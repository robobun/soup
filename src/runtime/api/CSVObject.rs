//! `Bun.CSV` — `parse()` and `stringify()` host functions.
//!
//! The format is RFC 4180 plus what every reader in practice accepts: a
//! record ends at `\n`, `\r\n` or a lone `\r`, a quoted field may span lines
//! and doubles its quote character to escape it, the delimiter and the quote
//! character are configurable, and a leading UTF-8 byte order mark is
//! skipped. Fields are strings; nothing is converted.

use bun_core::String as BunString;
use bun_core::strings;
use bun_jsc::bun_string_jsc::create_utf8_for_js;
use bun_jsc::{self as jsc, CallFrame, JSGlobalObject, JSValue, JsError, JsResult, wtf};

pub(crate) fn create(global: &JSGlobalObject) -> JSValue {
    bun_jsc::create_host_function_object(
        global,
        &[
            ("parse", __jsc_host_parse, 2),
            ("stringify", __jsc_host_stringify, 2),
        ],
    )
}

// ── options ─────────────────────────────────────────────────────────────────

const DEFAULT_DELIMITER: u16 = b',' as u16;
const DEFAULT_QUOTE: u16 = b'"' as u16;

/// `delimiter` / `quote`: a string of exactly one UTF-16 code unit, returned
/// as that code unit. `undefined` and `null` select the default.
fn read_char_option(
    global: &JSGlobalObject,
    options: JSValue,
    name: &'static str,
    default: u16,
) -> JsResult<u16> {
    let Some(value) = options.get(global, name)? else {
        return Ok(default);
    };
    if value.is_null() {
        return Ok(default);
    }
    let invalid = || {
        global.throw_invalid_arguments(format_args!(
            "CSV: `{name}` must be a string of exactly one character"
        ))
    };
    if !value.is_string() {
        return Err(invalid());
    }
    let string = value.to_bun_string(global)?;
    if string.length() != 1 {
        return Err(invalid());
    }
    let c = string.char_at(0);
    if c == b'\n' as u16 || c == b'\r' as u16 {
        return Err(
            global.throw_invalid_arguments(format_args!("CSV: `{name}` cannot be a line break"))
        );
    }
    Ok(c)
}

fn check_distinct(global: &JSGlobalObject, delimiter: u16, quote: u16) -> JsResult<()> {
    if delimiter == quote {
        return Err(global.throw_invalid_arguments(format_args!(
            "CSV: `delimiter` and `quote` must be different characters"
        )));
    }
    Ok(())
}

/// `columns` (stringify) / `header` (parse) given as an array: every element
/// must be a string.
fn read_string_array(
    global: &JSGlobalObject,
    array: JSValue,
    name: &'static str,
) -> JsResult<Vec<BunString>> {
    let mut iter = array.array_iterator(global)?;
    let mut out = Vec::with_capacity(iter.len as usize);
    while let Some(item) = iter.next()? {
        if !item.is_string() {
            return Err(global.throw_invalid_arguments(format_args!(
                "CSV: `{name}` must be an array of strings"
            )));
        }
        out.push(item.to_bun_string(global)?);
    }
    Ok(out)
}

/// One code unit as the UTF-8 bytes the parser scans for. A lone surrogate
/// becomes U+FFFD, which then never matches anything in valid UTF-8 input.
#[derive(Clone, Copy)]
struct Utf8Char {
    bytes: [u8; 4],
    len: u8,
}

impl Utf8Char {
    fn from_code_unit(unit: u16) -> Self {
        let c = char::from_u32(u32::from(unit)).unwrap_or(char::REPLACEMENT_CHARACTER);
        let mut bytes = [0u8; 4];
        let len = c.encode_utf8(&mut bytes).len();
        Self {
            bytes,
            len: len as u8,
        }
    }

    fn as_bytes(&self) -> &[u8] {
        &self.bytes[..usize::from(self.len)]
    }

    fn first(self) -> u8 {
        self.bytes[0]
    }
}

