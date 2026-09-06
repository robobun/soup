//! `sort` and `uniq`: line filters that need the whole input before they
//! can write anything.
//!
//! The two commands share this module because they share their shape: every
//! input is read to the end through an `IOReader` (stdin when there are no
//! operands, or for a `-` operand), the lines are rearranged in memory, and
//! the result is written once, to stdout or to the output file named by
//! `sort -o` or `uniq`'s second operand. [`Sort`] and [`Uniq`] differ in
//! their options, in the [`Program`] that turns the input into the output,
//! and in the name and exit code on their messages. An input that cannot be
//! read is reported on stderr as it is encountered, sets the exit code, and
//! does not stop the remaining inputs from being read.

use std::cmp::Ordering;
use std::io::Write as _;
use std::sync::Arc;

use crate::shell::ExitCode;
use crate::shell::builtin::{Builtin, BuiltinInput, BuiltinState, Impl, IoKind, Kind};
use crate::shell::interpreter::{Interpreter, NodeId, shell_openat, unreachable_state};
use crate::shell::io_reader::{ChildPtr as ReaderChildPtr, IOReader, ReaderTag};
use crate::shell::io_writer::{ChildPtr, WriterTag};
use crate::shell::yield_::Yield;

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    Idle,
    Reading,
    /// An unreadable input's message is being written; carry on with the
    /// next input once it lands.
    WaitingWriteInputErr,
    /// The result is being written; finish once it lands.
    WaitingWriteOut,
    /// A fatal message is being written; finish with `exit_code`.
    WaitingWriteErr,
}

fn is_blank(b: u8) -> bool {
    b == b' ' || b == b'\t'
}

/// Where a line's `field`th field starts and ends (fields count from 1).
/// Without a separator a field is a run of blanks followed by a run of
/// non-blanks, as in sort(1) and uniq(1); with one, the separator is not
/// part of either field.
fn field_bounds(line: &[u8], separator: Option<u8>, field: usize) -> Option<(usize, usize)> {
    let mut pos = 0usize;
    let mut n = 0usize;
    match separator {
        Some(sep) => loop {
            let end = bun_core::strings::index_of_char_usize(&line[pos..], sep)
                .map_or(line.len(), |i| pos + i);
            n += 1;
            if n == field {
                return Some((pos, end));
            }
            if end == line.len() {
                return None;
            }
            pos = end + 1;
        },
        None => {
            while pos < line.len() {
                let start = pos;
                while pos < line.len() && is_blank(line[pos]) {
                    pos += 1;
                }
                while pos < line.len() && !is_blank(line[pos]) {
                    pos += 1;
                }
                n += 1;
                if n == field {
                    return Some((start, pos));
                }
            }
            None
        }
    }
}

fn skip_blanks(line: &[u8], mut pos: usize) -> usize {
    while pos < line.len() && is_blank(line[pos]) {
        pos += 1;
    }
    pos
}

// ──────────────────────────────────────────────────────────────────────────
// sort
// ──────────────────────────────────────────────────────────────────────────

/// The ordering options that apply to one key, or to the whole line.
#[derive(Clone, Copy, Default, PartialEq, Eq)]
struct KeyOrdering {
    numeric: bool,
    fold_case: bool,
    reverse: bool,
    skip_blanks: bool,
}

impl KeyOrdering {
    /// Applies one of the letters `-k` accepts after a position. `i` and
    /// `d` are accepted and ignored: in the `C` locale every byte is
    /// printable and significant.
    fn apply(&mut self, letter: u8) -> bool {
        match letter {
            b'n' => self.numeric = true,
            b'f' => self.fold_case = true,
            b'r' => self.reverse = true,
            b'b' => self.skip_blanks = true,
            b'i' | b'd' => {}
            _ => return false,
        }
        true
    }

    fn compare(self, a: &[u8], b: &[u8]) -> Ordering {
        let ord = if self.numeric {
            numeric_compare(a, b)
        } else if self.fold_case {
            a.iter()
                .map(u8::to_ascii_uppercase)
                .cmp(b.iter().map(u8::to_ascii_uppercase))
        } else {
            a.cmp(b)
        };
        if self.reverse { ord.reverse() } else { ord }
    }
}

/// A decimal number as `sort -n` reads it: optional leading blanks, an
/// optional `-`, digits, and an optional fraction. The digits are kept as
/// they are, with leading and trailing zeros dropped, so the comparison
/// never overflows or rounds.
struct Decimal<'a> {
    negative: bool,
    integer: &'a [u8],
    fraction: &'a [u8],
}

