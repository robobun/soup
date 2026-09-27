//! `collectCoverageFrom` / `--collect-coverage-from`: the list of globs that
//! says which files the coverage report of `bun test` is about.
//!
//! Without the list the report is about the files the tests loaded. With it,
//! a loaded file the list does not name leaves the report, and a file the list
//! names that nothing loaded enters it with none of its lines run. Both happen
//! in [`complete`], once per run, in the process that prints the report: after
//! the tests, and under `--parallel` after the reports of the workers are
//! merged. Workers do not know of the list.
//!
//! A file that nothing loaded is not loaded here either. It is transpiled the
//! way a load transpiles it, and its lines and functions are read from the
//! result, so code in it never runs and a macro in it is an error.

use core::mem::ManuallyDrop;
use core::ptr;
use std::io::Write as _;

use bun_alloc::Arena;
use bun_ast::{ASTMemoryAllocator, ExportsKind, Loader};
use bun_bundler::options::ModuleType;
use bun_bundler::transpiler::{self, AlreadyBundled, ParseOptions, Transpiler};
use bun_core::{Output, strings};
use bun_glob::BunGlobWalker;
use bun_js_printer::{self as js_printer, BufferPrinter, BufferWriter};
use bun_jsc::saved_source_map::SavedSourceMap;
use bun_jsc::virtual_machine::VirtualMachine;
use bun_options_types::code_coverage_options::CodeCoverageOptions;
use bun_paths::resolve_path;
use bun_resolver::fs::FileSystem;
use bun_sourcemap_jsc::code_coverage::{NeverExecutedPass, Report, SourceKind, Unreadable};
use bun_sys::{Fd, FdExt as _};

use crate::test_command::{coverage, has_test_file_name};

/// What [`complete`] has to know of the run.
pub(crate) struct Run {
    /// The project root before the first test file ran. A test can
    /// `process.chdir()`, and the patterns must keep their meaning.
    root: Box<[u8]>,
    never_loaded: bool,
}

impl Run {
    /// Call before the first test file runs. `None`: there is no list.
    ///
    /// `test_files` is the number of test files the run is about to hand out
    /// and `subset` says that something other than the user's filters chose
    /// them (`--changed`). Files that nothing loaded are added only to a run
    /// that runs tests and could have run all of them: an empty `--shard`
    /// loads nothing and still has to pass a `coverageThreshold`.
    pub(crate) fn capture(
        opts: &CodeCoverageOptions,
        test_files: usize,
        subset: bool,
    ) -> Option<Run> {
        if !opts.enabled || opts.collect_from.is_empty() {
            return None;
        }
        Some(Run {
            root: Box::from(FileSystem::get().top_level_dir),
            never_loaded: test_files > 0 && !subset,
        })
    }

    /// The run ended before every test file had run, so a file can be missing
    /// from the reports although a test loads it.
    pub(crate) fn ended_early(&mut self) {
        self.never_loaded = false;
    }

    /// Whether [`complete`] can add a report to none.
    pub(crate) fn adds_files(&self) -> bool {
        self.never_loaded
    }

    /// What the patterns, and the paths in the report, are relative to.
    pub(crate) fn root(&self) -> &[u8] {
        &self.root
    }
}

#[derive(PartialEq, Eq)]
pub(crate) enum Completed {
    Yes,
    /// `interrupted` said so between two files. The reports are incomplete.
    Interrupted,
}