enum Header {
    /// The first record names the columns.
    FirstRow,
    /// Records are arrays.
    None,
    /// The caller names the columns; every record is data.
    Names(Vec<BunString>),
}

struct ParseOptions {
    header: Header,
    delimiter: Utf8Char,
    quote: Utf8Char,
    trim: bool,
    skip_empty_lines: bool,
}

impl ParseOptions {
    fn from_js(global: &JSGlobalObject, options: JSValue) -> JsResult<Self> {
        let mut out = Self {
            header: Header::FirstRow,
            delimiter: Utf8Char::from_code_unit(DEFAULT_DELIMITER),
            quote: Utf8Char::from_code_unit(DEFAULT_QUOTE),
            trim: false,
            skip_empty_lines: true,
        };
        if options.is_undefined_or_null() {
            return Ok(out);
        }
        if !options.is_object() {
            return Err(global
                .throw_invalid_arguments(format_args!("CSV.parse: expected an options object")));
        }

        if let Some(header) = options.get(global, "header")? {
            if header.is_array() {
                out.header = Header::Names(read_string_array(global, header, "header")?);
            } else if header.is_boolean() {
                out.header = if header.as_boolean() {
                    Header::FirstRow
                } else {
                    Header::None
                };
            } else if !header.is_null() {
                return Err(global.throw_invalid_arguments(format_args!(
                    "CSV.parse: `header` must be a boolean or an array of strings"
                )));
            }
        }

        let delimiter = read_char_option(global, options, "delimiter", DEFAULT_DELIMITER)?;
        let quote = read_char_option(global, options, "quote", DEFAULT_QUOTE)?;
        check_distinct(global, delimiter, quote)?;
        out.delimiter = Utf8Char::from_code_unit(delimiter);
        out.quote = Utf8Char::from_code_unit(quote);

        if let Some(trim) = options.get_boolean_loose(global, "trim")? {
            out.trim = trim;
        }
        if let Some(skip) = options.get_boolean_loose(global, "skipEmptyLines")? {
            out.skip_empty_lines = skip;
        }
        Ok(out)
    }
}

// ── parse ───────────────────────────────────────────────────────────────────

#[bun_jsc::host_fn]
pub(crate) fn parse(global: &JSGlobalObject, frame: &CallFrame) -> JsResult<JSValue> {
    super::with_text_format_source(
        global,
        frame,
        b"input.csv",
        super::BlobOrBufferInput::Bytes,
        super::NullishInput::Throw,
        |_arena, _log, source| {
            let options = ParseOptions::from_js(global, frame.argument(1))?;
            let contents = source.contents();
            let input = contents.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(contents);

            let mut parser = Parser::new(input, &options);
            let result = JSValue::create_empty_array(global, 0)?;

            let ParseOptions {
                header,
                skip_empty_lines,
                ..
            } = options;
            let mut header_pending = matches!(header, Header::FirstRow);
            let mut columns = match header {
                Header::Names(names) => Some(names),
                Header::FirstRow | Header::None => None,
            };

            while parser.next_record(global, skip_empty_lines)? {
                if header_pending {
                    header_pending = false;
                    // Atoms make the per-row property puts below a table hit
                    // instead of a hash of the name each time.
                    columns = Some(
                        parser
                            .cells
                            .iter()
                            .map(|&cell| BunString::create_atom_if_possible(parser.bytes(cell)))
                            .collect(),
                    );
                    continue;
                }

                match &columns {
                    None => {
                        let row = JSValue::create_empty_array(global, parser.cells.len())?;
                        result.push(global, row)?;
                        for (i, &cell) in parser.cells.iter().enumerate() {
                            row.put_index(global, i as u32, parser.to_js(global, cell)?)?;
                        }
                    }
                    Some(columns) => {
                        // A short record leaves its missing columns empty; fields
                        // past the last column have no name and are dropped.
                        let row = JSValue::create_empty_object(global, columns.len());
                        result.push(global, row)?;
                        for (i, name) in columns.iter().enumerate() {
                            let value = match parser.cells.get(i) {
                                Some(&cell) => parser.to_js(global, cell)?,
                                None => JSValue::js_empty_string(global),
                            };
                            row.put_may_be_index(global, name, value)?;
                        }
                    }
                }
            }

            Ok(result)
        },
    )
}

