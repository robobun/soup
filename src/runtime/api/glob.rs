use std::sync::Arc;

use bun_glob::BunGlobWalker as GlobWalker;
use bun_glob::walk;
use bun_glob::{IgnoreList, PatternList};
use bun_jsc::bindgen::{self, IntoError, JsHeap, JsLocal, JsScope};
use bun_jsc::bun_string_jsc;
use bun_jsc::{
    JSGlobalObject, JSPromiseStrong, JSValue, Job, JobContext, JsResult, JsThread, SysErrorJsc as _,
};
use bun_paths::MAX_PATH_BYTES;
use bun_sys as syscall;

use crate::generated_bindgen::glob::{GlobScanArgument, GlobScanIgnore, GlobScanOptions};

/// `Bun.Glob`, declared in `Glob.bind.ts`.
pub(crate) enum Glob {
    One {
        /// An ASCII pattern is the JavaScript string's own buffer, not a copy.
        pattern: bun_core::Utf8Bytes<'static>,
        shape: bun_glob::matcher::Shape,
    },
    /// An array of patterns.
    Many(Box<PatternList>),
}

// With it, the object of a `Glob` is 80 bytes. A list is behind a pointer so that it stays so.
#[cfg(target_pointer_width = "64")]
const _: () = assert!(size_of::<Glob>() == 56);

pub(crate) enum ScanError<'a> {
    Sys(syscall::Error),
    Runtime(crate::Error),
    CwdTooLong(&'static str),
    NullBytes(&'static str, Box<[u8]>),
    Js(bindgen::Error<'a>),
}
impl<'a> IntoError<'a> for ScanError<'a> {
    #[cold]
    fn into_error(self, heap: &JsHeap<'a>) -> bindgen::Error<'a> {
        match self {
            ScanError::Sys(err) => err.into_error(heap),
            ScanError::Runtime(err) => bun_jsc::JsError::from(err).into_error(heap),
            ScanError::CwdTooLong(fn_name) => heap.error(format_args!(
                "{fn_name}: invalid `cwd`, longer than {MAX_PATH_BYTES} bytes"
            )),
            ScanError::NullBytes(name, value) => heap.error_with_code(
                bun_jsc::ErrorCode::INVALID_ARG_VALUE,
                format_args!(
                    "The argument '{name}' must be a string without null bytes. Received {}",
                    bun_core::fmt::quote(&value)
                ),
            ),
            ScanError::Js(err) => err,
        }
    }
}

struct ScanOpts {
    cwd: Option<Box<[u8]>>,
    dot: bool,
    absolute: bool,
    only_files: bool,
    follow_symlinks: bool,
    error_on_broken_symlinks: bool,
    /// The `ignore` option. With a list of patterns, also the entries that leave out.
    ignore: Option<Arc<IgnoreList>>,
}

impl ScanOpts {
    /// `None` for the empty string, which means "not given".
    fn parse_cwd<'a>(
        cwd: &[u8],
        absolute: bool,
        fn_name: &'static str,
    ) -> Result<Option<Box<[u8]>>, ScanError<'a>> {
        if cwd.is_empty() {
            return Ok(None);
        }
        if cwd.len() > MAX_PATH_BYTES {
            return Err(ScanError::CwdTooLong(fn_name));
        }
        if bun_core::strings::contains_char(cwd, 0) {
            return Err(ScanError::NullBytes("cwd", Box::from(cwd)));
        }
        if bun_paths::is_absolute(cwd) {
            return Ok(Some(Box::from(cwd)));
        }

        let mut base_buf = bun_paths::path_buffer_pool::get();
        let base: &[u8] = match bun_core::working_directory_in_executable() {
            Some(directory) => directory,
            None if absolute => bun_sys::getcwd_z(&mut base_buf).map_err(ScanError::Sys)?,
            None => b"",
        };
        let cwd_str: Box<[u8]> = bun_paths::Path::join(&[base, cwd]).as_bytes().into();
        if cwd_str.len() > MAX_PATH_BYTES {
            return Err(ScanError::CwdTooLong(fn_name));
        }
        Ok(Some(cwd_str).filter(|cwd| !cwd.is_empty()))
    }

    fn new<'a>(
        argument: Option<GlobScanArgument<'a>>,
        fn_name: &'static str,
        list: Option<&Arc<IgnoreList>>,
    ) -> Result<ScanOpts, ScanError<'a>> {
        let options = match argument {
            Some(GlobScanArgument::Options(options)) => options,
            Some(GlobScanArgument::Cwd(cwd)) => GlobScanOptions {
                cwd: Some(cwd),
                ..Default::default()
            },
            None => Default::default(),
        };
        Ok(ScanOpts {
            cwd: match options.cwd {
                Some(cwd) => Self::parse_cwd(cwd, options.absolute, fn_name)?,
                None => None,
            }
            .or_else(|| bun_core::working_directory_in_executable().map(Box::from)),
            dot: options.dot,
            absolute: options.absolute,
            only_files: options.only_files,
            follow_symlinks: options.follow_symlinks,
            error_on_broken_symlinks: options.throw_error_on_broken_symlink,
            ignore: {
                let own = match &options.ignore {
                    Some(GlobScanIgnore::Pattern(pattern)) => Some(IgnoreList::new([*pattern])),
                    Some(GlobScanIgnore::Patterns(patterns)) if !patterns.is_empty() => Some(
                        IgnoreList::new(patterns.iter().map(|pattern| pattern.slice())),
                    ),
                    _ => None,
                };
                match (own, list) {
                    (Some(own), Some(list)) => Some(Arc::new(own.under(Arc::clone(list)))),
                    (Some(own), None) => Some(Arc::new(own)),
                    // The walkers share the list of the `Glob`.
                    (None, list) => list.map(Arc::clone),
                }
            },
        })
    }
}

