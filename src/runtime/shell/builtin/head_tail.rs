//! `head` and `tail`: print the first or the last part of each input.
//!
//! The two commands are one program with the selection inverted, so they
//! share this module: [`Head`] and [`Tail`] differ only in which [`Mode`]s
//! their options produce and in the name on their messages. Inputs are read
//! one at a time through an `IOReader` (stdin when there are no operands, or
//! for a `-` operand). Selected bytes are written as they arrive, so `head`
//! stops pulling from a pipe as soon as it has what it needs and
//! `tail -n +K` never holds more than one chunk. The "last N" selections keep
//! the retained suffix in a buffer and write it once the input ends. An input
//! that cannot be read is reported on stderr as it is encountered, sets the
//! exit code to 1, and does not stop the remaining inputs from being printed.

use std::rc::Rc;

use bun_core::ZStr;

use crate::shell::ExitCode;
use crate::shell::builtin::{Builtin, BuiltinInput, IoKind, Kind, Sink, State};
use crate::shell::interpreter::{Interpreter, NodeId, shell_openat};
use crate::shell::io_reader::{ChildPtr as ReaderChildPtr, IOReader, ReaderTag};
use crate::shell::yield_::Yield;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Unit {
    Lines,
    Bytes,
}

impl Unit {
    fn as_str(self) -> &'static str {
        match self {
            Unit::Lines => "lines",
            Unit::Bytes => "bytes",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// The first `n` units (`head -n N`, `head -c N`).
    First(u64),
    /// Everything but the last `n` units (`head -n -N`, `head -c -N`).
    AllButLast(u64),
    /// The last `n` units (`tail -n N`, `tail -c N`).
    Last(u64),
    /// Everything from unit `k` on, counting from 1 (`tail -n +K`,
    /// `tail -c +K`).
    From(u64),
}

/// The part of a chunk to write now.
enum Emit<'a> {
    Nothing,
    Slice(&'a [u8]),
    Owned(Vec<u8>),
}

/// Decides which bytes of one input are printed. `push` is fed every chunk
/// in order and returns the part of it to write; `finish` returns what is
/// still held back once the input has ended.
///
/// A line is a run of bytes ending in `\n`; bytes after the last `\n` of an
/// input form a line too, and are printed without a newline being added, as
/// head(1) and tail(1) do.
struct Selection {
    unit: Unit,
    mode: Mode,
    /// `First`: units still to print. `From`: units still to skip.
    remaining: u64,
    /// `Last` and `AllButLast`: the suffix of the input seen so far that can
    /// still be part of the output is `buf[start..]`. The dead prefix is
    /// compacted away once it takes up half of the buffer, so a byte is
    /// moved a bounded number of times however large the retained suffix is.
    buf: Vec<u8>,
    start: usize,
    /// Newlines in `buf[start..]`.
    newlines: usize,
}

impl Selection {
    fn new(unit: Unit, mode: Mode) -> Self {
        let mut this = Self {
            unit,
            mode,
            remaining: 0,
            buf: Vec::new(),
            start: 0,
            newlines: 0,
        };
        this.reset();
        this
    }

    /// Forgets the previous input.
    fn reset(&mut self) {
        self.remaining = match self.mode {
            Mode::First(n) => n,
            Mode::From(k) => k.saturating_sub(1),
            Mode::AllButLast(_) | Mode::Last(_) => 0,
        };
        self.buf.clear();
        self.start = 0;
        self.newlines = 0;
    }

    /// Whether no further input can change the output, so reading can stop.
    fn complete(&self) -> bool {
        match self.mode {
            Mode::First(_) => self.remaining == 0,
            Mode::Last(n) => n == 0,
            Mode::AllButLast(_) | Mode::From(_) => false,
        }
    }

