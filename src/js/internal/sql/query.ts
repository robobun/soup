import type { DatabaseAdapter, SQLHelper } from "./shared.ts";

const _resolve = Symbol("resolve");
const _reject = Symbol("reject");
const _handle = Symbol("handle");
const _queryStatus = Symbol("status");
const _handler = Symbol("handler");
const _strings = Symbol("strings");
const _values = Symbol("values");
const _flags = Symbol("flags");
const _results = Symbol("results");
const _adapter = Symbol("adapter");
const _waiter = Symbol("waiter");
const _settled = Symbol("settled");
const _copy = Symbol("copy");

const PublicPromise = Promise;
const { validateInteger } = require("internal/validators");

export interface BaseQueryHandle<Connection> {
  cancel?(): void;
  setMode(mode: SQLQueryResultMode): void;
  run(connection: Connection, query: Query<any, any>): void | Promise<void>;
}

export type { CursorSource, Query, SQLQueryResultMode };
export type QueryStrings = string | TemplateStringsArray | SQLHelper<any> | Query<any, any>;
class Query<T, Handle extends BaseQueryHandle<any>> extends PublicPromise<T> {
  public [_resolve]: (value: T) => void;
  public [_reject]: (reason?: Error) => void;
  public [_handle]: Handle | null;
  public [_handler]: (query: Query<T, Handle>, handle: Handle | null) => unknown;
  public [_queryStatus]: SQLQueryStatus;
  public [_strings]: QueryStrings;
  public [_values]: any[];
  public [_flags]: SQLQueryFlags;
  public [_waiter]: ((err: Error | null, connection: any) => void) | null;
  public [_settled]: Promise<void> | null;
  /// What is behind the stream of a query with SQLQueryFlags.copy, or its Cursor: what that attach() returns is dispatched.
  declare public [_copy]: {
    attach(handle: Handle): Handle | void;
    abandon(why: string, ending?: boolean): void;
    ended?: ((failed: boolean) => Promise<void>) | null;
  };

  public readonly [_adapter]: DatabaseAdapter<any, any, Handle>;

  [Symbol.for("nodejs.util.inspect.custom")](): `Query { ${string} }` {
    const status = this[_queryStatus];

    let query = "";
    if ((status & SQLQueryStatus.active) != 0) query += "active ";
    if ((status & SQLQueryStatus.cancelled) != 0) query += "cancelled ";
    if ((status & SQLQueryStatus.executed) != 0) query += "executed ";
    if ((status & SQLQueryStatus.error) != 0) query += "error ";

    return `Query { ${query.trimEnd()} }`;
  }