/// `bun_glob::walk::Accessor` over the standalone module graph, so `Glob.scan`
/// can walk the embedded `/$bunfs/` tree. Up-tier from the trait on purpose,
/// like `bun_resolver::DirEntryAccessor`.
pub(crate) mod standalone_accessor {
    use bun_core::ZStr;
    use bun_glob::walk::{Accessor, AccessorDirEntry, AccessorDirIter};
    use bun_paths::Path;
    use bun_standalone_graph::Graph;
    use bun_sys::{E, Error as SysError, FileKind, Result as Maybe, Stat, Tag};

    pub(crate) struct StandaloneAccessor;

    pub(crate) struct StandaloneHandle {
        /// The opened directory's `Graph::dir_key` (`'static`: the graph is
        /// the immortal process singleton), or its path among the sources.
        dir: &'static [u8],
    }

    /// `path` resolved against the handle's directory when relative.
    fn resolve(handle: &StandaloneHandle, path: &[u8]) -> Path {
        match bun_paths::is_absolute(path) {
            true => Path::from(path),
            false => Path::join(&[handle.dir, path]),
        }
    }

    fn open_resolved(path: &[u8]) -> Maybe<StandaloneHandle> {
        let Some(graph) = Graph::get_ref() else {
            return Err(SysError::from_code(E::ENOENT, Tag::open));
        };
        match graph.dir_key(path) {
            // A folder of the sources is listed as one, by its path.
            Ok(_) if !bun_standalone_graph::is_bun_standalone_file_path(path) => {
                let path = Graph::keep_folder_path(path);
                Ok(StandaloneHandle { dir: path })
            }
            Ok(key) => Ok(StandaloneHandle { dir: key }),
            Err(code) => Err(SysError::from_code(code, Tag::open)),
        }
    }

    pub(crate) struct StandaloneDirIter {
        entries: std::vec::IntoIter<(Box<[u8]>, bool)>,
        name: Box<[u8]>,
    }

    impl AccessorDirIter for StandaloneDirIter {
        type Handle = StandaloneHandle;

        fn next(&mut self) -> Maybe<Option<AccessorDirEntry<'_>>> {
            let Some((name, is_dir)) = self.entries.next() else {
                return Ok(None);
            };
            self.name = name;
            Ok(Some(AccessorDirEntry {
                name: &self.name,
                kind: if is_dir {
                    FileKind::Directory
                } else {
                    FileKind::File
                },
                symlink_target: None,
            }))
        }

