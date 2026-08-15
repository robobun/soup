//! `wc [-clmw] [file ...]`: count lines, words, bytes and UTF-8 characters.
//!
//! Operands are read one at a time through an `IOReader` (stdin is read
//! when there are none). Every row is kept until the last operand has been
//! counted so the columns can share one width; the only stdout write is the
//! final one. A file that cannot be read is reported on stderr as it is
//! encountered, sets the exit code to 1, and does not stop the remaining
//! operands from being counted.

use std::io::Write as _;
use std::sync::Arc;

use crate::shell::ExitCode;
use crate::shell::builtin::{Builtin, BuiltinInput, BuiltinState, IoKind, Kind};
use crate::shell::interpreter::{
    FlagParser, Interpreter, NodeId, ParseError, ParseFlagResult, parse_flags, shell_openat,
    unreachable_state, unsupported_flag,
};
use crate::shell::io_reader::{ChildPtr as ReaderChildPtr, IOReader, ReaderTag};
use crate::shell::io_writer::{ChildPtr, WriterTag};
use crate::shell::yield_::Yield;

#[derive(Clone, Copy, PartialEq, Eq, Default)]
enum State {
    #[default]
    Idle,
    Reading,
    /// An unreadable operand's message is being written; carry on with the
    /// next operand once it lands.
    WaitingWriteOperandErr,
    /// The counts are being written; finish once they land.
    WaitingWriteOut,
    /// A usage error is being written; finish with exit code 1.
    WaitingWriteErr,
}

#[derive(Clone, Copy, Default)]
pub struct Opts {
    lines: bool,
    words: bool,
    chars: bool,
    bytes: bool,
}

impl FlagParser for Opts {
    fn parse_long(&mut self, flag: &[u8]) -> Option<ParseFlagResult> {
        match flag {
            b"--lines" => self.lines = true,
            b"--words" => self.words = true,
            b"--chars" => self.chars = true,
            b"--bytes" => self.bytes = true,
            b"--max-line-length" => {
                return Some(ParseFlagResult::Unsupported(unsupported_flag(
                    b"--max-line-length",
                )));
            }
            _ => return None,
        }
        Some(ParseFlagResult::ContinueParsing)
    }

    fn parse_short(&mut self, ch: u8, smallflags: &[u8], i: usize) -> Option<ParseFlagResult> {
        match ch {
            b'l' => self.lines = true,
            b'w' => self.words = true,
            b'm' => self.chars = true,
            b'c' => self.bytes = true,
            b'L' => return Some(ParseFlagResult::Unsupported(unsupported_flag(b"-L"))),
            _ => {
                return Some(ParseFlagResult::IllegalOption(
                    &raw const smallflags[i..i + 1],
                ));
            }
        }
        None
    }
}

#[derive(Clone, Copy, Default)]
struct Counts {
    lines: u64,
    words: u64,
    chars: u64,
    bytes: u64,
    /// Whether the previous byte was part of a word; a word that straddles
    /// two chunks must only be counted once.
    in_word: bool,
}

impl Counts {
    fn add(&mut self, chunk: &[u8], opts: Opts) {
        self.bytes += chunk.len() as u64;
        if opts.lines {
            self.lines += bun_core::strings::count_char(chunk, b'\n') as u64;
        }
        if !opts.words && !opts.chars {
            return;
        }
        for &b in chunk {
            // UTF-8 continuation bytes are not characters of their own.
            if (b & 0xC0) != 0x80 {
                self.chars += 1;
            }
            if matches!(b, b' ' | b'\t' | b'\n' | 0x0B | 0x0C | b'\r') {
                self.in_word = false;
            } else if !self.in_word {
                self.in_word = true;
                self.words += 1;
            }
        }
    }

    fn accumulate(&mut self, other: &Counts) {
        self.lines += other.lines;
        self.words += other.words;
        self.chars += other.chars;
        self.bytes += other.bytes;
    }

    /// The counts in output order, filtered down to the ones requested.
    fn selected(self, opts: Opts) -> impl Iterator<Item = u64> {
        [
            (opts.lines, self.lines),
            (opts.words, self.words),
            (opts.chars, self.chars),
            (opts.bytes, self.bytes),
        ]
        .into_iter()
        .filter_map(|(selected, n)| selected.then_some(n))
    }
}

struct Row {
    counts: Counts,
    /// argv index of the operand; `None` for stdin, which is printed
    /// without a name.
    name: Option<usize>,
}

#[derive(Default)]
pub struct Wc {
    state: State,
    opts: Opts,
    /// argv index of the first operand.
    args_start: usize,
    /// Number of operands; 0 means stdin is the only input.
    n_operands: usize,
    /// argv offset (from `args_start`) of the next operand to open.
    idx: usize,
    /// Reader for the operand currently being counted. Dropping it closes
    /// the file.
    reader: Option<Arc<IOReader>>,
    current: Counts,
    total: Counts,
    rows: Vec<Row>,
    exit_code: ExitCode,
}

