//! `break [n]` and `continue [n]`
//!
//! Neither unwinds anything itself. It leaves a [`LoopJump`] in the shell env
//! and finishes; the sequencing states between here and the loop finish early
//! on it (`Interpreter::interrupted`), and the loop takes it from there
//! (`For::child_done`).

use std::io::Write as _;

use crate::shell::ExitCode;
use crate::shell::builtin::{Builtin, BuiltinState, Kind};
use crate::shell::interpreter::{Interpreter, LoopJump, LoopJumpKind, NodeId};
use crate::shell::yield_::Yield;

#[derive(Default)]
pub(crate) struct Break {
    exit_code: ExitCode,
}

#[derive(Default)]
pub(crate) struct Continue {
    exit_code: ExitCode,
}

impl Break {
    pub(crate) fn start(interp: &Interpreter, cmd: NodeId) -> Yield {
        match jump(interp, cmd, Kind::Break, LoopJumpKind::Break) {
            Ok(()) => Builtin::done(interp, cmd, 0),
            Err((msg, exit_code)) => {
                Self::state_mut(interp, cmd).exit_code = exit_code;
                Builtin::write_failing_error(interp, cmd, &msg, exit_code)
            }
        }
    }

    pub(crate) fn on_io_writer_chunk(
        interp: &Interpreter,
        cmd: NodeId,
        _: usize,
        _: Option<bun_sys::SystemError>,
    ) -> Yield {
        let exit_code = Self::state_mut(interp, cmd).exit_code;
        Builtin::done(interp, cmd, exit_code)
    }
}

impl Continue {
    pub(crate) fn start(interp: &Interpreter, cmd: NodeId) -> Yield {
        match jump(interp, cmd, Kind::Continue, LoopJumpKind::Continue) {
            Ok(()) => Builtin::done(interp, cmd, 0),
            Err((msg, exit_code)) => {
                Self::state_mut(interp, cmd).exit_code = exit_code;
                Builtin::write_failing_error(interp, cmd, &msg, exit_code)
            }
        }
    }

    pub(crate) fn on_io_writer_chunk(
        interp: &Interpreter,
        cmd: NodeId,
        _: usize,
        _: Option<bun_sys::SystemError>,
    ) -> Yield {
        let exit_code = Self::state_mut(interp, cmd).exit_code;
        Builtin::done(interp, cmd, exit_code)
    }
}

/// Arms the jump. `Err` is what to print and the status to finish with.
///
/// Outside a loop there is nothing to do, which bash reports and does not
/// count as a failure. A count that is not a positive integer is a failure,
/// and as in bash it ends every enclosing loop rather than none.
fn jump(
    interp: &Interpreter,
    cmd: NodeId,
    builtin: Kind,
    kind: LoopJumpKind,
) -> Result<(), (Vec<u8>, ExitCode)> {
    let name = builtin.as_str();
    let depth = Builtin::shell(interp, cmd).loop_depth;
    if depth == 0 {
        return Err((
            format!("{name}: only meaningful in a loop\n").into_bytes(),
            0,
        ));
    }

    let bltn = Builtin::of(interp, cmd);
    let (levels, err) = match bltn.args_slice().len() {
        0 => (1, None),
        1 => {
            let arg = bltn.arg_bytes(0);
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

    interp.as_cmd_mut(cmd).base.shell_mut().loop_jump = Some(LoopJump {
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
