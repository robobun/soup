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

use std::io::Write as _;
use std::sync::Arc;

use crate::shell::ExitCode;
use crate::shell::builtin::{Builtin, BuiltinInput, BuiltinState, Impl, IoKind, Kind};
use crate::shell::interpreter::{Interpreter, NodeId, shell_openat, unreachable_state};
use crate::shell::io_reader::{ChildPtr as ReaderChildPtr, IOReader, ReaderTag};
use crate::shell::io_writer::{ChildPtr, WriterTag};
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
enum State {
    Idle,
    /// Reading the current input and writing the selected bytes.
    Running,
    /// An unreadable input's message is being written; carry on with the
    /// next input once it lands.
    WaitingWriteOperandErr,
    /// A usage error is being written; finish with exit code 1.
    WaitingWriteErr,
}

/// Options shared by both commands, as parsed from argv.
struct Opts {
    unit: Unit,
    mode: Mode,
    /// `Some` when `-q`/`-v` decided it; otherwise headers are printed when
    /// there is more than one input.
    headers: Option<bool>,
    /// argv index of the first operand.
    args_start: usize,
}

/// Everything `Head` and `Tail` have in common: the option grammar, the
/// input loop, the output accounting and the error reporting.
struct Common {
    kind: Kind,
    tag: ReaderTag,
    state: State,
    selection: Selection,
    /// Print a `==> name <==` header before each input.
    headers: bool,
    /// A header is separated from the previous input's output by a blank
    /// line, so the first one is printed without it.
    printed_header: bool,
    /// The current input's header, written together with its first bytes
    /// (or on its own when it has none) so each step queues one write.
    pending_header: Option<Vec<u8>>,
    args_start: usize,
    /// Number of operands; 0 means stdin is the only input.
    n_operands: usize,
    /// argv offset (from `args_start`) of the next operand.
    idx: usize,
    /// Whether stdin has been read already. A second `-` operand is an
    /// empty input, as it would be for a process whose stdin hit EOF.
    stdin_consumed: bool,
    /// Reader for a file operand. Dropping it closes the file.
    reader: Option<Arc<IOReader>>,
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
    fn new(kind: Kind, tag: ReaderTag) -> Self {
        Self {
            kind,
            tag,
            state: State::Idle,
            selection: Selection::new(Unit::Lines, Mode::First(0)),
            headers: false,
            printed_header: false,
            pending_header: None,
            args_start: 0,
            n_operands: 0,
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
        }
    }

    fn fail(interp: &Interpreter, cmd: NodeId, msg: &[u8]) -> Yield {
        Self::state_mut(interp, cmd).state = State::WaitingWriteErr;
        Builtin::write_failing_error(interp, cmd, msg, 1)
    }

    fn start(interp: &Interpreter, cmd: NodeId, opts: Result<Opts, Vec<u8>>) -> Yield {
        let opts = match opts {
            Ok(opts) => opts,
            Err(msg) => return Self::fail(interp, cmd, &msg),
        };
        let argc = Builtin::of(interp, cmd).args_slice().len();
        let me = Self::state_mut(interp, cmd);
        me.selection = Selection::new(opts.unit, opts.mode);
        me.args_start = opts.args_start;
        me.n_operands = argc - opts.args_start;
        me.headers = opts.headers.unwrap_or(me.n_operands > 1);
        me.state = State::Running;
        Self::next_input(interp, cmd)
    }

