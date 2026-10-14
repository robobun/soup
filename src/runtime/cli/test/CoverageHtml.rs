//! `bun test --coverage-reporter=html`: lays the pages out under the coverage directory and writes them.

use std::io::Write as _;

use bun_collections::StringSet;
use bun_core::strings;
use bun_options_types::code_coverage_options::{CodeCoverageOptions, Fraction};
use bun_paths::resolve_path;
use bun_sourcemap_jsc::code_coverage::{Report, html};
use bun_sys::{Fd, File};

use crate::test_command::{ReportError, average_fraction};

const SEPARATORS: &[u8] = if cfg!(windows) { b"/\\" } else { b"/" };
const PAGE_EXTENSION: &[u8] = b".html";

/// Leaves room in a 255-byte file name for the extension, a `-<n>` and the suffix of the temporary file.
const LONGEST_SEGMENT: usize = 200;

/// What follows the directories in the path of a temporary file: the name, and 64 bytes for everything else.
const AFTER_DIRECTORIES: usize = LONGEST_SEGMENT + 64;

fn same_segment(a: &[u8], b: &[u8]) -> bool {
    if cfg!(windows) {
        a.eq_ignore_ascii_case(b)
    } else {
        a == b
    }
}

/// The segments of the deepest directory that holds `relative_dir` and every file with an absolute path.
fn common_root<'a>(relative_dir: &'a [u8], reports: &'a [Report<'_>]) -> Vec<&'a [u8]> {
    let mut root: Vec<&[u8]> = strings::tokenize_any(relative_dir, SEPARATORS).collect();
    for report in reports {
        if !bun_paths::is_absolute(&report.source_url) {
            continue;
        }
        let mut segments = strings::tokenize_any(&report.source_url, SEPARATORS).peekable();
        let mut shared = 0;
        while shared < root.len() {
            let Some(segment) = segments.next() else {
                break;
            };
            let is_file_name = segments.peek().is_none();
            if is_file_name || !same_segment(root[shared], segment) {
                break;
            }
            shared += 1;
        }
        root.truncate(shared);
    }
    root
}

/// Whether Win32 opens a device for `name`: CON, PRN, AUX, NUL, COM1-9 and LPT1-9, whatever the extension.
fn is_windows_device(name: &[u8]) -> bool {
    let stem = &name[..strings::index_of_char_usize(name, b'.').unwrap_or(name.len())];
    match stem.len() {
        3 => [b"con", b"prn", b"aux", b"nul"]
            .iter()
            .any(|device| stem.eq_ignore_ascii_case(*device)),
        4 => {
            matches!(stem[3], b'1'..=b'9')
                && (stem[..3].eq_ignore_ascii_case(b"com")
                    || stem[..3].eq_ignore_ascii_case(b"lpt"))
        }
        _ => false,
    }
}

/// Appends `segment` as one name that Windows takes too and that cannot leave the directory.
fn push_segment(path: &mut Vec<u8>, segment: &[u8]) {
    if matches!(segment, b"." | b"..") || is_windows_device(segment) {
        path.push(b'_');
    }
    let mut end = segment.len().min(LONGEST_SEGMENT);
    // A UTF-8 sequence is at most four bytes: three steps back are before it or at its start.
    for _ in 0..3 {
        if end == segment.len() || strings::is_utf8_char_boundary(segment[end]) {
            break;
        }
        end -= 1;
    }
    path.extend(segment[..end].iter().map(|&byte| match byte {
        0..=0x1F | 0x7F | b'<' | b'>' | b':' | b'"' | b'|' | b'?' | b'*' | b'\\' | b'/' => b'_',
        _ => byte,
    }));
}

/// Appends a directory of a page's path.
fn push_directory(path: &mut Vec<u8>, segment: &[u8]) {
    let start = path.len();
    push_segment(path, segment);
    let name = &path[start..];
    // Every file of the report ends in `.html` and `lcov.info` is the lcov reporter's, so no directory may.
    let is_a_file = name.eq_ignore_ascii_case(b"lcov.info")
        || (name.len() >= PAGE_EXTENSION.len()
            && name[name.len() - PAGE_EXTENSION.len()..].eq_ignore_ascii_case(PAGE_EXTENSION));
    // Win32 drops a dot or a space at the end of a name.
    if is_a_file || matches!(name.last(), Some(b'.' | b' ')) {
        path.push(b'_');
    }
    path.push(b'/');
}