/// Makes `reports` the reports of the files `opts.collect_from` names, sorted
/// by path.
pub(crate) fn complete(
    run: &Run,
    vm: &mut VirtualMachine,
    opts: &CodeCoverageOptions,
    reports: &mut Vec<Report<'static>>,
    interrupted: &dyn Fn() -> bool,
) -> Completed {
    let patterns = Patterns::new(&opts.collect_from);
    let root: &[u8] = &run.root;

    reports.retain(|report| patterns.matches(resolve_path::relative(root, &report.source_url)));

    if run.never_loaded {
        // Written the way the report is, which comes next and is not buffered.
        let mut warnings: Vec<u8> = Vec::new();
        let colors = Output::enable_ansi_colors_stderr();

        let files = never_loaded_files(vm, opts, &patterns, root, reports, &mut warnings);
        if !files.is_empty() {
            let pass = NeverExecutedPass::begin();
            let mut printer = BufferPrinter::init(BufferWriter::init());
            for file in &files {
                if interrupted() {
                    return Completed::Interrupted;
                }
                match report_of(&pass, vm, opts, file, &mut printer) {
                    Ok(Some(report)) => reports.push(report),
                    Ok(None) => {}
                    Err(failure) => {
                        let _ = bun_core::write_pretty!(
                            &mut warnings,
                            colors,
                            "<r><yellow>warn<r><d>:<r> Failed to collect coverage from {}{}\n",
                            bstr::BStr::new(resolve_path::relative(root, file.path.text)),
                            failure,
                        );
                    }
                }
            }
        }
        if reports.is_empty() {
            let _ = bun_core::write_pretty!(
                &mut warnings,
                colors,
                "<r><yellow>warn<r><d>:<r> No file matches collectCoverageFrom\n",
            );
        }
        if !warnings.is_empty() {
            // A closed stderr is not a reason to fail the run.
            let _ = Output::error_writer().write_all(&warnings);
        }
    }

    reports.sort_unstable_by(|a, b| a.source_url.cmp(&b.source_url));
    Completed::Yes
}

/// `collectCoverageFrom` as given, less what Jest allows in front of a
/// pattern and a path relative to the root does not have: `./` and
/// `<rootDir>/`.
struct Patterns {
    patterns: Vec<Box<[u8]>>,
    negated: usize,
}

impl Patterns {
    fn new(list: &[Box<[u8]>]) -> Patterns {
        let mut negated = 0;
        let patterns = list
            .iter()
            .map(|pattern| {
                let (bangs, glob) = split_negation(pattern);
                negated += bangs.len() % 2;
                let glob = glob.strip_prefix(b"<rootDir>/").unwrap_or(glob);
                let glob = glob.strip_prefix(b"./").unwrap_or(glob);
                [bangs, glob].concat().into_boxed_slice()
            })
            .collect();
        Patterns { patterns, negated }
    }

    /// Jest's rule: the patterns are asked in order and the last one that has
    /// a say decides. A pattern has a say on the paths it matches, a negated
    /// one on the paths it rejects. A list of negated patterns is about every
    /// path none of them rejects. A path outside the root is in no list: `*`
    /// would match its `..`.
    fn matches(&self, relative_path: &[u8]) -> bool {
        if bun_paths::is_absolute(relative_path)
            || relative_path == b".."
            || relative_path.starts_with(b"../")
            || relative_path.starts_with(b"..\\")
        {
            return false;
        }
        let mut kept: Option<bool> = None;
        for pattern in &self.patterns {
            let result = bun_glob::r#match(pattern, relative_path);
            if result.is_negated() {
                if !result.matches() {
                    kept = Some(false);
                }
            } else if result.matches() {
                kept = Some(true);
            }
        }
        if self.negated == self.patterns.len() {
            kept != Some(false)
        } else {
            kept == Some(true)
        }
    }

    /// The directories, relative to the root, below which a file the list
    /// names can be: what a pattern has in front of its first component with
    /// a glob in it. None of them is below another.
    fn directories(&self) -> Vec<&[u8]> {
        if self.negated == self.patterns.len() {
            return vec![b""];
        }
        let mut directories: Vec<&[u8]> = self
            .patterns
            .iter()
            .filter_map(|pattern| {
                let (bangs, glob) = split_negation(pattern);
                (bangs.len() % 2 == 0).then(|| literal_directory(glob))
            })
            .collect();
        directories.sort_unstable();
        directories.dedup_by(|next, kept| {
            kept.is_empty()
                || (next.starts_with(kept) && next.get(kept.len()).is_none_or(|&c| c == b'/'))
        });
        directories
    }
}

fn split_negation(pattern: &[u8]) -> (&[u8], &[u8]) {
    let bangs = pattern.iter().take_while(|&&byte| byte == b'!').count();
    pattern.split_at(bangs)
}

