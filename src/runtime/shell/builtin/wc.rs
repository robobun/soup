//! `wc [-clmw] [file ...]`: count lines, words, bytes and UTF-8 characters.
//!
//! Operands are read one at a time through an `IOReader` (stdin is read
//! when there are none). Every row is kept until the last operand has been
//! counted so the columns can share one width; the only stdout write is the
//! final one. A file that cannot be read is reported on stderr as it is
//! encountered, sets the exit code to 1, and does not stop the remaining
//! operands from being counted.

use std::io::Write as _;
use std::rc::Rc;

use bstr::BStr;
use bun_core::ZStr;

use crate::shell::ExitCode;
use crate::shell::builtin::{BadFlag, Builtin, BuiltinInput, IoKind, Kind, Sink, State};
use crate::shell::interpreter::{Interpreter, NodeId, shell_openat};
use crate::shell::io_reader::{ChildPtr as ReaderChildPtr, IOReader, ReaderTag};
use crate::shell::yield_::Yield;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Reading,
    /// An unreadable operand's message is being written; carry on with the
    /// next operand once it lands.
    WritingOperandError,
}

#[derive(Clone, Copy, Default)]
struct Opts {
    lines: bool,
    words: bool,
    chars: bool,
    bytes: bool,
}

impl Opts {
    fn parse<'a>(&mut self, flag: &'a [u8]) -> Result<(), BadFlag<'a>> {
        match flag {
            b"-" => return Err(BadFlag::Illegal(flag)),
            b"--lines" => self.lines = true,
            b"--words" => self.words = true,
            b"--chars" => self.chars = true,
            b"--bytes" => self.bytes = true,
            b"--max-line-length" => return Err(BadFlag::Unsupported(flag)),
            _ => {
                for (i, ch) in flag.iter().enumerate().skip(1) {
                    match ch {
                        b'l' => self.lines = true,
                        b'w' => self.words = true,
                        b'm' => self.chars = true,
                        b'c' => self.bytes = true,
                        b'L' => return Err(BadFlag::Unsupported(b"-L")),
                        _ => return Err(BadFlag::Illegal(&flag[i..i + 1])),
                    }
                }
            }
        }
        Ok(())
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

pub(crate) struct Wc {
    phase: Phase,
    opts: Opts,
    /// Index in [`Builtin::args`] of the first operand.
    first: usize,
    /// Number of operands; 0 means stdin is the only input.
    n_operands: usize,
    /// Offset from `first` of the next operand to open.
    idx: usize,
    /// Reader for the file being counted. Dropping it closes the file.
    reader: Option<Rc<IOReader>>,
    current: Counts,
    total: Counts,
    rows: Vec<Row>,
    exit_code: ExitCode,
}

pub(crate) fn start(interp: &Interpreter, cmd: NodeId) -> Yield {
    let (flags, operands) = Builtin::of(interp, cmd).split_flags();
    let mut opts = Opts::default();
    if let Err(flag) = flags.iter().try_for_each(|flag| opts.parse(flag)) {
        return Builtin::fail_flag(interp, cmd, flag);
    }
    if !(opts.lines || opts.words || opts.chars || opts.bytes) {
        opts.lines = true;
        opts.words = true;
        opts.bytes = true;
    }
    let (first, n_operands) = (flags.len(), operands.len());
    Builtin::of_mut(interp, cmd).state = State::Wc(Box::new(Wc {
        phase: Phase::Reading,
        opts,
        first,
        n_operands,
        idx: 0,
        reader: None,
        current: Counts::default(),
        total: Counts::default(),
        rows: Vec::new(),
        exit_code: 0,
    }));
    if n_operands == 0 {
        return Wc::read_stdin(interp, cmd, opts);
    }
    Wc::next_operand(interp, cmd)
}

fn listener(cmd: NodeId) -> ReaderChildPtr {
    ReaderChildPtr {
        node: cmd,
        tag: ReaderTag::Wc,
    }
}