/// Where a field's bytes are: in the input, or in `Parser::scratch` once a
/// quoted field had `""` escapes folded.
#[derive(Clone, Copy)]
enum Cell {
    Input { start: usize, end: usize },
    Scratch { start: usize, end: usize },
}

enum Terminator {
    Delimiter,
    LineBreak,
    Eof,
}

struct Parser<'a> {
    input: &'a [u8],
    pos: usize,
    delimiter: Utf8Char,
    quote: Utf8Char,
    trim: bool,
    /// The bytes an unquoted field stops at: the delimiter's first byte,
    /// `\r` and `\n`.
    unquoted_stops: [u8; 3],
    scratch: Vec<u8>,
    /// The fields of the record `next_record` parsed last.
    cells: Vec<Cell>,
}

impl<'a> Parser<'a> {
    fn new(input: &'a [u8], options: &ParseOptions) -> Self {
        Self {
            input,
            pos: 0,
            delimiter: options.delimiter,
            quote: options.quote,
            trim: options.trim,
            unquoted_stops: [options.delimiter.first(), b'\r', b'\n'],
            scratch: Vec::new(),
            cells: Vec::new(),
        }
    }

    fn bytes(&self, cell: Cell) -> &[u8] {
        match cell {
            Cell::Input { start, end } => &self.input[start..end],
            Cell::Scratch { start, end } => &self.scratch[start..end],
        }
    }

    fn to_js(&self, global: &JSGlobalObject, cell: Cell) -> JsResult<JSValue> {
        create_utf8_for_js(global, self.bytes(cell))
    }

    /// `trim` strips spaces and tabs, unless one of them is the delimiter.
    fn is_blank(&self, byte: u8) -> bool {
        (byte == b' ' || byte == b'\t') && byte != self.delimiter.first()
    }

    fn skip_blanks(&mut self) {
        while self.pos < self.input.len() && self.is_blank(self.input[self.pos]) {
            self.pos += 1;
        }
    }

    /// Consumes the line break at `pos` (`\n`, `\r\n` or `\r`), if there is one.
    fn eat_line_break(&mut self) -> bool {
        match self.input.get(self.pos) {
            Some(b'\n') => {
                self.pos += 1;
                true
            }
            Some(b'\r') => {
                self.pos += 1;
                if self.input.get(self.pos) == Some(&b'\n') {
                    self.pos += 1;
                }
                true
            }
            _ => false,
        }
    }

    /// Parses the next record into `cells`. `false` at the end of the input.
    fn next_record(&mut self, global: &JSGlobalObject, skip_empty_lines: bool) -> JsResult<bool> {
        self.scratch.clear();
        self.cells.clear();

        loop {
            if self.pos >= self.input.len() {
                return Ok(false);
            }
            if !skip_empty_lines {
                break;
            }
            let line_start = self.pos;
            if self.trim {
                self.skip_blanks();
            }
            if self.pos >= self.input.len() {
                return Ok(false);
            }
            if self.eat_line_break() {
                continue;
            }
            self.pos = line_start;
            break;
        }

        loop {
            let (cell, terminator) = self.next_field(global)?;
            self.cells.push(cell);
            match terminator {
                Terminator::Delimiter => {}
                Terminator::LineBreak | Terminator::Eof => return Ok(true),
            }
        }
    }

