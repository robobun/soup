//! `wait`
//!
//! Waits for the jobs (`cmd &`) that the env it runs in launched, and for no
//! others: a subshell, a pipeline member, a `$( )` and a job have launched none
//! when they start, as in sh. The status of a job is not kept, so there is
//! nothing that an operand could name yet.

use std::io::Write as _;

use crate::shell::builtin::{Builtin, BuiltinState, Impl};
use crate::shell::interpreter::{Interpreter, Node, NodeId};
use crate::shell::states::cmd::Exec;
use crate::shell::yield_::Yield;

#[derive(Default)]
pub(crate) struct Wait {
    /// The `ShellExecEnv::job_scope` whose jobs it waits for. 0 while it does not wait.
    parked_on: u32,
}

/// What sh answers for a pid that it did not start.
const NOT_A_CHILD: crate::shell::ExitCode = 127;

impl Wait {
    pub(crate) fn start(interp: &Interpreter, cmd: NodeId) -> Yield {
        let bltn = Builtin::of(interp, cmd);
        if !bltn.args_slice().is_empty() {
            let mut msg = Vec::new();
            let _ = writeln!(
                msg,
                "wait: {}: not a child of this shell",
                bstr::BStr::new(bltn.arg_bytes(0))
            );
            return Builtin::write_failing_error(interp, cmd, &msg, NOT_A_CHILD);
        }

        let scope = Builtin::shell(interp, cmd).job_scope;
        if scope != 0 && interp.park_wait(scope, cmd) {
            // `Interpreter::job_done` finishes it after the last job.
            Self::state_mut(interp, cmd).parked_on = scope;
            return Yield::suspended();
        }
        Builtin::done(interp, cmd, 0)
    }

    pub(crate) fn on_io_writer_chunk(
        interp: &Interpreter,
        cmd: NodeId,
        _: usize,
        _: Option<bun_sys::SystemError>,
    ) -> Yield {
        Builtin::done(interp, cmd, NOT_A_CHILD)
    }

    /// Whether the node at `cmd` is still the `wait` that parked on `scope`.
    pub(crate) fn is_parked(interp: &Interpreter, cmd: NodeId, scope: u32) -> bool {
        let Node::Cmd(node) = interp.node(cmd) else {
            return false;
        };
        let Exec::Builtin(builtin) = &node.exec else {
            return false;
        };
        matches!(&builtin.impl_, Impl::Wait(wait) if wait.parked_on == scope)
    }
}
