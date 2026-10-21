//! The client without its socket, timers and script: every method returns what is left to do.

use std::collections::VecDeque;

use bun_collections::OffsetByteList;
use bun_core::strings;

use crate::command::{self, ACKS, Ack, Reply, Transaction};
use crate::valkey_protocol::{Push, RESPValue, RedisError, ReplyScanner, ScanResult, ValkeyReader};
use State::{Backoff, Closed, Ending, Idle, Opening, Ready, Select};

const FIRST_DELAY_MS: u32 = 50;
const MAX_DELAY_MS: u32 = 2000;

#[derive(Clone)]
pub struct Config {
    pub username: Box<[u8]>,
    pub password: Box<[u8]>,
    pub database: u32,
    pub idle_timeout_ms: u32,
    pub connection_timeout_ms: u32,
    pub max_retries: u32,
    pub enable_auto_reconnect: bool,
    pub enable_offline_queue: bool,
    pub enable_auto_pipelining: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            username: Box::default(),
            password: Box::default(),
            database: 0,
            idle_timeout_ms: 0,
            connection_timeout_ms: 10000,
            max_retries: 20,
            enable_auto_reconnect: true,
            enable_offline_queue: true,
            enable_auto_pipelining: true,
        }
    }
}

enum State {
    /// Never dialed.
    Idle,
    Opening(Step, Retries),
    /// HELLO was accepted; the reply to SELECT is due.
    Select,
    Ready,
    /// The socket is closing, or the dial gave none: [`Client::lost`] is due.
    Ending(End),
    /// A dial is due, from the retry timer or from `connect()`.
    Backoff(Retries),
    /// Until [`Client::connect`].
    Closed,
}

enum Step {
    /// The socket is connecting, or in its TLS handshake.
    Dial,
    /// HELLO is written, and SELECT behind it if there is a database.
    Hello,
}

/// Since the server last took a connection.
type Retries = u32;

#[derive(Copy, Clone)]
enum End {
    /// The retry policy decides.
    Policy(Retries),
    /// By [`Client::close`]; as [`End::Final`], until [`Client::connect`] takes it back.
    Requested(Retries),
    /// No retry; what is queued until then is rejected.
    Final,
    /// No retry; everything is rejected already, and new commands are refused.
    Failed,
}

#[derive(Copy, Clone)]
enum Expect {
    Reply(Reply),
    /// Whichever acknowledgement comes next: a count would shift every later reply once a peer sent fewer.
    Ack,
    /// The replies to MULTI, to each command and to EXEC, which the first [`Plan`] reads.
    Transaction,
}

struct InFlight<P> {
    expect: Expect,
    promise: P,
}

struct Queued<P> {
    bytes: Box<[u8]>,
    can_pipeline: bool,
    request: InFlight<P>,
}

// Every queued command pays for these two; what only a transaction needs goes in its `Plan`.
const _: () = assert!(size_of::<InFlight<usize>>() == 2 * size_of::<usize>());
const _: () = assert!(
    size_of::<Queued<usize>>()
        == size_of::<Box<[u8]>>() + size_of::<InFlight<usize>>() + size_of::<usize>()
);

/// How the replies to one transaction settle its promise.
struct Plan {
    /// What each command's promise would resolve with.
    replies: Box<[Reply]>,
    /// Replies read so far.
    seen: usize,
    /// The first error reply to MULTI or to a command.
    error: Option<Box<[u8]>>,
}

impl Plan {
    /// Takes one reply. Whether it is the one to EXEC: of those before it, the first error is kept.
    fn read(&mut self, value: &mut RESPValue) -> bool {
        self.seen += 1;
        if self.seen == self.replies.len() + 2 {
            return true;
        }
        if let RESPValue::Error(message) = value
            && self.error.is_none()
        {
            self.error = Some(core::mem::take(message));
        }
        false
    }

    fn memory_cost(&self) -> usize {
        size_of::<Self>() + self.replies.len()
    }
}

