//! The `"engines"` and `"devEngines"` fields of the project's own package.json.
//!
//! `bun install` and `bun run <script>` read `engines.bun` and `devEngines`
//! from the root package.json and stop when what is running does not satisfy
//! them. Only the project's own package.json is checked, never a dependency's.

use core::fmt;

use bstr::BStr;
use bun_core::{Global, env};
use bun_install_types::dev_engines::{self, Engine, OnFail, Problem, Requirement};
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
    check_range(range, env::VERSION_STRING.as_bytes(), false)
}

/// Compare the `major.minor.patch` of `current` against `range`. `strict` refuses a range that npm refuses.
fn check_range(range: &[u8], current: &[u8], strict: bool) -> Check {
    let range = range.trim_ascii();
    if range.is_empty() {
        return Check::Satisfied;
    }

    // `query::parse` only fails on OOM.
    let group = bun_core::handle_oom(query::parse(range, SlicedString::init(range, range)));
    if group.is_empty() || (strict && group.has_skipped()) {
        return Check::InvalidRange;
    }

    let parsed = Version::parse(SlicedString::init(current, current))
        .version
        .min();
    // Without the tag: the kernel release `6.8.0-85-generic` is inside `>=6`, which a prerelease is not.
    let version = Version {
        major: parsed.major,
        minor: parsed.minor,
        patch: parsed.patch,
        ..Default::default()
    };

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

/// What bun compares the requirements of one `devEngines` key with.
struct Running {
    /// Empty for the libc of a system that is not Linux.
    name: &'static [u8],
    /// Empty for a CPU and a libc.
    version: Vec<u8>,
}

impl Running {
    fn of(engine: Engine) -> Running {
        match engine {
            Engine::PackageManager | Engine::Runtime => Running {
                name: b"bun",
                version: env::VERSION_STRING.as_bytes().to_vec(),
            },
            Engine::Os => Running {
                name: engine.name_of_this_system().unwrap_or_default(),
                version: os_release(),
            },
            Engine::Cpu | Engine::Libc => Running {
                name: engine.name_of_this_system().unwrap_or_default(),
                version: Vec::new(),
            },
        }
    }

    fn meets(&self, requirement: &Requirement) -> bool {
        if self.name.is_empty() || *requirement.name != *self.name {
            return false;
        }
        let version = requirement.version.as_deref().unwrap_or_default();
        let version = version.trim_ascii();
        if version.is_empty() {
            return true;
        }
        // As in npm, the same text is met whether or not it reads as a range.
        *version == *self.version
            || (!self.version.is_empty()
                && matches!(check_range(version, &self.version, true), Check::Satisfied))
    }
}

/// `os.release()`, which is what npm compares `devEngines.os` with.
fn os_release() -> Vec<u8> {
    #[cfg(unix)]
    {
        bun_core::ffi::c_field_bytes(&bun_core::ffi::cached_uname().release).to_vec()
    }
    #[cfg(windows)]
    {
        use bun_sys::windows::libuv;
        let mut info: libuv::uv_utsname_s = bun_core::ffi::zeroed();
        // SAFETY: `info` is a valid out-pointer for the duration of the call.
        if unsafe { libuv::uv_os_uname(&mut info) } != 0 {
            return Vec::new();
        }
        bun_core::slice_to_nul(&info.release).to_vec()
    }
}

/// `npm >=10 or pnpm >=9`
struct Alternatives<'a, I: Iterator<Item = &'a Requirement> + Clone>(I);

impl<'a, I: Iterator<Item = &'a Requirement> + Clone> fmt::Display for Alternatives<'a, I> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (i, requirement) in self.0.clone().enumerate() {
            if i > 0 {
                f.write_str(" or ")?;
            }
            write!(f, "{}", BStr::new(&requirement.name))?;
            let version = requirement.version.as_deref().unwrap_or_default();
            if !version.trim_ascii().is_empty() {
                write!(f, " {}", BStr::new(version.trim_ascii()))?;
            }
        }
        Ok(())
    }
}