    fn push<'a>(&mut self, chunk: &'a [u8]) -> Emit<'a> {
        match self.mode {
            Mode::First(_) => {
                let end = match self.unit {
                    Unit::Bytes => {
                        let take = self.remaining.min(chunk.len() as u64) as usize;
                        self.remaining -= take as u64;
                        take
                    }
                    Unit::Lines => {
                        let mut end = 0usize;
                        while self.remaining > 0 && end < chunk.len() {
                            match bun_core::strings::index_of_char_usize(&chunk[end..], b'\n') {
                                Some(i) => {
                                    end += i + 1;
                                    self.remaining -= 1;
                                }
                                None => end = chunk.len(),
                            }
                        }
                        end
                    }
                };
                Emit::Slice(&chunk[..end])
            }
            Mode::From(_) => {
                let start = match self.unit {
                    Unit::Bytes => {
                        let skip = self.remaining.min(chunk.len() as u64) as usize;
                        self.remaining -= skip as u64;
                        skip
                    }
                    Unit::Lines => {
                        let mut start = 0usize;
                        while self.remaining > 0 && start < chunk.len() {
                            match bun_core::strings::index_of_char_usize(&chunk[start..], b'\n') {
                                Some(i) => {
                                    start += i + 1;
                                    self.remaining -= 1;
                                }
                                None => start = chunk.len(),
                            }
                        }
                        start
                    }
                };
                Emit::Slice(&chunk[start..])
            }
            Mode::Last(n) | Mode::AllButLast(n) => {
                self.buf.extend_from_slice(chunk);
                if self.unit == Unit::Lines {
                    self.newlines += bun_core::strings::count_char(chunk, b'\n');
                }
                let (cut, dropped_newlines) = self.start_of_last(n);
                let emit = match self.mode {
                    Mode::AllButLast(_) => Emit::Owned(self.buf[self.start..cut].to_vec()),
                    _ => Emit::Nothing,
                };
                self.newlines -= dropped_newlines;
                self.start = cut;
                if self.start >= self.buf.len() / 2 {
                    self.buf.drain(..self.start);
                    self.start = 0;
                }
                emit
            }
        }
    }

    /// Where the last `n` units of `buf[start..]` begin, as an index into
    /// `buf`, and how many newlines lie before that point. With fewer than
    /// `n` units retained, everything is kept.
    fn start_of_last(&self, n: u64) -> (usize, usize) {
        let live = &self.buf[self.start..];
        match self.unit {
            // Newlines are only tracked for `Unit::Lines`.
            Unit::Bytes => {
                let keep = n.min(live.len() as u64) as usize;
                (self.start + live.len() - keep, 0)
            }
            Unit::Lines => {
                if n == 0 {
                    return (self.buf.len(), self.newlines);
                }
                let partial = live.last().is_some_and(|&b| b != b'\n');
                let lines = self.newlines + usize::from(partial);
                if lines as u64 <= n {
                    return (self.start, 0);
                }
                // Only the last line can lack its newline and it is kept,
                // so every dropped line ends in one.
                let drop = lines - n as usize;
                let keep = n as usize;
                let mut cut = 0usize;
                if keep < drop {
                    // Walk back over the kept lines from the end. The last
                    // line's own newline is not a separator.
                    let mut end = live.len() - usize::from(!partial);
                    for _ in 0..keep {
                        match bun_core::strings::last_index_of_char(&live[..end], b'\n') {
                            Some(i) => {
                                cut = i + 1;
                                end = i;
                            }
                            None => {
                                cut = 0;
                                break;
                            }
                        }
                    }
                } else {
                    for _ in 0..drop {
                        match bun_core::strings::index_of_char_usize(&live[cut..], b'\n') {
                            Some(i) => cut += i + 1,
                            None => break,
                        }
                    }
                }
                (self.start + cut, drop)
            }
        }
    }

    /// The bytes held back until the input ended.
    fn finish(&mut self) -> Emit<'static> {
        match self.mode {
            Mode::Last(_) => {
                let mut out = core::mem::take(&mut self.buf);
                out.drain(..self.start);
                self.start = 0;
                self.newlines = 0;
                Emit::Owned(out)
            }
            Mode::First(_) | Mode::AllButLast(_) | Mode::From(_) => Emit::Nothing,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    /// Reading the current input and writing the selected bytes.
    Running,
    /// An unreadable input's message is being written; carry on with the
    /// next input once it lands.
    WritingOperandError,
}

/// Options shared by both commands, as parsed from argv.
struct Opts {
    unit: Unit,
    mode: Mode,
    /// `Some` when `-q`/`-v` decided it; otherwise headers are printed when
    /// there is more than one input.
    headers: Option<bool>,
    /// Index in [`Builtin::args`] of the first operand.
    args_start: usize,
}

