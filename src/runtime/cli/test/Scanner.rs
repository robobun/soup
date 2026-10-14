use std::collections::VecDeque;
use std::rc::Rc;

use bun_alloc::AllocError;
use bun_bundler::Transpiler;
use bun_bundler::options::BundleOptions;
use bun_collections::index_sort;
use bun_core::{StringOrTinyString, strings};
use bun_output::{declare_scope, scoped_log};
use bun_paths::resolve_path::{join_abs_string_buf_checked, platform};
use bun_paths::{self, PathBuffer};
use bun_ptr::Interned;
use bun_resolver::fs::{self as fs, DirEntryIterator, EntriesOption, FileSystem};
use bun_sys::{Dir, Fd};

declare_scope!(jest, hidden);

pub(crate) struct Scanner<'a> {
    /// Memory is borrowed.
    pub(crate) exclusion_names: &'a [&'a [u8]],
    /// When this list is empty, no filters are applied.
    /// "test" suffixes (e.g. .spec.*) are always applied when traversing directories.
    pub(crate) filter_names: &'a [&'a [u8]],
    /// `--test-match` or `testMatch`. `None`: a test file has one of [`TEST_NAME_SUFFIXES`]
    /// before its extension.
    pub(crate) test_match: Option<&'a TestMatch>,
    /// Glob patterns for paths to ignore. Matched against the path relative to the
    /// project root (top_level_dir). When a file matches any pattern, it is excluded.
    pub(crate) path_ignore_patterns: &'a [bun_glob::Prepared<&'a [u8]>],
    pub(crate) dirs_to_scan: Fifo,
    /// Paths to test files found while scanning.
    pub(crate) test_files: Vec<Interned>,
    pub(crate) fs: *mut FileSystem,
    pub(crate) open_dir_buf: PathBuffer,
    pub(crate) options: &'a BundleOptions<'a>,
    pub(crate) has_iterated: bool,
    pub(crate) search_count: usize,
    /// The directory being iterated; its fd closes once every child `ScanEntry` has been opened.
    current_dir: Option<Rc<Dir>>,
}

// FIFO queue of scan entries (pop_front / push_back).
pub(crate) type Fifo = VecDeque<ScanEntry>;

pub(crate) struct ScanEntry {
    /// `None` for children of the root, which are opened by absolute path.
    pub(crate) relative_dir: Option<Rc<Dir>>,
    // `'static` is sound here: borrows from FileSystem.dirname_store, a
    // process-lifetime arena that is never reset.
    pub(crate) dir_path: &'static [u8],
    pub name: StringOrTinyString,
}

#[derive(thiserror::Error, Debug)]
pub(crate) enum ScanError {
    /// The entrypoint does not exist or does not fit a `PathBuffer`; never returned for subdirectories.
    #[error("DoesNotExist")]
    DoesNotExist,
    #[error("OutOfMemory")]
    OutOfMemory,
}
bun_core::oom_from_alloc!(ScanError);

/// Newtype around `*mut Scanner` so it can satisfy [`DirEntryIterator`]
/// (whose `next` takes `&self`) while still allowing mutable calls.
#[repr(transparent)]
struct ScannerDirIter<'a>(*mut Scanner<'a>);
impl<'a> DirEntryIterator for ScannerDirIter<'a> {
    fn next(&self, entry: &mut fs::Entry, _fd: Fd) {
        // SAFETY: `self.0` is `&mut Scanner` for the duration of
        // `read_directory_with_iterator`; no other live `&mut` alias exists
        // while the resolver walks entries.
        unsafe { (*self.0).next(entry) }
    }
}

