//! `--filter '[<rev>]'`: the workspaces that own a path git reports as changed since `<rev>`.
//!
//! Changed means that the working tree differs from the merge base of `<rev>` and `HEAD` (what is
//! committed, staged or only edited; a deleted file; both ends of a rename), or that the file is
//! untracked and not ignored. Commits that only `<rev>` has do not count.

use bstr::BStr;
use bun_collections::{DynamicBitSet, HashMap};
use bun_core::fmt::escape_control_chars;
use bun_core::{Global, Output, strings};
use bun_paths::path_buffer_pool;
use bun_paths::resolve_path::{join_abs_string_buf, platform};
use bun_spawn::sync as spawn_sync;
use bun_threading::Guarded;

use super::workspace_selection::{Candidate, RootLockfile, Since};

struct Snapshot {
    rev: Box<[u8]>,
    /// The top of the work tree: absolute, posix separators, no trailing slash.
    top: Box<[u8]>,
    /// NUL-terminated paths, relative to `top`.
    paths: Vec<u8>,
}

/// One answer per `<rev>` for the process. A command that selects again after it has written a
/// `package.json` (`bun update -i`, `bun update <glob> --filter`) has to select the same workspaces.
static SNAPSHOTS: Guarded<Vec<Snapshot>> = Guarded::new(Vec::new());