/// Everything `Head` and `Tail` have in common: the option grammar, the
/// input loop, the output accounting and the error reporting.
pub(crate) struct Common {
    kind: Kind,
    tag: ReaderTag,
    phase: Phase,
    selection: Selection,
    /// Print a `==> name <==` header before each input.
    headers: bool,
    /// A header is separated from the previous input's output by a blank
    /// line, so the first one is printed without it.
    printed_header: bool,
    /// The current input's header, written together with its first bytes
    /// (or on its own when it has none) so each step queues one write.
    pending_header: Option<Vec<u8>>,
    /// Index in [`Builtin::args`] of the first operand.
    args_start: usize,
    /// Number of operands; 0 means stdin is the only input.
    n_operands: usize,
    /// Offset from `args_start` of the next operand.
    idx: usize,
    /// Whether stdin has been read already. A second `-` operand is an
    /// empty input, as it would be for a process whose stdin hit EOF.
    stdin_consumed: bool,
    /// Reader for a file operand. Dropping it closes the file.
    reader: Option<Rc<IOReader>>,
    /// The builtin is registered on the reader of the current input.
    reading: bool,
    chunks_queued: usize,
    chunks_done: usize,
    /// The current input has ended or was cut short; it is finished once
    /// every queued write has landed.
    in_done: bool,
    /// The held-back bytes (and a header without content) were written.
    flushed: bool,
    /// A read error on the current input, reported once the bytes read
    /// before it are written.
    read_err: Option<bun_sys::SystemError>,
    exit_code: ExitCode,
}

impl Common {
    fn of(interp: &Interpreter, cmd: NodeId) -> Option<&mut Common> {
        match &mut Builtin::of_mut(interp, cmd).state {
            State::HeadTail(common) => Some(common),
            _ => None,
        }
    }

    fn start(
        interp: &Interpreter,
        cmd: NodeId,
        kind: Kind,
        tag: ReaderTag,
        opts: Result<Opts, Vec<u8>>,
    ) -> Yield {
        let opts = match opts {
            Ok(opts) => opts,
            Err(message) => return Builtin::finish(interp, cmd, IoKind::Stderr, &message, 1),
        };
        let n_operands = Builtin::of(interp, cmd).args().len() - opts.args_start;
        Builtin::of_mut(interp, cmd).state = State::HeadTail(Box::new(Common {
            kind,
            tag,
            phase: Phase::Running,
            selection: Selection::new(opts.unit, opts.mode),
            headers: opts.headers.unwrap_or(n_operands > 1),
            printed_header: false,
            pending_header: None,
            args_start: opts.args_start,
            n_operands,
            idx: 0,
            stdin_consumed: false,
            reader: None,
            reading: false,
            chunks_queued: 0,
            chunks_done: 0,
            in_done: false,
            flushed: false,
            read_err: None,
            exit_code: 0,
        }));
        Self::next_input(interp, cmd)
    }

    /// Opens inputs until one can be read (reporting the ones that cannot),
    /// and finishes once every input has been printed.
    fn next_input(interp: &Interpreter, cmd: NodeId) -> Yield {
        loop {
            let Some(me) = Self::of(interp, cmd) else {
                return Yield::suspended();
            };
            me.reader = None;
            me.reading = false;
            me.in_done = false;
            me.flushed = false;
            me.chunks_queued = 0;
            me.chunks_done = 0;
            me.selection.reset();
            if me.idx >= me.n_operands.max(1) {
                return Builtin::done(interp, cmd, me.exit_code);
            }
            let operand = (me.n_operands > 0).then_some(me.args_start + me.idx);
            me.idx += 1;

            let Some(operand) = operand else {
                return Self::read_stdin(interp, cmd);
            };
            // The `args` of the Cmd still have the NUL, and argv[0].
            let arg = interp.as_cmd(cmd).args.get(operand + 1);
            let Some(path) = arg.and_then(|arg| ZStr::from_slice_until_nul(arg)) else {
                continue;
            };
            if path.as_bytes() == b"-" {
                return Self::read_stdin(interp, cmd);
            }
            match shell_openat(Builtin::cwd(interp, cmd), path, bun_sys::O::RDONLY, 0) {
                Ok(fd) => {
                    let reader = IOReader::init(bun_sys::File::from_fd(fd), interp.event_loop);
                    if let Some(me) = Self::of(interp, cmd) {
                        me.reader = Some(Rc::clone(&reader));
                    }
                    return Self::read(interp, cmd, &reader, path.as_bytes());
                }
                Err(e) => {
                    let message = e.to_shell_system_error();
                    let message = message.message.byte_slice();
                    if let Some(yield_) =
                        Self::report_input_error(interp, cmd, path.as_bytes(), message)
                    {
                        return yield_;
                    }
                }
            }
        }
    }