impl<'a> Scanner<'a> {
    pub(crate) fn init(
        transpiler: &'a Transpiler,
        initial_results_capacity: usize,
    ) -> Result<Scanner<'a>, AllocError> {
        let results = Vec::with_capacity(initial_results_capacity);
        Ok(Scanner {
            exclusion_names: &[],
            filter_names: &[],
            test_match: None,
            path_ignore_patterns: &[],
            dirs_to_scan: Fifo::new(),
            options: &transpiler.options,
            fs: transpiler.fs,
            test_files: results,
            open_dir_buf: PathBuffer::ZEROED,
            has_iterated: false,
            search_count: 0,
            current_dir: None,
        })
    }

    #[inline]
    pub(crate) fn fs(&self) -> &'static FileSystem {
        // SAFETY: process-singleton; no `&mut` to it is live outside the iterator callback.
        unsafe { &*self.fs }
    }

    #[inline]
    fn top_level_dir(&self) -> &'static [u8] {
        // SAFETY: field-precise projection; never spans the mutably-borrowed `fs` field.
        unsafe { (*self.fs).top_level_dir }
    }

    #[inline]
    fn filename_store(&self) -> &'static fs::FilenameStore {
        // SAFETY: same as `top_level_dir`.
        unsafe { (*self.fs).filename_store }
    }

    #[inline]
    fn abs_buf_projected<'b>(
        top_level_dir: &'static [u8],
        parts: &[&[u8]],
        buf: &'b mut [u8],
    ) -> Option<&'b [u8]> {
        join_abs_string_buf_checked::<platform::Loose>(top_level_dir, buf, parts)
    }

    /// Take the list of test files out of this scanner. Caller owns the returned
    /// allocation.
    pub(crate) fn take_found_test_files(&mut self) -> Result<Box<[Interned]>, AllocError> {
        Ok(core::mem::take(&mut self.test_files).into_boxed_slice())
    }

    pub(crate) fn scan(&mut self, path_literal: &[u8]) -> Result<(), ScanError> {
        let mut scan_dir_buf = bun_paths::path_buffer_pool::get();
        let parts: [&[u8]; 2] = [self.top_level_dir(), path_literal];
        let Some(path) = Self::abs_buf_projected(self.top_level_dir(), &parts, &mut scan_dir_buf)
        else {
            return Err(ScanError::DoesNotExist);
        };

        let root = self
            .read_dir_with_name(path, None)
            .map_err(|_| ScanError::OutOfMemory)?;

        if let EntriesOption::Err(root_err) = root {
            let e = root_err.original_err;
            if e == bun_resolver::Error::Sys(bun_errno::SystemErrno::ENOTDIR) {
                if self.is_test_file(path) {
                    let stored = self
                        .fs()
                        .filename_store
                        .append_slice(path)
                        .map_err(|_| ScanError::OutOfMemory)?;
                    let rel_path = Interned::from_static(stored);
                    self.test_files.push(rel_path);
                }
            } else if e == bun_resolver::Error::Sys(bun_errno::SystemErrno::ENOENT) {
                return Err(ScanError::DoesNotExist);
            } else {
                scoped_log!(
                    jest,
                    "Scanner.readDirWithName('{}') -> {}",
                    bstr::BStr::new(path),
                    root_err.original_err.name()
                );
            }
        }

        // you typed "." and we already scanned it
        if !self.has_iterated {
            if let EntriesOption::Entries(entries) = root {
                // Collect first so `self.next(…)` doesn't overlap the
                // `entries.data` borrow.
                // this branch is taken when the resolver already has
                // `path` cached (e.g. `run_env_loader`/`read_dir_info` read the
                // cwd before the scanner runs), so `read_directory_with_iterator`
                // returned the cached `EntryMap` without invoking `iterator.next`.
                // Hash-map iteration order is not stable. Sort by (lowercased)
                // base name so test-file discovery order is deterministic —
                // regression/issue/26851 relies on `a_*.test` running before
                // `b_*.test` under `--bail`.
                let mut entry_ptrs: Vec<*mut fs::Entry> = entries.data.values().copied().collect();
                index_sort::sort_slice_by(&mut entry_ptrs, |a, b| {
                    // SAFETY: `EntryMap` stores `*mut Entry` into the
                    // process-static `EntryStore`; valid for `'static`.
                    let (an, bn) = unsafe { ((**a).base_lowercase(), (**b).base_lowercase()) };
                    an.cmp(bn)
                });
                for entry_ptr in entry_ptrs {
                    // SAFETY: `EntryMap` stores `*mut Entry` into the
                    // process-static `EntryStore`; valid for `'static`.
                    self.next(unsafe { &mut *entry_ptr });
                }
            }
        }

        while let Some(entry) = self.dirs_to_scan.pop_front() {
            let parts2: [&[u8]; 2] = [entry.dir_path, entry.name.slice()];
            let Some(path2) = self.fs().abs_buf_checked(&parts2, &mut scan_dir_buf) else {
                continue;
            };
            let (parent, rel_path): (Fd, &[u8]) = match &entry.relative_dir {
                Some(parent) => (parent.fd, entry.name.slice()),
                None => (Fd::cwd(), path2),
            };
            #[cfg(not(windows))]
            let opened = bun_sys::open_dir_at(parent, rel_path);
            #[cfg(windows)]
            let opened = bun_sys::open_dir_no_renaming_or_deleting_windows(parent, rel_path);
            // Dropping `entry` releases the parent fd once its last child is opened.
            drop(entry);
            let Ok(child_fd) = opened else {
                continue;
            };
            let child_dir = Rc::new(Dir::from_fd(child_fd));
            let path2 = self
                .fs()
                .dirname_store
                .append_slice(path2)
                .map_err(|_| ScanError::OutOfMemory)?;
            self.current_dir = Some(Rc::clone(&child_dir));
            let result = self.read_dir_with_name(path2, Some(child_dir.fd));
            self.current_dir = None;
            result.map_err(|_| ScanError::OutOfMemory)?;
        }

        Ok(())
    }

    /// `handle` stays owned by the caller; the resolver caches the listing but not the fd.
    fn read_dir_with_name(
        &mut self,
        name: &[u8],
        handle: Option<Fd>,
    ) -> crate::Result<&'static mut EntriesOption> {
        let fs_ptr = self.fs;
        let iter = ScannerDirIter(std::ptr::from_mut::<Scanner<'a>>(self));
        // SAFETY: borrows only the `fs` field; re-entrant access is serialised by `RealFS.entries_mutex`.
        unsafe { &mut (*fs_ptr).fs }
            .read_directory_with_iterator(name, handle, 0, false, iter)
            .map_err(Into::into)
    }

    pub(crate) fn could_be_test_file<const NEEDS_TEST_SUFFIX: bool>(&self, name: &[u8]) -> bool {
        let extname = bun_paths::extension(name);
        if extname.is_empty() || !self.options.loader(extname).is_javascript_like() {
            return false;
        }
        if !NEEDS_TEST_SUFFIX {
            return true;
        }
        let name_without_extension = &name[..name.len() - extname.len()];
        for suffix in TEST_NAME_SUFFIXES {
            if strings::ends_with(name_without_extension, suffix) {
                return true;
            }
        }

        false
    }

    pub(crate) fn does_absolute_path_match_filter(&self, name: &[u8]) -> bool {
        if self.filter_names.is_empty() {
            return true;
        }

        for filter_name in self.filter_names {
            if strings::starts_with(name, filter_name) {
                return true;
            }
        }

        false
    }

    pub(crate) fn does_path_match_filter(&self, name: &[u8]) -> bool {
        if self.filter_names.is_empty() {
            return true;
        }

        for filter_name in self.filter_names {
            if strings::index_of(name, filter_name).is_some() {
                return true;
            }
        }

        false
    }

    /// Returns true if the given path matches any of the path ignore patterns.
    /// The path is matched as a relative path from the project root.
    pub(crate) fn matches_path_ignore_pattern(&self, abs_path: &[u8]) -> bool {
        if self.path_ignore_patterns.is_empty() {
            return false;
        }
        let rel_path = bun_paths::resolve_path::relative(self.top_level_dir(), abs_path);

        // Build rel_path + '/' once. rel_path is a relative path from the project
        // root; 4096 bytes covers any sane test directory depth (POSIX PATH_MAX).
        let mut buf = [0u8; 4096];
        let rel_with_slash: Option<&[u8]> = if !rel_path.is_empty()
            && rel_path.len() < buf.len()
            && rel_path[rel_path.len() - 1] != b'/'
        {
            buf[..rel_path.len()].copy_from_slice(rel_path);
            buf[rel_path.len()] = b'/';
            Some(&buf[..rel_path.len() + 1])
        } else {
            None
        };

        for pattern in self.path_ignore_patterns {
            if pattern.r#match(rel_path).matches() {
                return true;
            }
            // Only try trailing separator for ** patterns (e.g. "vendor/**").
            // Single-star patterns like "vendor/*" must not prune entire
            // directories because * doesn't cross directory boundaries.
            if let Some(p) = rel_with_slash {
                if strings::index_of(pattern.pattern(), b"**").is_some() {
                    if pattern.r#match(p).matches() {
                        return true;
                    }
                }
            }
        }
        false
    }

    pub(crate) fn is_test_file(&self, name: &[u8]) -> bool {
        self.could_be_test_file::<false>(name)
            && self.does_path_match_filter(name)
            && !self.matches_path_ignore_pattern(name)
    }

    pub(crate) fn next(&mut self, entry: &mut fs::Entry) {
        let name = entry.base_lowercase();
        self.has_iterated = true;
        // SAFETY: `self.fs` is the process singleton.
        let real_fs = unsafe { &raw mut (*self.fs).fs };
        // SAFETY: caller holds `entries_mutex`; the direct path is single-threaded.
        match unsafe { entry.kind(real_fs, false) } {
            fs::EntryKind::Dir => {
                if (!name.is_empty() && name[0] == b'.') || name == b"node_modules" {
                    return;
                }

                debug_assert!(strings::index_of(name, bun_paths::NODE_MODULES_NEEDLE).is_none());

                for exclude_name in self.exclusion_names {
                    if strings::eql(exclude_name, name) {
                        return;
                    }
                }

                // Prune ignored directory trees early so we never traverse them.
                if !self.path_ignore_patterns.is_empty() {
                    let parts: [&[u8]; 2] = [entry.dir, entry.base()];
                    // reshaped for borrowck — drop the &mut borrow from
                    // abs_buf and reborrow open_dir_buf immutably so &self methods
                    // can be called with the slice.
                    let Some(dir_path_len) = Self::abs_buf_projected(
                        self.top_level_dir(),
                        &parts,
                        &mut self.open_dir_buf,
                    )
                    .map(<[u8]>::len) else {
                        return;
                    };
                    let dir_path = &self.open_dir_buf[..dir_path_len];
                    if self.matches_path_ignore_pattern(dir_path) {
                        return;
                    }
                }

                self.search_count += 1;

                self.dirs_to_scan.push_back(ScanEntry {
                    relative_dir: self.current_dir.clone(),
                    // SAFETY: StringOrTinyString is repr(C) POD ([u8;31] + u8) with
                    // no Drop. Upstream type lacks Clone/Copy, so bitwise-copy here.
                    name: unsafe { core::ptr::read(&raw const entry.base_) },
                    dir_path: entry.dir,
                });
            }
            fs::EntryKind::File => {
                // already seen it!
                if !entry.abs_path.is_empty() {
                    return;
                }

                self.search_count += 1;
                let has_test_name = match self.test_match {
                    // The patterns are about the path, which is joined below.
                    Some(test_match) if !test_match.keeps_default_names() => {
                        self.could_be_test_file::<false>(name)
                    }
                    _ => self.could_be_test_file::<true>(name),
                };
                if !has_test_name {
                    return;
                }

                let parts: [&[u8]; 2] = [entry.dir, entry.base()];
                // reshaped for borrowck — drop the &mut borrow from
                // abs_buf and reborrow open_dir_buf immutably so &self methods
                // below can be called with the slice.
                let Some(path_len) =
                    Self::abs_buf_projected(self.top_level_dir(), &parts, &mut self.open_dir_buf)
                        .map(<[u8]>::len)
                else {
                    return;
                };
                let path = &self.open_dir_buf[..path_len];

                if let Some(test_match) = self.test_match {
                    if !test_match.matches(path) {
                        return;
                    }
                }

                if !self.does_absolute_path_match_filter(path) {
                    let rel_path = bun_paths::resolve_path::relative(self.top_level_dir(), path);
                    if !self.does_path_match_filter(rel_path) {
                        return;
                    }
                }

                if self.matches_path_ignore_pattern(path) {
                    return;
                }

                let stored = match self.filename_store().append_slice(path) {
                    Ok(s) => s,
                    Err(_) => bun_core::out_of_memory(),
                };
                entry.abs_path = Interned::from_static(stored);
                self.test_files.push(entry.abs_path);
            }
            fs::EntryKind::Dangling => {}
        }
    }
}

