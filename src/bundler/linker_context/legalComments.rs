//! The `eof`, `linked` and `external` modes of `legalComments`: what a chunk gets back of the comments its printer left out.

use std::borrow::Cow;

use bun_collections::{ArrayHashMap, StringArrayHashMap, StringSet};
use bun_core::strings;
use bun_paths::fs::Path;

use crate::cheap_prefix_normalizer;

/// Goes after the path of the chunk.
pub(crate) const FILE_EXTENSION: &[u8] = b".LEGAL.txt";

/// The legal comments of one chunk, in the order of its code.
#[derive(Default)]
pub(crate) struct LegalCommentList {
    /// Each text once: a header that every file of a project repeats is one comment.
    first_party: StringSet,
    /// By source index. A notice that does not name its package would read as the license of the whole bundle.
    third_party: ArrayHashMap<u32, ThirdParty>,
}

#[derive(Default)]
struct ThirdParty {
    package_path: Box<[u8]>,
    comments: StringSet,
}

/// Files below `node_modules` that have the same comments.
struct Group<'a> {
    package_paths: Vec<&'a [u8]>,
    comments: &'a StringSet,
}

impl LegalCommentList {
    /// `comment` as it is written in a source file, `/*` or `//` included.
    pub(crate) fn add(&mut self, source_index: u32, path: &Path<'_>, comment: &[u8]) {
        let comments = match package_path(path) {
            Some(package_path) => {
                let entry = bun_core::handle_oom(self.third_party.get_or_put(source_index));
                let file: &mut ThirdParty = entry.value_ptr;
                if !entry.found_existing {
                    file.package_path = package_path.into_owned().into_boxed_slice();
                }
                &mut file.comments
            }
            None => &mut self.first_party,
        };
        bun_core::handle_oom(comments.insert(comment));
    }

    /// `text` is what a CSS comment has between `/*` and `*/`.
    pub(crate) fn add_css(&mut self, source_index: u32, path: &Path<'_>, text: &[u8]) {
        self.add(source_index, path, &css_comment(text));
    }

    fn groups(&self) -> Vec<Group<'_>> {
        let mut groups: Vec<Group<'_>> = Vec::new();
        let mut group_of: StringArrayHashMap<usize> = StringArrayHashMap::new();
        let mut key: Vec<u8> = Vec::new();
        for file in self.third_party.values() {
            key.clear();
            for comment in file.comments.keys() {
                key.extend_from_slice(&comment.len().to_le_bytes());
                key.extend_from_slice(comment);
            }
            let entry = bun_core::handle_oom(group_of.get_or_put(&key));
            if !entry.found_existing {
                *entry.value_ptr = groups.len();
                groups.push(Group {
                    package_paths: Vec::new(),
                    comments: &file.comments,
                });
            }
            let package_paths = &mut groups[*entry.value_ptr].package_paths;
            if !package_paths.contains(&&*file.package_path) {
                package_paths.push(&file.package_path);
            }
        }
        groups
    }

    /// What `eof` ends the code of the chunk with. In the comment of the packages, `(*` and `*)` stand for `/*` and `*/`.
    pub(crate) fn to_end_of_file(&self) -> Vec<u8> {
        let mut out = Vec::new();
        for comment in self.first_party.keys() {
            out.extend_from_slice(comment);
            out.push(b'\n');
        }

        let groups = self.groups();
        if groups.is_empty() {
            return out;
        }
        out.extend_from_slice(b"/*! Bundled license information:\n");
        for group in &groups {
            out.push(b'\n');
            for package_path in &group.package_paths {
                push_inside_comment(&mut out, package_path);
                out.extend_from_slice(b":\n");
            }
            for comment in group.comments.keys() {
                let block = comment
                    .strip_prefix(b"/*")
                    .and_then(|rest| rest.strip_suffix(b"*/"));
                let mut inside = Vec::with_capacity(comment.len());
                push_inside_comment(
                    &mut inside,
                    block.unwrap_or_else(|| comment.strip_prefix(b"//").unwrap_or(comment)),
                );
                out.extend_from_slice(b"  (*");
                push_indented(&mut out, &inside);
                out.extend_from_slice(if block.is_some() { b"*)\n" } else { b" *)\n" });
            }
        }
        out.extend_from_slice(b"*/\n");
        out
    }

    /// The file of `linked` and `external`. Empty when the chunk has no legal comments: then there is no file.
    pub(crate) fn to_external_file(&self) -> Vec<u8> {
        let mut out = Vec::new();
        for comment in self.first_party.keys() {
            out.extend_from_slice(comment);
            out.push(b'\n');
        }

        let groups = self.groups();
        if groups.is_empty() {
            return out;
        }
        if !out.is_empty() {
            out.push(b'\n');
        }
        out.extend_from_slice(b"Bundled license information:\n");
        for group in &groups {
            out.push(b'\n');
            for package_path in &group.package_paths {
                out.extend_from_slice(package_path);
                out.extend_from_slice(b":\n");
            }
            for comment in group.comments.keys() {
                out.extend_from_slice(b"  ");
                push_indented(&mut out, comment);
                out.push(b'\n');
            }
        }
        out
    }
}

