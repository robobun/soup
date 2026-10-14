//! `bun test --coverage-reporter=html`: renders the index and the page of each file.

use bun_core::{Global, strings};
use bun_io::Write;
use bun_sourcemap::{LineOffsetTable, LineOffsetTableColumns as _};

use super::{Fraction, Report};

const STYLE: &str = r#":root {
  color-scheme: light dark;
  --fg: #1f2328; --muted: #656d76; --bg: #fff; --border: #d0d7de; --head: #f6f8fa;
  --ok: #1a7f37; --low: #cf222e; --miss: #ffebe9; --link: #0969da;
}
@media (prefers-color-scheme: dark) {
  :root {
    --fg: #e6edf3; --muted: #8d96a0; --bg: #0d1117; --border: #30363d; --head: #161b22;
    --ok: #3fb950; --low: #f85149; --miss: #4b1d21; --link: #4493f8;
  }
}
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--fg); background: var(--bg); }
header, main, footer { max-width: 1200px; margin: 0 auto; padding: 16px 24px; }
main { padding-top: 0; }
footer, nav, .note { color: var(--muted); font-size: 12px; }
h1 { margin: 0 0 12px; font-size: 20px; overflow-wrap: anywhere; }
a { color: var(--link); text-decoration: none; }
a:hover { text-decoration: underline; }
.ok { color: var(--ok); }
.low { color: var(--low); }
.totals { display: flex; gap: 32px; margin: 0; }
.totals dt { color: var(--muted); font-size: 12px; }
.totals dd { margin: 0; font-size: 20px; font-weight: 600; }
.totals small { margin-left: 4px; color: var(--muted); font-size: 13px; font-weight: 400; }
.uncovered { margin: 12px 0 0; overflow-wrap: anywhere; }
#filter { width: 100%; max-width: 320px; margin-bottom: 12px; padding: 4px 8px; font: inherit; }
table { width: 100%; border-collapse: collapse; }
.files th, .files td { padding: 6px 12px; border-bottom: 1px solid var(--border); text-align: left; }
.files th { background: var(--head); font-weight: 600; white-space: nowrap; }
.files th button { all: unset; cursor: pointer; }
.files th button:focus-visible { outline: 2px solid var(--link); }
.files th[aria-sort="ascending"] button::after { content: " \25B2"; }
.files th[aria-sort="descending"] button::after { content: " \25BC"; }
.files .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.files td.count { color: var(--muted); }
.files .all td { font-weight: 600; }
.files td:first-child { width: 100%; overflow-wrap: anywhere; }
progress { width: 100px; height: 10px; vertical-align: middle; accent-color: var(--ok); }
progress.low { accent-color: var(--low); }
@media (max-width: 640px) {
  .files .count, .files .bar { display: none; }
}
.source { overflow-x: auto; border: 1px solid var(--border); border-radius: 6px; font: 12px/20px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.source td { padding: 0 12px; white-space: pre; tab-size: 2; vertical-align: top; }
.source .n { width: 1%; text-align: right; border-right: 3px solid transparent; user-select: none; }
.source .n a { color: var(--muted); }
.source .hit .n { border-right-color: var(--ok); }
.source .miss .n { border-right-color: var(--low); }
.source .miss .c { background: var(--miss); }
.source tr:target .c { box-shadow: inset 3px 0 var(--link); }
"#;

const INDEX_SCRIPT: &str = r#"const table = document.getElementById("files");
const body = table.tBodies[1];
const rows = [...body.rows];
const filter = document.getElementById("filter");
filter.hidden = false;
const applyFilter = () => {
  const query = filter.value.toLowerCase();
  for (const row of rows) row.hidden = !row.cells[0].textContent.toLowerCase().includes(query);
};
filter.addEventListener("input", applyFilter);
// The browser puts the text back into the box after this script has run.
addEventListener("pageshow", applyFilter);
table.tHead.addEventListener("click", event => {
  const button = event.target.closest("button[data-sort]");
  if (!button) return;
  const th = button.parentElement;
  const direction = th.getAttribute("aria-sort") === "ascending" ? -1 : 1;
  for (const cell of th.parentElement.cells) cell.removeAttribute("aria-sort");
  th.setAttribute("aria-sort", direction === 1 ? "ascending" : "descending");
  const numeric = button.dataset.sort === "n";
  const key = row => {
    const text = row.cells[th.cellIndex].textContent;
    return numeric ? parseFloat(text) : text;
  };
  rows.sort((a, b) => {
    const x = key(a);
    const y = key(b);
    return (x < y ? -1 : x > y ? 1 : 0) * direction;
  });
  body.append(...rows);
});
"#;

pub struct IndexRow<'a> {
    /// The path the text reporter prints for the file.
    pub name: &'a [u8],
    /// URL of the file's page, relative to the index.
    pub href: &'a [u8],
    pub report: &'a Report<'a>,
    pub fraction: &'a Fraction,
}