pub(crate) const TEST_NAME_SUFFIXES: [&[u8]; 4] = [b".test", b"_test", b".spec", b"_spec"];

/// Whether the name of the file at `path` ends in one of [`TEST_NAME_SUFFIXES`] before its
/// extension.
pub(crate) fn has_test_suffix(path: &[u8]) -> bool {
    let name_without_extension = &path[..path.len() - bun_paths::extension(path).len()];
    TEST_NAME_SUFFIXES
        .iter()
        .any(|suffix| strings::ends_with(name_without_extension, suffix))
}

/// Which files are tests, when `--test-match` or `testMatch` says so: for a scan, and for
/// `coverageSkipTestFiles`.
pub(crate) struct TestFiles {
    /// `--test-match`.
    flag: Option<TestMatch>,
    /// `testMatch` in bunfig.toml.
    config: Option<TestMatch>,
}

impl TestFiles {
    /// `None` without either list: the default names apply everywhere. `root` is `[test] root`.
    pub(crate) fn new(
        flag: &[Box<[u8]>],
        config: &[Box<[u8]>],
        top_level_dir: &[u8],
        root: &[u8],
    ) -> Option<TestFiles> {
        if flag.is_empty() && config.is_empty() {
            return None;
        }
        Some(TestFiles {
            flag: TestMatch::new(flag, top_level_dir, root),
            config: TestMatch::new(config, top_level_dir, root),
        })
    }

