//! What a scan leaves out, and the entries of a list of patterns.

use std::borrow::Cow;
use std::sync::Arc;

use bun_collections::smallvec::SmallVec;

use crate::{Prepared, matcher};

/// The patterns of the `ignore` option of a scan, and the `!` entries of a list of patterns.
///
/// A walker says which path a pattern is asked about, see `GlobWalker::set_ignore`. A `./` in
/// front of the path or of a pattern does not count: a scan for `./src/*.ts` reports
/// `./src/a.ts`, and `src/**` leaves it out.
pub struct IgnoreList {
    patterns: Vec<Pattern>,
    /// The `!` entries of a `Glob`, under the `ignore` option of one of its scans.
    parent: Option<Arc<IgnoreList>>,
}

struct Pattern {
    /// A walk asks it as it is: a scan asks one pattern about too few paths to make up for what
    /// a prepared one builds. `match()` of a list asks it prepared.
    text: Prepared<Box<[u8]>>,
    /// See [`names_directories`].
    names_directories: bool,
}

impl Pattern {
    fn new(text: &[u8]) -> Pattern {
        Pattern {
            names_directories: names_directories(text),
            text: Prepared::new(Box::from(text)),
        }
    }
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
            .map(|pattern| Pattern::new(&pattern_without_dot_slash(pattern)))
            .collect();
        IgnoreList {
            patterns,
            parent: None,
        }
    }

    /// The `ignore` option of a scan of a `Glob` whose `!` entries are `parent`: the scan leaves
    /// out what either of them leaves out.
    pub fn under(self, parent: Arc<IgnoreList>) -> IgnoreList {
        IgnoreList {
            parent: Some(parent),
            ..self
        }
    }

    pub fn is_empty(&self) -> bool {
        self.patterns.is_empty() && self.parent.as_ref().is_none_or(|it| it.is_empty())
    }

    /// The patterns, each as it is asked.
    pub fn patterns(&self) -> impl Iterator<Item = &[u8]> {
        self.patterns.iter().map(|it| it.text.pattern())
    }

    /// What a walk asks about a path that it found: whether a pattern matches it. A directory
    /// that is left out is not entered.
    #[inline]
    pub fn ignores(&self, path: &[u8], is_dir: bool) -> bool {
        let path = path_without_dot_slash(path);
        self.asks(path, is_dir) || self.parent.as_ref().is_some_and(|it| it.asks(path, is_dir))
    }

    #[inline]
    fn asks(&self, path: &[u8], is_dir: bool) -> bool {
        let matches =
            |pattern: &Pattern, path: &[u8]| crate::r#match(pattern.text.pattern(), path).matches();
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

/// A list of patterns, as `new Bun.Glob([..])` takes one.
///
/// An entry that starts with an odd number of `!` says what to leave out, as the `ignore` option
/// of a scan does. `!(` starts a group and is not counted, and `\!` is the character. The other
/// entries say what matches. A `./` in front of an entry does not count.
pub struct PatternList {
    positive: Vec<Prepared<Box<[u8]>>>,
    ignore: Arc<IgnoreList>,
    /// They match what is below a directory that `ignore` leaves out, see [`below`].
    below_ignored: Vec<Prepared<Box<[u8]>>>,
}

/// The pattern for what is below a directory that `pattern` matches: a walk does not enter
/// one. `None` if `pattern` matches all of that itself, as `dist/**` does, or names nothing.
fn below(pattern: &[u8]) -> Option<Box<[u8]>> {
    let escapes = |text: &[u8]| text.iter().rev().take_while(|it| **it == b'\\').count() % 2 == 1;
    // A `\` at the end of a pattern would escape what is put behind it.
    if pattern == b"**" || pattern.ends_with(b"/**") || escapes(pattern) {
        return None;
    }
    // `build/` is the directory `build`. An escaped `/` is part of a name.
    let mut directory = pattern;
    while let [rest @ .., b'/'] = directory
        && !escapes(rest)
    {
        directory = rest;
    }
    Some(match directory {
        b"" => return None,
        // `**/` is every directory, and what is below one has a `/` in it.
        b"**" => Box::from(&b"*/**"[..]),
        // `a/**/` is `a` and every directory below it.
        _ if directory.ends_with(b"/**") => Box::from(directory),
        _ => [directory, b"/**"].concat().into_boxed_slice(),
    })
}

impl PatternList {
    pub fn new<P: AsRef<[u8]>>(entries: impl IntoIterator<Item = P>) -> PatternList {
        let entries = entries.into_iter();
        let mut positive = Vec::with_capacity(entries.size_hint().0);
        let mut ignored = Vec::new();
        let mut below_ignored = Vec::new();
        for entry in entries {
            let entry = entry.as_ref();
            // An even number of `!` negates nothing, and a walker would read it as a name.
            let (bangs, pattern) = entry.split_at(matcher::negations(entry));
            let text = pattern_without_dot_slash(pattern);
            if bangs.len() % 2 == 1 {
                below_ignored.extend(below(&text).map(Prepared::new));
                ignored.push(Pattern::new(&text));
                continue;
            }
            // `./` alone stays what it is: the directory.
            positive.push(Prepared::new(Box::from(match &*text {
                b"" => pattern,
                text => text,
            })));
        }
        PatternList {
            positive,
            ignore: Arc::new(IgnoreList {
                patterns: ignored,
                parent: None,
            }),
            below_ignored,
        }
    }

    /// The entries that say what matches.
    pub fn positive(&self) -> &[Prepared<Box<[u8]>>] {
        &self.positive
    }

    /// The entries that say what to leave out.
    pub fn ignore(&self) -> &Arc<IgnoreList> {
        &self.ignore
    }

    /// Whether an entry matches `path` and a scan of the list would report it: no entry with `!`
    /// matches it or a directory above it, which a scan does not enter. The time is linear in the
    /// length of `path`.
    ///
    /// A walk does not ask about the `..` that a pattern starts with, or about the directory
    /// that an absolute pattern names before its first wildcard. This asks about them as well.
    pub fn matches(&self, path: &[u8]) -> bool {
        let matches = |patterns: &[Prepared<Box<[u8]>>], path: &[u8]| {
            patterns.iter().any(|it| it.r#match(path).matches())
        };
        // `./` alone stays what it is, as an entry does.
        let path = match path_without_dot_slash(path) {
            b"" => path,
            rest => rest,
        };
        let ignored = &self.ignore.patterns;
        matches(&self.positive, path)
            && !ignored.iter().any(|it| it.text.r#match(path).matches())
            && !matches(&self.below_ignored, path)
    }

    /// The bytes that the list owns when it is made. A pattern that is matched often builds
    /// more, as the pattern of every `Glob` does.
    pub fn memory_cost(&self) -> usize {
        let patterns = |list: &Vec<Prepared<Box<[u8]>>>| {
            list.capacity() * size_of::<Prepared<Box<[u8]>>>()
                + list.iter().map(|it| it.pattern().len()).sum::<usize>()
        };
        let ignored = &self.ignore.patterns;
        size_of::<Self>()
            + size_of::<IgnoreList>()
            + patterns(&self.positive)
            + patterns(&self.below_ignored)
            + ignored.capacity() * size_of::<Pattern>()
            + ignored
                .iter()
                .map(|it| it.text.pattern().len())
                .sum::<usize>()
    }
}