/// A license comment of a stylesheet as a comment, with the line endings of the output.
pub(crate) fn css_comment(text: &[u8]) -> Vec<u8> {
    let mut comment = Vec::with_capacity(text.len() + 4);
    comment.extend_from_slice(b"/*");
    for (i, line) in strings::split(text, b"\r\n").enumerate() {
        if i > 0 {
            comment.push(b'\n');
        }
        comment.extend_from_slice(line);
    }
    comment.extend_from_slice(b"*/");
    comment
}

/// What follows the last `node_modules` directory in the path of a file, with `/` between the names.
fn package_path<'a>(path: &Path<'a>) -> Option<Cow<'a, [u8]>> {
    const NODE_MODULES: &[u8] = b"node_modules";
    if path.is_data_url() {
        return None;
    }
    let text = path.text;
    let mut end = text.len();
    let below = loop {
        let start = strings::last_index_of(&text[..end], NODE_MODULES)?;
        let after = start + NODE_MODULES.len();
        let is_directory = (start == 0 || bun_paths::is_sep_native(text[start - 1]))
            && text
                .get(after)
                .is_some_and(|&byte| bun_paths::is_sep_native(byte));
        if is_directory {
            break &text[after + 1..];
        }
        end = start;
    };
    if below.is_empty() {
        return None;
    }
    if cfg!(windows) && strings::contains_char(below, b'\\') {
        let mut posix = below.to_vec();
        bun_paths::resolve_path::platform_to_posix_in_place::<u8>(&mut posix);
        return Some(Cow::Owned(posix));
    }
    Some(Cow::Borrowed(below))
}

/// `text` goes into a comment, which a `*/` in it would end.
fn push_inside_comment(out: &mut Vec<u8>, mut text: &[u8]) {
    while let Some(i) = strings::index_of(text, b"*/") {
        out.extend_from_slice(&text[..=i]);
        out.push(b' ');
        text = &text[i + 1..];
    }
    out.extend_from_slice(text);
}

/// The first line of `text` goes where `out` ends, the others below it with two spaces.
fn push_indented(out: &mut Vec<u8>, text: &[u8]) {
    for (i, line) in strings::split(text, b"\n").enumerate() {
        if i > 0 {
            out.extend_from_slice(b"\n  ");
        }
        out.extend_from_slice(line);
    }
}

/// `code` with the comment that `linked` ends a chunk with. `file` is the `.LEGAL.txt` file, named like a source map.
pub(crate) fn append_link(code: &[u8], public_path: &[u8], file: &[u8]) -> Box<[u8]> {
    const START: &[u8] = b"/*! For license information please see ";
    const END: &[u8] = b" */\n";

    let url = if public_path.is_empty() {
        bun_paths::basename(file).to_vec()
    } else {
        cheap_prefix_normalizer(public_path, file).concat()
    };
    let mut out = Vec::with_capacity(code.len() + 1 + START.len() + url.len() + END.len());
    out.extend_from_slice(code);
    if out.last().is_some_and(|&last| last != b'\n') {
        out.push(b'\n');
    }
    out.extend_from_slice(START);
    push_inside_comment(&mut out, &url);
    out.extend_from_slice(END);
    out.into_boxed_slice()
}