    /// The list a scan asks. `--test-match` replaces `testMatch`.
    pub(crate) fn scanned(&self) -> Option<&TestMatch> {
        self.flag.as_ref().or(self.config.as_ref())
    }

    /// Whether `coverageSkipTestFiles` leaves the file at `path` out. It is a test of this run,
    /// or one of the tests that `--test-match` did not ask for this time: what `testMatch`
    /// names, or without it the default names.
    pub(crate) fn names(&self, path: &[u8]) -> bool {
        let named_by = |list: &TestMatch| {
            list.matches(path) && (!list.keeps_default_names() || has_test_suffix(path))
        };
        match (&self.flag, &self.config) {
            (Some(flag), None) => named_by(flag) || has_test_suffix(path),
            (Some(flag), Some(config)) => named_by(flag) || named_by(config),
            (None, Some(config)) => named_by(config),
            (None, None) => has_test_suffix(path),
        }
    }
}

/// One list of `testMatch` globs.
pub(crate) struct TestMatch {
    patterns: Vec<Pattern>,
    /// Every pattern takes paths away, so the list starts from the default names.
    only_excludes: bool,
    /// The project root when the run started, without a separator at its end. A test can
    /// `process.chdir()`, and the patterns must keep their meaning.
    root: Box<[u8]>,
}