    fn next_field(&mut self, global: &JSGlobalObject) -> JsResult<(Cell, Terminator)> {
        if self.trim {
            self.skip_blanks();
        }
        if self.input[self.pos..].starts_with(self.quote.as_bytes()) {
            return self.quoted_field(global);
        }

        let start = self.pos;
        let mut scan = self.pos;
        loop {
            let Some(i) = strings::index_of_any_pos(self.input, &self.unquoted_stops, scan) else {
                self.pos = self.input.len();
                return Ok((self.unquoted(start, self.input.len()), Terminator::Eof));
            };
            if self.input[i] == self.delimiter.first() {
                if self.input[i..].starts_with(self.delimiter.as_bytes()) {
                    self.pos = i + self.delimiter.as_bytes().len();
                    return Ok((self.unquoted(start, i), Terminator::Delimiter));
                }
                // The first byte of a multi-byte delimiter, but not the delimiter.
                scan = i + 1;
                continue;
            }
            self.pos = i;
            self.eat_line_break();
            return Ok((self.unquoted(start, i), Terminator::LineBreak));
        }
    }

    fn unquoted(&self, start: usize, mut end: usize) -> Cell {
        if self.trim {
            while end > start && self.is_blank(self.input[end - 1]) {
                end -= 1;
            }
        }
        Cell::Input { start, end }
    }

    /// `pos` is at the opening quote.
    fn quoted_field(&mut self, global: &JSGlobalObject) -> JsResult<(Cell, Terminator)> {
        let quote = self.quote;
        let quote_len = quote.as_bytes().len();
        let field_start = self.pos;
        self.pos += quote_len;

        let scratch_start = self.scratch.len();
        let mut segment_start = self.pos;
        let mut unescaped = false;
        let cell = loop {
            let Some(i) = self.find_quote(self.pos) else {
                return Err(self.syntax_error(global, field_start, "unterminated quoted field"));
            };
            let after = i + quote_len;
            if self.input[after..].starts_with(quote.as_bytes()) {
                // `""` is one quote character: keep the first, skip the second.
                self.scratch
                    .extend_from_slice(&self.input[segment_start..after]);
                unescaped = true;
                self.pos = after + quote_len;
                segment_start = self.pos;
                continue;
            }
            self.pos = after;
            if unescaped {
                self.scratch
                    .extend_from_slice(&self.input[segment_start..i]);
                break Cell::Scratch {
                    start: scratch_start,
                    end: self.scratch.len(),
                };
            }
            break Cell::Input {
                start: segment_start,
                end: i,
            };
        };

        // Only a delimiter, a line break or the end of the input may follow
        // the closing quote.
        if self.trim {
            self.skip_blanks();
        }
        if self.pos >= self.input.len() {
            return Ok((cell, Terminator::Eof));
        }
        if self.input[self.pos..].starts_with(self.delimiter.as_bytes()) {
            self.pos += self.delimiter.as_bytes().len();
            return Ok((cell, Terminator::Delimiter));
        }
        if self.eat_line_break() {
            return Ok((cell, Terminator::LineBreak));
        }
        Err(self.syntax_error(
            global,
            self.pos,
            "unexpected character after a closing quote",
        ))
    }

    fn find_quote(&self, from: usize) -> Option<usize> {
        let quote = self.quote.as_bytes();
        let haystack = &self.input[from..];
        let i = if quote.len() == 1 {
            strings::index_of_char_usize(haystack, quote[0])
        } else {
            strings::index_of(haystack, quote)
        }?;
        Some(from + i)
    }

    fn syntax_error(&self, global: &JSGlobalObject, at: usize, what: &str) -> JsError {
        let line = strings::count_char(&self.input[..at], b'\n') + 1;
        global.throw_value(
            global.create_syntax_error_instance(format_args!(
                "CSV Parse error: {what} at line {line}"
            )),
        )
    }
}

// ── stringify ───────────────────────────────────────────────────────────────

struct StringifyOptions {
    header: bool,
    columns: Option<Vec<BunString>>,
    delimiter: u16,
    quote: u16,
}

