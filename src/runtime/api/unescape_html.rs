//! `Bun.unescapeHTML()`: replaces the character references of a text with the
//! characters they stand for, as the HTML tokenizer does.
//!
//! https://html.spec.whatwg.org/multipage/parsing.html#character-reference-state

use bun_core::strings;
use bun_jsc::bun_string_jsc::{owned_latin1_into_js, owned_utf16_into_js};
use bun_jsc::{CallFrame, JSGlobalObject, JSValue, JsResult, StringJsc as _};

#[bun_jsc::host_fn]
pub(crate) fn unescape_html(global: &JSGlobalObject, frame: &CallFrame) -> JsResult<JSValue> {
    let argument = frame.argument(0);
    let input = argument.to_bun_string(global)?;

    let options = frame.argument(1);
    let mut context = Context::Text;
    if !options.is_undefined_or_null() {
        if !options.is_object() {
            return Err(global.throw_invalid_argument_type_value("options", "object", options));
        }
        if options.get_boolean_loose(global, "attribute")? == Some(true) {
            context = Context::Attribute;
        }
    }

    let decoded = if input.is_8bit() {
        decode(input.latin1(), context)
    } else {
        decode(input.utf16(), context)
    };
    match decoded {
        // Nothing to replace: the string is returned as it is.
        None if argument.is_string() => Ok(argument),
        None => input.into_js(global),
        Some(Decoded::Latin1(bytes)) => owned_latin1_into_js(global, bytes),
        Some(Decoded::Utf16(units)) => owned_utf16_into_js(global, units),
    }
}

/// Where the text is from.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Context {
    /// Between tags.
    Text,
    /// The value of an attribute, where `&copy=1` of `?a=b&copy=1` is not a reference.
    Attribute,
}

/// The text with its references replaced. Latin-1 for as long as the input
/// and every character a reference stands for are.
enum Decoded {
    Latin1(Vec<u8>),
    Utf16(Vec<u16>),
}

impl Decoded {
    fn push(&mut self, code_point: u32) {
        if let Decoded::Latin1(bytes) = self {
            if let Ok(byte) = u8::try_from(code_point) {
                bytes.push(byte);
                return;
            }
            let mut units = Vec::with_capacity(bytes.capacity());
            units.extend(bytes.iter().map(|&byte| u16::from(byte)));
            *self = Decoded::Utf16(units);
        }
        let Decoded::Utf16(units) = self else {
            unreachable!()
        };
        match u16::try_from(code_point) {
            Ok(unit) => units.push(unit),
            Err(_) => {
                let offset = code_point - 0x1_0000;
                units.push(0xD800 | (offset >> 10) as u16);
                units.push(0xDC00 | (offset & 0x3FF) as u16);
            }
        }
    }
}

/// A code unit of a JavaScript string: Latin-1 or UTF-16.
trait CodeUnit: Copy + Into<u32> {
    fn index_of_ampersand(units: &[Self]) -> Option<usize>;
    fn output(capacity: usize) -> Decoded;
    fn append(out: &mut Decoded, units: &[Self]);
}

impl CodeUnit for u8 {
    fn index_of_ampersand(units: &[u8]) -> Option<usize> {
        strings::index_of_char_usize(units, b'&')
    }

    fn output(capacity: usize) -> Decoded {
        Decoded::Latin1(Vec::with_capacity(capacity))
    }

    fn append(out: &mut Decoded, units: &[u8]) {
        match out {
            Decoded::Latin1(bytes) => bytes.extend_from_slice(units),
            Decoded::Utf16(wide) => wide.extend(units.iter().map(|&byte| u16::from(byte))),
        }
    }
}

impl CodeUnit for u16 {
    fn index_of_ampersand(units: &[u16]) -> Option<usize> {
        strings::index_of_any16(units, &[u16::from(b'&')])
    }

    fn output(capacity: usize) -> Decoded {
        Decoded::Utf16(Vec::with_capacity(capacity))
    }

    fn append(out: &mut Decoded, units: &[u16]) {
        match out {
            Decoded::Utf16(wide) => wide.extend_from_slice(units),
            Decoded::Latin1(_) => unreachable!("UTF-16 input has UTF-16 output"),
        }
    }
}

/// `None` when `input` has no character reference, which is the common case
/// and allocates nothing.
fn decode<T: CodeUnit>(input: &[T], context: Context) -> Option<Decoded> {
    let mut out: Option<Decoded> = None;
    // Where the text that `out` does not have yet starts.
    let mut pending = 0;
    let mut cursor = 0;
    while let Some(found) = T::index_of_ampersand(&input[cursor..]) {
        let ampersand = cursor + found;
        cursor = ampersand + 1;
        let Some((len, code_points)) = reference(&input[cursor..], context) else {
            continue;
        };
        // No reference is shorter than what it stands for, so this never grows.
        let out = out.get_or_insert_with(|| T::output(input.len()));
        T::append(out, &input[pending..ampersand]);
        out.push(code_points[0]);
        if code_points[1] != 0 {
            out.push(code_points[1]);
        }
        cursor += len;
        pending = cursor;
    }
    let mut out = out?;
    T::append(&mut out, &input[pending..]);
    Some(out)
}

fn unit_at<T: CodeUnit>(units: &[T], index: usize) -> Option<u32> {
    units.get(index).map(|&unit| unit.into())
}