/// `src/utils` of `src/utils/*.ts` and of `src/utils/a.ts`, nothing of
/// `{src,lib}/**`.
fn literal_directory(glob: &[u8]) -> &[u8] {
    let mut end = 0;
    let mut rest = glob;
    while let Some(slash) = strings::index_of_char_usize(rest, b'/') {
        if strings::index_of_any(&rest[..slash], b"*?[]{}!\\").is_some() {
            break;
        }
        end = glob.len() - rest.len() + slash;
        rest = &rest[slash + 1..];
    }
    &glob[..end]
}

/// A file the list names that is in no report.
struct NeverLoaded {
    path: bun_paths::fs::Path<'static>,
    loader: Loader,
    module_type: ModuleType,
}

fn is_not_entered(directory_name: &[u8]) -> bool {
    directory_name == b"node_modules" || directory_name == b".git"
}

/// What a file is whatever path leads to it.
fn identity_of(path: &[u8]) -> Option<(u64, u64)> {
    if path.len() >= bun_paths::MAX_PATH_BYTES {
        return None;
    }
    let mut buf = bun_paths::path_buffer_pool::get();
    let stat = bun_sys::stat(resolve_path::z(path, &mut buf)).ok()?;
    Some((stat.st_dev as u64, stat.st_ino as u64))
}

fn never_loaded_files(
    vm: &mut VirtualMachine,
    opts: &CodeCoverageOptions,
    patterns: &Patterns,
    root: &[u8],
    reports: &[Report<'static>],
    warnings: &mut Vec<u8>,
) -> Vec<NeverLoaded> {
    let colors = Output::enable_ansi_colors_stderr();
    let mut warn = |what: &[u8], err: &dyn core::fmt::Display| {
        let _ = bun_core::write_pretty!(
            warnings,
            colors,
            "<r><yellow>warn<r><d>:<r> Failed to look for files to cover in {}: {}\n",
            bstr::BStr::new(what),
            err,
        );
    };

    let mut found: Vec<Box<[u8]>> = Vec::new();
    for directory in patterns.directories() {
        if directory == b".." || directory.starts_with(b"../") {
            continue;
        }
        let mut joined = bun_paths::path_buffer_pool::get();
        let below = resolve_path::join_abs_string_buf::<bun_paths::platform::Auto>(
            root,
            &mut joined[..],
            &[directory],
        );
        let walker = BunGlobWalker::init_with_cwd(
            b"**/*",
            below,
            true,
            true,
            false,
            false,
            true,
            Some(is_not_entered),
        );
        let Ok(Ok(mut walker)) = walker else {
            continue;
        };
        let mut files = bun_glob::walk::Iterator::new(&mut walker);
        match files.init() {
            Ok(Ok(())) => {}
            // The list can name a directory that is not there.
            Ok(Err(err)) if err.get_errno() == bun_sys::E::ENOENT => continue,
            Ok(Err(err)) => {
                warn(below, &err);
                continue;
            }
            Err(_) => continue,
        }
        // A directory that cannot be read does not end the walk. One that
        // fails over and over does.
        let mut failures = 0;
        while failures < 64 {
            match files.next() {
                Ok(Ok(Some(path))) => found.push(path),
                Ok(Ok(None)) => break,
                Ok(Err(err)) => {
                    failures += 1;
                    warn(&err.path, &err);
                }
                Err(_) => break,
            }
        }
    }
    // A directory is read in no order, and the warnings come in this one.
    found.sort_unstable();
    found.dedup();

    // A file can have more than one path, through a link or in another case.
    let mut seen: bun_collections::HashMap<(u64, u64), ()> = Default::default();
    for report in reports {
        if let Some(identity) = identity_of(&report.source_url) {
            seen.insert(identity, ());
        }
    }

    let mut files: Vec<NeverLoaded> = Vec::new();
    for path in &found {
        let path: &[u8] = path;
        let extension = bun_paths::extension(path);
        let loader = vm.transpiler.options.loader(extension);
        if !loader.is_javascript_like()
            || is_declaration_file(path)
            || (opts.skip_test_files && has_test_file_name(path))
            || coverage::is_ignored(opts, root, path)
            || !patterns.matches(resolve_path::relative(root, path))
        {
            continue;
        }
        let Some(identity) = identity_of(path) else {
            continue;
        };
        if seen.insert(identity, ()).is_some() {
            continue;
        }
        let module_type = match extension {
            b".cjs" | b".cts" => ModuleType::Cjs,
            b".mjs" | b".mts" => ModuleType::Esm,
            _ => vm
                .transpiler
                .resolver
                .read_dir_info_ignore_error(bun_paths::dirname(path).unwrap_or(root))
                .and_then(|directory| {
                    directory
                        .package_json()
                        .or(directory.enclosing_package_json)
                })
                .map_or(ModuleType::Unknown, |package_json| package_json.module_type),
        };
        files.push(NeverLoaded {
            path: bun_paths::fs::Path::init(bun_core::handle_oom(
                bun_resolver::fs::FilenameStore::instance().append_slice(path),
            )),
            loader,
            module_type,
        });
    }
    files
}

/// `.d.ts`, `.d.mts`, `.d.cts`: declarations for the type checker.
fn is_declaration_file(path: &[u8]) -> bool {
    let extension = bun_paths::extension(path);
    matches!(extension, b".ts" | b".mts" | b".cts")
        && path[..path.len() - extension.len()].ends_with(b".d")
}

/// Whether the file has no statement: types, comments, directives, the
/// `export {}` that makes a file of types a module.
fn has_nothing_to_run(ast: &bun_ast::Ast) -> bool {
    use bun_ast::StmtData;
    ast.parts.iter().all(|part| {
        part.stmts.iter().all(|stmt| match &stmt.data {
            StmtData::SExportClause(clause) => clause.items.is_empty(),
            StmtData::SEmpty(_)
            | StmtData::STypeScript(_)
            | StmtData::SComment(_)
            | StmtData::SDirective(_) => true,
            _ => false,
        })
    })
}

/// Why a file the list names has no report.
struct Failure {
    /// Line and column of the error in the file.
    at: Option<(i32, i32)>,
    text: Vec<u8>,
}

impl Failure {
    fn new(text: &[u8]) -> Failure {
        Failure {
            at: None,
            text: text.to_vec(),
        }
    }

    fn first_error_of(log: &bun_ast::Log) -> Failure {
        let Some(message) = log
            .msgs
            .iter()
            .find(|message| message.kind == bun_ast::Kind::Err)
        else {
            return Failure::new(b"it does not parse");
        };
        Failure {
            at: message
                .data
                .location
                .as_ref()
                .filter(|location| location.line > 0)
                .map(|location| (location.line, location.column)),
            text: message.data.text.to_vec(),
        }
    }
}

impl core::fmt::Display for Failure {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        if let Some((line, column)) = self.at {
            write!(f, ":{line}:{column}")?;
        }
        write!(f, ": {}", bstr::BStr::new(&self.text))
    }
}

