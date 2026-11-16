//! `cut -b list | -c list | -f list [-d delim] [-s] [file ...]`: print the
//! selected bytes, characters or fields of every line.
//!
//! Operands are read one at a time through an `IOReader` (stdin when there
//! are none, and for `-`). A line is cut as soon as its end is read, and the
//! input is read no faster than stdout takes the output, as in `cat`. A file
//! that cannot be read is reported on stderr when its turn comes, sets the
//! exit code to 1 and does not stop the other operands, like cut(1).
//!
//! Text is UTF-8, whatever the locale says: `-c` counts characters, `-n`
//! keeps `-b` from splitting one, and `-d` takes one character. A byte that
//! is not part of a well-formed sequence is a character of its own. That is
//! GNU cut 9.11 in a UTF-8 locale. The long options and what they print are
//! those of GNU cut.

use std::rc::Rc;

use bun_core::ZStr;

use crate::shell::ExitCode;
use crate::shell::builtin::{Builtin, BuiltinInput, IoKind, Kind, Sink, State};
use crate::shell::builtins::arg_parser::{ArgParser, split_long};
use crate::shell::interpreter::{Interpreter, NodeId, shell_openat};
use crate::shell::io_reader::{ChildPtr as ReaderChildPtr, IOReader, ReaderTag};
use crate::shell::yield_::Yield;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Reading,
    /// The message about an operand that could not be read is being written.
    /// Carry on with the next operand once it lands.
    WritingOperandError,
}

#[derive(Clone, Copy, PartialEq, Eq, Default)]
enum Mode {
    #[default]
    Bytes,
    Chars,
    Fields,
}

/// "To the end of the line", as the upper end of a range.
const END: usize = usize::MAX;

/// What to print of a line.
#[derive(Default)]
struct Program {
    mode: Mode,
    /// 1-based and inclusive, in rising order. Ranges that overlap are one
    /// range. Ranges that only touch stay two, which `--output-delimiter`
    /// shows between bytes and between characters.
    ranges: Vec<(usize, usize)>,
    /// One character, which is the NUL byte for `-d ''`.
    delimiter: Vec<u8>,
    output_delimiter: Option<Vec<u8>>,
    /// `-s`: a line without the delimiter is not printed.
    only_delimited: bool,
    /// `-n`: with `-b`, a character is printed when its last byte is selected.
    whole_characters: bool,
    terminator: u8,
}

impl Program {
    /// The delimiter is the line terminator, so no line has it. As in GNU
    /// cut, the fields are then the lines of the input, which is one record.
    fn input_is_one_record(&self) -> bool {
        self.mode == Mode::Fields && self.delimiter == [self.terminator]
    }

    /// Appends what is selected of `line`, and the line terminator.
    /// `starts` is scratch space for the characters of a line.
    fn cut_line(&self, line: &[u8], starts: &mut Vec<usize>, out: &mut Vec<u8>) {
        match self.mode {
            Mode::Fields => {
                if bun_core::strings::index_of(line, &self.delimiter).is_some() {
                    self.cut_fields(line, out);
                } else if !self.only_delimited {
                    out.extend_from_slice(line);
                    out.push(self.terminator);
                }
            }
            Mode::Chars if !line.is_ascii() => {
                character_starts(line, starts);
                self.cut_units(line, starts.len() - 1, |unit| starts[unit], out);
            }
            Mode::Bytes if self.whole_characters && !line.is_ascii() => {
                character_starts(line, starts);
                self.cut_whole_characters(line, starts, out);
            }
            Mode::Bytes | Mode::Chars => self.cut_units(line, line.len(), |unit| unit, out),
        }
    }

    /// `count` units (bytes or characters) make up `line`, and unit `n`
    /// (0-based) starts at byte `start_of(n)`; `start_of(count)` is the
    /// length of the line.
    fn cut_units(
        &self,
        line: &[u8],
        count: usize,
        start_of: impl Fn(usize) -> usize,
        out: &mut Vec<u8>,
    ) {
        let mut printed = false;
        for &(low, high) in &self.ranges {
            if low > count {
                break;
            }
            if printed {
                if let Some(delimiter) = &self.output_delimiter {
                    out.extend_from_slice(delimiter);
                }
            }
            out.extend_from_slice(&line[start_of(low - 1)..start_of(high.min(count))]);
            printed = true;
        }
        out.push(self.terminator);
    }