/// Exits when `devEngines` is malformed or a key whose last `onFail` is `error` is not met, as `npm install` does.
pub fn enforce_dev_engines(
    dev_engines: &dev_engines::Parsed,
    package_json_path: &[u8],
    runtime_is_bun: bool,
) {
    let dev_engines = match dev_engines {
        Ok(dev_engines) => dev_engines,
        Err(invalid) => exit_with_invalid_dev_engines(invalid, package_json_path),
    };

    let mut failed = false;
    for engine in Engine::ALL {
        let all = dev_engines.of(engine);
        let Some(last) = all.last() else {
            continue;
        };
        // Unless `--bun` says so, bun cannot tell which runtime a script starts: it checks the entries that name it.
        let is_ours = |requirement: &&Requirement| {
            engine != Engine::Runtime || runtime_is_bun || *requirement.name == *b"bun"
        };
        let mut ours = all.iter().filter(is_ours).peekable();
        if ours.peek().is_none() {
            continue;
        }

        let running = Running::of(engine);
        if ours.clone().any(|requirement| running.meets(requirement)) {
            continue;
        }
        if last.on_fail == OnFail::Ignore {
            continue;
        }

        let wanted = Alternatives(ours);
        let (kind, role) = match engine {
            Engine::PackageManager => ("", " as its package manager"),
            Engine::Runtime => ("", " as its runtime"),
            Engine::Os => ("the operating system ", ""),
            Engine::Cpu => ("the CPU architecture ", ""),
            Engine::Libc => ("the C library ", ""),
        };
        let mut found: Vec<u8> = match engine {
            // Only Linux has a libc that npm has a name for.
            Engine::Libc if running.name.is_empty() => Engine::Os
                .name_of_this_system()
                .unwrap_or_default()
                .to_vec(),
            _ => running.name.to_vec(),
        };
        if !running.version.is_empty() {
            found.push(b' ');
            found.extend_from_slice(&running.version);
        }
        let (found_prefix, found_suffix) = match engine {
            Engine::PackageManager | Engine::Runtime => ("", " is running"),
            Engine::Os | Engine::Cpu | Engine::Libc => ("this is ", ""),
        };

        macro_rules! report {
            ($level:literal) => {
                bun_core::pretty_errorln!(
                    concat!(
                        $level,
                        "<d>:<r> this project requires {}<b>{}<r>{}, but {}<b>{}<r>{}"
                    ),
                    kind,
                    wanted,
                    role,
                    found_prefix,
                    BStr::new(&found),
                    found_suffix,
                )
            };
        }
        if last.on_fail == OnFail::Warn {
            report!("<r><yellow>warn<r>");
        } else {
            failed = true;
            report!("<r><red>error<r>");
        }
        bun_core::note!(
            "\"devEngines.{}\" in {} sets the requirement",
            engine.key(),
            BStr::new(package_json_path),
        );
        bun_core::output::flush();
    }

    if failed {
        Global::exit(1);
    }
}

fn exit_with_invalid_dev_engines(invalid: &dev_engines::Invalid, package_json_path: &[u8]) -> ! {
    let property = invalid.property.as_str();
    let path = BStr::new(package_json_path);
    match &invalid.problem {
        Problem::NotAnObject => bun_core::pretty_errorln!(
            "<r><red>error<r><d>:<r> \"{}\" in {} must be an object",
            property,
            path,
        ),
        Problem::NotAnObjectOrArrayOfObjects => bun_core::pretty_errorln!(
            "<r><red>error<r><d>:<r> \"{}\" in {} must be an object or an array of objects",
            property,
            path,
        ),
        Problem::MissingName => bun_core::pretty_errorln!(
            "<r><red>error<r><d>:<r> \"{}\" in {} needs a <b>\"name\"<r>",
            property,
            path,
        ),
        Problem::NotAString => bun_core::pretty_errorln!(
            "<r><red>error<r><d>:<r> \"{}\" in {} must be a string",
            property,
            path,
        ),
        Problem::UnknownOnFail(on_fail) => bun_core::pretty_errorln!(
            "<r><red>error<r><d>:<r> \"{}\" in {} must be \"ignore\", \"warn\", \"error\" or \"download\", not <b>\"{}\"<r>",
            property,
            path,
            BStr::new(on_fail),
        ),
    }
    Global::exit(1);
}
