//! https://www.gnu.org/software/bash/manual/bash.html#Bash-Conditional-Expressions

use crate::shell::ExitCode;
use crate::shell::ast;
use crate::shell::interpreter::{Interpreter, Node, NodeId, ShellExecEnv, log};
use crate::shell::io::IO;
use crate::shell::states::base::Base;
use crate::shell::states::expansion::Expansion;
use crate::shell::yield_::Yield;

pub struct CondExpr {
    pub(crate) base: Base,
    pub node: bun_ptr::BackRef<ast::CondExpr>,
    pub(crate) io: IO,
    pub(crate) state: CondExprState,
    pub args: Vec<Vec<u8>>,
}

#[derive(Default, strum::IntoStaticStr)]
pub enum CondExprState {
    #[default]
    Idle,
    ExpandingArgs {
        idx: u32,
    },
    WaitingStat,
    WaitingWriteErr,
}

impl CondExpr {
    pub(crate) fn init(
        interp: &Interpreter,
        shell: *mut ShellExecEnv,
        node: &ast::CondExpr,
        parent: NodeId,
        io: IO,
    ) -> NodeId {
        interp.alloc_node(Node::CondExpr(CondExpr {
            base: Base::new(parent, shell),
            node: bun_ptr::BackRef::new(node),
            io,
            state: CondExprState::Idle,
            args: Vec::new(),
        }))
    }

    pub(crate) fn start(_interp: &Interpreter, this: NodeId) -> Yield {
        Yield::Next(this)
    }

    pub(crate) fn next(interp: &Interpreter, this: NodeId) -> Yield {
        // Expand each arg via Expansion, then evaluate the operator.
        loop {
            let (shell, node) = {
                let me = interp.as_condexpr(this);
                (me.base.shell, me.node)
            };
            let n = node.get();
            match interp.as_condexpr(this).state {
                CondExprState::Idle => {
                    interp.as_condexpr_mut(this).state = CondExprState::ExpandingArgs { idx: 0 };
                    continue;
                }
                CondExprState::ExpandingArgs { idx } => {
                    if (idx as usize) >= n.args.len() {
                        return Self::command_impl_start(interp, this, n.op);
                    }
                    let atom: *const ast::Atom = n.args.get_const(idx as usize);
                    let child = Expansion::init(interp, shell, atom, this, false);
                    return Expansion::start(interp, child);
                }
                CondExprState::WaitingStat => return Yield::suspended(),
                CondExprState::WaitingWriteErr => return Yield::suspended(),
            }
        }
    }

    /// Evaluates the operator against
    /// the expanded `args` and returns the resulting exit code.
    fn command_impl_start(interp: &Interpreter, this: NodeId, op: ast::CondExprOp) -> Yield {
        use ast::CondExprOp as Op;
        let parent = interp.as_condexpr(this).base.parent;
        match op {
            Op::DashB
            | Op::DashC
            | Op::DashD
            | Op::DashE
            | Op::DashF
            | Op::DashH
            | Op::DashCapL
            | Op::DashP
            | Op::DashS
            | Op::DashCapS => {
                // Empty expansion or empty path → exit 1 (bash always
                // gives 1; Windows `stat("")` can succeed and return cwd's
                // stat, so the empty-path check must be explicit).
                let path = interp.as_condexpr(this).args.first().cloned();
                let Some(path) = path.filter(|path| !path.is_empty()) else {
                    return interp.child_done(parent, this, 1);
                };
                let no_follow = matches!(op, Op::DashH | Op::DashCapL);
                Self::do_stat(interp, this, [path, Vec::new()], no_follow)
            }
            Op::DashEf | Op::DashNt | Op::DashOt => {
                // A missing or empty operand is a file that does not exist;
                // `run_from_thread_pool` reports it as such, so `-nt`/`-ot`
                // keep bash's "exists vs. does not exist" answers.
                let paths = {
                    let me = interp.as_condexpr(this);
                    [
                        me.args.first().cloned().unwrap_or_default(),
                        me.args.get(1).cloned().unwrap_or_default(),
                    ]
                };
                Self::do_stat(interp, this, paths, false)
            }
            Op::DashEq | Op::DashNe | Op::DashLt | Op::DashLe | Op::DashGt | Op::DashGe => {
                let parsed = {
                    let me = interp.as_condexpr(this);
                    let lhs = me.args.first().map_or(&[][..], Vec::as_slice);
                    let rhs = me.args.get(1).map_or(&[][..], Vec::as_slice);
                    match (parse_integer_operand(lhs), parse_integer_operand(rhs)) {
                        (Some(lhs), Some(rhs)) => Ok((lhs, rhs)),
                        (None, _) => Err(lhs.to_vec()),
                        (_, None) => Err(rhs.to_vec()),
                    }
                };
                let (lhs, rhs) = match parsed {
                    Ok(operands) => operands,
                    Err(bad) => {
                        return Self::write_failing_error(
                            interp,
                            this,
                            format_args!(
                                "[[: {}: integer expression expected\n",
                                bstr::BStr::new(&bad)
                            ),
                        );
                    }
                };
                let holds = match op {
                    Op::DashEq => lhs == rhs,
                    Op::DashNe => lhs != rhs,
                    Op::DashLt => lhs < rhs,
                    Op::DashLe => lhs <= rhs,
                    Op::DashGt => lhs > rhs,
                    _ => lhs >= rhs,
                };
                interp.child_done(parent, this, if holds { 0 } else { 1 })
            }
            Op::DashZ => {
                let exit = {
                    let me = interp.as_condexpr(this);
                    if me.args.is_empty() || me.args[0].is_empty() {
                        0
                    } else {
                        1
                    }
                };
                interp.child_done(parent, this, exit)
            }
            Op::DashN => {
                let exit = {
                    let me = interp.as_condexpr(this);
                    if !me.args.is_empty() && !me.args[0].is_empty() {
                        0
                    } else {
                        1
                    }
                };
                interp.child_done(parent, this, exit)
            }
            Op::EqEq => {
                let exit = {
                    let me = interp.as_condexpr(this);
                    let is_eq =
                        me.args.is_empty() || (me.args.len() >= 2 && me.args[0] == me.args[1]);
                    if is_eq { 0 } else { 1 }
                };
                interp.child_done(parent, this, exit)
            }
            Op::NotEq => {
                let exit = {
                    let me = interp.as_condexpr(this);
                    let is_neq = me.args.len() >= 2 && me.args[0] != me.args[1];
                    if is_neq { 0 } else { 1 }
                };
                interp.child_done(parent, this, exit)
            }
            _ => {
                debug_assert!(
                    !ast::CondExprOp::is_supported(op),
                    "supported CondExprOp not handled in command_impl_start"
                );
                // Unsupported op is unreachable (parser rejects it).
                interp.child_done(parent, this, 1)
            }
        }
    }