struct Pattern {
    glob: bun_glob::Prepared<Box<[u8]>>,
    /// Takes paths away: an odd number of `!` in front, or a `!(...)` group in front, which
    /// Jest counts as a negation too.
    negated: bool,
}

impl TestMatch {
    fn new(patterns: &[Box<[u8]>], top_level_dir: &[u8], root: &[u8]) -> Option<TestMatch> {
        if patterns.is_empty() {
            return None;
        }
        let is_separator = |byte: &u8| *byte == b'/' || (cfg!(windows) && *byte == b'\\');
        let without_end_separators = |path: &[u8]| -> usize {
            path.iter()
                .rposition(|byte| !is_separator(byte))
                .map_or(0, |last| last + 1)
        };
        let project = &top_level_dir[..without_end_separators(top_level_dir)];

        // What `<rootDir>` stands for: nothing, or `[test] root` from the project root.
        let mut root_dir: Vec<u8> = Vec::new();
        if !root.is_empty() {
            use bun_paths::resolve_path::{join_abs, platform};
            let absolute = join_abs::<platform::Auto>(top_level_dir, root);
            let absolute = &absolute[..without_end_separators(absolute)];
            let mut buf = bun_paths::path_buffer_pool::get();
            if let Some(relative) = relative_to(project, absolute, &mut buf[..]) {
                if !relative.is_empty() {
                    root_dir = escaped(relative);
                    root_dir.push(b'/');
                }
            }
        }

        let patterns: Vec<Pattern> = patterns
            .iter()
            .map(|pattern| Pattern::new(pattern, &root_dir))
            .collect();
        Some(TestMatch {
            only_excludes: patterns.iter().all(|pattern| pattern.negated),
            patterns,
            root: Box::from(project),
        })
    }