    /// `-b` with `-n`: the ranges count bytes, and a character goes with its
    /// last byte. `starts` holds the start of every character and the length
    /// of the line.
    fn cut_whole_characters(&self, line: &[u8], starts: &[usize], out: &mut Vec<u8>) {
        let ends = &starts[1..];
        let mut printed = false;
        for &(low, high) in &self.ranges {
            // The characters whose last byte, counted from 1, is in the range.
            let first = ends.partition_point(|&end| end < low);
            let after = ends.partition_point(|&end| end <= high);
            if first >= after {
                continue;
            }
            if printed {
                if let Some(delimiter) = &self.output_delimiter {
                    out.extend_from_slice(delimiter);
                }
            }
            out.extend_from_slice(&line[starts[first]..ends[after - 1]]);
            printed = true;
        }
        out.push(self.terminator);
    }

    /// `line` has the delimiter in it.
    fn cut_fields(&self, line: &[u8], out: &mut Vec<u8>) {
        let output_delimiter = self.output_delimiter.as_deref().unwrap_or(&self.delimiter);
        let mut rest = line;
        let mut number = 1usize;
        let mut range = 0usize;
        let mut printed = false;
        loop {
            while range < self.ranges.len() && self.ranges[range].1 < number {
                range += 1;
            }
            if range == self.ranges.len() {
                break;
            }
            let end = bun_core::strings::index_of(rest, &self.delimiter);
            if self.ranges[range].0 <= number {
                if printed {
                    out.extend_from_slice(output_delimiter);
                }
                out.extend_from_slice(&rest[..end.unwrap_or(rest.len())]);
                printed = true;
            }
            let Some(end) = end else { break };
            rest = &rest[end + self.delimiter.len()..];
            number += 1;
        }
        out.push(self.terminator);
    }

    /// The whole input of an operand as one record, for `input_is_one_record`.
    fn cut_record(&self, record: &[u8], out: &mut Vec<u8>) {
        let Some(last) = record.last() else {
            return;
        };
        if bun_core::strings::index_of_char_usize(record, self.terminator).is_none() {
            if !self.only_delimited {
                out.extend_from_slice(record);
                out.push(self.terminator);
            }
            return;
        }
        // The terminator at the end of the input ends the record. It makes no empty last field.
        let fields = match *last == self.terminator {
            true => &record[..record.len() - 1],
            false => record,
        };
        // One line, with `-s` and without its one field in the list: GNU cut prints nothing.
        if self.only_delimited
            && bun_core::strings::index_of_char_usize(fields, self.terminator).is_none()
            && self.ranges.first().is_none_or(|&(low, _)| low > 1)
        {
            return;
        }
        self.cut_fields(fields, out);
    }
}

/// Fills `starts` with the start of every character of `line`, and with the
/// length of the line. A lead byte and the continuation bytes that it asks
/// for are one character. Any other byte is a character of its own, so text
/// that is not UTF-8 keeps one column per byte.
fn character_starts(line: &[u8], starts: &mut Vec<usize>) {
    starts.clear();
    let mut index = 0usize;
    while index < line.len() {
        starts.push(index);
        let length = usize::from(bun_core::strings::utf8_byte_sequence_length(line[index]));
        let well_formed = length > 1
            && line
                .get(index + 1..index + length)
                .is_some_and(|rest| rest.iter().all(|byte| (byte & 0xC0) == 0x80));
        index += if well_formed { length } else { 1 };
    }
    starts.push(line.len());
}

