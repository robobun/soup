//! The default answer of `build.resolve()`: what an import of the same path gets when no plugin
//! answers for it. Nothing here writes to the graph or to the log of the build.
//!
//! It runs on the thread of the bundle, because only that thread has the resolvers of the build:
//! one for each graph, made from the options of the build with its log and its environment.
//!
//! The rules and their order are those of `BundleV2::resolve_import_records`, which answers only
//! for an import record of a parsed file: `alias`, the builtins of a build for Bun, the in-memory
//! `files`, then the resolver of the graph that asks. A rule that changes there changes here.
//! "build.resolve() and the import agree" in `test/bundler/bundler_plugin.test.ts` compares the
//! two answers.

use core::cell::OnceCell;
use core::ptr::NonNull;

use bun_ast::{ImportKind, Kind, Log, SideEffects};
use bun_resolve_builtins::HardcodedModule;
use bun_resolver::{self as resolver, Resolver, is_package_path};

use crate::BundleV2;
use crate::bun_fs as Fs;
use crate::options::Target;
use crate::transpiler::Transpiler;

/// One `build.resolve()` call that no plugin answered.
pub struct PluginResolveQuery<'q> {
    pub specifier: &'q [u8],
    /// Absolute, or empty when the caller gave neither a directory nor a file that imports.
    pub resolve_dir: &'q [u8],
    pub kind: ImportKind,
    /// The graph of the request whose callback called `build.resolve()`. `None` when no callback
    /// of a request was on the stack: then the build cannot tell which of its graphs asks.
    pub target: Option<Target>,
}

#[derive(Default)]
pub struct PluginResolveAnswer {
    /// Empty when the path did not resolve. `errors` then says why.
    pub path: Box<[u8]>,
    pub namespace: Box<[u8]>,
    pub external: bool,
    pub side_effects: bool,
    pub errors: Vec<Box<[u8]>>,
    pub warnings: Vec<Box<[u8]>>,
}

impl PluginResolveAnswer {
    fn file(path: &[u8]) -> Self {
        Self {
            path: path.into(),
            namespace: (&b"file"[..]).into(),
            side_effects: true,
            ..Default::default()
        }
    }

    /// The import stays in the output as written.
    fn external(path: &[u8], side_effects: bool) -> Self {
        Self {
            path: path.into(),
            external: true,
            side_effects,
            ..Default::default()
        }
    }

    fn failed(error: impl Into<Box<[u8]>>) -> Self {
        Self {
            errors: vec![error.into()],
            ..Default::default()
        }
    }

    fn found(result: &resolver::Result<'_>, written: &[u8]) -> Self {
        let primary = &result.path_pair.primary;
        let side_effects = result.primary_side_effects_data == SideEffects::HasSideEffects;
        if result.flags.is_external() {
            let rewritten =
                result.flags.external_kind() == resolver::ExternalKind::ExternalRewritePath;
            return Self::external(if rewritten { primary.text } else { written }, side_effects);
        }
        // A path that a "browser" field disables has no other one. The caller gets its name.
        let path = result.path_const().unwrap_or(primary);
        Self {
            path: path.text.into(),
            namespace: match path.namespace {
                b"" => (&b"file"[..]).into(),
                namespace => namespace.into(),
            },
            side_effects,
            ..Default::default()
        }
    }

    fn is_same_module(&self, other: &Self) -> bool {
        self.path == other.path
            && self.namespace == other.namespace
            && self.external == other.external
    }

