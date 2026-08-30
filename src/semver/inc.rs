//! `inc`: node-semver's `semver.inc()` on a parsed [`Version`].

use std::io::Write;

use bun_core::strings;

use crate::Version;

/// The part of a version an increment bumps, in node-semver's vocabulary.
#[derive(Copy, Clone, Eq, PartialEq, Debug)]
pub enum Release {
    Major,
    Minor,
    Patch,
    Premajor,
    Preminor,
    Prepatch,
    Prerelease,
    /// Drops the prerelease tag: `1.2.3-beta.4` becomes `1.2.3`.
    Release,
}

impl Release {
    pub const ALL: [Release; 8] = [
        Release::Major,
        Release::Minor,
        Release::Patch,
        Release::Premajor,
        Release::Preminor,
        Release::Prepatch,
        Release::Prerelease,
        Release::Release,
    ];

    pub fn from_bytes(name: &[u8]) -> Option<Release> {
        Release::ALL
            .into_iter()
            .find(|release| release.as_str().as_bytes() == name)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Release::Major => "major",
            Release::Minor => "minor",
            Release::Patch => "patch",
            Release::Premajor => "premajor",
            Release::Preminor => "preminor",
            Release::Prepatch => "prepatch",
            Release::Prerelease => "prerelease",
            Release::Release => "release",
        }
    }

    fn is_pre(self) -> bool {
        matches!(
            self,
            Release::Premajor | Release::Preminor | Release::Prepatch | Release::Prerelease
        )
    }
}

/// The number a new prerelease identifier starts at.
#[derive(Copy, Clone, Eq, PartialEq, Debug)]
pub enum IdentifierBase {
    /// `1.2.3-beta.0`
    Zero,
    /// `1.2.3-beta.1`
    One,
    /// No number at all: `1.2.3-beta`.
    None,
}

/// One dot-separated part of a prerelease tag. Numeric parts are what an
/// increment counts up, so they are kept as numbers.
#[derive(Copy, Clone)]
enum Identifier<'a> {
    Number(u64),
    Text(&'a [u8]),
}