    /// IOWriter completion callback for the error message written in
    /// `WaitingWriteErr`: on write failure finish with the errno as the exit
    /// code, otherwise finish with exit code 1.
    pub(crate) fn on_io_writer_chunk(
        interp: &Interpreter,
        this: NodeId,
        _written: usize,
        err: Option<bun_sys::SystemError>,
    ) -> Yield {
        let parent = interp.as_condexpr(this).base.parent;
        if let Some(e) = err {
            // Recover the positive errno (`to_shell_system_error` negated it).
            let exit_code: ExitCode = e.errno.unsigned_abs() as ExitCode;
            return interp.child_done(parent, this, exit_code);
        }
        if matches!(
            interp.as_condexpr(this).state,
            CondExprState::WaitingWriteErr
        ) {
            return interp.child_done(parent, this, 1);
        }
        crate::shell::interpreter::unreachable_state(
            "CondExpr.onIOWriterChunk",
            <&'static str>::from(&interp.as_condexpr(this).state),
        )
    }

    /// Main-thread re-entry for the off-thread `stat`/`lstat` posted by a
    /// file-test operator. `stats[1]` is only filled in for the binary
    /// operators (`-nt`, `-ot`, `-ef`).
    pub(crate) fn on_stat_task_done(
        interp: &Interpreter,
        this: NodeId,
        stats: &[bun_sys::Result<bun_sys::Stat>; 2],
    ) {
        use ast::CondExprOp as Op;
        debug_assert!(matches!(
            interp.as_condexpr(this).state,
            CondExprState::WaitingStat
        ));
        let op = interp.as_condexpr(this).node.op;
        let [first, second] = stats;
        let holds = match op {
            Op::DashNt => match (first, second) {
                (Ok(a), Ok(b)) => bun_sys::stat_mtime(a)
                    .order(&bun_sys::stat_mtime(b))
                    .is_gt(),
                (Ok(_), Err(_)) => true,
                (Err(_), _) => false,
            },
            Op::DashOt => match (first, second) {
                (Ok(a), Ok(b)) => bun_sys::stat_mtime(a)
                    .order(&bun_sys::stat_mtime(b))
                    .is_lt(),
                (Err(_), Ok(_)) => true,
                (_, Err(_)) => false,
            },
            Op::DashEf => match (first, second) {
                (Ok(a), Ok(b)) => a.st_dev == b.st_dev && a.st_ino == b.st_ino,
                _ => false,
            },
            _ => match first {
                Err(_) => false,
                Ok(st) => {
                    let mode = st.st_mode as _;
                    match op {
                        Op::DashE => true,
                        Op::DashS => st.st_size > 0,
                        Op::DashF => bun_sys::S::ISREG(mode),
                        Op::DashD => bun_sys::S::ISDIR(mode),
                        Op::DashC => bun_sys::S::ISCHR(mode),
                        Op::DashB => bun_sys::S::ISBLK(mode),
                        Op::DashP => bun_sys::S::ISFIFO(mode),
                        Op::DashCapS => bun_sys::S::ISSOCK(mode),
                        Op::DashH | Op::DashCapL => bun_sys::S::ISLNK(mode),
                        _ => unreachable!(
                            "CondExprOp does not need stat(); this indicates a bug in Bun"
                        ),
                    }
                }
            },
        };
        let parent = interp.as_condexpr(this).base.parent;
        interp
            .child_done(parent, this, if holds { 0 } else { 1 })
            .run(interp);
    }