impl<'a> Decimal<'a> {
    fn parse(s: &'a [u8]) -> Self {
        let mut pos = skip_blanks(s, 0);
        let negative = s.get(pos) == Some(&b'-');
        if negative {
            pos += 1;
        }
        let int_start = pos;
        while pos < s.len() && s[pos].is_ascii_digit() {
            pos += 1;
        }
        let mut integer = &s[int_start..pos];
        while let Some((&b'0', rest)) = integer.split_first() {
            integer = rest;
        }
        let mut fraction: &[u8] = b"";
        if s.get(pos) == Some(&b'.') {
            let frac_start = pos + 1;
            pos = frac_start;
            while pos < s.len() && s[pos].is_ascii_digit() {
                pos += 1;
            }
            fraction = &s[frac_start..pos];
            while let Some((&b'0', rest)) = fraction.split_last() {
                fraction = rest;
            }
        }
        // `-0`, `-.0` and a line with no number at all are all zero.
        let negative = negative && !(integer.is_empty() && fraction.is_empty());
        Self {
            negative,
            integer,
            fraction,
        }
    }

    fn magnitude_cmp(&self, other: &Self) -> Ordering {
        self.integer
            .len()
            .cmp(&other.integer.len())
            .then_with(|| self.integer.cmp(other.integer))
            .then_with(|| self.fraction.cmp(other.fraction))
    }
}

fn numeric_compare(a: &[u8], b: &[u8]) -> Ordering {
    let (a, b) = (Decimal::parse(a), Decimal::parse(b));
    match (a.negative, b.negative) {
        (true, false) => Ordering::Less,
        (false, true) => Ordering::Greater,
        (false, false) => a.magnitude_cmp(&b),
        (true, true) => b.magnitude_cmp(&a),
    }
}

/// One end of a `-k` key: a field, and a character within it (1-based; 0
/// means the field's own boundary).
#[derive(Clone, Copy)]
struct KeyPos {
    field: usize,
    char: usize,
}

#[derive(Clone, Copy)]
struct Key {
    start: KeyPos,
    end: Option<KeyPos>,
    ordering: KeyOrdering,
}

impl Key {
    /// Parses `F[.C][OPTS][,F[.C][OPTS]]`. An error names what is wrong,
    /// as GNU sort does.
    fn parse(spec: &[u8], global: KeyOrdering) -> Result<Key, Vec<u8>> {
        let invalid = |what: &str| -> Vec<u8> {
            format!(
                "{what}: invalid field specification '{}'",
                bstr::BStr::new(spec)
            )
            .into_bytes()
        };
        let (start_spec, end_spec) = match bun_core::strings::split_once_char(spec, b',') {
            Some((s, e)) => (s, Some(e)),
            None => (spec, None),
        };

        let mut ordering = KeyOrdering::default();
        let mut has_letters = false;
        let mut parse_pos = |s: &[u8], is_end: bool| -> Result<KeyPos, Vec<u8>> {
            let (field, rest) = parse_number(s).ok_or_else(|| invalid("invalid number"))?;
            if field == 0 {
                return Err(invalid("field number is zero"));
            }
            let (char, rest) = match rest.split_first() {
                Some((b'.', rest)) => {
                    let (c, rest) = parse_number(rest).ok_or_else(|| invalid("invalid number"))?;
                    if c == 0 && !is_end {
                        return Err(invalid("character offset is zero"));
                    }
                    (c, rest)
                }
                _ => (if is_end { 0 } else { 1 }, rest),
            };
            for &letter in rest {
                if !ordering.apply(letter) {
                    return Err(format!(
                        "invalid option letter '{}' in field specification '{}'",
                        letter as char,
                        bstr::BStr::new(spec)
                    )
                    .into_bytes());
                }
                has_letters = true;
            }
            Ok(KeyPos { field, char })
        };
        let start = parse_pos(start_spec, false)?;
        let end = end_spec.map(|e| parse_pos(e, true)).transpose()?;
        // A key with ordering letters of its own ignores the global ones.
        let ordering = if has_letters { ordering } else { global };
        Ok(Key {
            start,
            end,
            ordering,
        })
    }

    /// The bytes of `line` this key compares.
    fn extract<'a>(&self, line: &'a [u8], separator: Option<u8>) -> &'a [u8] {
        // A character offset past the field reaches into the next one,
        // as in GNU sort; it is only cut at the line's end.
        let start = match field_bounds(line, separator, self.start.field) {
            Some((start, _)) => {
                let start = if self.ordering.skip_blanks {
                    skip_blanks(line, start)
                } else {
                    start
                };
                (start + self.start.char - 1).min(line.len())
            }
            None => line.len(),
        };
        let end = match self.end {
            None => line.len(),
            Some(KeyPos { field, char }) => match field_bounds(line, separator, field) {
                Some((field_start, field_end)) => {
                    if char == 0 {
                        field_end
                    } else {
                        let field_start = if self.ordering.skip_blanks {
                            skip_blanks(line, field_start)
                        } else {
                            field_start
                        };
                        (field_start + char).min(line.len())
                    }
                }
                None => line.len(),
            },
        };
        if end <= start { b"" } else { &line[start..end] }
    }
}

