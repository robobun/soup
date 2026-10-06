// Bun.Queue: a message queue kept in a SQLite database.
//
// A message is one row of the table `bun_queue`. The row leaves the table when a consumer
// acknowledges the message. Until then `visible_at` says when it may next be delivered:
//
//   - sent with a delay: `visible_at` is the time the delay ends
//   - claimed by a consumer: `visible_at` is the time its lease ends, `lease` names the claim,
//     and `attempts` counts the deliveries so far
//   - retried: `visible_at` is the time the retry delay ends, and `lease` is NULL again
//
// A consumer claims every message with `visible_at <= now`, so a message whose consumer died is
// simply delivered again once its lease has run out. A consumer that is alive extends the leases
// of the messages it still works on. Every write checks `lease`, so a claim that lost its lease
// cannot acknowledge a message that somebody else now holds.
//
// Several processes can use one file. SQLite has no way to tell another process that a row was
// inserted, so a consumer of a file looks every POLL_INTERVAL milliseconds. Inside one thread a
// send() wakes the consumers of that queue directly.

import type * as BunSQLiteModule from "bun:sqlite";

type Statement = BunSQLiteModule.Statement;

const AsyncContextFrame = require("internal/async_context_frame");
const isFrameOfStoppedModuleGraph = $newCppFunction("ModuleGraph.cpp", "jsFunctionIsFrameOfStoppedModuleGraph", 1);

const { randomUUIDv7, sleepSync } = Bun;
const ArrayBufferIsView = ArrayBuffer.isView;
const ArrayIsArray = Array.isArray;
const BufferByteLength = Buffer.byteLength;
const DateNow = Date.now;
const JSONParse = JSON.parse;
const JSONStringify = JSON.stringify;
const MathCeil = Math.ceil;
const MathFloor = Math.floor;
const MathMax = Math.max;
const MathMin = Math.min;
const MathRandom = Math.random;
const NumberIsSafeInteger = Number.isSafeInteger;
const ObjectFreeze = Object.freeze;
const SymbolAsyncDispose = Symbol.asyncDispose;
const SymbolDispose = Symbol.dispose;
const SymbolIterator = Symbol.iterator;
const kInspect = Symbol.for("nodejs.util.inspect.custom");

type Inspect = (value: unknown, options: object) => string;

/** How often a consumer of a file looks for messages that another process sent. */
const POLL_INTERVAL = 100;
/** How long a consumer delivers batches in one go before it lets the event loop run. */
const PUMP_SLICE = 10;
/** The longest wait between two tries of a consumer whose database does not answer. */
const MAX_BACKOFF = 5000;
/** The longest delay a timer takes. */
const MAX_TIMEOUT = 2 ** 31 - 1;
/** How long SQLite waits for another connection's write before it gives up with SQLITE_BUSY. */
const BUSY_TIMEOUT = 5000;

const MEMORY = ":memory:";

const enum State {
  Pending,
  Acked,
  Retried,
}

const enum Op {
  /** Delete the message. */
  Ack,
  /** Make the message visible again at `at`. */
  Retry,
  /** Hand the message to the dead-letter queue. */
  Move,
  /** Give the message back as if it had not been claimed. */
  Release,
}

type Write = { op: Op; seq: number; lease: number; at: number };

type Row = {
  seq: number;
  id: string;
  content_type: string;
  sent_at: number;
  attempts: number;
  body: string | Uint8Array;
};

type Settled = { seq: number; attempts: number; state: State.Acked | State.Retried; delay: number | undefined };

type RetryOptions = { delaySeconds?: number };
type Handler = (batch: MessageBatch) => unknown;
type ErrorHandler = (error: unknown, batch: MessageBatch | undefined) => unknown;

let lazySQLite: typeof BunSQLiteModule;
let lazyJSC: typeof import("bun:jsc");
let textDecoder: TextDecoder | undefined;
let textEncoder: TextEncoder | undefined;

// Message, MessageBatch and Consumer reach into each other through these, which the classes
// assign from a static block. None of it is a property that user code can call.
let settleMessage: (
  message: Message,
  state: State.Acked | State.Retried,
  delay: number | undefined,
) => Settled | undefined;
let writeSettled: (batch: MessageBatch, settled: Settled[]) => void;
let settleRest: (batch: MessageBatch, state: State.Acked | State.Retried, delay: number | undefined) => void;
let leaseOf: (batch: MessageBatch) => number;
let pendingOf: (batch: MessageBatch) => Set<number>;
let settleInConsumer: (consumer: Consumer, lease: number, settled: Settled[]) => void;
let wakeConsumer: (consumer: Consumer) => void;

function isBusy(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && code.startsWith("SQLITE_BUSY");
}

/**
 * One database, shared by every queue of its owner that names the same file. The owner is the
 * thread, or the Bun.ModuleGraph whose script made the first of those queues: the connection and
 * the timers of its consumers are that graph's then, and go when the graph is disposed.
 */
class Store {
  readonly key: string;
  readonly registry: Map<string, Store>;
  /** The async context frame of the Bun.ModuleGraph that owns this store, if one does. */
  readonly ownerFrame: unknown;
  /** Whether another process can write to this database. */
  readonly persistent: boolean;
  refs = 0;
  /** The running consumers, by the name of their queue. */
  readonly consumers = new Map<string, Set<Consumer>>();
  /** The clock as the last claim() read it, once it had the write lock. */
  claimedAt = 0;

