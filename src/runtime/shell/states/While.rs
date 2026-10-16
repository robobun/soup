//! `while cond; do body; done` and `until cond; do body; done`

use crate::shell::ExitCode;
use crate::shell::ast;
use crate::shell::dispatch_tasks::ShellLoopYieldTask;
use crate::shell::interpreter::{
    Interpreter, LoopJump, LoopJumpKind, Node, NodeId, ShellExecEnv, log,
};
use crate::shell::io::IO;
use crate::shell::states::base::Base;
use crate::shell::states::stmt::Stmt;
use crate::shell::yield_::Yield;

pub(crate) struct While {
    pub(crate) base: Base,
    pub node: bun_ptr::BackRef<ast::While>,
    pub(crate) io: IO,
    pub(crate) state: WhileState,
    /// Status of the last command the condition ran in this round.
    pub(crate) cond_exit_code: ExitCode,
    /// Status of the last command the body ran, 0 if it ran none. The loop exits with it.
    pub(crate) body_exit_code: ExitCode,
    /// Counted in `ShellExecEnv::loop_depth`, from the first condition on.
    pub(crate) entered: bool,
}

#[derive(Default, strum::IntoStaticStr)]
pub(crate) enum WhileState {
    #[default]
    Idle,
    /// About to run statement `stmt_idx` of the condition.
    Cond { stmt_idx: u32 },
    /// About to run statement `stmt_idx` of the body.
    Body { stmt_idx: u32 },
}

enum Action {
    SpawnStmt(*const ast::Stmt),
    YieldToEventLoop,
    Done,
}

impl While {
    pub(crate) fn init(
        interp: &Interpreter,
        shell: *mut ShellExecEnv,
        node: &ast::While,
        parent: NodeId,
        io: IO,
    ) -> NodeId {
        interp.alloc_node(Node::While(While {
            base: Base::new(parent, shell),
            node: bun_ptr::BackRef::new(node),
            io,
            state: WhileState::Idle,
            cond_exit_code: 0,
            body_exit_code: 0,
            entered: false,
        }))
    }

    pub(crate) fn start(_interp: &Interpreter, this: NodeId) -> Yield {
        Yield::Next(this)
    }

    pub(crate) fn next(interp: &Interpreter, this: NodeId) -> Yield {
        let stop = {
            let me = interp.as_while(this);
            !matches!(me.state, WhileState::Idle)
                && (interp.interrupted(this) || me.io.has_broken_pipe())
        };
        if stop {
            let exit_code = interp.as_while(this).body_exit_code;
            return Self::finish(interp, this, exit_code);
        }

        let action = loop {
            let me = interp.as_while_mut(this);
            let node = me.node;
            let n = node.get();
            let (stmts, stmt_idx) = match &mut me.state {
                WhileState::Idle => {
                    me.state = WhileState::Cond { stmt_idx: 0 };
                    me.entered = true;
                    me.base.shell_mut().loop_depth += 1;
                    continue;
                }
                WhileState::Cond { stmt_idx } => {
                    if *stmt_idx as usize >= n.cond.len() {
                        if (me.cond_exit_code == 0) == n.until {
                            break Action::Done;
                        }
                        me.state = WhileState::Body { stmt_idx: 0 };
                        continue;
                    }
                    if *stmt_idx == 0 && interp.loop_round_should_yield() {
                        break Action::YieldToEventLoop;
                    }
                    (&n.cond, stmt_idx)
                }
                WhileState::Body { stmt_idx } => {
                    if *stmt_idx as usize >= n.body.len() {
                        me.state = WhileState::Cond { stmt_idx: 0 };
                        continue;
                    }
                    (&n.body, stmt_idx)
                }
            };
            let stmt = &stmts[*stmt_idx as usize];
            *stmt_idx += 1;
            // `;;` leaves a statement without a command, which has no status of its own.
            if !stmt.exprs.is_empty() {
                break Action::SpawnStmt(stmt);
            }
        };

        match action {
            Action::SpawnStmt(stmt) => {
                let (shell, io) = {
                    let me = interp.as_while(this);
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
                let exit_code = interp.as_while(this).body_exit_code;
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
        interp.deinit_node(child);
        let me = interp.as_while_mut(this);
        let in_cond = matches!(me.state, WhileState::Cond { .. });
        if in_cond {
            me.cond_exit_code = exit_code;
        } else {
            me.body_exit_code = exit_code;
        }

        if let Some(LoopJump { kind, levels }) = me.base.shell_mut().loop_jump.take() {
            // bash: a condition that ends the loop anyway uses the jump up, whichever it is.
            let cond_ends_loop = in_cond && (exit_code == 0) == me.node.get().until;
            if in_cond && !cond_ends_loop {
                // bash: the body counts as run, with the status the condition left.
                me.body_exit_code = exit_code;
            }
            if levels > 1 {
                me.base.shell_mut().loop_jump = Some(LoopJump {
                    kind,
                    levels: levels - 1,
                });
            } else if kind == LoopJumpKind::Continue && !cond_ends_loop {
                me.state = WhileState::Cond { stmt_idx: 0 };
                return Yield::Next(this);
            }
            let exit_code = me.body_exit_code;
            return Self::finish(interp, this, exit_code);
        }

        Yield::Next(this)
    }

    fn finish(interp: &Interpreter, this: NodeId, exit_code: ExitCode) -> Yield {
        let me = interp.as_while_mut(this);
        if core::mem::take(&mut me.entered) {
            me.base.shell_mut().loop_depth -= 1;
        }
        let parent = me.base.parent;
        interp.child_done(parent, this, exit_code)
    }

    pub(crate) fn deinit(_interp: &Interpreter, this: NodeId) {
        log!("While {} deinit", this);
    }
}