    /// What the resolver said while it looked. Without this it would be in the log of the build.
    ///
    /// The resolver says it once, when it reads the `package.json` or the `tsconfig.json` that is
    /// wrong, and keeps what it read. So the directory of each such file is read again by whoever
    /// looks there next, and an import of the build gets the message into the log of the build.
    fn take_messages(&mut self, log: &mut Log, resolver: &mut Resolver<'_>) {
        let resolved = !self.path.is_empty();
        for message in log.msgs.drain(..) {
            if let Some(location) = &message.data.location {
                if bun_paths::is_absolute(&location.file) {
                    if let Some(directory) = bun_paths::dirname(&location.file) {
                        resolver.bust_dir_cache(directory);
                    }
                }
            }
            let text: Box<[u8]> = message.data.text.into_owned().into_boxed_slice();
            match message.kind {
                // `errors` is why there is no path. For a path that was found it is empty.
                Kind::Err if !resolved => self.errors.push(text),
                Kind::Err | Kind::Warn => self.warnings.push(text),
                Kind::Note | Kind::Debug | Kind::Verbose => {}
            }
        }
    }
}

/// The text that an import of `specifier` that does not resolve has in the log of the build.
fn could_not_resolve(
    specifier: &[u8],
    original: Option<&[u8]>,
    kind: ImportKind,
    target: Target,
) -> Box<[u8]> {
    use std::io::Write as _;
    let name = bstr::BStr::new(specifier);
    let import = bstr::BStr::new(kind.error_label());
    let mut text = Vec::new();
    let _ = if let Some(original) = original {
        let original = bstr::BStr::new(original);
        write!(
            text,
            "Could not resolve: \"{name}\" (originally \"{original}\")"
        )
    } else if !is_package_path(specifier) {
        write!(text, "Could not resolve: \"{name}\"")
    } else if target == Target::Browser && crate::options::is_node_builtin(specifier) {
        write!(
            text,
            "Browser build cannot {import} Node.js builtin: \"{name}\". To use Node.js builtins, set target to 'node' or 'bun'"
        )
    } else if !target.is_bun() && (specifier == b"bun" || specifier.starts_with(b"bun:")) {
        write!(
            text,
            "Browser build cannot {import} Bun builtin: \"{name}\". When bundling for Bun, set target to 'bun'"
        )
    } else {
        write!(
            text,
            "Could not resolve: \"{name}\". Maybe you need to \"bun install\"?"
        )
    };
    text.into_boxed_slice()
}

fn with_trailing_separator(directory: &[u8]) -> Vec<u8> {
    let mut directory = directory.to_vec();
    if !directory
        .last()
        .is_some_and(|&last| bun_paths::is_sep_any(last))
    {
        // A directory that is written with `/` keeps it: the keys of `files` can be, on Windows.
        let written_with_slash = bun_core::strings::contains_char(&directory, b'/');
        directory.push(if written_with_slash {
            b'/'
        } else {
            bun_paths::SEP
        });
    }
    directory
}

impl<'a> BundleV2<'a> {
    /// Runs on the thread of the bundle, between two of its tasks.
    pub fn resolve_for_plugin(&mut self, query: &PluginResolveQuery<'_>) -> PluginResolveAnswer {
        self.thread_lock.assert_locked();

        // The resolver reads a directory once per build, and this makes it read some before an
        // import would have. A file that a plugin writes into one of them later is not in what
        // was read, so from here on an import that does not resolve gets a second look.
        self.recheck_unresolved_imports = true;

        if let Some(target) = query.target {
            return self.resolve_for_plugin_in_graph(query, target);
        }

        // An import is resolved for the graph that its file is in. Which graph a file is in is
        // not a question that its path answers: a file can be in two, the one of a server and the
        // one of its pages. So a call that no request stands for gets an answer only where every
        // graph of the build gives the same one.
        let mut answer: Option<PluginResolveAnswer> = None;
        for target in self.targets_with_a_resolver() {
            let in_graph = self.resolve_for_plugin_in_graph(query, target);
            match &answer {
                None => answer = Some(in_graph),
                Some(first) if first.is_same_module(&in_graph) => {}
                Some(_) => {
                    let mut text = b"build.resolve() cannot tell which graph asks for \"".to_vec();
                    text.extend_from_slice(query.specifier);
                    text.extend_from_slice(
                        b"\": this build has more than one (a server and its pages), and the path is not the same module in each. Call build.resolve() in an onResolve() or onLoad() callback before the first await of that callback",
                    );
                    return PluginResolveAnswer::failed(text);
                }
            }
        }
        answer.expect("a build has a graph")
    }