#[derive(Clone, Copy)]
pub enum Source<'a> {
    /// The file as the module loader reads it: UTF-8, without a byte order mark.
    Text(&'a [u8]),
    Unreadable,
    /// A `data:` or `blob:` URL, or a module that a plugin made up.
    NotAFile,
    /// `coverageIgnoreSourcemaps`: the lines are those of the transpiled code, which is not on disk.
    Transpiled,
    /// The file names a source map of its own, so the lines are those of the sources it was made from.
    Mapped,
}

/// Escapes `text` for HTML text and attribute values; NUL and bytes that are not UTF-8 become U+FFFD.
fn write_escaped(writer: &mut impl Write, text: &[u8]) -> bun_io::Result<()> {
    const REPLACEMENT: &[u8] = "\u{FFFD}".as_bytes();
    for chunk in text.utf8_chunks() {
        let mut rest = chunk.valid().as_bytes();
        while let Some(i) = strings::index_of_any(rest, b"&<>\"'\0") {
            writer.write_all(&rest[..i])?;
            writer.write_all(strings::html_escape_entity(rest[i]).unwrap_or(REPLACEMENT))?;
            rest = &rest[i + 1..];
        }
        writer.write_all(rest)?;
        if !chunk.invalid().is_empty() {
            writer.write_all(REPLACEMENT)?;
        }
    }
    Ok(())
}

fn write_head(writer: &mut impl Write, title: &[u8]) -> bun_io::Result<()> {
    writer.write_all(
        b"<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n\
<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>",
    )?;
    write_escaped(writer, title)?;
    writer.write_all(b"</title>\n<style>\n")?;
    writer.write_all(STYLE.as_bytes())?;
    writer.write_all(b"</style>\n</head>\n<body>\n")
}

fn write_foot(writer: &mut impl Write) -> bun_io::Result<()> {
    writeln!(
        writer,
        "<footer>Generated by <a href=\"https://bun.com/docs/test/code-coverage\">bun test</a> v{}</footer>",
        Global::package_json_version_with_sha
    )
}

/// `low` is the text reporter's red, `ok` its green.
fn class_of(value: f64, threshold: f64) -> &'static str {
    if value < threshold { "low" } else { "ok" }
}

fn write_bar(writer: &mut impl Write, value: f64, threshold: f64) -> bun_io::Result<()> {
    write!(
        writer,
        "<progress class=\"{}\" max=\"1\" value=\"{:.4}\"></progress>",
        class_of(value, threshold),
        value.clamp(0.0, 1.0)
    )
}

fn is_executed(report: &Report<'_>, line: usize) -> bool {
    report
        .lines_which_have_executed
        .is_set_allow_out_of_bound(line, false)
}

struct Counts {
    functions: usize,
    functions_executed: usize,
    lines: usize,
    lines_executed: usize,
}

impl Counts {
    fn of(report: &Report<'_>) -> Counts {
        let mut lines_executed = 0;
        let mut lines = report.executable_lines.iterator::<true, true>();
        while let Some(line) = lines.next() {
            lines_executed += usize::from(is_executed(report, line));
        }
        Counts {
            functions: report.functions.len(),
            functions_executed: report.functions_which_have_executed.count(),
            lines: report.executable_lines.count(),
            lines_executed,
        }
    }
}

