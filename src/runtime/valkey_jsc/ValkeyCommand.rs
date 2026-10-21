use bun_jsc::{self as jsc, JSGlobalObject, JSValue, JsResult};
use bun_valkey::valkey_protocol as protocol;

use super::protocol_jsc::{ToJSOptions, resp_value_to_js_with_options};

// Note: callers in `js_valkey_functions.rs` construct
// `Vec<crate::node::types::BlobOrStringOrBuffer>` directly, so `Args::Args` must accept
// that exact type. The upstream `bun_jsc::Node::BlobOrStringOrBuffer` re-export is a
// stub; use the real in-crate definition (which already provides `slice()` /
// `byte_length()`).
type BlobOrStringOrBuffer = crate::node::types::BlobOrStringOrBuffer;

// Note: `Command` is a transient view struct; fields
// borrow caller-owned data for the duration of serialization.
#[derive(Copy, Clone)]
pub(crate) struct Command<'a> {
    pub(crate) command: &'a [u8],
    pub args: Args<'a>,
    pub(crate) meta: Meta,
}

#[derive(Copy, Clone)]
pub(crate) enum Args<'a> {
    Slices(&'a [bun_core::Utf8Bytes<'a>]),
    Args(&'a [BlobOrStringOrBuffer]),
    Raw(&'a [&'a [u8]]),
}

impl<'a> Args<'a> {
    fn len(&self) -> usize {
        match self {
            Args::Slices(args) => args.len(),
            Args::Args(args) => args.len(),
            Args::Raw(args) => args.len(),
        }
    }
}

impl<'a> Command<'a> {
    // Always inlined, so that a second caller cannot cost every queued command a call.
    #[inline(always)]
    pub(crate) fn write(&self, writer: &mut impl bun_io::Write) -> Result<(), crate::Error> {
        // Serialize as RESP array format directly
        write!(writer, "*{}\r\n", 1 + self.args.len())?;
        write!(writer, "${}\r\n", self.command.len())?;
        writer.write_all(self.command)?;
        writer.write_all(b"\r\n")?;

        match &self.args {
            Args::Slices(args) => {
                for arg in args.iter() {
                    let bytes = arg.slice();
                    write!(writer, "${}\r\n", bytes.len())?;
                    writer.write_all(bytes)?;
                    writer.write_all(b"\r\n")?;
                }
            }
            Args::Args(args) => {
                for arg in args.iter() {
                    write!(writer, "${}\r\n", arg.byte_length())?;
                    writer.write_all(arg.slice())?;
                    writer.write_all(b"\r\n")?;
                }
            }
            Args::Raw(args) => {
                for arg in args.iter() {
                    write!(writer, "${}\r\n", arg.len())?;
                    writer.write_all(arg)?;
                    writer.write_all(b"\r\n")?;
                }
            }
        }
        Ok(())
    }

    pub(crate) fn byte_length(&self) -> usize {
        // DiscardingWriter is bun_io's byte-counting null sink.
        let mut counter = bun_io::DiscardingWriter::default();
        self.write(&mut counter).expect("unreachable");
        counter.count
    }

    pub(crate) fn serialize(&self) -> Result<Box<[u8]>, crate::Error> {
        let mut buf: Vec<u8> = Vec::with_capacity(self.byte_length());
        self.write(&mut buf)?;
        Ok(buf.into_boxed_slice())
    }
}

/// Command stored in offline queue when disconnected
pub(crate) struct Entry {
    pub(crate) serialized_data: Box<[u8]>, // Pre-serialized RESP protocol bytes
    pub(crate) meta: Meta,
    pub(crate) promise: Promise,
}

// Inherent associated
// types are unstable on stable Rust, so expose as a sibling module alias instead.
pub(crate) mod entry {
    pub(crate) type Queue = std::collections::VecDeque<super::Entry>;
}