    /// The targets that `transpiler_for_target` has a resolver of its own for, at this moment.
    fn targets_with_a_resolver(&self) -> Vec<Target> {
        let main = self.transpiler.options.target;
        let mut targets = vec![main];
        if self.client_transpiler.is_some() && main != Target::Browser {
            targets.push(Target::Browser);
        }
        if !core::ptr::eq(
            self.ssr_transpiler.cast_const(),
            &raw const *self.transpiler,
        ) {
            targets.push(Target::ServerComponentsSsr);
        }
        targets
    }

    fn resolve_for_plugin_in_graph(
        &mut self,
        query: &PluginResolveQuery<'_>,
        target: Target,
    ) -> PluginResolveAnswer {
        let top_level_dir = Fs::FileSystem::get().top_level_dir();
        // The resolver opens the directory, and a path with a NUL in it is not one.
        let has_directory = !query.resolve_dir.is_empty()
            && !bun_core::strings::contains_char(query.resolve_dir, 0);
        if query.kind.is_entry_point()
            && bun_paths::string_paths::without_trailing_slash(query.resolve_dir)
                == bun_paths::string_paths::without_trailing_slash(top_level_dir)
        {
            return self.resolve_entry_point_for_plugin(query.specifier, target);
        }

        let aliased = if self.transpiler.options.alias.is_empty() {
            None
        } else {
            self.alias_substitute(query.specifier)
        };
        let specifier: &[u8] = aliased.unwrap_or(query.specifier);

        if target.is_bun() {
            let cfg = HardcodedModule::Cfg {
                rewrite_jest_for_tests: self.transpiler.options.rewrite_jest_for_tests,
            };
            if let Some(builtin) = HardcodedModule::Alias::get(specifier, Target::Bun, cfg) {
                let path = builtin.path.as_bytes();
                let path = if builtin.node_builtin && !builtin.node_only_prefix {
                    &path[5..]
                } else {
                    path
                };
                return PluginResolveAnswer::external(path, false);
            }
            if specifier.starts_with(b"bun:") {
                let path = HardcodedModule::Alias::bun_prefixed_builtin(specifier);
                return PluginResolveAnswer::external(path.unwrap_or(specifier), false);
            }
        }

        // Without a directory there is an answer for what needs none: a name that stays an
        // import, a URL, an absolute path, a key of `files`. The resolver is asked from the
        // working directory, and a file that it finds from there is not an answer.
        let needs_directory = aliased.is_none() && !has_directory;
        let no_directory = || {
            let mut text = b"Could not resolve: \"".to_vec();
            text.extend_from_slice(specifier);
            text.extend_from_slice(
                b"\". build.resolve() has no directory to look from: pass \"resolveDir\", or an \"importer\" in the \"file\" namespace",
            );
            PluginResolveAnswer::failed(text)
        };

        // An alias is looked up from the working directory, whoever imports it.
        let (source_dir, importer): (Vec<u8>, Vec<u8>) = match aliased {
            Some(_) => {
                let (directory, file) = self.alias_base();
                (with_trailing_separator(directory), file.to_vec())
            }
            None => {
                // The rules that ask for the importing file get one in the directory.
                let source_dir = with_trailing_separator(if has_directory {
                    query.resolve_dir
                } else {
                    top_level_dir
                });
                let importer = [&source_dir[..], b"build.resolve"].concat();
                (source_dir, importer)
            }
        };

        if let Some(files) = self.file_map {
            if needs_directory {
                if files.contains(specifier) {
                    return PluginResolveAnswer::file(specifier);
                }
            } else if let Some(found) = files.resolve(self.arena(), &importer, specifier) {
                return PluginResolveAnswer::file(found.path_pair.primary.text);
            }
        }
        if needs_directory && (specifier.starts_with(b"./") || specifier.starts_with(b"../")) {
            return no_directory();
        }

        let transpiler: *mut Transpiler<'a> = self.transpiler_for_target(target);
        let mut unread_log = Log::init();
        // SAFETY: the transpiler lives as long as the bundle, and `unread_log` outlives the guard.
        let resolver = unsafe { &mut (*transpiler).resolver };
        // SAFETY: as above.
        let log_scope =
            unsafe { Resolver::scoped_log(&raw mut *resolver, NonNull::from(&mut unread_log)) };
        let mut rechecked = false;
        let mut answer = loop {
            match resolver.resolve_with_framework(&source_dir, specifier, query.kind) {
                Ok(result) => {
                    let found = PluginResolveAnswer::found(&result, specifier);
                    let from_directory = !found.external
                        && &*found.namespace == b"file"
                        && !bun_paths::is_absolute_loose(specifier);
                    break if needs_directory && from_directory {
                        no_directory()
                    } else {
                        found
                    };
                }
                // The same second look: the plugin can have written the file since the directory was read.
                Err(resolver::Error::ModuleNotFound)
                    if !rechecked
                        && !needs_directory
                        && resolver.bust_dir_cache_from_specifier(&importer, specifier) =>
                {
                    rechecked = true;
                }
                Err(resolver::Error::ModuleNotFound) if needs_directory => break no_directory(),
                Err(resolver::Error::ModuleNotFound) => {
                    let original = aliased.map(|_| query.specifier);
                    break PluginResolveAnswer::failed(could_not_resolve(
                        specifier, original, query.kind, target,
                    ));
                }
                Err(resolver::Error::InvalidDataURL) => {
                    let mut text = b"Could not resolve data URL: \"".to_vec();
                    text.extend_from_slice(specifier);
                    text.push(b'"');
                    break PluginResolveAnswer::failed(text);
                }
                // The resolver has said what is wrong, into `unread_log`.
                Err(_) => break PluginResolveAnswer::default(),
            }
        };
        drop(log_scope);
        answer.take_messages(&mut unread_log, resolver);
        if answer.path.is_empty() && answer.errors.is_empty() {
            answer
                .errors
                .push(could_not_resolve(specifier, None, query.kind, target));
        }
        answer
    }

