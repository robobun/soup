//! `jsr:` dependencies.
//!
//! JSR serves every package to npm clients as `@jsr/<scope>__<name>` from a registry of its own,
//! so a `jsr:` specifier is another spelling of an `npm:` alias in the `@jsr` scope:
//!
//! ```text
//! "@std/path": "jsr:^1.0.0"            ->  "npm:@jsr/std__path@^1.0.0"
//! "path":      "jsr:@std/path@^1.0.0"  ->  "npm:@jsr/std__path@^1.0.0"
//! ```
//!
//! A specifier becomes the alias where it is read (a package.json, a registry manifest, a
//! lockfile, the command line), so a `Dependency` and a lockfile only ever hold the alias. What
//! is written back to a package.json is spelled `jsr:` again.

use std::borrow::Cow;

use bun_core::strings;

pub const PROTOCOL: &[u8] = b"jsr:";

/// The npm scope of the packages of JSR, and the registry of that scope when neither it nor the
/// default registry is configured.
pub const SCOPE: &[u8] = b"jsr";
pub const REGISTRY_URL: &[u8] = b"https://npm.jsr.io/";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Error {
    MissingScope,
    InvalidName,
    InvalidVersion,
}

impl Error {
    pub fn message(self) -> &'static str {
        match self {
            Error::MissingScope => "JSR package names have a scope, like jsr:@scope/name",
            Error::InvalidName => "invalid JSR package name",
            Error::InvalidVersion => "invalid JSR version: expected a version, a range or a tag",
        }
    }
}

/// What follows `jsr:`. Both are slices of the specifier, without whitespace around them.
pub struct Specifier<'a> {
    /// `@scope/name`. `jsr:<version>` has none: the package is the one the dependency is named after.
    pub name: Option<&'a [u8]>,
    pub version: &'a [u8],
}

/// `jsr:@scope/name[@version]` or `jsr:<version>`. `jsr:owner/repo.git` is neither: it is a git
/// remote in scp form on a host named `jsr`, which is what every `jsr:` was before.
pub fn specifier(literal: &[u8]) -> Option<Specifier<'_>> {
    let target = strings::trim_left(literal, b" \t\n\r").strip_prefix(PROTOCOL)?;
    let target = strings::trim(target, &strings::WHITESPACE_CHARS);
    if !target.starts_with(b"@") {
        return (!strings::contains_char(target, b'/')).then_some(Specifier {
            name: None,
            version: target,
        });
    }
    let (name, version) = match strings::index_of_char_usize(&target[1..], b'@') {
        Some(at) => (&target[..at + 1], &target[at + 2..]),
        None => (target, &target[target.len()..]),
    };
    Some(Specifier {
        name: Some(strings::trim(name, &strings::WHITESPACE_CHARS)),
        version: strings::trim(version, &strings::WHITESPACE_CHARS),
    })
}

#[inline]
pub fn is_jsr(literal: &[u8]) -> bool {
    specifier(literal).is_some()
}

/// `@std/path` -> `@jsr/std__path`
fn npm_name(jsr_name: &[u8]) -> Result<Vec<u8>, Error> {
    let Some(scoped) = jsr_name.strip_prefix(b"@") else {
        return Err(Error::MissingScope);
    };
    let Some((scope, name)) = strings::split_once_char(scoped, b'/') else {
        return Err(Error::InvalidName);
    };
    let npm_name = [b"@jsr/".as_slice(), scope, b"__", name].concat();
    // The scope and the name become one path segment of a registry URL.
    if scope.is_empty() || name.is_empty() || !strings::is_npm_package_name(&npm_name) {
        return Err(Error::InvalidName);
    }
    Ok(npm_name)
}

/// A version, a range or a dist-tag: nothing that names a package, a protocol, a path or a
/// tarball, which an `npm:` alias would read as one.
fn is_registry_version(version: &[u8]) -> bool {
    let is_tarball = |suffix: &[u8]| {
        version.len() >= suffix.len()
            && version[version.len() - suffix.len()..].eq_ignore_ascii_case(suffix)
    };
    strings::index_of_any(version, b"@:/\\").is_none()
        && !version.starts_with(b".")
        && !is_tarball(b".tgz")
        && !is_tarball(b".tar.gz")
        && !is_tarball(b".tar")
}

/// The `npm:` alias that `literal` stands for, or `None` if it is not a `jsr:` specifier.
pub fn to_npm_alias(dependency_name: &[u8], literal: &[u8]) -> Result<Option<Vec<u8>>, Error> {
    let Some(Specifier { name, version }) = specifier(literal) else {
        return Ok(None);
    };
    let npm_name = match name {
        Some(name) => npm_name(name)?,
        // `jsr:name@1.0.0`
        None if strings::contains_char(version, b'@') => return Err(Error::MissingScope),
        None => npm_name(dependency_name)?,
    };
    if !is_registry_version(version) {
        return Err(Error::InvalidVersion);
    }
    let mut alias = [b"npm:".as_slice(), &npm_name].concat();
    if !version.is_empty() {
        alias.push(b'@');
        alias.extend_from_slice(version);
    }
    Ok(Some(alias))
}

/// `literal` as a `Dependency` holds it: the alias of a `jsr:` specifier, anything else as it is.
pub fn stored<'a>(dependency_name: &[u8], literal: &'a [u8]) -> Result<Cow<'a, [u8]>, Error> {
    Ok(match to_npm_alias(dependency_name, literal)? {
        Some(alias) => Cow::Owned(alias),
        None => Cow::Borrowed(literal),
    })
}

/// The reverse of [`to_npm_alias`], as short as the name of the dependency allows:
/// `npm:@jsr/std__path@^1.0.0` -> `jsr:^1.0.0` for `@std/path`, `jsr:@std/path@^1.0.0` otherwise.
pub fn from_npm_alias(dependency_name: &[u8], literal: &[u8]) -> Option<Vec<u8>> {
    let target = strings::trim_left(literal, b" \t\n\r").strip_prefix(b"npm:@jsr/")?;
    let (npm_name, version) = strings::split_once_char(target, b'@').unwrap_or((target, b""));
    let separator = strings::index_of(npm_name, b"__")?;
    let (scope, name) = (&npm_name[..separator], &npm_name[separator + 2..]);
    if scope.is_empty() || name.is_empty() {
        return None;
    }
    let jsr_name = [b"@".as_slice(), scope, b"/", name].concat();
    let mut literal = PROTOCOL.to_vec();
    if jsr_name != dependency_name || version.is_empty() {
        literal.extend_from_slice(&jsr_name);
        if !version.is_empty() {
            literal.push(b'@');
        }
    }
    literal.extend_from_slice(version);
    Some(literal)
}