    /// For a command without operands, and for a `-` operand.
    fn read_stdin(interp: &Interpreter, cmd: NodeId) -> Yield {
        const NAME: &[u8] = b"standard input";
        let Some(me) = Self::of(interp, cmd) else {
            return Yield::suspended();
        };
        let consumed = core::mem::replace(&mut me.stdin_consumed, true);
        let input: &[u8] = match &Builtin::of(interp, cmd).stdin {
            BuiltinInput::Fd(reader) if !consumed => {
                return Self::read(interp, cmd, &Rc::clone(reader), NAME);
            }
            BuiltinInput::ArrayBuf { buf } if !consumed => buf.slice(),
            BuiltinInput::Blob(blob) if !consumed => blob.blob.shared_view(),
            _ => b"",
        };
        // A buffer, a Blob or nothing: the whole input is available now.
        let Some(me) = Self::of(interp, cmd) else {
            return Yield::suspended();
        };
        me.queue_header(NAME);
        let emit = me.selection.push(input);
        me.in_done = true;
        if let Some(yield_) = Self::write_emit(interp, cmd, emit) {
            return yield_;
        }
        Self::advance(interp, cmd)
    }

    /// The caller owns a `reader` too: `start` can finish the command.
    fn read(interp: &Interpreter, cmd: NodeId, reader: &Rc<IOReader>, name: &[u8]) -> Yield {
        let Some(me) = Self::of(interp, cmd) else {
            return Yield::suspended();
        };
        me.queue_header(name);
        if me.selection.complete() {
            // `head -n 0`: nothing of this input is printed, so it is not
            // read at all.
            me.in_done = true;
            return Self::advance(interp, cmd);
        }
        me.reading = true;
        reader.set_interp(interp);
        reader.add_reader(me.listener(cmd));
        reader.start()
    }

    fn listener(&self, cmd: NodeId) -> ReaderChildPtr {
        ReaderChildPtr {
            node: cmd,
            tag: self.tag,
        }
    }

    fn queue_header(&mut self, name: &[u8]) {
        if !self.headers {
            return;
        }
        let mut header = Vec::with_capacity(name.len() + 10);
        if self.printed_header {
            header.push(b'\n');
        }
        header.extend_from_slice(b"==> ");
        header.extend_from_slice(name);
        header.extend_from_slice(b" <==\n");
        self.printed_header = true;
        self.pending_header = Some(header);
    }

    /// Writes `bytes`, preceded by the pending header, to stdout. Returns
    /// the yield to propagate when the write goes through the IOWriter (its
    /// completion resumes the state machine in [`Self::on_write`]), or
    /// `None` once the bytes have been written and the caller can carry on.
    fn write(interp: &Interpreter, cmd: NodeId, bytes: &[u8]) -> Option<Yield> {
        let header = Self::of(interp, cmd)?.pending_header.take();
        let joined: Vec<u8>;
        let out: &[u8] = match header {
            Some(mut header) => {
                header.extend_from_slice(bytes);
                joined = header;
                &joined
            }
            None => bytes,
        };
        if out.is_empty() {
            return None;
        }
        match Builtin::sink(interp, cmd, IoKind::Stdout) {
            Sink::Fd(fd) => {
                Self::of(interp, cmd)?.chunks_queued += 1;
                Some(fd.enqueue(out))
            }
            Sink::Memory(memory) => {
                let _ = memory.write(out);
                None
            }
        }
    }