    pub(crate) fn child_done(
        interp: &Interpreter,
        this: NodeId,
        child: NodeId,
        exit_code: ExitCode,
    ) -> Yield {
        // Child is always an Expansion that produced one arg.
        // On nonzero exit, write the failing error and finish; otherwise
        // collect the expanded word and advance.
        if exit_code != 0 {
            // Pull the expansion error out before deiniting the child, then
            // write the failing error.
            let err = Expansion::take_err(interp, child);
            interp.deinit_node(child);
            if let Some(err) = err {
                return Self::write_failing_error(interp, this, format_args!("{}\n", err));
            }
            // Defensive fallback — finish via `writeFailingError` with exit 1.
            debug_assert!(false, "Expansion child failed without an error");
            let parent = interp.as_condexpr(this).base.parent;
            return interp.child_done(parent, this, 1);
        }
        let out = Expansion::take_out(interp, child);
        interp.deinit_node(child);
        {
            let me = interp.as_condexpr_mut(this);
            me.args.push(out.buf);
            if let CondExprState::ExpandingArgs { ref mut idx } = me.state {
                *idx += 1;
            }
        }
        Yield::Next(this)
    }

    /// Heap-allocate a `ShellCondExprStatTask`
    /// and hand it to the work pool; `run_from_thread_pool` performs the
    /// `statat` of every operand, then the main thread resumes via
    /// `ShellCondExprStatTask::run_from_main_thread` → `on_stat_task_done`.
    fn do_stat(
        interp: &Interpreter,
        this: NodeId,
        mut paths: [Vec<u8>; 2],
        no_follow: bool,
    ) -> Yield {
        use crate::shell::dispatch_tasks::{CondExprStatInner, ShellCondExprStatTask};
        use crate::shell::interpreter::ShellTask;
        for path in &mut paths {
            if path.last() != Some(&0) {
                path.push(0);
            }
        }
        let cwd_fd = interp.as_condexpr(this).base.shell().cwd_fd;
        interp.as_condexpr_mut(this).state = CondExprState::WaitingStat;
        let mut task = ShellTask::new(interp.event_loop);
        task.interp = interp.as_ctx_ptr();
        let stat_task = bun_core::heap::alloc(ShellCondExprStatTask {
            task: CondExprStatInner {
                task,
                cond: this,
                paths,
                // Placeholders — overwritten by `run_from_thread_pool` before
                // the main thread reads them.
                stats: [Err(Default::default()), Err(Default::default())],
                no_follow,
                cwd_fd,
            },
        });
        // SAFETY: `stat_task` is a fresh heap allocation embedding `ShellTask`
        // at `TASK_OFFSET`; consumed (heap::take) in
        // `ShellCondExprStatTask::run_from_main_thread`.
        unsafe { ShellTask::schedule::<ShellCondExprStatTask>(stat_task) };
        Yield::suspended()
    }

