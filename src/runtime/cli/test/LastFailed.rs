//! `bun test --last-failed`: the set of test files that failed in the
//! previous run of this project, kept in the user cache directory as
//! `<cache>/@test@/last-failed-<hash of the project root>.json`:
//! `{ "version": 1, "files": ["relative/path.test.ts"] }`.
//!
//! Every run updates the set for the files it ran: a file that fails is
//! added, a file that passes is removed, a file the run did not touch keeps
//! its entry. So `bun test --last-failed` after a partial run (`--bail`, a
//! path filter, a shard) still knows about the failures it did not rerun.
//! A project whose runs never fail never gets a record.

use std::io::Write as _;

use bun_alloc::Arena as Bump;
use bun_collections::StringArrayHashMap;
use bun_core::{Output, strings};
use bun_parsers::json as bun_json;
use bun_paths::PathBuffer;
use bun_ptr::Interned;
use bun_resolver::fs::FileSystem;
use bun_sys::{Fd, File};

pub struct LastFailed {
    /// Absolute path of the record, or empty when no cache directory resolves.
    path: Box<[u8]>,
    /// Posix-separator paths relative to the project root.
    files: StringArrayHashMap<()>,
    /// Whether the record existed on disk. A run with no failures only writes
    /// when there is a record to clear.
    existed: bool,
    /// Whether this run changed the set.
    dirty: bool,
    /// Key of the file that is running now, for a bail in the middle of it.
    current: Vec<u8>,
}

impl LastFailed {
    pub fn load() -> LastFailed {
        let mut this = LastFailed {
            path: Self::record_path(),
            files: StringArrayHashMap::new(),
            existed: false,
            dirty: false,
            current: Vec::new(),
        };
        if this.path.is_empty() {
            return this;
        }
        let contents = match File::read_from(Fd::cwd(), &this.path) {
            Ok(contents) => contents,
            Err(_) => return this,
        };
        this.existed = true;
        if contents.is_empty() {
            return this;
        }
        bun_ast::initialize_store();
        let source = bun_ast::Source::init_path_string(&this.path[..], &contents[..]);
        let mut log = bun_ast::Log::init();
        if let Ok(parsed) = bun_json::ParsedJson::parse_json(&source, &mut log) {
            let root = &parsed.root;
            if root
                .as_property(b"version")
                .and_then(|v| v.expr.as_number())
                == Some(1.0)
                && let Some(mut iter) = root.get_array(b"files")
            {
                let bump = Bump::new();
                while let Some(item) = iter.next() {
                    if let Some(file) = item.as_string(&bump) {
                        let _ = this.files.put(file, ());
                    }
                }
            }
        }
        bun_ast::Expr::data_store_reset();
        bun_ast::Stmt::data_store_reset();
        this
    }

    fn record_path() -> Box<[u8]> {
        let mut buf = Box::new(PathBuffer::ZEROED);
        let dir_len = bun_jsc::runtime_transpiler_cache::user_cache_dir(&mut buf, b"@test@");
        if dir_len == 0 {
            return Box::default();
        }
        let mut path = buf[..dir_len].to_vec();
        let _ = write!(
            &mut path,
            "{}last-failed-{:016x}.json",
            bun_paths::SEP as char,
            bun_wyhash::hash(FileSystem::get().top_level_dir)
        );
        path.into_boxed_slice()
    }

    fn key_for(abs_path: &[u8]) -> Vec<u8> {
        let rel = bun_paths::resolve_path::relative(FileSystem::get().top_level_dir, abs_path);
        let mut key = rel.to_vec();
        if cfg!(windows) {
            bun_paths::resolve_path::platform_to_posix_in_place(&mut key[..]);
        }
        key
    }

    /// Whether a previous run left a record. False also when no cache
    /// directory resolves, which reads as "no previous run" to the user.
    pub fn has_record(&self) -> bool {
        self.existed
    }

    pub fn count(&self) -> usize {
        self.files.count()
    }

    /// Keeps only the files that failed last time, compacted to the front of
    /// `files`; returns how many were kept. Recorded files that no longer
    /// exist are forgotten, so a deleted test file does not stay in the set.
    pub fn select(&mut self, files: &mut [Interned]) -> usize {
        let mut write = 0;
        let mut seen: StringArrayHashMap<()> = StringArrayHashMap::new();
        for i in 0..files.len() {
            let key = Self::key_for(files[i].as_bytes());
            if self.files.contains(&key) {
                let _ = seen.put(&key, ());
                files[write] = files[i];
                write += 1;
            }
        }
        let top = FileSystem::get().top_level_dir;
        let before = self.files.count();
        self.files.retain(|key, _| {
            seen.contains(key)
                || bun_sys::exists(bun_paths::resolve_path::join_abs::<
                    bun_paths::resolve_path::platform::Auto,
                >(top, key))
        });
        if self.files.count() != before {
            self.dirty = true;
        }
        write
    }

    pub fn record(&mut self, abs_path: &[u8], failed: bool) {
        let key = Self::key_for(abs_path);
        self.record_key(&key, failed);
    }

    fn record_key(&mut self, key: &[u8], failed: bool) {
        let changed = if failed {
            !self.files.contains(key) && self.files.put(key, ()).is_ok()
        } else {
            self.files.swap_remove(key)
        };
        if changed {
            self.dirty = true;
        }
    }

    pub fn begin_file(&mut self, abs_path: &[u8]) {
        self.current = Self::key_for(abs_path);
    }

    /// Records the file that is running now as failed. For an exit before the
    /// runner gets to record it, such as `--bail`.
    pub fn fail_current(&mut self) {
        if !self.current.is_empty() {
            let key = std::mem::take(&mut self.current);
            self.record_key(&key, true);
        }
    }

    /// Writes the record when this run changed it.
    pub fn write(&mut self) {
        if !self.dirty || self.path.is_empty() {
            return;
        }
        self.dirty = false;
        let dest_z = bun_core::ZBox::from_bytes(&self.path);

        self.files
            .sort(|keys, _, a, b| strings::order(&keys[a], &keys[b]).is_lt());
        let mut out: Vec<u8> = Vec::with_capacity(self.files.count() * 48 + 40);
        out.extend_from_slice(b"{\n  \"version\": 1,\n  \"files\": [");
        for (i, key) in self.files.keys().iter().enumerate() {
            let _ = write!(
                &mut out,
                "{}\n    {}",
                if i > 0 { "," } else { "" },
                bun_core::fmt::format_json_string_utf8(key, Default::default()),
            );
        }
        out.extend_from_slice(if self.files.count() > 0 {
            b"\n  ]\n}\n"
        } else {
            b"]\n}\n"
        });

        let mut tmp: Vec<u8> = self.path.to_vec();
        let _ = write!(&mut tmp, ".{}.tmp", std::process::id());
        let tmp_z = bun_core::ZBox::from_vec(tmp);
        let flags =
            bun_sys::O::WRONLY | bun_sys::O::CREAT | bun_sys::O::TRUNC | bun_sys::O::CLOEXEC;
        let result = File::make_open(tmp_z.as_bytes(), flags, 0o666)
            .and_then(|f| f.write_all(&out))
            .and_then(|()| bun_sys::renameat(Fd::cwd(), &tmp_z, Fd::cwd(), &dest_z));
        match result {
            Ok(()) => self.existed = true,
            Err(err) => {
                let _ = bun_sys::unlinkat(Fd::cwd(), &tmp_z);
                Output::warn(&format_args!(
                    "failed to record the failed test files in {}: {}",
                    bstr::BStr::new(&self.path),
                    err
                ));
            }
        }
    }
}