    fn write_emit(interp: &Interpreter, cmd: NodeId, emit: Emit<'_>) -> Option<Yield> {
        match emit {
            Emit::Nothing => Self::write(interp, cmd, b""),
            Emit::Slice(bytes) => Self::write(interp, cmd, bytes),
            Emit::Owned(bytes) => Self::write(interp, cmd, &bytes),
        }
    }

    /// Writes `<kind>: <name>: <message>` to stderr and marks the command as
    /// failed. Returns the yield to propagate when the write completes
    /// asynchronously (the state machine resumes from [`Self::on_write`]),
    /// or `None` once the message has been written.
    fn report_input_error(
        interp: &Interpreter,
        cmd: NodeId,
        name: &[u8],
        message: &[u8],
    ) -> Option<Yield> {
        let me = Self::of(interp, cmd)?;
        me.exit_code = 1;
        let name = bstr::BStr::new(name);
        let message = bstr::BStr::new(message);
        let line = me.kind.message(format_args!("{name}: {message}\n"));
        match Builtin::sink(interp, cmd, IoKind::Stderr) {
            Sink::Fd(fd) => {
                Self::of(interp, cmd)?.phase = Phase::WritingOperandError;
                Some(fd.enqueue(&line))
            }
            Sink::Memory(memory) => {
                let _ = memory.write(&line);
                None
            }
        }
    }

    /// Name of the input being read, for error messages.
    fn current_input_name<'a>(interp: &'a Interpreter, cmd: NodeId) -> &'a [u8] {
        let operand = Self::of(interp, cmd)
            .filter(|me| me.n_operands > 0)
            .map(|me| me.args_start + me.idx - 1);
        match operand.and_then(|i| Builtin::of(interp, cmd).args().get(i)) {
            Some(name) if name.get() != b"-" => name.get(),
            _ => b"standard input",
        }
    }

    /// Finishes the current input once its output has landed: writes what
    /// was held back, reports a read error, and moves on to the next input.
    fn advance(interp: &Interpreter, cmd: NodeId) -> Yield {
        let Some(me) = Self::of(interp, cmd) else {
            return Yield::suspended();
        };
        if !me.in_done || me.chunks_done < me.chunks_queued {
            return Yield::suspended();
        }
        if !core::mem::replace(&mut me.flushed, true) {
            let emit = me.selection.finish();
            if let Some(yield_) = Self::write_emit(interp, cmd, emit) {
                return yield_;
            }
        }
        if let Some(err) = Self::of(interp, cmd).and_then(|me| me.read_err.take()) {
            let name = Self::current_input_name(interp, cmd);
            if let Some(yield_) =
                Self::report_input_error(interp, cmd, name, err.message.byte_slice())
            {
                return yield_;
            }
        }
        Self::next_input(interp, cmd)
    }

    /// Stops listening to the current input's reader.
    fn detach_reader(interp: &Interpreter, cmd: NodeId) {
        let Some(me) = Self::of(interp, cmd) else {
            return;
        };
        if !core::mem::replace(&mut me.reading, false) {
            return;
        }
        let child = me.listener(cmd);
        match me.reader.take() {
            Some(reader) => reader.remove_reader(child),
            None => {
                if let BuiltinInput::Fd(reader) = &Builtin::of(interp, cmd).stdin {
                    reader.remove_reader(child);
                }
            }
        }
    }

    pub(crate) fn on_write(interp: &Interpreter, cmd: NodeId, failed: Option<ExitCode>) -> Yield {
        if let Some(exit_code) = failed {
            // A write that fails ends the command, as it does for `cat`. The
            // writer fails every chunk that is still queued with a
            // completion of its own, and by then this command is gone.
            for to in [IoKind::Stdout, IoKind::Stderr] {
                if let Sink::Fd(fd) = Builtin::sink(interp, cmd, to) {
                    fd.cancel_queued();
                }
            }
            Self::detach_reader(interp, cmd);
            return Builtin::done(interp, cmd, exit_code);
        }
        let Some(me) = Self::of(interp, cmd) else {
            return Yield::suspended();
        };
        match me.phase {
            Phase::Running => {
                me.chunks_done += 1;
                Self::advance(interp, cmd)
            }
            Phase::WritingOperandError => {
                me.phase = Phase::Running;
                Self::next_input(interp, cmd)
            }
        }
    }

    fn on_io_reader_chunk(
        interp: &Interpreter,
        cmd: NodeId,
        chunk: &[u8],
        remove: &mut bool,
    ) -> Yield {
        *remove = false;
        let Some(me) = Self::of(interp, cmd) else {
            return Yield::done();
        };
        if me.in_done {
            *remove = true;
            return Yield::done();
        }
        let emit = me.selection.push(chunk);
        if me.selection.complete() {
            // Everything this input contributes has been seen: unregister
            // so the reader stops pulling (and a pipe's writer sees EPIPE
            // once the fd closes with the command).
            *remove = true;
            me.reading = false;
            me.in_done = true;
        }
        if let Some(yield_) = Self::write_emit(interp, cmd, emit) {
            return yield_;
        }
        if Self::of(interp, cmd).is_some_and(|me| me.in_done) {
            return Self::advance(interp, cmd);
        }
        Yield::done()
    }

    fn on_io_reader_done(
        interp: &Interpreter,
        cmd: NodeId,
        err: Option<bun_sys::SystemError>,
    ) -> Yield {
        let Some(me) = Self::of(interp, cmd) else {
            return Yield::suspended();
        };
        if me.phase != Phase::Running || me.in_done {
            return Yield::suspended();
        }
        me.reading = false;
        me.in_done = true;
        me.read_err = err;
        Self::advance(interp, cmd)
    }
}