/// A decimal `usize` prefix and what follows it.
fn parse_number(s: &[u8]) -> Option<(usize, &[u8])> {
    let mut n: usize = 0;
    let mut len = 0usize;
    while let Some(&d) = s.get(len) {
        if !d.is_ascii_digit() {
            break;
        }
        n = n.checked_mul(10)?.checked_add(usize::from(d - b'0'))?;
        len += 1;
    }
    (len > 0).then_some((n, &s[len..]))
}

fn parse_whole_number(s: &[u8]) -> Option<usize> {
    match parse_number(s) {
        Some((n, [])) => Some(n),
        _ => None,
    }
}

#[derive(Default)]
struct SortOpts {
    keys: Vec<Key>,
    global: KeyOrdering,
    separator: Option<u8>,
    /// `-s`: no last-resort comparison, equal lines keep their input order.
    stable: bool,
    /// `-u`: of a run of equal lines only the first is printed.
    unique: bool,
    /// `-c`: report the first line that is out of order instead of sorting.
    check: bool,
}

impl SortOpts {
    /// Compares the keys of two lines, without the last-resort comparison.
    fn compare_keys(&self, a: &[u8], b: &[u8]) -> Ordering {
        if self.keys.is_empty() {
            let (ka, kb) = if self.global.skip_blanks {
                (&a[skip_blanks(a, 0)..], &b[skip_blanks(b, 0)..])
            } else {
                (a, b)
            };
            return self.global.compare(ka, kb);
        }
        for key in &self.keys {
            let ord = key.ordering.compare(
                key.extract(a, self.separator),
                key.extract(b, self.separator),
            );
            if ord != Ordering::Equal {
                return ord;
            }
        }
        Ordering::Equal
    }