    /// Opens inputs until one can be read (reporting the ones that cannot),
    /// and finishes once every input has been printed.
    fn next_input(interp: &Interpreter, cmd: NodeId) -> Yield {
        loop {
            let (args_start, n_operands, idx) = {
                let me = Self::state_mut(interp, cmd);
                me.reader = None;
                me.reading = false;
                me.in_done = false;
                me.flushed = false;
                me.chunks_queued = 0;
                me.chunks_done = 0;
                me.selection.reset();
                (me.args_start, me.n_operands, me.idx)
            };
            if idx >= n_operands.max(1) {
                let exit_code = Self::state_mut(interp, cmd).exit_code;
                return Builtin::done(interp, cmd, exit_code);
            }
            Self::state_mut(interp, cmd).idx += 1;

            let operand: Option<&[u8]> =
                (n_operands > 0).then(|| Builtin::of(interp, cmd).arg_bytes(args_start + idx));
            let is_stdin = operand.is_none_or(|name| name == b"-");
            let name: &[u8] = if is_stdin {
                b"standard input"
            } else {
                operand.expect("a file operand")
            };

            let reader = if is_stdin {
                let consumed =
                    core::mem::replace(&mut Self::state_mut(interp, cmd).stdin_consumed, true);
                match &Builtin::of(interp, cmd).stdin {
                    BuiltinInput::Fd(reader) if !consumed => Arc::clone(reader),
                    _ => {
                        // stdin is a buffer, a Blob or nothing: the whole
                        // input is available now.
                        let bytes = if consumed {
                            Vec::new()
                        } else {
                            Builtin::read_stdin_no_io(interp, cmd).to_vec()
                        };
                        Self::queue_header(interp, cmd, name);
                        let emit = Self::state_mut(interp, cmd).selection.push(&bytes);
                        Self::state_mut(interp, cmd).in_done = true;
                        if let Some(yield_) = Self::write_emit(interp, cmd, emit) {
                            return yield_;
                        }
                        return Self::advance(interp, cmd);
                    }
                }
            } else {
                let path = Builtin::of(interp, cmd).arg_zstr(args_start + idx);
                let fd = match shell_openat(Builtin::cwd(interp, cmd), path, bun_sys::O::RDONLY, 0)
                {
                    Ok(fd) => fd,
                    Err(e) => {
                        let message = e.to_shell_system_error();
                        match Self::report_input_error(
                            interp,
                            cmd,
                            name,
                            message.message.byte_slice(),
                        ) {
                            Some(yield_) => return yield_,
                            None => continue,
                        }
                    }
                };
                let reader = IOReader::init(fd, Builtin::event_loop(interp, cmd));
                Self::state_mut(interp, cmd).reader = Some(Arc::clone(&reader));
                reader
            };

            Self::queue_header(interp, cmd, name);
            if Self::state_mut(interp, cmd).selection.complete() {
                // `head -n 0`: nothing of this input is printed, so it is
                // not read at all.
                Self::state_mut(interp, cmd).in_done = true;
                return Self::advance(interp, cmd);
            }
            let tag = {
                let me = Self::state_mut(interp, cmd);
                me.reading = true;
                me.tag
            };
            reader.set_interp(interp.as_ctx_ptr());
            reader.add_reader(ReaderChildPtr { node: cmd, tag });
            return reader.start();
        }
    }

    fn queue_header(interp: &Interpreter, cmd: NodeId, name: &[u8]) {
        let me = Self::state_mut(interp, cmd);
        if !me.headers {
            return;
        }
        let mut header = Vec::with_capacity(name.len() + 10);
        if me.printed_header {
            header.push(b'\n');
        }
        header.extend_from_slice(b"==> ");
        header.extend_from_slice(name);
        header.extend_from_slice(b" <==\n");
        me.printed_header = true;
        me.pending_header = Some(header);
    }