    /// With only `!` patterns, a test also needs one of [`TEST_NAME_SUFFIXES`]. A scan and
    /// `coverageSkipTestFiles` each have their own way to ask for that.
    pub(crate) fn keeps_default_names(&self) -> bool {
        self.only_excludes
    }

    /// Whether the patterns take the file at `path`, which is absolute, for a test.
    ///
    /// Jest's rule for `testMatch`: the patterns are asked in order and the last one that has a
    /// say decides. A pattern has a say on the paths it matches, a negated one on the paths it
    /// rejects.
    pub(crate) fn matches(&self, path: &[u8]) -> bool {
        // A module that is no file has no place in the project: a `data:` URL, for one.
        if !bun_paths::is_absolute(path) {
            return false;
        }
        let mut buf = bun_paths::path_buffer_pool::get();
        let Some(relative_path) = relative_to(&self.root, path, &mut buf[..]) else {
            return false;
        };
        let mut kept: Option<bool> = None;
        for pattern in &self.patterns {
            let matched = pattern.glob.r#match(relative_path).matches();
            if pattern.negated {
                if !matched {
                    kept = Some(false);
                }
            } else if matched {
                kept = Some(true);
            }
        }
        if self.only_excludes {
            kept != Some(false)
        } else {
            kept == Some(true)
        }
    }
}

impl Pattern {
    /// `root_dir` is what `<rootDir>` stands for, as a glob.
    fn new(pattern: &[u8], root_dir: &[u8]) -> Pattern {
        let bangs = pattern.iter().take_while(|byte| **byte == b'!').count();
        let (bangs, rest) = pattern.split_at(bangs);
        let mut glob = bangs.to_vec();

        // A path relative to the project starts with neither prefix. Jest configs have `<rootDir>`.
        let (rest, has_prefix) = if let Some(rest) = rest.strip_prefix(b"<rootDir>") {
            glob.extend_from_slice(root_dir);
            (rest.strip_prefix(b"/").unwrap_or(rest), true)
        } else if let Some(rest) = rest.strip_prefix(b"./") {
            (rest, true)
        } else {
            (rest, false)
        };

        let is_after_bang = !has_prefix && !bangs.is_empty();
        let rest = with_bare_groups(rest, is_after_bang);
        // What stood behind the prefix is not part of the `!`s in front of it: `!./(old)/**` is
        // not the group `!(old)`, and `./!important/**` is not a negation.
        let joins_the_bangs = match rest.first() {
            Some(b'!') => true,
            Some(b'(') => !bangs.is_empty(),
            _ => false,
        };
        if has_prefix && glob.len() == bangs.len() && joins_the_bangs {
            glob.push(b'\\');
        }
        glob.extend_from_slice(&rest);

        // The same count as the matcher's, where the `!` of a `!(...)` group is not a negation.
        let bangs = glob.iter().take_while(|byte| **byte == b'!').count();
        let group = usize::from(bangs > 0 && glob.get(bangs) == Some(&b'('));
        Pattern {
            negated: (bangs - group) % 2 == 1 || group == 1,
            glob: bun_glob::Prepared::new(glob.into_boxed_slice()),
        }
    }
}

