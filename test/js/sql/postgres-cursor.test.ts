// query.cursor(): a statement that is read in batches, through a portal of the server with a row limit.
import { SQL } from "bun";
import { describe, expect, test } from "bun:test";
import { heapStats } from "bun:jsc";
import { bunEnv, bunExe, describeWithContainer, isASAN, isDebug, tempDir, withoutAsanQuarantine } from "harness";
import path from "node:path";
import {
  pgBindComplete,
  pgCloseComplete,
  pgCommandComplete,
  pgDataRow,
  pgDecodeBind,
  pgErrorResponse,
  pgHold,
  pgMockServer,
  pgNoData,
  pgParameterDescription,
  pgParseComplete,
  pgPortalSuspended,
  pgReadyForQuery,
  pgRowDescription,
} from "./wire-frames";

const outcome = (promise: PromiseLike<unknown>) =>
  promise.then(
    () => "fulfilled",
    e => e,
  );
const failure = (e: any) => ({ code: e.code, errno: e.errno, message: e.message });
const xs = (rows: any[]) => rows.map(row => row.x);
/** The rows of a batch, and what the server said when it ended. */
const batch = (rows: any) => ({ x: xs(rows), count: rows.count, command: rows.command });
/** What the query of a cursor resolves to. */
const summary = (result: any) => ({ ...batch(result), affectedRows: result.affectedRows });
async function batches(cursor: AsyncIterable<any[]>) {
  const all: number[][] = [];
  for await (const rows of cursor) all.push(xs(rows));
  return all;
}

/** Two statements see one now() only inside a transaction block. */
async function inTransaction(sql: SQL) {
  const [first] = await sql`select now()::text as t`;
  const [second] = await sql`select now()::text as t`;
  return first.t === second.t;
}
/** The portals of the session that have a name. The statement that asks runs in one without. */
const portals = async (sql: SQL) => (await sql`select name from pg_cursors where name <> ''`.values()).flat();
const pidOf = async (sql: SQL) => (await sql`select pg_backend_pid() as pid`)[0].pid as number;
const series = (sql: SQL, rows: number) => sql`select x from generate_series(1, ${rows}::int) as x`;

/** What ends a cursor with its handle. */
const closed = (why: string) => ({
  code: "ERR_POSTGRES_QUERY_CANCELLED",
  errno: undefined,
  message: "Cursor closed: " + why,
});
/** cancel(), as of any query. */
const cancelled = { code: "ERR_POSTGRES_QUERY_CANCELLED", errno: undefined, message: "Query cancelled" };
/** cancel() of a request that the server was working on: the server says that it stopped. */
const stopped = {
  code: "ERR_POSTGRES_SERVER_ERROR",
  errno: "57014",
  message: "canceling statement due to user request",
};
/** pg_terminate_backend() */
const terminated = {
  code: "ERR_POSTGRES_SERVER_ERROR",
  errno: "57P01",
  message: "terminating connection due to administrator command",
};
const needsTransaction = {
  code: "ERR_POSTGRES_INVALID_TRANSACTION_STATE",
  errno: undefined,
  message:
    "A cursor needs a transaction, and this connection is in none. Call cursor() on sql, or on the handle that begin() gives",
};

type Container = { host: string; port: number; ready: Promise<void> };
const urlOf = (container: Container) => `postgres://bun_sql_test@${container.host}:${container.port}/bun_sql_test`;
const connectTo = (container: Container) =>
  async function connect(options: SQL.Options = {}) {
    await container.ready;
    return new SQL(urlOf(container), { max: 1, ...options });
  };

/** The two ways to read a cursor. Each gives the `x` of every batch. */
const forms: [string, (query: SQL.Query<any>, rows?: number) => Promise<number[][]>][] = [
  ["for await", (query, rows) => batches(rows === undefined ? query.cursor() : query.cursor(rows))],
  [
    "a callback",
    async (query, rows) => {
      const all: number[][] = [];
      const fn = (batch: any[]) => void all.push(xs(batch));
      await (rows === undefined ? query.cursor(fn) : query.cursor(rows, fn));
      return all;
    },
  ],
];