/// Parses the options `head` and `tail` share. `count` turns the value of
/// `-n`/`-c` into a [`Mode`] (the two commands read a sign differently);
/// `unsupported` names the short options the command knows but does not
/// implement.
fn parse_opts(
    interp: &Interpreter,
    cmd: NodeId,
    kind: Kind,
    count: fn(&[u8]) -> Option<Mode>,
    unsupported: &[u8],
) -> Result<Opts, Vec<u8>> {
    let args = Builtin::of(interp, cmd).args();
    let argc = args.len();
    let mut unit = Unit::Lines;
    let mut mode = count(b"10").expect("a plain count parses");
    let mut headers = None;
    let mut i = 0usize;

    let illegal = |opt: &[u8]| -> Vec<u8> {
        format!(
            "{}: illegal option -- {}\n",
            kind.as_str(),
            bstr::BStr::new(opt)
        )
        .into_bytes()
    };
    let requires_argument = |letter: u8| -> Vec<u8> {
        format!(
            "{}: option requires an argument -- {}\n",
            kind.as_str(),
            letter as char
        )
        .into_bytes()
    };
    let invalid = |unit: Unit, value: &[u8]| -> Vec<u8> {
        format!(
            "{}: invalid number of {}: '{}'\n",
            kind.as_str(),
            unit.as_str(),
            bstr::BStr::new(value)
        )
        .into_bytes()
    };

    while i < argc {
        let arg = args[i].get();
        if arg == b"--" {
            i += 1;
            break;
        }
        if arg.len() < 2 || arg[0] != b'-' {
            break;
        }
        i += 1;

        if arg[1] == b'-' {
            let (name, inline_value) = match bun_core::strings::index_of_char_usize(arg, b'=') {
                Some(eq) => (&arg[..eq], Some(&arg[eq + 1..])),
                None => (arg, None),
            };
            let (letter, value_unit) = match name {
                b"--lines" => (b'n', Unit::Lines),
                b"--bytes" => (b'c', Unit::Bytes),
                b"--quiet" | b"--silent" => {
                    headers = Some(false);
                    continue;
                }
                b"--verbose" => {
                    headers = Some(true);
                    continue;
                }
                _ => return Err(illegal(b"-")),
            };
            let value = match inline_value {
                Some(value) => value,
                None => {
                    if i >= argc {
                        return Err(requires_argument(letter));
                    }
                    i += 1;
                    args[i - 1].get()
                }
            };
            mode = count(value).ok_or_else(|| invalid(value_unit, value))?;
            unit = value_unit;
            continue;
        }

        // `-N` is the historical spelling of `-n N`.
        if arg[1].is_ascii_digit() {
            let value = &arg[1..];
            mode = count(value).ok_or_else(|| invalid(Unit::Lines, value))?;
            unit = Unit::Lines;
            continue;
        }

        let mut j = 1usize;
        while j < arg.len() {
            let ch = arg[j];
            j += 1;
            match ch {
                b'n' | b'c' => {
                    let value_unit = if ch == b'n' { Unit::Lines } else { Unit::Bytes };
                    let value = if j < arg.len() {
                        &arg[j..]
                    } else {
                        if i >= argc {
                            return Err(requires_argument(ch));
                        }
                        i += 1;
                        args[i - 1].get()
                    };
                    mode = count(value).ok_or_else(|| invalid(value_unit, value))?;
                    unit = value_unit;
                    break;
                }
                b'q' => headers = Some(false),
                b'v' => headers = Some(true),
                _ if bun_core::strings::contains_char(unsupported, ch) => {
                    return Err(format!(
                        "{}: unsupported option, please open a GitHub issue -- -{}\n",
                        kind.as_str(),
                        ch as char
                    )
                    .into_bytes());
                }
                _ => return Err(illegal(&arg[j - 1..j])),
            }
        }
    }

    Ok(Opts {
        unit,
        mode,
        headers,
        args_start: i,
    })
}