impl<'a> Identifier<'a> {
    /// An all-digit part is a number up to `Number.MAX_SAFE_INTEGER`, the same parts
    /// `Bun.semver.parse` reports as numbers. Above that it stays text and is never counted up.
    fn parse(text: &'a [u8]) -> Identifier<'a> {
        const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

        if is_numeric(text)
            && let Ok(number) = bun_core::parse_unsigned::<u64>(text, 10)
            && number <= MAX_SAFE_INTEGER
        {
            return Identifier::Number(number);
        }
        Identifier::Text(text)
    }

    /// node-semver's `compareIdentifiers(a, b) === 0`: two numeric parts are equal as
    /// numbers (`01` equals `1`), anything else as text.
    fn equals(self, text: &[u8]) -> bool {
        match self {
            Identifier::Number(number) => {
                is_numeric(text)
                    && bun_core::parse_unsigned::<u64>(text, 10).is_ok_and(|other| other == number)
            }
            Identifier::Text(own) => own == text,
        }
    }

    fn write_to(self, out: &mut Vec<u8>) {
        match self {
            Identifier::Number(number) => {
                write!(out, "{number}").expect("writing to a Vec cannot fail");
            }
            Identifier::Text(text) => out.extend_from_slice(text),
        }
    }
}

fn is_numeric(part: &[u8]) -> bool {
    !part.is_empty() && part.iter().all(u8::is_ascii_digit)
}

/// A prerelease identifier as semver.org item 9 defines it: dot-separated parts of
/// `[0-9A-Za-z-]`, where a numeric part has no leading zero.
fn is_valid_identifier(identifier: &[u8]) -> bool {
    !identifier.is_empty()
        && strings::split(identifier, b".").all(|part| {
            !part.is_empty()
                && part.iter().all(|&c| c.is_ascii_alphanumeric() || c == b'-')
                && !(is_numeric(part) && part.len() > 1 && part[0] == b'0')
        })
}

fn write_joined(parts: &[Identifier<'_>], out: &mut Vec<u8>) {
    for (i, part) in parts.iter().enumerate() {
        if i > 0 {
            out.push(b'.');
        }
        part.write_to(out);
    }
}

/// node-semver's `SemVer#inc`. `version` was parsed from `buf`.
///
/// Returns the new version without build metadata, or `None` when there is nothing
/// to increment to: `release` on a version with no prerelease tag, an `identifier`
/// that is not a valid prerelease identifier, a prerelease that would be empty, or a
/// component that would overflow. `identifier` and `base` only matter to the `pre*`
/// release types and are not looked at otherwise.
pub fn inc(
    version: Version,
    buf: &[u8],
    release: Release,
    identifier: Option<&[u8]>,
    base: IdentifierBase,
) -> Option<Vec<u8>> {
    let identifier = identifier.filter(|identifier| !identifier.is_empty());
    if release.is_pre() {
        if identifier.is_some_and(|identifier| !is_valid_identifier(identifier)) {
            return None;
        }
        // Without an identifier and without a number the prerelease tag would be empty.
        if identifier.is_none() && base == IdentifierBase::None {
            return None;
        }
    }

    let (mut major, mut minor, mut patch) = (version.major, version.minor, version.patch);
    let pre_tag = version.tag.pre.slice(buf);
    let mut pre: Vec<Identifier<'_>> = if pre_tag.is_empty() {
        Vec::new()
    } else {
        strings::split(pre_tag, b".")
            .map(Identifier::parse)
            .collect()
    };

    match release {
        // A prerelease of the next major, minor or patch version (`2.0.0-beta.1`,
        // `1.2.0-rc.0`, `1.2.3-0`) is bumped to that version itself, not past it.
        Release::Major => {
            if minor != 0 || patch != 0 || pre.is_empty() {
                major = major.checked_add(1)?;
            }
            minor = 0;
            patch = 0;
            pre.clear();
        }
        Release::Minor => {
            if patch != 0 || pre.is_empty() {
                minor = minor.checked_add(1)?;
            }
            patch = 0;
            pre.clear();
        }
        Release::Patch => {
            if pre.is_empty() {
                patch = patch.checked_add(1)?;
            }
            pre.clear();
        }
        Release::Premajor => {
            major = major.checked_add(1)?;
            minor = 0;
            patch = 0;
            pre.clear();
            bump_prerelease(&mut pre, identifier, base)?;
        }
        Release::Preminor => {
            minor = minor.checked_add(1)?;
            patch = 0;
            pre.clear();
            bump_prerelease(&mut pre, identifier, base)?;
        }
        Release::Prepatch => {
            patch = patch.checked_add(1)?;
            pre.clear();
            bump_prerelease(&mut pre, identifier, base)?;
        }
        // On a version that is not a prerelease this is `prepatch`.
        Release::Prerelease => {
            if pre.is_empty() {
                patch = patch.checked_add(1)?;
            }
            bump_prerelease(&mut pre, identifier, base)?;
        }
        Release::Release => {
            if pre.is_empty() {
                return None;
            }
            pre.clear();
        }
    }

    let mut out = Vec::with_capacity(buf.len() + 4);
    write!(out, "{major}.{minor}.{patch}").expect("writing to a Vec cannot fail");
    if !pre.is_empty() {
        out.push(b'-');
        write_joined(&pre, &mut out);
    }
    Some(out)
}

/// node-semver's `inc("pre")`: count the last numeric part up, or start one; then,
/// with an identifier, keep the tag only if it already belongs to that identifier
/// (`beta.1` stays `beta.2` for `beta`, becomes `alpha.0` for `alpha`).
fn bump_prerelease<'a>(
    pre: &mut Vec<Identifier<'a>>,
    identifier: Option<&'a [u8]>,
    base: IdentifierBase,
) -> Option<()> {
    let base_number = match base {
        IdentifierBase::One => 1,
        IdentifierBase::Zero | IdentifierBase::None => 0,
    };

    if pre.is_empty() {
        pre.push(Identifier::Number(base_number));
    } else {
        let last_number = pre.iter_mut().rev().find_map(|part| match part {
            Identifier::Number(number) => Some(number),
            Identifier::Text(_) => None,
        });
        match last_number {
            Some(number) => *number = number.checked_add(1)?,
            None => {
                // `1.2.3-beta` with the identifier `beta` and no number has nowhere to go.
                if base == IdentifierBase::None
                    && let Some(identifier) = identifier
                {
                    let mut joined = Vec::with_capacity(identifier.len());
                    write_joined(pre, &mut joined);
                    if joined == identifier {
                        return None;
                    }
                }
                pre.push(Identifier::Number(base_number));
            }
        }
    }

    if let Some(identifier) = identifier {
        let same_identifier = pre[0].equals(identifier);
        let has_number = match pre.get(1) {
            Some(Identifier::Number(_)) => true,
            Some(Identifier::Text(text)) => is_numeric(text),
            None => false,
        };
        if !same_identifier || !has_number {
            pre.clear();
            pre.push(Identifier::Text(identifier));
            if base != IdentifierBase::None {
                pre.push(Identifier::Number(base_number));
            }
        }
    }
    Some(())
}
