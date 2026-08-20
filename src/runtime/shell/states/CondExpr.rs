//! https://www.gnu.org/software/bash/manual/bash.html#Bash-Conditional-Expressions

use crate::node::fs::stat_embedded_shell_operand;
use crate::shell::ExitCode;
use crate::shell::ast;
use crate::shell::dispatch_tasks::ShellCondExprStatTask;
use crate::shell::interpreter::{Interpreter, Node, NodeId, PoolTask, ShellTask, ShellWork};
use crate::shell::io::IO;
use crate::shell::states::base::{Base, Env};
use crate::shell::states::expansion::Expansion;
use crate::shell::yield_::Yield;

pub(crate) struct CondExpr {
    pub(crate) base: Base,
    pub node: bun_ptr::BackRef<ast::CondExpr>,
    pub(crate) io: IO,
    pub(crate) state: CondExprState,
    pub args: Vec<Vec<u8>>,
    shell: Env,
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
        shell: Env,
        node: &ast::CondExpr,
        parent: NodeId,
        io: IO,
    ) -> NodeId {
        interp.alloc_node(Node::CondExpr(CondExpr {
            base: Base::new(parent),
            shell,
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
                (me.shell.as_ptr(), me.node)
            };
            let n = node.get();
            match interp.as_condexpr(this).state {
                CondExprState::Idle => {
                    interp.as_condexpr_mut(this).state = CondExprState::ExpandingArgs { idx: 0 };
                    continue;
                }
                CondExprState::ExpandingArgs { idx } => {
                    let Some(atom) = n.args.slice().get(idx as usize) else {
                        return Self::command_impl_start(interp, this, n.op);
                    };
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
    fn on_stat_task_done(
        interp: &Interpreter,
        this: NodeId,
        stats: &[bun_sys::Result<bun_sys::Stat>; 2],
        paths: &[Vec<u8>; 2],
    ) -> Yield {
        use ast::CondExprOp as Op;
        debug_assert!(matches!(
            interp.as_condexpr(this).state,
            CondExprState::WaitingStat
        ));
        let op = interp.as_condexpr(this).node.op;
        let cwd = interp.as_condexpr(this).shell.cwd();
        // What the disk lacks, a standalone executable may hold.
        let embedded = [0, 1].map(|i| {
            let operand = paths[i].strip_suffix(b"\0").unwrap_or(&paths[i]);
            match &stats[i] {
                Err(_) if !operand.is_empty() => stat_embedded_shell_operand(cwd, operand),
                _ => None,
            }
        });
        let [first, second] = [0, 1].map(|i| stats[i].as_ref().ok().or(embedded[i].as_ref()));
        let holds = match op {
            Op::DashNt => match (first, second) {
                (Some(a), Some(b)) => bun_sys::stat_mtime(a)
                    .order(&bun_sys::stat_mtime(b))
                    .is_gt(),
                (Some(_), None) => true,
                (None, _) => false,
            },
            Op::DashOt => match (first, second) {
                (Some(a), Some(b)) => bun_sys::stat_mtime(a)
                    .order(&bun_sys::stat_mtime(b))
                    .is_lt(),
                (None, Some(_)) => true,
                (_, None) => false,
            },
            Op::DashEf => match (first, second) {
                (Some(a), Some(b)) => a.st_dev == b.st_dev && a.st_ino == b.st_ino,
                _ => false,
            },
            _ => match first {
                None => false,
                Some(st) => {
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
        interp.child_done(parent, this, if holds { 0 } else { 1 })
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
            debug_assert!(interp.failed(), "Expansion child failed without an error");
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

    /// Stats every operand in one thread pool hop.
    fn do_stat(
        interp: &Interpreter,
        this: NodeId,
        mut paths: [Vec<u8>; 2],
        no_follow: bool,
    ) -> Yield {
        for path in &mut paths {
            if path.last() != Some(&0) {
                path.push(0);
            }
        }
        let cwd_fd = interp.as_condexpr(this).shell.cwd_fd.fd();
        interp.as_condexpr_mut(this).state = CondExprState::WaitingStat;
        let task = ShellCondExprStatTask {
            cond: this,
            paths,
            // Overwritten by `run_from_thread_pool`.
            stats: [Err(Default::default()), Err(Default::default())],
            no_follow,
            cwd_fd,
        };
        PoolTask::schedule(interp, task);
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
        let me = interp.as_condexpr_mut(this);
        if let OutKind::Fd(fd) = &me.io.stderr {
            me.state = CondExprState::WaitingWriteErr;
            let child = io_writer::ChildPtr::new(this, io_writer::WriterTag::CondExpr);
            return fd.writer.enqueue(child, fd.captured, &buf);
        }
        // No-IO path: append to the shell env's captured stderr and finish
        // synchronously with exit 1 (matches `on_io_writer_chunk`).
        if let OutKind::Pipe = &interp.as_condexpr(this).io.stderr {
            // SAFETY: single trampoline frame; no other borrow of the env's
            // (or its parent's) stderr buffer is live.
            let stderr = unsafe { interp.as_condexpr_mut(this).shell.buffered_stderr_mut() };
            stderr.extend_from_slice(&buf);
        }
        let parent = interp.as_condexpr(this).base.parent;
        interp.child_done(parent, this, 1)
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

impl ShellWork for ShellCondExprStatTask {
    const TAG: bun_event_loop::TaskTag = bun_event_loop::task_tag::ShellCondExprStatTask;

    fn run_from_thread_pool(&mut self, _: &ShellTask) {
        use crate::shell::interpreter::{shell_lstatat, shell_statat};
        for (path, stat) in self.paths.iter().zip(self.stats.iter_mut()) {
            // An empty operand names no file. Windows `stat("")` would report
            // the cwd instead of failing.
            if path.len() <= 1 {
                *stat = Err(bun_sys::Error::new(
                    bun_sys::E::ENOENT,
                    bun_sys::Tag::fstatat,
                ));
                continue;
            }
            let z = bun_core::ZStr::from_slice_with_nul(path);
            *stat = if self.no_follow {
                shell_lstatat(self.cwd_fd, z)
            } else {
                shell_statat(self.cwd_fd, z)
            };
        }
    }

    fn run_from_main_thread(&mut self, interp: &Interpreter) -> Yield {
        CondExpr::on_stat_task_done(interp, self.cond, &self.stats, &self.paths)
    }
}
