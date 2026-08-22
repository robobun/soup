//! What a scan leaves out.

use std::borrow::Cow;

use bun_collections::smallvec::SmallVec;

use crate::matcher;

/// The patterns of the `ignore` option of a scan.
///
/// A walker says which path a pattern is asked about, see `GlobWalker::set_ignore`. A `./` in
/// front of the path or of a pattern does not count: a scan for `./src/*.ts` reports
/// `./src/a.ts`, and `src/**` leaves it out.
pub struct IgnoreList {
    patterns: Vec<Pattern>,
}

struct Pattern {
    text: Box<[u8]>,
    /// See [`names_directories`].
    names_directories: bool,
}

/// `text` without each `./` that it starts with, and without the separators behind it. What is
/// left starts in the same directory: `.//a` is `a` and not `/a`.
fn without_dot_slash(mut text: &[u8], is_separator: impl Fn(u8) -> bool) -> &[u8] {
    while let [b'.', separator, rest @ ..] = text
        && is_separator(*separator)
    {
        text = rest;
        while let [separator, rest @ ..] = text
            && is_separator(*separator)
        {
            text = rest;
        }
    }
    text
}

/// `pattern` without the `./` in front of it. In a pattern `\` escapes, so only `/` separates.
/// A `!` that the `./` stood in front of is a character of a name and not a negation: it gets
/// a `\`.
pub(crate) fn pattern_without_dot_slash(pattern: &[u8]) -> Cow<'_, [u8]> {
    let rest = without_dot_slash(pattern, |c| c == b'/');
    if rest.len() != pattern.len() && matcher::negations(rest) > 0 {
        return Cow::Owned([b"\\", rest].concat());
    }
    Cow::Borrowed(rest)
}

pub(crate) fn path_without_dot_slash(path: &[u8]) -> &[u8] {
    without_dot_slash(path, bun_paths::is_sep)
}

/// Whether a directory is asked a second time, with a `/` at its end: `dist/**` and `build/`
/// match `dist/` and `build/`, and not `dist` and `build`. The pattern has a `**`, or a `/` at
/// its end or at the end of an alternative of a group. Another pattern is not asked so: the `*`
/// of `dist/*` matches nothing as well, and `dist` would be left out with what is in it.
fn names_directories(pattern: &[u8]) -> bool {
    let mut is_escaped = false;
    let mut previous = 0;
    for (index, &c) in pattern.iter().enumerate() {
        if is_escaped {
            is_escaped = false;
            previous = 0;
            continue;
        }
        match (c, pattern.get(index + 1)) {
            (b'\\', _) => is_escaped = true,
            (b'*', _) if previous == b'*' => return true,
            (b'/', None | Some(b',' | b'}' | b'|' | b')')) => return true,
            _ => {}
        }
        previous = c;
    }
    false
}

impl IgnoreList {
    pub fn new<'a>(patterns: impl IntoIterator<Item = &'a [u8]>) -> IgnoreList {
        let patterns = patterns
            .into_iter()
            .map(|pattern| {
                let text = Box::<[u8]>::from(pattern_without_dot_slash(pattern));
                Pattern {
                    names_directories: names_directories(&text),
                    text,
                }
            })
            .collect();
        IgnoreList { patterns }
    }

    pub fn is_empty(&self) -> bool {
        self.patterns.is_empty()
    }

    /// What a walk asks about a path that it found: whether a pattern matches it. A directory
    /// that is left out is not entered.
    #[inline]
    pub fn ignores(&self, path: &[u8], is_dir: bool) -> bool {
        let path = path_without_dot_slash(path);
        let matches =
            |pattern: &Pattern, path: &[u8]| crate::r#match(&pattern.text, path).matches();
        if self.patterns.iter().any(|it| matches(it, path)) {
            return true;
        }
        if !is_dir || !self.patterns.iter().any(|it| it.names_directories) {
            return false;
        }
        // A walk asks this for every directory, and most paths fit.
        let mut with_separator = SmallVec::<[u8; 256]>::new();
        with_separator.extend_from_slice(path);
        with_separator.push(b'/');
        self.patterns
            .iter()
            .any(|it| it.names_directories && matches(it, &with_separator))
    }
}