impl Entry {
    // Create an Offline by serializing the Valkey command directly
    pub(crate) fn create(command: &Command<'_>, promise: Promise) -> Result<Entry, crate::Error> {
        Ok(Entry {
            serialized_data: command.serialize()?,
            // We should be calling .check against command here but due
            // to a hack introduced to let SUBSCRIBE work, we are not doing that for now.
            meta: command.meta,
            promise,
        })
    }

    /// An entry whose bytes are serialized already.
    pub(crate) fn from_parts(serialized_data: Box<[u8]>, meta: Meta, promise: Promise) -> Entry {
        Entry {
            serialized_data,
            meta,
            promise,
        }
    }
}

bitflags::bitflags! {
    #[repr(transparent)]
    #[derive(Clone, Copy, PartialEq, Eq)]
    pub struct Meta: u8 {
        const RETURN_AS_BOOL          = 1 << 0;
        const SUPPORTS_AUTO_PIPELINING = 1 << 1;
        const RETURN_AS_BUFFER        = 1 << 2;
        const SUBSCRIPTION_REQUEST    = 1 << 3;
        /// The entry holds MULTI, the commands of a transaction and EXEC; see [`UnitPlan`].
        const TRANSACTION_UNIT        = 1 << 5;
        // bit 4 and bits 6..8 are padding
    }
}

impl Default for Meta {
    fn default() -> Self {
        // supports_auto_pipelining defaults to true, rest false.
        Meta::SUPPORTS_AUTO_PIPELINING
    }
}

bun_core::comptime_string_set! {
    /// Commands that must not be auto-pipelined.
    static AUTO_PIPELINE_DISALLOWED_COMMANDS = {
        b"AUTH",
        b"EXEC",
        b"INFO",
        b"QUIT",
        b"MULTI",
        b"WATCH",
        b"SCRIPT",
        b"SELECT",
        b"CLUSTER",
        b"DISCARD",
        b"UNWATCH",
        b"PIPELINE",
        b"SUBSCRIBE",
        b"PSUBSCRIBE",
        b"UNSUBSCRIBE",
        b"UNPSUBSCRIBE",
    };
}

impl Meta {
    pub(crate) fn check(self, command: &Command<'_>) -> Self {
        let mut new = self;
        new.set(
            Meta::SUPPORTS_AUTO_PIPELINING,
            !AUTO_PIPELINE_DISALLOWED_COMMANDS.contains(command.command),
        );
        if is_subscription_command(command.command) {
            new.insert(Meta::SUBSCRIPTION_REQUEST);
        }
        new
    }

    /// `exists()` and its like give a boolean for the integer reply.
    #[inline]
    pub(crate) fn convert_reply(self, value: &mut protocol::RESPValue) {
        if self.contains(Meta::RETURN_AS_BOOL)
            && let protocol::RESPValue::Integer(int_value) = *value
        {
            *value = protocol::RESPValue::Boolean(int_value > 0);
        }
    }

    #[inline]
    pub(crate) fn to_js_options(self) -> ToJSOptions {
        ToJSOptions {
            return_as_buffer: self.contains(Meta::RETURN_AS_BUFFER),
        }
    }
}

/// How the `metas.len() + 2` replies to one [`Meta::TRANSACTION_UNIT`] entry settle its promise.
pub(crate) struct UnitPlan {
    /// Each command's `Meta`, which converts its element of EXEC's reply.
    pub(crate) metas: Box<[Meta]>,
    /// Replies read so far.
    pub(crate) seen: u32,
    /// The error reply to MULTI, after which this MULTI queued nothing.
    pub(crate) multi_error: Option<Box<[u8]>>,
    /// The first error reply to a command.
    pub(crate) queue_error: Option<Box<[u8]>>,
}

impl UnitPlan {
    pub(crate) fn new(metas: Box<[Meta]>) -> Self {
        UnitPlan {
            metas,
            seen: 0,
            multi_error: None,
            queue_error: None,
        }
    }