pub(crate) struct Cut {
    phase: Phase,
    program: Program,
    /// Index in [`Builtin::args`] of the first operand.
    args_start: usize,
    /// Number of operands; 0 means stdin is the only input.
    n_operands: usize,
    /// Offset from `args_start` of the next operand to open.
    idx: usize,
    /// Reader for the file that is being cut. Dropping it closes the file.
    reader: Option<Rc<IOReader>>,
    /// Whether the input that is being cut is stdin.
    reading_stdin: bool,
    /// Stdin is read once: a second `-` is at its end already.
    stdin_used: bool,
    /// The start of a line whose end is not read yet.
    carry: Vec<u8>,
    /// Scratch space of `Program::cut_line`.
    starts: Vec<usize>,
    /// Chunks handed to the stdout writer, and how many of them it has written.
    chunks_queued: usize,
    chunks_done: usize,
    in_done: bool,
    /// The message about a read error of the current input. It is written once the output is.
    pending_error: Option<Vec<u8>>,
    exit_code: ExitCode,
}

pub(crate) fn start(interp: &Interpreter, cmd: NodeId) -> Yield {
    let (program, args_start) = match parse_opts(interp, cmd) {
        Ok(parsed) => parsed,
        Err(message) => return Builtin::finish(interp, cmd, IoKind::Stderr, &message, 1),
    };
    let n_operands = Builtin::of(interp, cmd).args().len() - args_start;
    Builtin::of_mut(interp, cmd).state = State::Cut(Box::new(Cut {
        phase: Phase::Reading,
        program,
        args_start,
        n_operands,
        idx: 0,
        reader: None,
        reading_stdin: false,
        stdin_used: false,
        carry: Vec::new(),
        starts: Vec::new(),
        chunks_queued: 0,
        chunks_done: 0,
        in_done: false,
        pending_error: None,
        exit_code: 0,
    }));
    Cut::next_input(interp, cmd)
}

fn listener(cmd: NodeId) -> ReaderChildPtr {
    ReaderChildPtr {
        node: cmd,
        tag: ReaderTag::Cut,
    }
}

impl Cut {
    fn of(interp: &Interpreter, cmd: NodeId) -> Option<&mut Cut> {
        match &mut Builtin::of_mut(interp, cmd).state {
            State::Cut(cut) => Some(cut),
            _ => None,
        }
    }

    /// Starts to read the next operand that can be read (reporting the ones
    /// that cannot), or ends the command once there is none left. An operand
    /// that is dealt with at once is followed by the next one in this loop,
    /// not by a call: there can be any number of them.
    fn next_input(interp: &Interpreter, cmd: NodeId) -> Yield {
        loop {
            let Some(cut) = Self::of(interp, cmd) else {
                return Yield::suspended();
            };
            cut.reader = None;
            cut.reading_stdin = false;
            cut.in_done = false;
            // Without operands stdin is the one input.
            if cut.idx >= cut.n_operands.max(1) {
                return Builtin::done(interp, cmd, cut.exit_code);
            }
            let operand = cut.args_start + cut.idx;
            let stdin_only = cut.n_operands == 0;
            cut.idx += 1;

            let args = Builtin::of(interp, cmd).args();
            if stdin_only || args.get(operand).is_some_and(|arg| arg.get() == b"-") {
                match Self::read_stdin(interp, cmd) {
                    Some(yield_) => return yield_,
                    None => continue,
                }
            }

            // The `args` of the Cmd still have the NUL, and argv[0].
            let arg = interp.as_cmd(cmd).args.get(operand + 1);
            let Some(path) = arg.and_then(|arg| ZStr::from_slice_until_nul(arg)) else {
                continue;
            };
            match shell_openat(Builtin::cwd(interp, cmd), path, bun_sys::O::RDONLY, 0) {
                Ok(fd) => {
                    let reader = IOReader::init(bun_sys::File::from_fd(fd), interp.event_loop);
                    if let Some(cut) = Self::of(interp, cmd) {
                        cut.reader = Some(Rc::clone(&reader));
                    }
                    return Self::read(interp, cmd, &reader);
                }
                Err(e) => {
                    let message = e.to_shell_system_error();
                    let message = operand_error(path.as_bytes(), message.message.byte_slice());
                    if let Some(yield_) = Self::report_operand_error(interp, cmd, &message) {
                        return yield_;
                    }
                }
            }
        }
    }