/// Sets in `changed` the members of `selectable` that own a path changed since `rev`. `pattern` is
/// the `--filter` value as it was typed, for the messages.
pub(super) fn mark(
    pattern: &[u8],
    rev: &[u8],
    since: Since<'_>,
    candidates: &[Candidate<'_>],
    selectable: &DynamicBitSet,
    changed: &mut DynamicBitSet,
) {
    let mut snapshots = SNAPSHOTS.lock();
    let index = match snapshots.iter().position(|taken| *taken.rev == *rev) {
        Some(index) => index,
        None => {
            snapshots.push(Snapshot::take(pattern, rev, since.root));
            snapshots.len() - 1
        }
    };
    let snapshot = &snapshots[index];

    let lockfiles: [Vec<u8>; 2] = {
        let mut buf = path_buffer_pool::get();
        [&b"bun.lock"[..], b"bun.lockb"].map(|name| {
            join_abs_string_buf::<platform::Posix>(since.root, &mut buf.0, &[name]).to_vec()
        })
    };

    // Only a workspace that the pattern can select owns a path. A `package.json` without a name
    // inside of a workspace (`{"type": "module"}`) leaves its files to that workspace.
    let mut by_dir: HashMap<&[u8], usize> = HashMap::with_capacity(candidates.len());
    // The directories above a workspace. git reports a submodule and an untracked nested
    // repository as one path, and the workspaces inside of it changed with it.
    let mut above: HashMap<&[u8], ()> = HashMap::new();
    for (i, candidate) in candidates.iter().enumerate() {
        if !selectable.is_set(i) || by_dir.contains_key(candidate.abs_posix_dir) {
            continue;
        }
        by_dir.insert(candidate.abs_posix_dir, i);
        let mut dir = candidate.abs_posix_dir;
        while let Some(parent) = parent_dir(dir) {
            if above.contains_key(parent) {
                break;
            }
            above.insert(parent, ());
            dir = parent;
        }
    }

    let mut abs: Vec<u8> = Vec::new();
    for rel in strings::tokenize(&snapshot.paths, b"\0") {
        abs.clear();
        abs.extend_from_slice(&snapshot.top);
        abs.push(b'/');
        // An untracked nested repository is listed as `dir/`.
        abs.extend_from_slice(strings::without_trailing_slash(rel));

        if lockfiles.contains(&abs) {
            match since.root_lockfile {
                RootLockfile::Ignored => continue,
                RootLockfile::ChangesAll => {
                    selectable.copy_into(changed);
                    return;
                }
            }
        }

        // The deepest workspace that contains the path owns it. The path itself comes first: a
        // workspace that is a submodule is one path.
        let mut dir: Option<&[u8]> = Some(&abs);
        while let Some(at) = dir {
            if let Some(&i) = by_dir.get(at) {
                changed.set(i);
                break;
            }
            dir = parent_dir(at);
        }
        if above.contains_key(&abs[..]) {
            for (i, candidate) in candidates.iter().enumerate() {
                if selectable.is_set(i)
                    && candidate
                        .abs_posix_dir
                        .strip_prefix(&abs[..])
                        .is_some_and(|below| below.first() == Some(&b'/'))
                {
                    changed.set(i);
                }
            }
        }
    }

    // Overlapping `workspaces` entries make one directory two candidates.
    for (i, candidate) in candidates.iter().enumerate() {
        if selectable.is_set(i)
            && by_dir
                .get(candidate.abs_posix_dir)
                .is_some_and(|&first| changed.is_set(first))
        {
            changed.set(i);
        }
    }
}

/// `/a/b` is below `/a`, `/a` is below `/`, and `/` is below nothing.
fn parent_dir(dir: &[u8]) -> Option<&[u8]> {
    match strings::last_index_of_char(dir, b'/')? {
        0 if dir.len() > 1 => Some(&dir[..1]),
        0 => None,
        slash => Some(&dir[..slash]),
    }
}

impl Snapshot {
    fn take(pattern: &[u8], rev: &[u8], root: &[u8]) -> Snapshot {
        check_rev(pattern, rev);
        let git = Git::find(pattern, root);

        // One process for three answers: whether the clone is shallow, the way up to the top of
        // the work tree, and the ids of `HEAD`, of `<rev>` and, as `^<id>`, of each merge base.
        // `<rev>` is asked for again as a commit: for an annotated tag, the first id is the tag's.
        // With the `--`, a word that git cannot resolve is an error and not echoed as a path.
        let range = [rev, b"...HEAD"].concat();
        let commit = [rev, b"^{commit}"].concat();
        let resolved = git.run(
            pattern,
            &[
                b"rev-parse",
                b"--is-shallow-repository",
                b"--show-cdup",
                &range,
                &commit,
                b"--",
            ],
        );
        if !resolved.is_ok() {
            git.fail_unresolved(pattern, rev, &resolved.stderr);
        }
        // A name that is both a tag and a branch resolves, and git only says which one it took.
        for line in strings::tokenize(&resolved.stderr, b"\n") {
            if let Some(warning) = strings::trim(line, b" \t\r").strip_prefix(b"warning: ") {
                bun_core::warn!(
                    "--filter \"{}\": {}",
                    escape_control_chars(pattern),
                    escape_control_chars(warning),
                );
            }
        }

        let mut lines =
            strings::split(&resolved.stdout, b"\n").map(|line| strings::trim(line, b"\r"));
        let shallow = lines.next() == Some(&b"true"[..]);
        let cdup = lines.next().unwrap_or(b"");
        let mut tips: Vec<&[u8]> = Vec::new();
        let mut merge_bases: Vec<&[u8]> = Vec::new();
        for line in lines {
            let (id, ids) = match line.strip_prefix(b"^") {
                Some(id) => (id, &mut merge_bases),
                None => (line, &mut tips),
            };
            if !id.is_empty() && id.iter().all(u8::is_ascii_hexdigit) {
                ids.push(id);
            }
        }
        if merge_bases.is_empty() {
            // Falling back to `<rev>` itself would make the selection depend on the depth of the
            // clone, and these workspaces are what `bun add` and `bun publish` then write to.
            Output::err_generic(
                "--filter \"{}\": \"{}\" and HEAD have no common ancestor in this clone",
                (BStr::new(pattern), BStr::new(rev)),
            );
            if shallow {
                note_shallow();
            }
            Global::crash();
        }
        if shallow {
            // An ancestor that git finds in a shallow clone is an ancestor. It is the merge base
            // when it is one of the two commits, or when no history is missing between it and
            // them. Two of them can be one behind the other with the way between them cut off.
            let certain = match merge_bases[..] {
                [merge_base] => {
                    tips.contains(&merge_base)
                        || git.has_history_between(pattern, &tips, merge_base)
                }
                _ => false,
            };
            if !certain {
                Output::err_generic(
                    "--filter \"{}\": this shallow clone cannot tell where \"{}\" and HEAD parted",
                    (BStr::new(pattern), BStr::new(rev)),
                );
                note_shallow();
                Global::crash();
            }
        }

        let mut top_buf = path_buffer_pool::get();
        let mut top = join_abs_string_buf::<platform::Posix>(root, &mut top_buf.0, &[cdup]);
        while let Some(rest) = top.strip_suffix(b"/") {
            top = rest;
        }

        let mut paths: Vec<u8> = Vec::new();
        // More than one merge base is a criss-cross merge: what changed since any of them counts.
        for merge_base in &merge_bases {
            let diff = git.run(
                pattern,
                &[
                    // A user's `diff.relative` would drop what is outside of the root.
                    b"-c",
                    b"diff.relative=false",
                    // Without the refresh, a file that was only touched is listed.
                    b"-c",
                    b"diff.autoRefreshIndex=true",
                    b"diff",
                    b"--name-only",
                    b"-z",
                    // With rename detection, the workspace a file moved out of is not listed.
                    b"--no-renames",
                    // A submodule counts with a new commit, an edit or an untracked file,
                    // whatever `diff.ignoreSubmodules` and `.gitmodules` say.
                    b"--ignore-submodules=none",
                    merge_base,
                    b"--",
                ],
            );
            if !diff.is_ok() {
                fail(pattern, "diff", &diff.stderr);
            }
            paths.extend_from_slice(&diff.stdout);
        }
        // From the top of the work tree: a workspace can be outside of the root directory, and
        // a pathspec for the top (`:/`) is a file name under `GIT_LITERAL_PATHSPECS`.
        let mut untracked: Vec<&[u8]> = Vec::with_capacity(6);
        if !cdup.is_empty() {
            untracked.extend_from_slice(&[b"-C", cdup]);
        }
        untracked.extend_from_slice(&[b"ls-files", b"--others", b"--exclude-standard", b"-z"]);
        let untracked = git.run(pattern, &untracked);
        if !untracked.is_ok() {
            fail(pattern, "ls-files", &untracked.stderr);
        }
        paths.extend_from_slice(&untracked.stdout);

        Snapshot {
            rev: rev.into(),
            top: top.into(),
            paths,
        }
    }
}

/// Before any process starts: the text goes to git as `<rev>...HEAD`.
fn check_rev(pattern: &[u8], rev: &[u8]) {
    if rev.is_empty() {
        Output::err_generic(
            "--filter \"{}\" is missing a git revision",
            (BStr::new(pattern),),
        );
    } else if strings::contains(rev, b"..") {
        Output::err_generic(
            "--filter \"{}\": \"{}\" is a range, and a filter takes one revision",
            (BStr::new(pattern), BStr::new(rev)),
        );
    } else if matches!(rev[0], b'-' | b'^') || strings::index_of_any(rev, b"\0\n").is_some() {
        Output::err_generic(
            "--filter \"{}\": \"{}\" is not a git revision",
            (BStr::new(pattern), BStr::new(rev)),
        );
    } else if rev[0] == b':' {
        // `:/text` takes the rest of the word, the `...HEAD` too, as the text to look for.
        Output::err_generic(
            "--filter \"{}\": a revision that starts with \":\" is not supported",
            (BStr::new(pattern),),
        );
    } else {
        return;
    }
    bun_core::note!(
        "a filter in brackets selects the workspaces changed since a git revision, as in \"[origin/main]\""
    );
    Global::crash();
}

fn note_shallow() {
    bun_core::note!(
        "a shallow clone does not have the history between them. Fetch more of it, for example with \"git fetch --unshallow\""
    );
}

/// What git said: its `fatal:` line, or else its first line.
fn reason(stderr: &[u8]) -> Option<&[u8]> {
    let mut first = None;
    for line in strings::tokenize(stderr, b"\n") {
        let line = strings::trim(line, b" \t\r");
        if let Some(fatal) = line.strip_prefix(b"fatal: ") {
            return Some(fatal);
        }
        if first.is_none() && !line.is_empty() {
            first = Some(line);
        }
    }
    first
}

fn fail(pattern: &[u8], command: &str, stderr: &[u8]) -> ! {
    match reason(stderr) {
        Some(reason) => Output::err_generic(
            "--filter \"{}\": git {} failed: {}",
            (BStr::new(pattern), command, BStr::new(reason)),
        ),
        None => Output::err_generic(
            "--filter \"{}\": git {} failed",
            (BStr::new(pattern), command),
        ),
    }
    Global::crash();
}

struct Git {
    exe: Box<[u8]>,
    cwd: Box<[u8]>,
    #[cfg(windows)]
    event_loop: bun_event_loop::EventLoopHandle,
}

impl Git {
    fn find(pattern: &[u8], cwd: &[u8]) -> Git {
        let mut buf = path_buffer_pool::get();
        let Some(exe) = bun_which::which(
            &mut buf,
            bun_core::env_var::PATH.get().unwrap_or(b""),
            cwd,
            b"git",
        ) else {
            Output::err_generic(
                "--filter \"{}\" needs git, and git is not in PATH",
                (BStr::new(pattern),),
            );
            Global::crash();
        };
        Git {
            exe: exe.as_bytes().into(),
            cwd: cwd.into(),
            #[cfg(windows)]
            event_loop: spawn_loop(),
        }
    }

    fn run(&self, pattern: &[u8], args: &[&[u8]]) -> spawn_sync::Result {
        let argv: Vec<Box<[u8]>> = [&self.exe[..], b"--no-optional-locks"]
            .into_iter()
            .chain(args.iter().copied())
            .map(Box::from)
            .collect();
        let spawned = spawn_sync::spawn(&spawn_sync::Options {
            argv,
            cwd: self.cwd.clone(),
            stdout: spawn_sync::Stdio::Buffer,
            stderr: spawn_sync::Stdio::Buffer,
            #[cfg(windows)]
            windows: spawn_sync::WindowsOptions {
                loop_: self.event_loop,
                ..Default::default()
            },
            ..Default::default()
        });
        match spawned {
            Ok(Ok(result)) => result,
            Ok(Err(err)) => {
                Output::err_generic(
                    "--filter \"{}\": failed to run git: {}",
                    (BStr::new(pattern), err),
                );
                Global::crash();
            }
            Err(err) => {
                Output::err_generic(
                    "--filter \"{}\": failed to run git: {}",
                    (BStr::new(pattern), err.name()),
                );
                Global::crash();
            }
        }
    }

    /// `git rev-parse <rev>...HEAD` failed: say which part git could not read.
    fn fail_unresolved(&self, pattern: &[u8], rev: &[u8], stderr: &[u8]) -> ! {
        let is_commit = |name: &[u8]| {
            let commit = [name, b"^{commit}"].concat();
            self.run(pattern, &[b"rev-parse", b"--verify", b"--quiet", &commit])
                .is_ok()
        };
        if !self.run(pattern, &[b"rev-parse", b"--git-dir"]).is_ok() {
            match reason(stderr) {
                Some(reason) => Output::err_generic(
                    "--filter \"{}\" needs a git repository: {}",
                    (BStr::new(pattern), BStr::new(reason)),
                ),
                None => Output::err_generic(
                    "--filter \"{}\" needs a git repository",
                    (BStr::new(pattern),),
                ),
            }
        } else if !is_commit(b"HEAD") {
            Output::err_generic(
                "--filter \"{}\": HEAD is not a commit yet",
                (BStr::new(pattern),),
            );
        } else if !is_commit(rev) {
            Output::err_generic(
                "--filter \"{}\": git has no commit \"{}\"",
                (BStr::new(pattern), BStr::new(rev)),
            );
            bun_core::note!(
                "a filter in brackets selects the workspaces changed since a git revision. A shallow or single-branch clone does not have every branch: fetch it first, or clone the full history (\"fetch-depth: 0\" in actions/checkout)"
            );
        } else {
            fail(pattern, "rev-parse", stderr);
        }
        Global::crash();
    }

    /// In a shallow clone: whether every commit that `<rev>` or `HEAD` has and the merge base does
    /// not is there with its parents. Behind a commit that was cut off, the two can meet again.
    fn has_history_between(&self, pattern: &[u8], tips: &[&[u8]], merge_base: &[u8]) -> bool {
        let mut args: Vec<&[u8]> = vec![&b"rev-list"[..], b"--parents"];
        args.extend_from_slice(tips);
        args.extend_from_slice(&[b"--not", merge_base]);
        let listed = self.run(pattern, &args);
        if !listed.is_ok() {
            fail(pattern, "rev-list", &listed.stderr);
        }
        // A commit that git lists without a parent is where the clone was cut off. A first commit
        // looks the same, and more history is asked for then as well.
        strings::tokenize(&listed.stdout, b"\n").all(|line| strings::contains_char(line, b' '))
    }
}

/// On Windows a spawn that captures its output reads the pipes on a uv loop, and selection runs
/// before `bun run --filter` has made one. This is one more handle on the thread's uv loop, kept
/// for the process because the spawned `Process` holds it.
#[cfg(windows)]
fn spawn_loop() -> bun_event_loop::EventLoopHandle {
    use core::sync::atomic::{AtomicPtr, Ordering};

    use bun_event_loop::{AnyEventLoop, EventLoopHandle};

    static LOOP: AtomicPtr<AnyEventLoop> = AtomicPtr::new(core::ptr::null_mut());
    let mut event_loop = LOOP.load(Ordering::Relaxed);
    if event_loop.is_null() {
        event_loop = bun_core::heap::into_raw(Box::new(AnyEventLoop::init()));
        LOOP.store(event_loop, Ordering::Relaxed);
    }
    // SAFETY: allocated above and never freed; only the thread that parses the command line
    // selects workspaces.
    EventLoopHandle::from_any(unsafe { &mut *event_loop })
}