  #db: BunSQLiteModule.Database;
  #insert: Statement;
  #ready: Statement;
  #claim: Statement;
  #nextAfter: Statement;
  #metrics: Statement;
  #ack: Statement;
  #retry: Statement;
  #move: Statement;
  #release: Statement;
  #extend: Statement;
  #begin: Statement;
  #commit: Statement;
  #rollback: Statement;

  constructor(key: string, registry: Map<string, Store>) {
    this.key = key;
    this.registry = registry;
    this.ownerFrame = AsyncContextFrame.currentGraphFrame();
    this.persistent = key !== MEMORY;
    const { Database } = (lazySQLite ??= require("../bun/sqlite.ts"));
    const db = (this.#db = new Database(key, { create: true, readwrite: true }));
    try {
      this.#migrate(db);
      // query() statements belong to the database: close() finalizes them.
      this.#insert = db.query(
        "INSERT INTO bun_queue (queue, id, content_type, sent_at, visible_at, bytes, body) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      this.#ready = db.query(
        "SELECT count(*) AS n FROM (SELECT 1 FROM bun_queue WHERE queue = ? AND visible_at <= ? LIMIT ?)",
      );
      // One statement finds the messages and takes them, so two consumers never get the same one.
      this.#claim = db.query(
        `UPDATE bun_queue SET visible_at = ?1, attempts = attempts + 1, lease = ?2
         WHERE seq IN (SELECT seq FROM bun_queue WHERE queue = ?3 AND visible_at <= ?4 ORDER BY visible_at, seq LIMIT ?5)
         RETURNING seq, id, content_type, sent_at, attempts, body`,
      );
      this.#nextAfter = db.query("SELECT min(visible_at) AS at FROM bun_queue WHERE queue = ? AND visible_at > ?");
      this.#metrics = db.query(
        `SELECT count(*) AS backlogCount, coalesce(sum(bytes), 0) AS backlogBytes,
                coalesce(min(sent_at), 0) AS oldestMessageTimestamp
         FROM bun_queue WHERE queue = ?`,
      );
      this.#ack = db.query("DELETE FROM bun_queue WHERE seq = ? AND lease = ?");
      this.#retry = db.query("UPDATE bun_queue SET visible_at = ?, lease = NULL WHERE seq = ? AND lease = ?");
      this.#move = db.query(
        "UPDATE bun_queue SET queue = ?, visible_at = ?, attempts = 0, lease = NULL WHERE seq = ? AND lease = ?",
      );
      this.#release = db.query(
        "UPDATE bun_queue SET visible_at = ?, attempts = attempts - 1, lease = NULL WHERE seq = ? AND lease = ?",
      );
      this.#extend = db.query("UPDATE bun_queue SET visible_at = ? WHERE seq = ? AND lease = ?");
      this.#begin = db.query("BEGIN IMMEDIATE");
      this.#commit = db.query("COMMIT");
      this.#rollback = db.query("ROLLBACK");
    } catch (error) {
      db.close();
      throw error;
    }
  }

  #migrate(db: BunSQLiteModule.Database) {
    db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT}`);
    // The busy timeout does not cover the switch of a new file to WAL: of several processes that
    // create the file at the same moment, all but one get SQLITE_BUSY from it at once.
    for (const deadline = DateNow() + BUSY_TIMEOUT; ; ) {
      try {
        if (this.persistent) {
          // In WAL mode readers do not block the writer, and a commit does not wait for the disk.
          const { journal_mode } = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
          if (journal_mode !== "wal") db.run("PRAGMA journal_mode = WAL");
          db.run("PRAGMA synchronous = NORMAL");
        }
        // `body` is the last column and its size is kept beside it: metrics() and the scans of
        // the consumers then never read the pages that a large body overflows into.
        db.run(
          `CREATE TABLE IF NOT EXISTS bun_queue (
            seq INTEGER PRIMARY KEY,
            queue TEXT NOT NULL,
            id TEXT NOT NULL,
            content_type TEXT NOT NULL,
            sent_at INTEGER NOT NULL,
            visible_at INTEGER NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            lease INTEGER,
            bytes INTEGER NOT NULL,
            body BLOB NOT NULL
          )`,
        );
        db.run("CREATE INDEX IF NOT EXISTS bun_queue_visible ON bun_queue (queue, visible_at, seq)");
        return;
      } catch (error) {
        if (!isBusy(error) || DateNow() > deadline) throw error;
        sleepSync(1 + MathRandom() * 10);
      }
    }
  }

  close() {
    this.#db.close();
  }

  transaction(fn: () => void) {
    this.#begin.run();
    try {
      fn();
      this.#commit.run();
    } catch (error) {
      // After some errors, a full disk for one, SQLite has rolled back by itself. A ROLLBACK
      // fails then, and its error would take the place of the one that matters.
      if (this.#db.inTransaction) this.#rollback.run();
      throw error;
    }
  }

  insert(queue: string, body: string | Uint8Array, contentType: string, sentAt: number, visibleAt: number) {
    const bytes = typeof body === "string" ? BufferByteLength(body) : body.byteLength;
    this.#insert.run(queue, randomUUIDv7(), contentType, sentAt, visibleAt, bytes, body);
  }

  /** The number of messages that can be delivered now, counted up to `limit`. */
  ready(queue: string, now: number, limit: number): number {
    return (this.#ready.get(queue, now, limit) as { n: number }).n;
  }

  /** Take up to `limit` messages for `visibilityTimeout` milliseconds, counted from `claimedAt`. */
  claim(queue: string, limit: number, lease: number, visibilityTimeout: number): Row[] {
    let rows: Row[] = [];
    this.transaction(() => {
      // The clock is read once the write lock is held, which can take as long as BUSY_TIMEOUT:
      // a lease that was measured from before the wait could be over before it is written.
      const now = (this.claimedAt = DateNow());
      rows = this.#claim.all(now + visibilityTimeout, lease, queue, now, limit) as Row[];
    });
    return rows;
  }

  /** Keep `leases` for `visibilityTimeout` milliseconds from now. */
  extend(leases: { seq: number; lease: number }[], visibilityTimeout: number) {
    this.transaction(() => {
      const until = DateNow() + visibilityTimeout;
      for (const { seq, lease } of leases) this.#extend.run(until, seq, lease);
    });
  }

  /** When the next message of `queue` that is not visible at `now` becomes visible, or null. */
  nextAfter(queue: string, now: number): number | null {
    return (this.#nextAfter.get(queue, now) as { at: number | null }).at;
  }

  metrics(queue: string) {
    return this.#metrics.get(queue);
  }

  write(writes: Write[], deadLetterQueue: string | undefined) {
    if (writes.length === 1) {
      this.#writeOne(writes[0], deadLetterQueue);
      return;
    }
    this.transaction(() => {
      for (const write of writes) this.#writeOne(write, deadLetterQueue);
    });
  }

  #writeOne({ op, seq, lease, at }: Write, deadLetterQueue: string | undefined) {
    switch (op) {
      case Op.Ack:
        this.#ack.run(seq, lease);
        break;
      case Op.Retry:
        this.#retry.run(at, seq, lease);
        break;
      case Op.Move:
        this.#move.run(deadLetterQueue!, at, seq, lease);
        break;
      case Op.Release:
        this.#release.run(at, seq, lease);
        break;
    }
  }

  addConsumer(queue: string, consumer: Consumer) {
    let consumers = this.consumers.get(queue);
    if (consumers === undefined) this.consumers.set(queue, (consumers = new Set()));
    consumers.add(consumer);
  }

  removeConsumer(queue: string, consumer: Consumer) {
    const consumers = this.consumers.get(queue);
    if (consumers === undefined) return;
    consumers.delete(consumer);
    if (consumers.size === 0) this.consumers.delete(queue);
  }

  /** Something of `queue` changed that the consumers of this store should look at. */
  notify(queue: string) {
    const consumers = this.consumers.get(queue);
    if (consumers === undefined) return;
    for (const consumer of consumers) wakeConsumer(consumer);
  }
}

// Every owner has stores of its own. A Bun.ModuleGraph that shared a connection with the thread
// would close it under everybody else when it is disposed, and the queues that two tenants keep
// in memory under one name must not be one queue.
const threadStores = new Map<string, Store>();
const graphStores = new WeakMap<object, Map<string, Store>>();

function acquireStore(path: string | undefined): Store {
  const key = path === undefined || path === "" || path === MEMORY ? MEMORY : require("node:path").resolve(path);
  const graph = AsyncContextFrame.currentGraph();
  let stores = threadStores;
  if (graph !== undefined) {
    stores = graphStores.get(graph)!;
    if (stores === undefined) graphStores.set(graph, (stores = new Map()));
  }
  let store = stores.get(key);
  if (store === undefined) stores.set(key, (store = new Store(key, stores)));
  store.refs++;
  return store;
}

function releaseStore(store: Store) {
  // The database in memory is the queues of its owner. It stays for as long as the owner does,
  // or closing the last Queue object would take every message with it.
  if (--store.refs === 0 && store.persistent) {
    store.registry.delete(store.key);
    store.close();
  }
}

function encodeBody(body: unknown, contentType: unknown): string | Uint8Array {
  switch (contentType) {
    case "json": {
      const json = JSONStringify(body);
      if (json === undefined) {
        throw $ERR_INVALID_ARG_VALUE("body", body, 'cannot be serialized to JSON. Send it with contentType "v8"');
      }
      return json;
    }
    case "text":
      if (typeof body !== "string") throw $ERR_INVALID_ARG_TYPE("body", "string", body);
      return body;
    case "bytes":
      if (ArrayBufferIsView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
      if (require("node:util/types").isAnyArrayBuffer(body)) return new Uint8Array(body as ArrayBuffer);
      throw $ERR_INVALID_ARG_TYPE("body", ["ArrayBuffer", "TypedArray", "DataView"], body);
    case "v8":
      return new Uint8Array((lazyJSC ??= require("bun:jsc")).serialize(body));
    default:
      throw $ERR_INVALID_ARG_VALUE("contentType", contentType, 'must be one of "json", "text", "bytes" or "v8"');
  }
}

function decodeBody(body: string | Uint8Array, contentType: string): unknown {
  // SQLite gives back what was stored, a string or a blob. A row that another program wrote can
  // hold either one for any content type.
  switch (contentType) {
    case "json":
      return JSONParse(typeof body === "string" ? body : (textDecoder ??= new TextDecoder()).decode(body));
    case "text":
      return typeof body === "string" ? body : (textDecoder ??= new TextDecoder()).decode(body);
    case "bytes":
      return typeof body === "string" ? (textEncoder ??= new TextEncoder()).encode(body) : body;
    case "v8":
      return (lazyJSC ??= require("bun:jsc")).deserialize(body as Uint8Array);
    default:
      throw $ERR_INVALID_STATE(`Unsupported queue message content type: ${contentType}`);
  }
}

/** Seconds, as every duration of this API is given, to the milliseconds the table holds. */
function toMilliseconds(seconds: unknown, name: string): number {
  if (typeof seconds !== "number") throw $ERR_INVALID_ARG_TYPE(name, "number", seconds);
  if (!(seconds >= 0) || seconds === Infinity) throw $ERR_OUT_OF_RANGE(name, "a finite number >= 0", seconds);
  return MathCeil(seconds * 1000);
}

function validateObject(value: unknown, name: string) {
  if (value === null || typeof value !== "object" || ArrayIsArray(value)) {
    throw $ERR_INVALID_ARG_TYPE(name, "object", value);
  }
}

function validateCount(value: unknown, name: string, min: number): number {
  if (typeof value !== "number") throw $ERR_INVALID_ARG_TYPE(name, "number", value);
  // Only a safe integer: it becomes the LIMIT of a statement, which takes nothing else.
  if (!NumberIsSafeInteger(value) || value < min) throw $ERR_OUT_OF_RANGE(name, `an integer >= ${min}`, value);
  return value;
}

function retryDelayOf(options: RetryOptions | undefined): number | undefined {
  if (options === undefined) return undefined;
  validateObject(options, "options");
  const { delaySeconds } = options;
  return delaySeconds === undefined ? undefined : toMilliseconds(delaySeconds, "options.delaySeconds");
}

function sendDelayOf(options: { delaySeconds?: unknown }, name: string, fallback: number): number {
  const { delaySeconds } = options;
  return delaySeconds === undefined ? fallback : toMilliseconds(delaySeconds, name);
}

function bySeq(a: Row, b: Row): number {
  return a.seq - b.seq;
}

class Message {
  readonly id: string;
  readonly timestamp: Date;
  readonly body: unknown;
  readonly attempts: number;
  #batch: MessageBatch;
  #seq: number;
  // What the table says, whatever the handler assigns to the property.
  #attempts: number;
  #state = State.Pending;

  constructor(batch: MessageBatch, row: Row, body: unknown) {
    this.id = row.id;
    this.timestamp = new Date(row.sent_at);
    this.body = body;
    this.attempts = this.#attempts = row.attempts;
    this.#batch = batch;
    this.#seq = row.seq;
  }

  static {
    // The first ack() or retry() that reaches a message decides it, whether it was called on the
    // message or on its batch.
    settleMessage = (message, state, delay) => {
      if (message.#state !== State.Pending) return undefined;
      message.#state = state;
      return { seq: message.#seq, attempts: message.#attempts, state, delay };
    };
  }

  // ack() and retry() are written before they return, not when the handler does: a process that
  // dies in the middle of a batch has kept what it acknowledged.
  ack(): void {
    const settled = settleMessage(this, State.Acked, undefined);
    if (settled !== undefined) writeSettled(this.#batch, [settled]);
  }

  retry(options?: RetryOptions): void {
    const settled = settleMessage(this, State.Retried, retryDelayOf(options));
    if (settled !== undefined) writeSettled(this.#batch, [settled]);
  }

  [kInspect](_depth: number, options: object, inspect: Inspect) {
    // Bun's formatter also asks the prototype.
    if (!(#seq in this)) return this;
    const { id, timestamp, body, attempts } = this;
    return `Message ${inspect({ id, timestamp, body, attempts }, options)}`;
  }
}

class MessageBatch {
  readonly queue: string;
  readonly messages: readonly Message[];
  // The same array. A handler can assign another one to the property.
  #messages: readonly Message[];
  #consumer: Consumer;
  #lease: number;
  /** seq of every message that is neither acknowledged nor retried yet. */
  #pending = new Set<number>();

  constructor(consumer: Consumer, queue: string, lease: number, rows: Row[], bodies: unknown[]) {
    this.queue = queue;
    this.#consumer = consumer;
    this.#lease = lease;
    const messages: Message[] = [];
    for (let i = 0; i < rows.length; i++) {
      messages.push(new Message(this, rows[i], bodies[i]));
      this.#pending.add(rows[i].seq);
    }
    this.messages = this.#messages = ObjectFreeze(messages);
  }

  static {
    writeSettled = (batch, settled) => {
      for (const { seq } of settled) batch.#pending.delete(seq);
      settleInConsumer(batch.#consumer, batch.#lease, settled);
    };
    // One write for every message of the batch that is not decided yet.
    settleRest = (batch, state, delay) => {
      const settled: Settled[] = [];
      for (const message of batch.#messages) {
        const one = settleMessage(message, state, delay);
        if (one !== undefined) settled.push(one);
      }
      if (settled.length > 0) writeSettled(batch, settled);
    };
    leaseOf = batch => batch.#lease;
    pendingOf = batch => batch.#pending;
  }

  ackAll(): void {
    settleRest(this, State.Acked, undefined);
  }

  retryAll(options?: RetryOptions): void {
    settleRest(this, State.Retried, retryDelayOf(options));
  }

  [kInspect](_depth: number, options: object, inspect: Inspect) {
    if (!(#lease in this)) return this;
    return `MessageBatch ${inspect({ queue: this.queue, messages: this.messages }, options)}`;
  }
}

class Consumer {
  #store: Store;
  #queue: string;
  /** The consumers of the Queue object that made this one. */
  #owner: Set<Consumer>;
  #handler: Handler;
  #maxBatchSize = 10;
  #maxBatchTimeout = 0;
  #maxAttempts = 4;
  #retryDelay: number | ((attempts: number) => unknown) = 0;
  #maxConcurrency = 1;
  #deadLetterQueue: string | undefined;
  #visibilityTimeout = 30_000;
  #onError: ErrorHandler | undefined;

  #batches = new Set<MessageBatch>();
  /** Writes that failed, for example with SQLITE_BUSY. They are tried again with the next pump. */
  #unwritten: Write[] = [];
  /** How many pumps in a row the database did not answer. */
  #failures = 0;
  #timer: Timer | undefined;
  /** When a batch that is not full yet is delivered anyway, or 0 when none is waiting. */
  #batchDeadline = 0;
  #nextHeartbeat = Infinity;
  #pumpQueued = false;
  #pumping = false;
  /** When the deliveries began that the event loop has not had a turn since, or 0. */
  #sliceStart = 0;
  #sliceEnds = () => {
    this.#sliceStart = 0;
  };
  #refed = true;
  #stopped: PromiseWithResolvers<void> | undefined;
  #finished = false;

  constructor(store: Store, owner: Set<Consumer>, queue: string, handler: Handler, options: unknown) {
    this.#store = store;
    this.#queue = queue;
    this.#owner = owner;
    this.#handler = handler;
    if (options !== undefined) {
      validateObject(options, "options");
      const {
        maxBatchSize,
        maxBatchTimeout,
        maxRetries,
        retryDelay,
        maxConcurrency,
        deadLetterQueue,
        visibilityTimeout,
        onError,
      } = options as Record<string, unknown>;
      if (maxBatchSize !== undefined) this.#maxBatchSize = validateCount(maxBatchSize, "options.maxBatchSize", 1);
      if (maxBatchTimeout !== undefined) {
        this.#maxBatchTimeout = toMilliseconds(maxBatchTimeout, "options.maxBatchTimeout");
      }
      if (maxRetries !== undefined) this.#maxAttempts = validateCount(maxRetries, "options.maxRetries", 0) + 1;
      if (retryDelay !== undefined) {
        this.#retryDelay = $isCallable(retryDelay)
          ? (retryDelay as (attempts: number) => unknown)
          : toMilliseconds(retryDelay, "options.retryDelay");
      }
      if (maxConcurrency !== undefined) {
        this.#maxConcurrency = validateCount(maxConcurrency, "options.maxConcurrency", 1);
      }
      if (deadLetterQueue !== undefined) {
        if (typeof deadLetterQueue !== "string") {
          throw $ERR_INVALID_ARG_TYPE("options.deadLetterQueue", "string", deadLetterQueue);
        }
        if (deadLetterQueue === "" || deadLetterQueue === queue) {
          throw $ERR_INVALID_ARG_VALUE("options.deadLetterQueue", deadLetterQueue, "must name another queue");
        }
        this.#deadLetterQueue = deadLetterQueue;
      }
      if (visibilityTimeout !== undefined) {
        const timeout = toMilliseconds(visibilityTimeout, "options.visibilityTimeout");
        if (timeout === 0) throw $ERR_OUT_OF_RANGE("options.visibilityTimeout", "> 0", visibilityTimeout);
        this.#visibilityTimeout = timeout;
      }
      if (onError !== undefined) {
        if (!$isCallable(onError)) throw $ERR_INVALID_ARG_TYPE("options.onError", "function", onError);
        this.#onError = onError as ErrorHandler;
      }
    }
    store.refs++;
    store.addConsumer(queue, this);
    owner.add(this);
    this.#queuePump();
  }

  static {
    wakeConsumer = consumer => consumer.#queuePump();
    settleInConsumer = (consumer, lease, settled) => consumer.#settle(lease, settled);
  }

  /**
   * Calls `fn` as the owner of the store, whoever is calling. The timers a consumer arms and what
   * its handler opens are then the owner's: the thread's, or those of the Bun.ModuleGraph the
   * queue was made in, which takes them along when it is disposed. It is also what keeps the
   * AsyncLocalStorage stores of a send() caller out of the handler, and out of the timers that
   * would hold on to them.
   */
  #runAsOwner(fn: (this: Consumer) => void) {
    AsyncContextFrame.run(this.#store.ownerFrame, fn, this);
  }

  // A send() must not run the handler before it returns, so deliveries start from a microtask.
  #queuePump() {
    if (this.#pumpQueued || this.#stopped !== undefined) return;
    this.#pumpQueued = true;
    queueMicrotask(() => {
      this.#pumpQueued = false;
      this.#runAsOwner(this.#pump);
    });
  }

  /** Deliver batches until nothing is ready or maxConcurrency batches are in flight. */
  #pump() {
    if (this.#stopped !== undefined) return;
    const store = this.#store;
    if (store.ownerFrame !== undefined && isFrameOfStoppedModuleGraph(store.ownerFrame)) {
      // The Bun.ModuleGraph that this consumer belongs to was disposed, and its database and its
      // timers with it. A disposed graph hears nothing more. What the consumer had in flight
      // comes back when the leases run out, for a consumer that is still there.
      this.#abandon();
      return;
    }
    const queue = this.#queue;
    const maxBatchSize = this.#maxBatchSize;
    let more = false;
    // What follows runs user code (onError, retryDelay, a handler), and any of it can call
    // stop(). While this is set, stop() leaves the database to the end of this function.
    this.#pumping = true;
    try {
      // The leases come first. After a handler that held the thread for longer than a lease, the
      // claim below would otherwise take this consumer's own messages a second time.
      if (DateNow() >= this.#nextHeartbeat) this.#heartbeat();
      if (!this.#writeUnwritten()) {
        this.#failures++;
      } else {
        while (this.#stopped === undefined && this.#batches.size < this.#maxConcurrency) {
          const now = DateNow();
          // Handlers that do not wait for anything would otherwise keep the event loop from
          // running until the queue is empty: a delivery that ends queues the next pump as a
          // microtask, which runs before any timer does. So the time is counted over every
          // pump since the event loop last had a turn, which an immediate tells.
          if (this.#sliceStart === 0) {
            this.#sliceStart = now;
            setImmediate(this.#sliceEnds);
          } else if (now - this.#sliceStart > PUMP_SLICE) {
            more = true;
            break;
          }
          // A claim is a write. This read keeps an idle consumer from taking the write lock of
          // the database with every poll.
          const ready = store.ready(queue, now, maxBatchSize);
          if (ready === 0) {
            this.#batchDeadline = 0;
            break;
          }
          if (ready < maxBatchSize && this.#maxBatchTimeout > 0) {
            if (this.#batchDeadline === 0) this.#batchDeadline = now + this.#maxBatchTimeout;
            if (now < this.#batchDeadline) break;
          }
          this.#batchDeadline = 0;

          const lease = MathFloor(MathRandom() * 2 ** 48);
          const rows = store.claim(queue, maxBatchSize, lease, this.#visibilityTimeout);
          if (rows.length === 0) break;
          // RETURNING gives the rows in no particular order. A batch is in the order of sending.
          rows.sort(bySeq);
          this.#deliver(lease, rows, store.claimedAt);
        }
        this.#failures = 0;
      }
    } catch (error) {
      this.#failures++;
      this.#report(error, undefined);
    }
    this.#pumping = false;
    if (this.#stopped !== undefined && this.#batches.size === 0) this.#finishStop();
    else this.#arm(more);
  }

  #deliver(lease: number, rows: Row[], now: number) {
    const maxAttempts = this.#maxAttempts;
    const deliverable: Row[] = [];
    const bodies: unknown[] = [];
    const undecodable: Settled[] = [];
    const errors: unknown[] = [];
    const exhausted: Write[] = [];
    for (const row of rows) {
      if (row.attempts > maxAttempts) {
        // Delivered maxAttempts times and never decided: its consumer died every time.
        exhausted.push(this.#giveUp(row.seq, lease, now));
        continue;
      }
      let body: unknown;
      try {
        body = decodeBody(row.body, row.content_type);
      } catch (error) {
        // Nothing that can be handed to the handler. It counts as a delivery that failed.
        undecodable.push({ seq: row.seq, attempts: row.attempts, state: State.Retried, delay: undefined });
        errors.push(error);
        continue;
      }
      deliverable.push(row);
      bodies.push(body);
    }
    if (exhausted.length > 0) this.#write(exhausted);
    if (undecodable.length > 0) {
      this.#settle(lease, undecodable);
      for (const error of errors) this.#report(error, undefined);
    }
    if (deliverable.length === 0) return;
    if (this.#stopped !== undefined) {
      // onError or retryDelay stopped the consumer just now. The rest of the claim goes back.
      const released: Write[] = [];
      for (const { seq } of deliverable) released.push({ op: Op.Release, seq, lease, at: now });
      this.#write(released);
      return;
    }

    const batch = new MessageBatch(this, this.#queue, lease, deliverable, bodies);
    this.#batches.add(batch);
    if (this.#nextHeartbeat === Infinity) this.#nextHeartbeat = now + this.#visibilityTimeout / 3;
    let result: any;
    try {
      result = this.#handler.$call(undefined, batch);
      if (!$isPromise(result) && $isObject(result) && $isCallable(result.then)) {
        // A thenable that is not a promise is waited for like one.
        const thenable = result;
        result = new Promise(resolve => resolve(thenable));
      }
    } catch (error) {
      this.#finish(batch, false, error);
      return;
    }
    if ($isPromise(result)) {
      result.then(
        () => this.#finish(batch, true, undefined),
        error => this.#finish(batch, false, error),
      );
    } else {
      this.#finish(batch, true, undefined);
    }
  }

  #finish(batch: MessageBatch, ok: boolean, error: unknown) {
    // What the handler did not decide, its outcome decides.
    settleRest(batch, ok ? State.Acked : State.Retried, undefined);
    this.#batches.delete(batch);
    if (this.#batches.size === 0) this.#nextHeartbeat = Infinity;
    if (!ok) this.#report(error, batch);
    if (this.#stopped === undefined) this.#queuePump();
    else if (this.#batches.size === 0 && !this.#pumping) this.#finishStop();
  }

  /** A message that used up its deliveries goes to the dead-letter queue, or is deleted. */
  #giveUp(seq: number, lease: number, now: number): Write {
    return { op: this.#deadLetterQueue === undefined ? Op.Ack : Op.Move, seq, lease, at: now };
  }

  /** Write what was decided for messages of the claim `lease`. */
  #settle(lease: number, settled: Settled[]) {
    const now = DateNow();
    const writes: Write[] = [];
    for (const { seq, attempts, state, delay } of settled) {
      if (state === State.Acked) {
        writes.push({ op: Op.Ack, seq, lease, at: 0 });
      } else if (attempts >= this.#maxAttempts) {
        writes.push(this.#giveUp(seq, lease, now));
      } else {
        writes.push({ op: Op.Retry, seq, lease, at: now + (delay ?? this.#retryDelayFor(attempts)) });
      }
    }
    this.#write(writes);
  }

  #retryDelayFor(attempts: number): number {
    const retryDelay = this.#retryDelay;
    if (typeof retryDelay === "number") return retryDelay;
    try {
      return toMilliseconds(retryDelay.$call(undefined, attempts), "The value that options.retryDelay returned");
    } catch (error) {
      this.#report(error, undefined);
      return 0;
    }
  }

  #write(writes: Write[]) {
    try {
      this.#store.write(writes, this.#deadLetterQueue);
    } catch (error) {
      // The leases still hold. Keep the writes and try them again with the next pump. Only the
      // first failure is reported, not every attempt after it.
      const first = this.#unwritten.length === 0;
      for (const write of writes) this.#unwritten.push(write);
      if (first) this.#report(error, undefined);
      this.#queuePump();
      return;
    }
    this.#written(writes);
  }

  /** Wake whoever waits for what `writes` made visible. */
  #written(writes: Write[]) {
    let retried = false;
    let moved = false;
    for (const { op } of writes) {
      if (op === Op.Retry || op === Op.Release) retried = true;
      else if (op === Op.Move) moved = true;
    }
    if (retried) this.#store.notify(this.#queue);
    if (moved) this.#store.notify(this.#deadLetterQueue!);
  }

  /** Whether nothing is left unwritten. */
  #writeUnwritten(): boolean {
    const unwritten = this.#unwritten;
    if (unwritten.length === 0) return true;
    // Left in place while it is tried, so that a second failure is not reported as a first one.
    try {
      this.#store.write(unwritten, this.#deadLetterQueue);
    } catch {
      return false;
    }
    this.#unwritten = [];
    this.#written(unwritten);
    return true;
  }

  /** Keep the leases of the messages that handlers still work on. */
  #heartbeat() {
    const timeout = this.#visibilityTimeout;
    // Set before the write: one that fails is tried again a third of a lease later, not at once.
    this.#nextHeartbeat = DateNow() + timeout / 3;
    const leases: { seq: number; lease: number }[] = [];
    for (const batch of this.#batches) {
      const lease = leaseOf(batch);
      for (const seq of pendingOf(batch)) leases.push({ seq, lease });
    }
    if (leases.length > 0) this.#store.extend(leases, timeout);
  }

  #arm(immediately: boolean) {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    const stopped = this.#stopped !== undefined;
    // A stopped consumer keeps the leases of the batches it still has in flight, and nothing else.
    if (stopped && this.#batches.size === 0) return;
    const store = this.#store;
    const now = DateNow();
    let at = this.#nextHeartbeat;
    let failed = false;
    let error: unknown;
    if (immediately) {
      at = now;
    } else if (!stopped) {
      if (this.#failures > 0) {
        // The database did not answer. Ask again later, and later still each time it does not.
        at = MathMin(at, now + MathMin(POLL_INTERVAL * 2 ** (this.#failures - 1), MAX_BACKOFF));
      } else if (this.#batches.size < this.#maxConcurrency) {
        if (this.#batchDeadline !== 0) at = MathMin(at, this.#batchDeadline);
        // A delay or a retry delay that ends wakes nobody, in memory least of all.
        try {
          const next = store.nextAfter(this.#queue, now);
          if (next !== null) at = MathMin(at, next);
        } catch (thrown) {
          failed = true;
          error = thrown;
          this.#failures = 1;
          at = MathMin(at, now + POLL_INTERVAL);
        }
        if (store.persistent) at = MathMin(at, now + POLL_INTERVAL);
      }
    }
    // With nothing to wait for there is still a timer: a consumer keeps the process alive, as a
    // server does, until it is stopped or unref()'d.
    this.#timer = setTimeout(() => this.#onTimer(), MathMin(MathMax(at - now, 0), MAX_TIMEOUT));
    if (!this.#refed) this.#timer.unref();
    // Last, because onError can call stop(), which then finds the timer to clear.
    if (failed) this.#report(error, undefined);
  }

  #onTimer() {
    this.#timer = undefined;
    // A timer that fires is a turn of the event loop as well.
    this.#sliceStart = 0;
    if (this.#stopped === undefined) {
      this.#pump();
      return;
    }
    // Stopped, with batches in flight: their leases are what is left to look after, and an
    // outcome that could not be written before.
    if (DateNow() >= this.#nextHeartbeat) {
      try {
        this.#heartbeat();
      } catch (error) {
        this.#report(error, undefined);
      }
    }
    this.#writeUnwritten();
    this.#arm(false);
  }

  #report(error: unknown, batch: MessageBatch | undefined) {
    const onError = this.#onError;
    if (onError !== undefined) {
      try {
        onError.$call(undefined, error, batch);
        return;
      } catch (thrown) {
        error = thrown;
      }
    }
    console.error(error);
  }

  #detach() {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#store.removeConsumer(this.#queue, this);
    this.#owner.delete(this);
  }

  #finishStop() {
    if (this.#finished) return;
    this.#finished = true;
    this.#detach();
    if (!this.#writeUnwritten()) {
      // This was the last try. The messages are delivered again when their leases run out.
      this.#report(
        $ERR_INVALID_STATE("The consumer stopped before it could write the outcome of its messages"),
        undefined,
      );
    }
    releaseStore(this.#store);
    this.#stopped!.resolve();
  }

  /** The end of a consumer whose Bun.ModuleGraph was disposed. There is no database to write to. */
  #abandon() {
    this.#stopped ??= Promise.withResolvers<void>();
    if (this.#finished) return;
    this.#finished = true;
    this.#detach();
    this.#stopped.resolve();
  }

  stop(): Promise<void> {
    if (this.#stopped === undefined) {
      this.#stopped = Promise.withResolvers<void>();
      // Not taken out of #owner yet: a close() of the Queue object waits for this consumer too.
      this.#store.removeConsumer(this.#queue, this);
      if (this.#batches.size === 0 && !this.#pumping) this.#finishStop();
      else this.#runAsOwner(this.#armStopped);
    }
    return this.#stopped.promise;
  }

  #armStopped() {
    this.#arm(false);
  }

  ref(): this {
    this.#refed = true;
    this.#timer?.ref();
    return this;
  }

  unref(): this {
    this.#refed = false;
    this.#timer?.unref();
    return this;
  }

  [SymbolDispose](): void {
    this.stop();
  }

  [SymbolAsyncDispose](): Promise<void> {
    return this.stop();
  }

  [kInspect](_depth: number, options: object, inspect: Inspect) {
    if (!(#queue in this)) return this;
    return `QueueConsumer ${inspect({ queue: this.#queue, stopped: this.#stopped !== undefined }, options)}`;
  }
}

class Queue {
  readonly name: string;
  #name: string;
  #store: Store | undefined;
  #consumers = new Set<Consumer>();
  #closed: Promise<void> | undefined;

  constructor(name: string, options?: { path?: string }) {
    if (typeof name !== "string") throw $ERR_INVALID_ARG_TYPE("name", "string", name);
    if (name === "") throw $ERR_INVALID_ARG_VALUE("name", name, "must not be empty");
    let path: string | undefined;
    if (options !== undefined) {
      validateObject(options, "options");
      path = options.path;
      if (path !== undefined && typeof path !== "string") throw $ERR_INVALID_ARG_TYPE("options.path", "string", path);
    }
    this.name = this.#name = name;
    this.#store = acquireStore(path);
  }

  #open(): Store {
    const store = this.#store;
    if (store === undefined) throw $ERR_INVALID_STATE("Queue is closed");
    return store;
  }

  async send(body: unknown, options?: { contentType?: string; delaySeconds?: number }): Promise<void> {
    const store = this.#open();
    let contentType: string = "json";
    let delay = 0;
    if (options !== undefined) {
      validateObject(options, "options");
      ({ contentType = "json" } = options);
      delay = sendDelayOf(options, "options.delaySeconds", 0);
    }
    const data = encodeBody(body, contentType);
    const now = DateNow();
    store.insert(this.#name, data, contentType, now, now + delay);
    store.notify(this.#name);
  }

  async sendBatch(
    messages: Iterable<{ body: unknown; contentType?: string; delaySeconds?: number }>,
    options?: { delaySeconds?: number },
  ): Promise<void> {
    const store = this.#open();
    let batchDelay = 0;
    if (options !== undefined) {
      validateObject(options, "options");
      batchDelay = sendDelayOf(options, "options.delaySeconds", 0);
    }
    if (messages === null || messages === undefined || !$isCallable(messages[SymbolIterator])) {
      throw $ERR_INVALID_ARG_TYPE("messages", "Iterable", messages);
    }
    // Everything is encoded before anything is written: a message that cannot be sent sends none.
    const rows: { data: string | Uint8Array; contentType: string; delay: number }[] = [];
    for (const message of messages) {
      validateObject(message, "message");
      const { body, contentType = "json" } = message;
      const delay = sendDelayOf(message, "message.delaySeconds", batchDelay);
      rows.push({ data: encodeBody(body, contentType), contentType, delay });
    }
    if (rows.length === 0) return;
    const name = this.#name;
    store.transaction(() => {
      const now = DateNow();
      for (const { data, contentType, delay } of rows) store.insert(name, data, contentType, now, now + delay);
    });
    store.notify(name);
  }

  async metrics(): Promise<{ backlogCount: number; backlogBytes: number; oldestMessageTimestamp: number }> {
    return this.#open().metrics(this.#name) as any;
  }

  consume(handler: Handler, options?: object): Consumer {
    const store = this.#open();
    if (!$isCallable(handler)) throw $ERR_INVALID_ARG_TYPE("handler", "function", handler);
    return new Consumer(store, this.#consumers, this.#name, handler, options);
  }

  /** Stops the consumers of this object. Resolves when the batches they were handling are done. */
  close(): Promise<void> {
    const store = this.#store;
    if (store === undefined) return this.#closed!;
    this.#store = undefined;
    const stopping: Promise<void>[] = [];
    // A consumer that is done takes itself out of the set, which a Set allows while it is iterated.
    for (const consumer of this.#consumers) stopping.push(consumer.stop());
    releaseStore(store);
    return (this.#closed = Promise.all(stopping).then(() => {}));
  }

  [SymbolDispose](): void {
    this.close();
  }

  [SymbolAsyncDispose](): Promise<void> {
    return this.close();
  }

  [kInspect](_depth: number, options: object, inspect: Inspect) {
    if (!(#name in this)) return this;
    return `Queue ${inspect({ name: this.#name }, options)}`;
  }
}

/**
 * `bun --hot` is about to evaluate the modules again, and with them every consume() call. The
 * batches that are in flight finish with the handler they started with.
 */
function stopConsumers() {
  for (const store of threadStores.values()) {
    for (const consumers of store.consumers.values()) {
      for (const consumer of consumers) consumer.stop();
    }
  }
}

export default { Queue, stopConsumers };