    /// `entrypoints` are looked up from the working directory, and `a.js` also as `./a.js`.
    /// Plugins are told the entry as it is written, so a plugin that passes it on needs the same.
    fn resolve_entry_point_for_plugin(
        &mut self,
        entry_point: &[u8],
        target: Target,
    ) -> PluginResolveAnswer {
        if let Some(files) = self.file_map {
            if let Some(found) = files.resolve(self.arena(), b"", entry_point) {
                return PluginResolveAnswer::file(found.path_pair.primary.text);
            }
        }

        let transpiler: *mut Transpiler<'a> = self.transpiler_for_target(target);
        let mut unread_log = Log::init();
        // SAFETY: the transpiler lives as long as the bundle, and `unread_log` outlives the guard.
        let transpiler = unsafe { &mut *transpiler };
        // SAFETY: as above.
        let log_scope = unsafe {
            Resolver::scoped_log(&raw mut transpiler.resolver, NonNull::from(&mut unread_log))
        };
        let dot_slash = OnceCell::new();
        let mut answer = match transpiler.resolve_entry_point_past_cache(entry_point, &dot_slash) {
            Ok(result) => PluginResolveAnswer::found(&result, entry_point),
            // The text that the build has for an entry point that is not there.
            Err(error) => PluginResolveAnswer::failed(
                format!(
                    "{} resolving \"{}\" (entry point)",
                    error,
                    bstr::BStr::new(entry_point)
                )
                .into_bytes(),
            ),
        };
        drop(log_scope);
        answer.take_messages(&mut unread_log, &mut transpiler.resolver);
        answer
    }
}