    /// The caller owns a `reader` too: `start` can finish the command.
    fn read(interp: &Interpreter, cmd: NodeId, reader: &Rc<IOReader>) -> Yield {
        reader.set_interp(interp);
        reader.add_reader(listener(cmd));
        reader.start()
    }

    /// Starts to read stdin. `None` when this input is dealt with already:
    /// stdin is a buffer of the program, or nothing, or it was read before,
    /// and stdout took the output at once.
    fn read_stdin(interp: &Interpreter, cmd: NodeId) -> Option<Yield> {
        let Some(cut) = Self::of(interp, cmd) else {
            return Some(Yield::suspended());
        };
        cut.reading_stdin = true;
        let first_use = !core::mem::replace(&mut cut.stdin_used, true);
        let input: &[u8] = match &Builtin::of(interp, cmd).stdin {
            BuiltinInput::Fd(reader) if first_use => {
                return Some(Self::read(interp, cmd, &Rc::clone(reader)));
            }
            BuiltinInput::ArrayBuf { buf } if first_use => buf.slice(),
            BuiltinInput::Blob(blob) if first_use => blob.blob.shared_view(),
            _ => b"",
        };
        let mut out = Self::cut_chunk(interp, cmd, input);
        Self::end_of_input(interp, cmd, &mut out);
        Self::enqueue_output(interp, cmd, &out)
    }

    /// Cuts the lines that end in `chunk`, and keeps the start of the one that does not.
    fn cut_chunk(interp: &Interpreter, cmd: NodeId, chunk: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        let Some(cut) = Self::of(interp, cmd) else {
            return out;
        };
        if cut.program.input_is_one_record() {
            cut.carry.extend_from_slice(chunk);
            return out;
        }
        let mut rest = chunk;
        while let Some(end) = bun_core::strings::index_of_char_usize(rest, cut.program.terminator) {
            if cut.carry.is_empty() {
                cut.program
                    .cut_line(&rest[..end], &mut cut.starts, &mut out);
            } else {
                cut.carry.extend_from_slice(&rest[..end]);
                cut.program.cut_line(&cut.carry, &mut cut.starts, &mut out);
                cut.carry.clear();
            }
            rest = &rest[end + 1..];
        }
        cut.carry.extend_from_slice(rest);
        out
    }

    /// The input is at its end. A last line without a terminator is a line too.
    fn end_of_input(interp: &Interpreter, cmd: NodeId, out: &mut Vec<u8>) {
        let Some(cut) = Self::of(interp, cmd) else {
            return;
        };
        cut.in_done = true;
        if cut.program.input_is_one_record() {
            cut.program.cut_record(&cut.carry, out);
        } else if !cut.carry.is_empty() {
            cut.program.cut_line(&cut.carry, &mut cut.starts, out);
        }
        cut.carry.clear();
    }

    /// Hands `out` to stdout. `None` when stdout took it at once.
    fn enqueue_output(interp: &Interpreter, cmd: NodeId, out: &[u8]) -> Option<Yield> {
        if out.is_empty() {
            return None;
        }
        match Builtin::sink(interp, cmd, IoKind::Stdout) {
            Sink::Fd(fd) => {
                let Some(cut) = Self::of(interp, cmd) else {
                    return Some(Yield::suspended());
                };
                cut.chunks_queued += 1;
                Some(fd.enqueue(out))
            }
            Sink::Memory(memory) => {
                let _ = memory.write(out);
                None
            }
        }
    }

    /// What to do once a chunk is written to stdout, or once the input is at its end.
    fn step(interp: &Interpreter, cmd: NodeId) -> Yield {
        let Some(cut) = Self::of(interp, cmd) else {
            return Yield::suspended();
        };
        if cut.chunks_done < cut.chunks_queued {
            return Yield::suspended();
        }
        if !cut.in_done {
            // Cloned out of the state, so that no borrow of it is held while the reader runs.
            let reader = if cut.reading_stdin {
                match &Builtin::of(interp, cmd).stdin {
                    BuiltinInput::Fd(reader) => Some(Rc::clone(reader)),
                    _ => None,
                }
            } else {
                cut.reader.clone()
            };
            return reader.map_or(Yield::suspended(), |reader| reader.resume());
        }
        if let Some(message) = cut.pending_error.take() {
            if let Some(yield_) = Self::report_operand_error(interp, cmd, &message) {
                return yield_;
            }
        }
        Self::next_input(interp, cmd)
    }