describeWithContainer("postgres", { image: "postgres_plain", concurrent: true }, container => {
  const connect = connectTo(container);

  describe.each(forms)("%s", (_, read) => {
    test.each<[number, number | undefined, number[][]]>([
      [7, 3, [[1, 2, 3], [4, 5, 6], [7]]],
      [
        6,
        3,
        [
          [1, 2, 3],
          [4, 5, 6],
        ],
      ],
      [2, undefined, [[1], [2]]],
      [3, 10, [[1, 2, 3]]],
      [3, 2147483647, [[1, 2, 3]]],
      [0, 3, []],
    ])("%i rows by %p", async (rows, limit, expected) => {
      await using sql = await connect();
      expect(await read(series(sql, rows), limit)).toEqual(expected);
      expect(await read(series(sql, rows), limit)).toEqual(expected);
      expect(await inTransaction(sql)).toBe(false);
    });

    test.each<[string, SQL.Options, (sql: SQL, dir: string) => SQL.Query<any>]>([
      ["prepare: false", { prepare: false }, sql => series(sql, 5)],
      ["sql.unsafe() with values", {}, sql => sql.unsafe("select x from generate_series(1, $1::int) as x", [5])],
      ["sql.unsafe() without values", {}, sql => sql.unsafe("select x from generate_series(1, 5) as x")],
      [".simple()", {}, sql => sql`select x from generate_series(1, 5) as x`.simple()],
      ["sql.file()", {}, (sql, dir) => sql.file(path.join(dir, "series.sql"), [5])],
      ["sql.file() on a pool", { max: 3 }, (sql, dir) => sql.file(path.join(dir, "series.sql"), [5])],
    ])("%s", async (_, options, query) => {
      using dir = tempDir("postgres-cursor", { "series.sql": "select x from generate_series(1, $1::int) as x" });
      await using sql = await connect(options);
      for (let run = 0; run < 2; run++) {
        expect(await read(query(sql, String(dir)), 2)).toEqual([[1, 2], [3, 4], [5]]);
      }
      expect(await sql`select 1 as x`).toEqual([{ x: 1 }]);
    });

    test("a statement of the transaction runs between two batches", async () => {
      await using sql = await connect();
      await sql`create temporary table doubled (x int)`;
      await sql.begin(async tx => {
        const all = await read(tx`select x from generate_series(1, 5) as x`, 2);
        expect(all).toEqual([[1, 2], [3, 4], [5]]);
        for await (const rows of tx`select x from generate_series(1, 5) as x`.cursor(2)) {
          await tx`insert into doubled ${tx(rows.map(row => ({ x: row.x * 2 })))}`;
        }
        expect(await portals(tx)).toEqual([]);
      });
      expect(xs(await sql`select x from doubled order by x`)).toEqual([2, 4, 6, 8, 10]);
    });

    test("an error of the server in the middle of the result", async () => {
      await using sql = await connect();
      const seen: number[][] = [];
      const query = sql`select 10 / (5 - x) as x from generate_series(1, 7) as x`;
      const reading =
        read === forms[0][1]
          ? (async () => {
              for await (const rows of query.cursor(3)) seen.push(xs(rows));
            })()
          : query.cursor(3, rows => void seen.push(xs(rows)));
      expect(failure(await outcome(reading))).toMatchObject({
        code: "ERR_POSTGRES_SERVER_ERROR",
        errno: "22012",
        message: "division by zero",
      });
      expect(seen).toEqual([[2, 3, 5]]);
      // ROLLBACK has ended the transaction of the cursor.
      expect([await inTransaction(sql), await sql`select 1 as x`]).toEqual([false, [{ x: 1 }]]);
    });
  });

  test("a batch is a result: its count is its rows, and the one that the statement ends with has the command", async () => {
    await using sql = await connect();
    const described = (rows: any) => ({
      ...batch(rows),
      affectedRows: rows.affectedRows,
      columns: rows.columns.map((column: any) => column.name),
    });
    for (const options of [{}, { prepare: false }]) {
      await using other = await connect(options);
      for (let run = 0; run < 2; run++) {
        const all: any[] = [];
        for await (const rows of other`select x, x::text as t from generate_series(1, 5) as x`.cursor(2)) {
          all.push(described(rows));
        }
        expect(all).toEqual([
          { x: [1, 2], count: 2, command: null, affectedRows: 0, columns: ["x", "t"] },
          { x: [3, 4], count: 2, command: null, affectedRows: 0, columns: ["x", "t"] },
          { x: [5], count: 1, command: "SELECT", affectedRows: 0, columns: ["x", "t"] },
        ]);
      }
    }
  });

  test("the query of a cursor resolves to no rows, their count, and the command if the statement ended", async () => {
    await using sql = await connect();
    // After a multiple of the limit the server has no rows left to say so with: no batch has the command.
    const even: any[] = [];
    const exact = series(sql, 6);
    for await (const rows of exact.cursor(3)) even.push(batch(rows));
    expect(even).toEqual([
      { x: [1, 2, 3], count: 3, command: null },
      { x: [4, 5, 6], count: 3, command: null },
    ]);
    const single: any[] = [];
    for await (const rows of series(sql, 2).cursor()) single.push(batch(rows));
    expect(single).toEqual([
      { x: [1], count: 1, command: null },
      { x: [2], count: 1, command: null },
    ]);
    // The query of an iterator resolves as that of a callback does: no rows, their count, and the command that ended.
    expect({ ...summary(await exact), columns: (await exact).columns.map((column: any) => column.name) }).toEqual({
      x: [],
      count: 6,
      command: "SELECT",
      affectedRows: 0,
      columns: ["x"],
    });

    const seen: number[][] = [];
    expect(summary(await series(sql, 4).cursor(2, rows => void seen.push(xs(rows))))).toEqual({
      x: [],
      count: 4,
      command: "SELECT",
      affectedRows: 0,
    });
    expect(summary(await series(sql, 3).cursor(2, rows => void seen.push(xs(rows))))).toEqual({
      x: [],
      count: 3,
      command: "SELECT",
      affectedRows: 0,
    });
    // Stopped before the statement ended: the server has not named the command.
    expect(summary(await series(sql, 9).cursor(2, rows => (seen.push(xs(rows)), sql.CLOSE)))).toEqual({
      x: [],
      count: 2,
      command: null,
      affectedRows: 0,
    });
    const stopped = series(sql, 9);
    for await (const rows of stopped.cursor(2)) {
      seen.push(xs(rows));
      break;
    }
    expect(summary(await stopped)).toEqual({ x: [], count: 2, command: null, affectedRows: 0 });
    expect(summary(await series(sql, 0).cursor(2, rows => void seen.push(xs(rows))))).toEqual({
      x: [],
      count: 0,
      command: "SELECT",
      affectedRows: 0,
    });
    expect(seen).toEqual([[1, 2], [3, 4], [1, 2], [3], [1, 2], [1, 2]]);
  });

  test("values(), raw(), bigint and a column transform apply to every batch", async () => {
    await using sql = await connect({ bigint: true, transform: { column: { from: name => name.toUpperCase() } } });
    const values: unknown[][] = [];
    for await (const rows of sql`select x::int8 as big, x::text as t from generate_series(1, 3) as x`
      .values()
      .cursor(2)) {
      values.push([...rows]);
    }
    expect(values).toEqual([
      [
        [1n, "1"],
        [2n, "2"],
      ],
      [[3n, "3"]],
    ]);
    const raw: string[][] = [];
    await sql`select x::text as t from generate_series(1, 3) as x`
      .raw()
      .cursor(2, rows => void raw.push(rows.map((row: Buffer[]) => row[0].toString())));
    expect(raw).toEqual([["1", "2"], ["3"]]);
    const objects: unknown[] = [];
    for await (const rows of sql`select x::int4 as small from generate_series(1, 3) as x`.cursor(2)) {
      objects.push(...rows);
    }
    expect(objects).toEqual([{ SMALL: 1 }, { SMALL: 2 }, { SMALL: 3 }]);
  });

  test("a plan that streams computes no row that was not asked for", async () => {
    await using sql = await connect();
    await sql`create temporary sequence counted`;
    const query = () => sql`select nextval('counted')::int as x from generate_series(1, 1000)`;
    for await (const rows of query().cursor(10)) {
      expect(xs(rows)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      break;
    }
    expect(await sql`select last_value::int as x from counted`).toEqual([{ x: 10 }]);
    await query().cursor(5, rows => (xs(rows).at(-1) === 25 ? sql.CLOSE : undefined));
    expect(await sql`select last_value::int as x from counted`).toEqual([{ x: 25 }]);
    expect(await inTransaction(sql)).toBe(false);
  });

  test("sql.CLOSE and sql.END are one token, on every handle", async () => {
    await using sql = await connect();
    expect(sql.CLOSE).toBe(sql.END);
    expect(Object.isFrozen(sql.CLOSE)).toBe(true);
    expect(Bun.sql.CLOSE).toBe(sql.CLOSE);
    expect(SQL.prototype.END).toBe(sql.CLOSE);
    let calls = 0;
    {
      using reserved = await sql.reserve();
      expect(reserved.CLOSE).toBe(sql.CLOSE);
      await reserved.begin(tx =>
        tx`select x from generate_series(1, 9) as x`.cursor(2, () => (++calls === 2 ? reserved.END : undefined)),
      );
    }
    await sql.begin(async tx => {
      expect(tx.END).toBe(sql.CLOSE);
      await tx`select x from generate_series(1, 9) as x`.cursor(2, async () => (++calls === 4 ? tx.CLOSE : undefined));
    });
    expect(calls).toBe(4);
  });

  test("the callback is awaited, and what it throws ends the cursor and rejects", async () => {
    await using sql = await connect();
    const order: string[] = [];
    await series(sql, 2).cursor(async ([{ x }]) => {
      order.push(x + "a");
      await new Promise<void>(resolve => setImmediate(resolve));
      order.push(x + "b");
    });
    expect(order).toEqual(["1a", "1b", "2a", "2b"]);

    await sql`create temporary table kept (x int)`;
    const thrown = new Error("from the callback");
    const query = sql`insert into kept select generate_series(1, 5) returning x`.cursor(2, rows => {
      order.push("rows " + xs(rows));
      throw thrown;
    });
    expect(await outcome(query)).toBe(thrown);
    expect(order.slice(4)).toEqual(["rows 1,2"]);
    // As a loop body that throws: what the statement wrote is there.
    expect([await inTransaction(sql), await sql`select count(*)::int as x from kept`]).toEqual([false, [{ x: 5 }]]);

    const rejected = sql`select x from generate_series(1, 5) as x`.cursor(2, () => Promise.reject(thrown));
    expect(await outcome(rejected)).toBe(thrown);
  });

  test("the callback of the rows that the statement ends with is awaited, and what it throws rejects the query", async () => {
    await using sql = await connect();
    await sql`create temporary table last_batch (x int)`;
    const order: string[] = [];
    const result = await series(sql, 3).cursor(2, async rows => {
      order.push("start " + xs(rows));
      await new Promise<void>(resolve => setImmediate(resolve));
      order.push("end " + xs(rows));
    });
    order.push("resolved " + result.count);
    expect(order).toEqual(["start 1,2", "end 1,2", "start 3", "end 3", "resolved 3"]);

    const thrown = new Error("from the last callback");
    const seen: number[][] = [];
    const query = sql`insert into last_batch select generate_series(1, 3) returning x`.cursor(2, rows => {
      seen.push(xs(rows));
      if (rows.command !== null) throw thrown;
    });
    expect(await outcome(query)).toBe(thrown);
    // The cursor was committed before its last rows were handed out: the throw undoes nothing.
    expect([seen, await inTransaction(sql), await sql`select count(*)::int as x from last_batch`]).toEqual([
      [[1, 2], [3]],
      false,
      [{ x: 3 }],
    ]);
    const rejected = sql`insert into last_batch select generate_series(4, 6) returning x`.cursor(5, () =>
      Promise.reject(thrown),
    );
    expect(await outcome(rejected)).toBe(thrown);
    expect(await sql`select count(*)::int as x from last_batch`).toEqual([{ x: 6 }]);
  });

  test("a loop body that throws, and a return() with no next()", async () => {
    await using sql = await connect();
    const thrown = new Error("from the loop");
    const reading = (async () => {
      for await (const _ of series(sql, 9).cursor(2)) throw thrown;
    })();
    expect(await outcome(reading)).toBe(thrown);
    expect(await inTransaction(sql)).toBe(false);

    // Until its first next() the iterator has sent nothing, and the query is any other query.
    const query = series(sql, 3);
    const iterator = query.cursor(2);
    expect(iterator[Symbol.asyncIterator]()).toBe(iterator);
    expect(await iterator.return()).toEqual({ done: true, value: undefined });
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(xs(await query)).toEqual([1, 2, 3]);
    // The query has started: it has no cursor any more.
    expect(() => query.cursor(2)).toThrow(expect.objectContaining({ code: "ERR_INVALID_STATE" }));

    // `await using` ends the cursor at the end of its block.
    await sql`create temporary table disposed (x int)`;
    const disposed = sql`insert into disposed select generate_series(1, 9) returning x`;
    {
      await using batches = disposed.cursor(2);
      expect(xs((await batches.next()).value)).toEqual([1, 2]);
    }
    expect(summary(await disposed)).toEqual({ x: [], count: 2, command: null, affectedRows: 0 });
    expect([await inTransaction(sql), await sql`select count(*)::int as x from disposed`]).toEqual([false, [{ x: 9 }]]);
  });

  test("INSERT ... RETURNING: the first batch has written every row", async () => {
    await using sql = await connect();
    await sql`create temporary table written (x int)`;
    const counts: number[] = [];
    const all: any[] = [];
    await sql.begin(async tx => {
      for await (const rows of tx`insert into written select generate_series(1, 7) returning x`.cursor(3)) {
        all.push(batch(rows));
        counts.push((await tx`select count(*)::int as x from written`)[0].x);
      }
    });
    expect(all).toEqual([
      { x: [1, 2, 3], count: 3, command: null },
      { x: [4, 5, 6], count: 3, command: null },
      { x: [7], count: 1, command: "INSERT" },
    ]);
    expect(counts).toEqual([7, 7, 7]);

    // The tag of the last Execute counts one row. The query counts them all.
    expect(
      summary(await sql`insert into written select generate_series(8, 14) returning x`.cursor(3, () => {})),
    ).toEqual({ x: [], count: 7, command: "INSERT", affectedRows: 7 });
    // A cursor that stops early keeps what the statement wrote, and the server has not said how much that is.
    expect(
      summary(await sql`insert into written select generate_series(15, 21) returning x`.cursor(3, () => sql.CLOSE)),
    ).toEqual({ x: [], count: 3, command: null, affectedRows: 0 });
    expect(await sql`select count(*)::int as x from written`).toEqual([{ x: 21 }]);
  });

  test("a statement that returns no rows gives no batch, and the query has its count", async () => {
    await using sql = await connect();
    await sql`create temporary table rowless (x int)`;
    let calls = 0;
    const inserted = sql`insert into rowless values (1), (2)`;
    expect(await batches(inserted.cursor(3))).toEqual([]);
    expect(summary(await inserted)).toEqual({ x: [], count: 2, command: "INSERT", affectedRows: 2 });
    expect(summary(await sql`update rowless set x = x + 1`.cursor(3, () => void calls++))).toEqual({
      x: [],
      count: 2,
      command: "UPDATE",
      affectedRows: 2,
    });
    expect(summary(await sql`delete from rowless where false`.cursor(() => void calls++))).toEqual({
      x: [],
      count: 0,
      command: "DELETE",
      affectedRows: 0,
    });
    expect(
      summary(await sql`create temporary table copied as select * from rowless`.cursor(() => void calls++)),
    ).toEqual({ x: [], count: 2, command: "SELECT", affectedRows: 0 });
    expect(calls).toBe(0);
    expect([await inTransaction(sql), xs(await sql`select x from copied order by x`)]).toEqual([false, [2, 3]]);
  });

  test("statements that are no cursor, and arguments that are no row limit", async () => {
    await using sql = await connect();
    expect(failure(await outcome(sql`wat`.cursor(() => {})))).toMatchObject({ errno: "42601" });
    expect(failure(await outcome(sql.unsafe("select 1 as x; select 2 as x").cursor(() => {})))).toMatchObject({
      errno: "42601",
      message: "cannot insert multiple commands into a prepared statement",
    });
    expect(failure(await outcome(sql`copy (select 1) to stdout`.cursor(() => {})))).toEqual({
      code: "ERR_POSTGRES_COPY_NOT_SUPPORTED",
      errno: undefined,
      message: "A COPY statement has no cursor: use query.readable() or query.writable()",
    });
    // An empty statement has no command and no rows.
    expect(await batches(sql.unsafe("").cursor(2))).toEqual([]);
    expect([await inTransaction(sql), await sql`select 1 as x`]).toEqual([false, [{ x: 1 }]]);

    for (const rows of [0, -1, 1.5, 2 ** 31, NaN, Infinity]) {
      expect(() => series(sql, 1).cursor(rows)).toThrow(expect.objectContaining({ code: "ERR_OUT_OF_RANGE" }));
    }
    for (const rows of ["3", null, {}, 3n]) {
      expect(() => series(sql, 1).cursor(rows as any)).toThrow(
        expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
      );
    }
    expect(() => series(sql, 1).cursor(2, "fn" as any)).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );

    // A query is a cursor or a COPY stream, and it says so before it starts.
    const started = series(sql, 1);
    await started;
    expect(() => started.cursor()).toThrow(expect.objectContaining({ code: "ERR_INVALID_STATE" }));
    const copy = sql`copy (select 1) to stdout`;
    const stream = copy.readable();
    expect(() => copy.cursor()).toThrow(expect.objectContaining({ code: "ERR_INVALID_STATE" }));
    expect(await stream.text()).toBe("1\n");
    const cursor = series(sql, 1).cursor(() => {});
    expect(() => cursor.readable()).toThrow(expect.objectContaining({ code: "ERR_INVALID_STATE" }));
    expect(batch(await cursor)).toEqual({ x: [], count: 1, command: "SELECT" });

    // The first cursor() that is called with a callback, or iterated, has the query.
    const claimed = { code: "ERR_INVALID_STATE", message: "Invalid state: cursor() was already called on this query" };
    const calls: string[] = [];
    const twice = series(sql, 3).cursor(2, () => void calls.push("first"));
    expect(() => twice.cursor(2, () => void calls.push("second"))).toThrow(expect.objectContaining(claimed));
    expect(() => twice.cursor()).toThrow(expect.objectContaining(claimed));
    const late = series(sql, 3);
    const unread = late.cursor(2);
    late.cursor(2, () => void calls.push("callback"));
    expect(await outcome(unread.next())).toMatchObject(claimed);
    expect([(await twice).count, (await late).count, calls]).toEqual([
      3,
      3,
      ["first", "first", "callback", "callback"],
    ]);
    const iterated = series(sql, 3);
    await using one = iterated.cursor(2);
    const other = iterated.cursor(2);
    expect(xs((await one.next()).value)).toEqual([1, 2]);
    expect(await outcome(other.next())).toMatchObject(claimed);
  });

  test("simple(), sql.unsafe() without values and sql.file(): the rows come as text, as without a cursor", async () => {
    using dir = tempDir("postgres-cursor-text", {
      "typed.sql": "select array[x, x] as a, 0.1::float4 as f from generate_series(1, 3) as x",
    });
    await using sql = await connect();
    const text = "select array[x, x] as a, 0.1::float4 as f from generate_series(1, 3) as x";
    const read = async (query: SQL.Query<any>) => {
      const all: unknown[] = [];
      for await (const rows of query.cursor(2)) all.push(...rows);
      return all;
    };
    // Twice: nothing of the first run is kept for the second.
    for (let run = 0; run < 2; run++) {
      const awaited = [...(await sql.unsafe(text))];
      expect(await read(sql.unsafe(text))).toEqual(awaited);
      expect(await read(sql.file(path.join(String(dir), "typed.sql")))).toEqual(awaited);
      expect(
        await read(sql`select array[x, x] as a, 0.1::float4 as f from generate_series(1, 3) as x`.simple()),
      ).toEqual(awaited);
      // With the extended protocol a statement is described before its rows come, from the first run on.
      const prepared = () => sql`select array[x, x] as a, 0.1::float4 as f from generate_series(1, ${3}::int) as x`;
      await prepared();
      const warm = [...(await prepared())];
      expect(await read(prepared())).toEqual(warm);
      expect(await read(sql`select array[x, x] as a, 0.1::float4 as f from generate_series(1, 3) as x`)).toEqual(warm);
      expect(warm[0].a).toBeInstanceOf(Int32Array);
      expect(awaited[0].a).toBeInstanceOf(Array);
    }
    // The statement of a cursor is its own: the server keeps none of them.
    expect(
      await sql`select statement from pg_prepared_statements where statement like '%0.1::float4%' and statement not like '%$1%'`,
    ).toEqual([]);
  });

  test("simple() means the same before and after cursor(): no parameters", async () => {
    await using sql = await connect();
    const simple = { code: "ERR_INVALID_ARG_TYPE" };
    expect(await outcome(sql`select ${1}::int as x`.simple().cursor(() => {}))).toMatchObject(simple);
    expect(await outcome(sql`select ${1}::int as x`.cursor(() => {}).simple())).toMatchObject(simple);
    expect(await outcome(batches(sql`select ${1}::int as x`.simple().cursor()))).toMatchObject(simple);
    const limited: number[][] = [];
    await sql`select x from generate_series(1, 3) as x`.cursor(2, rows => void limited.push(xs(rows))).simple();
    expect(limited).toEqual([[1, 2], [3]]);
    expect([await inTransaction(sql), await sql`select 1 as x`]).toEqual([false, [{ x: 1 }]]);
  });

  test("an identifier is no query", async () => {
    await using sql = await connect();
    expect(() => sql("name").cursor()).toThrow(expect.objectContaining({ code: "ERR_POSTGRES_NOT_TAGGED_CALL" }));
  });

  describe("in a transaction", () => {
    test("two cursors are read in turns, and none is left", async () => {
      await using sql = await connect();
      const seen: number[] = [];
      await sql.begin(async tx => {
        const low = tx`select x from generate_series(1, 4) as x`.cursor(1)[Symbol.asyncIterator]();
        const high = tx`select x from generate_series(101, 104) as x`.cursor(2)[Symbol.asyncIterator]();
        for (;;) {
          const [a, b] = [await low.next(), await high.next()];
          if (a.done && b.done) break;
          seen.push(...xs(a.value ?? []), ...xs(b.value ?? []));
          if (!a.done) expect(await portals(tx)).toHaveLength(b.done ? 1 : 2);
        }
        expect(await portals(tx)).toEqual([]);
      });
      expect(seen).toEqual([1, 101, 102, 2, 103, 104, 3, 4]);
    });

    test("every end closes the portal, so that its table can change", async () => {
      await using sql = await connect();
      await sql`create temporary table changing (x int)`;
      await sql`insert into changing select generate_series(1, 7)`;
      const ends: [string, (tx: SQL) => Promise<unknown>][] = [
        ["the last batch", tx => batches(tx`select x from changing`.cursor(3))],
        ["a result in one batch", tx => batches(tx`select x from changing`.cursor(100))],
        [
          "break",
          async tx => {
            for await (const _ of tx`select x from changing`.cursor(3)) break;
          },
        ],
        ["the token", tx => tx`select x from changing`.cursor(3, () => tx.CLOSE)],
        [
          "a callback that throws",
          tx =>
            outcome(
              tx`select x from changing`.cursor(3, () => {
                throw new Error("stop");
              }),
            ),
        ],
        [
          "cancel()",
          async tx => {
            const query = tx`select x from changing`;
            const iterator = query.cursor(3)[Symbol.asyncIterator]();
            await iterator.next();
            query.cancel();
            expect(failure(await outcome(iterator.next()))).toEqual(cancelled);
          },
        ],
      ];
      await sql.begin(async tx => {
        for (const [name, end] of ends) {
          await end(tx);
          expect([name, await portals(tx)]).toEqual([name, []]);
          // 55006 while a portal has the table, also one that was read to its end.
          await tx.unsafe(`alter table changing add column "${name}" int`);
        }
      });
      expect(Object.keys((await sql`select * from changing limit 1`)[0])).toEqual(["x", ...ends.map(([name]) => name)]);
    });

    test("a savepoint that is rolled back takes the cursors that it opened", async () => {
      await using sql = await connect();
      await sql.begin(async tx => {
        const before = tx`select x from generate_series(1, 9) as x`.cursor(2)[Symbol.asyncIterator]();
        expect(xs((await before.next()).value)).toEqual([1, 2]);
        let inside: AsyncIterator<any[]>;
        const rolledBack = tx.savepoint(async sp => {
          inside = sp`select x from generate_series(1, 9) as x`.cursor(2)[Symbol.asyncIterator]();
          expect(xs((await inside.next()).value)).toEqual([1, 2]);
          expect(xs((await before.next()).value)).toEqual([3, 4]);
          throw new Error("roll back");
        });
        expect(failure(await outcome(rolledBack))).toMatchObject({ message: "roll back" });
        expect(failure(await outcome(inside!.next()))).toEqual(closed("the savepoint ended before the cursor did"));
        // The one from before keeps the place that it reached inside.
        expect(xs((await before.next()).value)).toEqual([5, 6]);
        await before.return!(undefined);
        expect(await portals(tx)).toEqual([]);
      });
    });

    test("a cursor of the transaction that is opened inside a savepoint ends with the ROLLBACK of that savepoint", async () => {
      await using sql = await connect();
      await sql`create temporary table kept (x int)`;
      await sql.begin(async tx => {
        const before = series(tx, 9).cursor(2);
        expect(xs((await before.next()).value)).toEqual([1, 2]);
        // Made before the savepoint, and bound inside it: the server keeps its portal as long as the savepoint.
        const inside = series(tx, 9).cursor(2);
        let later: Bun.SQL.CursorIterator<any[]>;
        const rolledBack = tx.savepoint(async () => {
          expect(xs((await inside.next()).value)).toEqual([1, 2]);
          await tx.savepoint(async () => {
            later = series(tx, 9).cursor(2);
            expect(xs((await later.next()).value)).toEqual([1, 2]);
          });
          // RELEASE has handed it to the savepoint around.
          expect(xs((await later!.next()).value)).toEqual([3, 4]);
          throw new Error("roll back");
        });
        expect(failure(await outcome(rolledBack))).toMatchObject({ message: "roll back" });
        const why = closed("the savepoint that it was opened in ended");
        expect(failure(await outcome(inside.next()))).toEqual(why);
        expect(failure(await outcome(later!.next()))).toEqual(why);
        // No request went out for a portal that the server has ended: the transaction is not aborted.
        expect(xs((await before.next()).value)).toEqual([3, 4]);
        await before.return();
        await tx`insert into kept values (1)`;
        expect(await portals(tx)).toEqual([]);
      });
      expect(await sql`select count(*)::int as x from kept`).toEqual([{ x: 1 }]);
    });

    test("a cursor of a reserved connection that is opened inside reserved.begin() ends with that transaction", async () => {
      await using sql = await connect();
      using reserved = await sql.reserve();
      let iterator: Bun.SQL.CursorIterator<any[]>;
      await reserved.begin(async () => {
        iterator = series(reserved, 9).cursor(2);
        expect(xs((await iterator.next()).value)).toEqual([1, 2]);
      });
      expect(failure(await outcome(iterator!.next()))).toEqual(closed("the transaction that it was opened in ended"));
      expect([await inTransaction(reserved), await portals(reserved)]).toEqual([false, []]);
    });

    test("a callback runs a statement of the transaction between two batches", async () => {
      await using sql = await connect();
      await sql`create temporary table doubled (x int)`;
      await sql.begin(async tx => {
        await series(tx, 5).cursor(2, async rows => {
          await tx`insert into doubled ${tx(rows.map(row => ({ x: row.x * 2 })))}`;
        });
      });
      expect(xs(await sql`select x from doubled order by x`)).toEqual([2, 4, 6, 8, 10]);
    });

    test("sql.file() on the handle of a transaction or of a reservation: the cursor reads on the connection of the handle", async () => {
      using dir = tempDir("postgres-cursor-file", {
        "local.sql": "select pg_backend_pid() as pid, x from local_rows order by x",
      });
      const file = path.join(String(dir), "local.sql");
      await using sql = await connect({ max: 2 });
      const read = async (handle: SQL) => {
        // A temporary table: only the session of `handle` has it.
        await handle`create temporary table local_rows on commit drop as select generate_series(1, 3) as x`;
        const pid = await pidOf(handle);
        const iterated: unknown[] = [];
        for await (const rows of handle.file(file).cursor(2)) iterated.push(rows.map(row => [row.pid === pid, row.x]));
        const called: unknown[] = [];
        await handle.file(file).cursor(2, rows => void called.push(xs(rows)));
        return [iterated, called];
      };
      const expected = [
        [
          [
            [true, 1],
            [true, 2],
          ],
          [[true, 3]],
        ],
        [[1, 2], [3]],
      ];
      expect(await sql.begin(read)).toEqual(expected);
      using reserved = await sql.reserve();
      expect(await reserved.begin(read)).toEqual(expected);
      await reserved.unsafe("BEGIN");
      expect(await read(reserved)).toEqual(expected);
      await reserved.unsafe("ROLLBACK");
    });

    test("a savepoint that is rolled back takes the cursors of the other handles that were opened in it", async () => {
      await using sql = await connect();
      await sql`create temporary table around (x int)`;
      await sql.begin(async tx => {
        await tx`insert into around values (1)`;
        await tx.savepoint(async outer => {
          await outer`insert into around values (2)`;
          let inside: Bun.SQL.CursorIterator<any[]>;
          // A savepoint of `tx`: on the server it is inside the one of `outer`, whose handle is no scope around it.
          const inner = tx.savepoint(async () => {
            inside = series(outer, 9).cursor(2);
            expect(xs((await inside.next()).value)).toEqual([1, 2]);
            throw new Error("roll back");
          });
          expect(failure(await outcome(inner))).toMatchObject({ message: "roll back" });
          expect(failure(await outcome(inside!.next()))).toEqual(closed("the savepoint that it was opened in ended"));
          await outer`insert into around values (3)`;
        });
        await tx`insert into around values (4)`;
      });
      expect(xs(await sql`select x from around order by x`)).toEqual([1, 2, 3, 4]);
    });

    test("a cursor that is open when the transaction ends fails it, as an open COPY stream does", async () => {
      await using sql = await connect();
      await sql`create temporary table undone (x int)`;
      let iterator: AsyncIterator<any[]>;
      const transaction = sql.begin(async tx => {
        await tx`insert into undone values (1)`;
        iterator = tx`select x from generate_series(1, 9) as x`.cursor(2)[Symbol.asyncIterator]();
        await iterator.next();
      });
      const why = closed("the transaction ended before the cursor did");
      expect(failure(await outcome(transaction))).toEqual(why);
      expect(failure(await outcome(iterator!.next()))).toEqual(why);
      expect(await sql`select count(*)::int as x from undone`).toEqual([{ x: 0 }]);
    });

    test("a statement that fails takes the cursor with it", async () => {
      await using sql = await connect();
      const transaction = sql.begin(async tx => {
        const iterator = tx`select x from generate_series(1, 9) as x`.cursor(2)[Symbol.asyncIterator]();
        await iterator.next();
        expect(failure(await outcome(tx`select 1 / 0`))).toMatchObject({ errno: "22012" });
        // current transaction is aborted
        expect(failure(await outcome(iterator.next()))).toMatchObject({ errno: "25P02" });
        expect(await iterator.next()).toEqual({ done: true, value: undefined });
      });
      expect(failure(await outcome(transaction))).toMatchObject({ code: "ERR_POSTGRES_COMMIT_ROLLED_BACK" });
      expect(await sql`select 1 as x`).toEqual([{ x: 1 }]);
    });
  });

  describe("on a reserved connection", () => {
    test("that is in no transaction, a cursor is refused and nothing is written", async () => {
      await using sql = await connect();
      await sql`create temporary table refused (x int)`;
      using reserved = await sql.reserve();
      const query = reserved`insert into refused select generate_series(1, 5) returning x`;
      expect(failure(await outcome(batches(query.cursor(2))))).toEqual(needsTransaction);
      expect(failure(await outcome(query))).toEqual(needsTransaction);
      expect(failure(await outcome(reserved`select 1 as x`.cursor(() => {})))).toEqual(needsTransaction);
      expect([await inTransaction(reserved), await reserved`select count(*)::int as x from refused`]).toEqual([
        false,
        [{ x: 0 }],
      ]);
      // reserved.begin() gives the transaction.
      const read = await reserved.begin(tx =>
        batches(tx`insert into refused select generate_series(1, 5) returning x`.cursor(2)),
      );
      expect(read).toEqual([[1, 2], [3, 4], [5]]);
      expect(await reserved`select count(*)::int as x from refused`).toEqual([{ x: 5 }]);
    });

    test("inside a BEGIN by hand, the transaction stays the caller's", async () => {
      await using sql = await connect();
      await using monitor = await connect();
      await sql`create temporary table by_hand (x int)`;
      using reserved = await sql.reserve();
      const pid = await pidOf(reserved);
      // Not awaited: the cursor learns from the server, in its turn, that a transaction is open.
      const begun = reserved.unsafe("BEGIN").execute();
      const states: string[] = [];
      for await (const rows of reserved`insert into by_hand select generate_series(1, 5) returning x`.cursor(2)) {
        const [backend] = await monitor`select state from pg_stat_activity where pid = ${pid}`;
        states.push(`${xs(rows)}: ${backend.state}, ${await portals(reserved)}`);
      }
      await begun;
      // Every batch ended with its own Sync: the backend waits as it does between two statements.
      expect(states).toEqual([
        "1,2: idle in transaction, C1",
        "3,4: idle in transaction, C1",
        "5: idle in transaction, ",
      ]);
      expect([await inTransaction(reserved), await portals(reserved)]).toEqual([true, []]);
      await reserved.unsafe("ROLLBACK");
      expect(await reserved`select count(*)::int as x from by_hand`).toEqual([{ x: 0 }]);

      // The COMMIT of the caller takes the portal. 34000: the portal does not exist.
      await reserved.unsafe("BEGIN");
      const iterator = reserved`select x from generate_series(1, 9) as x`.cursor(2);
      await iterator.next();
      await reserved.unsafe("COMMIT");
      expect(failure(await outcome(iterator.next()))).toMatchObject({ errno: "34000" });
      expect([await inTransaction(reserved), await reserved`select 1 as x`]).toEqual([false, [{ x: 1 }]]);
    });

    // What the caller sent before the cursor is answered by the time the cursor asks where the session is.
    test.each<[string, (reserved: SQL) => Promise<unknown>, unknown]>([
      [
        "BEGIN and an INSERT that are not answered yet: the cursor joins, and the ROLLBACK of the caller undoes all",
        async reserved => {
          reserved.unsafe("BEGIN").execute();
          reserved`insert into ordered values (1)`.execute();
          const read = await batches(series(reserved, 7).cursor(3));
          await reserved`insert into ordered values (2)`;
          await reserved.unsafe("ROLLBACK");
          return [read, await reserved`select count(*)::int as x from ordered`];
        },
        [[[1, 2, 3], [4, 5, 6], [7]], [{ x: 0 }]],
      ],
      [
        "a COMMIT that is not answered yet: the cursor comes after it, and is refused",
        async reserved => {
          await reserved.unsafe("BEGIN");
          reserved.unsafe("COMMIT").execute();
          return [failure(await outcome(batches(series(reserved, 4).cursor(3)))), await inTransaction(reserved)];
        },
        [needsTransaction, false],
      ],
      [
        "BEGIN and a statement that fails: the cursor fails as the next statement of that transaction would",
        async reserved => {
          reserved.unsafe("BEGIN").execute();
          const failed = outcome(reserved`select 1 / 0`);
          const cursor = failure(await outcome(batches(series(reserved, 7).cursor(3))));
          const next = failure(await outcome(reserved`insert into ordered values (2)`));
          await failed;
          await reserved.unsafe("ROLLBACK");
          return [cursor.errno, next.errno, await inTransaction(reserved)];
        },
        ["25P02", "25P02", false],
      ],
      [
        "after a query that was cancelled on the wire, in no transaction: refused",
        async reserved => {
          const query = reserved`select ${1}::int as x`;
          const running = outcome(query);
          query.cancel();
          await running;
          return [failure(await outcome(batches(series(reserved, 7).cursor(3)))), await inTransaction(reserved)];
        },
        [needsTransaction, false],
      ],
      [
        "BEGIN, the cursor and COMMIT in one go: the COMMIT of the caller ends the portal after its first batch",
        async reserved => {
          reserved.unsafe("BEGIN").execute();
          const seen: number[][] = [];
          const reading = (async () => {
            for await (const rows of series(reserved, 7).cursor(3)) seen.push(xs(rows));
          })();
          await reserved.unsafe("COMMIT");
          return [failure(await outcome(reading)).errno, seen, await inTransaction(reserved)];
        },
        // 34000: the portal does not exist
        ["34000", [[1, 2, 3]], false],
      ],
    ])("%s", async (_, run, expected) => {
      await using sql = await connect();
      await sql`create temporary table ordered (x int)`;
      using reserved = await sql.reserve();
      expect(await run(reserved)).toEqual(expected);
      expect([await portals(reserved), await reserved`select 1 as x`]).toEqual([[], [{ x: 1 }]]);
    });

    test("the end of a cursor ends no transaction: not that of the caller, not that of another cursor", async () => {
      await using sql = await connect();
      await sql`create temporary table shared (x int)`;
      using reserved = await sql.reserve();
      await reserved.unsafe("BEGIN");
      const first = reserved`insert into shared select generate_series(1, 4) returning x`.cursor(2);
      const second = reserved`insert into shared select generate_series(5, 8) returning x`.cursor(2);
      expect([xs((await first.next()).value), xs((await second.next()).value)]).toEqual([
        [1, 2],
        [5, 6],
      ]);
      // One ends early and one is cancelled. Neither is the end of the transaction that they read in.
      await first.return();
      expect([await inTransaction(reserved), await portals(reserved)]).toEqual([true, ["C2"]]);
      const cancelledQuery = reserved`select x from generate_series(1, 9) as x`;
      const third = cancelledQuery.cursor(2);
      await third.next();
      cancelledQuery.cancel();
      expect(failure(await outcome(third.next()))).toEqual(cancelled);
      expect(xs((await second.next()).value)).toEqual([7, 8]);
      expect(await second.next()).toEqual({ done: true, value: undefined });
      expect([await inTransaction(reserved), await portals(reserved)]).toEqual([true, []]);
      // The caller decides, and both statements wrote all their rows at their first batch.
      expect(await reserved`select count(*)::int as x from shared`).toEqual([{ x: 8 }]);
      await reserved.unsafe("ROLLBACK");
      expect(await reserved`select count(*)::int as x from shared`).toEqual([{ x: 0 }]);
    });

    test("a statement of the caller that fails takes the cursor with it, and the transaction stays open", async () => {
      await using sql = await connect();
      await sql`create temporary table failed (x int)`;
      using reserved = await sql.reserve();
      await reserved.unsafe("BEGIN");
      const reading = (async () => {
        for await (const _ of reserved`insert into failed select generate_series(1, 9) returning x`.cursor(2)) {
          expect(failure(await outcome(reserved`select 1 / 0`))).toMatchObject({ errno: "22012" });
        }
      })();
      // current transaction is aborted
      expect(failure(await outcome(reading))).toMatchObject({ errno: "25P02" });
      expect(failure(await outcome(reserved`select 1 as x`))).toMatchObject({ errno: "25P02" });
      await reserved.unsafe("ROLLBACK");
      expect([await inTransaction(reserved), await reserved`select count(*)::int as x from failed`]).toEqual([
        false,
        [{ x: 0 }],
      ]);
    });

    test("release() ends a cursor that is open", async () => {
      await using sql = await connect();
      await sql`create temporary table released (x int)`;
      const reserved = await sql.reserve();
      await reserved.unsafe("BEGIN");
      const iterator = reserved`insert into released select generate_series(1, 9) returning x`.cursor(2);
      try {
        await iterator.next();
      } finally {
        reserved.release();
      }
      expect(failure(await outcome(iterator.next()))).toEqual(closed("the reservation ended before the cursor did"));
      // A connection that comes back in a transaction is not used again.
      expect([await inTransaction(sql), await sql`select 1 as x`]).toEqual([false, [{ x: 1 }]]);
    });
  });

  describe("on a pool", () => {
    test("a cursor has one connection for itself, and the other queries have the rest", async () => {
      await using sql = await connect({ max: 2 });
      const pids = new Set<number>();
      let cursorPid = 0;
      for await (const rows of sql`select pg_backend_pid() as pid, x from generate_series(1, 6) as x`.cursor(2)) {
        cursorPid = rows[0].pid;
        pids.add(await pidOf(sql));
      }
      expect([...pids]).toEqual([expect.any(Number)]);
      expect(pids.has(cursorPid)).toBe(false);
    });

    test("cursors that start together on one connection run one after the other", async () => {
      await using sql = await connect();
      const seen: number[] = [];
      await Promise.all(
        [0, 1, 2, 3, 4, 5, 6].map(i =>
          sql`select ${i}::int as a, generate_series(1, 2) as x`.cursor(([row]) => void seen.push(row.a + row.x)),
        ),
      );
      expect(seen.join("")).toBe("12233445566778");
      expect(await inTransaction(sql)).toBe(false);
    });

    test("a cursor puts BEGIN and COMMIT around its statement as sql.begin() does, also inside a BEGIN by hand", async () => {
      await using sql = await connect();
      await sql`create temporary table by_hand (x int)`;
      await sql.unsafe("BEGIN");
      await sql`insert into by_hand values (1)`;
      expect(await batches(series(sql, 3).cursor(2))).toEqual([[1, 2], [3]]);
      // As after sql.begin() in the same place: the COMMIT of the cursor was the end of the transaction.
      expect(await inTransaction(sql)).toBe(false);
      await sql.unsafe("ROLLBACK");
      expect(await sql`select count(*)::int as x from by_hand`).toEqual([{ x: 1 }]);
    });

    test("as many cursors as connections but one leave a connection for the queries of their loops", async () => {
      await using sql = await connect({ max: 3 });
      const read = async (from: number) => {
        const sums: number[] = [];
        for await (const rows of sql`select x from generate_series(${from}::int, ${from + 3}::int) as x`.cursor(2)) {
          sums.push((await sql`select ${xs(rows)[0]}::int + ${xs(rows)[1]}::int as x`)[0].x);
        }
        return sums;
      };
      expect(await Promise.all([read(1), read(11)])).toEqual([
        [3, 7],
        [23, 27],
      ]);
    });

    test("a session that has forgotten its statements: DEALLOCATE ALL and DISCARD PLANS", async () => {
      await using sql = await connect();
      await sql`create temporary table forgotten (x int)`;
      const write = () => batches(sql`insert into forgotten select generate_series(1, 5) returning x`.cursor(2));
      const all = [[1, 2], [3, 4], [5]];
      expect(await write()).toEqual(all);
      for (const forget of ["DEALLOCATE ALL", "DISCARD PLANS"]) {
        await sql.unsafe(forget);
        expect([forget, await write()]).toEqual([forget, all]);
        expect([
          forget,
          await sql.begin(tx => batches(tx`insert into forgotten select generate_series(1, 5) returning x`.cursor(2))),
        ]).toEqual([forget, all]);
      }
      expect([await inTransaction(sql), await sql`select count(*)::int as x from forgotten`]).toEqual([
        false,
        [{ x: 25 }],
      ]);
      // A statement that refuses a transaction block has no cursor. 25001.
      expect(failure(await outcome(sql`vacuum forgotten`.cursor(() => {})))).toMatchObject({
        errno: "25001",
        message: "VACUUM cannot run inside a transaction block",
      });
      expect([await inTransaction(sql), await sql`select 1 as x`]).toEqual([false, [{ x: 1 }]]);
    });

    test("a cursor has no cached statement that DISCARD ALL or a new column could make stale", async () => {
      await using sql = await connect();
      expect(await batches(series(sql, 3).cursor(2))).toEqual([[1, 2], [3]]);
      await sql.unsafe("DISCARD ALL");
      expect(await batches(series(sql, 3).cursor(2))).toEqual([[1, 2], [3]]);
      await sql`create temporary table forgotten (x int)`;
      await sql`insert into forgotten values (1)`;
      const read = async () => {
        const rows: unknown[] = [];
        for await (const some of sql`select * from forgotten where x = 1 limit 1`.cursor(2)) rows.push(...some);
        return rows;
      };
      expect(await read()).toEqual([{ x: 1 }]);
      await sql`alter table forgotten add column y int default 2`;
      expect(await read()).toEqual([{ x: 1, y: 2 }]);
    });

    test("what a cursor wrote is committed when the cursor ends, and a batch with a command comes after that", async () => {
      await using sql = await connect({ max: 2 });
      const table = sql("cursor_visible_" + Bun.randomUUIDv7("hex").replaceAll("-", ""));
      await sql`create table ${table} (x int)`;
      try {
        const seen: [number[], string | null, number][] = [];
        for await (const rows of sql`insert into ${table} select generate_series(1, 5) returning x`.cursor(2)) {
          // The other connection of the pool.
          seen.push([xs(rows), rows.command, (await sql`select count(*)::int as x from ${table}`)[0].x]);
        }
        expect(seen).toEqual([
          [[1, 2], null, 0],
          [[3, 4], null, 0],
          [[5], "INSERT", 5],
        ]);
      } finally {
        await sql`drop table ${table}`;
      }
    });

    test("the COMMIT of a cursor that fails rejects the cursor, and nothing is written", async () => {
      await using sql = await connect();
      // The constraint is checked at COMMIT. 23505: duplicate key.
      await sql`create temporary table deferred (x int, unique (x) deferrable initially deferred) on commit preserve rows`;
      const duplicate = { code: "ERR_POSTGRES_SERVER_ERROR", errno: "23505" };
      const insert = () => sql`insert into deferred select 1 from generate_series(1, 4) returning x`;

      const toTheEnd = insert();
      const seen: number[][] = [];
      const reading = (async () => {
        for await (const rows of toTheEnd.cursor(3)) seen.push(xs(rows));
      })();
      const err = await outcome(reading);
      expect(failure(err)).toMatchObject(duplicate);
      // The rows that the statement ends with come after its COMMIT, so they do not come.
      expect(seen).toEqual([[1, 1, 1]]);
      expect(await outcome(toTheEnd)).toBe(err);

      const stopped = (async () => {
        for await (const _ of insert().cursor(3)) break;
      })();
      expect(failure(await outcome(stopped))).toMatchObject(duplicate);
      expect(failure(await outcome(insert().cursor(3, () => {})))).toMatchObject(duplicate);
      expect(failure(await outcome(insert().cursor(3, () => sql.CLOSE)))).toMatchObject(duplicate);
      expect([await inTransaction(sql), await sql`select count(*)::int as x from deferred`]).toEqual([
        false,
        [{ x: 0 }],
      ]);
    });
  });

  describe("cancel()", () => {
    test("before the query starts", async () => {
      await using sql = await connect();
      const withCallback = series(sql, 9).cursor(2, () => {});
      withCallback.cancel();
      const query = series(sql, 9);
      const iterator = query.cursor(2);
      query.cancel();
      expect(failure(await outcome(withCallback))).toEqual(cancelled);
      expect(failure(await outcome(iterator.next()))).toEqual(cancelled);
      expect(await sql`select 1 as x`).toEqual([{ x: 1 }]);
    });

    test("while it waits for a connection: the iterator and the query have one error, and nothing ran", async () => {
      await using sql = await connect();
      await sql`create temporary table waited (x int)`;
      const query = sql`insert into waited select generate_series(1, 5) returning x`;
      const withCallback = sql`insert into waited select generate_series(1, 5) returning x`.cursor(2, () => {});
      {
        using holder = await sql.reserve();
        const waiting = outcome(query.cursor(2).next());
        const settled = outcome(withCallback);
        query.cancel();
        withCallback.cancel();
        const err = await waiting;
        expect(failure(err)).toEqual(cancelled);
        expect(await outcome(query)).toBe(err);
        expect(failure(await settled)).toEqual(cancelled);
        expect(await holder`select count(*)::int as x from waited`).toEqual([{ x: 0 }]);
      }
      // The pool serves the next query: the cursors left nothing in its queue.
      expect([await inTransaction(sql), await sql`select count(*)::int as x from waited`]).toEqual([false, [{ x: 0 }]]);

      // The same while the text of sql.file() is read.
      using dir = tempDir("postgres-cursor-cancel", { "insert.sql": "insert into waited values (1) returning x" });
      const fromFile = sql.file(path.join(String(dir), "insert.sql"));
      const reading = outcome(fromFile.cursor(2).next());
      fromFile.cancel();
      const err = await reading;
      expect(failure(err)).toEqual(cancelled);
      expect(await outcome(fromFile)).toBe(err);
      expect(await sql`select count(*)::int as x from waited`).toEqual([{ x: 0 }]);
    });

    test("between two batches", async () => {
      await using sql = await connect();
      await sql`create temporary table undone (x int)`;
      const query = sql`insert into undone select generate_series(1, 9) returning x`;
      await using iterator = query.cursor(2);
      expect(xs((await iterator.next()).value)).toEqual([1, 2]);
      expect(query.cancel()).toBe(query);
      const err = await outcome(iterator.next());
      expect(failure(err)).toEqual(cancelled);
      expect(await outcome(query)).toBe(err);
      expect(await iterator.next()).toEqual({ done: true, value: undefined });
      // The transaction of the cursor is rolled back.
      expect([await inTransaction(sql), await sql`select count(*)::int as x from undone`]).toEqual([false, [{ x: 0 }]]);
    });

    test("after the rows that the statement ended with: the statement is committed, and cancel() changes nothing", async () => {
      await using sql = await connect();
      await sql`create temporary table finished (x int)`;
      const query = sql`insert into finished select generate_series(1, 3) returning x`;
      await using iterator = query.cursor(5);
      const last = (await iterator.next()).value;
      expect(batch(last)).toEqual({ x: [1, 2, 3], count: 3, command: "INSERT" });
      // The cursor has ended on the server before the batch that says so is handed out.
      expect([await inTransaction(sql), await sql`select count(*)::int as x from finished`]).toEqual([
        false,
        [{ x: 3 }],
      ]);
      query.cancel();
      expect(await iterator.next()).toEqual({ done: true, value: undefined });
      expect(summary(await query)).toEqual({ x: [], count: 3, command: "INSERT", affectedRows: 3 });

      const withCallback = sql`insert into finished select generate_series(4, 6) returning x`.cursor(5, async () => {
        withCallback.cancel();
        return [await inTransaction(sql), await sql`select count(*)::int as x from finished`];
      });
      expect(summary(await withCallback)).toEqual({ x: [], count: 3, command: "INSERT", affectedRows: 3 });
      expect(await sql`select count(*)::int as x from finished`).toEqual([{ x: 6 }]);
    });

    /** The first batch comes at once. The backend sleeps in the second one. */
    const slowAfterTwo = (sql: SQL) =>
      sql`select pg_backend_pid() as pid, x, pg_sleep(case when x > 2 then 30 else 0 end) from generate_series(1, 9) as x`;
    /** Resolves when the backend sleeps. Throws what `request` settled with, if that comes first. */
    async function asleep(monitor: SQL, pid: number, request: Promise<unknown>) {
      let settled: { with: unknown } | undefined;
      request.then(
        value => (settled = { with: value }),
        error => (settled = { with: error }),
      );
      for (;;) {
        const [backend] = await monitor`select wait_event from pg_stat_activity where pid = ${pid}`;
        if (backend?.wait_event === "PgSleep") return;
        if (settled) throw new Error("the request ended before the backend slept", { cause: settled.with });
      }
    }

    test("while the server works on the first batch", async () => {
      await using sql = await connect();
      await using monitor = await connect();
      const pid = await pidOf(sql);
      const query = sql`select pg_sleep(30), x from generate_series(1, 9) as x`;
      const first = outcome(query.cursor(2, () => {}));
      await asleep(monitor, pid, first);
      query.cancel();
      // As a query that is cancelled on its way: the error is the answer of the server.
      expect(failure(await first)).toEqual(stopped);
      // The server was asked to stop: the connection does not wait for the 30 seconds.
      expect([await pidOf(sql), await inTransaction(sql)]).toEqual([pid, false]);
    });

    test("while the server works on a later batch", async () => {
      await using sql = await connect();
      await using monitor = await connect();
      const pid = await pidOf(sql);
      const query = slowAfterTwo(sql);
      await using iterator = query.cursor(2);
      expect(xs((await iterator.next()).value)).toEqual([1, 2]);
      const second = outcome(iterator.next());
      await asleep(monitor, pid, second);
      query.cancel();
      const err = await second;
      expect(failure(err)).toEqual(stopped);
      expect(await iterator.next()).toEqual({ done: true, value: undefined });
      expect(await outcome(query)).toBe(err);
      expect([await pidOf(sql), await inTransaction(sql)]).toEqual([pid, false]);
    });

    test("in a transaction, while the server works on a later batch: the error says that the transaction is aborted", async () => {
      await using sql = await connect();
      await using monitor = await connect();
      const pid = await pidOf(sql);
      const transaction = sql.begin(async tx => {
        const query = slowAfterTwo(tx);
        const iterator = query.cursor(2);
        expect(xs((await iterator.next()).value)).toEqual([1, 2]);
        const second = outcome(iterator.next());
        await asleep(monitor, pid, second);
        query.cancel();
        // 57014 is the answer to a statement of this transaction. Between two batches cancel() leaves the transaction alone.
        expect(failure(await second)).toEqual(stopped);
        expect(failure(await outcome(tx`select 1 as x`))).toMatchObject({ errno: "25P02" });
      });
      expect(failure(await outcome(transaction))).toMatchObject({ code: "ERR_POSTGRES_COMMIT_ROLLED_BACK" });
      expect([await pidOf(sql), await inTransaction(sql)]).toEqual([pid, false]);
    });

    test("a transaction that ends while the server works on a batch: the server is asked to stop", async () => {
      await using sql = await connect();
      await using monitor = await connect();
      await sql`create temporary sequence computed`;
      const pid = await pidOf(sql);
      let second: Promise<unknown>;
      const transaction = sql.begin(async tx => {
        const iterator =
          tx`select nextval('computed')::int as x, pg_sleep(case when x > 2 then 30 else 0 end) from generate_series(1, 9) as x`.cursor(
            2,
          );
        expect(xs((await iterator.next()).value)).toEqual([1, 2]);
        second = outcome(iterator.next());
        await asleep(monitor, pid, second);
      });
      const why = closed("the transaction ended before the cursor did");
      expect(failure(await outcome(transaction))).toEqual(why);
      expect(failure(await second!)).toEqual(why);
      // The statement stopped in its third row, and nothing waited for the 30 seconds of that row.
      expect([
        await pidOf(sql),
        await inTransaction(sql),
        await sql`select last_value::int as x from computed`,
      ]).toEqual([pid, false, [{ x: 3 }]]);
    });

    test("cancel() reaches the server also when another cursor of the transaction was closed meanwhile", async () => {
      await using sql = await connect();
      await using monitor = await connect();
      const pid = await pidOf(sql);
      const transaction = sql.begin(async tx => {
        const other = series(tx, 9).cursor(2);
        await other.next();
        const query = slowAfterTwo(tx);
        const iterator = query.cursor(2);
        expect(xs((await iterator.next()).value)).toEqual([1, 2]);
        const second = outcome(iterator.next());
        await asleep(monitor, pid, second);
        // The Close of its portal waits for the request that is on its way. Written behind it, it would keep the cancel back.
        await other.return();
        query.cancel();
        expect(failure(await second)).toEqual(stopped);
      });
      expect(failure(await outcome(transaction))).toMatchObject({ code: "ERR_POSTGRES_COMMIT_ROLLED_BACK" });
      expect([await pidOf(sql), await inTransaction(sql)]).toEqual([pid, false]);
    });

    test("the COMMIT of reserved.begin() waits for a cursor of the reserved connection that has a batch on its way", async () => {
      await using sql = await connect();
      await using monitor = await connect();
      await sql`create temporary table committed (x int)`;
      using reserved = await sql.reserve();
      const pid = await pidOf(reserved);
      let second: Promise<unknown>;
      await reserved.begin(async tx => {
        await tx`insert into committed values (1)`;
        const iterator =
          reserved`select x, pg_sleep(case when x > 2 then 0.2 else 0 end) from generate_series(1, 4) as x`.cursor(2);
        expect(xs((await iterator.next()).value)).toEqual([1, 2]);
        second = outcome(iterator.next());
        await asleep(monitor, pid, second);
      });
      // No cancel: 57014 would abort the transaction that is about to commit.
      expect(failure(await second!)).toEqual(closed("the transaction that it was opened in ended"));
      expect([await inTransaction(reserved), await reserved`select count(*)::int as x from committed`]).toEqual([
        false,
        [{ x: 1 }],
      ]);
    });

    test.each(["the first batch", "a later batch"])(
      "a connection that the server ends while it works on %s",
      async which => {
        await using sql = await connect();
        await using admin = await connect();
        const pid = await pidOf(sql);
        const query =
          which === "the first batch" ? sql`select pg_sleep(30), x from generate_series(1, 9) as x` : slowAfterTwo(sql);
        await using iterator = query.cursor(2);
        if (which === "a later batch") expect(xs((await iterator.next()).value)).toEqual([1, 2]);
        const waiting = outcome(iterator.next());
        await asleep(admin, pid, waiting);
        await admin`select pg_terminate_backend(${pid})`;
        const err: any = await waiting;
        expect(failure(err)).toEqual(terminated);
        expect(await iterator.next()).toEqual({ done: true, value: undefined });
        expect(await outcome(query)).toBe(err);
        // The pool dials again.
        expect(await pidOf(sql)).not.toBe(pid);
        expect(await inTransaction(sql)).toBe(false);
      },
    );
  });

  test("a connection that the server ends between two batches", async () => {
    const ended = Promise.withResolvers<void>();
    await using sql = await connect({ onclose: () => ended.resolve() });
    await using admin = await connect();
    const query = sql`select pg_backend_pid() as pid, x from generate_series(1, 9) as x`;
    await using iterator = query.cursor(2);
    const { value } = await iterator.next();
    await admin`select pg_terminate_backend(${value[0].pid})`;
    await ended.promise;
    const err = await outcome(iterator.next());
    expect(failure(err)).toEqual(terminated);
    expect(await outcome(query)).toBe(err);
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(await sql`select 1 as x`).toEqual([{ x: 1 }]);
  });

  test("close() waits for a cursor, and close({ timeout: 0 }) ends it", async () => {
    const waited = await connect();
    const reading = batches(series(waited, 5).cursor(2));
    await waited.close();
    expect(await reading).toEqual([[1, 2], [3, 4], [5]]);

    const ended = await connect();
    const iterator = series(ended, 9).cursor(2)[Symbol.asyncIterator]();
    await iterator.next();
    await ended.close({ timeout: 0 });
    expect(failure(await outcome(iterator.next()))).toMatchObject({ code: "ERR_POSTGRES_CONNECTION_CLOSED" });
  });

  test("the timeout of the server for a statement counts each batch, not the time between them", async () => {
    await using sql = await connect();
    await using other = await connect();
    // Each batch: the one with the slow row is cancelled, after the one before it was delivered. 57014.
    const slow = sql.begin(async tx => {
      await tx`set local statement_timeout = 300`;
      const iterator = tx`select x, case when x = 3 then pg_sleep(0.6) end from generate_series(1, 4) as x`.cursor(2);
      expect(xs((await iterator.next()).value)).toEqual([1, 2]);
      await iterator.next();
    });
    expect(failure(await outcome(slow))).toMatchObject({ code: "ERR_POSTGRES_SERVER_ERROR", errno: "57014" });
    // Not the time between them: 400 ms by the clock of the server, in which this session gets nothing.
    await sql.begin(async tx => {
      await tx`set local statement_timeout = 300`;
      const iterator = series(tx, 4).cursor(2);
      expect(xs((await iterator.next()).value)).toEqual([1, 2]);
      await other`select pg_sleep(0.4)`;
      expect(xs((await iterator.next()).value)).toEqual([3, 4]);
      expect(await iterator.next()).toEqual({ done: true, value: undefined });
    });
  });

  test("the timeout of the server for an idle transaction ends a cursor whose consumer waits", async () => {
    const ended = Promise.withResolvers<void>();
    await using sql = await connect({ onclose: () => ended.resolve() });
    using reserved = await sql.reserve();
    await reserved.unsafe("BEGIN");
    const query = series(reserved, 9);
    const iterator = query.cursor(2);
    expect(xs((await iterator.next()).value)).toEqual([1, 2]);
    // Between two batches the session is idle in a transaction. From here on the server ends one that is.
    await reserved`set idle_in_transaction_session_timeout = 50`;
    await ended.promise;
    const err = await outcome(iterator.next());
    expect(failure(err)).toEqual({
      code: "ERR_POSTGRES_SERVER_ERROR",
      errno: "25P03",
      message: "terminating connection due to idle-in-transaction timeout",
    });
    expect(await outcome(query)).toBe(err);
  });

  const run = async (script: string) => {
    await container.ready;
    await using proc = Bun.spawn({
      cmd: [bunExe(), "-e", script],
      env: { ...withoutAsanQuarantine(bunEnv), CURSOR_URL: urlOf(container) },
      stdout: "pipe",
      stderr: "inherit",
    });
    const [stdout, exitCode] = await Promise.all([proc.stdout.text(), proc.exited]);
    return { stdout, exitCode };
  };

  test("the consumer holds one batch at a time: nothing keeps a batch while the next one is on its way", async () => {
    // The server waits in the second batch. Meanwhile the first one is collected, if the cursor has let go of it.
    const script = `
      const sql = new Bun.SQL(process.env.CURSOR_URL, { max: 1 });
      const monitor = new Bun.SQL(process.env.CURSOR_URL, { max: 1 });
      const [{ pid }] = await sql\`select pg_backend_pid() as pid\`;
      const query = () => sql\`select x, case when x = 3 then pg_sleep(0.3) end from generate_series(1, 6) as x\`;
      const collected = async (ref, pending) => {
        let settled = false;
        pending.then(() => (settled = true), () => (settled = true));
        for (;;) {
          const [backend] = await monitor\`select wait_event from pg_stat_activity where pid = \${pid}\`;
          if (backend?.wait_event === "PgSleep" || settled) break;
        }
        while (!settled) {
          Bun.gc(true);
          if (ref().deref() === undefined) return true;
          await new Promise(resolve => setImmediate(resolve));
        }
        return false;
      };
      const iterate = async () => {
        const iterator = query().cursor(2);
        // Read in a function that has returned: no variable of this one has the batch.
        const first = await (async () => new WeakRef((await iterator.next()).value))();
        const second = iterator.next();
        const gone = await collected(() => first, second);
        return [gone, (await second).value.length, (await iterator.return()).done];
      };
      const call = async () => {
        let first;
        const second = Promise.withResolvers();
        const callback = query().cursor(2, batch => {
          if (first === undefined) first = new WeakRef(batch);
          else second.resolve();
        });
        callback.execute();
        const gone = await collected(() => first, second.promise);
        return [gone, (await callback).count];
      };
      console.log(JSON.stringify({ iterator: await iterate(), callback: await call() }));
      await sql.close();
      await monitor.close();
    `;
    const { stdout, exitCode } = await run(script);
    expect({ ...JSON.parse(stdout), exitCode }).toEqual({
      iterator: [true, 2, true],
      callback: [true, 6],
      exitCode: 0,
    });
  });

  test("a script that stops asking for rows is not kept alive", async () => {
    const script = `
      const sql = new Bun.SQL(process.env.CURSOR_URL, { max: 1 });
      const iterator = sql\`select x from generate_series(1, 1000) as x\`.cursor(10)[Symbol.asyncIterator]();
      console.log((await iterator.next()).value.length);
    `;
    expect(await run(script)).toEqual({ stdout: "10\n", exitCode: 0 });
  });
});

