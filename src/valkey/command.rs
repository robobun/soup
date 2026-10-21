use bun_core::fmt::{ItoaBuf, digit_count, itoa};
use bun_core::strings;

/// What a command's promise resolves with.
#[derive(Copy, Clone, PartialEq, Eq)]
pub enum Reply {
    Value,
    /// An integer reply, as `reply > 0`.
    Bool,
    /// Strings, as buffers.
    Buffer,
}

/// A subscription command, and the push of the same name that acknowledges it.
#[derive(Copy, Clone, PartialEq, Eq)]
pub(crate) enum Ack {
    Subscribe,
    PSubscribe,
    SSubscribe,
    Unsubscribe,
    PUnsubscribe,
    SUnsubscribe,
}

bun_core::comptime_string_map! {
    pub(crate) static ACKS: Ack = {
        b"subscribe" => Ack::Subscribe,
        b"psubscribe" => Ack::PSubscribe,
        b"ssubscribe" => Ack::SSubscribe,
        b"unsubscribe" => Ack::Unsubscribe,
        b"punsubscribe" => Ack::PUnsubscribe,
        b"sunsubscribe" => Ack::SUnsubscribe,
    };
}

bun_core::comptime_string_set! {
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

pub(crate) fn can_pipeline(name: &[u8]) -> bool {
    !AUTO_PIPELINE_DISALLOWED_COMMANDS.contains(name)
}

/// After MULTI the server runs these six at once instead of queueing them; UNWATCH goes with WATCH.
const NOT_QUEUED_AFTER_MULTI: [&[u8]; 7] = [
    b"MULTI", b"EXEC", b"DISCARD", b"WATCH", b"QUIT", b"RESET", b"UNWATCH",
];

/// MULTI and the commands of a transaction, for `Client::send_transaction` to send with EXEC as one command.
pub struct Transaction {
    bytes: Vec<u8>,
    /// What each command's promise would resolve with.
    replies: Vec<Reply>,
}

impl Default for Transaction {
    fn default() -> Self {
        let mut bytes = Vec::new();
        encode::<&[u8]>(b"MULTI", &[], &mut bytes);
        Self {
            bytes,
            replies: Vec::new(),
        }
    }
}

impl Transaction {
    /// Whether a transaction cannot hold the command: the server would not queue it, or would answer it with pushes.
    pub fn refuses(name: &[u8]) -> bool {
        ACKS.get_ascii_case_insensitive(name).is_some()
            || strings::eql_any_case_insensitive_ascii(name, &NOT_QUEUED_AFTER_MULTI)
    }

    /// For a command that [`Self::refuses`] does not refuse.
    pub fn push<A: AsRef<[u8]>>(&mut self, name: &[u8], args: &[A], reply: Reply) {
        // `encode` reserves what one command takes and no more, which would copy the buffer for each command.
        self.bytes.reserve(encoded_len(name, args));
        encode(name, args, &mut self.bytes);
        self.replies.push(reply);
    }

    /// What it has allocated.
    pub fn capacity(&self) -> usize {
        self.bytes.capacity() + self.replies.capacity()
    }

    /// With EXEC, and what each command's promise would resolve with.
    pub(crate) fn finish(mut self) -> (Box<[u8]>, Box<[Reply]>) {
        encode::<&[u8]>(b"EXEC", &[], &mut self.bytes);
        let (bytes, replies) = (self.bytes, self.replies);
        (bytes.into_boxed_slice(), replies.into_boxed_slice())
    }
}

/// Appends the command as a RESP array, growing `out` at most once.
// Always inlined, so that a second caller, the transaction, cannot cost every command a call.
#[inline(always)]
pub(crate) fn encode<A: AsRef<[u8]>>(name: &[u8], args: &[A], out: &mut Vec<u8>) {
    out.reserve_exact(encoded_len(name, args));
    header(b'*', 1 + args.len(), out);
    bulk(name, out);
    for arg in args {
        bulk(arg.as_ref(), out);
    }
}

#[inline(always)]
fn encoded_len<A: AsRef<[u8]>>(name: &[u8], args: &[A]) -> usize {
    let bulk_lens: usize = args.iter().map(|arg| bulk_len(arg.as_ref())).sum();
    header_len(1 + args.len()) + bulk_len(name) + bulk_lens
}

fn header_len(count: usize) -> usize {
    1 + digit_count(count) + 2
}

fn bulk_len(bytes: &[u8]) -> usize {
    header_len(bytes.len()) + bytes.len() + 2
}

fn header(kind: u8, count: usize, out: &mut Vec<u8>) {
    out.push(kind);
    out.extend_from_slice(itoa(&mut ItoaBuf::new(), count));
    out.extend_from_slice(b"\r\n");
}

fn bulk(bytes: &[u8], out: &mut Vec<u8>) {
    header(b'$', bytes.len(), out);
    out.extend_from_slice(bytes);
    out.extend_from_slice(b"\r\n");
}