  #createHandle(): Handle | null {
    try {
      const adapter = this[_adapter];
      const flags = this[_flags];
      const [sql, values] = adapter.normalizeQuery(this[_strings], this[_values]);
      const handle = adapter.createQueryHandle(sql, values, flags);
      const mode = (flags >> resultModeShift) & 3;
      if (mode !== SQLQueryResultMode.objects) {
        handle.setMode(mode);
      }
      if (flags & (SQLQueryFlags.copy | SQLQueryFlags.cursor)) {
        return (this[_handle] = this[_copy].attach(handle) ?? handle);
      }
      return (this[_handle] = handle);
    } catch (err) {
      this.reject(err as Error);
      return null;
    }
  }

  #setMode(mode: SQLQueryResultMode) {
    this[_flags] = (this[_flags] & ~(3 << resultModeShift)) | (mode << resultModeShift);
    this[_handle]?.setMode(mode);
    return this;
  }

  constructor(
    strings: QueryStrings,
    values: any[],
    flags: number,
    handler,
    adapter: DatabaseAdapter<any, any, Handle>,
  ) {
    let resolve_: (value: T) => void, reject_: (reason?: any) => void;

    super((resolve, reject) => {
      resolve_ = resolve;
      reject_ = reject;
    });

    this[_adapter] = adapter;

    if (typeof strings === "string" && !(flags & SQLQueryFlags.unsafe)) {
      // identifier (cannot be executed in safe mode); the adapter that runs the statement quotes it
      if (strings.includes("\0")) {
        throw $ERR_INVALID_ARG_VALUE("name", strings, "must not contain null bytes");
      }
      flags |= SQLQueryFlags.notTagged;
    }

    this[_resolve] = resolve_!;
    this[_reject] = reject_!;
    this[_handle] = null;
    this[_handler] = handler;
    this[_queryStatus] = SQLQueryStatus.none;
    this[_strings] = strings;
    this[_values] = values;
    this[_flags] = flags;
    this[_waiter] = null;
    this[_settled] = null;

    this[_results] = null;
  }

  #run() {
    const { [_handler]: handler, [_queryStatus]: status, [_flags]: flags } = this;

    if (status & (SQLQueryStatus.executed | SQLQueryStatus.error)) {
      return;
    }

    if (flags & SQLQueryFlags.notTagged) {
      this.reject(this[_adapter].notTaggedCallError());
      return;
    }

    if (status & SQLQueryStatus.cancelled) {
      // as in onQuerySettled()
      $pokePromiseAsHandled(this);
      this.reject(this[_adapter].queryCancelledError());
      return;
    }

    this[_queryStatus] |= SQLQueryStatus.executed;
    let handle: Handle | null = null;
    if (!(flags & SQLQueryFlags.deferredText)) {
      handle = this.#createHandle();
      if (handle === null) {
        return;
      }
    }

    try {
      handler(this, handle);
    } catch (err) {
      this.reject(err as Error);
    }
  }

  setText(text: string): Handle | null {
    if (this[_queryStatus] & SQLQueryStatus.error) {
      return null;
    }
    this[_strings] = text;
    this[_flags] &= ~SQLQueryFlags.deferredText;
    return this.#createHandle();
  }

  get active() {
    return (this[_queryStatus] & SQLQueryStatus.active) != 0;
  }

  set active(value) {
    const status = this[_queryStatus];
    if (status & (SQLQueryStatus.cancelled | SQLQueryStatus.error)) {
      return;
    }

    if (value) {
      this[_queryStatus] |= SQLQueryStatus.active;
    } else {
      this[_queryStatus] &= ~SQLQueryStatus.active;
    }
  }

  get cancelled() {
    return (this[_queryStatus] & SQLQueryStatus.cancelled) !== 0;
  }

  #settling() {
    this[_queryStatus] &= ~SQLQueryStatus.active;
    const settled = this[_settled];
    if (settled !== null && $isPromisePending(settled)) {
      $resolvePromise(settled, undefined);
    }
  }

  resolve(x: T) {
    this.#settling();

    return this[_resolve](x);
  }

  reject(x: Error) {
    this[_queryStatus] |= SQLQueryStatus.error;
    this.#settling();

    return this[_reject](x);
  }

  cancel() {
    const status = this[_queryStatus];
    if (status & SQLQueryStatus.cancelled) {
      return this;
    }

    this[_queryStatus] |= SQLQueryStatus.cancelled;
    if (this[_flags] & (SQLQueryFlags.copy | SQLQueryFlags.cursor)) {
      this[_copy].abandon("Query cancelled");
    }

    const waiter = this[_waiter];
    const handle = this[_handle];
    if (waiter) {
      this[_waiter] = null;
      this[_adapter].cancelConnect(waiter);
      this.reject(this[_adapter].queryCancelledError());
    } else if (handle) {
      handle.cancel?.();
    } else if (status & SQLQueryStatus.executed) {
      // it waits for its text
      this.reject(this[_adapter].queryCancelledError());
    }

    return this;
  }

  execute() {
    this.#run();
    return this;
  }

  /// then() rejects what these throw.
  #runTagged() {
    if (this[_flags] & SQLQueryFlags.notTagged) {
      throw this[_adapter].notTaggedCallError();
    }
    this.#run();
  }

  async run() {
    this.#runTagged();
    return this;
  }

  raw() {
    return this.#setMode(SQLQueryResultMode.raw);
  }

  simple() {
    this[_flags] |= SQLQueryFlags.simple;
    return this;
  }

  values() {
    return this.#setMode(SQLQueryResultMode.values);
  }

  /// The server takes no parameters in a COPY, so nothing is lost with the simple protocol.
  #copyStream(writable: boolean) {
    const adapter = this[_adapter];
    if (this[_flags] & SQLQueryFlags.notTagged) {
      throw adapter.notTaggedCallError();
    }
    if (adapter.copyStream === undefined) {
      throw new Error("readable() and writable() are not supported by this adapter (PostgreSQL only)");
    }
    if (this[_flags] & SQLQueryFlags.cursor) {
      throw $ERR_INVALID_STATE("cursor() was already called on this query");
    }
    if (this[_queryStatus] & SQLQueryStatus.executed) {
      throw $ERR_INVALID_STATE("readable() and writable() must be called before the query starts");
    }
    this[_flags] |= SQLQueryFlags.simple | SQLQueryFlags.copy;
    return adapter.copyStream(this, writable);
  }

  readable() {
    return this.#copyStream(false) as ReadableStream<Uint8Array>;
  }

  writable() {
    return this.#copyStream(true) as WritableStream<string | ArrayBufferView | ArrayBufferLike>;
  }

  /// cursor(), cursor(rows), cursor(fn) and cursor(rows, fn).
  cursor(rows?: unknown, fn?: unknown) {
    if ($isCallable(rows)) {
      fn = rows;
      rows = undefined;
    }
    const adapter = this[_adapter];
    if (this[_flags] & SQLQueryFlags.notTagged) {
      throw adapter.notTaggedCallError();
    }
    if (adapter.cursor === undefined) {
      throw new Error("cursor() is not supported by this adapter (PostgreSQL only)");
    }
    checkUnclaimed(this);
    if (rows === undefined) {
      rows = 1;
    } else {
      // the Int32 of an Execute message, where 0 is no limit
      validateInteger(rows, "rows", 1, 2147483647);
    }
    if (fn !== undefined && !$isCallable(fn)) {
      throw $ERR_INVALID_ARG_TYPE("fn", "function", fn);
    }
    const cursor = new Cursor(this, rows as number, fn as CursorCallback | undefined);
    if (fn === undefined) {
      // Nothing starts before the first next(): until then the query is any other query.
      const batches = new CursorIterator(cursor);
      // A handle of begin() or reserve() ends its cursors when it ends. On a pool, only the cursor ends its transaction.
      if (!(this[_flags] & SQLQueryFlags.allowUnsafeTransaction)) {
        (droppedCursors ??= new FinalizationRegistry(closeDroppedCursor)).register(batches, cursor);
      }
      return batches;
    }
    cursor.claim();
    return this;
  }

  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2>;
  then() {
    this.#run();

    return super.$then.$apply(this, arguments);
  }

  catch<TResult = never>(onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | null): Promise<T | TResult>;
  catch() {
    this.#runTagged();
    return super.catch.$apply(this, arguments);
  }

  finally(onFinally?: (() => void) | undefined | null) {
    this.#runTagged();
    if (!$isCallable(onFinally)) {
      return super.finally.$apply(this, arguments);
    }
    // Once `onFinally` and what it returned are through, the failure of the query passes on to `result`: as with
    // execute(), nobody has to handle it. What `onFinally` throws is the caller's own, and the mark is not reached.
    const result = super.finally(() => PublicPromise.$resolve(onFinally()).$then(() => $pokePromiseAsHandled(result)));
    return result;
  }
}