/// The character reference that starts after a `&`: how many units it takes
/// and the one or two code points it stands for.
fn reference<T: CodeUnit>(after: &[T], context: Context) -> Option<(usize, [u32; 2])> {
    if unit_at(after, 0) == Some(u32::from(b'#')) {
        let (len, code_point) = numeric(&after[1..])?;
        return Some((len + 1, [code_point, 0]));
    }
    named(after, context)
}

/// `&#38;` or `&#x26;`, after the `#`. The `;` can be left out.
fn numeric<T: CodeUnit>(after: &[T]) -> Option<(usize, u32)> {
    let (radix, start) = match unit_at(after, 0).and_then(char::from_u32) {
        Some('x' | 'X') => (16, 1),
        _ => (10, 0),
    };
    let mut value: u32 = 0;
    let mut end = start;
    while let Some(digit) = unit_at(after, end)
        .and_then(char::from_u32)
        .and_then(|unit| unit.to_digit(radix))
    {
        // Past the last code point the number only has to stay out of range.
        if value <= 0x10_FFFF {
            value = value * radix + digit;
        }
        end += 1;
    }
    if end == start {
        return None;
    }
    if unit_at(after, end) == Some(u32::from(b';')) {
        end += 1;
    }
    Some((end, numeric_code_point(value)))
}

/// https://html.spec.whatwg.org/multipage/parsing.html#numeric-character-reference-end-state
fn numeric_code_point(value: u32) -> u32 {
    match value {
        0 | 0xD800..=0xDFFF | 0x11_0000.. => 0xFFFD,
        // C1 controls are read as Windows-1252, which is what the pages that have them meant.
        0x80..=0x9F => u32::from(WINDOWS_1252[(value - 0x80) as usize]),
        _ => value,
    }
}

#[rustfmt::skip]
const WINDOWS_1252: [u16; 32] = [
    0x20AC, 0x0081, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021,
    0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008D, 0x017D, 0x008F,
    0x0090, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014,
    0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x009D, 0x017E, 0x0178,
];

/// `CounterClockwiseContourIntegral`
const LONGEST_NAME: usize = 31;

/// `&amp;`, after the `&`. The longest name that matches wins, and the names
/// of [`LEGACY_NAMES`] match without their `;` too: `&notin;` is `∉`,
/// `&notit;` is `¬it;`. In an attribute such a name is only a reference when
/// neither `=` nor a letter or digit follows it.
fn named<T: CodeUnit>(after: &[T], context: Context) -> Option<(usize, [u32; 2])> {
    // `&`, the name, `;`: what `bun_md::entity::lookup` takes.
    let mut name = [0u8; LONGEST_NAME + 2];
    name[0] = b'&';
    let mut len = 0;
    while len < LONGEST_NAME
        && let Some(unit) = unit_at(after, len)
            .and_then(|unit| u8::try_from(unit).ok())
            .filter(u8::is_ascii_alphanumeric)
    {
        name[1 + len] = unit;
        len += 1;
    }

    if unit_at(after, len) == Some(u32::from(b';')) {
        name[1 + len] = b';';
        if let Some(code_points) = bun_md::entity::lookup(&name[..len + 2]) {
            return Some((len + 1, code_points));
        }
    }

    for len in (2..=len.min(LONGEST_LEGACY_NAME)).rev() {
        if LEGACY_NAMES.binary_search(&&name[1..1 + len]).is_ok() {
            if context == Context::Attribute
                && unit_at(after, len).is_some_and(|next| {
                    next == u32::from(b'=')
                        || u8::try_from(next).is_ok_and(|next| next.is_ascii_alphanumeric())
                })
            {
                return None;
            }
            name[1 + len] = b';';
            let code_points = bun_md::entity::lookup(&name[..len + 2])?;
            return Some((len, code_points));
        }
    }
    None
}

const LONGEST_LEGACY_NAME: usize = 6;

/// The names of HTML 4, which a browser also takes without the `;`. Sorted.
#[rustfmt::skip]
static LEGACY_NAMES: [&[u8]; 106] = [
    b"AElig", b"AMP", b"Aacute", b"Acirc", b"Agrave", b"Aring", b"Atilde", b"Auml", b"COPY",
    b"Ccedil", b"ETH", b"Eacute", b"Ecirc", b"Egrave", b"Euml", b"GT", b"Iacute", b"Icirc",
    b"Igrave", b"Iuml", b"LT", b"Ntilde", b"Oacute", b"Ocirc", b"Ograve", b"Oslash", b"Otilde",
    b"Ouml", b"QUOT", b"REG", b"THORN", b"Uacute", b"Ucirc", b"Ugrave", b"Uuml", b"Yacute",
    b"aacute", b"acirc", b"acute", b"aelig", b"agrave", b"amp", b"aring", b"atilde", b"auml",
    b"brvbar", b"ccedil", b"cedil", b"cent", b"copy", b"curren", b"deg", b"divide", b"eacute",
    b"ecirc", b"egrave", b"eth", b"euml", b"frac12", b"frac14", b"frac34", b"gt", b"iacute",
    b"icirc", b"iexcl", b"igrave", b"iquest", b"iuml", b"laquo", b"lt", b"macr", b"micro",
    b"middot", b"nbsp", b"not", b"ntilde", b"oacute", b"ocirc", b"ograve", b"ordf", b"ordm",
    b"oslash", b"otilde", b"ouml", b"para", b"plusmn", b"pound", b"quot", b"raquo", b"reg",
    b"sect", b"shy", b"sup1", b"sup2", b"sup3", b"szlig", b"thorn", b"times", b"uacute",
    b"ucirc", b"ugrave", b"uml", b"uuml", b"yacute", b"yen", b"yuml",
];