impl Wc {
    fn of(interp: &Interpreter, cmd: NodeId) -> Option<&mut Wc> {
        match &mut Builtin::of_mut(interp, cmd).state {
            State::Wc(wc) => Some(wc),
            _ => None,
        }
    }

    fn read_stdin(interp: &Interpreter, cmd: NodeId, opts: Opts) -> Yield {
        let input = match &Builtin::of(interp, cmd).stdin {
            BuiltinInput::Fd(reader) => return Self::read(interp, cmd, &Rc::clone(reader)),
            BuiltinInput::ArrayBuf { buf } => buf.slice(),
            BuiltinInput::Blob(blob) => blob.blob.shared_view(),
            BuiltinInput::Ignore => b"",
        };
        let mut counts = Counts::default();
        counts.add(input, opts);
        if let Some(wc) = Self::of(interp, cmd) {
            wc.current = counts;
        }
        Self::finish_operand(interp, cmd);
        Self::write_output(interp, cmd)
    }

    /// The caller owns a `reader` too: `start` can finish the command.
    fn read(interp: &Interpreter, cmd: NodeId, reader: &Rc<IOReader>) -> Yield {
        if let Some(wc) = Self::of(interp, cmd) {
            wc.phase = Phase::Reading;
        }
        reader.set_interp(interp);
        reader.add_reader(listener(cmd));
        reader.start()
    }

    /// Opens operands until one can be read (reporting the ones that
    /// cannot), or writes the counts once every operand has been consumed.
    fn next_operand(interp: &Interpreter, cmd: NodeId) -> Yield {
        loop {
            let Some(wc) = Self::of(interp, cmd) else {
                return Yield::suspended();
            };
            wc.reader = None;
            wc.current = Counts::default();
            if wc.idx >= wc.n_operands {
                return Self::write_output(interp, cmd);
            }
            let operand = wc.first + wc.idx;
            wc.idx += 1;

            // The `args` of the Cmd still have the NUL, and argv[0].
            let arg = interp.as_cmd(cmd).args.get(operand + 1);
            let Some(path) = arg.and_then(|arg| ZStr::from_slice_until_nul(arg)) else {
                continue;
            };
            match shell_openat(Builtin::cwd(interp, cmd), path, bun_sys::O::RDONLY, 0) {
                Ok(fd) => {
                    let reader = IOReader::init(bun_sys::File::from_fd(fd), interp.event_loop);
                    if let Some(wc) = Self::of(interp, cmd) {
                        wc.reader = Some(Rc::clone(&reader));
                    }
                    return Self::read(interp, cmd, &reader);
                }
                Err(e) => {
                    let message = e.to_shell_system_error();
                    let message = message.message.byte_slice();
                    if let Some(yield_) =
                        Self::report_operand_error(interp, cmd, path.as_bytes(), message)
                    {
                        return yield_;
                    }
                }
            }
        }
    }

    /// Writes `wc: <name>: <message>` and marks the command as failed.
    /// Returns the yield to propagate when the write completes
    /// asynchronously (the state machine resumes from [`Self::on_write`]),
    /// or `None` once the message has been written and the caller can carry
    /// on.
    fn report_operand_error(
        interp: &Interpreter,
        cmd: NodeId,
        name: &[u8],
        message: &[u8],
    ) -> Option<Yield> {
        let line = Kind::Wc.message(format_args!(
            "{}: {}\n",
            BStr::new(name),
            BStr::new(message)
        ));
        if let Some(wc) = Self::of(interp, cmd) {
            wc.exit_code = 1;
            wc.phase = Phase::WritingOperandError;
        }
        match Builtin::sink(interp, cmd, IoKind::Stderr) {
            Sink::Fd(fd) => return Some(fd.enqueue(&line)),
            Sink::Memory(memory) => {
                let _ = memory.write(&line);
            }
        }
        if let Some(wc) = Self::of(interp, cmd) {
            wc.phase = Phase::Reading;
        }
        None
    }