/// Calls `callback` in a microtask once the query has settled, before the reactions of the caller.
function onQuerySettled(query: Query<any, any>, callback: () => void) {
  // A query that is only started, sql`...`.execute(), does not end the process when it fails. What the caller makes
  // of it with then() or catch() is a promise like any other.
  $pokePromiseAsHandled(query);
  let settled = query[_settled];
  if (settled === null) {
    settled = query[_settled] = $newPromise<void>();
    if (!$isPromisePending(query)) {
      $resolvePromise(settled, undefined);
    }
  }
  settled.$then(callback);
}

type CursorCallback = (rows: unknown[]) => unknown;

/// The adapter's half of a cursor. attach() returns it, so it is dispatched as the handle of the query: run() gives it the connection.
interface CursorSource<Handle> extends BaseQueryHandle<any> {
  attach(handle: Handle): CursorSource<Handle>;
  /// run() has given it a connection.
  readonly started: boolean;
  /// The next rows. After the fetch() that has the last ones, which can be none, `more` is false.
  fetch(): Promise<unknown[]>;
  readonly more: boolean;
  /// Rejects the fetch() that waits, if one does.
  interrupt(err: unknown): void;
  /// Asks the server to stop the request that is on its way. `false`: none is, and fetch() has nothing to settle with.
  stop(): boolean;
  /// Ends the cursor on the server. `ending`: the transaction of the cursor ends next, and what the cursor has there with it.
  close(ending: boolean): void;
  /// What the query resolves with: a result without rows, for all the batches.
  summary(): unknown;
}

/// sql.CLOSE and sql.END: what the callback of a cursor returns to stop.
const CLOSE = Object.freeze({ __proto__: null });

const enum CursorState {
  /// the query is any other query: claim() makes it the query of this cursor
  unclaimed,
  /// the query has not started
  claimed,
  open,
  /// the cursor is closed on the server, and the query is not settled
  closed,
  over,
}

function checkUnclaimed(query: Query<any, any>) {
  if (query[_flags] & SQLQueryFlags.cursor) {
    throw $ERR_INVALID_STATE("cursor() was already called on this query");
  }
  if (query[_queryStatus] & SQLQueryStatus.executed || query[_flags] & SQLQueryFlags.copy) {
    throw $ERR_INVALID_STATE("cursor() must be called before the query starts");
  }
}