    /// Writes `message` to stderr and marks the command as failed. Returns
    /// the yield to propagate when the write completes asynchronously (the
    /// state machine resumes from [`Self::on_write`]), or `None` once the
    /// message is written and the caller can carry on.
    fn report_operand_error(interp: &Interpreter, cmd: NodeId, message: &[u8]) -> Option<Yield> {
        if let Some(cut) = Self::of(interp, cmd) {
            cut.exit_code = 1;
            cut.phase = Phase::WritingOperandError;
        }
        match Builtin::sink(interp, cmd, IoKind::Stderr) {
            Sink::Fd(fd) => return Some(fd.enqueue(message)),
            Sink::Memory(memory) => {
                let _ = memory.write(message);
            }
        }
        if let Some(cut) = Self::of(interp, cmd) {
            cut.phase = Phase::Reading;
        }
        None
    }

    /// Stdout failed: stop reading and end the command with exit code 1.
    /// A pipe that nobody reads any more ends it in silence, as SIGPIPE ends
    /// cut(1). Any other error is reported, as cut(1) reports it.
    fn stdout_failed(interp: &Interpreter, cmd: NodeId, err: &bun_sys::SystemError) -> Yield {
        if let Sink::Fd(fd) = Builtin::sink(interp, cmd, IoKind::Stdout) {
            fd.cancel_queued();
        }
        // The reader of an input that is at its end has let go of this listener already.
        if let Some(cut) = Self::of(interp, cmd).filter(|cut| !cut.in_done) {
            if cut.reading_stdin {
                if let BuiltinInput::Fd(stdin) = &Builtin::of(interp, cmd).stdin {
                    stdin.remove_reader(listener(cmd));
                }
            } else if let Some(reader) = cut.reader.take() {
                reader.remove_reader(listener(cmd));
            }
        }
        if err.get_errno() == bun_sys::E::EPIPE {
            return Builtin::done(interp, cmd, 1);
        }
        let message = bstr::BStr::new(err.message.byte_slice());
        Builtin::fail(interp, cmd, format_args!("write error: {message}\n"))
    }

    /// A chunk of the output, or the message about an operand, is written or has failed.
    pub(crate) fn on_write(
        interp: &Interpreter,
        cmd: NodeId,
        err: Option<bun_sys::SystemError>,
    ) -> Yield {
        let Some(cut) = Self::of(interp, cmd) else {
            return Yield::suspended();
        };
        match cut.phase {
            Phase::Reading => {
                if let Some(err) = err {
                    return Self::stdout_failed(interp, cmd, &err);
                }
                cut.chunks_done += 1;
                Self::step(interp, cmd)
            }
            // Also when stderr did not take the message: the other operands are still cut.
            Phase::WritingOperandError => {
                cut.phase = Phase::Reading;
                Self::next_input(interp, cmd)
            }
        }
    }

    /// The reader pauses while stdout still has chunks of this `cut` to write.
    pub(crate) fn awaits_write(interp: &Interpreter, cmd: NodeId) -> bool {
        Self::of(interp, cmd)
            .is_some_and(|cut| cut.phase == Phase::Reading && cut.chunks_done < cut.chunks_queued)
    }

    pub(crate) fn on_io_reader_chunk(
        interp: &Interpreter,
        cmd: NodeId,
        chunk: &[u8],
        remove: &mut bool,
    ) -> Yield {
        *remove = false;
        let out = Self::cut_chunk(interp, cmd, chunk);
        Self::enqueue_output(interp, cmd, &out).unwrap_or(Yield::done())
    }

