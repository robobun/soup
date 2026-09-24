//! `--watch-path`: files and directories that restart (`--watch`) or reload
//! (`--hot`) the process when they change, although nothing imports them.
//!
//! `bun_watcher::Watcher` is shaped around the module graph: an entry per file
//! (on macOS a descriptor per file), a 16-bit index, and on Windows nothing
//! above the project root. A path given here is a plain tree of files, which
//! is what the `fs.watch()` backend is for (inotify, FSEvents,
//! `ReadDirectoryChangesW`; recursive, anywhere on disk), so each path is
//! watched by `FSWatcher`s whose listeners are the native functions below.
//!
//! Each path has two watchers. `own` is on the path itself while it exists:
//! recursive for a directory, and through the link for a symlink to a file.
//! `above` is on the deepest directory above the path that exists, normally
//! its parent, and only looks at events that name the next component on the
//! way to the path. That is how a plain file is watched (an editor that saves
//! by renaming a temporary file over it replaces the inode a watch on the file
//! would be tied to), how a path that does not exist yet is seen being
//! created, however many directories are missing, and how a directory that is
//! deleted and made again (`rm -rf dist && build`) gets a new recursive
//! watcher under `--hot`, where no restart would make one.

use core::cell::{Cell, RefCell};
use core::ffi::c_void;

use bun_core::{Output, strings};
use bun_jsc::host_fn;
use bun_jsc::hot_reloader::{self, HotReloaderCtx as _, ImportWatcher};
use bun_jsc::node::PathLike;
use bun_jsc::virtual_machine::VirtualMachine;
use bun_jsc::{CallFrame, JSGlobalObject, JSValue, JsClass as _, JsResult, Weak};
use bun_paths::resolve_path::{self, platform};

use crate::node::node_fs_watcher::{Arguments, FSWatcher};
use crate::node::types::Encoding;

thread_local! {
    /// Every `--watch-path` of the main thread's VM, for [`restart`].
    static ROOTS: RefCell<Vec<&'static Root>> = const { RefCell::new(Vec::new()) };
}

/// One `--watch-path`. Leaked: it is the data of listener functions, and the
/// paths are watched for as long as the process runs. JS thread only.
struct Root {
    /// Absolute, without a trailing separator.
    path: Box<[u8]>,
    /// What `path` was when `own` was last armed.
    kind: Cell<Kind>,
    /// How much of `path` is the directory that `above` watches.
    above_len: Cell<usize>,
    /// The JS wrappers of the two watchers. Weak, because a watcher closes
    /// with its global under `bun test --isolate` and nothing here hears of
    /// it.
    above: Cell<Weak<()>>,
    own: Cell<Weak<()>>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Missing,
    /// Anything that is not a directory. `true`: reached through a symlink,
    /// so events in its directory say nothing about its contents.
    File(bool),
    Directory,
}

impl Kind {
    fn of(path: &[u8]) -> Kind {
        let mut buf = bun_paths::path_buffer_pool::get();
        let path = resolve_path::z(path, &mut buf);
        match bun_sys::stat(path) {
            Ok(stat) if bun_sys::S::ISDIR(stat.st_mode as _) => Kind::Directory,
            Ok(_) => Kind::File(
                bun_sys::lstat(path).is_ok_and(|stat| bun_sys::S::ISLNK(stat.st_mode as _)),
            ),
            Err(_) => Kind::Missing,
        }
    }
}

/// What an `FSWatcher` tells its listener.
enum Event {
    /// `"change"`: contents or attributes. The name is empty when the backend
    /// could not tell, or lost events.
    Change(Vec<u8>),
    /// `"rename"`: created, deleted or moved.
    Rename(Vec<u8>),
    /// `"error"`: the watcher is of no use any more. Windows reports a
    /// watched directory that was deleted this way.
    Error,
}

/// Starts the watchers for every `--watch-path`. Call once the hot reloader
/// is enabled and before the entry point loads.
pub(crate) fn start(vm: &VirtualMachine, paths: &[Box<[u8]>]) {
    if paths.is_empty() || !vm.is_watcher_enabled() {
        return;
    }
    let top_level_dir = vm.top_level_dir();
    let mut roots: Vec<&'static Root> = Vec::with_capacity(paths.len());
    for path in paths {
        let mut buf = bun_paths::path_buffer_pool::get();
        let Some(abs) = resolve_path::join_abs_string_buf_checked::<platform::Auto>(
            top_level_dir,
            &mut **buf,
            &[path],
        ) else {
            bun_core::warn!(
                "--watch-path {} is too long to be watched",
                bun_core::fmt::quote(path),
            );
            continue;
        };
        roots.push(Box::leak(Box::new(Root {
            path: Box::from(abs),
            kind: Cell::new(Kind::Missing),
            above_len: Cell::new(0),
            above: Cell::new(Weak::default()),
            own: Cell::new(Weak::default()),
        })));
    }
    // `bun test` gets here without the API lock.
    vm.run_with_api_lock(|| {
        for root in &roots {
            root.arm(vm);
        }
    });
    Output::flush();
    ROOTS.with_borrow_mut(|all| all.extend(roots));
}

