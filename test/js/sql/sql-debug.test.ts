// The `debug` option of Bun.SQL and BUN_CONFIG_VERBOSE_SQL: every query an
// instance runs is reported, with the text and the parameters that go to the
// database, right before it runs.
//
// The option lives in the adapter-independent layer, so most of this file uses
// the SQLite adapter and runs everywhere. What only a connection pool has (the
// connection index, and a query that waits for a connection) runs against the
// docker-compose PostgreSQL and MySQL services.

import { SQL } from "bun";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { bunEnv, bunExe, describeWithContainer, tempDir } from "harness";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";

type Call = [connection: number, query: string, parameters: unknown[]];

function recorder() {
  const calls: Call[] = [];
  return { calls, debug: (...args: Call) => void calls.push(args) };
}

// Where the placeholders and helpers leave their spaces is not what these tests are about.
function squeeze(calls: Call[]) {
  return calls.map(([, query, parameters]) => [query.replace(/\s+/g, " ").trim(), parameters]);
}

describe("debug option", () => {
  test("is called with the text and the parameters of each query", async () => {
    const { calls, debug } = recorder();
    await using sql = new SQL(":memory:", { debug });

    await sql`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)`;
    await sql`INSERT INTO users ${sql([
      { name: "alice", age: 30 },
      { name: "bob", age: 25 },
    ])}`;
    const minAge = 26;
    const rows = await sql`SELECT name FROM users WHERE age > ${minAge} ${sql`AND name <> ${"carol"}`}`;
    await sql.unsafe("SELECT name FROM users WHERE id = ?", [2]);
    await sql.unsafe("SELECT $id AS id", { $id: 7 });

    expect(rows).toEqual([{ name: "alice" }]);
    // the one place where the text is compared as it is: it is the text the database gets
    expect(calls).toEqual([
      [0, "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)", []],
      [0, 'INSERT INTO users ("name", "age") VALUES(?, ?),(?, ?) ', ["alice", 30, "bob", 25]],
      [0, "SELECT name FROM users WHERE age > ?  AND name <> ? ", [26, "carol"]],
      [0, "SELECT name FROM users WHERE id = ?", [2]],
      // named parameters are one object, the way bun:sqlite takes them as one argument
      [0, "SELECT $id AS id", [{ $id: 7 }]],
    ]);
  });

  test("accepts the options object alone", async () => {
    const { calls, debug } = recorder();
    await using sql = new SQL({ adapter: "sqlite", filename: ":memory:", debug });
    await sql`SELECT ${1} AS x`;
    expect(squeeze(calls)).toEqual([["SELECT ? AS x", [1]]]);
  });

  test("is called before the query runs", async () => {
    using dir = tempDir("sql-debug", {});
    const filename = path.join(String(dir), "before.sqlite");
    // a second connection, to look at the database from inside the callback
    let observer: Database | undefined;
    const rowsSeen: [string, number][] = [];
    {
      await using sql = new SQL({
        adapter: "sqlite",
        filename,
        debug(_connection, query) {
          if (observer) rowsSeen.push([query, observer.query("SELECT count(*) AS n FROM t").get()!["n"]]);
        },
      });
      await sql`CREATE TABLE t (x)`;
      observer = new Database(filename, { readonly: true });
      await sql`INSERT INTO t VALUES (1)`;
      await sql`INSERT INTO t VALUES (2)`;
    }
    observer.close();
    expect(rowsSeen).toEqual([
      ["INSERT INTO t VALUES (1)", 0],
      ["INSERT INTO t VALUES (2)", 1],
    ]);
  });

  test("reports the statements of a transaction", async () => {
    const { calls, debug } = recorder();
    await using sql = new SQL(":memory:", { debug });
    await sql`CREATE TABLE t (x)`;
    calls.length = 0;

    await sql.begin(async tx => {
      await tx`INSERT INTO t VALUES (${1})`;
      await tx.savepoint(async sp => {
        await sp`INSERT INTO t VALUES (${2})`;
      });
      await tx
        .savepoint(async sp => {
          await sp`INSERT INTO t VALUES (${3})`;
          throw new Error("undo the savepoint");
        })
        .catch(() => {});
    });
    await sql
      .begin(async tx => {
        await tx`INSERT INTO t VALUES (${4})`;
        throw new Error("undo the transaction");
      })
      .catch(() => {});

    expect(squeeze(calls)).toEqual([
      ["BEGIN", []],
      ["INSERT INTO t VALUES (? )", [1]],
      ["SAVEPOINT s0", []],
      ["INSERT INTO t VALUES (? )", [2]],
      ["RELEASE SAVEPOINT s0", []],
      ["SAVEPOINT s1", []],
      ["INSERT INTO t VALUES (? )", [3]],
      ["ROLLBACK TO SAVEPOINT s1", []],
      ["COMMIT", []],
      ["BEGIN", []],
      ["INSERT INTO t VALUES (? )", [4]],
      ["ROLLBACK", []],
    ]);
    expect(await sql`SELECT x FROM t`.values()).toEqual([[1], [2]]);
  });

  test("does not report a query that never runs", async () => {
    const { calls, debug } = recorder();
    await using sql = new SQL(":memory:", { debug });

    // A query is lazy: this one is built, asked for its result format, and dropped.
    sql`SELECT 'never awaited'`.values();
    // A fragment is part of the query it is interpolated into.
    const fragment = sql`WHERE 1 = ${1}`;
    await sql`SELECT 'ran' AS x ${fragment}`;

    expect(squeeze(calls)).toEqual([["SELECT 'ran' AS x WHERE 1 = ?", [1]]]);
  });

  test("gets an array of parameters of its own", async () => {
    const kept: unknown[][] = [];
    await using sql = new SQL(":memory:", {
      debug(_connection, _query, parameters) {
        kept.push([...parameters]);
        parameters.fill("redacted");
      },
    });
    const values = ["secret"];
    expect(await sql`SELECT ${"secret"} AS x`).toEqual([{ x: "secret" }]);
    expect(await sql.unsafe("SELECT ? AS x", values)).toEqual([{ x: "secret" }]);
    expect({ kept, values }).toEqual({ kept: [["secret"], ["secret"]], values: ["secret"] });
  });

  test("must be a boolean or a function", () => {
    for (const debug of ["yes", 1, {}]) {
      // @ts-expect-error
      expect(() => new SQL(":memory:", { debug })).toThrow(
        expect.objectContaining({
          code: "ERR_INVALID_ARG_TYPE",
          message: expect.stringContaining('The "options.debug" property must be one of type boolean or function'),
        }),
      );
      // the PostgreSQL and MySQL options take another path
      // @ts-expect-error
      expect(() => new SQL("postgres://localhost/db", { debug })).toThrow(
        expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
      );
    }
  });
});

