//! `--watch-exclude` patterns.

use bun_core::strings;

/// One `--watch-exclude`, turned into a glob over absolute paths with `/`
/// separators so that every path is matched in one form. Matching the path
/// relative to the project root as well would make a negated pattern cover
/// everything: one of the two forms always fails to match.
pub(crate) struct ExcludePattern {
    /// The pattern began with an odd number of `!`.
    negated: bool,
    glob: Box<[u8]>,
    /// `glob` with `/**` behind it: a pattern that names a directory covers
    /// what is in it, which is what `--watch-exclude src/generated` means.
    glob_below: Option<Box<[u8]>>,
}

impl ExcludePattern {
    /// `None` for a pattern that is empty. `cwd` is what a relative pattern is
    /// relative to.
    pub(crate) fn parse(pattern: &[u8], cwd: &[u8]) -> Option<ExcludePattern> {
        let mut body = pattern;
        let mut negated = false;
        while let Some(rest) = body.strip_prefix(b"!") {
            negated = !negated;
            body = rest;
        }
        if body.is_empty() {
            return None;
        }
        let mut body = body.to_vec();
        let mut cwd = cwd.to_vec();
        // On Windows a backslash in a pattern is a separator, as it is in the
        // paths the pattern is matched against, and not an escape.
        bun_paths::resolve_path::platform_to_posix_in_place(&mut body);
        bun_paths::resolve_path::platform_to_posix_in_place(&mut cwd);

        let is_absolute = body.first() == Some(&b'/')
            || (cfg!(windows) && body.len() > 2 && body[1] == b':' && body[2] == b'/');
        let mut glob: Vec<u8> = if is_absolute || body.starts_with(b"**") {
            body
        } else {
            let mut base: &[u8] = strings::trim_right(&cwd, b"/");
            let mut segments: Vec<&[u8]> = Vec::new();
            for segment in strings::split(&body, b"/") {
                match segment {
                    b"" | b"." => {}
                    b".." => {
                        if segments.pop().is_none() {
                            base = &base[..strings::last_index_of_char(base, b'/').unwrap_or(0)];
                        }
                    }
                    _ => segments.push(segment),
                }
            }
            // The directory is text, not a pattern.
            let mut glob = Vec::with_capacity(base.len() + body.len() + 1);
            for &byte in base {
                if matches!(byte, b'*' | b'?' | b'[' | b']' | b'{' | b'}' | b'\\') {
                    glob.push(b'\\');
                }
                glob.push(byte);
            }
            for segment in segments {
                glob.push(b'/');
                glob.extend_from_slice(segment);
            }
            glob
        };
        while glob.len() > 1 && glob.last() == Some(&b'/') {
            glob.pop();
        }
        if glob.is_empty() {
            return None;
        }
        let glob_below = (!glob.ends_with(b"**")).then(|| {
            let mut below = glob.clone();
            if below.last() != Some(&b'/') {
                below.push(b'/');
            }
            below.extend_from_slice(b"**");
            below.into_boxed_slice()
        });
        Some(ExcludePattern {
            negated,
            glob: glob.into_boxed_slice(),
            glob_below,
        })
    }

    /// `abs_path` is absolute, with `/` separators.
    pub(crate) fn covers(&self, abs_path: &[u8]) -> bool {
        let matched = bun_glob::r#match(&self.glob, abs_path).matches()
            || self
                .glob_below
                .as_deref()
                .is_some_and(|below| bun_glob::r#match(below, abs_path).matches());
        matched != self.negated
    }
}