impl Wc {
    pub(crate) fn start(interp: &Interpreter, cmd: NodeId) -> Yield {
        let mut opts = Opts::default();
        let args = Builtin::of(interp, cmd).args_slice();
        let argc = args.len();
        let args_start = match parse_flags(&mut opts, args) {
            Ok(Some(operands)) => argc - operands.len(),
            // No arguments at all, or nothing but flags: count stdin.
            Ok(None) | Err(ParseError::ShowUsage) => argc,
            Err(e) => {
                return Builtin::fail_parse(interp, cmd, Kind::Wc, &e, || {
                    Self::state_mut(interp, cmd).state = State::WaitingWriteErr
                });
            }
        };
        if !(opts.lines || opts.words || opts.chars || opts.bytes) {
            opts.lines = true;
            opts.words = true;
            opts.bytes = true;
        }

        {
            let me = Self::state_mut(interp, cmd);
            me.opts = opts;
            me.args_start = args_start;
            me.n_operands = argc - args_start;
        }

        if args_start == argc {
            return Self::read_stdin(interp, cmd);
        }
        Self::next_operand(interp, cmd)
    }

    fn read_stdin(interp: &Interpreter, cmd: NodeId) -> Yield {
        let reader = match &Builtin::of(interp, cmd).stdin {
            BuiltinInput::Fd(reader) => Arc::clone(reader),
            _ => {
                let opts = Self::state_mut(interp, cmd).opts;
                let mut counts = Counts::default();
                counts.add(Builtin::read_stdin_no_io(interp, cmd), opts);
                Self::state_mut(interp, cmd).current = counts;
                Self::finish_operand(interp, cmd);
                return Self::write_output(interp, cmd);
            }
        };
        Self::state_mut(interp, cmd).state = State::Reading;
        reader.set_interp(interp.as_ctx_ptr());
        reader.add_reader(ReaderChildPtr {
            node: cmd,
            tag: ReaderTag::Wc,
        });
        reader.start()
    }

    /// Opens operands until one can be read (reporting the ones that
    /// cannot), or writes the counts once every operand has been consumed.
    fn next_operand(interp: &Interpreter, cmd: NodeId) -> Yield {
        loop {
            let (args_start, n_operands, idx) = {
                let me = Self::state_mut(interp, cmd);
                me.reader = None;
                me.current = Counts::default();
                (me.args_start, me.n_operands, me.idx)
            };
            if idx >= n_operands {
                return Self::write_output(interp, cmd);
            }
            Self::state_mut(interp, cmd).idx += 1;

            let path = Builtin::of(interp, cmd).arg_zstr(args_start + idx);
            let fd = match shell_openat(Builtin::cwd(interp, cmd), path, bun_sys::O::RDONLY, 0) {
                Ok(fd) => fd,
                Err(e) => {
                    let message = e.to_shell_system_error();
                    match Self::report_operand_error(
                        interp,
                        cmd,
                        path.as_bytes(),
                        message.message.byte_slice(),
                    ) {
                        Some(yield_) => return yield_,
                        None => continue,
                    }
                }
            };

            let reader = IOReader::init(fd, Builtin::event_loop(interp, cmd));
            reader.set_interp(interp.as_ctx_ptr());
            {
                let me = Self::state_mut(interp, cmd);
                me.reader = Some(Arc::clone(&reader));
                me.state = State::Reading;
            }
            reader.add_reader(ReaderChildPtr {
                node: cmd,
                tag: ReaderTag::Wc,
            });
            return reader.start();
        }
    }

    /// Writes `wc: <name>: <message>` and marks the command as failed.
    /// Returns the yield to propagate when the write completes
    /// asynchronously (the state machine resumes from
    /// `on_io_writer_chunk`), or `None` once the message has been written
    /// and the caller can carry on.
    fn report_operand_error(
        interp: &Interpreter,
        cmd: NodeId,
        name: &[u8],
        message: &[u8],
    ) -> Option<Yield> {
        Self::state_mut(interp, cmd).exit_code = 1;
        let mut buf = Vec::new();
        let _ = writeln!(
            &mut buf,
            "{}: {}: {}",
            Kind::Wc.as_str(),
            bstr::BStr::new(name),
            bstr::BStr::new(message)
        );
        if let Some(safeguard) = Builtin::of(interp, cmd).stderr.needs_io() {
            Self::state_mut(interp, cmd).state = State::WaitingWriteOperandErr;
            let child = ChildPtr::new(cmd, WriterTag::Builtin);
            return Some(
                Builtin::of_mut(interp, cmd)
                    .stderr
                    .enqueue(child, &buf, safeguard),
            );
        }
        let _ = Builtin::write_no_io(interp, cmd, IoKind::Stderr, &buf);
        None
    }

    /// Turns the counts of the input just consumed into a row.
    fn finish_operand(interp: &Interpreter, cmd: NodeId) {
        let me = Self::state_mut(interp, cmd);
        let counts = core::mem::take(&mut me.current);
        me.total.accumulate(&counts);
        let name = (me.n_operands != 0).then(|| me.args_start + me.idx - 1);
        me.rows.push(Row { counts, name });
    }