    /// The full ordering: the keys, then, unless `-s` or `-u`, the whole
    /// line byte for byte (reversed by a global `-r`, as in GNU sort).
    fn compare(&self, a: &[u8], b: &[u8]) -> Ordering {
        let ord = self.compare_keys(a, b);
        if ord != Ordering::Equal || self.stable || self.unique {
            return ord;
        }
        let ord = a.cmp(b);
        if self.global.reverse {
            ord.reverse()
        } else {
            ord
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────
// uniq
// ──────────────────────────────────────────────────────────────────────────

struct UniqOpts {
    /// Print the runs of exactly one line (off with `-d` and `-D`).
    unique: bool,
    /// Print the first line of every run longer than one (off with `-u`).
    first_repeated: bool,
    /// `-D`: print the other lines of every run longer than one as well.
    later_repeated: bool,
    /// `-c`: prefix each line with the length of its run.
    count: bool,
    ignore_case: bool,
    /// `-f`: fields to skip before comparing.
    skip_fields: usize,
    /// `-s`: bytes to skip after the fields.
    skip_chars: usize,
    /// `-w`: bytes to compare after that.
    check_chars: Option<usize>,
}

impl Default for UniqOpts {
    fn default() -> Self {
        Self {
            unique: true,
            first_repeated: true,
            later_repeated: false,
            count: false,
            ignore_case: false,
            skip_fields: 0,
            skip_chars: 0,
            check_chars: None,
        }
    }
}

impl UniqOpts {
    fn key<'a>(&self, line: &'a [u8]) -> &'a [u8] {
        let mut pos = 0usize;
        if self.skip_fields > 0 {
            pos = match field_bounds(line, None, self.skip_fields) {
                Some((_, end)) => end,
                None => line.len(),
            };
        }
        pos = (pos + self.skip_chars).min(line.len());
        let key = &line[pos..];
        match self.check_chars {
            Some(n) if n < key.len() => &key[..n],
            _ => key,
        }
    }

    fn same(&self, a: &[u8], b: &[u8]) -> bool {
        let (a, b) = (self.key(a), self.key(b));
        if self.ignore_case {
            a.eq_ignore_ascii_case(b)
        } else {
            a == b
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────
// the shared state machine
// ──────────────────────────────────────────────────────────────────────────

enum Program {
    Sort(SortOpts),
    Uniq(UniqOpts),
}

/// Why the program could not produce its output: the message for stderr
/// and the exit code.
struct Failure {
    message: Vec<u8>,
    exit_code: ExitCode,
}

impl Program {
    /// Splits the input into lines. Every input was given a terminator
    /// when it was read, so the last line is never cut short.
    fn lines(input: &[u8], terminator: u8) -> Vec<&[u8]> {
        let mut lines = Vec::new();
        let mut rest = input;
        while let Some(i) = bun_core::strings::index_of_char_usize(rest, terminator) {
            lines.push(&rest[..i]);
            rest = &rest[i + 1..];
        }
        lines
    }

    fn run(&self, input: &[u8], terminator: u8, input_name: &[u8]) -> Result<Vec<u8>, Failure> {
        let mut lines = Self::lines(input, terminator);
        let mut out = Vec::with_capacity(input.len());
        match self {
            Program::Sort(opts) if opts.check => {
                for i in 1..lines.len() {
                    let ord = opts.compare(lines[i - 1], lines[i]);
                    if ord == Ordering::Greater || (opts.unique && ord == Ordering::Equal) {
                        let mut message = Vec::new();
                        let _ = writeln!(
                            &mut message,
                            "sort: {}:{}: disorder: {}",
                            bstr::BStr::new(input_name),
                            i + 1,
                            bstr::BStr::new(lines[i])
                        );
                        return Err(Failure {
                            message,
                            exit_code: 1,
                        });
                    }
                }
            }
            Program::Sort(opts) => {
                lines.sort_by(|a, b| opts.compare(a, b));
                let mut previous: Option<&[u8]> = None;
                for line in lines {
                    if opts.unique
                        && previous.is_some_and(|p| opts.compare_keys(p, line) == Ordering::Equal)
                    {
                        continue;
                    }
                    out.extend_from_slice(line);
                    out.push(terminator);
                    previous = Some(line);
                }
            }
            Program::Uniq(opts) => {
                let mut i = 0usize;
                while i < lines.len() {
                    let mut j = i + 1;
                    while j < lines.len() && opts.same(lines[i], lines[j]) {
                        j += 1;
                    }
                    let run = j - i;
                    // The three switches combine as in GNU uniq, so `-du`
                    // prints nothing and `-Du` only the later copies.
                    let print = if run == 1 {
                        if opts.unique {
                            &lines[i..j]
                        } else {
                            &lines[i..i]
                        }
                    } else {
                        let from = if opts.first_repeated { i } else { i + 1 };
                        let to = if opts.later_repeated { j } else { i + 1 };
                        &lines[from..to.max(from)]
                    };
                    for line in print {
                        if opts.count {
                            let _ = write!(&mut out, "{run:>7} ");
                        }
                        out.extend_from_slice(line);
                        out.push(terminator);
                    }
                    i = j;
                }
            }
        }
        Ok(out)
    }
}

/// Where one input comes from.
#[derive(Clone, Copy)]
enum Input {
    Stdin,
    /// argv index of the path.
    File(usize),
}

struct Opts {
    program: Program,
    terminator: u8,
    inputs: Vec<Input>,
    /// The file the result goes to, instead of stdout, with a trailing NUL.
    output: Option<Vec<u8>>,
}

pub struct Common {
    kind: Kind,
    tag: ReaderTag,
    /// Exit code of a failed read, open or usage error (`sort` uses 2,
    /// `uniq` 1).
    failure_code: ExitCode,
    state: State,
    program: Program,
    terminator: u8,
    inputs: Vec<Input>,
    /// Index of the next input to read.
    idx: usize,
    output: Option<Vec<u8>>,
    /// Whether stdin has been read already. A second `-` operand is an
    /// empty input, as it would be for a process whose stdin hit EOF.
    stdin_consumed: bool,
    /// Reader for a file operand. Dropping it closes the file.
    reader: Option<Arc<IOReader>>,
    /// Every input so far, each ended with the terminator.
    buf: Vec<u8>,
    exit_code: ExitCode,
}

impl Common {
    fn new(kind: Kind, tag: ReaderTag, failure_code: ExitCode, program: Program) -> Self {
        Self {
            kind,
            tag,
            failure_code,
            state: State::Idle,
            program,
            terminator: b'\n',
            inputs: Vec::new(),
            idx: 0,
            output: None,
            stdin_consumed: false,
            reader: None,
            buf: Vec::new(),
            exit_code: 0,
        }
    }

    fn fail(interp: &Interpreter, cmd: NodeId, msg: &[u8]) -> Yield {
        let me = Self::state_mut(interp, cmd);
        me.state = State::WaitingWriteErr;
        me.exit_code = me.failure_code;
        let exit_code = me.exit_code;
        Builtin::write_failing_error(interp, cmd, msg, exit_code)
    }

    fn start(interp: &Interpreter, cmd: NodeId, opts: Result<Opts, Vec<u8>>) -> Yield {
        let opts = match opts {
            Ok(opts) => opts,
            Err(msg) => return Self::fail(interp, cmd, &msg),
        };
        let me = Self::state_mut(interp, cmd);
        me.program = opts.program;
        me.terminator = opts.terminator;
        me.inputs = opts.inputs;
        me.output = opts.output;
        me.state = State::Reading;
        Self::next_input(interp, cmd)
    }

    /// Opens inputs until one can be read (reporting the ones that cannot),
    /// and runs the program once every input has been read.
    fn next_input(interp: &Interpreter, cmd: NodeId) -> Yield {
        loop {
            let input = {
                let me = Self::state_mut(interp, cmd);
                me.reader = None;
                match me.inputs.get(me.idx) {
                    Some(&input) => input,
                    None => return Self::write_output(interp, cmd),
                }
            };
            Self::state_mut(interp, cmd).idx += 1;

            let reader = match input {
                Input::Stdin => {
                    let consumed =
                        core::mem::replace(&mut Self::state_mut(interp, cmd).stdin_consumed, true);
                    match &Builtin::of(interp, cmd).stdin {
                        BuiltinInput::Fd(reader) if !consumed => Arc::clone(reader),
                        _ => {
                            // stdin is a buffer, a Blob or nothing: the whole
                            // input is available now.
                            if !consumed {
                                let bytes = Builtin::read_stdin_no_io(interp, cmd);
                                Self::state_mut(interp, cmd).buf.extend_from_slice(bytes);
                            }
                            Self::finish_input(interp, cmd);
                            continue;
                        }
                    }
                }
                Input::File(i) => {
                    let path = Builtin::of(interp, cmd).arg_zstr(i);
                    let fd = match shell_openat(
                        Builtin::cwd(interp, cmd),
                        path,
                        bun_sys::O::RDONLY,
                        0,
                    ) {
                        Ok(fd) => fd,
                        Err(e) => {
                            let message = e.to_shell_system_error();
                            match Self::report_input_error(
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
                    Self::state_mut(interp, cmd).reader = Some(Arc::clone(&reader));
                    reader
                }
            };

            let tag = Self::state_mut(interp, cmd).tag;
            reader.set_interp(interp.as_ctx_ptr());
            reader.add_reader(ReaderChildPtr { node: cmd, tag });
            return reader.start();
        }
    }

    /// Ends the input just read with the terminator, so a last line
    /// without one is a line of its own and does not run into the next
    /// input's first line.
    fn finish_input(interp: &Interpreter, cmd: NodeId) {
        let me = Self::state_mut(interp, cmd);
        if me.buf.last().is_some_and(|&b| b != me.terminator) {
            me.buf.push(me.terminator);
        }
    }

    /// Writes `<kind>: <name>: <message>` (`sort: cannot read: <name>:
    /// <message>`) to stderr and marks the command as failed. Returns the
    /// yield to propagate when the write completes asynchronously (the
    /// state machine resumes from `on_io_writer_chunk`), or `None` once the
    /// message has been written.
    fn report_input_error(
        interp: &Interpreter,
        cmd: NodeId,
        name: &[u8],
        message: &[u8],
    ) -> Option<Yield> {
        let kind = {
            let me = Self::state_mut(interp, cmd);
            me.exit_code = me.failure_code;
            me.kind
        };
        let mut buf = Vec::new();
        let _ = match kind {
            Kind::Sort => writeln!(
                &mut buf,
                "sort: cannot read: {}: {}",
                bstr::BStr::new(name),
                bstr::BStr::new(message)
            ),
            _ => writeln!(
                &mut buf,
                "{}: {}: {}",
                kind.as_str(),
                bstr::BStr::new(name),
                bstr::BStr::new(message)
            ),
        };
        if let Some(safeguard) = Builtin::of(interp, cmd).stderr.needs_io() {
            Self::state_mut(interp, cmd).state = State::WaitingWriteInputErr;
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

    /// Name of the input that was read last, for messages.
    fn input_name<'a>(interp: &'a Interpreter, cmd: NodeId) -> &'a [u8] {
        let me = Self::state_mut(interp, cmd);
        match me.inputs.get(me.idx.wrapping_sub(1)) {
            Some(&Input::File(i)) => Builtin::of(interp, cmd).arg_bytes(i),
            _ => b"-",
        }
    }

    /// Runs the program over everything that was read and writes the result.
    fn write_output(interp: &Interpreter, cmd: NodeId) -> Yield {
        let (out, output) = {
            let name = Self::input_name(interp, cmd);
            let me = Self::state_mut(interp, cmd);
            let buf = core::mem::take(&mut me.buf);
            match me.program.run(&buf, me.terminator, name) {
                Ok(out) => (out, me.output.take()),
                Err(Failure { message, exit_code }) => {
                    me.state = State::WaitingWriteErr;
                    me.exit_code = exit_code;
                    return Builtin::write_failing_error(interp, cmd, &message, exit_code);
                }
            }
        };

        if let Some(path) = output {
            let path = bun_core::ZStr::from_buf(&path, path.len() - 1);
            let result = shell_openat(
                Builtin::cwd(interp, cmd),
                path,
                bun_sys::O::WRONLY | bun_sys::O::CREAT | bun_sys::O::TRUNC,
                0o666,
            )
            .and_then(|fd| bun_sys::File::from_fd(fd).write_all(&out));
            if let Err(e) = result {
                let message = e.to_shell_system_error();
                let kind = Self::state_mut(interp, cmd).kind;
                let mut buf = Vec::new();
                let _ = writeln!(
                    &mut buf,
                    "{}: {}: {}",
                    kind.as_str(),
                    bstr::BStr::new(path.as_bytes()),
                    bstr::BStr::new(message.message.byte_slice())
                );
                return Self::fail(interp, cmd, &buf);
            }
            let exit_code = Self::state_mut(interp, cmd).exit_code;
            return Builtin::done(interp, cmd, exit_code);
        }

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

    fn on_io_writer_chunk(
        interp: &Interpreter,
        cmd: NodeId,
        err: Option<bun_sys::SystemError>,
    ) -> Yield {
        if let Some(_err) = err {
            let exit_code = Self::state_mut(interp, cmd).failure_code;
            return Builtin::done(interp, cmd, exit_code);
        }
        match Self::state_mut(interp, cmd).state {
            State::WaitingWriteInputErr => {
                Self::state_mut(interp, cmd).state = State::Reading;
                Self::next_input(interp, cmd)
            }
            State::WaitingWriteOut | State::WaitingWriteErr => {
                let exit_code = Self::state_mut(interp, cmd).exit_code;
                Builtin::done(interp, cmd, exit_code)
            }
            State::Idle => unreachable_state("SortUniq.onIOWriterChunk", "idle"),
            State::Reading => unreachable_state("SortUniq.onIOWriterChunk", "reading"),
        }
    }

    fn on_io_reader_chunk(
        interp: &Interpreter,
        cmd: NodeId,
        chunk: &[u8],
        remove: &mut bool,
    ) -> Yield {
        *remove = false;
        Self::state_mut(interp, cmd).buf.extend_from_slice(chunk);
        Yield::done()
    }

    fn on_io_reader_done(
        interp: &Interpreter,
        cmd: NodeId,
        err: Option<bun_sys::SystemError>,
    ) -> Yield {
        if Self::state_mut(interp, cmd).state != State::Reading {
            return Yield::suspended();
        }
        Self::finish_input(interp, cmd);
        if let Some(err) = err {
            let name = Self::input_name(interp, cmd);
            if let Some(yield_) =
                Self::report_input_error(interp, cmd, name, err.message.byte_slice())
            {
                return yield_;
            }
        }
        Self::next_input(interp, cmd)
    }
}

// ──────────────────────────────────────────────────────────────────────────
// option parsing
// ──────────────────────────────────────────────────────────────────────────

/// Walks argv for the two commands: `--` ends the options, the first
/// argument that does not start with `-` (or is `-` alone) starts the
/// operands. Short options may take their value in the same argument
/// (`-k2`, `-t,`) or the next one; long ones as `--key=2` or the next
/// argument.
struct ArgParser<'a> {
    interp: &'a Interpreter,
    cmd: NodeId,
    kind: Kind,
    argc: usize,
    i: usize,
}

impl<'a> ArgParser<'a> {
    fn new(interp: &'a Interpreter, cmd: NodeId, kind: Kind) -> Self {
        let argc = Builtin::of(interp, cmd).args_slice().len();
        Self {
            interp,
            cmd,
            kind,
            argc,
            i: 0,
        }
    }

    fn arg(&self, i: usize) -> &'a [u8] {
        Builtin::of(self.interp, self.cmd).arg_bytes(i)
    }

    fn error(&self, args: core::fmt::Arguments<'_>) -> Vec<u8> {
        format!("{}: {args}\n", self.kind.as_str()).into_bytes()
    }

    fn illegal(&self, opt: &[u8]) -> Vec<u8> {
        self.error(format_args!("illegal option -- {}", bstr::BStr::new(opt)))
    }

    fn unsupported(&self, opt: &[u8]) -> Vec<u8> {
        self.error(format_args!(
            "unsupported option, please open a GitHub issue -- {}",
            bstr::BStr::new(opt)
        ))
    }

    /// The next option argument, or `None` once the operands start.
    fn next_option(&mut self) -> Option<&'a [u8]> {
        if self.i >= self.argc {
            return None;
        }
        let arg = self.arg(self.i);
        if arg == b"--" {
            self.i += 1;
            return None;
        }
        if arg.len() < 2 || arg[0] != b'-' {
            return None;
        }
        self.i += 1;
        Some(arg)
    }

    /// The value of a long option: after its `=`, or the next argument.
    fn long_value(&mut self, name: &[u8], inline: Option<&'a [u8]>) -> Result<&'a [u8], Vec<u8>> {
        if let Some(value) = inline {
            return Ok(value);
        }
        if self.i >= self.argc {
            return Err(self.error(format_args!(
                "option '{}' requires an argument",
                bstr::BStr::new(name)
            )));
        }
        self.i += 1;
        Ok(self.arg(self.i - 1))
    }

    /// The value of a short option: the rest of its cluster, or the next
    /// argument.
    fn short_value(&mut self, letter: u8, rest: &'a [u8]) -> Result<&'a [u8], Vec<u8>> {
        if !rest.is_empty() {
            return Ok(rest);
        }
        if self.i >= self.argc {
            return Err(self.error(format_args!(
                "option requires an argument -- {}",
                letter as char
            )));
        }
        self.i += 1;
        Ok(self.arg(self.i - 1))
    }

    fn operands(&self) -> impl Iterator<Item = usize> + use<'_> {
        self.i..self.argc
    }

    fn input(&self, i: usize) -> Input {
        if self.arg(i) == b"-" {
            Input::Stdin
        } else {
            Input::File(i)
        }
    }
}

fn nul_terminated(path: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(path.len() + 1);
    v.extend_from_slice(path);
    v.push(0);
    v
}

fn split_long(arg: &[u8]) -> (&[u8], Option<&[u8]>) {
    match bun_core::strings::split_once_char(arg, b'=') {
        Some((name, value)) => (name, Some(value)),
        None => (arg, None),
    }
}

fn parse_sort_opts(interp: &Interpreter, cmd: NodeId) -> Result<Opts, Vec<u8>> {
    let mut p = ArgParser::new(interp, cmd, Kind::Sort);
    let mut opts = SortOpts::default();
    let mut terminator = b'\n';
    let mut output: Option<&[u8]> = None;
    // `-k` specs are parsed once the global options are known, since a key
    // without letters of its own takes them.
    let mut key_specs: Vec<&[u8]> = Vec::new();

    let separator = |p: &ArgParser, value: &[u8]| -> Result<Option<u8>, Vec<u8>> {
        match value {
            [sep] => Ok(Some(*sep)),
            b"\\0" => Ok(Some(0)),
            _ => Err(p.error(format_args!(
                "multi-character tab '{}'",
                bstr::BStr::new(value)
            ))),
        }
    };

    while let Some(arg) = p.next_option() {
        if arg[1] == b'-' {
            let (name, inline) = split_long(arg);
            match name {
                b"--numeric-sort" => opts.global.numeric = true,
                b"--ignore-case" => opts.global.fold_case = true,
                b"--reverse" => opts.global.reverse = true,
                b"--ignore-leading-blanks" => opts.global.skip_blanks = true,
                b"--stable" => opts.stable = true,
                b"--unique" => opts.unique = true,
                b"--check" => opts.check = true,
                b"--zero-terminated" => terminator = 0,
                b"--key" => key_specs.push(p.long_value(name, inline)?),
                b"--field-separator" => {
                    let value = p.long_value(name, inline)?;
                    opts.separator = separator(&p, value)?;
                }
                b"--output" => output = Some(p.long_value(name, inline)?),
                b"--dictionary-order" | b"--ignore-nonprinting" => {}
                b"--general-numeric-sort"
                | b"--human-numeric-sort"
                | b"--month-sort"
                | b"--version-sort"
                | b"--random-sort"
                | b"--merge"
                | b"--buffer-size"
                | b"--temporary-directory"
                | b"--parallel"
                | b"--files0-from"
                | b"--batch-size"
                | b"--compress-program"
                | b"--debug"
                | b"--random-source" => return Err(p.unsupported(name)),
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
                b'n' => opts.global.numeric = true,
                b'f' => opts.global.fold_case = true,
                b'r' => opts.global.reverse = true,
                b'b' => opts.global.skip_blanks = true,
                b's' => opts.stable = true,
                b'u' => opts.unique = true,
                b'c' => opts.check = true,
                b'z' => terminator = 0,
                b'd' | b'i' => {}
                b'k' => {
                    key_specs.push(p.short_value(letter, rest)?);
                    break;
                }
                b't' => {
                    let value = p.short_value(letter, rest)?;
                    opts.separator = separator(&p, value)?;
                    break;
                }
                b'o' => {
                    output = Some(p.short_value(letter, rest)?);
                    break;
                }
                b'g' | b'h' | b'M' | b'V' | b'R' | b'm' | b'S' | b'T' => {
                    return Err(p.unsupported(&arg[j - 1..j]));
                }
                _ => return Err(p.illegal(&arg[j - 1..j])),
            }
        }
    }

    for spec in key_specs {
        let key = Key::parse(spec, opts.global)
            .map_err(|m| p.error(format_args!("{}", bstr::BStr::new(&m))))?;
        opts.keys.push(key);
    }

    let inputs: Vec<Input> = p.operands().map(|i| p.input(i)).collect();
    if opts.check && inputs.len() > 1 {
        return Err(p.error(format_args!(
            "extra operand '{}' not allowed with -c",
            bstr::BStr::new(p.arg(p.i + 1))
        )));
    }
    let inputs = if inputs.is_empty() {
        vec![Input::Stdin]
    } else {
        inputs
    };
    Ok(Opts {
        program: Program::Sort(opts),
        terminator,
        inputs,
        output: output.map(nul_terminated),
    })
}

fn parse_uniq_opts(interp: &Interpreter, cmd: NodeId) -> Result<Opts, Vec<u8>> {
    let mut p = ArgParser::new(interp, cmd, Kind::Uniq);
    let mut opts = UniqOpts::default();
    let mut terminator = b'\n';

    let number = |p: &ArgParser, what: &str, value: &[u8]| -> Result<usize, Vec<u8>> {
        parse_whole_number(value).ok_or_else(|| {
            p.error(format_args!(
                "invalid number of {what}: '{}'",
                bstr::BStr::new(value)
            ))
        })
    };

    while let Some(arg) = p.next_option() {
        if arg[1] == b'-' {
            let (name, inline) = split_long(arg);
            match name {
                b"--count" => opts.count = true,
                b"--repeated" => opts.unique = false,
                b"--all-repeated" => {
                    opts.unique = false;
                    opts.later_repeated = true;
                }
                b"--unique" => opts.first_repeated = false,
                b"--ignore-case" => opts.ignore_case = true,
                b"--zero-terminated" => terminator = 0,
                b"--skip-fields" => {
                    let value = p.long_value(name, inline)?;
                    opts.skip_fields = number(&p, "fields to skip", value)?;
                }
                b"--skip-chars" => {
                    let value = p.long_value(name, inline)?;
                    opts.skip_chars = number(&p, "bytes to skip", value)?;
                }
                b"--check-chars" => {
                    let value = p.long_value(name, inline)?;
                    opts.check_chars = Some(number(&p, "bytes to compare", value)?);
                }
                b"--group" => return Err(p.unsupported(name)),
                _ => return Err(p.illegal(b"-")),
            }
            continue;
        }

        // `-N` is the historical spelling of `-f N`.
        if arg[1].is_ascii_digit() {
            opts.skip_fields = number(&p, "fields to skip", &arg[1..])?;
            continue;
        }

        let mut j = 1usize;
        while j < arg.len() {
            let letter = arg[j];
            j += 1;
            let rest = &arg[j..];
            match letter {
                b'c' => opts.count = true,
                b'd' => opts.unique = false,
                b'D' => {
                    opts.unique = false;
                    opts.later_repeated = true;
                }
                b'u' => opts.first_repeated = false,
                b'i' => opts.ignore_case = true,
                b'z' => terminator = 0,
                b'f' => {
                    let value = p.short_value(letter, rest)?;
                    opts.skip_fields = number(&p, "fields to skip", value)?;
                    break;
                }
                b's' => {
                    let value = p.short_value(letter, rest)?;
                    opts.skip_chars = number(&p, "bytes to skip", value)?;
                    break;
                }
                b'w' => {
                    let value = p.short_value(letter, rest)?;
                    opts.check_chars = Some(number(&p, "bytes to compare", value)?);
                    break;
                }
                _ => return Err(p.illegal(&arg[j - 1..j])),
            }
        }
    }

    if opts.count && opts.later_repeated {
        return Err(p.error(format_args!(
            "printing all duplicated lines and repeat counts is meaningless"
        )));
    }

    let mut operands = p.operands();
    let inputs = vec![operands.next().map_or(Input::Stdin, |i| p.input(i))];
    let output = operands.next().map(|i| nul_terminated(p.arg(i)));
    if let Some(extra) = operands.next() {
        return Err(p.error(format_args!(
            "extra operand '{}'",
            bstr::BStr::new(p.arg(extra))
        )));
    }
    Ok(Opts {
        program: Program::Uniq(opts),
        terminator,
        inputs,
        output,
    })
}

// ──────────────────────────────────────────────────────────────────────────
// the two builtins
// ──────────────────────────────────────────────────────────────────────────

pub struct Sort {
    common: Common,
}

impl Default for Sort {
    fn default() -> Self {
        Self {
            common: Common::new(
                Kind::Sort,
                ReaderTag::Sort,
                2,
                Program::Sort(SortOpts::default()),
            ),
        }
    }
}

impl Sort {
    pub(crate) fn start(interp: &Interpreter, cmd: NodeId) -> Yield {
        let opts = parse_sort_opts(interp, cmd);
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

pub struct Uniq {
    common: Common,
}

impl Default for Uniq {
    fn default() -> Self {
        Self {
            common: Common::new(
                Kind::Uniq,
                ReaderTag::Uniq,
                1,
                Program::Uniq(UniqOpts::default()),
            ),
        }
    }
}

impl Uniq {
    pub(crate) fn start(interp: &Interpreter, cmd: NodeId) -> Yield {
        let opts = parse_uniq_opts(interp, cmd);
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
            Impl::Sort(s) => &mut s.common,
            Impl::Uniq(u) => &mut u.common,
            _ => unreachable!("not sort or uniq"),
        }
    }
}
