//! The `"devEngines"` field of package.json, parsed here because `bun install` and the resolver each read the file.

use bun_ast::Expr;

use crate::{Architecture, Libc, OperatingSystem};

/// The keys of `devEngines`, in the order they are checked and reported.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Engine {
    PackageManager,
    Runtime,
    Os,
    Cpu,
    Libc,
}

impl Engine {
    pub const ALL: [Engine; 5] = [
        Engine::PackageManager,
        Engine::Runtime,
        Engine::Os,
        Engine::Cpu,
        Engine::Libc,
    ];

    pub const fn key(self) -> &'static str {
        match self {
            Engine::PackageManager => "packageManager",
            Engine::Runtime => "runtime",
            Engine::Os => "os",
            Engine::Cpu => "cpu",
            Engine::Libc => "libc",
        }
    }

    /// `process.platform`, `process.arch`, or the libc of Linux. `None` for the two engines that bun itself is.
    pub fn name_of_this_system(self) -> Option<&'static [u8]> {
        fn name_of<Int: Copy + PartialEq>(
            names: &'static [(&'static [u8], Int)],
            current: Int,
        ) -> Option<&'static [u8]> {
            names
                .iter()
                .find(|(_, bit)| *bit == current)
                .map(|(name, _)| *name)
        }
        match self {
            Engine::PackageManager | Engine::Runtime => None,
            Engine::Os => name_of(OperatingSystem::NAME_MAP_KVS, OperatingSystem::CURRENT.0),
            Engine::Cpu => name_of(Architecture::NAME_MAP_KVS, Architecture::CURRENT.0),
            Engine::Libc => Libc::CURRENT.single_name(),
        }
    }
}

/// What happens when no requirement of an engine is met.
#[derive(Clone, Copy, PartialEq, Eq, Default)]
pub enum OnFail {
    Ignore,
    Warn,
    #[default]
    Error,
    /// npm reads it as `error`, and so does bun.
    Download,
}

impl OnFail {
    fn from_name(name: &[u8]) -> Option<OnFail> {
        match name {
            b"ignore" => Some(OnFail::Ignore),
            b"warn" => Some(OnFail::Warn),
            b"error" => Some(OnFail::Error),
            b"download" => Some(OnFail::Download),
            _ => None,
        }
    }
}

/// One `{ "name": ..., "version": ..., "onFail": ... }`.
pub struct Requirement {
    pub name: Box<[u8]>,
    /// A semver range, or a version to compare as text.
    pub version: Option<Box<[u8]>>,
    pub on_fail: OnFail,
}

/// A `devEngines` that has the shape npm accepts.
#[derive(Default)]
pub struct DevEngines {
    /// By `Engine as usize`. One requirement that is met is enough.
    requirements: [Vec<Requirement>; Engine::ALL.len()],
}

/// The resolver keeps the error of a malformed field until a script of the file runs.
pub type Parsed = Result<DevEngines, Invalid>;

/// A `devEngines` that npm rejects too.
pub struct Invalid {
    /// `devEngines.runtime.onFail`
    pub property: String,
    pub problem: Problem,
}

pub enum Problem {
    NotAnObject,
    NotAnObjectOrArrayOfObjects,
    MissingName,
    NotAString,
    UnknownOnFail(Box<[u8]>),
}

impl DevEngines {
    pub fn of(&self, engine: Engine) -> &[Requirement] {
        &self.requirements[engine as usize]
    }

    /// Keys other than the five of `Engine` are skipped, where npm throws: a newer package.json still installs.
    pub fn parse(dev_engines: &Expr) -> Parsed {
        if !dev_engines.is_object() {
            return Err(Invalid {
                property: "devEngines".into(),
                problem: Problem::NotAnObject,
            });
        }

        let bump = bun_alloc::Arena::new();
        let mut this = DevEngines::default();
        for engine in Engine::ALL {
            let Some(value) = dev_engines.get(engine.key().as_bytes()) else {
                continue;
            };
            let property = || format!("devEngines.{}", engine.key());
            let requirements = &mut this.requirements[engine as usize];
            if value.is_object() {
                requirements.push(Requirement::parse(&value, &property(), &bump)?);
            } else if value.is_array() {
                // `as_array` is `None` for `[]`, which requires nothing.
                if let Some(mut items) = value.as_array() {
                    while let Some(item) = items.next() {
                        if !item.is_object() {
                            return Err(Invalid {
                                property: property(),
                                problem: Problem::NotAnObjectOrArrayOfObjects,
                            });
                        }
                        requirements.push(Requirement::parse(&item, &property(), &bump)?);
                    }
                }
            } else {
                return Err(Invalid {
                    property: property(),
                    problem: Problem::NotAnObjectOrArrayOfObjects,
                });
            }
        }
        Ok(this)
    }
}

impl Requirement {
    fn parse(requirement: &Expr, property: &str, bump: &bun_alloc::Arena) -> Result<Self, Invalid> {
        let string = |key: &str| -> Result<Option<Box<[u8]>>, Invalid> {
            let Some(value) = requirement.get(key.as_bytes()) else {
                return Ok(None);
            };
            match value.as_string(bump) {
                Some(text) => Ok(Some(Box::from(text))),
                None => Err(Invalid {
                    property: format!("{property}.{key}"),
                    problem: Problem::NotAString,
                }),
            }
        };

        let Some(name) = string("name")? else {
            return Err(Invalid {
                property: property.into(),
                problem: Problem::MissingName,
            });
        };
        let version = string("version")?;
        let on_fail = match string("onFail")? {
            None => OnFail::default(),
            Some(on_fail) => OnFail::from_name(&on_fail).ok_or_else(|| Invalid {
                property: format!("{property}.onFail"),
                problem: Problem::UnknownOnFail(on_fail),
            })?,
        };
        Ok(Requirement {
            name,
            version,
            on_fail,
        })
    }
}