    /// Same shape as `Builtin::cmd_write_failing_error`: `.fd` stderr
    /// enqueues an async
    /// write and parks in `WaitingWriteErr` (resumed by
    /// `on_io_writer_chunk`); otherwise append to the captured stderr buffer
    /// and finish with exit 1.
    fn write_failing_error(
        interp: &Interpreter,
        this: NodeId,
        args: core::fmt::Arguments<'_>,
    ) -> Yield {
        use crate::shell::io::OutKind;
        use crate::shell::io_writer;
        use std::io::Write as _;
        let mut buf = Vec::new();
        let _ = buf.write_fmt(args);
        if interp.as_condexpr(this).io.stderr.needs_io().is_some() {
            // Only the fd arm transitions state.
            interp.as_condexpr_mut(this).state = CondExprState::WaitingWriteErr;
            let child = io_writer::ChildPtr::new(this, io_writer::WriterTag::CondExpr);
            // `OutKind::Fd` guaranteed by `needs_io()`.
            if let OutKind::Fd(fd) = &interp.as_condexpr(this).io.stderr {
                return fd.writer.enqueue(child, fd.captured, &buf);
            }
            unreachable!()
        }
        // No-IO path: append to the shell env's captured stderr and finish
        // synchronously with exit 1 (matches `on_io_writer_chunk`).
        if let OutKind::Pipe = &interp.as_condexpr(this).io.stderr {
            // SAFETY: single trampoline frame; no other borrow of the env's
            // (or its parent's) stderr buffer is live.
            let stderr = unsafe {
                interp
                    .as_condexpr_mut(this)
                    .base
                    .shell_mut()
                    .buffered_stderr_mut()
            };
            stderr.extend_from_slice(&buf);
        }
        let parent = interp.as_condexpr(this).base.parent;
        interp.child_done(parent, this, 1)
    }

    pub(crate) fn deinit(interp: &Interpreter, this: NodeId) {
        log!("CondExpr {} deinit", this);
        let me = interp.as_condexpr_mut(this);
        me.args.clear();
    }
}

/// Operand of `-eq`, `-ne`, `-lt`, `-le`, `-gt` or `-ge`: an optionally signed
/// decimal integer with optional surrounding whitespace. As in bash's `[[ ]]`,
/// an empty operand (usually an unset variable) counts as 0.
fn parse_integer_operand(arg: &[u8]) -> Option<i64> {
    let arg = arg.trim_ascii();
    let (negative, digits) = match arg.split_first() {
        None => return Some(0),
        Some((b'-', rest)) => (true, rest),
        Some((b'+', rest)) => (false, rest),
        Some(_) => (false, arg),
    };
    if digits.is_empty() {
        return None;
    }
    let mut value: i64 = 0;
    for &byte in digits {
        if !byte.is_ascii_digit() {
            return None;
        }
        let digit = i64::from(byte - b'0');
        value = value.checked_mul(10)?;
        value = if negative {
            value.checked_sub(digit)?
        } else {
            value.checked_add(digit)?
        };
    }
    Some(value)
}

// `runtime::dispatch::run_task`'s `task_tag::ShellCondExprStatTask` arm casts
// the enqueued pointer back to `ShellCondExprStatTask`; both sides MUST agree.
impl bun_event_loop::Taskable for crate::shell::dispatch_tasks::ShellCondExprStatTask {
    const TAG: bun_event_loop::TaskTag = bun_event_loop::task_tag::ShellCondExprStatTask;
    /// A stat the pool finished whose result will not be applied: drop the
    /// keep-alive and the box.
    unsafe fn release_unrun(this: *mut Self) {
        // SAFETY: fn contract — the box `do_stat` scheduled.
        unsafe {
            (*this).task.task.unref_unrun();
            drop(bun_core::heap::take(this));
        }
    }
}

impl crate::shell::interpreter::ShellTaskCtx
    for crate::shell::dispatch_tasks::ShellCondExprStatTask
{
    // The `ShellTask` is embedded one level down (`.task.task`); the dispatch
    // arm (`shell_dispatch!(nested ...)`) walks the same two hops.
    const TASK_OFFSET: usize =
        core::mem::offset_of!(crate::shell::dispatch_tasks::ShellCondExprStatTask, task)
            + core::mem::offset_of!(crate::shell::dispatch_tasks::CondExprStatInner, task);

    fn run_from_thread_pool(this: &mut Self) {
        use crate::shell::interpreter::{shell_lstatat, shell_statat};
        let inner = &mut this.task;
        for (path, stat) in inner.paths.iter().zip(inner.stats.iter_mut()) {
            debug_assert!(path.last() == Some(&0));
            // An empty operand names no file. Windows `stat("")` would report
            // the cwd instead of failing.
            if path.len() <= 1 {
                *stat = Err(bun_sys::Error::new(
                    bun_sys::E::ENOENT,
                    bun_sys::Tag::fstatat,
                ));
                continue;
            }
            let z = bun_core::ZStr::from_buf(path, path.len() - 1);
            *stat = if inner.no_follow {
                shell_lstatat(inner.cwd_fd, z)
            } else {
                shell_statat(inner.cwd_fd, z)
            };
        }
    }

    fn run_from_main_thread(this: *mut Self, interp: &Interpreter) {
        // Delegates to the inherent fn in `dispatch_tasks.rs` (which consumes
        // the heap allocation). The dispatch arm calls the inherent fn
        // directly; this trait method exists to satisfy `ShellTaskCtx`.
        crate::shell::dispatch_tasks::ShellCondExprStatTask::run_from_main_thread(this, interp);
    }
}