    pub(crate) fn on_io_reader_done(
        interp: &Interpreter,
        cmd: NodeId,
        err: Option<bun_sys::SystemError>,
    ) -> Yield {
        if Self::of(interp, cmd).is_none_or(|cut| cut.phase != Phase::Reading) {
            return Yield::suspended();
        }
        // A read error ends the input like EOF does: what was read before it is still cut.
        if let Some(err) = err {
            let operand = Self::of(interp, cmd)
                .filter(|cut| !cut.reading_stdin)
                .map(|cut| cut.args_start + cut.idx - 1);
            let name: &[u8] = match operand.and_then(|i| Builtin::of(interp, cmd).args().get(i)) {
                Some(arg) => arg.get(),
                None => b"stdin",
            };
            let message = operand_error(name, err.message.byte_slice());
            if let Some(cut) = Self::of(interp, cmd) {
                cut.pending_error = Some(message);
            }
        }
        let mut out = Vec::new();
        Self::end_of_input(interp, cmd, &mut out);
        match Self::enqueue_output(interp, cmd, &out) {
            Some(yield_) => yield_,
            None => Self::step(interp, cmd),
        }
    }
}

/// `cut: <name>: <message>`
fn operand_error(name: &[u8], message: &[u8]) -> Vec<u8> {
    Kind::Cut.message(format_args!(
        "{}: {}\n",
        bstr::BStr::new(name),
        bstr::BStr::new(message)
    ))
}

// ──────────────────────────────────────────────────────────────────────────
// option parsing
// ──────────────────────────────────────────────────────────────────────────

/// The program, and the index in [`Builtin::args`] of the first operand.
fn parse_opts(interp: &Interpreter, cmd: NodeId) -> Result<(Program, usize), Vec<u8>> {
    fn set_list<'a>(
        p: &ArgParser<'a>,
        list: &mut Option<(Mode, &'a [u8])>,
        mode: Mode,
        value: &'a [u8],
    ) -> Result<(), Vec<u8>> {
        if list.is_some() {
            return Err(p.error(format_args!("only one list may be specified")));
        }
        *list = Some((mode, value));
        Ok(())
    }

    let mut p = ArgParser::new(interp, cmd, Kind::Cut);
    let mut list: Option<(Mode, &[u8])> = None;
    let mut delimiter: Option<&[u8]> = None;
    let mut output_delimiter: Option<&[u8]> = None;
    let mut only_delimited = false;
    let mut whole_characters = false;
    let mut complement = false;
    let mut terminator = b'\n';

    while let Some(arg) = p.next_option() {
        if arg[1] == b'-' {
            let (name, inline) = split_long(arg);
            match name {
                b"--bytes" | b"--characters" | b"--fields" => {
                    let mode = match name {
                        b"--bytes" => Mode::Bytes,
                        b"--characters" => Mode::Chars,
                        _ => Mode::Fields,
                    };
                    let value = p.long_value(name, inline)?;
                    set_list(&p, &mut list, mode, value)?;
                }
                b"--delimiter" => delimiter = Some(p.long_value(name, inline)?),
                b"--output-delimiter" => output_delimiter = Some(p.long_value(name, inline)?),
                b"--only-delimited" => only_delimited = true,
                b"--complement" => complement = true,
                b"--zero-terminated" => terminator = 0,
                _ => return Err(p.illegal(b"-")),
            }
            continue;
        }

        let mut j = 1usize;
        while j < arg.len() {
            let letter = arg[j];
            j += 1;
            let rest = &arg[j..];
            match letter {
                b'b' | b'c' | b'f' => {
                    let mode = match letter {
                        b'b' => Mode::Bytes,
                        b'c' => Mode::Chars,
                        _ => Mode::Fields,
                    };
                    let value = p.short_value(letter, rest)?;
                    set_list(&p, &mut list, mode, value)?;
                    break;
                }
                b'd' => {
                    delimiter = Some(p.short_value(letter, rest)?);
                    break;
                }
                b's' => only_delimited = true,
                b'z' => terminator = 0,
                b'n' => whole_characters = true,
                b'w' => return Err(p.unsupported(b"-w")),
                _ => return Err(p.illegal(&arg[j - 1..j])),
            }
        }
    }

    let Some((mode, list)) = list else {
        return Err(p.error(format_args!(
            "you must specify a list of bytes, characters, or fields"
        )));
    };
    if mode != Mode::Fields {
        if delimiter.is_some() {
            return Err(p.error(format_args!(
                "an input delimiter may be specified only when operating on fields"
            )));
        }
        if only_delimited {
            return Err(p.error(format_args!(
                "suppressing non-delimited lines makes sense\n\tonly when operating on fields"
            )));
        }
    }
    let delimiter = match delimiter {
        None => b"\t".to_vec(),
        Some(b"") => vec![0],
        Some(value) if is_one_character(value) => value.to_vec(),
        Some(_) => {
            return Err(p.error(format_args!("the delimiter must be a single character")));
        }
    };
    // As in GNU cut, an empty string stands for the NUL byte here too.
    let output_delimiter = output_delimiter.map(|value| match value {
        b"" => vec![0],
        value => value.to_vec(),
    });

    let mut ranges =
        parse_list(list, mode).map_err(|message| p.error(format_args!("{message}")))?;
    if complement {
        ranges = complement_of(&ranges);
    }

    let program = Program {
        mode,
        ranges,
        delimiter,
        output_delimiter,
        only_delimited,
        whole_characters,
        terminator,
    };
    let argc = Builtin::of(interp, cmd).args().len();
    Ok((program, p.operands().next().unwrap_or(argc)))
}