impl StringifyOptions {
    fn from_js(global: &JSGlobalObject, options: JSValue) -> JsResult<Self> {
        let mut out = Self {
            header: true,
            columns: None,
            delimiter: DEFAULT_DELIMITER,
            quote: DEFAULT_QUOTE,
        };
        if options.is_undefined_or_null() {
            return Ok(out);
        }
        if !options.is_object() {
            return Err(global.throw_invalid_arguments(format_args!(
                "CSV.stringify: expected an options object"
            )));
        }
        if let Some(header) = options.get_boolean_loose(global, "header")? {
            out.header = header;
        }
        if let Some(columns) = options.get(global, "columns")? {
            if columns.is_array() {
                out.columns = Some(read_string_array(global, columns, "columns")?);
            } else if !columns.is_null() {
                return Err(global.throw_invalid_arguments(format_args!(
                    "CSV: `columns` must be an array of strings"
                )));
            }
        }
        out.delimiter = read_char_option(global, options, "delimiter", DEFAULT_DELIMITER)?;
        out.quote = read_char_option(global, options, "quote", DEFAULT_QUOTE)?;
        check_distinct(global, out.delimiter, out.quote)?;
        Ok(out)
    }
}

enum Rows {
    Arrays,
    Objects,
}

#[bun_jsc::host_fn]
fn stringify(global: &JSGlobalObject, frame: &CallFrame) -> JsResult<JSValue> {
    let [rows, options] = frame.arguments_as_array::<2>();
    if !rows.is_array() {
        return Err(global.throw_invalid_arguments(format_args!(
            "CSV.stringify expects an array of rows, each an array or an object"
        )));
    }
    let options = StringifyOptions::from_js(global, options)?;

    let mut writer = Writer {
        builder: wtf::StringBuilder::init(),
        delimiter: options.delimiter,
        quote: options.quote,
    };
    let mut columns = options.columns;
    let mut shape: Option<Rows> = None;

    let mut iter = rows.array_iterator(global)?;
    let mut index: usize = 0;
    while let Some(row) = iter.next()? {
        let is_object = row.is_object() && !row.is_callable();
        if shape.is_none() {
            let first = if row.is_array() {
                Rows::Arrays
            } else if is_object {
                if columns.is_none() {
                    columns = Some(own_keys(global, row)?);
                }
                Rows::Objects
            } else {
                return Err(bad_row(global, index, "an array or an object"));
            };
            if options.header {
                if let Some(columns) = &columns {
                    writer.append_header(columns);
                }
            }
            shape = Some(first);
        }

        match shape.as_ref().expect("set above") {
            Rows::Arrays => {
                if !row.is_array() {
                    return Err(bad_row(global, index, "an array like the first row"));
                }
                let mut cells = row.array_iterator(global)?;
                let mut i = 0;
                while let Some(cell) = cells.next()? {
                    if i > 0 {
                        writer.append_delimiter();
                    }
                    writer.append_value(global, cell)?;
                    i += 1;
                }
            }
            Rows::Objects => {
                if !is_object {
                    return Err(bad_row(global, index, "an object like the first row"));
                }
                for (i, name) in columns
                    .as_deref()
                    .expect("set with the shape")
                    .iter()
                    .enumerate()
                {
                    if i > 0 {
                        writer.append_delimiter();
                    }
                    let value = row.get_own(global, name)?.unwrap_or(JSValue::UNDEFINED);
                    writer.append_value(global, value)?;
                }
            }
        }
        writer.builder.append_lchar(b'\n');
        index += 1;
    }

    // No rows: the header still names the columns when the caller gave them.
    if shape.is_none() && options.header {
        if let Some(columns) = &columns {
            writer.append_header(columns);
        }
    }

    writer.builder.to_string(global)
}

fn bad_row(global: &JSGlobalObject, index: usize, expected: &str) -> JsError {
    global.throw_invalid_arguments(format_args!("CSV.stringify: row {index} is not {expected}"))
}

/// The own enumerable string keys of the first object row, in `Object.keys` order.
fn own_keys(global: &JSGlobalObject, row: JSValue) -> JsResult<Vec<BunString>> {
    let iter = jsc::JSPropertyIterator::init(
        global,
        row.to_object(global)?,
        jsc::JSPropertyIteratorOptions {
            skip_empty_name: false,
            include_value: false,
            ..Default::default()
        },
    )?;
    let mut keys = Vec::with_capacity(iter.len);
    while let Some((name, _)) = iter.next()? {
        keys.push(BunString::create_atom_if_possible(&name.to_utf8()));
    }
    Ok(keys)
}

