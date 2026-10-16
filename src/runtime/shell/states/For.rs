//! `for name in words; do body; done`
//!
//! The words are expanded once, like the arguments of a command, before the
//! first iteration. Each resulting field is assigned to `name` as a shell
//! variable and the body runs with it. `name` keeps its last value after the
//! loop, as in POSIX sh.

use crate::shell::ast;
use crate::shell::dispatch_tasks::ShellLoopYieldTask;
use crate::shell::interpreter::{
    Interpreter, LoopJump, LoopJumpKind, Node, NodeId, ShellExecEnv, StateKind, log,
};
use crate::shell::io::IO;
use crate::shell::states::assigns::AssignCtx;
use crate::shell::states::base::Base;
use crate::shell::states::expansion::Expansion;
use crate::shell::states::stmt::Stmt;
use crate::shell::yield_::Yield;
use crate::shell::{EnvStr, ExitCode};

pub(crate) struct For {
    pub(crate) base: Base,
    pub node: bun_ptr::BackRef<ast::For>,
    pub(crate) io: IO,
    pub(crate) state: ForState,
    /// The fields the word list expanded to, one iteration each.
    pub(crate) items: Vec<Vec<u8>>,
    /// Status of the last command the body ran, 0 if it ran none.
    pub(crate) last_exit_code: ExitCode,
    /// The body is running, so this loop counts towards `ShellExecEnv::loop_depth`.
    pub(crate) entered: bool,
}

#[derive(Default, strum::IntoStaticStr)]
pub(crate) enum ForState {
    #[default]
    Idle,
    ExpandingWords {
        idx: u32,
    },
    /// About to run statement `stmt_idx` of the body for `items[item_idx]`.
    Body {
        item_idx: usize,
        stmt_idx: u32,
    },
    WaitingWriteErr,
}

