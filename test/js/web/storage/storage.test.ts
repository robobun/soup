// The conformance of the Storage interface itself is test/js/third_party/wpt-webstorage, which
// runs the Web Platform Tests. This file is what they do not cover: what is a global and when,
// the file behind `localStorage`, and everything that is Bun's and not the specification's.
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { bunEnv, bunExe, isPosix, nodeExe, tempDir } from "harness";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";
import { createContext, runInContext } from "node:vm";

async function run(cwd: string, args: string[]) {
  await using proc = Bun.spawn({
    cmd: [bunExe(), ...args],
    env: bunEnv,
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

describe("sessionStorage", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  test("Storage is an interface object that cannot be constructed", () => {
    expect(typeof Storage).toBe("function");
    expect(Storage.name).toBe("Storage");
    expect(Storage.length).toBe(0);
    expect(() => new (Storage as any)()).toThrow(
      expect.objectContaining({ name: "TypeError", message: "Illegal constructor" }),
    );
    expect(() => (Storage as any)()).toThrow(TypeError);
    expect(sessionStorage).toBeInstanceOf(Storage);
    expect(Object.prototype.toString.call(sessionStorage)).toBe("[object Storage]");
    expect(Storage.prototype.constructor).toBe(Storage);

    // An interface object is not enumerable, its attributes and operations are.
    expect(Object.getOwnPropertyDescriptor(globalThis, "Storage")).toEqual({
      value: Storage,
      writable: true,
      enumerable: false,
      configurable: true,
    });
    expect(Object.keys(globalThis)).toContain("sessionStorage");
    expect(Object.keys(Storage.prototype).sort()).toEqual([
      "clear",
      "getItem",
      "key",
      "length",
      "removeItem",
      "setItem",
    ]);
    expect(Object.getOwnPropertyDescriptor(Storage.prototype, "length")).toEqual({
      get: expect.any(Function),
      set: undefined,
      enumerable: true,
      configurable: true,
    });
    expect([Storage.prototype.key.length, Storage.prototype.getItem.length, Storage.prototype.setItem.length]).toEqual([
      1, 1, 2,
    ]);
  });

  test("the methods store strings", () => {
    expect(sessionStorage.length).toBe(0);
    expect(sessionStorage.getItem("a")).toBe(null);
    expect(sessionStorage.key(0)).toBe(null);

    expect(sessionStorage.setItem("a", "1")).toBe(undefined);
    sessionStorage.setItem("b", 2 as any);
    sessionStorage.setItem("c", { toString: () => "three" } as any);
    sessionStorage.setItem(null as any, undefined as any);
    expect<unknown>({ ...sessionStorage }).toEqual({ a: "1", b: "2", c: "three", null: "undefined" });
    expect(sessionStorage.length).toBe(4);

    const keys = [0, 1, 2, 3].map(index => sessionStorage.key(index));
    expect(keys.toSorted()).toEqual(["a", "b", "c", "null"]);
    expect(sessionStorage.key(4)).toBe(null);
    // The index is an `unsigned long`.
    expect(sessionStorage.key(2 ** 32)).toBe(keys[0]);
    expect(sessionStorage.key(-1)).toBe(null);
    expect(sessionStorage.key("1" as any)).toBe(keys[1]);

    sessionStorage.setItem("a", "one");
    expect(sessionStorage.getItem("a")).toBe("one");
    expect(sessionStorage.length).toBe(4);
    // The order of the keys stays as long as the set of keys does.
    expect([0, 1, 2, 3].map(index => sessionStorage.key(index))).toEqual(keys);

    expect(sessionStorage.removeItem("a")).toBe(undefined);
    sessionStorage.removeItem("not there");
    expect(sessionStorage.getItem("a")).toBe(null);
    expect(sessionStorage.length).toBe(3);

    expect(sessionStorage.clear()).toBe(undefined);
    expect(sessionStorage.length).toBe(0);
    expect<unknown>({ ...sessionStorage }).toEqual({});
  });

  test("an item is a property", () => {
    sessionStorage.theme = "dark";
    sessionStorage[42] = 43;
    expect(sessionStorage.getItem("theme")).toBe("dark");
    expect(sessionStorage.getItem("42")).toBe("43");
    expect(sessionStorage.theme).toBe("dark");
    expect(sessionStorage[42]).toBe("43");
    expect(sessionStorage.nothing).toBe(undefined);

    expect("theme" in sessionStorage).toBe(true);
    expect(42 in sessionStorage).toBe(true);
    expect("nothing" in sessionStorage).toBe(false);
    expect(Object.hasOwn(sessionStorage, "theme")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(sessionStorage, "theme")).toEqual({
      value: "dark",
      writable: true,
      enumerable: true,
      configurable: true,
    });

    expect(Object.keys(sessionStorage).sort()).toEqual(["42", "theme"]);
    expect(Object.getOwnPropertyNames(sessionStorage).sort()).toEqual(["42", "theme"]);
    expect(Object.entries(sessionStorage).sort()).toEqual([
      ["42", "43"],
      ["theme", "dark"],
    ]);
    expect(JSON.parse(JSON.stringify(sessionStorage))).toEqual({ "42": "43", theme: "dark" });
    const seen: string[] = [];
    for (const key in sessionStorage) if (Object.hasOwn(sessionStorage, key)) seen.push(key);
    expect(seen.sort()).toEqual(["42", "theme"]);

    expect(delete sessionStorage.theme).toBe(true);
    expect(delete sessionStorage[42]).toBe(true);
    expect(delete sessionStorage.nothing).toBe(true);
    expect(sessionStorage.length).toBe(0);

    expect(Object.defineProperty(sessionStorage, "defined", { value: 1 })).toBe(sessionStorage);
    expect(Reflect.defineProperty(sessionStorage, "bare", {})).toBe(false);
    expect(() => Object.defineProperty(sessionStorage, "getter", { get: () => 1 })).toThrow(TypeError);
    expect<unknown>({ ...sessionStorage }).toEqual({ defined: "1" });
  });

  test("an item does not hide what the prototype chain has", () => {
    for (const name of ["getItem", "setItem", "length", "toString", "constructor"]) sessionStorage[name] = "stored";
    expect(sessionStorage.getItem).toBe(Storage.prototype.getItem);
    expect(sessionStorage.toString).toBe(Object.prototype.toString);
    expect(sessionStorage.constructor).toBe(Storage);
    expect(sessionStorage.length).toBe(5);
    expect(sessionStorage.getItem("getItem")).toBe("stored");
    expect(sessionStorage.getItem("length")).toBe("stored");

    // Such an item is not a property: it is not listed, and `delete` leaves it.
    expect(Object.keys(sessionStorage)).toEqual([]);
    expect(Object.getOwnPropertyNames(sessionStorage)).toEqual([]);
    expect(Object.getOwnPropertyDescriptor(sessionStorage, "getItem")).toBe(undefined);
    expect(delete (sessionStorage as any).getItem).toBe(true);
    expect(sessionStorage.getItem("getItem")).toBe("stored");
    sessionStorage.removeItem("getItem");
    expect(sessionStorage.getItem("getItem")).toBe(null);

    // The other way around: a property that the prototype gets later hides the item.
    sessionStorage.late = "item";
    try {
      (Storage.prototype as any).late = "prototype";
      expect(sessionStorage.late).toBe("prototype");
      expect(sessionStorage.getItem("late")).toBe("item");
      expect(Object.keys(sessionStorage)).toEqual([]);
    } finally {
      delete (Storage.prototype as any).late;
    }
    expect(sessionStorage.late).toBe("item");
    expect(Object.keys(sessionStorage)).toEqual(["late"]);
  });

  test("keys and values are kept code unit for code unit", () => {
    const strings = [
      "",
      " ",
      "\0",
      "a\0b",
      "é",
      "\u00ff",
      "日本語",
      "👍",
      "\ud83d",
      "\udc4d",
      "\udc4d\ud83d",
      "a".padEnd(300, "é"),
      Buffer.alloc(100_000, "x").toString(),
    ];
    for (const string of strings) sessionStorage.setItem(string, string);
    expect(sessionStorage.length).toBe(strings.length);
    for (const string of strings) {
      expect(sessionStorage.getItem(string)).toBe(string);
      expect(sessionStorage[string]).toBe(string);
    }
    expect(Object.keys(sessionStorage).sort()).toEqual(strings.toSorted());
    // "é" and its decomposed form are two keys.
    sessionStorage.setItem("e\u0301", "decomposed");
    expect(sessionStorage.getItem("é")).toBe("é");
  });

  test("a symbol is an ordinary property", () => {
    const symbol = Symbol("symbol");
    try {
      (sessionStorage as any)[symbol] = { an: "object" };
      expect((sessionStorage as any)[symbol]).toEqual({ an: "object" });
      expect(sessionStorage.length).toBe(0);
      expect(Object.getOwnPropertySymbols(sessionStorage)).toEqual([symbol]);
      sessionStorage.clear();
      expect(symbol in sessionStorage).toBe(true);
    } finally {
      delete (sessionStorage as any)[symbol];
    }
    expect(symbol in sessionStorage).toBe(false);
  });

  test("the methods check their receiver and their arguments", () => {
    const calls: (() => unknown)[] = [
      () => Storage.prototype.length,
      () => Object.getOwnPropertyDescriptor(Storage.prototype, "length")!.get!.call({}),
      () => Storage.prototype.key.call({}, 0),
      () => Storage.prototype.getItem.call(Object.create(sessionStorage), "a"),
      () => Storage.prototype.setItem.call(null, "a", "b"),
      () => Storage.prototype.removeItem.call(new Map(), "a"),
      () => Storage.prototype.clear.call(undefined),
      () => (sessionStorage as any).key(),
      () => (sessionStorage as any).getItem(),
      () => (sessionStorage as any).setItem(),
      () => (sessionStorage as any).setItem("a"),
      () => (sessionStorage as any).removeItem(),
    ];
    for (const call of calls) expect(call).toThrow(TypeError);
    expect(() => sessionStorage.setItem(Symbol() as any, "a")).toThrow(TypeError);
    expect(() => sessionStorage.setItem("a", Symbol() as any)).toThrow(TypeError);
    expect(() => {
      sessionStorage.a = Symbol();
    }).toThrow(TypeError);
    expect(() =>
      sessionStorage.setItem("a", {
        toString() {
          throw new RangeError("from toString");
        },
      } as any),
    ).toThrow(RangeError);
    expect(sessionStorage.length).toBe(0);
  });

  test("the quota is ten megabytes of keys and values", () => {
    // Two bytes a code unit: this key alone is the quota.
    const key = Buffer.alloc((10 * 1024 * 1024) / 2, "k").toString();
    sessionStorage.setItem(key, "");

    const quotaExceeded = expect.objectContaining({ name: "QuotaExceededError", code: 22 });
    expect(() => sessionStorage.setItem("a", "")).toThrow(quotaExceeded);
    expect(() => {
      sessionStorage.a = "";
    }).toThrow(quotaExceeded);
    expect(() => sessionStorage.setItem(key, "v")).toThrow(quotaExceeded);
    let thrown: unknown;
    try {
      Object.defineProperty(sessionStorage, "a", { value: "" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DOMException);
    // What failed changed nothing.
    expect(sessionStorage.length).toBe(1);
    expect(sessionStorage.getItem(key)).toBe("");

    sessionStorage.removeItem(key);
    sessionStorage.setItem("a", "fits again");
    expect(sessionStorage.getItem("a")).toBe("fits again");
  });

  test("a lookup is never answered from a cache", () => {
    function read(storage: Storage) {
      return storage.cached;
    }
    function has(storage: Storage) {
      return "cached" in storage;
    }
    // Enough calls for the optimizing tiers, which cache what a property lookup found.
    for (let i = 0; i < 3_000; i++) {
      if (read(sessionStorage) !== undefined || has(sessionStorage)) throw new Error("found before it was set");
    }
    sessionStorage.setItem("cached", "first");
    for (let i = 0; i < 3_000; i++) {
      if (read(sessionStorage) !== "first" || !has(sessionStorage)) throw new Error("not found after it was set");
    }
    sessionStorage.setItem("cached", "second");
    expect(read(sessionStorage)).toBe("second");
    sessionStorage.removeItem("cached");
    expect(read(sessionStorage)).toBe(undefined);
    expect(has(sessionStorage)).toBe(false);
  });

  test("is printed with its items and cannot be cloned", () => {
    sessionStorage.setItem("a", "1");
    sessionStorage.setItem("length", "hidden");
    expect(inspect(sessionStorage)).toBe("Storage { a: '1' }");
    expect(Bun.inspect(sessionStorage)).toStartWith('Storage {\n  a: "1",\n  length: 2,');
    expect(() => structuredClone(sessionStorage)).toThrow(expect.objectContaining({ name: "DataCloneError" }));
  });

  test("cannot be frozen, sealed or made non-extensible", () => {
    sessionStorage.setItem("token", "secret");
    for (const lock of [Object.freeze, Object.seal, Object.preventExtensions]) {
      expect(() => lock(sessionStorage)).toThrow(TypeError);
    }
    expect(Reflect.preventExtensions(sessionStorage)).toBe(false);
    expect(Object.isExtensible(sessionStorage)).toBe(true);

    // A descriptor without a value has nothing to say about an item, which has no attributes.
    expect(Object.defineProperty(sessionStorage, "token", { writable: false })).toBe(sessionStorage);
    Object.defineProperty(sessionStorage, "absent", { writable: false, enumerable: false });
    expect<unknown>({ ...sessionStorage }).toEqual({ token: "secret" });

    Object.defineProperty(sessionStorage, "token", { value: "changed", writable: false, configurable: false });
    expect(Object.getOwnPropertyDescriptor(sessionStorage, "token")).toEqual({
      value: "changed",
      writable: true,
      enumerable: true,
      configurable: true,
    });
  });

  test("whatever the prototype chain does to answer is allowed to happen", () => {
    sessionStorage.setItem("sql", "item");
    sessionStorage.setItem("other", "item");
    try {
      // `Bun.sql` is made by JavaScript the first time something asks for it.
      Object.setPrototypeOf(sessionStorage, Bun);
      expect(sessionStorage.sql).toBe(Bun.sql);
      expect("sql" in sessionStorage).toBe(true);
      expect(Object.keys(sessionStorage)).toEqual(["other"]);
      expect(delete sessionStorage.sql).toBe(true);

      const asked: PropertyKey[] = [];
      Object.setPrototypeOf(
        sessionStorage,
        new Proxy(Storage.prototype, {
          has(target, key) {
            asked.push(key);
            return Reflect.has(target, key);
          },
        }),
      );
      expect(sessionStorage.other).toBe("item");
      expect(asked).toContain("other");
    } finally {
      Object.setPrototypeOf(sessionStorage, Storage.prototype);
    }
    expect(sessionStorage.getItem("sql")).toBe("item");
    expect(sessionStorage.sql).toBe("item");
  });

  test("an array that inherits from a storage reads its holes from it", () => {
    sessionStorage.setItem("1", "from the storage");
    const array = [0, , 2];
    Object.setPrototypeOf(array, sessionStorage);
    expect<unknown>(array[1]).toBe("from the storage");
    expect(Array.prototype.join.call(array)).toBe("0,from the storage,2");
    expect(Array.prototype.slice.call(array)).toEqual([0, "from the storage", 2]);
  });

  test("a script of a node:vm context gets the errors of a storage", () => {
    // Three million code units are six of the ten megabytes: the second item does not fit.
    const big = Buffer.alloc(3_000_000, "x").toString();
    let thrown: any;
    try {
      runInContext("storage.a = big; storage.b = big;", createContext({ storage: sessionStorage, big }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DOMException);
    expect(thrown.name).toBe("QuotaExceededError");
    expect(sessionStorage.length).toBe(1);
  });

  test("localStorage is not defined without --localstorage-file", () => {
    expect(typeof localStorage).toBe("undefined");
    expect("localStorage" in globalThis).toBe(false);
  });
});

describe.concurrent("localStorage", () => {
  test("is stored in the file that --localstorage-file names", async () => {
    using dir = tempDir("localstorage-file", {});
    const script = `
      const runs = Number(localStorage.getItem("runs") ?? 0) + 1;
      localStorage.setItem("runs", runs);
      localStorage["run " + runs] = process.pid === Number(localStorage.pid) ? "same process" : "new process";
      localStorage.pid = process.pid;
      sessionStorage.setItem("runs", runs);
      console.log(JSON.stringify([localStorage.runs, localStorage.length, sessionStorage.runs, localStorage instanceof Storage]));
    `;
    for (const [flag, expected] of [
      [["--localstorage-file", "storage.db"], '["1",3,"1",true]\n'],
      [["--localstorage-file=storage.db"], '["2",4,"2",true]\n'],
      [["--localstorage-file=" + join(String(dir), "storage.db")], '["3",5,"3",true]\n'],
    ] as const) {
      expect(await run(String(dir), [...flag, "-e", script])).toEqual({ stdout: expected, stderr: "", exitCode: 0 });
    }
    // The process that exits leaves one file, with nothing beside it.
    expect(readdirSync(String(dir))).toEqual(["storage.db"]);
  });

  test("the file is made when localStorage is used, where the process started", async () => {
    using dir = tempDir("localstorage-lazy", { "elsewhere": {} });
    expect(
      await run(String(dir), [
        "--localstorage-file=unused.db",
        "-e",
        `console.log(typeof localStorage, localStorage === globalThis.localStorage, Object.keys(globalThis).includes("localStorage"))`,
      ]),
    ).toEqual({ stdout: "object true true\n", stderr: "", exitCode: 0 });
    expect(readdirSync(String(dir))).toEqual(["elsewhere"]);

    expect(
      await run(String(dir), [
        "--localstorage-file=used.db",
        "-e",
        `process.chdir("elsewhere"); localStorage.setItem("a", "1"); console.log(localStorage.length)`,
      ]),
    ).toEqual({ stdout: "1\n", stderr: "", exitCode: 0 });
    expect(readdirSync(String(dir)).sort()).toEqual(["elsewhere", "used.db"]);
    expect(readdirSync(join(String(dir), "elsewhere"))).toEqual([]);
  });

  test("--localstorage-file=:memory: keeps it in memory", async () => {
    using dir = tempDir("localstorage-memory", {});
    const script = `localStorage.setItem("a", "1"); console.log(localStorage.getItem("a"), localStorage.length)`;
    for (let i = 0; i < 2; i++) {
      expect(await run(String(dir), ["--localstorage-file=:memory:", "-e", script])).toEqual({
        stdout: "1 1\n",
        stderr: "",
        exitCode: 0,
      });
    }
    expect(readdirSync(String(dir))).toEqual([]);
  });

  test("--localstorage-file= without a file is an error", async () => {
    using dir = tempDir("localstorage-empty", {});
    const { stdout, stderr, exitCode } = await run(String(dir), [
      "--localstorage-file=",
      "-e",
      "console.log(typeof localStorage)",
    ]);
    expect(stderr).toContain("--localstorage-file= requires an argument");
    expect({ stdout, exitCode }).toEqual({ stdout: "", exitCode: 9 });
  });

  test("the file has the schema of Node.js", async () => {
    using dir = tempDir("localstorage-schema", {});
    const file = join(String(dir), "storage.db");
    expect(
      await run(String(dir), [
        "--localstorage-file=storage.db",
        "-e",
        `localStorage.setItem("name", "value"); localStorage.setItem("é", "👍"); localStorage.setItem("", ""); localStorage.setItem("gone", "x"); localStorage.removeItem("gone");`,
      ]),
    ).toEqual({ stdout: "", stderr: "", exitCode: 0 });

    {
      using db = new Database(file);
      expect(
        db
          .query("SELECT type, name FROM sqlite_master WHERE name LIKE 'nodejs_%' ORDER BY name")
          .all()
          .map((row: any) => `${row.type} ${row.name}`),
      ).toEqual([
        "trigger nodejs_quota_delete",
        "trigger nodejs_quota_insert",
        "trigger nodejs_quota_update",
        "table nodejs_webstorage",
        "table nodejs_webstorage_state",
      ]);
      // Keys and values are blobs of UTF-16 code units, and total_size is their size in bytes.
      const utf16 = (string: string) => Buffer.from(string, "utf16le");
      expect(db.query("SELECT key, value FROM nodejs_webstorage ORDER BY key").values()).toEqual([
        [new Uint8Array(0), new Uint8Array(0)],
        [new Uint8Array(utf16("name")), new Uint8Array(utf16("value"))],
        [new Uint8Array(utf16("é")), new Uint8Array(utf16("👍"))],
      ]);
      expect(db.query("SELECT * FROM nodejs_webstorage_state").all()).toEqual([
        {
          max_size: 10 * 1024 * 1024,
          total_size: 2 * ("name".length + "value".length + "é".length + "👍".length),
          schema_version: 1,
          single_row_: 1,
        },
      ]);
      expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });

      // What another program puts into the table is an item. A smaller max_size is a smaller quota.
      db.run("INSERT INTO nodejs_webstorage (key, value) VALUES (?, ?)", [utf16("from sqlite"), utf16("\ud800 alone")]);
      db.run("UPDATE nodejs_webstorage_state SET max_size = total_size + 7");
    }

    expect(
      await run(String(dir), [
        "--localstorage-file=storage.db",
        "-e",
        `
          console.log(JSON.stringify(Object.entries(localStorage).sort()));
          console.log(localStorage.getItem("from sqlite") === "\\ud800 alone");
          localStorage.setItem("abc", "");
          try { localStorage.setItem("d", ""); } catch (error) { console.log(error.name); }
          console.log(localStorage.length);
        `,
      ]),
    ).toEqual({
      stdout: '[["",""],["from sqlite","\\ud800 alone"],["name","value"],["é","👍"]]\ntrue\nQuotaExceededError\n5\n',
      stderr: "",
      exitCode: 0,
    });
  });

  test("two processes that have the file open see what the other writes", async () => {
    using dir = tempDir("localstorage-shared", {});
    await using first = Bun.spawn({
      cmd: [
        bunExe(),
        "--localstorage-file=storage.db",
        "-e",
        `
          localStorage.setItem("first", "was here");
          console.log("ready");
          for await (const line of console) {
            console.log(JSON.stringify(Object.entries(localStorage).sort()));
            break;
          }
        `,
      ],
      env: bunEnv,
      cwd: String(dir),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = first.stdout.getReader();
    const decoder = new TextDecoder();
    let stdout = "";
    while (!stdout.includes("ready\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      stdout += decoder.decode(value, { stream: true });
    }
    expect(stdout).toBe("ready\n");

    expect(
      await run(String(dir), [
        "--localstorage-file=storage.db",
        "-e",
        `console.log(localStorage.first); localStorage.second = "was here too"; delete localStorage.first;`,
      ]),
    ).toEqual({ stdout: "was here\n", stderr: "", exitCode: 0 });

    first.stdin.write("go\n");
    await first.stdin.end();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      stdout += decoder.decode(value, { stream: true });
    }
    expect(await first.stderr.text()).toBe("");
    expect(stdout).toBe('ready\n[["second","was here too"]]\n');
    expect(await first.exited).toBe(0);
  });

  test("processes that use a new file at the same moment all get to", async () => {
    using dir = tempDir("localstorage-first-use", {});
    const script = `localStorage.setItem(process.argv.at(-1), "was here"); console.log(localStorage.getItem(process.argv.at(-1)));`;
    const names = ["a", "b", "c", "d", "e", "f"];
    const outcomes = await Promise.all(
      names.map(name => run(String(dir), ["--localstorage-file=storage.db", "-e", script, name])),
    );
    expect(outcomes).toEqual(names.map(() => ({ stdout: "was here\n", stderr: "", exitCode: 0 })));
    expect(
      await run(String(dir), [
        "--localstorage-file=storage.db",
        "-e",
        "console.log(Object.keys(localStorage).sort().join(''))",
      ]),
    ).toEqual({ stdout: "abcdef\n", stderr: "", exitCode: 0 });
  });

  test("a Worker has the same localStorage and a sessionStorage of its own", async () => {
    using dir = tempDir("localstorage-worker", {
      "main.js": `
        sessionStorage.setItem("where", "main");
        localStorage.setItem("where", "main");
        const worker = new Worker(new URL("./worker.js", import.meta.url).href);
        worker.onmessage = ({ data }) => {
          console.log(JSON.stringify(data));
          console.log(localStorage.getItem("worker"), sessionStorage.getItem("worker"));
          worker.terminate();
        };
      `,
      "worker.js": `
        localStorage.setItem("worker", "was here");
        sessionStorage.setItem("worker", "was here");
        postMessage({
          local: localStorage.getItem("where"),
          session: sessionStorage.getItem("where"),
          storage: localStorage instanceof Storage,
        });
      `,
    });
    expect(await run(String(dir), ["--localstorage-file=storage.db", "main.js"])).toEqual({
      stdout: '{"local":"main","session":null,"storage":true}\nwas here null\n',
      stderr: "",
      exitCode: 0,
    });
  });

  test("the globals can be replaced", async () => {
    using dir = tempDir("localstorage-replace", {});
    expect(
      await run(String(dir), [
        "--localstorage-file=:memory:",
        "-e",
        `
          "use strict";
          const real = sessionStorage;
          globalThis.sessionStorage = { mock: "session" };
          globalThis.localStorage = { mock: "local" };
          console.log(sessionStorage.mock, localStorage.mock, real instanceof Storage);
          Object.defineProperty(globalThis, "localStorage", { value: 1, configurable: true });
          console.log(localStorage, delete globalThis.sessionStorage, typeof sessionStorage);
        `,
      ]),
    ).toEqual({ stdout: "session local true\n1 true undefined\n", stderr: "", exitCode: 0 });
  });

  test.each([[[]], [["--parallel=2", "--parallel-delay=0"]]])("bun test %j takes the flag", async flags => {
    const file = `
      import { expect, test } from "bun:test";
      test("localStorage", () => {
        localStorage.setItem("a", "1");
        expect({ ...localStorage }).toEqual({ a: "1" });
      });
    `;
    using dir = tempDir("localstorage-bun-test", { "a.test.ts": file, "b.test.ts": file });
    const { stderr, exitCode } = await run(String(dir), [
      "test",
      ...flags,
      "--localstorage-file=:memory:",
      "./a.test.ts",
      "./b.test.ts",
    ]);
    expect(stderr).toContain(" 2 pass");
    expect(stderr).toContain(" 0 fail");
    expect(exitCode).toBe(0);
  });

  test("ten megabytes is the quota of the file too", async () => {
    using dir = tempDir("localstorage-quota", {});
    expect(
      await run(String(dir), [
        "--localstorage-file=storage.db",
        "-e",
        `
          localStorage[Buffer.alloc(${10 * 1024 * 1024} / 2, "a").toString()] = "";
          try {
            localStorage.anything = "should fail";
          } catch (error) {
            console.log(error.name, error.code, error instanceof DOMException, error.message);
          }
          console.log(localStorage.length);
        `,
      ]),
    ).toEqual({
      stdout: "QuotaExceededError 22 true Setting the value exceeded the quota\n1\n",
      stderr: "",
      exitCode: 0,
    });
  });

  test("a file that cannot be opened is an error of the operation, every time", async () => {
    using dir = tempDir("localstorage-unopenable", {});
    expect(
      await run(String(dir), [
        "--localstorage-file=" + join(String(dir), "no such directory", "storage.db"),
        "-e",
        `
          const attempts = [
            () => localStorage.length,
            () => localStorage.getItem("a"),
            () => localStorage.a,
            () => "a" in localStorage,
            () => { localStorage.a = "1"; },
            () => delete localStorage.a,
            () => Object.keys(localStorage),
            () => localStorage.clear(),
          ];
          for (const attempt of attempts) {
            try {
              attempt();
              console.log("no error");
            } catch (error) {
              console.log(error.name, error.code, error.message);
            }
          }
          sessionStorage.a = "still works";
          console.log(sessionStorage.a);
        `,
      ]),
    ).toEqual({
      stdout: "Error ERR_INVALID_STATE unable to open database file\n".repeat(8) + "still works\n",
      stderr: "",
      exitCode: 0,
    });
  });

  describe("a file with something else in the tables is an error and not a crash", () => {
    // The tables are STRICT when Bun or Node.js makes them, and are made with IF NOT EXISTS, so
    // a file that already has tables of these names is taken as it is. Without STRICT a BLOB
    // column keeps a text as a text.
    function malformed(
      dir: string,
      fill: (tools: { insert(key: unknown, value: unknown): void; setSchemaVersion(version: unknown): void }) => void,
    ) {
      using db = new Database(join(dir, "malformed.db"));
      db.run(`
        CREATE TABLE nodejs_webstorage(
          key BLOB NOT NULL, value BLOB NOT NULL, PRIMARY KEY(key)
        );
        CREATE TABLE nodejs_webstorage_state(
          max_size INTEGER NOT NULL DEFAULT 10485760,
          total_size INTEGER NOT NULL,
          schema_version INTEGER NOT NULL DEFAULT 1,
          single_row_ INTEGER NOT NULL DEFAULT 1 CHECK(single_row_ = 1),
          PRIMARY KEY(single_row_)
        );
      `);
      fill({
        insert: (key, value) =>
          void db.run("INSERT INTO nodejs_webstorage (key, value) VALUES (?, ?)", [key as any, value as any]),
        setSchemaVersion: version =>
          void db.run("INSERT INTO nodejs_webstorage_state (total_size, schema_version) VALUES (0, ?)", [
            version as any,
          ]),
      });
    }
    const utf16 = (string: string) => Buffer.from(string, "utf16le");

    test.each([
      [
        "a text schema_version",
        "localStorage.length",
        "expected schema_version to be an integer",
        tools => tools.setSchemaVersion("one"),
      ],
      [
        "a text key read by key()",
        "localStorage.key(0)",
        "expected key to be a blob",
        tools => (tools.insert("greeting", utf16("hello")), tools.setSchemaVersion(1)),
      ],
      [
        "a text key read by enumeration",
        "Object.keys(localStorage)",
        "expected key to be a blob",
        tools => (tools.insert("greeting", utf16("hello")), tools.setSchemaVersion(1)),
      ],
      [
        "a text value",
        "localStorage.getItem('greeting')",
        "expected value to be a blob",
        tools => (tools.insert(utf16("greeting"), "hello"), tools.setSchemaVersion(1)),
      ],
      [
        "a text value read as a property",
        "localStorage.greeting",
        "expected value to be a blob",
        tools => (tools.insert(utf16("greeting"), "hello"), tools.setSchemaVersion(1)),
      ],
    ] as [string, string, string, Parameters<typeof malformed>[1]][])(
      "%s, via %s",
      async (_, expression, detail, fill) => {
        using dir = tempDir("localstorage-malformed", {});
        malformed(String(dir), fill);
        const { stdout, stderr, exitCode } = await run(String(dir), [
          "--localstorage-file=malformed.db",
          "-e",
          expression,
        ]);
        expect(stderr).toContain(`localStorage database is malformed: ${detail}`);
        expect(stderr).toContain(`code: "ERR_INVALID_STATE"`);
        expect({ stdout, exitCode }).toEqual({ stdout: "", exitCode: 1 });
      },
    );

    test("a newer schema_version", async () => {
      using dir = tempDir("localstorage-newer", {});
      malformed(String(dir), tools => tools.setSchemaVersion(2));
      expect(
        await run(String(dir), [
          "--localstorage-file=malformed.db",
          "-e",
          `try { localStorage.length } catch (error) { console.log(error.code, error.message) }`,
        ]),
      ).toEqual({
        stdout:
          "ERR_INVALID_STATE localStorage was created with a newer version of the schema than this version of Bun reads\n",
        stderr: "",
        exitCode: 0,
      });
    });

    // A failed open has a connection to close, and with it two file descriptors.
    test.skipIf(!isPosix)("does not leak the connection of an open that failed", async () => {
      using dir = tempDir("localstorage-leak", {});
      malformed(String(dir), tools => tools.setSchemaVersion("one"));
      expect(
        await run(String(dir), [
          "--localstorage-file=malformed.db",
          "-e",
          `
            const { readdirSync } = require("fs");
            const descriptors = () => readdirSync(process.platform === "linux" ? "/proc/self/fd" : "/dev/fd").length;
            const attempt = () => {
              try {
                localStorage.length;
              } catch (error) {
                if (!/expected schema_version to be an integer/.test(error.message)) throw error;
                return;
              }
              throw new Error("did not throw");
            };
            attempt();
            const before = descriptors();
            for (let i = 0; i < 200; i++) attempt();
            console.log(descriptors() - before < 20 ? "no leak" : "leaked " + (descriptors() - before));
          `,
        ]),
      ).toEqual({ stdout: "no leak\n", stderr: "", exitCode: 0 });
    });
  });

  // Node.js 25 and later have localStorage without a flag.
  const node = nodeExe();
  const nodeHasWebStorage =
    node !== null &&
    Number(Bun.spawnSync({ cmd: [node, "-p", "process.versions.node.split('.')[0]"] }).stdout.toString()) >= 25;
  test.skipIf(!nodeHasWebStorage)("Node.js and Bun read and write the same file", async () => {
    using dir = tempDir("localstorage-node", {});
    const runNode = async (script: string) => {
      await using proc = Bun.spawn({
        cmd: [node!, "--no-warnings", "--localstorage-file=storage.db", "-e", script],
        env: bunEnv,
        cwd: String(dir),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      return { stdout, stderr, exitCode };
    };
    const dump = `console.log(JSON.stringify(Object.entries(localStorage).sort()), localStorage.length);`;

    expect(
      await run(String(dir), [
        "--localstorage-file=storage.db",
        "-e",
        `localStorage.setItem("from bun", "👍 \\ud800"); localStorage.setItem("", ""); localStorage.shared = "bun";`,
      ]),
    ).toEqual({ stdout: "", stderr: "", exitCode: 0 });
    expect(
      await runNode(
        `${dump} localStorage.setItem("from node", "héllo"); localStorage.shared = "node"; delete localStorage[""];`,
      ),
    ).toEqual({ stdout: '[["",""],["from bun","👍 \\ud800"],["shared","bun"]] 3\n', stderr: "", exitCode: 0 });
    expect(await run(String(dir), ["--localstorage-file=storage.db", "-e", dump])).toEqual({
      stdout: '[["from bun","👍 \\ud800"],["from node","héllo"],["shared","node"]] 3\n',
      stderr: "",
      exitCode: 0,
    });
    expect(existsSync(join(String(dir), "storage.db"))).toBe(true);
  });
});