struct Writer {
    builder: wtf::StringBuilder,
    delimiter: u16,
    quote: u16,
}

impl Writer {
    fn append_char(&mut self, c: u16) {
        if let Ok(byte) = u8::try_from(c) {
            self.builder.append_lchar(byte);
        } else {
            self.builder.append_uchar(c);
        }
    }

    fn append_delimiter(&mut self) {
        self.append_char(self.delimiter);
    }

    fn append_header(&mut self, columns: &[BunString]) {
        for (i, name) in columns.iter().enumerate() {
            if i > 0 {
                self.append_delimiter();
            }
            self.append_field(name);
        }
        self.builder.append_lchar(b'\n');
    }

    /// One cell. `null` and `undefined` are empty fields, a `Date` is its ISO
    /// string, a nested object or array is its JSON, and functions and symbols
    /// are empty like in `JSON.stringify`. Everything else is its string form.
    fn append_value(&mut self, global: &JSGlobalObject, value: JSValue) -> JsResult<()> {
        let value = value.unwrap_boxed_primitive(global)?;
        if value.is_undefined_or_null() || value.is_symbol() || value.is_callable() {
            return Ok(());
        }
        if value.is_date() {
            let mut buf = [0u8; 64];
            let Some(iso) = value.to_iso_string(global, &mut buf) else {
                return Err(global.throw(format_args!(
                    "CSV.stringify cannot serialize an invalid Date"
                )));
            };
            let iso = BunString::from_bytes(iso);
            self.append_field(&iso);
            return Ok(());
        }
        let string = if value.is_object() {
            value.json_stringify_fast(global)?
        } else {
            value.to_bun_string(global)?
        };
        self.append_field(&string);
        Ok(())
    }

    /// Quotes a field that contains the delimiter, the quote character or a
    /// line break, or that starts or ends with a space or a tab (so that a
    /// reader with `trim` gives it back unchanged). Anything else is written
    /// as is.
    fn append_field(&mut self, field: &BunString) {
        debug_assert!(!field.is_utf8());
        if !self.needs_quotes(field) {
            self.builder.append_string(field);
            return;
        }
        let quote = self.quote;
        self.append_char(quote);
        if field.is_utf16() {
            for &c in field.utf16() {
                if c == quote {
                    self.builder.append_uchar(quote);
                }
                self.builder.append_uchar(c);
            }
        } else {
            let bytes = field.latin1();
            match u8::try_from(quote) {
                Ok(quote) => {
                    let mut rest = bytes;
                    while let Some(i) = strings::index_of_char_usize(rest, quote) {
                        self.builder.append_latin1(&rest[..=i]);
                        self.builder.append_lchar(quote);
                        rest = &rest[i + 1..];
                    }
                    self.builder.append_latin1(rest);
                }
                // A Latin-1 string cannot contain a quote character above U+00FF.
                Err(_) => self.builder.append_latin1(bytes),
            }
        }
        self.append_char(quote);
    }

    fn needs_quotes(&self, field: &BunString) -> bool {
        let len = field.length();
        if len == 0 {
            return false;
        }
        let is_blank = |c: u16| c == b' ' as u16 || c == b'\t' as u16;
        if is_blank(field.char_at(0)) || is_blank(field.char_at(len - 1)) {
            return true;
        }
        if field.is_utf16() {
            let stops = [b'\r' as u16, b'\n' as u16, self.delimiter, self.quote];
            return strings::index_of_any16(field.utf16(), &stops).is_some();
        }
        let mut stops = [b'\r', b'\n', 0, 0];
        let mut count = 2;
        for c in [self.delimiter, self.quote] {
            if let Ok(byte) = u8::try_from(c) {
                stops[count] = byte;
                count += 1;
            }
        }
        strings::index_of_any(field.latin1(), &stops[..count]).is_some()
    }
}
