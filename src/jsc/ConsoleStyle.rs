//! `console.log("%c…", css)`: browsers apply the CSS in the argument to the
//! rest of the message. A terminal can show a handful of those properties, so
//! this turns them into one SGR escape sequence and ignores everything else,
//! including values that do not parse.

use bun_core::output::ColorDepth;
use bun_core::strings;
use bun_css::values::color::RGBA;

/// What one `%c` argument asks for. Every field starts from the terminal's
/// defaults: a `%c` replaces the style of the previous one, it does not add to it.
#[derive(Default)]
struct Style {
    color: Option<RGBA>,
    background: Option<RGBA>,
    bold: bool,
    italic: bool,
    underline: bool,
    line_through: bool,
    overline: bool,
}

/// Appends the escape sequence for the declarations in `css` to `out`, for
/// example `\x1b[1;38;2;255;0;0m` for `font-weight: bold; color: red` on a
/// true-color terminal. Appends nothing when no declaration has an effect.
pub fn write_sgr(css: &[u8], depth: ColorDepth, out: &mut Vec<u8>) {
    let style = Style::parse(css);

    let start = out.len();
    out.extend_from_slice(b"\x1b[");
    let first = out.len();
    let separate = |out: &mut Vec<u8>| {
        if out.len() > first {
            out.push(b';');
        }
    };

    for (on, code) in [
        (style.bold, &b"1"[..]),
        (style.italic, b"3"),
        (style.underline, b"4"),
        (style.line_through, b"9"),
        (style.overline, b"53"),
    ] {
        if on {
            separate(out);
            out.extend_from_slice(code);
        }
    }
    if depth != ColorDepth::None {
        for (color, background) in [(style.color, false), (style.background, true)] {
            if let Some(color) = color {
                separate(out);
                depth.write_sgr_color(out, background, color.red, color.green, color.blue);
            }
        }
    }

    if out.len() == first {
        out.truncate(start);
    } else {
        out.push(b'm');
    }
}

impl Style {
    fn parse(css: &[u8]) -> Style {
        let mut style = Style::default();
        let mut rest = css;
        while let Some(declaration) = next_declaration(&mut rest) {
            let Some(colon) = strings::index_of_char_usize(declaration, b':') else {
                continue;
            };
            let property = trim(&declaration[..colon]);
            let value = without_important(trim(&declaration[colon + 1..]));
            if value.is_empty() {
                continue;
            }
            let is = |name: &[u8]| strings::eql_case_insensitive_ascii_check_length(property, name);

            if is(b"color") {
                if let Some(color) = parse_color(value) {
                    style.color = color;
                }
            } else if is(b"background-color") || is(b"background") {
                if let Some(color) = parse_color(value) {
                    style.background = color;
                }
            } else if is(b"font-weight") {
                if let Some(bold) = parse_font_weight(value) {
                    style.bold = bold;
                }
            } else if is(b"font-style") {
                if value.eq_ignore_ascii_case(b"italic")
                    || strings::starts_with_case_insensitive_ascii(value, b"oblique")
                {
                    style.italic = true;
                } else if value.eq_ignore_ascii_case(b"normal") {
                    style.italic = false;
                }
            } else if is(b"text-decoration") || is(b"text-decoration-line") {
                style.underline = false;
                style.line_through = false;
                style.overline = false;
                for word in strings::tokenize_any(value, WHITESPACE) {
                    if word.eq_ignore_ascii_case(b"underline") {
                        style.underline = true;
                    } else if word.eq_ignore_ascii_case(b"line-through") {
                        style.line_through = true;
                    } else if word.eq_ignore_ascii_case(b"overline") {
                        style.overline = true;
                    }
                }
            }
        }
        style
    }
}

/// Splits off the next `;`-separated declaration, skipping semicolons inside
/// parentheses.
fn next_declaration<'a>(rest: &mut &'a [u8]) -> Option<&'a [u8]> {
    if rest.is_empty() {
        return None;
    }
    let mut depth: u32 = 0;
    let mut end = rest.len();
    for (i, &byte) in rest.iter().enumerate() {
        match byte {
            b'(' => depth += 1,
            b')' => depth = depth.saturating_sub(1),
            b';' if depth == 0 => {
                end = i;
                break;
            }
            _ => {}
        }
    }
    let declaration = &rest[..end];
    *rest = rest.get(end + 1..).unwrap_or(b"");
    Some(declaration)
}

const WHITESPACE: &[u8] = b" \t\n\r\x0c";

fn trim(s: &[u8]) -> &[u8] {
    strings::trim(s, WHITESPACE)
}

/// Nothing competes with a `%c` declaration, so `!important` only needs removing.
fn without_important(value: &[u8]) -> &[u8] {
    const IMPORTANT: &[u8] = b"!important";
    if value.len() >= IMPORTANT.len() {
        let (head, tail) = value.split_at(value.len() - IMPORTANT.len());
        if tail.eq_ignore_ascii_case(IMPORTANT) {
            return trim(head);
        }
    }
    value
}

/// `Some(None)` selects the terminal's default color. `None` is a value to skip.
fn parse_color(value: &[u8]) -> Option<Option<RGBA>> {
    for keyword in [&b"inherit"[..], b"initial", b"unset", b"revert"] {
        if value.eq_ignore_ascii_case(keyword) {
            return Some(None);
        }
    }

    let arena = bun_alloc::Arena::new();
    let mut input = bun_css::ParserInput::new(value, &arena);
    let mut parser = bun_css::Parser::new(
        &mut input,
        None,
        bun_css::css_parser::ParserOpts::default(),
        None,
    );
    let color = bun_css::CssColor::parse(&mut parser).ok()?;
    if !parser.is_exhausted() {
        return None;
    }
    if matches!(color, bun_css::CssColor::CurrentColor) {
        return Some(None);
    }
    let rgba = RGBA::try_from_css_color(&color)?;
    // `transparent`: let the terminal's own color through.
    Some((rgba.alpha != 0).then_some(rgba))
}

fn parse_font_weight(value: &[u8]) -> Option<bool> {
    if value.eq_ignore_ascii_case(b"bold") || value.eq_ignore_ascii_case(b"bolder") {
        return Some(true);
    }
    if value.eq_ignore_ascii_case(b"normal") || value.eq_ignore_ascii_case(b"lighter") {
        return Some(false);
    }
    // Terminals have one bold; 600 (semibold) and up counts as it.
    let weight: f64 = core::str::from_utf8(value).ok()?.parse().ok()?;
    (1.0..=1000.0).contains(&weight).then_some(weight >= 600.0)
}