/// The batches of one query, for its callback or its iterator. The query settles once the cursor is closed on the server.
class Cursor {
  query: Query<any, any>;
  rows: number;
  fn: CursorCallback | undefined;
  source: CursorSource<any> | null = null;
  state = CursorState.unclaimed;
  /// Of a cursor that has a transaction for itself: ends it, with ROLLBACK if `failed`.
  ended: ((failed: boolean) => Promise<void>) | null = null;
  /// cancel() came while a request was on its way: the answer of the server to that request ends the cursor.
  stopped = false;
  /// The iterator, while a call of it waits: only between two calls can the consumer have dropped it.
  reader: object | null = null;
  readers = 0;

  constructor(query: Query<any, any>, rows: number, fn: CursorCallback | undefined) {
    this.query = query;
    this.rows = rows;
    this.fn = fn;
  }

  /// The first cursor() that is called with a callback, or iterated, has the query.
  claim() {
    const query = this.query;
    checkUnclaimed(query);
    const adapter = query[_adapter];
    const flags = query[_flags];
    query[_flags] = flags | SQLQueryFlags.cursor;
    // On a pool the cursor needs a connection of its own. A scope has one, and a file is read first.
    if (!(flags & (SQLQueryFlags.allowUnsafeTransaction | SQLQueryFlags.deferredText))) {
      query[_handler] = adapter.cursorHandler!;
    }
    query[_copy] = this;
    this.source = adapter.cursor!(query, this.rows);
    this.state = CursorState.claimed;
    // Whatever rejects the query ends the cursor. Also the handler that the query of an iterator never gets.
    query.$then(undefined, onCursorQueryRejected.bind(this));
  }

  /// From the query, when it has its text and its handle.
  attach(handle: unknown) {
    const source = this.source!.attach(handle);
    if (this.fn !== undefined) {
      this.run();
    }
    return source;
  }

  /// The next rows, or `undefined` after the last. With the rows that the statement ends with, the cursor is closed first.
  async next(): Promise<unknown[] | undefined> {
    if (this.state === CursorState.unclaimed) {
      this.claim();
    }
    if (this.state === CursorState.claimed) {
      this.state = CursorState.open;
      this.query[_adapter].cursors!++;
      this.query.execute();
    }
    const source = this.source!;
    while (this.state === CursorState.open) {
      let rows: unknown[];
      try {
        rows = await source.fetch();
      } catch (err) {
        await this.fail(err);
        throw err;
      }
      if (this.state !== CursorState.open) {
        break;
      }
      if (this.stopped) {
        // The request ended before the server could stop it.
        const err = this.query[_adapter].queryCancelledError();
        await this.fail(err);
        throw err;
      }
      if (!source.more) {
        await this.close();
        // Its callback can still throw.
        if (this.fn === undefined) {
          this.settle();
        }
      }
      // After an exact multiple of the limit the last rows are none, and so are those of a statement that returns none.
      if (rows.length > 0) {
        return rows;
      }
    }
    // It is over, or it failed or was closed while this waited: the query has the reason.
    if (this.state === CursorState.over) {
      return this.query.$then(() => undefined);
    }
    return undefined;
  }

  /// The end on the server that is no failure: what the statement wrote stays. A transaction of the cursor's own is committed.
  async close() {
    this.state = CursorState.closed;
    const ended = this.ended;
    try {
      this.source!.close(ended !== null);
      if (ended !== null) {
        await ended(false);
      }
    } catch (err) {
      this.over();
      this.query.reject(err as Error);
      throw err;
    }
  }

  over() {
    this.state = CursorState.over;
    this.query[_adapter].cursors!--;
  }

  /// `thrown`: by the callback, after a close that did not fail.
  settle(thrown?: { error: unknown }) {
    if (this.state !== CursorState.closed) {
      return;
    }
    this.over();
    if (thrown !== undefined) {
      this.query.reject(thrown.error as Error);
    } else {
      this.query.resolve(this.source!.summary());
    }
  }

  /// The end that the consumer asked for: break, return(), sql.CLOSE, and what its loop or its callback threw.
  async finish(thrown?: { error: unknown }) {
    if (this.state === CursorState.open) {
      await this.close();
    }
    this.settle(thrown);
  }

  /// A fetch that failed, cancel(), the end of what the query was made on. A transaction of the cursor's own is rolled back. `ending`: the one that it reads in ends next.
  async fail(err: unknown, ending = false) {
    const state = this.state;
    if (state === CursorState.open) {
      this.over();
    } else if (state === CursorState.claimed) {
      this.state = CursorState.over;
    } else {
      return;
    }
    const source = this.source!;
    source.interrupt(err);
    const ended = this.ended;
    try {
      source.close(ending || ended !== null);
      if (ended !== null) {
        await ended(true);
      }
    } catch {
      // `err` is why the cursor ended.
    }
    this.query.reject(err as Error);
  }