        fn iterate(dir: &StandaloneHandle) -> Self {
            // `open_resolved` proved the directory.
            let entries = Graph::get_ref()
                .and_then(|graph| graph.readdir(dir.dir, false))
                .unwrap_or_default();
            StandaloneDirIter {
                entries: entries.into_iter(),
                name: Box::default(),
            }
        }
    }

    impl Accessor for StandaloneAccessor {
        type Handle = StandaloneHandle;
        type DirIter = StandaloneDirIter;

        fn open(path: &ZStr) -> Result<Maybe<StandaloneHandle>, bun_core::Error> {
            Ok(open_resolved(path.as_bytes()))
        }

        fn openat(
            handle: &StandaloneHandle,
            path: &ZStr,
        ) -> Result<Maybe<StandaloneHandle>, bun_core::Error> {
            Ok(open_resolved(&resolve(handle, path)))
        }

        fn statat(handle: &StandaloneHandle, path: &ZStr) -> Maybe<Stat> {
            let resolved: &[u8] = &resolve(handle, path);
            Graph::get_ref()
                .and_then(|graph| {
                    graph
                        .stat(resolved)
                        .or_else(|| graph.source_path_stat(resolved))
                })
                .ok_or_else(|| SysError::from_code(E::ENOENT, Tag::fstatat))
        }

        fn lstatat(handle: &StandaloneHandle, path: &ZStr) -> Maybe<Stat> {
            // The embedded graph has no symlinks, so lstat == stat.
            Self::statat(handle, path)
        }
    }
}
use standalone_accessor::StandaloneAccessor;

type StandaloneGlobWalker = walk::GlobWalker<StandaloneAccessor, false>;

type MatchedPaths = bun_collections::StringArrayHashMap<()>;

/// The accessor is picked at init time: embedded-graph walks for a cwd or
/// pattern under the standalone virtual path, syscalls for everything else.
pub(crate) enum AnyGlobWalker {
    Fs(Box<GlobWalker>),
    Standalone(Box<StandaloneGlobWalker>),
    Each(Box<EachWalker>),
}

/// A walker for each pattern of a list. They walk one after the other, and a walker does not
/// report a path that one before it has found.
pub(crate) struct EachWalker {
    walkers: Vec<AnyGlobWalker>,
    found: MatchedPaths,
}

impl AnyGlobWalker {
    fn walk(&mut self) -> Result<bun_sys::Result<()>, bun_core::Error> {
        match self {
            AnyGlobWalker::Fs(walker) => walker.walk(),
            AnyGlobWalker::Standalone(walker) => walker.walk(),
            AnyGlobWalker::Each(each) => {
                let EachWalker { walkers, found } = &mut **each;
                // A walker that has walked is dropped: it holds what it has read.
                for mut walker in core::mem::take(walkers) {
                    core::mem::swap(walker.matched_paths_mut(), found);
                    let result = walker.walk()?;
                    core::mem::swap(walker.matched_paths_mut(), found);
                    if result.is_err() {
                        return Ok(result);
                    }
                }
                Ok(Ok(()))
            }
        }
    }

    fn matched_paths(&self) -> &MatchedPaths {
        match self {
            AnyGlobWalker::Fs(walker) => &walker.matched_paths,
            AnyGlobWalker::Standalone(walker) => &walker.matched_paths,
            AnyGlobWalker::Each(each) => &each.found,
        }
    }

    fn matched_paths_mut(&mut self) -> &mut MatchedPaths {
        match self {
            AnyGlobWalker::Fs(walker) => &mut walker.matched_paths,
            AnyGlobWalker::Standalone(walker) => &mut walker.matched_paths,
            AnyGlobWalker::Each(each) => &mut each.found,
        }
    }

    fn matched_paths_to_js<'a>(&self, heap: &JsHeap<'a>) -> bindgen::Result<'a, JsLocal<'a>> {
        bindgen::to_js::array(heap, self.matched_paths().keys(), bindgen::to_js::utf8)
    }
}

/// `Glob.scan()` off the JS thread.
pub(crate) struct WalkTask {
    // Dropping the enum runs `GlobWalker::Drop` then frees the box.
    walker: AnyGlobWalker,
    err: Option<WalkTaskErr>,
}

#[derive(bun_jsc::JsAffine)]
pub(crate) struct WalkJs {
    promise: JSPromiseStrong,
}

pub(crate) enum WalkTaskErr {
    Syscall(syscall::Error),
    Unknown(crate::Error),
}

impl WalkTaskErr {
    fn to_js(&self, global_this: &JSGlobalObject) -> JsResult<JSValue> {
        match self {
            WalkTaskErr::Syscall(err) => Ok(err.to_js(global_this)),
            WalkTaskErr::Unknown(err) => {
                bun_string_jsc::create_utf8_for_js(global_this, err.name().as_bytes())
            }
        }
    }
}

