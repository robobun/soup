//! The option walker of the builtins that take options with values
//! (`sort -k2`, `uniq --skip-fields=1`): POSIX utility syntax, in which the
//! options come before the operands.

use crate::shell::builtin::{Arg, Builtin, Kind};
use crate::shell::interpreter::{Interpreter, NodeId};

/// Walks the argv of a builtin: `--` ends the options, the first
/// argument that does not start with `-` (or is `-` alone) starts the
/// operands. Short options may take their value in the same argument
/// (`-k2`, `-t,`) or the next one; long ones as `--key=2` or the next
/// argument.
pub(crate) struct ArgParser<'a> {
    /// [`Builtin::args`]: what the indices here count.
    args: &'a [Arg],
    kind: Kind,
    i: usize,
}

impl<'a> ArgParser<'a> {
    pub(crate) fn new(interp: &'a Interpreter, cmd: NodeId, kind: Kind) -> Self {
        Self {
            args: Builtin::of(interp, cmd).args(),
            kind,
            i: 0,
        }
    }

    pub(crate) fn arg(&self, i: usize) -> &'a [u8] {
        self.args[i].get()
    }

    pub(crate) fn error(&self, args: core::fmt::Arguments<'_>) -> Vec<u8> {
        self.kind.message(format_args!("{args}\n"))
    }

    pub(crate) fn illegal(&self, opt: &[u8]) -> Vec<u8> {
        self.error(format_args!("illegal option -- {}", bstr::BStr::new(opt)))
    }

    pub(crate) fn unsupported(&self, opt: &[u8]) -> Vec<u8> {
        self.error(format_args!(
            "unsupported option, please open a GitHub issue -- {}",
            bstr::BStr::new(opt)
        ))
    }

    /// The next option argument, or `None` once the operands start.
    pub(crate) fn next_option(&mut self) -> Option<&'a [u8]> {
        if self.i >= self.args.len() {
            return None;
        }
        let arg = self.arg(self.i);
        if arg == b"--" {
            self.i += 1;
            return None;
        }
        if arg.len() < 2 || arg[0] != b'-' {
            return None;
        }
        self.i += 1;
        Some(arg)
    }

    /// The value of a long option: after its `=`, or the next argument.
    pub(crate) fn long_value(
        &mut self,
        name: &[u8],
        inline: Option<&'a [u8]>,
    ) -> Result<&'a [u8], Vec<u8>> {
        if let Some(value) = inline {
            return Ok(value);
        }
        if self.i >= self.args.len() {
            return Err(self.error(format_args!(
                "option '{}' requires an argument",
                bstr::BStr::new(name)
            )));
        }
        self.i += 1;
        Ok(self.arg(self.i - 1))
    }

    /// The value of a short option: the rest of its cluster, or the next
    /// argument.
    pub(crate) fn short_value(&mut self, letter: u8, rest: &'a [u8]) -> Result<&'a [u8], Vec<u8>> {
        if !rest.is_empty() {
            return Ok(rest);
        }
        if self.i >= self.args.len() {
            return Err(self.error(format_args!(
                "option requires an argument -- {}",
                letter as char
            )));
        }
        self.i += 1;
        Ok(self.arg(self.i - 1))
    }

    pub(crate) fn operands(&self) -> impl Iterator<Item = usize> + use<'_> {
        self.i..self.args.len()
    }
}

/// `--name=value` as its name and its value.
pub(crate) fn split_long(arg: &[u8]) -> (&[u8], Option<&[u8]>) {
    match bun_core::strings::split_once_char(arg, b'=') {
        Some((name, value)) => (name, Some(value)),
        None => (arg, None),
    }
}