/// Where the page of each report goes under the coverage directory, with `/` between segments.
fn page_paths(
    opts: &CodeCoverageOptions,
    relative_dir: &[u8],
    reports: &[Report<'_>],
) -> Vec<Vec<u8>> {
    let root = common_root(relative_dir, reports);
    let longest = bun_paths::MAX_PATH_BYTES
        .saturating_sub(relative_dir.len() + opts.reports_directory.len() + AFTER_DIRECTORIES);
    let mut taken = StringSet::new();
    bun_core::handle_oom(taken.insert(b"index.html"));
    let mut folded: Vec<u8> = Vec::new();
    let mut paths = Vec::with_capacity(reports.len());
    for report in reports {
        let url: &[u8] = &report.source_url;
        let mut path: Vec<u8> = Vec::with_capacity(url.len() + PAGE_EXTENSION.len());
        // Not a path (a `data:` or `blob:` URL, the module of a plugin): the whole of it is one name.
        let mut file_name = url;
        if bun_paths::is_absolute(url) {
            let mut segments = strings::tokenize_any(url, SEPARATORS)
                .skip(root.len())
                .peekable();
            while let Some(segment) = segments.next() {
                if segments.peek().is_some() {
                    push_directory(&mut path, segment);
                } else {
                    file_name = segment;
                }
            }
        }
        // The directories do not fit a path buffer: the page goes next to the index.
        if path.len() > longest {
            path.clear();
        }
        push_segment(&mut path, file_name);
        if path.is_empty() {
            path.push(b'_');
        }
        let stem = path.len();
        path.extend_from_slice(PAGE_EXTENSION);
        let mut copy: u32 = 1;
        loop {
            folded.clear();
            folded.extend(path.iter().map(u8::to_ascii_lowercase));
            if !taken.contains(&folded) {
                break;
            }
            copy += 1;
            path.truncate(stem);
            let _ = write!(&mut path, "-{copy}.html");
        }
        bun_core::handle_oom(taken.insert(&folded));
        paths.push(path);
    }
    paths
}

fn href_of(path: &[u8]) -> Vec<u8> {
    let mut href = Vec::with_capacity(path.len());
    for (i, segment) in strings::split(path, b"/").enumerate() {
        if i > 0 {
            href.push(b'/');
        }
        strings::percent_encode_uri_component(segment, &mut href);
    }
    href
}

/// Bun does not transpile a `// @bun` file, and reads the source map that the file names.
fn names_a_source_map(text: &[u8]) -> bool {
    let code = if text.starts_with(b"#!") {
        strings::index_of_char_usize(text, b'\n').map_or(&text[..0], |end| &text[end + 1..])
    } else {
        text
    };
    code.starts_with(b"// @bun") && strings::contains(code, b"//# sourceMappingURL=")
}

/// What the page of the module at `url` shows: the file, read into `text` as the module loader reads it, or why not.
fn source_of<'a>(
    opts: &CodeCoverageOptions,
    url: &[u8],
    text: &'a mut Vec<u8>,
) -> html::Source<'a> {
    if opts.ignore_sourcemap {
        return html::Source::Transpiled;
    }
    if !bun_paths::is_absolute(url) {
        return html::Source::NotAFile;
    }
    let Ok(bytes) = File::read_from(Fd::cwd(), url) else {
        return html::Source::Unreadable;
    };
    *text = match strings::BOM::detect(&bytes) {
        Some(bom) => bom.remove_and_convert_to_utf8_and_free(bytes),
        None => bytes,
    };
    if names_a_source_map(text) {
        return html::Source::Mapped;
    }
    html::Source::Text(text)
}

fn make_directory(path: &[u8]) -> bun_sys::Result<()> {
    let mut fs = crate::node::fs::NodeFS::default();
    fs.mkdir_recursive(&crate::node::fs::args::Mkdir {
        path: crate::node::PathLike::borrowed(path),
        always_return_none: true,
        recursive: true,
        ..Default::default()
    })
    .map(|_| ())
}