/// `P` stands for whoever waits for a command; the client only hands it back.
pub struct Client<P> {
    config: Config,
    state: State,
    is_subscriber: bool,
    output: OffsetByteList,
    input: OffsetByteList,
    /// Resumes over `input`.
    scanner: ReplyScanner,
    in_flight: VecDeque<InFlight<P>>,
    queue: VecDeque<Queued<P>>,
    /// One for each transaction in `in_flight` and `queue`, oldest first. The first transaction makes the queue.
    #[allow(
        clippy::box_collection,
        reason = "a client that sends no transaction pays one word for the queue, not four"
    )]
    plans: Option<Box<VecDeque<Plan>>>,
}

/// Where the replies of one read come from.
pub enum Input<'a> {
    Borrowed(&'a [u8]),
    Buffered,
}

pub enum Event<P> {
    Ignored,
    /// With the reply to HELLO.
    Connected(RESPValue),
    Resolved {
        promise: P,
        value: RESPValue,
        as_buffer: bool,
    },
    Rejected {
        promise: P,
        message: Box<[u8]>,
    },
    /// A transaction ran: the reply to each command, and what that command's promise would resolve with.
    Executed {
        promise: P,
        values: Vec<RESPValue>,
        replies: Box<[Reply]>,
    },
    /// The reply to EXEC is not one for each command. Only the transaction fails: the connection is still in step.
    Invalid {
        promise: P,
        message: Box<[u8]>,
        error: RedisError,
    },
    Message(Vec<RESPValue>),
    /// Has no listeners, but is a microtask checkpoint like a message.
    PatternMessage,
    Subscribed(Acked<P>),
    Unsubscribed(Acked<P>),
    /// For [`Client::fail`].
    Broken {
        message: Box<[u8]>,
        error: RedisError,
    },
}

/// Whom an acknowledgement answers.
pub enum Acked<P> {
    Nobody,
    Channel(P),
    /// Pattern and shard requests resolve with the push itself.
    Raw(P, RESPValue),
}

/// Permission to call [`Client::lost`] once. The next dial cannot start before it is used.
#[must_use]
pub struct Attempt(());

#[must_use]
#[derive(Copy, Clone, PartialEq, Eq)]
pub enum Sent {
    /// In [`Client::output`].
    Buffered,
    /// For [`Client::batch`], once the microtasks have run.
    Batched,
    Queued,
}

#[must_use]
pub enum Close {
    Nothing,
    /// Its close event leads to [`Client::lost`].
    Socket,
    /// There is no socket, only a retry to disarm.
    Retry(Attempt),
}

#[must_use]
pub enum Lost<P> {
    ForGood { reason: Reason, pending: Vec<P> },
    Retry { delay_ms: u32, in_flight: Vec<P> },
}

/// Why no retry follows.
#[derive(Debug)]
pub enum Reason {
    Requested,
    /// The attempt failed for good, or retries are off.
    Final,
    RetriesUsedUp,
}

fn broken<P>(message: &[u8], error: RedisError) -> Event<P> {
    Event::Broken {
        message: message.into(),
        error,
    }
}

/// An error reply to the handshake. One that passes is not `error`: script can try again.
fn refused<P>(message: &[u8], error: RedisError) -> Event<P> {
    const PASSING: [&[u8]; 5] = [
        b"LOADING ",
        b"BUSY ",
        b"MASTERDOWN ",
        b"TRYAGAIN ",
        b"ERR max number of clients",
    ];
    if PASSING.iter().any(|prefix| message.starts_with(prefix)) {
        broken(message, RedisError::ConnectionClosed)
    } else {
        broken(message, error)
    }
}

fn invalid<P>(promise: P, message: &[u8], error: RedisError) -> Event<P> {
    Event::Invalid {
        promise,
        message: message.into(),
        error,
    }
}

impl<P> Client<P> {
    pub fn new(config: Config) -> Self {
        Self {
            config,
            state: Idle,
            is_subscriber: false,
            output: OffsetByteList::default(),
            input: OffsetByteList::default(),
            scanner: ReplyScanner::default(),
            in_flight: VecDeque::new(),
            queue: VecDeque::new(),
            plans: None,
        }
    }

    pub fn config(&self) -> &Config {
        &self.config
    }

    pub fn is_connected(&self) -> bool {
        match self.state {
            Select | Ready => true,
            Idle | Opening(..) | Ending(_) | Backoff(_) | Closed => false,
        }
    }