/// `bun test --isolate` closes what a test file left open together with the
/// global it retires, and these watchers with it. Starts them again in the
/// global that replaced it. A change the finished file never let the event
/// loop deliver, or one made before this runs, goes unseen.
pub(crate) fn restart(vm: &VirtualMachine) {
    let roots = ROOTS.with_borrow(|roots| roots.clone());
    if roots.is_empty() {
        return;
    }
    vm.run_with_api_lock(|| {
        for root in roots {
            root.arm(vm);
        }
    });
}

impl Root {
    /// The part of `path` below the directory `above` watches, and the first
    /// component of that: the name `above` waits for.
    fn below(&self) -> (&[u8], &[u8]) {
        let below = &self.path[self.above_len.get().min(self.path.len())..];
        let below = strings::trim_left(below, b"/\\");
        let next = strings::split_any(below, b"/\\").next().unwrap_or(below);
        (below, next)
    }

    /// Watches what exists now, in the current global.
    fn arm(&'static self, vm: &VirtualMachine) {
        close(self.above.take());
        // The deepest directory above `path` that exists.
        let mut above = bun_paths::dirname(&self.path);
        while let Some(dir) = above {
            if Kind::of(dir) == Kind::Directory {
                break;
            }
            above = bun_paths::dirname(dir).filter(|parent| parent.len() < dir.len());
        }
        // `None`: `path` is a file system root.
        if let Some(dir) = above {
            self.above_len.set(dir.len());
            self.above
                .set(self.watch(vm, dir, false, __jsc_host_on_above_event));
        }
        self.arm_own(vm);
    }

    /// Replaces the watcher on `path` itself with one on what is there now.
    /// Never kept, even when `path` looks unchanged: a directory that was
    /// deleted and made again can have the inode number it had before, and the
    /// old watch is on the old inode.
    fn arm_own(&'static self, vm: &VirtualMachine) {
        close(self.own.take());
        let kind = Kind::of(&self.path);
        self.kind.set(kind);
        let recursive = match kind {
            Kind::Directory => true,
            Kind::File(true) => false,
            Kind::File(false) | Kind::Missing => return,
        };
        self.own
            .set(self.watch(vm, &self.path, recursive, __jsc_host_on_own_event));
    }

    fn watch(
        &'static self,
        vm: &VirtualMachine,
        path: &[u8],
        recursive: bool,
        listener: host_fn::JsHostFn,
    ) -> Weak<()> {
        let global = vm.global();
        let data = core::ptr::from_ref(self).cast_mut().cast::<c_void>();
        let listener = host_fn::new_function_with_data(global, None, 2, listener, data);
        let watcher = Arguments {
            path: PathLike::owned(path.to_vec()),
            listener,
            global_this: global,
            context: vm.root_context(),
            signal: None,
            // The run loop of `--watch` and `--hot` never ends on its own.
            persistent: false,
            recursive,
            // File names are bytes.
            encoding: Encoding::Buffer,
            verbose: false,
            every_event: true,
        }
        .create_fs_watcher();
        match watcher {
            // SAFETY: `FSWatcher::init` returns a live watcher. Its wrapper
            // owns it and is alive until the watcher is closed.
            Ok(watcher) => Weak::create_passive(unsafe { &*watcher }.js_this(), global),
            Err(err) => {
                bun_core::warn!(
                    "--watch-path {} cannot be watched: {}",
                    bun_core::fmt::quote(&self.path),
                    err,
                );
                Weak::default()
            }
        }
    }
}

fn close(wrapper: Weak<()>) {
    if let Some(watcher) = wrapper.get().and_then(FSWatcher::from_js) {
        // SAFETY: the weak handle just returned the wrapper that owns
        // `watcher`.
        unsafe { &*watcher }.close();
    }
}

/// The arguments of a listener call: `(eventType, filename)`. `None` for
/// `"close"`.
fn event(global: &JSGlobalObject, frame: &CallFrame) -> JsResult<Option<(&'static Root, Event)>> {
    let Some(data) = host_fn::get_function_data(frame.callee()) else {
        return Ok(None);
    };
    // SAFETY: the data of both listeners is the leaked `Root` from `watch`.
    let root: &'static Root = unsafe { &*data.cast::<Root>() };
    let [event_type, filename] = frame.arguments_as_array::<2>();
    if !event_type.is_string() {
        return Ok(None);
    }
    let event_type = event_type.to_bun_string(global)?;
    let name = || {
        filename
            .as_array_buffer(global)
            .map(|buffer| buffer.slice().to_vec())
            .unwrap_or_default()
    };
    Ok(if event_type.eq_ascii(b"change") {
        Some((root, Event::Change(name())))
    } else if event_type.eq_ascii(b"rename") {
        Some((root, Event::Rename(name())))
    } else if event_type.eq_ascii(b"error") {
        Some((root, Event::Error))
    } else {
        None
    })
}