  /// cancel(), or what the query was made on ends. Without a connection there is nothing to close: cancel() rejects the query. `ending`: as for fail().
  abandon(why: string, ending = false) {
    const source = this.source!;
    if (this.state !== CursorState.open || !source.started) {
      return;
    }
    const query = this.query;
    const adapter = query[_adapter];
    if (!query.cancelled) {
      this.fail(adapter.error("QUERY_CANCELLED", "Cursor closed: " + why), ending);
    } else if (this.stopped || source.stop()) {
      // As any query that is cancelled on its way: it rejects with what the server answers.
      this.stopped = true;
    } else {
      this.fail(adapter.queryCancelledError());
    }
  }

  /// The callback form: the query starts it.
  async run() {
    const fn = this.fn!;
    try {
      for (let rows: unknown[] | undefined; (rows = await this.next()) !== undefined;) {
        let answer: unknown;
        try {
          answer = await fn(rows);
        } catch (error) {
          // As a loop body that throws: the iterator cannot tell that from a break.
          return await this.finish({ error });
        }
        if (answer === CLOSE || this.state !== CursorState.open) {
          break;
        }
      }
      await this.finish();
    } catch {
      // next() and finish() have told the query.
    }
  }
}

function onCursorQueryRejected(this: Cursor, err: unknown) {
  this.fail(err);
}

async function* iterateCursor(cursor: Cursor) {
  try {
    for (let rows: unknown[] | undefined; (rows = await cursor.next()) !== undefined;) {
      yield rows;
    }
  } finally {
    await cursor.finish();
  }
}

/// What cursor(rows) returns. Not the generator: a `for await` loop keeps the last value of a generator until the next one.
class CursorIterator {
  #cursor: Cursor;
  #batches: AsyncGenerator<unknown[], void, unknown>;

  constructor(cursor: Cursor) {
    this.#cursor = cursor;
    this.#batches = iterateCursor(cursor);
  }

  async next() {
    const cursor = this.#cursor;
    cursor.reader = this;
    cursor.readers++;
    try {
      return await this.#batches.next();
    } finally {
      if (--cursor.readers === 0) {
        cursor.reader = null;
      }
    }
  }

  async return() {
    const cursor = this.#cursor;
    cursor.reader = this;
    cursor.readers++;
    try {
      return await this.#batches.return(undefined);
    } finally {
      if (--cursor.readers === 0) {
        cursor.reader = null;
      }
    }
  }

  [Symbol.asyncIterator]() {
    return this;
  }

  async [Symbol.asyncDispose]() {
    await this.return();
  }
}

/// On a pool nothing else ends the transaction of a cursor whose iterator the consumer dropped. The cursor has no reference to the iterator.
let droppedCursors: FinalizationRegistry<Cursor> | undefined;

function closeDroppedCursor(cursor: Cursor) {
  cursor.abandon("its iterator was dropped before the last rows");
}

Object.defineProperty(Query, Symbol.species, { value: PublicPromise });
Object.defineProperty(Query, Symbol.toStringTag, { value: "Query" });

enum SQLQueryResultMode {
  objects = 0,
  values = 1,
  raw = 2,
}

enum SQLQueryFlags {
  none = 0,
  allowUnsafeTransaction = 1 << 0,
  unsafe = 1 << 1,
  bigint = 1 << 2,
  simple = 1 << 3,
  notTagged = 1 << 4,
  /// sent by begin() / savepoint() themselves: nothing that cancels a handle's queries cancels it
  internal = 1 << 5,
  /// the handler gets no handle: it finds the text (sql.file()) and calls setText()
  deferredText = 1 << 6,
  copy = 1 << 9,
  /// query.cursor(): the handle that is dispatched is the CursorSource of its Cursor
  cursor = 1 << 12,
}
/// Bits 7 and 8 of the flags: the SQLQueryResultMode asked for before the handle exists.
const resultModeShift = 7;

const enum SQLQueryStatus {
  none = 0,
  active = 1 << 1,
  cancelled = 1 << 2,
  error = 1 << 3,
  executed = 1 << 4,
}

export default {
  Query,
  CLOSE,
  onQuerySettled,
  SQLQueryFlags,
  SQLQueryResultMode,

  symbols: {
    _adapter,
    _handle,
    _strings,
    _values,
    _flags,
    _results,
    _waiter,
    _copy,
  },
};
