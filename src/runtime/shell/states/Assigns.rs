//! In pipeline expressions, assigns (e.g. `FOO=bar BAR=baz | echo hi`) have
//! no effect on the environment of the shell, so we can skip them.

use crate::shell::ast;
use crate::shell::interpreter::{Interpreter, Node, NodeId, ShellExecEnv, log};
use crate::shell::io::IO;
use crate::shell::states::base::Base;
use crate::shell::states::expansion::Expansion;
use crate::shell::yield_::Yield;
use crate::shell::{EnvStr, ExitCode};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum AssignCtx {
    Cmd,
    Shell,
}

pub(crate) struct Assigns {
    pub(crate) base: Base,
    /// Points into the AST arena, which outlives every state node — `RawSlice`
    /// invariant.
    pub node: bun_ptr::RawSlice<ast::Assign>,
    pub(crate) state: AssignsState,
    pub ctx: AssignCtx,
    /// Where the error of a value that does not expand is written.
    pub(crate) io: IO,
}

#[derive(Default, strum::IntoStaticStr)]
pub(crate) enum AssignsState {
    #[default]
    Idle,
    Expanding {
        idx: u32,
    },
    WaitingWriteErr,
    Done,
}

impl Assigns {
    pub(crate) fn init(
        interp: &Interpreter,
        shell: *mut ShellExecEnv,
        node: &[ast::Assign],
        parent: NodeId,
        ctx: AssignCtx,
        io: IO,
    ) -> NodeId {
        interp.alloc_node(Node::Assigns(Assigns {
            base: Base::new(parent, shell),
            // AST arena outlives every state node — `RawSlice` invariant.
            node: bun_ptr::RawSlice::new(node),
            state: AssignsState::Idle,
            ctx,
            io,
        }))
    }

    pub(crate) fn start(_interp: &Interpreter, this: NodeId) -> Yield {
        Yield::Next(this)
    }

    pub(crate) fn next(interp: &Interpreter, this: NodeId) -> Yield {
        loop {
            let (shell, node) = {
                let me = interp.as_assigns(this);
                (me.base.shell, me.node)
            };
            let assigns = node.slice();
            match interp.as_assigns(this).state {
                AssignsState::Idle => {
                    interp.as_assigns_mut(this).state = AssignsState::Expanding { idx: 0 };
                    continue;
                }
                AssignsState::Expanding { idx } => {
                    if (idx as usize) >= assigns.len() {
                        interp.as_assigns_mut(this).state = AssignsState::Done;
                        continue;
                    }
                    let atom = &assigns[idx as usize].value;
                    let child = Expansion::init(interp, shell, atom, this, true);
                    return Expansion::start(interp, child);
                }
                AssignsState::WaitingWriteErr => return Yield::suspended(),
                AssignsState::Done => {
                    let parent = interp.as_assigns(this).base.parent;
                    return interp.child_done(parent, this, 0);
                }
            }
        }
    }

    pub(crate) fn child_done(
        interp: &Interpreter,
        this: NodeId,
        child: NodeId,
        exit_code: ExitCode,
    ) -> Yield {
        // Child is always an Expansion.
        if exit_code != 0 {
            let err = Expansion::take_err(interp, child);
            interp.deinit_node(child);
            if let Some(err) = err {
                return Self::write_failing_error(interp, this, format_args!("{}\n", err));
            }
            return Self::fail(interp, this, 1);
        }

        let out = Expansion::take_out(interp, child);
        interp.deinit_node(child);

        let (node, ctx) = {
            let me = interp.as_assigns(this);
            (me.node, me.ctx)
        };
        let AssignsState::Expanding { idx } = &mut interp.as_assigns_mut(this).state else {
            unreachable!("Assigns child_done outside Expanding")
        };
        // `idx` was bounds-checked in `next` before spawning the child.
        let label = node.slice()[*idx as usize].label;
        *idx += 1;

        // Join multi-word expansions with a single space. `ExpansionOut` stores all words contiguously in `buf`
        // with `bounds` marking inter-word offsets, so the merged value is
        // `buf` with a space inserted at each boundary.
        let value: Vec<u8> = if out.bounds.is_empty() {
            out.buf
        } else {
            let mut merged = Vec::with_capacity(out.buf.len() + out.bounds.len());
            let mut prev = 0usize;
            for &b in &out.bounds {
                merged.extend_from_slice(&out.buf[prev..b as usize]);
                merged.push(b' ');
                prev = b as usize;
            }
            merged.extend_from_slice(&out.buf[prev..]);
            merged
        };

        let value_ref = EnvStr::init_ref_counted(value.into_boxed_slice());
        interp.as_assigns_mut(this).base.shell_mut().assign_var(
            EnvStr::init_slice(label),
            value_ref,
            ctx,
        );
        value_ref.deref();

        Yield::Next(this)
    }

    /// Nothing after the value that did not expand is assigned.
    fn fail(interp: &Interpreter, this: NodeId, exit_code: ExitCode) -> Yield {
        interp.as_assigns_mut(this).state = AssignsState::Done;
        let parent = interp.as_assigns(this).base.parent;
        interp.child_done(parent, this, exit_code)
    }

    /// Same shape as `For::write_failing_error`: an `.fd` stderr enqueues an
    /// async write and parks in `WaitingWriteErr` (resumed by
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
        if interp.as_assigns(this).io.stderr.needs_io().is_some() {
            interp.as_assigns_mut(this).state = AssignsState::WaitingWriteErr;
            let child = io_writer::ChildPtr::new(this, io_writer::WriterTag::Assigns);
            if let OutKind::Fd(fd) = &interp.as_assigns(this).io.stderr {
                return fd.writer.enqueue(child, fd.captured, &buf);
            }
            unreachable!()
        }
        if let OutKind::Pipe = &interp.as_assigns(this).io.stderr {
            // SAFETY: single trampoline frame; no other borrow of the env's
            // (or its parent's) stderr buffer is live.
            let stderr = unsafe {
                interp
                    .as_assigns_mut(this)
                    .base
                    .shell_mut()
                    .buffered_stderr_mut()
            };
            stderr.extend_from_slice(&buf);
        }
        Self::fail(interp, this, 1)
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
            return Self::fail(interp, this, exit_code);
        }
        if matches!(interp.as_assigns(this).state, AssignsState::WaitingWriteErr) {
            return Self::fail(interp, this, 1);
        }
        crate::shell::interpreter::unreachable_state(
            "Assigns.onIOWriterChunk",
            <&'static str>::from(&interp.as_assigns(this).state),
        )
    }

    pub(crate) fn deinit(_interp: &Interpreter, this: NodeId) {
        log!("Assigns {} deinit", this);
    }
}