    fn is_ready(&self) -> bool {
        matches!(self.state, Ready)
    }

    pub fn is_ending(&self) -> bool {
        matches!(self.state, Ending(_))
    }

    /// An event is still to come.
    pub fn is_active(&self) -> bool {
        match self.state {
            Opening(..) | Select | Ready | Ending(_) | Backoff(_) => true,
            Idle | Closed => false,
        }
    }

    fn has_failed(&self) -> bool {
        match self.state {
            Ending(End::Failed) | Closed => true,
            Ending(End::Policy(_) | End::Requested(_) | End::Final) => false,
            Idle | Opening(..) | Select | Ready | Backoff(_) => false,
        }
    }

    pub fn is_subscriber(&self) -> bool {
        self.is_subscriber
    }

    pub fn leave_subscriber_mode(&mut self) {
        self.is_subscriber = false;
    }

    pub fn has_pending_commands(&self) -> bool {
        !self.in_flight.is_empty() || !self.queue.is_empty() || self.buffered_amount() > 0
    }

    pub fn buffered_amount(&self) -> usize {
        self.output.len() + self.input.len()
    }

    pub fn memory_cost(&self) -> usize {
        let plans = self.plans.iter().flat_map(|it| it.iter());
        self.output.byte_list.capacity()
            + self.input.byte_list.capacity()
            + self.in_flight.len() * size_of::<InFlight<P>>()
            + self.queue.len() * size_of::<Queued<P>>()
            + self.queue.iter().map(|it| it.bytes.len()).sum::<usize>()
            + plans.map(Plan::memory_cost).sum::<usize>()
    }

    /// What bounds the current state; 0 for nothing.
    pub fn timeout_ms(&self) -> u32 {
        if self.is_connected() {
            self.config.idle_timeout_ms
        } else if self.has_failed() {
            0
        } else {
            self.config.connection_timeout_ms
        }
    }

    /// An explicit `connect()`, ahead of [`Self::first_dial`] and [`Self::redial`].
    pub fn connect(&mut self) {
        match self.state {
            Backoff(_) | Closed => self.state = Backoff(0),
            // The close of a dial without a TLS context is still due, and no retry can build one.
            Ending(End::Failed) => self.state = Ending(End::Final),
            Ending(End::Requested(retries)) => self.state = Ending(End::Policy(retries)),
            Idle | Opening(..) | Select | Ready | Ending(End::Policy(_) | End::Final) => {}
        }
    }

    pub fn close(&mut self) -> Close {
        let (retries, close) = match self.state {
            Idle | Closed | Ending(End::Requested(_) | End::Final | End::Failed) => {
                return Close::Nothing;
            }
            Ending(End::Policy(retries)) => (retries, Close::Nothing),
            Opening(_, retries) => (retries, Close::Socket),
            Select | Ready => (0, Close::Socket),
            Backoff(retries) => (retries, Close::Retry(Attempt(()))),
        };
        self.state = Ending(End::Requested(retries));
        close
    }

    #[must_use]
    pub fn first_dial(&mut self) -> Option<Attempt> {
        matches!(self.state, Idle).then(|| self.dial(0))
    }

    #[must_use]
    pub fn redial(&mut self) -> Option<Attempt> {
        let Backoff(retries) = self.state else {
            return None;
        };
        Some(self.dial(retries))
    }

    fn dial(&mut self, retries: Retries) -> Attempt {
        self.state = Opening(Step::Dial, retries);
        Attempt(())
    }

    /// The dial gave no socket.
    pub fn dial_failed(&mut self) {
        if let Opening(Step::Dial, retries) = self.state {
            self.state = Ending(End::Policy(retries));
        }
    }

    /// The transport is up. A TLS renegotiation says so again.
    pub fn start(&mut self) {
        let Opening(Step::Dial, retries) = self.state else {
            return;
        };
        self.state = Opening(Step::Hello, retries);
        let Config {
            username,
            password,
            database,
            ..
        } = &self.config;
        let user: &[u8] = if username.is_empty() {
            b"default"
        } else {
            username
        };
        let hello: [&[u8]; 4] = [b"3", b"AUTH", user, password];
        let anonymous = username.is_empty() && password.is_empty();
        let out = &mut self.output.byte_list;
        command::encode(b"HELLO", &hello[..if anonymous { 1 } else { 4 }], out);
        if *database > 0 {
            let mut digits = bun_core::fmt::ItoaBuf::new();
            let database = bun_core::fmt::itoa(&mut digits, *database);
            command::encode(b"SELECT", &[database], out);
        }
    }

