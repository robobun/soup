//! `wait`
//!
//! Waits for the jobs (`cmd &`) that the env it runs in launched, and for no
//! others: a subshell, a pipeline member, a `$( )` and a job have launched none
//! when they start, as in sh. The status of a job is not kept, so there is
//! nothing that an operand could name yet.

use bstr::BStr;

use crate::shell::builtin::{Builtin, IoKind, Kind, State};
use crate::shell::interpreter::{Interpreter, Node, NodeId};
use crate::shell::states::cmd::Exec;
use crate::shell::yield_::Yield;

/// What sh answers for a pid that it did not start.
const NOT_A_CHILD: crate::shell::ExitCode = 127;

pub(crate) fn start(interp: &Interpreter, cmd: NodeId) -> Yield {
    if let [pid, ..] = Builtin::of(interp, cmd).args() {
        let pid = BStr::new(pid.get());
        let message = Kind::Wait.message(format_args!("{pid}: not a child of this shell\n"));
        return Builtin::finish(interp, cmd, IoKind::Stderr, &message, NOT_A_CHILD);
    }

    let scope = Builtin::shell(interp, cmd).job_scope;
    if scope != 0 && interp.park_wait(scope, cmd) {
        // `Interpreter::job_done` finishes it after the last job.
        Builtin::of_mut(interp, cmd).state = State::Wait { parked_on: scope };
        return Yield::suspended();
    }
    Builtin::done(interp, cmd, 0)
}

/// Whether the node at `cmd` is still the `wait` that parked on `scope`.
pub(crate) fn is_parked(interp: &Interpreter, cmd: NodeId, scope: u32) -> bool {
    let Node::Cmd(node) = interp.node(cmd) else {
        return false;
    };
    let Exec::Builtin(builtin) = &node.exec else {
        return false;
    };
    matches!(builtin.state, State::Wait { parked_on } if parked_on == scope)
}
