//! `alias` of `Bun.build` and `bun build --alias`: package names that the bundler looks up as
//! another package or as a file. The rules are esbuild's.

use bun_core::strings;

/// `(name, substitute)` pairs.
#[derive(Clone, Default)]
pub struct PackageAliases {
    entries: Vec<(Box<[u8]>, Box<[u8]>)>,
}

/// The half of an entry that cannot be one.
#[derive(Copy, Clone, Eq, PartialEq, Debug)]
pub enum InvalidAlias {
    /// Not a package path as an import spells it: relative, absolute, or not normalized.
    Name,
    /// Empty.
    Substitute,
}

impl PackageAliases {
    #[inline]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// A second entry for a name replaces the first.
    pub fn insert(&mut self, name: &[u8], substitute: &[u8]) -> Result<(), InvalidAlias> {
        if !Self::is_name(name) {
            return Err(InvalidAlias::Name);
        }
        if substitute.is_empty() {
            return Err(InvalidAlias::Substitute);
        }
        match self.entries.iter_mut().find(|entry| &*entry.0 == name) {
            Some(entry) => entry.1 = substitute.into(),
            None => self.entries.push((name.into(), substitute.into())),
        }
        Ok(())
    }

    /// `pkg`, `pkg/sub`, `@scope/pkg`, `node:fs`: not relative, not absolute, and nothing that
    /// normalizing a path would change.
    fn is_name(name: &[u8]) -> bool {
        let is_on_a_drive = name.len() >= 2
            && name[0].is_ascii_alphabetic()
            && name[1] == b':'
            && name.get(2).is_none_or(|&c| c == b'/');
        !name.is_empty()
            && !matches!(name[0], b'.' | b'/')
            && !strings::contains_char(name, b'\\')
            && !is_on_a_drive
            && strings::split(name, b"/")
                .all(|part| !part.is_empty() && part != b"." && part != b"..")
    }

    /// For an import of `specifier`: the substitute of the longest name that is `specifier` or a
    /// directory above it, and what `specifier` has after that name. `import "pkg/"` has nothing
    /// after it: the slash only tells a package from the Node.js module of the same name.
    pub fn find<'a>(&'a self, specifier: &'a [u8]) -> Option<(&'a [u8], &'a [u8])> {
        if self.entries.is_empty() {
            return None;
        }
        let (name, substitute) = self
            .entries
            .iter()
            .filter(|(name, _)| {
                specifier
                    .strip_prefix(&**name)
                    .is_some_and(|rest| rest.is_empty() || rest[0] == b'/')
            })
            .max_by_key(|(name, _)| name.len())?;
        let rest = &specifier[name.len()..];
        Some((substitute, if rest == b"/" { b"" } else { rest }))
    }
}