/// Jest's matcher reads `(spec|test)` as the group `@(spec|test)`, and `Bun.Glob` as text. Jest
/// lists are full of them, so a group that has alternatives and no prefix gets the `@`.
/// Parentheses without a `|` stay text: `app/(marketing)/**` is a directory.
fn with_bare_groups(glob: &[u8], is_after_bang: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(glob.len() + 2);
    // The byte before, unless it was escaped.
    let mut before = is_after_bang.then_some(b'!');
    let mut at = 0;
    while at < glob.len() {
        let byte = glob[at];
        if byte == b'\\' {
            out.extend_from_slice(&glob[at..(at + 2).min(glob.len())]);
            before = None;
            at += 2;
            continue;
        }
        if byte == b'[' {
            // A class is copied as it is: `[(|]` has no group in it. The first byte of a class
            // can be a `]`.
            let class_start = at + 2;
            if let Some(close) = (class_start..glob.len()).find(|i| glob[*i] == b']') {
                out.extend_from_slice(&glob[at..=close]);
                before = Some(b']');
                at = close + 1;
                continue;
            }
        }
        let has_prefix = matches!(before, Some(b'?' | b'*' | b'+' | b'@' | b'!'));
        if byte == b'(' && !has_prefix && has_alternatives(&glob[at..]) {
            out.push(b'@');
        }
        out.push(byte);
        before = Some(byte);
        at += 1;
    }
    out
}

/// Whether the group that `glob` starts with has a `|` in it, at any depth.
fn has_alternatives(glob: &[u8]) -> bool {
    let mut depth = 0usize;
    let mut found = false;
    let mut at = 0;
    while at < glob.len() {
        match glob[at] {
            b'\\' => at += 1,
            b'[' => {
                if let Some(close) = (at + 2..glob.len()).find(|i| glob[*i] == b']') {
                    at = close;
                }
            }
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return found;
                }
            }
            b'|' => found = true,
            _ => {}
        }
        at += 1;
    }
    // Never closed: text.
    false
}

/// `path` as a glob that matches only it, with `/` between its parts.
fn escaped(path: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(path.len());
    for &byte in path {
        let byte = if cfg!(windows) && byte == b'\\' {
            b'/'
        } else {
            byte
        };
        if matches!(
            byte,
            b'\\' | b'*' | b'?' | b'[' | b']' | b'{' | b'}' | b'(' | b')' | b'!'
        ) {
            out.push(b'\\');
        }
        out.push(byte);
    }
    out
}

/// `path` from the directory `root`. Both are absolute and normalized, and `root` has no
/// separator at its end. `None` when the answer does not fit `buf`.
///
/// Not `resolve_path::relative`, which answers in a buffer of the thread. This is asked for
/// every module that a test loads, and `TestCommand::run` reads the name of the test file from
/// that buffer for as long as the file runs.
fn relative_to<'a>(root: &[u8], path: &'a [u8], buf: &'a mut [u8]) -> Option<&'a [u8]> {
    let is_separator = |byte: u8| byte == b'/' || (cfg!(windows) && byte == b'\\');
    let is_same = |a: u8, b: u8| {
        a == b
            || (is_separator(a) && is_separator(b))
            || (cfg!(windows) && a.eq_ignore_ascii_case(&b))
    };

    // How much of `root` the two have in common, ending where a directory ends.
    let mut shared = 0;
    let mut at = 0;
    loop {
        if at == root.len() {
            if at == path.len() || is_separator(path[at]) {
                shared = at;
            }
            break;
        }
        if at == path.len() {
            if is_separator(root[at]) {
                shared = at;
            }
            break;
        }
        if !is_same(root[at], path[at]) {
            break;
        }
        if is_separator(root[at]) {
            shared = at;
        }
        at += 1;
    }

    let below = &path[shared..];
    let below = match below.iter().position(|byte| !is_separator(*byte)) {
        Some(start) => &below[start..],
        None => b"",
    };
    // Inside the root, which is nearly every path: the rest of it.
    if shared == root.len() {
        return Some(below);
    }
    let above = root[shared..]
        .split(|byte| is_separator(*byte))
        .filter(|part| !part.is_empty())
        .count();
    let len = above * 3 + below.len();
    if len > buf.len() {
        return None;
    }
    for up in buf[..above * 3].as_chunks_mut::<3>().0 {
        *up = *b"../";
    }
    buf[above * 3..len].copy_from_slice(below);
    Some(&buf[..len])
}
