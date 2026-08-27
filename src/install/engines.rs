//! The `"engines"` field of the project's own package.json.
//!
//! `bun install` and `bun run <script>` read `engines.bun` from the root
//! package.json and stop when the running bun does not satisfy it. Only the
//! project's own package.json is checked, never a dependency's.

use bstr::BStr;
use bun_core::{Global, env};
use bun_semver::{SlicedString, Version, query};

pub enum Check {
    /// The range is empty, or the running version is inside it.
    Satisfied,
    /// Nothing in the range parsed as a comparator (`"latest"`).
    InvalidRange,
    Unsatisfied,
}

/// Compare the running bun version against an `engines.bun` range.
///
/// The version is the bare `major.minor.patch`: a debug or canary build
/// counts as the release it is built from, the same way `Bun.version`
/// reports it. The range syntax is the one `bun install` accepts for a
/// dependency, so `>=1.3`, `1.x`, `^1.3.0 || ^2` and `*` all work.
pub fn check_bun_range(range: &[u8]) -> Check {
    let range = range.trim_ascii();
    if range.is_empty() {
        return Check::Satisfied;
    }

    // `query::parse` only fails on OOM.
    let group = bun_core::handle_oom(query::parse(range, SlicedString::init(range, range)));
    if group.is_empty() {
        return Check::InvalidRange;
    }

    let current = env::VERSION_STRING.as_bytes();
    let version = Version::parse(SlicedString::init(current, current))
        .version
        .min();

    let satisfied = match group.get_exact_version() {
        Some(exact) => version.eql(exact),
        None => group.satisfies(version, range, current),
    };

    if satisfied {
        Check::Satisfied
    } else {
        Check::Unsatisfied
    }
}

/// Exit with an error when the running bun does not satisfy `range`.
///
/// `package_json_path` names the file the range came from.
pub fn enforce_bun_range(range: &[u8], package_json_path: &[u8]) {
    match check_bun_range(range) {
        Check::Satisfied => {}
        Check::InvalidRange => {
            bun_core::pretty_errorln!(
                "<r><red>error<r><d>:<r> \"engines.bun\" in {} is not a valid version range: <b>\"{}\"<r>",
                BStr::new(package_json_path),
                BStr::new(range.trim_ascii()),
            );
            Global::exit(1);
        }
        Check::Unsatisfied => {
            bun_core::pretty_errorln!(
                "<r><red>error<r><d>:<r> this project requires bun <b>{}<r>, but bun <b>{}<r> is running",
                BStr::new(range.trim_ascii()),
                env::VERSION_STRING,
            );
            bun_core::note!(
                "\"engines\" in {} sets the requirement",
                BStr::new(package_json_path),
            );
            Global::exit(1);
        }
    }
}