/// Something happened in the directory above a watched path.
#[bun_jsc::host_fn]
fn on_above_event(global: &JSGlobalObject, frame: &CallFrame) -> JsResult<JSValue> {
    let Some((root, event)) = event(global, frame)? else {
        return Ok(JSValue::UNDEFINED);
    };
    let vm = global.bun_vm().as_mut();
    let (below, next) = root.below();
    let above = &root.path[..root.above_len.get().min(root.path.len())];
    let (about_next, about_above) = match &event {
        Event::Error => (false, true),
        Event::Change(name) => (name.is_empty() || is_same_name(name, next), false),
        // A directory watched without `recursive` reports what happens to
        // itself under its own name.
        Event::Rename(name) => (
            name.is_empty() || is_same_name(name, next),
            is_same_name(name, bun_paths::basename(above)),
        ),
    };
    if !about_next && !about_above {
        return Ok(JSValue::UNDEFINED);
    }

    let before = root.kind.get();
    if about_above || next.len() != below.len() {
        // A directory on the way to the path appeared or went away.
        root.arm(vm);
        if root.kind.get() != before {
            changed(vm, &root.path);
        }
        return Ok(JSValue::UNDEFINED);
    }

    // About the path itself.
    if let (Kind::Directory, Event::Change(name)) = (before, &event) {
        // The attributes of the directory, or on Windows its contents, which
        // `own` reports.
        if !name.is_empty() {
            return Ok(JSValue::UNDEFINED);
        }
    }
    changed(vm, &root.path);
    if !matches!(event, Event::Change(_)) || Kind::of(&root.path) != before {
        root.arm_own(vm);
    }
    Ok(JSValue::UNDEFINED)
}

/// Something happened to a watched path, or below it.
#[bun_jsc::host_fn]
fn on_own_event(global: &JSGlobalObject, frame: &CallFrame) -> JsResult<JSValue> {
    let Some((root, event)) = event(global, frame)? else {
        return Ok(JSValue::UNDEFINED);
    };
    let vm = global.bun_vm().as_mut();
    let name = match &event {
        Event::Change(name) | Event::Rename(name) => name.as_slice(),
        Event::Error => b"",
    };
    if root.kind.get() != Kind::Directory || name.is_empty() {
        // The target of the symlink, or the directory itself: deleted, moved,
        // its attributes, or events that the backend lost.
        changed(vm, &root.path);
        if !matches!(event, Event::Change(_)) {
            root.arm_own(vm);
        }
        return Ok(JSValue::UNDEFINED);
    }
    // `bun install` and every git command would otherwise restart the process.
    if strings::split_any(name, b"/\\")
        .any(|component| component == b"node_modules" || component == b".git")
    {
        return Ok(JSValue::UNDEFINED);
    }
    let mut buf = bun_paths::path_buffer_pool::get();
    if let Some(abs) =
        resolve_path::join_abs_string_buf_checked::<platform::Auto>(&root.path, &mut **buf, &[name])
    {
        changed(vm, abs);
    }
    Ok(JSValue::UNDEFINED)
}

/// Whether an event named `name` is about `component`, which comes from the
/// command line: on a file system that ignores case it may be spelled
/// differently there than on disk.
fn is_same_name(name: &[u8], component: &[u8]) -> bool {
    if cfg!(any(windows, target_os = "macos")) {
        strings::eql_case_insensitive_ascii(name, component, true)
    } else {
        name == component
    }
}

fn changed(vm: &mut VirtualMachine, abs_path: &[u8]) {
    // SAFETY: `start` checked `is_watcher_enabled`, so this is the
    // `ImportWatcher` the hot reloader installed and leaked.
    let import_watcher = unsafe { &*vm.bun_watcher.cast::<ImportWatcher>() };
    // An imported file is the import watcher's to report: twice is two
    // reloads under `--hot`.
    if import_watcher.is_excluded(abs_path) || import_watcher.is_watching_file(abs_path) {
        return;
    }
    if vm.log_level_at_least_info() {
        bun_core::pretty_errorln!(
            "<cyan>watcher<r><d>:<r> File changed: {}",
            bstr::BStr::new(resolve_path::relative(vm.top_level_dir(), abs_path)),
        );
        Output::flush();
    }
    hot_reloader::reload_from_js_thread(vm);
}