    /// What to do after the current input (and any error message about it)
    /// has been dealt with.
    fn advance(interp: &Interpreter, cmd: NodeId) -> Yield {
        if Self::state_mut(interp, cmd).n_operands == 0 {
            return Self::write_output(interp, cmd);
        }
        Self::next_operand(interp, cmd)
    }

    fn render(interp: &Interpreter, cmd: NodeId) -> Vec<u8> {
        let (opts, rows, total, n_operands) = {
            let me = Self::state_mut(interp, cmd);
            (
                me.opts,
                core::mem::take(&mut me.rows),
                me.total,
                me.n_operands,
            )
        };
        // GNU and BSD wc pad the columns to a fixed width (derived from the
        // file sizes, or 7/8 for pipes) which differs between the two. The
        // builtin sizes the columns to the largest count it prints, so
        // `wc -l < file` is a bare number and columns still line up across
        // files and the total line.
        let print_total = n_operands > 1;
        let width = rows
            .iter()
            .map(|row| row.counts)
            .chain(print_total.then_some(total))
            .flat_map(|counts| counts.selected(opts))
            .map(digits)
            .max()
            .unwrap_or(1);

        let mut out = Vec::new();
        let bltn = Builtin::of(interp, cmd);
        for row in &rows {
            let name = row.name.map(|i| bltn.arg_bytes(i));
            write_row(&mut out, row.counts, name, opts, width);
        }
        if print_total {
            write_row(&mut out, total, Some(b"total"), opts, width);
        }
        out
    }

    fn write_output(interp: &Interpreter, cmd: NodeId) -> Yield {
        let out = Self::render(interp, cmd);
        Self::state_mut(interp, cmd).state = State::WaitingWriteOut;
        if let Some(safeguard) = Builtin::of(interp, cmd).stdout.needs_io() {
            let child = ChildPtr::new(cmd, WriterTag::Builtin);
            return Builtin::of_mut(interp, cmd)
                .stdout
                .enqueue(child, &out, safeguard);
        }
        let _ = Builtin::write_no_io(interp, cmd, IoKind::Stdout, &out);
        let exit_code = Self::state_mut(interp, cmd).exit_code;
        Builtin::done(interp, cmd, exit_code)
    }

    pub(crate) fn on_io_writer_chunk(
        interp: &Interpreter,
        cmd: NodeId,
        _: usize,
        err: Option<bun_sys::SystemError>,
    ) -> Yield {
        if let Some(_err) = err {
            return Builtin::done(interp, cmd, 1);
        }
        match Self::state_mut(interp, cmd).state {
            State::WaitingWriteOperandErr => Self::advance(interp, cmd),
            State::WaitingWriteOut => {
                let exit_code = Self::state_mut(interp, cmd).exit_code;
                Builtin::done(interp, cmd, exit_code)
            }
            State::WaitingWriteErr => Builtin::done(interp, cmd, 1),
            State::Idle => unreachable_state("Wc.onIOWriterChunk", "idle"),
            State::Reading => unreachable_state("Wc.onIOWriterChunk", "reading"),
        }
    }

    pub(crate) fn on_io_reader_chunk(
        interp: &Interpreter,
        cmd: NodeId,
        chunk: &[u8],
        remove: &mut bool,
    ) -> Yield {
        *remove = false;
        let me = Self::state_mut(interp, cmd);
        let opts = me.opts;
        me.current.add(chunk, opts);
        Yield::done()
    }

    pub(crate) fn on_io_reader_done(
        interp: &Interpreter,
        cmd: NodeId,
        err: Option<bun_sys::SystemError>,
    ) -> Yield {
        if Self::state_mut(interp, cmd).state != State::Reading {
            return Yield::suspended();
        }
        Self::finish_operand(interp, cmd);
        if let Some(err) = err {
            // The row was still emitted above: like wc(1), a read error
            // reports what was counted before it and is flagged through the
            // exit code.
            let name: &[u8] = match Self::state_mut(interp, cmd)
                .rows
                .last()
                .and_then(|row| row.name)
            {
                Some(i) => Builtin::of(interp, cmd).arg_bytes(i),
                None => b"stdin",
            };
            if let Some(yield_) =
                Self::report_operand_error(interp, cmd, name, err.message.byte_slice())
            {
                return yield_;
            }
        }
        Self::advance(interp, cmd)
    }
}

fn digits(mut n: u64) -> usize {
    let mut width = 1;
    while n >= 10 {
        n /= 10;
        width += 1;
    }
    width
}

fn write_row(out: &mut Vec<u8>, counts: Counts, name: Option<&[u8]>, opts: Opts, width: usize) {
    for (i, n) in counts.selected(opts).enumerate() {
        if i > 0 {
            out.push(b' ');
        }
        let _ = write!(out, "{n:>width$}");
    }
    if let Some(name) = name {
        out.push(b' ');
        out.extend_from_slice(name);
    }
    out.push(b'\n');
}