/// `all_files` is the row the text reporter calls "All files".
pub fn write_index(
    rows: &[IndexRow<'_>],
    all_files: &Fraction,
    thresholds: &Fraction,
    writer: &mut impl Write,
) -> bun_io::Result<()> {
    write_head(writer, b"Coverage report")?;
    writer.write_all(
        b"<header>\n<h1>Coverage report</h1>\n</header>\n<main>\n\
<input id=\"filter\" type=\"search\" placeholder=\"Filter files\" aria-label=\"Filter files\" hidden>\n\
<table class=\"files\" id=\"files\">\n\
<thead><tr><th aria-sort=\"ascending\"><button type=\"button\" data-sort=\"s\">File</button></th>\
<th class=\"num\"><button type=\"button\" data-sort=\"n\">% Funcs</button></th><th class=\"num count\">Funcs</th>\
<th class=\"num\"><button type=\"button\" data-sort=\"n\">% Lines</button></th><th class=\"num count\">Lines</th>\
<th class=\"bar\"></th></tr></thead>\n",
    )?;

    // Without files the text reporter compares "All files" with no threshold.
    let no_threshold = Fraction {
        functions: 0.0,
        lines: 0.0,
        stmts: 0.0,
        failing: false,
    };
    let all_thresholds = if rows.is_empty() {
        &no_threshold
    } else {
        thresholds
    };
    write!(
        writer,
        "<tbody class=\"all\"><tr><td>All files</td><td class=\"num {}\">{:.2}</td><td class=\"count\"></td>\
<td class=\"num {}\">{:.2}</td><td class=\"count\"></td><td class=\"bar\">",
        class_of(all_files.functions, all_thresholds.functions),
        all_files.functions * 100.0,
        class_of(all_files.lines, all_thresholds.lines),
        all_files.lines * 100.0,
    )?;
    write_bar(writer, all_files.lines, all_thresholds.lines)?;
    writer.write_all(b"</td></tr></tbody>\n<tbody>\n")?;

    for row in rows {
        let counts = Counts::of(row.report);
        writer.write_all(b"<tr><td><a href=\"")?;
        write_escaped(writer, row.href)?;
        writer.write_all(b"\">")?;
        write_escaped(writer, row.name)?;
        write!(
            writer,
            "</a></td><td class=\"num {}\">{:.2}</td><td class=\"num count\">{}/{}</td>\
<td class=\"num {}\">{:.2}</td><td class=\"num count\">{}/{}</td><td class=\"bar\">",
            class_of(row.fraction.functions, thresholds.functions),
            row.fraction.functions * 100.0,
            counts.functions_executed,
            counts.functions,
            class_of(row.fraction.lines, thresholds.lines),
            row.fraction.lines * 100.0,
            counts.lines_executed,
            counts.lines,
        )?;
        write_bar(writer, row.fraction.lines, thresholds.lines)?;
        writer.write_all(b"</td></tr>\n")?;
    }

    writer.write_all(b"</tbody>\n</table>\n</main>\n")?;
    write_foot(writer)?;
    writer.write_all(b"<script>\n")?;
    writer.write_all(INDEX_SCRIPT.as_bytes())?;
    writer.write_all(b"</script>\n</body>\n</html>\n")
}

/// The lines of `text` by the table that numbers the lines of a report, each without its terminator.
fn lines_of(text: &[u8]) -> Vec<&[u8]> {
    const TERMINATORS: [&[u8]; 5] = [b"\r\n", b"\n", b"\r", b"\xE2\x80\xA8", b"\xE2\x80\xA9"];
    let mut table = bun_core::handle_oom(LineOffsetTable::generate(text, 0));
    let starts = table.items_byte_offset_to_start_of_line().to_vec();
    table.drop_elements();
    let mut lines: Vec<&[u8]> = Vec::with_capacity(starts.len());
    for (i, &start) in starts.iter().enumerate() {
        let end = starts.get(i + 1).map_or(text.len(), |&next| next as usize);
        let line = &text[start as usize..end];
        let terminator = TERMINATORS
            .iter()
            .find(|terminator| line.ends_with(terminator));
        lines.push(&line[..line.len() - terminator.map_or(0, |terminator| terminator.len())]);
    }
    // The table ends with the line after the last terminator, which has nothing on it.
    if starts
        .last()
        .is_some_and(|&start| start as usize == text.len())
    {
        lines.pop();
    }
    lines
}

/// The ranges the text reporter lists under "Uncovered Line #s", zero-based and inclusive.
fn uncovered_ranges(report: &Report<'_>) -> Vec<(usize, usize)> {
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    let mut lines = report.executable_lines.iterator::<true, true>();
    while let Some(line) = lines.next() {
        if is_executed(report, line) {
            continue;
        }
        match ranges.last_mut() {
            Some((_, end)) if *end + 1 == line => *end = line,
            _ => ranges.push((line, line)),
        }
    }
    ranges
}

/// `name` is the path the text reporter prints, `index_href` the URL of the index from this page.
pub fn write_file(
    report: &Report<'_>,
    name: &[u8],
    index_href: &[u8],
    source: Source<'_>,
    fraction: &Fraction,
    thresholds: &Fraction,
    writer: &mut impl Write,
) -> bun_io::Result<()> {
    write_head(writer, name)?;
    writer.write_all(b"<header>\n<nav><a href=\"")?;
    write_escaped(writer, index_href)?;
    writer.write_all(b"\">All files</a></nav>\n<h1>")?;
    write_escaped(writer, name)?;
    writer.write_all(b"</h1>\n")?;

    let counts = Counts::of(report);
    write!(
        writer,
        "<dl class=\"totals\">\n\
<div><dt>Functions</dt><dd class=\"{}\">{:.2}% <small>{}/{}</small></dd></div>\n\
<div><dt>Lines</dt><dd class=\"{}\">{:.2}% <small>{}/{}</small></dd></div>\n\
</dl>\n",
        class_of(fraction.functions, thresholds.functions),
        fraction.functions * 100.0,
        counts.functions_executed,
        counts.functions,
        class_of(fraction.lines, thresholds.lines),
        fraction.lines * 100.0,
        counts.lines_executed,
        counts.lines,
    )?;

    let mut from_last = report.executable_lines.iterator::<true, false>();
    let numbered_lines = from_last.next().map_or(0, |line| line + 1);
    let shown: Result<Vec<&[u8]>, &str> = match source {
        Source::Text(text) => Some(lines_of(text))
            .filter(|lines| lines.len() >= numbered_lines)
            .ok_or("The file has fewer lines than the code that ran, so its source is not shown."),
        Source::Unreadable => Err("The file could not be read, so its source is not shown."),
        Source::NotAFile => Err("This module is not a file, so there is no source to show."),
        Source::Transpiled => Err(
            "coverageIgnoreSourcemaps is set: the line numbers are those of the transpiled code, so the source is not shown.",
        ),
        Source::Mapped => Err(
            "This file names a source map of its own: the line numbers are those of the sources it was made from, so the file is not shown.",
        ),
    };

    let ranges = uncovered_ranges(report);
    for (i, &(start, end)) in ranges.iter().enumerate() {
        writer.write_all(if i == 0 {
            b"<p class=\"uncovered\">Uncovered lines: ".as_slice()
        } else {
            b", ".as_slice()
        })?;
        // Without the source there is no line to link to.
        if shown.is_ok() {
            write!(writer, "<a href=\"#L{}\">", start + 1)?;
        }
        write!(writer, "{}", start + 1)?;
        if start != end {
            write!(writer, "-{}", end + 1)?;
        }
        if shown.is_ok() {
            writer.write_all(b"</a>")?;
        }
    }
    if !ranges.is_empty() {
        writer.write_all(b"</p>\n")?;
    }
    writer.write_all(b"</header>\n<main>\n")?;

    match shown {
        Ok(lines) => write_source(writer, report, &lines)?,
        Err(note) => writeln!(writer, "<p class=\"note\">{note}</p>")?,
    }

    writer.write_all(b"</main>\n")?;
    write_foot(writer)?;
    writer.write_all(b"</body>\n</html>\n")
}

fn write_source(
    writer: &mut impl Write,
    report: &Report<'_>,
    lines: &[&[u8]],
) -> bun_io::Result<()> {
    writer.write_all(b"<div class=\"source\"><table>\n")?;
    for (line, text) in lines.iter().enumerate() {
        let executable = report
            .executable_lines
            .is_set_allow_out_of_bound(line, false);
        let class = match (executable, is_executed(report, line)) {
            (false, _) => "",
            (true, true) => " class=\"hit\"",
            (true, false) => " class=\"miss\"",
        };
        let number = line + 1;
        write!(
            writer,
            "<tr id=\"L{number}\"{class}><td class=\"n\"><a href=\"#L{number}\">{number}</a></td><td class=\"c\">"
        )?;
        write_escaped(writer, text)?;
        writer.write_all(b"</td></tr>\n")?;
    }
    writer.write_all(b"</table></div>\n")
}