// What goes to stderr, and what becomes an uncaught exception, is only visible from outside.
async function run(script: string, env: Record<string, string | undefined> = {}) {
  await using proc = Bun.spawn({
    cmd: [bunExe(), "-e", script],
    env: { ...bunEnv, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

const queries = (options: string) => /* ts */ `
  import { SQL } from "bun";
  const sql = new SQL(":memory:", ${options});
  await sql\`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, meta TEXT)\`;
  await sql.begin(async tx => {
    await tx\`INSERT INTO users \${tx({ name: "alice", meta: null })}\`;
  });
  const rows = await sql\`
    SELECT name
    FROM users
    WHERE id IN \${sql([1, 2])} AND name = \${"alice"}
  \`;
  await sql.unsafe("SELECT $id AS id", { $id: 7 });
  console.log(JSON.stringify(rows));
`;

const printed = [
  "[sql] CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, meta TEXT)",
  "[sql] BEGIN",
  '[sql] INSERT INTO users ("name", "meta") VALUES(?, ?) [ "alice", null ]',
  "[sql] COMMIT",
  // the text is the one the database gets, without the white space around it
  "[sql] SELECT name",
  "    FROM users",
  '    WHERE id IN (?, ?)  AND name = ? [ 1, 2, "alice" ]',
  "[sql] SELECT $id AS id [ { $id: 7 } ]",
  "",
].join("\n");

describe.concurrent("debug: true", () => {
  test("prints each query and its parameters to stderr", async () => {
    const { stdout, stderr, exitCode } = await run(queries("{ debug: true }"));
    expect(stderr).toBe(printed);
    expect(stdout).toBe('[{"name":"alice"}]\n');
    expect(exitCode).toBe(0);
  });

  test("BUN_CONFIG_VERBOSE_SQL turns it on for an instance without the option", async () => {
    const values = ["1", "true", "0", "false", "", "yes", undefined];
    const results = await Promise.all(values.map(value => run(queries("{}"), { BUN_CONFIG_VERBOSE_SQL: value })));
    expect(results.map(({ stderr }, i) => [values[i], stderr])).toEqual([
      ["1", printed],
      ["true", printed],
      // the values BUN_CONFIG_VERBOSE_FETCH takes, and nothing else
      ["0", ""],
      ["false", ""],
      ["", ""],
      ["yes", ""],
      [undefined, ""],
    ]);
    expect(results.map(({ exitCode }) => exitCode)).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  test("BUN_CONFIG_VERBOSE_SQL reaches the instance behind Bun.sql", async () => {
    const { stdout, stderr, exitCode } = await run(
      /* ts */ `
        import { sql } from "bun";
        console.log(JSON.stringify(await sql\`SELECT \${"default instance"} AS x\`));
      `,
      { BUN_CONFIG_VERBOSE_SQL: "1", DATABASE_URL: "sqlite://:memory:" },
    );
    expect(stderr).toBe('[sql] SELECT ?  AS x [ "default instance" ]\n');
    expect(stdout).toBe('[{"x":"default instance"}]\n');
    expect(exitCode).toBe(0);
  });

  test("BUN_CONFIG_VERBOSE_SQL can come from a .env file", async () => {
    using dir = tempDir("sql-debug-dotenv", {
      ".env": "BUN_CONFIG_VERBOSE_SQL=1\n",
      "index.ts": /* ts */ `
        import { SQL } from "bun";
        const sql = new SQL(":memory:");
        console.log(JSON.stringify(await sql\`SELECT \${"from .env"} AS x\`));
      `,
    });
    await using proc = Bun.spawn({
      cmd: [bunExe(), "index.ts"],
      env: bunEnv,
      cwd: String(dir),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect(stderr).toBe('[sql] SELECT ?  AS x [ "from .env" ]\n');
    expect(stdout).toBe('[{"x":"from .env"}]\n');
    expect(exitCode).toBe(0);
  });

  test("the option wins over BUN_CONFIG_VERBOSE_SQL, unless it is null or undefined", async () => {
    const [off, callback, isNull, isUndefined] = await Promise.all([
      run(queries("{ debug: false }"), { BUN_CONFIG_VERBOSE_SQL: "1" }),
      run(queries("{ debug: (connection, query) => console.error(connection, query.trim().split(' ', 1)[0]) }"), {
        BUN_CONFIG_VERBOSE_SQL: "1",
      }),
      run(queries("{ debug: null }"), { BUN_CONFIG_VERBOSE_SQL: "1" }),
      run(queries("{ debug: undefined }"), { BUN_CONFIG_VERBOSE_SQL: "1" }),
    ]);
    expect(off.stderr).toBe("");
    expect(off.exitCode).toBe(0);
    expect([isNull.stderr, isUndefined.stderr]).toEqual([printed, printed]);
    expect([isNull.exitCode, isUndefined.exitCode]).toEqual([0, 0]);
    expect(callback.stderr).toBe("0 CREATE\n0 BEGIN\n0 INSERT\n0 COMMIT\n0 SELECT\n0 SELECT\n");
    expect(callback.exitCode).toBe(0);
  });

  test("has colors when stderr has them", async () => {
    const [forced, piped] = await Promise.all([
      run(queries("{ debug: true }"), { NO_COLOR: undefined, FORCE_COLOR: "1" }),
      // stderr is a pipe here, so this is what `2> queries.log` gets in a terminal with colors
      run(queries("{ debug: true }"), { NO_COLOR: undefined, FORCE_COLOR: undefined }),
    ]);
    expect(forced.stderr).toStartWith("\x1b[2m[sql]\x1b[0m CREATE TABLE users");
    expect(forced.stderr).toContain("\x1b[2m[sql]\x1b[0m BEGIN\n");
    expect(forced.stderr).toContain('"alice"\x1b[0m');
    expect(Bun.stripANSI(forced.stderr)).toBe(printed);
    expect(piped.stderr).toBe(printed);
    expect([forced.exitCode, piped.exitCode]).toEqual([0, 0]);
  });

  test("a parameter that cannot be printed does not fail the query", async () => {
    const { stdout, stderr, exitCode } = await run(/* ts */ `
        import { SQL } from "bun";
        const sql = new SQL(":memory:", { debug: true });
        const value = Buffer.from("hi");
        value[Symbol.for("nodejs.util.inspect.custom")] = () => {
          throw new Error("do not look at me");
        };
        console.log(JSON.stringify(await sql\`SELECT length(\${value}) AS n, \${1} AS one\`));
      `);
    expect(stderr).toBe("[sql] SELECT length(? ) AS n, ?  AS one [ 2 parameters ]\n");
    expect(stdout).toBe('[{"n":2,"one":1}]\n');
    expect(exitCode).toBe(0);
  });
});

// A callback that throws is reported as an uncaught exception. It cannot keep a statement from
// being sent: a transaction without its COMMIT or ROLLBACK would go back to the pool open.
const throwingCallback = (url: string, createTable: string) => /* ts */ `
  import { SQL } from "bun";
  let uncaught = 0;
  process.on("uncaughtException", err => {
    if (err.message.startsWith("boom from debug: ")) uncaught++;
    else console.log("unexpected:", err);
  });
  const seen = [];
  // one connection: if a statement is lost or a connection is not released, what follows hangs or fails
  const sql = new SQL(${JSON.stringify(url)}, {
    max: 1,
    debug(connection, query) {
      seen.push(query.trim().split(" ", 1)[0]);
      throw new Error("boom from debug: " + query);
    },
  });
  await sql.unsafe(${JSON.stringify(createTable)});
  await sql\`INSERT INTO sql_debug_throw VALUES (\${1})\`;
  await sql.begin(async tx => {
    await tx\`INSERT INTO sql_debug_throw VALUES (\${2})\`;
  });
  await sql
    .begin(async tx => {
      await tx\`INSERT INTO sql_debug_throw VALUES (\${3})\`;
      throw new Error("undo");
    })
    .catch(() => {});
  // a new transaction on the same connection: the last one is over
  const rows = await sql.begin(tx => tx\`SELECT x FROM sql_debug_throw ORDER BY x\`.values());
  await sql.close();
  console.log(JSON.stringify({ rows, seen: seen.length, uncaught }));
`;

test("a callback that throws is reported as uncaught and every statement still runs", async () => {
  const { stdout, exitCode } = await run(throwingCallback(":memory:", "CREATE TABLE sql_debug_throw (x INTEGER)"));
  // CREATE, INSERT, BEGIN INSERT COMMIT, BEGIN INSERT ROLLBACK, BEGIN SELECT COMMIT
  expect(stdout).toBe('{"rows":[[1],[2]],"seen":11,"uncaught":11}\n');
  expect(exitCode).toBe(0);
});

// A pool: `connection` is the slot that runs the query, and a query can wait for one.
for (const [adapter, image, url] of [
  [
    "postgres",
    "postgres_plain",
    (host: string, port: number) => `postgres://bun_sql_test@${host}:${port}/bun_sql_test`,
  ],
  ["mysql", "mysql_plain", (host: string, port: number) => `mysql://root@${host}:${port}/bun_sql_test`],
] as const) {
  describeWithContainer(adapter, { image }, container => {
    test("debug reports the pooled connection of each query", async () => {
      await container.ready;
      const { calls, debug } = recorder();
      await using sql = new SQL(url(container.host, container.port), { max: 2, debug });

      await sql.begin(async tx => {
        await tx`SELECT ${1} AS x`;
        // the pool's other connection
        await sql`SELECT ${2} AS x`;
        await tx`SELECT ${3} AS x`;
      });
      using reserved = await sql.reserve();
      await reserved`SELECT ${4} AS x`;

      const placeholder = adapter === "postgres" ? "$1" : "?";
      const connections = calls.map(([connection]) => connection);
      const [inTransaction, , other] = connections;
      expect([inTransaction, other].sort()).toEqual([0, 1]);
      expect(connections.slice(0, 5)).toEqual([inTransaction, inTransaction, other, inTransaction, inTransaction]);
      expect(connections[5]).toBeOneOf([0, 1]);
      expect(squeeze(calls)).toEqual([
        [adapter === "postgres" ? "BEGIN" : "START TRANSACTION", []],
        [`SELECT ${placeholder} AS x`, [1]],
        [`SELECT ${placeholder} AS x`, [2]],
        [`SELECT ${placeholder} AS x`, [3]],
        ["COMMIT", []],
        [`SELECT ${placeholder} AS x`, [4]],
      ]);
    });

    test("debug runs in the async context of the code that ran the query", async () => {
      await container.ready;
      const requests = new AsyncLocalStorage<number>();
      const seen: [store: number | undefined, parameter: unknown][] = [];
      await using sql = new SQL(url(container.host, container.port), {
        max: 2,
        debug: (_connection, _query, parameters) => void seen.push([requests.getStore(), parameters[0]]),
      });

      // Nothing is connected yet, so every one of these waits for a connection, and gets it
      // from the event that opened one: a socket callback, which has no async context.
      await Promise.all(
        [1, 2, 3, 4, 5].map(id =>
          requests.run(id, async () => {
            await sql`SELECT ${id} AS id`;
          }),
        ),
      );

      expect(seen.sort()).toEqual([
        [1, 1],
        [2, 2],
        [3, 3],
        [4, 4],
        [5, 5],
      ]);
    });

    test("a debug callback that throws leaves the pool and its transactions alone", async () => {
      await container.ready;
      const { stdout, exitCode } = await run(
        throwingCallback(url(container.host, container.port), "CREATE TEMPORARY TABLE sql_debug_throw (x INTEGER)"),
      );
      expect(stdout).toBe('{"rows":[[1],[2]],"seen":11,"uncaught":11}\n');
      expect(exitCode).toBe(0);
    });

    if (adapter !== "postgres") return;

    test("debug reports notify() and not the LISTEN of listen()", async () => {
      await container.ready;
      const { calls, debug } = recorder();
      await using sql = new SQL(url(container.host, container.port), { max: 1, debug });

      const channel = "sql_debug_" + Bun.randomUUIDv7("hex").replaceAll("-", "");
      const { promise: received, resolve } = Promise.withResolvers<string>();
      await using _subscription = await sql.listen(channel, resolve);
      await sql.notify(channel, "hello");

      expect(await received).toBe("hello");
      // listen() has a connection of its own, which is not the pool's
      expect(squeeze(calls)).toEqual([["SELECT pg_notify($1, $2)", [channel, "hello"]]]);
    });
  });
}