enum Action<'a> {
    Expand(&'a ast::Atom),
    SpawnStmt(&'a ast::Stmt),
    YieldToEventLoop,
    Done,
}

impl For {
    pub(crate) fn init(
        interp: &Interpreter,
        shell: *mut ShellExecEnv,
        node: &ast::For,
        parent: NodeId,
        io: IO,
    ) -> NodeId {
        interp.alloc_node(Node::For(For {
            base: Base::new(parent, shell),
            node: bun_ptr::BackRef::new(node),
            io,
            state: ForState::Idle,
            items: Vec::new(),
            last_exit_code: 0,
            entered: false,
        }))
    }

    pub(crate) fn start(_interp: &Interpreter, this: NodeId) -> Yield {
        Yield::Next(this)
    }

    pub(crate) fn next(interp: &Interpreter, this: NodeId) -> Yield {
        // The script may have been stopped while the loop was off the thread.
        let stop = {
            let me = interp.as_for(this);
            matches!(me.state, ForState::Body { .. })
                && (interp.interrupted(this) || me.io.has_broken_pipe())
        };
        if stop {
            let exit_code = interp.as_for(this).last_exit_code;
            return Self::finish(interp, this, exit_code);
        }
        // Copy the BackRef out so that what `action` borrows from the AST outlives `me`.
        let node = interp.as_for(this).node;
        let n = node.get();
        let action = loop {
            let me = interp.as_for_mut(this);
            match &mut me.state {
                ForState::Idle => {
                    me.state = ForState::ExpandingWords { idx: 0 };
                }
                ForState::ExpandingWords { idx } => {
                    if let Some(word) = n.words.get(*idx as usize) {
                        break Action::Expand(word);
                    }
                    me.state = ForState::Body {
                        item_idx: 0,
                        stmt_idx: 0,
                    };
                    me.entered = true;
                    me.base.shell_mut().loop_depth += 1;
                }
                ForState::Body { item_idx, stmt_idx } => {
                    if *item_idx >= me.items.len() {
                        break Action::Done;
                    }
                    if *stmt_idx as usize >= n.body.len() {
                        *item_idx += 1;
                        *stmt_idx = 0;
                        continue;
                    }
                    let stmt = &n.body[*stmt_idx as usize];
                    if *stmt_idx == 0 {
                        if interp.loop_round_should_yield() {
                            break Action::YieldToEventLoop;
                        }
                        let value = core::mem::take(&mut me.items[*item_idx]);
                        let value = EnvStr::init_ref_counted(value.into_boxed_slice());
                        me.base.shell_mut().assign_var(
                            EnvStr::init_slice(n.var),
                            value,
                            AssignCtx::Shell,
                        );
                        value.deref();
                    }
                    *stmt_idx += 1;
                    break Action::SpawnStmt(stmt);
                }
                ForState::WaitingWriteErr => return Yield::suspended(),
            }
        };

        match action {
            Action::Expand(word) => {
                let shell = interp.as_for(this).base.shell;
                let child = Expansion::init(interp, shell, word, this, false);
                Expansion::start(interp, child)
            }
            Action::SpawnStmt(stmt) => {
                let (shell, io) = {
                    let me = interp.as_for(this);
                    (me.base.shell, me.io.clone())
                };
                let child = Stmt::init(interp, shell, stmt, this, io);
                Stmt::start(interp, child)
            }
            Action::YieldToEventLoop => {
                ShellLoopYieldTask::enqueue(interp, this);
                Yield::suspended()
            }
            Action::Done => {
                let exit_code = interp.as_for(this).last_exit_code;
                Self::finish(interp, this, exit_code)
            }
        }
    }

    pub(crate) fn child_done(
        interp: &Interpreter,
        this: NodeId,
        child: NodeId,
        exit_code: ExitCode,
    ) -> Yield {
        if matches!(interp.node(child).kind(), StateKind::Expansion) {
            return Self::word_expanded(interp, this, child, exit_code);
        }

        interp.deinit_node(child);
        let jump = {
            let me = interp.as_for_mut(this);
            me.last_exit_code = exit_code;
            me.base.shell_mut().loop_jump.take()
        };
        match jump {
            Some(LoopJump { kind, levels }) if levels > 1 => {
                // Meant for a loop further out: leave this one and pass it on.
                interp.as_for_mut(this).base.shell_mut().loop_jump = Some(LoopJump {
                    kind,
                    levels: levels - 1,
                });
                return Self::finish(interp, this, exit_code);
            }
            Some(LoopJump {
                kind: LoopJumpKind::Break,
                ..
            }) => return Self::finish(interp, this, exit_code),
            Some(LoopJump {
                kind: LoopJumpKind::Continue,
                ..
            }) => {
                if let ForState::Body { item_idx, stmt_idx } = &mut interp.as_for_mut(this).state {
                    *item_idx += 1;
                    *stmt_idx = 0;
                }
            }
            None => {}
        }
        if interp.interrupted(this) {
            return Self::finish(interp, this, exit_code);
        }
        Yield::Next(this)
    }

    fn word_expanded(
        interp: &Interpreter,
        this: NodeId,
        child: NodeId,
        exit_code: ExitCode,
    ) -> Yield {
        if exit_code != 0 {
            let err = Expansion::take_err(interp, child);
            interp.deinit_node(child);
            if let Some(err) = err {
                return Self::write_failing_error(interp, this, format_args!("{}\n", err));
            }
            debug_assert!(
                interp.interrupted(this),
                "Expansion child failed without an error"
            );
            return Self::finish(interp, this, 1);
        }

        let out = Expansion::take_out(interp, child);
        interp.deinit_node(child);
        if interp.interrupted(this) {
            return Self::finish(interp, this, exit_code);
        }
        let me = interp.as_for_mut(this);
        if out.bounds.is_empty() {
            // `$unset` expands to no field at all, `""` to one empty field.
            if !out.buf.is_empty() || out.has_quoted_empty {
                me.items.push(out.buf);
            }
        } else {
            let mut prev = 0usize;
            for &b in &out.bounds {
                me.items.push(out.buf[prev..b as usize].to_vec());
                prev = b as usize;
            }
            me.items.push(out.buf[prev..].to_vec());
        }
        if let ForState::ExpandingWords { idx } = &mut me.state {
            *idx += 1;
        }
        Yield::Next(this)
    }

    fn finish(interp: &Interpreter, this: NodeId, exit_code: ExitCode) -> Yield {
        let me = interp.as_for_mut(this);
        if core::mem::take(&mut me.entered) {
            me.base.shell_mut().loop_depth -= 1;
        }
        let parent = me.base.parent;
        interp.child_done(parent, this, exit_code)
    }

    /// Same shape as `CondExpr::write_failing_error`: an `.fd` stderr enqueues
    /// an async write and parks in `WaitingWriteErr` (resumed by
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
        if interp.as_for(this).io.stderr.needs_io().is_some() {
            interp.as_for_mut(this).state = ForState::WaitingWriteErr;
            let child = io_writer::ChildPtr::new(this, io_writer::WriterTag::For);
            if let OutKind::Fd(fd) = &interp.as_for(this).io.stderr {
                return fd.writer.enqueue(child, fd.captured, &buf);
            }
            unreachable!()
        }
        if let OutKind::Pipe = &interp.as_for(this).io.stderr {
            // SAFETY: single trampoline frame; no other borrow of the env's
            // (or its parent's) stderr buffer is live.
            let stderr = unsafe {
                interp
                    .as_for_mut(this)
                    .base
                    .shell_mut()
                    .buffered_stderr_mut()
            };
            stderr.extend_from_slice(&buf);
        }
        Self::finish(interp, this, 1)
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
        if let Some(e) = err {
            // Recover the positive errno (`to_shell_system_error` negated it).
            let exit_code: ExitCode = e.errno.unsigned_abs() as ExitCode;
            return Self::finish(interp, this, exit_code);
        }
        if matches!(interp.as_for(this).state, ForState::WaitingWriteErr) {
            return Self::finish(interp, this, 1);
        }
        crate::shell::interpreter::unreachable_state(
            "For.onIOWriterChunk",
            <&'static str>::from(&interp.as_for(this).state),
        )
    }

    pub(crate) fn deinit(_interp: &Interpreter, this: NodeId) {
        log!("For {} deinit", this);
    }
}