/// A decimal count with an optional sign. Returns the sign and the value.
fn parse_count(value: &[u8]) -> Option<(Option<u8>, u64)> {
    let (sign, digits) = match value.first() {
        Some(&sign @ (b'+' | b'-')) => (Some(sign), &value[1..]),
        _ => (None, value),
    };
    if digits.is_empty() || !digits.iter().all(u8::is_ascii_digit) {
        return None;
    }
    let mut n: u64 = 0;
    for &d in digits {
        n = n.checked_mul(10)?.checked_add(u64::from(d - b'0'))?;
    }
    Some((sign, n))
}

pub(crate) struct Head;

impl Head {
    /// `N` and `+N` print the first N units, `-N` everything but the last N.
    fn count(value: &[u8]) -> Option<Mode> {
        let (sign, n) = parse_count(value)?;
        Some(match sign {
            Some(b'-') => Mode::AllButLast(n),
            _ => Mode::First(n),
        })
    }

    pub(crate) fn start(interp: &Interpreter, cmd: NodeId) -> Yield {
        let opts = parse_opts(interp, cmd, Kind::Head, Self::count, b"z");
        Common::start(interp, cmd, Kind::Head, ReaderTag::Head, opts)
    }

    pub(crate) fn on_io_reader_chunk(
        interp: &Interpreter,
        cmd: NodeId,
        chunk: &[u8],
        remove: &mut bool,
    ) -> Yield {
        Common::on_io_reader_chunk(interp, cmd, chunk, remove)
    }

    pub(crate) fn on_io_reader_done(
        interp: &Interpreter,
        cmd: NodeId,
        err: Option<bun_sys::SystemError>,
    ) -> Yield {
        Common::on_io_reader_done(interp, cmd, err)
    }
}

pub(crate) struct Tail;

impl Tail {
    /// `N` and `-N` print the last N units, `+K` everything from unit K on.
    fn count(value: &[u8]) -> Option<Mode> {
        let (sign, n) = parse_count(value)?;
        Some(match sign {
            Some(b'+') => Mode::From(n.max(1)),
            _ => Mode::Last(n),
        })
    }

    pub(crate) fn start(interp: &Interpreter, cmd: NodeId) -> Yield {
        let opts = parse_opts(interp, cmd, Kind::Tail, Self::count, b"fFrz");
        Common::start(interp, cmd, Kind::Tail, ReaderTag::Tail, opts)
    }

    pub(crate) fn on_io_reader_chunk(
        interp: &Interpreter,
        cmd: NodeId,
        chunk: &[u8],
        remove: &mut bool,
    ) -> Yield {
        Common::on_io_reader_chunk(interp, cmd, chunk, remove)
    }

    pub(crate) fn on_io_reader_done(
        interp: &Interpreter,
        cmd: NodeId,
        err: Option<bun_sys::SystemError>,
    ) -> Yield {
        Common::on_io_reader_done(interp, cmd, err)
    }
}
