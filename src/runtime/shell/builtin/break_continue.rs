//! `break [n]` and `continue [n]`
//!
//! Neither unwinds anything itself. It leaves a [`LoopJump`] in the shell env
//! and finishes; the sequencing states between here and the loop finish early
//! on it (`Interpreter::interrupted`), and the loop takes it from there
//! (`For::child_done`, `While::child_done`).

use std::io::Write as _;

use crate::shell::ExitCode;
use crate::shell::builtin::{Builtin, IoKind, Kind};
use crate::shell::interpreter::{Interpreter, LoopJump, LoopJumpKind, NodeId};
use crate::shell::yield_::Yield;

/// `builtin` is [`Kind::Break`] or [`Kind::Continue`].
pub(crate) fn start(interp: &Interpreter, cmd: NodeId, builtin: Kind) -> Yield {
    match jump(interp, cmd, builtin) {
        Ok(()) => Builtin::done(interp, cmd, 0),
        Err((msg, exit_code)) => Builtin::finish(interp, cmd, IoKind::Stderr, &msg, exit_code),
    }
}

/// Arms the jump. `Err` is what to print and the status to finish with.
///
/// Outside a loop there is nothing to do, which bash reports and does not
/// count as a failure. A count that is not a positive integer is a failure,
/// and as in bash it ends every enclosing loop rather than none.
fn jump(interp: &Interpreter, cmd: NodeId, builtin: Kind) -> Result<(), (Vec<u8>, ExitCode)> {
    let name = builtin.as_str();
    let kind = match builtin {
        Kind::Continue => LoopJumpKind::Continue,
        _ => LoopJumpKind::Break,
    };
    let depth = Builtin::shell(interp, cmd).loop_depth;
    if depth == 0 {
        return Err((
            format!("{name}: only meaningful in a loop\n").into_bytes(),
            0,
        ));
    }

    let (levels, err) = match Builtin::of(interp, cmd).args() {
        [] => (1, None),
        [arg] => {
            let arg = arg.get();
            match bun_core::fmt::parse_decimal::<i64>(arg) {
                Some(n) if n >= 1 => (u32::try_from(n).unwrap_or(u32::MAX).min(depth), None),
                Some(_) => {
                    let mut msg = Vec::new();
                    let _ = writeln!(
                        msg,
                        "{name}: {}: loop count out of range",
                        bstr::BStr::new(arg)
                    );
                    (depth, Some(msg))
                }
                None => {
                    let mut msg = Vec::new();
                    let _ = writeln!(
                        msg,
                        "{name}: {}: numeric argument required",
                        bstr::BStr::new(arg)
                    );
                    (depth, Some(msg))
                }
            }
        }
        _ => (
            depth,
            Some(format!("{name}: too many arguments\n").into_bytes()),
        ),
    };

    interp.as_cmd_mut(cmd).shell.loop_jump = Some(LoopJump {
        kind: if err.is_some() {
            LoopJumpKind::Break
        } else {
            kind
        },
        levels,
    });
    match err {
        Some(msg) => Err((msg, 1)),
        None => Ok(()),
    }
}