// Not concurrent: they wait for the collector.
describeWithContainer("a cursor and the collector", { image: "postgres_plain" }, container => {
  const connect = connectTo(container);
  const turn = () => new Promise<void>(resolve => setImmediate(resolve));

  test("on a pool, a cursor whose iterator is dropped is closed when the iterator is collected", async () => {
    const sql = await connect();
    try {
      await sql`create temporary table dropped (x int)`;
      await (async () => {
        const iterator = sql`insert into dropped select generate_series(1, 9) returning x`.cursor(2);
        expect(xs((await iterator.next()).value)).toEqual([1, 2]);
      })();
      const state = { served: false };
      const query = sql`select count(*)::int as x from dropped`.then(rows => ((state.served = true), rows));
      for (let i = 0; i < 10 && !state.served; i++) {
        Bun.gc(true);
        await turn();
      }
      expect(state.served).toBe(true);
      // Nobody read the cursor to its end: its transaction is rolled back.
      expect(await query).toEqual([{ x: 0 }]);
    } finally {
      await sql.close({ timeout: 0 });
    }
  });

  test("an iterator is not dropped while its next() waits, whoever keeps only the promise", async () => {
    const sql = await connect();
    try {
      await sql`create temporary table awaited (x int)`;
      const holder = await sql.reserve();
      // No reference to the iterator: only to the batch that it was asked for.
      const first = sql`insert into awaited select generate_series(1, 9) returning x`.cursor(2).next();
      for (let i = 0; i < 3; i++) {
        Bun.gc(true);
        await turn();
      }
      holder.release();
      expect(xs((await first).value)).toEqual([1, 2]);
      const state = { served: false };
      const query = sql`select count(*)::int as x from awaited`.then(rows => ((state.served = true), rows));
      for (let i = 0; i < 10 && !state.served; i++) {
        Bun.gc(true);
        await turn();
      }
      // Now it is dropped: the collector ends the cursor, and the pool has its connection again.
      expect(state.served).toBe(true);
      expect(await query).toEqual([{ x: 0 }]);
    } finally {
      await sql.close({ timeout: 0 });
    }
  });

  test.each([true, false])(
    "in a transaction, the end of the transaction ends a dropped cursor and fails (collected first: %p)",
    async collect => {
      await using sql = await connect();
      await sql`create temporary table unread (x int)`;
      const transaction = sql.begin(async tx => {
        await (async () => {
          const iterator = tx`insert into unread select generate_series(1, 9) returning x`.cursor(2);
          expect(xs((await iterator.next()).value)).toEqual([1, 2]);
        })();
        for (let i = 0; collect && i < 5; i++) {
          Bun.gc(true);
          await turn();
        }
      });
      expect(failure(await outcome(transaction))).toEqual(closed("the transaction ended before the cursor did"));
      expect(await sql`select count(*)::int as x from unread`).toEqual([{ x: 0 }]);
    },
  );

  test("the requests of many cursors are collected, whichever way the cursors end", async () => {
    await using sql = await connect();
    const count = isDebug || isASAN ? 18 : 300;
    const requests = () => {
      Bun.gc(true);
      return heapStats().objectTypeCounts.PostgresSQLQuery ?? 0;
    };
    await sql.begin(tx => batches(series(tx, 3).cursor(2)));
    const before = requests();
    let read = 0;
    // A request that waits for the next batch has left the queue of its connection: only its cursor holds it.
    await sql.begin(async tx => {
      for (let i = 0; i < count; i++) {
        const query = series(tx, 5);
        const iterator = query.cursor(2);
        read += (await iterator.next()).value.length;
        if (i % 9 === 0) Bun.gc(true);
        if (i % 3 === 0) for (let next; !(next = await iterator.next()).done;) read += next.value.length;
        else if (i % 3 === 1) await iterator.return();
        else {
          query.cancel();
          await outcome(iterator.next());
        }
      }
      expect(await portals(tx)).toEqual([]);
    });
    // With a request on its way when the cursor is cancelled, each in a transaction of its own.
    for (let i = 0; i < count / 10; i++) {
      const query = series(sql, 5);
      const iterator = query.cursor(2);
      await iterator.next();
      const second = outcome(iterator.next());
      query.cancel();
      await second;
    }
    expect(read).toBe(count * 2 + Math.ceil(count / 3) * 3);
    // Behind the ROLLBACK of the last cursor: every request is answered.
    expect(await inTransaction(sql)).toBe(false);
    let left = Infinity;
    for (let i = 0; i < 10 && left >= 10; i++) {
      await turn();
      left = requests() - before;
    }
    // A leak would be one for each cursor.
    expect(left).toBeLessThan(10);
  });
});