    /// Gives up the attempt, if there is one, without a retry: the caller rejects these and closes the socket.
    #[must_use]
    pub fn fail(&mut self) -> Option<Vec<P>> {
        match self.state {
            Idle | Backoff(_) | Ending(End::Failed) | Closed => None,
            Opening(..)
            | Select
            | Ready
            | Ending(End::Policy(_) | End::Requested(_) | End::Final) => {
                self.state = Ending(End::Failed);
                Some(self.take_pending())
            }
        }
    }

    /// The TLS session broke. `Some` if that counts as a lost connection and not as a failed handshake.
    #[must_use]
    pub fn session_broke(&mut self) -> Option<Vec<P>> {
        (self.is_connected() && self.config.enable_auto_reconnect).then(|| self.take_in_flight())
    }

    /// The socket closed, or there never was one.
    pub fn lost(&mut self, Attempt(()): Attempt, owner_is_gone: bool) -> Lost<P> {
        self.output.clear_and_free();
        self.input.clear_and_free();
        self.scanner.reset();

        let policy = match self.state {
            Opening(_, retries) | Ending(End::Policy(retries)) | Backoff(retries) => Ok(retries),
            Select | Ready => Ok(0),
            Ending(End::Requested(_)) => Err(Reason::Requested),
            Idle | Ending(End::Final | End::Failed) | Closed => Err(Reason::Final),
        };
        let reason = match policy {
            Err(over) => over,
            Ok(_) if owner_is_gone || !self.config.enable_auto_reconnect => Reason::Final,
            Ok(retries) if retries >= self.config.max_retries => Reason::RetriesUsedUp,
            Ok(retries) => {
                self.state = Backoff(retries + 1);
                return Lost::Retry {
                    delay_ms: (FIRST_DELAY_MS << retries.min(9)).min(MAX_DELAY_MS),
                    in_flight: self.take_in_flight(),
                };
            }
        };
        self.state = Closed;
        Lost::ForGood {
            reason,
            pending: self.take_pending(),
        }
    }

    fn take_in_flight(&mut self) -> Vec<P> {
        let in_flight = core::mem::take(&mut self.in_flight);
        if let Some(plans) = &mut self.plans {
            for it in &in_flight {
                if matches!(it.expect, Expect::Transaction) {
                    plans.pop_front();
                }
            }
        }
        in_flight.into_iter().map(|it| it.promise).collect()
    }

    fn take_pending(&mut self) -> Vec<P> {
        let mut pending = self.take_in_flight();
        let queue = core::mem::take(&mut self.queue);
        pending.extend(queue.into_iter().map(|it| it.request.promise));
        self.plans = None;
        pending
    }