/// The report of `file`, or why there is none. `Ok(None)`: the file has
/// nothing that can run, or a comment in it says to leave it out.
fn report_of(
    pass: &NeverExecutedPass,
    vm: &mut VirtualMachine,
    opts: &CodeCoverageOptions,
    file: &NeverLoaded,
    printer: &mut BufferPrinter,
) -> Result<Option<Report<'static>>, Failure> {
    let arena = Arena::new();
    let mut ast_memory_store = ASTMemoryAllocator::borrowing(&arena);
    let _ast_scope = ast_memory_store.enter();
    let mut log = bun_ast::Log::init();

    // A copy, as `TranspilerJob::run` makes one: the log, the arena and the
    // macro switch of the transpiler that loads modules stay as they are.
    // SAFETY: every pointer in the copy targets memory that `vm.transpiler`
    // owns and that outlives this call. `ManuallyDrop`: the copy owns nothing.
    let mut transpiler_storage = ManuallyDrop::new(unsafe { ptr::read(&raw const vm.transpiler) });
    // SAFETY: the lifetime of `Transpiler` is that of its arena, which is
    // replaced below by one that is declared before the copy.
    let transpiler: &mut Transpiler<'_> =
        unsafe { &mut *(&raw mut *transpiler_storage).cast::<Transpiler<'_>>() };
    transpiler.set_arena(&arena);
    transpiler.set_log(&raw mut log);
    transpiler.options.no_macros = true;
    transpiler.macro_context = None;
    // `parse` makes a macro context for the copy, which nothing else frees.
    let _macro_context = scopeguard::guard(&raw mut transpiler.macro_context, |slot| {
        // SAFETY: `slot` is in `transpiler_storage`, declared before this
        // guard, and no borrow of it is live when the guard runs.
        if let Some(context) = unsafe { (*slot).take() } {
            context.deinit();
        }
    });

    let mut input_file_fd = Fd::INVALID;
    let parse_options = ParseOptions {
        arena: &arena,
        path: file.path,
        loader: file.loader,
        dirname_fd: Fd::INVALID,
        file_descriptor: None,
        file_fd_ptr: Some(&mut input_file_fd),
        macro_remappings: Default::default(),
        macro_js_ctx: transpiler::default_macro_js_value(),
        jsx: transpiler.options.jsx.clone(),
        emit_decorator_metadata: transpiler.options.emit_decorator_metadata,
        experimental_decorators: transpiler.options.experimental_decorators,
        use_define_for_class_fields: transpiler.options.use_define_for_class_fields,
        virtual_source: None,
        replace_exports: Default::default(),
        dont_bundle_twice: true,
        allow_commonjs: true,
        inject_jest_globals: transpiler.options.rewrite_jest_for_tests,
        set_breakpoint_on_first_line: false,
        runtime_transpiler_cache: None,
        remove_cjs_module_wrapper: false,
        module_type: file.module_type,
        keep_json_and_toml_as_one_statement: false,
        allow_bytecode_cache: false,
    };
    let parsed = transpiler
        .parse_maybe_return_file_only_allow_shared_buffer::<false, false>(parse_options, None);
    if input_file_fd.is_valid() {
        input_file_fd.close();
    }
    let parsed = match parsed {
        Some(parsed) if log.errors == 0 => parsed,
        _ => return Err(Failure::first_error_of(&log)),
    };
    if parsed.empty || !parsed.loader.is_javascript_like() {
        return Ok(None);
    }
    if matches!(parsed.already_bundled, AlreadyBundled::None) && has_nothing_to_run(&parsed.ast) {
        return Ok(None);
    }

    let hints = if opts.ignore_sourcemap {
        None
    } else {
        bun_core::handle_oom(coverage::ignore_hints::scan(&parsed.source.contents))
    };
    let ignored_lines = match &hints {
        Some(coverage::IgnoreHints::File) => return Ok(None),
        Some(coverage::IgnoreHints::Lines(lines)) => Some(lines),
        None => None,
    };
    let unreadable = |why| match why {
        Unreadable::DoesNotParse => Failure::new(b"JavaScriptCore cannot parse it"),
        Unreadable::NestedTooDeeply => {
            Failure::new(b"an array or object literal in it is nested too deeply")
        }
    };

    // `// @bun`: the file is the text a load hands to JavaScriptCore.
    if !matches!(parsed.already_bundled, AlreadyBundled::None) {
        return Report::never_executed(
            pass,
            file.path.text,
            &parsed.source.contents,
            None,
            if parsed.already_bundled.is_common_js() {
                SourceKind::CommonJs
            } else {
                SourceKind::Module
            },
            opts.ignore_sourcemap,
            ignored_lines,
        )
        .map_err(unreadable);
    }

    let kind =
        if parsed.ast.has_commonjs_export_names || parsed.ast.exports_kind == ExportsKind::Cjs {
            SourceKind::CommonJs
        } else {
            SourceKind::Module
        };
    // The source map stays with this file. The one map the module loader
    // keeps per path is for the text that is loaded, and this one is not.
    let mut source_maps = SavedSourceMap::default();
    printer.ctx.reset();
    if let Err(err) = transpiler.print_with_source_map(
        &arena,
        parsed,
        printer,
        js_printer::Format::EsmAscii,
        js_printer::SourceMapHandler::for_(&mut source_maps),
        None,
    ) {
        return Err(Failure::new(err.name().as_bytes()));
    }
    let source_map = source_maps.get(file.path.text);
    Report::never_executed(
        pass,
        file.path.text,
        printer.ctx.get_written(),
        source_map.as_deref(),
        kind,
        opts.ignore_sourcemap,
        ignored_lines,
    )
    .map_err(unreadable)
}