impl JobContext for WalkTask {
    type OffThread = Self;
    type Js = WalkJs;

    fn run(this: &mut Self, done: bun_jsc::Completion<Self>) -> Option<bun_jsc::Completion<Self>> {
        let result = match this.walker.walk() {
            Ok(r) => r,
            Err(err) => {
                this.err = Some(WalkTaskErr::Unknown(err.into()));
                return Some(done);
            }
        };
        if let bun_sys::Result::Err(err) = result {
            this.err = Some(WalkTaskErr::Syscall(err));
        }
        Some(done)
    }

    fn then(this: Self, mut js: WalkJs, cx: &JsThread<'_>) -> JsResult<()> {
        let global = cx.global();
        let promise = js.promise.swap();
        if let Some(err) = &this.err {
            promise.reject_with_async_stack(global, err.to_js(global))?;
            return Ok(());
        }
        let settle = |cx: &mut JsScope<'_>| match this.walker.matched_paths_to_js(&cx.heap) {
            Ok(paths) => promise.resolve(global, paths.to_js()),
            Err(err) => promise.reject(global, Err(err.into_js_error(global))),
        };
        // SAFETY: a job's completion, entered from the event loop with no `JsScope` borrowed.
        unsafe { JsScope::with(global.as_mut_ptr(), settle) }
    }
}

impl Glob {
    /// `None` for a list without an entry that says what matches: a scan of it finds nothing,
    /// and looks at nothing.
    fn make_glob_walker<'a>(
        &self,
        argument: Option<GlobScanArgument<'a>>,
        fn_name: &'static str,
    ) -> Result<Option<AnyGlobWalker>, ScanError<'a>> {
        let null_bytes = |pattern: &[u8]| {
            bun_core::strings::contains_char(pattern, 0)
                .then(|| ScanError::NullBytes("pattern", Box::from(pattern)))
        };
        let list = match self {
            Glob::One { pattern, .. } => {
                if let Some(error) = null_bytes(pattern.slice()) {
                    return Err(error);
                }
                let mut match_opts = ScanOpts::new(argument, fn_name, None)?;
                let ignore = match_opts.ignore.take();
                return Self::walker_of(pattern.slice(), &match_opts, ignore).map(Some);
            }
            Glob::Many(list) => list,
        };
        // Every entry is looked at before a walker exists, as the one pattern is.
        let positive = list.positive().iter().map(|it| it.pattern());
        if let Some(error) = positive
            .clone()
            .chain(list.ignore().patterns())
            .find_map(null_bytes)
        {
            return Err(error);
        }
        let match_opts = ScanOpts::new(argument, fn_name, Some(list.ignore()))?;
        // The walkers share what the scan leaves out.
        let ignore = match_opts.ignore.as_ref();
        let walkers = positive
            .map(|pattern| Self::walker_of(pattern, &match_opts, ignore.map(Arc::clone)))
            .collect::<Result<Vec<_>, _>>()?;
        Ok((!walkers.is_empty()).then(|| {
            AnyGlobWalker::Each(Box::new(EachWalker {
                walkers,
                found: MatchedPaths::default(),
            }))
        }))
    }

    /// The walker of one pattern.
    fn walker_of<'a>(
        pattern: &[u8],
        match_opts: &ScanOpts,
        ignore: Option<Arc<IgnoreList>>,
    ) -> Result<AnyGlobWalker, ScanError<'a>> {
        fn init_walker<'a, A: walk::Accessor>(
            pattern: &[u8],
            opts: &ScanOpts,
            ignore: Option<Arc<IgnoreList>>,
        ) -> Result<Box<walk::GlobWalker<A, false>>, ScanError<'a>> {
            let result = match &opts.cwd {
                Some(cwd) => walk::GlobWalker::<A, false>::init_with_cwd(
                    pattern,
                    cwd,
                    opts.dot,
                    opts.absolute,
                    opts.follow_symlinks,
                    opts.error_on_broken_symlinks,
                    opts.only_files,
                    None,
                ),
                None => walk::GlobWalker::<A, false>::init(
                    pattern,
                    opts.dot,
                    opts.absolute,
                    opts.follow_symlinks,
                    opts.error_on_broken_symlinks,
                    opts.only_files,
                    None,
                ),
            };
            let mut walker = result
                .map_err(|err| ScanError::Runtime(err.into()))?
                .map_err(ScanError::Sys)?;
            if let Some(ignore) = ignore {
                walker.set_ignore(ignore);
            }
            Ok(Box::new(walker))
        }

        // Match the walker's root choice (`Iterator::init`): an absolute
        // pattern roots at its literal prefix and ignores the cwd, a relative
        // pattern roots at the cwd. A `/$bunfs/` root walks the graph, as does an embedded directory that is not on disk.
        let pattern_is_absolute = bun_paths::is_absolute(pattern);
        let in_standalone_graph = bun_standalone_graph::Graph::get_ref().is_some_and(|graph| {
            if pattern_is_absolute {
                let literal = pattern
                    .iter()
                    .position(|c| b"*?[{".contains(c))
                    .unwrap_or(pattern.len());
                let folder = pattern[..literal]
                    .iter()
                    .rposition(|&c| bun_paths::is_sep(c))
                    .unwrap_or(0);
                bun_standalone_graph::is_bun_standalone_file_path(pattern)
                    || graph.owns_directory(&pattern[..folder])
            } else {
                match_opts
                    .cwd
                    .as_deref()
                    .is_some_and(|cwd| graph.owns_directory(cwd))
            }
        });

        if in_standalone_graph {
            return Ok(AnyGlobWalker::Standalone(
                init_walker::<StandaloneAccessor>(pattern, match_opts, ignore)?,
            ));
        }
        Ok(AnyGlobWalker::Fs(init_walker::<walk::SyscallAccessor>(
            pattern, match_opts, ignore,
        )?))
    }
}