/// Writes `name` under the coverage directory through a temporary file, so a reader never sees half a page.
fn write_file(
    opts: &CodeCoverageOptions,
    relative_dir: &[u8],
    temporary_suffix: &[u8],
    name: &[u8],
    contents: &[u8],
) -> bun_sys::Result<()> {
    let joined =
        relative_dir.len() + opts.reports_directory.len() + name.len() + temporary_suffix.len();
    if joined + 3 >= bun_paths::MAX_PATH_BYTES {
        return Err(
            bun_sys::Error::from_code(bun_sys::E::ENAMETOOLONG, bun_sys::Tag::open).with_path(name),
        );
    }
    let mut buf = bun_paths::path_buffer_pool::get();
    let destination = resolve_path::join_abs_string_buf::<bun_paths::platform::Auto>(
        relative_dir,
        &mut buf,
        &[&opts.reports_directory, name],
    );
    let tmp_z = bun_core::ZBox::from_vec([destination, temporary_suffix].concat());
    let dest_z = bun_core::ZBox::from_bytes(destination);
    let flags = bun_sys::O::WRONLY | bun_sys::O::CREAT | bun_sys::O::TRUNC | bun_sys::O::CLOEXEC;
    let open = || File::openat(Fd::cwd(), tmp_z.as_bytes(), flags, 0o644);
    let result = open()
        .or_else(|err| match bun_paths::dirname(destination) {
            Some(directory) if err.get_errno() == bun_sys::E::ENOENT => {
                make_directory(directory)?;
                open()
            }
            _ => Err(err),
        })
        .and_then(|file| file.write_all(contents))
        .and_then(|()| bun_sys::renameat(Fd::cwd(), &tmp_z, Fd::cwd(), &dest_z));
    if result.is_err() {
        let _ = bun_sys::unlinkat(Fd::cwd(), &tmp_z);
    }
    result
}

/// `fractions` go with `reports`.
pub(crate) fn write(
    opts: &CodeCoverageOptions,
    relative_dir: &[u8],
    reports: &[Report<'_>],
    fractions: &[Fraction],
) -> Result<(), ReportError> {
    let thresholds = &opts.fractions;
    let paths = page_paths(opts, relative_dir, reports);

    // Random, as the lcov reporter's: two runs that write into one directory share no temporary file.
    let mut random = [0u8; 8];
    bun_boringssl_sys::rand_bytes(&mut random);
    let mut temporary_suffix: Vec<u8> = Vec::new();
    let _ = write!(
        &mut temporary_suffix,
        ".{}.tmp",
        bun_core::fmt::hex_lower(&random)
    );
    let write_page = |name: &[u8], contents: &[u8]| {
        write_file(opts, relative_dir, &temporary_suffix, name, contents).map_err(|err| {
            let directory: &[u8] = &opts.reports_directory;
            ReportError {
                err,
                file: [directory, name].join(&b'/'),
            }
        })
    };

    let mut names: Vec<Vec<u8>> = Vec::with_capacity(reports.len());
    let mut page: Vec<u8> = Vec::new();
    let mut text: Vec<u8> = Vec::new();
    for ((report, fraction), path) in reports.iter().zip(fractions).zip(&paths) {
        let url: &[u8] = &report.source_url;
        // What the text reporter prints, but a URL that is not a path stays as it is.
        let name = if bun_paths::is_absolute(url) {
            resolve_path::relative(relative_dir, url).to_vec()
        } else {
            url.to_vec()
        };
        let mut index_href = b"../".repeat(strings::count_char(path, b'/'));
        index_href.extend_from_slice(b"index.html");

        page.clear();
        // Writing into a Vec cannot fail.
        let _ = html::write_file(
            report,
            &name,
            &index_href,
            source_of(opts, url, &mut text),
            fraction,
            thresholds,
            &mut page,
        );
        write_page(path, &page)?;
        names.push(name);
    }

    let hrefs: Vec<Vec<u8>> = paths.iter().map(|path| href_of(path)).collect();
    let mut rows: Vec<html::IndexRow<'_>> = reports
        .iter()
        .zip(fractions)
        .zip(names.iter().zip(&hrefs))
        .map(|((report, fraction), (name, href))| html::IndexRow {
            name,
            href,
            report,
            fraction,
        })
        .collect();
    // The index says that it is sorted by name, and `reports` are sorted by path.
    rows.sort_by(|a, b| a.name.cmp(b.name));
    page.clear();
    let _ = html::write_index(&rows, &average_fraction(fractions), thresholds, &mut page);
    write_page(b"index.html", &page)
}