describe("the other adapters", () => {
  test.each<[string, () => SQL]>([
    ["sqlite", () => new SQL(":memory:")],
    ["mysql", () => new SQL("mysql://root@127.0.0.1:1/none", { max: 1 })],
  ])("%s has no cursor(), and says so in the call", async (_, connect) => {
    // Nothing is dialed: a query starts when it is awaited.
    const sql = connect();
    const unsupported = "cursor() is not supported by this adapter (PostgreSQL only)";
    expect(() => sql`select 1`.cursor()).toThrow(unsupported);
    expect(() => sql`select 1`.cursor(2, () => {})).toThrow(unsupported);
    expect(sql.CLOSE).toBe(sql.END);
    await sql.close({ timeout: 0 });
  });
});

describe("on the wire", () => {
  const int4 = (value: number, binary: boolean) => {
    if (!binary) return Buffer.from(String(value));
    const bytes = Buffer.alloc(4);
    bytes.writeInt32BE(value);
    return bytes;
  };
  const columns = pgRowDescription([{ name: "x", typeOid: 23 }]);
  /** One frontend message, as the test states it. */
  type Frame = string;

  /**
   * A server with a result of `total` rows for every statement. It answers BEGIN, COMMIT and ROLLBACK, keeps the
   * position of each portal, and says in ReadyForQuery whether a transaction is open. `frames` gets what it reads.
   * `begin`: it refuses BEGIN, or keeps the ReadyForQuery of BEGIN back until `release()`.
   * `tags`: what the tag of an Execute counts. PostgreSQL 13 and later count the rows of that Execute, earlier ones all rows so far.
   */
  async function portalServer(total: number, begin?: "refused" | "held", tags: "execute" | "portal" = "execute") {
    const frames: Frame[] = [];
    /** Of each statement its text, and of each portal its text and the rows that it has given. */
    const statements = new Map<string, string>();
    const portals = new Map<string, { text: string; position: number; binary: boolean }>();
    let status: "I" | "T" = "I";
    const cstring = (body: Buffer, at = 0) => body.toString("utf8", at, body.indexOf(0, at));
    /** BEGIN, COMMIT and ROLLBACK, by whichever protocol. The portals of a transaction end with it. */
    const transaction = (text: string) => {
      status = /^begin/i.test(text) ? "T" : "I";
      if (status === "I") portals.clear();
      return pgCommandComplete(text.toUpperCase());
    };
    const isTransaction = (text: string) => /^(begin|commit|rollback)/i.test(text);
    const mock = await pgMockServer((type, body) => {
      switch (type) {
        case "Q": {
          const text = cstring(body);
          frames.push(`Query ${text}`);
          if (begin !== undefined && /^begin/i.test(text)) {
            if (begin === "refused") {
              return [pgErrorResponse({ S: "ERROR", C: "53200", M: "out of memory" }), pgReadyForQuery(status)];
            }
            return [transaction(text), pgHold, pgReadyForQuery(status)];
          }
          return [transaction(text), pgReadyForQuery(status)];
        }
        case "P": {
          const name = cstring(body);
          const text = cstring(body, name.length + 1);
          statements.set(name, text);
          frames.push(`Parse ${text}`);
          return pgParseComplete();
        }
        case "D": {
          frames.push("Describe");
          const text = statements.get(cstring(body, 1))!;
          // int4 for each placeholder
          const parameters = (text.match(/\$\d+/g) ?? []).map(() => 23);
          return [pgParameterDescription(parameters), isTransaction(text) ? pgNoData() : columns];
        }
        case "B": {
          const bind = pgDecodeBind(body);
          const text = statements.get(bind.statement)!;
          // The client asks for int4 in binary once it knows the column.
          const binary = bind.resultFormats[0] === 1;
          frames.push(`Bind ${bind.portal} ${binary ? "binary" : "text"} ${text}`);
          portals.set(bind.portal, { text, position: 0, binary });
          return pgBindComplete();
        }
        case "E": {
          const name = cstring(body);
          const limit = body.readInt32BE(name.length + 1);
          frames.push(`Execute ${name} ${limit}`);
          const portal = portals.get(name);
          if (portal === undefined) {
            return pgErrorResponse({ S: "ERROR", C: "34000", M: `portal "${name}" does not exist` });
          }
          if (isTransaction(portal.text)) {
            return transaction(portal.text);
          }
          const from = portal.position;
          const to = limit > 0 ? Math.min(from + limit, total) : total;
          portal.position = to;
          const rows = Array.from({ length: to - from }, (_, i) => pgDataRow([int4(from + i + 1, portal.binary)]));
          // As the server: an Execute that ends at its limit does not know whether a row is left.
          return [
            ...rows,
            limit > 0 && to - from === limit
              ? pgPortalSuspended()
              : pgCommandComplete(`SELECT ${tags === "portal" ? to : to - from}`),
          ];
        }
        case "C": {
          frames.push(`Close ${String.fromCharCode(body[0])} ${cstring(body, 1)}`);
          if (body[0] === 0x50) portals.delete(cstring(body, 1));
          return pgCloseComplete();
        }
        case "S":
          frames.push("Sync");
          return pgReadyForQuery(status);
        case "H":
          frames.push("Flush");
          return;
        default:
          frames.push(type);
      }
    });
    return {
      frames,
      url: `postgres://postgres@127.0.0.1:${mock.port}/postgres`,
      held: mock.held,
      release: mock.release,
      [Symbol.dispose]: () => void mock.server.close(),
    };
  }
  const select = "select x from t";
  /** The statement of a cursor is the unnamed one: it is parsed for every cursor. Its rows are binary once it is described. */
  const describe = (text = select) => [`Parse ${text}`, "Describe", "Sync"];
  const bind = (limit: number, text = select, portal = "C1", format = "binary") => [
    `Bind ${portal} ${format} ${text}`,
    `Execute ${portal} ${limit}`,
    "Sync",
  ];
  const fetch = (limit: number, portal = "C1") => [`Execute ${portal} ${limit}`, "Sync"];
  const close = (portal = "C1") => [`Close P ${portal}`, "Sync"];

  test("on a pool: BEGIN, the statement with a portal and a row limit, an Execute for each batch, COMMIT", async () => {
    using server = await portalServer(7);
    await using sql = new SQL(server.url, { max: 1 });
    const frames = ["Query BEGIN", ...describe(), ...bind(3), ...fetch(3), ...fetch(3), "Query COMMIT"];
    // The second cursor sends what the first one sent: the server keeps no statement for it.
    for (let run = 0; run < 2; run++) {
      server.frames.length = 0;
      expect(await batches(sql`select x from t`.cursor(3))).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
      expect(server.frames).toEqual(frames);
    }

    // The result ends at the row limit, so only one more Execute says that it has ended.
    server.frames.length = 0;
    expect(await batches(sql`select x from t`.cursor(7))).toEqual([[1, 2, 3, 4, 5, 6, 7]]);
    expect(server.frames).toEqual(["Query BEGIN", ...describe(), ...bind(7), ...fetch(7), "Query COMMIT"]);

    // A statement with a parameter is described for its parameter too.
    server.frames.length = 0;
    const filtered = "select x from t where y = $1";
    expect(await batches(sql.unsafe(filtered, [1]).cursor(4))).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7],
    ]);
    expect(server.frames).toEqual([
      "Query BEGIN",
      ...describe(filtered),
      ...bind(4, filtered),
      ...fetch(4),
      "Query COMMIT",
    ]);

    // A break ends the transaction, and the portal with it: no Close.
    server.frames.length = 0;
    for await (const _ of sql`select x from t`.cursor(3)) break;
    expect(server.frames).toEqual(["Query BEGIN", ...describe(), ...bind(3), "Query COMMIT"]);
  });

  test("a query that has the simple protocol without a cursor: one request opens the portal, and its rows are text", async () => {
    using server = await portalServer(3);
    await using sql = new SQL(server.url, { max: 1 });
    for (const query of [() => sql.unsafe(select), () => sql.unsafe(select, []), () => sql`select x from t`.simple()]) {
      server.frames.length = 0;
      expect(await batches(query().cursor(2))).toEqual([[1, 2], [3]]);
      expect(server.frames).toEqual([
        "Query BEGIN",
        `Parse ${select}`,
        "Describe",
        ...bind(2, select, "C1", "text"),
        ...fetch(2),
        "Query COMMIT",
      ]);
    }
  });

  test("in a transaction: nothing is begun, and a Close of the portal ends the cursor", async () => {
    using server = await portalServer(5);
    await using sql = new SQL(server.url, { max: 1 });
    await sql.begin(async tx => {
      expect(await batches(tx`select x from t`.cursor(2))).toEqual([[1, 2], [3, 4], [5]]);
      for await (const _ of tx`select x from t`.cursor(2)) break;
      // Two that are open at once have two names.
      const [one, other] = [tx`select x from t`.cursor(2), tx`select x from t`.cursor(2)];
      await one.next();
      await other.next();
      await one.return();
      await other.return();
    });
    expect(server.frames).toEqual([
      "Query BEGIN",
      ...describe(),
      ...bind(2),
      ...fetch(2),
      ...fetch(2),
      ...close(),
      ...describe(),
      ...bind(2),
      ...close(),
      ...describe(),
      ...bind(2),
      ...describe(),
      ...bind(2, select, "C2"),
      ...close(),
      ...close("C2"),
      "Query COMMIT",
    ]);
  });

  test("prepare: false: the statement is parsed in the request that binds its portal", async () => {
    using server = await portalServer(3);
    await using sql = new SQL(server.url, { max: 1, prepare: false });
    for (let run = 0; run < 2; run++) {
      server.frames.length = 0;
      expect(await batches(sql`select x from t`.cursor(2))).toEqual([[1, 2], [3]]);
      expect(server.frames).toEqual([
        "Query BEGIN",
        `Parse ${select}`,
        "Describe",
        ...bind(2, select, "C1", "text"),
        ...fetch(2),
        "Query COMMIT",
      ]);
    }
  });

  test("a reserved connection: the statement goes out only when the server has said that a transaction is open", async () => {
    using server = await portalServer(3, "held");
    await using sql = new SQL(server.url, { max: 1 });
    using reserved = await sql.reserve();
    expect(failure(await outcome(batches(reserved`select x from t`.cursor(2))))).toEqual(needsTransaction);
    expect(server.frames).toEqual([]);

    // BEGIN has its CommandComplete and not its ReadyForQuery: the statement waits, and then goes out alone.
    const begun = reserved.unsafe("begin").execute();
    const reading = batches(reserved`select x from t`.cursor(2));
    await server.held();
    expect(server.frames).toEqual(["Query begin"]);
    server.release();
    expect(await reading).toEqual([[1, 2], [3]]);
    await begun;
    await reserved.unsafe("commit");
    expect(server.frames).toEqual(["Query begin", ...describe(), ...bind(2), ...fetch(2), ...close(), "Query commit"]);
  });

  test("a BEGIN that the server refuses: the cursor rejects with its error, and its statement is not sent", async () => {
    using server = await portalServer(3, "refused");
    await using sql = new SQL(server.url, { max: 1 });
    for (const read of [
      () => batches(sql`select x from t`.cursor(2)),
      () => sql`select x from t`.cursor(2, () => {}),
    ]) {
      expect(failure(await outcome(read()))).toMatchObject({ errno: "53200", message: "out of memory" });
    }
    expect(server.frames).toEqual(["Query BEGIN", "Query BEGIN"]);
  });

  test("cancel() while the BEGIN of the cursor is on its way: the statement is not sent", async () => {
    for (const form of ["iterator", "callback"] as const) {
      using server = await portalServer(3, "held");
      await using sql = new SQL(server.url, { max: 1 });
      const query = sql`select x from t`;
      let calls = 0;
      await using batches = form === "iterator" ? query.cursor(2) : undefined;
      const reading = batches ? outcome(batches.next()) : outcome(query.cursor(2, () => void calls++));
      await server.held();
      expect(server.frames).toEqual(["Query BEGIN"]);
      query.cancel();
      server.release();
      const err = await reading;
      expect(failure(err)).toEqual(cancelled);
      expect(await outcome(query)).toBe(err);
      expect([form, calls, server.frames]).toEqual([form, 0, ["Query BEGIN", "Query ROLLBACK"]]);
    }
  });

  test("cancel() of a cursor whose statement waits behind a request of the caller: the statement is not sent", async () => {
    using server = await portalServer(3, "held");
    await using sql = new SQL(server.url, { max: 1 });
    using reserved = await sql.reserve();
    const begun = reserved.unsafe("begin").execute();
    const query = reserved`select x from t`;
    const first = outcome(query.cursor(2).next());
    await server.held();
    query.cancel();
    server.release();
    const err = await first;
    expect(failure(err)).toEqual(cancelled);
    expect(await outcome(query)).toBe(err);
    await begun;
    await reserved.unsafe("commit");
    expect(server.frames.filter(frame => /^(Parse|Bind|Execute)/.test(frame))).toEqual([]);
  });

  test.each(["execute", "portal"] as const)(
    "the count of the query is the rows of its batches, whatever the tag of the last %s counts",
    async tags => {
      using server = await portalServer(7, undefined, tags);
      await using sql = new SQL(server.url, { max: 1 });
      for (const [limit, expected] of [
        [3, [[1, 2, 3], [4, 5, 6], [7]]],
        [7, [[1, 2, 3, 4, 5, 6, 7]]],
      ] as const) {
        const all: any[] = [];
        const result = await sql`select x from t`.cursor(limit, rows => void all.push(batch(rows)));
        expect(all.map(rows => rows.x)).toEqual(expected);
        expect(all.map(rows => rows.count)).toEqual(expected.map(rows => rows.length));
        expect(summary(result)).toEqual({ x: [], count: 7, command: "SELECT", affectedRows: 0 });
      }
    },
  );

  test("every request of a cursor ends with its own Sync", async () => {
    using server = await portalServer(4);
    await using sql = new SQL(server.url, { max: 1 });
    await batches(sql`select x from t`.cursor(1));
    await sql.begin(tx => tx`select x from t`.cursor(3, () => tx.CLOSE));
    const { frames } = server;
    expect(frames).not.toContain("Flush");
    // The statement and four more for its rows, then the statement and the Close of its portal.
    const requests = frames.flatMap((frame, i) => (/^(Execute|Close P)/.test(frame) ? [frames[i + 1]] : []));
    expect(requests).toEqual(Array(7).fill("Sync"));
  });
});