impl Glob {
    pub(crate) fn constructor(_: &JsHeap<'_>, pattern: bun_core::Utf8Bytes<'static>) -> Self {
        Glob::One {
            shape: bun_glob::matcher::Shape::of(pattern.slice()),
            pattern,
        }
    }

    /// `new Glob([..])`. `PatternList` says what an entry with `!` or `./` in front is.
    pub(crate) fn from_list(
        heap: &JsHeap<'_>,
        patterns: Vec<bun_core::Utf8Bytes<'static>>,
    ) -> Self {
        let patterns = PatternList::new(patterns);
        // The collector counts 80 bytes for the object. It is told what the list holds now, and
        // not again when it marks the object: that is `estimatedSize`, which a `Glob` of one
        // pattern would pay for.
        // SAFETY: the collector runs no JavaScript.
        let vm = unsafe { heap.global() }.vm();
        vm.report_extra_memory(patterns.memory_cost());
        Glob::Many(Box::new(patterns))
    }

    pub(crate) fn r#match<'a>(&self, str: &'a [u8]) -> bool {
        match self {
            Glob::One { pattern, shape } => bun_glob::matcher::match_prepared::<{ cfg!(windows) }>(
                pattern.slice(),
                shape,
                str,
                bun_glob::Dots::Match,
            )
            .matches(),
            Glob::Many(list) => list.matches(str),
        }
    }

    pub(crate) fn scan<'a>(
        &self,
        cx: &mut JsScope<'a>,
        options: Option<GlobScanArgument<'a>>,
    ) -> Result<JsLocal<'a>, ScanError<'a>> {
        let Some(walker) = self.make_glob_walker(options, "scan")? else {
            return Ok(JsLocal::UNDEFINED);
        };
        let promise = JSPromiseStrong::init(cx.global());
        let value = promise.value();
        Job::<WalkTask>::schedule(
            &cx.js_thread(),
            WalkTask { walker, err: None },
            WalkJs { promise },
        );
        Ok(JsLocal::new(&cx.heap, value))
    }

    pub(crate) fn scan_sync<'a>(
        &self,
        heap: &JsHeap<'a>,
        options: Option<GlobScanArgument<'a>>,
    ) -> Result<JsLocal<'a>, ScanError<'a>> {
        let Some(mut walker) = self.make_glob_walker(options, "scanSync")? else {
            return Ok(JsLocal::UNDEFINED);
        };
        walker
            .walk()
            .map_err(|err| ScanError::Runtime(err.into()))?
            .map_err(ScanError::Sys)?;
        walker.matched_paths_to_js(heap).map_err(ScanError::Js)
    }
}