/// One byte, or one well-formed UTF-8 sequence.
fn is_one_character(value: &[u8]) -> bool {
    let mut starts = Vec::new();
    character_starts(value, &mut starts);
    starts.len() == 2
}

/// Parses `N`, `N-`, `N-M` and `-M`, separated by commas or blanks, into
/// ranges in rising order, with the ones that overlap merged.
fn parse_list(list: &[u8], mode: Mode) -> Result<Vec<(usize, usize)>, String> {
    let from_one = || match mode {
        Mode::Fields => "fields are numbered from 1".to_owned(),
        Mode::Bytes | Mode::Chars => "byte/character positions are numbered from 1".to_owned(),
    };
    let number = |text: &[u8]| -> Result<usize, String> {
        if text.is_empty() || !text.iter().all(u8::is_ascii_digit) {
            let text = bstr::BStr::new(text);
            return Err(match mode {
                Mode::Fields => format!("invalid field value '{text}'"),
                Mode::Bytes | Mode::Chars => format!("invalid byte/character position '{text}'"),
            });
        }
        // A number that does not fit selects what no line has, like `END - 1` does.
        let value = text.iter().fold(0usize, |value, digit| {
            value
                .saturating_mul(10)
                .saturating_add(usize::from(digit - b'0'))
        });
        match value {
            0 => Err(from_one()),
            value => Ok(value.min(END - 1)),
        }
    };

    let mut ranges: Vec<(usize, usize)> = Vec::new();
    for item in bun_core::strings::split_any(list, b", \t") {
        let range = match bun_core::strings::split_once_char(item, b'-') {
            None if item.is_empty() => return Err(from_one()),
            None => {
                let value = number(item)?;
                (value, value)
            }
            Some((b"", b"")) => return Err("invalid range with no endpoint: -".to_owned()),
            Some((b"", high)) => (1, number(high)?),
            Some((low, b"")) => (number(low)?, END),
            Some((low, high)) => {
                let (low, high) = (number(low)?, number(high)?);
                if low > high {
                    return Err("invalid decreasing range".to_owned());
                }
                (low, high)
            }
        };
        ranges.push(range);
    }

    ranges.sort_unstable();
    let mut merged: Vec<(usize, usize)> = Vec::with_capacity(ranges.len());
    for (low, high) in ranges {
        match merged.last_mut() {
            Some(last) if low <= last.1 => last.1 = last.1.max(high),
            _ => merged.push((low, high)),
        }
    }
    Ok(merged)
}

/// The ranges that `ranges` leaves out.
fn complement_of(ranges: &[(usize, usize)]) -> Vec<(usize, usize)> {
    let mut out = Vec::with_capacity(ranges.len() + 1);
    let mut next = 1usize;
    for &(low, high) in ranges {
        if low > next {
            out.push((next, low - 1));
        }
        if high == END {
            return out;
        }
        next = next.max(high + 1);
    }
    out.push((next, END));
    out
}