    /// Turns the counts of the input just consumed into a row.
    fn finish_operand(interp: &Interpreter, cmd: NodeId) {
        let Some(wc) = Self::of(interp, cmd) else {
            return;
        };
        let counts = core::mem::take(&mut wc.current);
        wc.total.accumulate(&counts);
        let name = (wc.n_operands != 0).then(|| wc.first + wc.idx - 1);
        wc.rows.push(Row { counts, name });
    }

    /// What to do after the current input (and any error message about it)
    /// has been dealt with.
    fn advance(interp: &Interpreter, cmd: NodeId) -> Yield {
        if Self::of(interp, cmd).is_some_and(|wc| wc.n_operands == 0) {
            return Self::write_output(interp, cmd);
        }
        Self::next_operand(interp, cmd)
    }

    fn write_output(interp: &Interpreter, cmd: NodeId) -> Yield {
        let Some(wc) = Self::of(interp, cmd) else {
            return Yield::suspended();
        };
        let (opts, total, exit_code) = (wc.opts, wc.total, wc.exit_code);
        let print_total = wc.n_operands > 1;
        let rows = core::mem::take(&mut wc.rows);
        // GNU and BSD wc pad the columns to a fixed width (derived from the
        // file sizes, or 7/8 for pipes) which differs between the two. The
        // builtin sizes the columns to the largest count it prints, so
        // `wc -l < file` is a bare number and columns still line up across
        // files and the total line.
        let width = rows
            .iter()
            .map(|row| row.counts)
            .chain(print_total.then_some(total))
            .flat_map(|counts| counts.selected(opts))
            .map(digits)
            .max()
            .unwrap_or(1);

        let mut out = Vec::new();
        let args = Builtin::of(interp, cmd).args();
        for row in &rows {
            let name = row.name.and_then(|i| args.get(i)).map(|arg| arg.get());
            write_row(&mut out, row.counts, name, opts, width);
        }
        if print_total {
            write_row(&mut out, total, Some(b"total"), opts, width);
        }
        Builtin::finish(interp, cmd, IoKind::Stdout, &out, exit_code)
    }

    /// The message about an unreadable operand has been written.
    pub(crate) fn on_write(interp: &Interpreter, cmd: NodeId, failed: Option<ExitCode>) -> Yield {
        if let Some(exit_code) = failed {
            return Builtin::done(interp, cmd, exit_code);
        }
        let Some(wc) = Self::of(interp, cmd) else {
            return Yield::suspended();
        };
        if wc.phase != Phase::WritingOperandError {
            return Yield::suspended();
        }
        wc.phase = Phase::Reading;
        Self::advance(interp, cmd)
    }

    pub(crate) fn on_io_reader_chunk(
        interp: &Interpreter,
        cmd: NodeId,
        chunk: &[u8],
        remove: &mut bool,
    ) -> Yield {
        *remove = false;
        if let Some(wc) = Self::of(interp, cmd) {
            let opts = wc.opts;
            wc.current.add(chunk, opts);
        }
        Yield::done()
    }

    pub(crate) fn on_io_reader_done(
        interp: &Interpreter,
        cmd: NodeId,
        err: Option<bun_sys::SystemError>,
    ) -> Yield {
        if Self::of(interp, cmd).is_none_or(|wc| wc.phase != Phase::Reading) {
            return Yield::suspended();
        }
        Self::finish_operand(interp, cmd);
        if let Some(err) = err {
            // The row was still emitted above: like wc(1), a read error
            // reports what was counted before it and is flagged through the
            // exit code.
            let row = Self::of(interp, cmd).and_then(|wc| wc.rows.last()?.name);
            let name: &[u8] = match row.and_then(|i| Builtin::of(interp, cmd).args().get(i)) {
                Some(arg) => arg.get(),
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
