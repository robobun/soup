//! A background job: `list &`.
//!
//! The job is a root of the node tree (its parent is the interpreter) and runs
//! the list in a subshell environment copied when the `&` ran, so nothing the
//! statement that launched it does afterwards reaches it. The launcher goes on
//! at once (`Yield::Job`). `Interpreter::job_done` is where a job ends.

use crate::shell::ExitCode;
use crate::shell::ast;
use crate::shell::interpreter::{Interpreter, Node, NodeId, ShellExecEnv, log};
use crate::shell::io::IO;
use crate::shell::states::base::Base;
use crate::shell::yield_::Yield;

pub(crate) struct Async {
    /// `shell` is the job's own env.
    pub(crate) base: Base,
    pub node: bun_ptr::BackRef<ast::Expr>,
    pub(crate) io: IO,
    pub(crate) child: Option<NodeId>,
    /// `ShellExecEnv::job_scope` of the env that launched the job: `wait` there waits for it.
    pub(crate) scope: u32,
    /// The `$( )` the job was launched in, if any.
    pub(crate) capture: Option<CaptureOwner>,
}

/// A job writes captured output through raw pointers into the buffer of the
/// `$( )` env around it, so that `$( )` is not done before its last job is
/// (`ShellExecEnv::capture_holds`, `Expansion::child_done`).
#[derive(Clone, Copy)]
pub(crate) struct CaptureOwner {
    pub(crate) env: *mut ShellExecEnv,
    /// The `Expansion` of the `$( )`.
    pub(crate) collector: NodeId,
}

impl Async {
    /// `env` is a copy that the job owns from here on.
    pub(crate) fn init(
        interp: &Interpreter,
        env: *mut ShellExecEnv,
        node: &ast::Expr,
        io: IO,
        scope: u32,
        capture: Option<CaptureOwner>,
    ) -> NodeId {
        let id = interp.alloc_node(Node::Async(Async {
            base: Base::new(NodeId::INTERPRETER, env),
            node: bun_ptr::BackRef::new(node),
            io,
            child: None,
            scope,
            capture,
        }));
        log!("Job {} init", id);
        id
    }

    pub(crate) fn start(interp: &Interpreter, this: NodeId) -> Yield {
        let (shell, io, node) = {
            let me = interp.as_async(this);
            (me.base.shell, me.io.clone(), me.node)
        };
        let (child, y) = interp.spawn_expr(shell, node.get(), this, io);
        interp.as_async_mut(this).child = child;
        y
    }

    /// The list is the only thing a job waits for.
    pub(crate) fn next(_interp: &Interpreter, _this: NodeId) -> Yield {
        Yield::suspended()
    }

    /// The status of a job is dropped: nothing can ask for it yet.
    pub(crate) fn child_done(
        interp: &Interpreter,
        this: NodeId,
        child: NodeId,
        _exit_code: ExitCode,
    ) -> Yield {
        interp.as_async_mut(this).child = None;
        interp.deinit_node(child);
        Self::finish(interp, this)
    }

    /// Also where a job ends whose list did not start (`Interpreter::fail`).
    pub(crate) fn finish(interp: &Interpreter, this: NodeId) -> Yield {
        log!("Job {} done", this);
        let (scope, capture) = {
            let me = interp.as_async(this);
            (me.scope, me.capture)
        };
        interp.deinit_node(this);
        interp.job_done(scope, capture)
    }

    pub(crate) fn deinit(interp: &Interpreter, this: NodeId) {
        let child = interp.as_async_mut(this).child.take();
        if let Some(child) = child {
            interp.deinit_node(child);
        }
        let me = interp.as_async_mut(this);
        if !me.base.shell.is_null() {
            ShellExecEnv::deinit_impl(me.base.shell);
            me.base.shell = core::ptr::null_mut();
        }
    }
}