    /// Why a command cannot be sent or queued now.
    pub fn rejection(&self) -> Option<&'static str> {
        if self.has_failed() {
            Some("Connection has failed")
        } else if !self.is_connected() && !self.config.enable_offline_queue {
            Some("Connection is closed and offline queue is disabled")
        } else {
            None
        }
    }

    /// For a client with no [`Self::rejection`].
    pub fn send<A: AsRef<[u8]>>(
        &mut self,
        name: &[u8],
        args: &[A],
        reply: Reply,
        promise: P,
    ) -> Sent {
        let expect = match ACKS.get_ascii_case_insensitive(name) {
            Some(_) => Expect::Ack,
            None => Expect::Reply(reply),
        };
        let request = InFlight { expect, promise };
        let can_pipeline = command::can_pipeline(name);
        let goes_now = self.goes_now(can_pipeline);

        let mut bytes = Vec::new();
        let out = if goes_now {
            &mut self.output.byte_list
        } else {
            &mut bytes
        };
        command::encode(name, args, out);
        if goes_now {
            self.in_flight.push_back(request);
            return Sent::Buffered;
        }
        self.enqueue(Queued {
            bytes: bytes.into_boxed_slice(),
            can_pipeline,
            request,
        })
    }

    /// As [`Self::send`], for MULTI, the commands and EXEC as one command that can share a write: nothing comes between them.
    pub fn send_transaction(&mut self, transaction: Transaction, promise: P) -> Sent {
        let (bytes, replies) = transaction.finish();
        let plan = Plan {
            replies,
            seen: 0,
            error: None,
        };
        self.plans.get_or_insert_default().push_back(plan);
        let expect = Expect::Transaction;
        let queued = Queued {
            bytes,
            can_pipeline: true,
            request: InFlight { expect, promise },
        };
        if self.goes_now(true) {
            self.put_in_flight(queued);
            return Sent::Buffered;
        }
        self.enqueue(queued)
    }

    /// Whether what is sent now goes to [`Self::output`] at once: it shares no batch, and nothing is ahead of it.
    fn goes_now(&self, can_pipeline: bool) -> bool {
        let batches = can_pipeline && self.config.enable_auto_pipelining;
        !batches && self.is_ready() && self.queue.is_empty() && self.in_flight.is_empty()
    }

    fn enqueue(&mut self, queued: Queued<P>) -> Sent {
        let batches = queued.can_pipeline && self.config.enable_auto_pipelining;
        self.queue.push_back(queued);
        if batches && self.is_connected() {
            Sent::Batched
        } else {
            Sent::Queued
        }
    }

    /// Moves the head of the queue to [`Self::output`] if it travels alone. Whether [`Self::batch`] is due.
    #[must_use]
    pub fn advance(&mut self) -> bool {
        if !self.output.is_empty() || !self.is_ready() {
            return false;
        }
        if self.in_flight.is_empty()
            && let Some(alone) = self.queue.pop_front_if(|it| !it.can_pipeline)
        {
            self.put_in_flight(alone);
        }
        self.queue.front().is_some_and(|it| it.can_pipeline)
    }

    /// Moves what may share a write to [`Self::output`]. Whether to come back.
    #[must_use]
    pub fn batch(&mut self) -> bool {
        if !self.is_connected() {
            return false;
        }
        let batch = self.queue.iter().take_while(|it| it.can_pipeline);
        let len = batch.map(|it| it.bytes.len()).sum();
        self.output.byte_list.reserve(len);
        while let Some(next) = self.queue.pop_front_if(|it| it.can_pipeline) {
            self.put_in_flight(next);
        }
        !self.queue.is_empty()
    }

    fn put_in_flight(&mut self, queued: Queued<P>) {
        self.output.byte_list.extend_from_slice(&queued.bytes);
        self.in_flight.push_back(queued.request);
    }

    /// What the socket has yet to take.
    pub fn output(&self) -> &[u8] {
        self.output.remaining()
    }

    pub fn wrote(&mut self, len: usize) {
        self.output.consume(len);
    }

    /// Copies `data` only if it continues a partial reply.
    pub fn feed<'a>(&mut self, data: &'a [u8]) -> Input<'a> {
        if self.input.is_empty() {
            return Input::Borrowed(data);
        }
        self.input.byte_list.extend_from_slice(data);
        Input::Buffered
    }

    /// `None` once `input` holds no complete reply.
    #[must_use]
    pub fn next_event(&mut self, input: &mut Input<'_>) -> Option<Event<P>> {
        let value = match input {
            Input::Borrowed([]) => return None,
            Input::Borrowed(data) => {
                let mut reader = ValkeyReader::init(data);
                match reader.read_value() {
                    Ok(value) => {
                        *data = &data[reader.pos()..];
                        value
                    }
                    Err(RedisError::InvalidResponse) => {
                        self.scanner.reset();
                        self.input.byte_list.extend_from_slice(data);
                        *data = &[];
                        return None;
                    }
                    Err(error) => {
                        *data = &[];
                        return Some(broken(b"Failed to read data (stack path)", error));
                    }
                }
            }
            Input::Buffered => match self.read_buffered() {
                Ok(value) => value?,
                Err(error) => {
                    *input = Input::Borrowed(&[]);
                    return Some(broken(b"Failed to read data (buffer path)", error));
                }
            },
        };
        Some(self.route(value))
    }

    fn read_buffered(&mut self) -> Result<Option<RESPValue>, RedisError> {
        let buffered = self.input.remaining();
        if buffered.is_empty() || matches!(self.scanner.scan(buffered)?, ScanResult::NeedMoreData) {
            return Ok(None);
        }
        let mut reader = ValkeyReader::init(buffered);
        let value = reader.read_value()?;
        let len = reader.pos();
        self.input.consume(len);
        self.scanner.reset();
        Ok(Some(value))
    }

    fn route(&mut self, value: RESPValue) -> Event<P> {
        match self.state {
            Ready => self.on_reply(value),
            Opening(Step::Hello, _) => self.on_hello(value),
            Select => self.on_select(value),
            Idle | Opening(Step::Dial, _) | Ending(_) | Backoff(_) | Closed => Event::Ignored,
        }
    }

    fn on_hello(&mut self, value: RESPValue) -> Event<P> {
        use RedisError::{AuthenticationFailed, UnsupportedProtocol};
        match value {
            RESPValue::Error(message) => {
                // Redis 5 has no HELLO. It echoes the arguments, and the password is one.
                let echo = strings::split_once(&message, b", with args beginning with");
                let message = echo.map_or(&*message, |(message, _)| message);
                refused(message, AuthenticationFailed)
            }
            RESPValue::SimpleString(ref text) if **text != *b"OK" => broken(
                b"Authentication failed (unexpected response)",
                AuthenticationFailed,
            ),
            RESPValue::Map(ref map)
                if map.iter().any(|entry| {
                    matches!(
                        (&entry.key, &entry.value),
                        (RESPValue::SimpleString(key), RESPValue::Integer(version))
                            if **key == *b"proto" && *version != 3
                    )
                }) =>
            {
                broken(b"Server does not support RESP3", UnsupportedProtocol)
            }
            RESPValue::SimpleString(_) | RESPValue::Map(_) => self.connected(value),
            _ => broken(
                b"Authentication failed with unexpected response",
                AuthenticationFailed,
            ),
        }
    }

    fn on_select(&mut self, value: RESPValue) -> Event<P> {
        match value {
            RESPValue::SimpleString(text) if *text == *b"OK" => {
                self.state = Ready;
                Event::Ignored
            }
            RESPValue::Error(message) => refused(&message, RedisError::InvalidCommand),
            RESPValue::SimpleString(_) => broken(
                b"SELECT command failed with non-OK response",
                RedisError::InvalidResponse,
            ),
            _ => broken(
                b"Received non-SELECT response while in the SELECT state.",
                RedisError::InvalidResponse,
            ),
        }
    }

    fn connected(&mut self, hello: RESPValue) -> Event<P> {
        self.state = if self.config.database > 0 {
            Select
        } else {
            Ready
        };
        Event::Connected(hello)
    }

    fn on_reply(&mut self, value: RESPValue) -> Event<P> {
        match value {
            RESPValue::Push(push) => self.on_push(push),
            // The request it answers stays in flight: `fail` rejects it first.
            RESPValue::Error(message) if self.is_subscriber && !self.reads_transaction() => {
                Event::Broken {
                    message,
                    error: RedisError::ServerError,
                }
            }
            value => self.answer(value),
        }
    }

    /// The next reply is one to a transaction, which keeps its errors to itself.
    fn reads_transaction(&self) -> bool {
        let next = self.in_flight.front().map(|it| it.expect);
        matches!(next, Some(Expect::Transaction))
    }

    fn answer(&mut self, value: RESPValue) -> Event<P> {
        let Some(InFlight { expect, promise }) = self.in_flight.pop_front() else {
            return Event::Ignored;
        };
        match (value, expect) {
            (value, Expect::Transaction) => self.on_transaction_reply(value, promise),
            (RESPValue::Error(message), _) => Event::Rejected { promise, message },
            (RESPValue::Integer(int), Expect::Reply(Reply::Bool)) => Event::Resolved {
                promise,
                value: RESPValue::Boolean(int > 0),
                as_buffer: false,
            },
            (value, expect) => Event::Resolved {
                promise,
                value,
                as_buffer: matches!(expect, Expect::Reply(Reply::Buffer)),
            },
        }
    }

    /// One of the replies to a transaction: the one to MULTI, one for each command, then the one to EXEC.
    #[cold]
    fn on_transaction_reply(&mut self, mut value: RESPValue, promise: P) -> Event<P> {
        let expect = Expect::Transaction;
        let plans = self.plans.as_deref_mut().filter(|it| !it.is_empty());
        let Some(plans) = plans else {
            // `fail` rejects it with the rest.
            self.in_flight.push_front(InFlight { expect, promise });
            return broken(
                b"Received a transaction reply without a transaction",
                RedisError::InvalidResponse,
            );
        };
        let Some(plan) = plans.pop_front_if(|plan| plan.read(&mut value)) else {
            // The transaction waits at the front for the reply to EXEC.
            self.in_flight.push_front(InFlight { expect, promise });
            return Event::Ignored;
        };
        // The error of MULTI or of a command says more than the reply of EXEC to either.
        if let Some(message) = plan.error {
            return Event::Rejected { promise, message };
        }
        let replies = plan.replies;
        match value {
            RESPValue::Error(message) => Event::Rejected { promise, message },
            // A watched key changed: `_`, or `*-1` and `$-1` from a server that answers in RESP2.
            value @ (RESPValue::Null | RESPValue::BulkString(None)) => Event::Resolved {
                promise,
                value,
                as_buffer: false,
            },
            RESPValue::Array(mut values) if values.len() == replies.len() => {
                for (each, reply) in values.iter_mut().zip(replies.iter()) {
                    if *reply == Reply::Bool
                        && let RESPValue::Integer(int) = *each
                    {
                        *each = RESPValue::Boolean(int > 0);
                    }
                }
                Event::Executed {
                    promise,
                    values,
                    replies,
                }
            }
            RESPValue::Array(values) => {
                let message = format!(
                    "EXEC replied with {} replies to a transaction of {} commands",
                    values.len(),
                    replies.len()
                );
                invalid(promise, message.as_bytes(), RedisError::InvalidResponse)
            }
            _ => invalid(
                promise,
                b"EXEC replied with neither an array nor null",
                RedisError::InvalidResponseType,
            ),
        }
    }

    fn on_push(&mut self, push: Push) -> Event<P> {
        let kind = match &*push.kind {
            b"message" if self.is_subscriber => return Event::Message(push.data),
            b"pmessage" | b"smessage" if self.is_subscriber => return Event::PatternMessage,
            kind => ACKS.get(kind),
        };
        let Some(&kind) = kind else {
            return self.on_unknown_push(push);
        };
        let request = self
            .in_flight
            .pop_front_if(|it| matches!(it.expect, Expect::Ack));
        let acked = match request.map(|it| it.promise) {
            None if !self.is_subscriber => return Event::Ignored,
            None => Acked::Nobody,
            Some(promise) if matches!(kind, Ack::Subscribe | Ack::Unsubscribe) => {
                Acked::Channel(promise)
            }
            Some(promise) => Acked::Raw(promise, RESPValue::Push(push)),
        };
        match kind {
            Ack::Subscribe | Ack::PSubscribe | Ack::SSubscribe => {
                self.is_subscriber = true;
                Event::Subscribed(acked)
            }
            Ack::Unsubscribe | Ack::PUnsubscribe | Ack::SUnsubscribe => Event::Unsubscribed(acked),
        }
    }

    fn on_unknown_push(&mut self, push: Push) -> Event<P> {
        // A second prefix (`spsubscribe`) counts as a reply.
        if !matches!(&*push.kind, [b'p' | b's', rest @ ..] if ACKS.get(rest).is_some()) {
            return Event::Ignored;
        }
        match self.in_flight.front().map(|it| it.expect) {
            None | Some(Expect::Reply(_)) if !self.is_subscriber => {
                self.answer(RESPValue::Push(push))
            }
            Some(Expect::Transaction) => self.answer(RESPValue::Push(push)),
            _ => broken(
                b"Unexpected push message kind without promise",
                RedisError::InvalidResponseType,
            ),
        }
    }
}