    /// MULTI, the commands, EXEC.
    pub(crate) fn reply_count(&self) -> usize {
        self.metas.len() + 2
    }
}

pub(crate) mod unit_plan {
    pub(crate) type Queue = std::collections::VecDeque<super::UnitPlan>;
}

#[inline(always)]
fn is_subscription_command(name: &[u8]) -> bool {
    [
        &b"SUBSCRIBE"[..],
        b"PSUBSCRIBE",
        b"SSUBSCRIBE",
        b"UNSUBSCRIBE",
        b"PUNSUBSCRIBE",
        b"SUNSUBSCRIBE",
    ]
    .iter()
    .any(|c| bun_core::strings::eql_case_insensitive_ascii(name, c, true))
}

pub(crate) const MULTI_FRAME: &[u8] = b"*1\r\n$5\r\nMULTI\r\n";
pub(crate) const EXEC_FRAME: &[u8] = b"*1\r\n$4\r\nEXEC\r\n";

/// After MULTI the server runs these six at once instead of queueing them; UNWATCH goes with WATCH.
const NOT_QUEUED_AFTER_MULTI: [&[u8]; 7] = [
    b"MULTI", b"EXEC", b"DISCARD", b"WATCH", b"QUIT", b"RESET", b"UNWATCH",
];

/// A transaction cannot hold these, nor a subscription, which the server answers with pushes.
pub(crate) fn is_refused_in_transaction(command: &Command<'_>) -> bool {
    command
        .meta
        .check(command)
        .contains(Meta::SUBSCRIPTION_REQUEST)
        || NOT_QUEUED_AFTER_MULTI
            .iter()
            .any(|c| bun_core::strings::eql_case_insensitive_ascii(command.command, c, true))
}

/// Promise for a Valkey command
pub(crate) struct Promise {
    pub(crate) meta: Meta,
    pub(crate) promise: jsc::JSPromiseStrong,
}

impl Promise {
    pub(crate) fn create(global_object: &JSGlobalObject, meta: Meta) -> Promise {
        let promise = jsc::JSPromiseStrong::init(global_object);
        Promise { meta, promise }
    }

    pub(crate) fn resolve(
        &mut self,
        global_object: &JSGlobalObject,
        value: &mut protocol::RESPValue,
    ) -> JsResult<()> {
        let options = self.meta.to_js_options();

        let js_value = match resp_value_to_js_with_options(value, global_object, options) {
            Ok(v) => v,
            Err(err) => {
                self.reject(global_object, Ok(global_object.take_error(err)))?;
                return Ok(());
            }
        };
        self.promise.resolve(global_object, js_value)?;
        Ok(())
    }

    pub(crate) fn reject(
        &mut self,
        global_object: &JSGlobalObject,
        jsvalue: JsResult<JSValue>,
    ) -> JsResult<()> {
        self.promise.reject(global_object, jsvalue)?;
        Ok(())
    }
}

// Command+Promise pair for tracking which command corresponds to which promise
pub(crate) struct PromisePair {
    pub(crate) meta: Meta,
    pub(crate) promise: Promise,
}

// See `entry` note above.
pub(crate) mod promise_pair {
    pub(crate) type Queue = std::collections::VecDeque<super::PromisePair>;
}

// Every queued command pays for these two; what only a transaction needs goes in its `UnitPlan`.
const _: () = assert!(
    core::mem::size_of::<PromisePair>()
        == core::mem::size_of::<Promise>() + core::mem::size_of::<usize>()
);
const _: () = assert!(
    core::mem::size_of::<Entry>()
        == core::mem::size_of::<Box<[u8]>>() + core::mem::size_of::<PromisePair>()
);

impl PromisePair {
    pub(crate) fn reject_command(
        &mut self,
        global_object: &JSGlobalObject,
        jsvalue: JSValue,
    ) -> JsResult<()> {
        self.promise.reject(global_object, Ok(jsvalue))?;
        Ok(())
    }
}