    /// Writes `bytes`, preceded by the pending header, to stdout. Returns
    /// the yield to propagate when the write goes through the IOWriter (its
    /// completion resumes the state machine in `on_io_writer_chunk`), or
    /// `None` once the bytes have been written and the caller can carry on.
    fn write(interp: &Interpreter, cmd: NodeId, bytes: &[u8]) -> Option<Yield> {
        let header = Self::state_mut(interp, cmd).pending_header.take();
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
        if let Some(safeguard) = Builtin::of(interp, cmd).stdout.needs_io() {
            Self::state_mut(interp, cmd).chunks_queued += 1;
            let child = ChildPtr::new(cmd, WriterTag::Builtin);
            return Some(
                Builtin::of_mut(interp, cmd)
                    .stdout
                    .enqueue(child, out, safeguard),
            );
        }
        let _ = Builtin::write_no_io(interp, cmd, IoKind::Stdout, out);
        None
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
    /// asynchronously (the state machine resumes from `on_io_writer_chunk`),
    /// or `None` once the message has been written.
    fn report_input_error(
        interp: &Interpreter,
        cmd: NodeId,
        name: &[u8],
        message: &[u8],
    ) -> Option<Yield> {
        let kind = {
            let me = Self::state_mut(interp, cmd);
            me.exit_code = 1;
            me.kind
        };
        let mut buf = Vec::new();
        let _ = writeln!(
            &mut buf,
            "{}: {}: {}",
            kind.as_str(),
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

    /// Name of the input being read, for error messages.
    fn current_input_name<'a>(interp: &'a Interpreter, cmd: NodeId) -> &'a [u8] {
        let (args_start, n_operands, idx) = {
            let me = Self::state_mut(interp, cmd);
            (me.args_start, me.n_operands, me.idx)
        };
        if n_operands == 0 {
            return b"standard input";
        }
        let name = Builtin::of(interp, cmd).arg_bytes(args_start + idx - 1);
        if name == b"-" {
            b"standard input"
        } else {
            name
        }
    }

    /// Finishes the current input once its output has landed: writes what
    /// was held back, reports a read error, and moves on to the next input.
    fn advance(interp: &Interpreter, cmd: NodeId) -> Yield {
        let flush = {
            let me = Self::state_mut(interp, cmd);
            if !me.in_done || me.chunks_done < me.chunks_queued {
                return Yield::suspended();
            }
            !core::mem::replace(&mut me.flushed, true)
        };
        if flush {
            let emit = Self::state_mut(interp, cmd).selection.finish();
            if let Some(yield_) = Self::write_emit(interp, cmd, emit) {
                return yield_;
            }
        }
        if let Some(err) = Self::state_mut(interp, cmd).read_err.take() {
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
        let (tag, reader) = {
            let me = Self::state_mut(interp, cmd);
            if !core::mem::replace(&mut me.reading, false) {
                return;
            }
            (me.tag, me.reader.take())
        };
        let child = ReaderChildPtr { node: cmd, tag };
        match reader {
            Some(reader) => reader.remove_reader(child),
            None => {
                if let BuiltinInput::Fd(reader) = &Builtin::of(interp, cmd).stdin {
                    reader.remove_reader(child);
                }
            }
        }
    }

    fn on_io_writer_chunk(
        interp: &Interpreter,
        cmd: NodeId,
        err: Option<bun_sys::SystemError>,
    ) -> Yield {
        let state = Self::state_mut(interp, cmd).state;
        if let Some(_err) = err {
            // A write that fails ends the command with exit code 1, as it
            // does for `cat`.
            if state == State::Running {
                Self::detach_reader(interp, cmd);
            }
            return Builtin::done(interp, cmd, 1);
        }
        match state {
            State::Running => {
                Self::state_mut(interp, cmd).chunks_done += 1;
                Self::advance(interp, cmd)
            }
            State::WaitingWriteOperandErr => {
                Self::state_mut(interp, cmd).state = State::Running;
                Self::next_input(interp, cmd)
            }
            State::WaitingWriteErr => Builtin::done(interp, cmd, 1),
            State::Idle => unreachable_state("HeadTail.onIOWriterChunk", "idle"),
        }
    }

    fn on_io_reader_chunk(
        interp: &Interpreter,
        cmd: NodeId,
        chunk: &[u8],
        remove: &mut bool,
    ) -> Yield {
        *remove = false;
        if Self::state_mut(interp, cmd).in_done {
            *remove = true;
            return Yield::done();
        }
        let emit = Self::state_mut(interp, cmd).selection.push(chunk);
        if Self::state_mut(interp, cmd).selection.complete() {
            // Everything this input contributes has been seen: unregister
            // so the reader stops pulling (and a pipe's writer sees EPIPE
            // once the fd closes with the command).
            *remove = true;
            let me = Self::state_mut(interp, cmd);
            me.reading = false;
            me.in_done = true;
        }
        if let Some(yield_) = Self::write_emit(interp, cmd, emit) {
            return yield_;
        }
        if Self::state_mut(interp, cmd).in_done {
            return Self::advance(interp, cmd);
        }
        Yield::done()
    }

    fn on_io_reader_done(
        interp: &Interpreter,
        cmd: NodeId,
        err: Option<bun_sys::SystemError>,
    ) -> Yield {
        let me = Self::state_mut(interp, cmd);
        if me.state != State::Running || me.in_done {
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
    let argc = Builtin::of(interp, cmd).args_slice().len();
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
        let arg = Builtin::of(interp, cmd).arg_bytes(i);
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
                    Builtin::of(interp, cmd).arg_bytes(i - 1)
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
                        Builtin::of(interp, cmd).arg_bytes(i - 1)
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

pub struct Head {
    common: Common,
}

impl Default for Head {
    fn default() -> Self {
        Self {
            common: Common::new(Kind::Head, ReaderTag::Head),
        }
    }
}

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
        Common::start(interp, cmd, opts)
    }

    pub(crate) fn on_io_writer_chunk(
        interp: &Interpreter,
        cmd: NodeId,
        _: usize,
        err: Option<bun_sys::SystemError>,
    ) -> Yield {
        Common::on_io_writer_chunk(interp, cmd, err)
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

pub struct Tail {
    common: Common,
}

impl Default for Tail {
    fn default() -> Self {
        Self {
            common: Common::new(Kind::Tail, ReaderTag::Tail),
        }
    }
}

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
        Common::start(interp, cmd, opts)
    }

    pub(crate) fn on_io_writer_chunk(
        interp: &Interpreter,
        cmd: NodeId,
        _: usize,
        err: Option<bun_sys::SystemError>,
    ) -> Yield {
        Common::on_io_writer_chunk(interp, cmd, err)
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

impl BuiltinState for Common {
    fn extract(impl_: &mut Impl) -> &mut Self {
        match impl_ {
            Impl::Head(h) => &mut h.common,
            Impl::Tail(t) => &mut t.common,
            _ => unreachable!("not head or tail"),
        }
    }
}
