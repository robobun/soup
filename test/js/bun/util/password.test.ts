import { password } from "bun";
import { describe, expect, test } from "bun:test";
import { bunEnv, bunExe, isASAN, isDebug, isLinux } from "harness";
import { argon2Sync } from "node:crypto";

const placeholder = "hey";

const notBytes = [
  null,
  5,
  true,
  1n,
  Symbol(),
  {},
  [],
  () => {},
  new Blob(["abc"]),
  { toString: () => "abc" },
  {
    toString() {
      throw new Error("toString() failed");
    },
  },
];
const mustBeBytes = (name: string) =>
  expect.objectContaining({
    name: "TypeError",
    code: "ERR_INVALID_ARG_TYPE",
    message: `${name} must be a string, ArrayBuffer or ArrayBufferView`,
  });

// argon2id iterates so slowly under debug/ASAN that the 60 000 warm-up
// iterations blow past the 90 s test timeout before the leak check even
// starts. The leak numbers are only meaningful on release anyway — skip
// the whole suite on debug so the rest of the file can run.
describe.skipIf(isDebug)("does not leak", () => {
  async function run(code: string) {
    await using proc = Bun.spawn({
      cmd: [bunExe(), "--smol", "-e", code],
      env: bunEnv,
      stdout: "inherit",
      stderr: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([proc.stderr.text(), proc.exited]);
    // Only fail on a non-zero exit. ASAN builds may emit startup warnings on
    // stderr that are not errors, so don't require stderr to be empty.
    if (exitCode !== 0) throw new Error(stderr || `exited with code ${exitCode}`);
  }

  test("hashSync", async () => {
    await run(/* js */ `
        const rss = process.memoryUsage.rss;
        const opts = { algorithm: "argon2id", memoryCost: 8, timeCost: 1 };
        // Large warm-up so the JSC heap and allocator arenas reach steady state
        // before we start measuring (debug/ASAN builds especially need this).
        for (let i = 0; i < 60000; i++) Bun.password.hashSync("hey", opts);
        Bun.gc(true);
        const before = rss();
        for (let i = 0; i < 60000; i++) Bun.password.hashSync("hey", opts);
        Bun.gc(true);
        const growthMB = (rss() - before) / 1024 / 1024;
        // ASAN's free quarantine (default 256 MB) plus redzones and glibc page
        // retention inflate RSS even when nothing is leaking.
        const limit = ${isASAN ? 400 : 4};
        if (growthMB > limit) throw new Error("leaked " + growthMB.toFixed(2) + "MB (limit " + limit + "MB)");
      `);
  }, 90_000);

  test("hash", async () => {
    await run(/* js */ `
        const rss = process.memoryUsage.rss;
        const opts = { algorithm: "argon2id", memoryCost: 8, timeCost: 1 };
        async function batch(n) {
          const promises = [];
          for (let i = 0; i < n; i++) promises.push(Bun.password.hash("hey", opts));
          await Promise.all(promises);
        }
        for (let i = 0; i < 500; i++) await batch(100);
        Bun.gc(true);
        const before = rss();
        for (let i = 0; i < 2000; i++) await batch(100);
        Bun.gc(true);
        const growthMB = (rss() - before) / 1024 / 1024;
        // ASAN's free quarantine (default 256 MB) plus redzones and glibc page
        // retention inflate RSS even when nothing is leaking.
        const limit = ${isASAN ? 400 : 20};
        if (growthMB > limit) throw new Error("leaked " + growthMB.toFixed(2) + "MB (limit " + limit + "MB)");
      `);
  }, 90_000);
});

describe("hash", () => {
  describe("arguments parsing", () => {
    for (let hash of [password.hash, password.hashSync]) {
      test("no blank password allowed", () => {
        expect(() => hash("")).toThrow("password must not be empty");
      });

      test("password is required", () => {
        // @ts-expect-error
        expect(() => hash()).toThrow(expect.objectContaining({ name: "TypeError", code: "ERR_INVALID_ARG_TYPE" }));
        // @ts-expect-error
        expect(() => hash(undefined)).toThrow("password must be a string");
        // @ts-expect-error
        expect(() => hash(undefined, "bcrypt")).toThrow("password must be a string");
      });

      test("invalid algorithm throws", () => {
        // @ts-expect-error
        expect(() => hash(placeholder, "scrpyt")).toThrow();
        // @ts-expect-error
        expect(() => hash(placeholder, 123)).toThrow();

        expect(() =>
          hash(placeholder, {
            // @ts-expect-error
            toString() {
              return "scrypt";
            },
          }),
        ).toThrow();

        expect(() =>
          hash(placeholder, {
            // @ts-expect-error
            algorithm: "poop",
          }),
        ).toThrow();

        expect(() =>
          hash(placeholder, {
            algorithm: "bcrypt",
            cost: Infinity,
          }),
        ).toThrow();

        expect(() =>
          hash(placeholder, {
            algorithm: "argon2id",
            memoryCost: -1,
          }),
        ).toThrow();

        // argon2 requires `memoryCost >= 8 * parallelism`; Bun hard-codes
        // `parallelism = 1`, so anything below 8 must throw rather than be
        // silently clamped (regression coverage for #30960).
        for (const invalid of [1, 3, 7]) {
          expect(() =>
            hash(placeholder, {
              algorithm: "argon2id",
              memoryCost: invalid,
            }),
          ).toThrow("Memory cost must be at least 8");
        }

        expect(() =>
          hash(placeholder, {
            algorithm: "argon2id",
            timeCost: -1,
          }),
        ).toThrow();

        expect(() =>
          hash(placeholder, {
            algorithm: "bcrypt",
            cost: -999,
          }),
        ).toThrow();
      });

      test("cost values are range-checked before ToInt32 narrowing", () => {
        // These used to wrap modulo 2^32 (cost: 2^32 + 4 hashed with cost 4)
        // or truncate (cost: 4.5 hashed with cost 4) instead of throwing.
        expect(() =>
          hash(placeholder, {
            algorithm: "bcrypt",
            cost: 2 ** 32 + 4,
          }),
        ).toThrow("Rounds must be an integer between 4 and 31");

        expect(() =>
          hash(placeholder, {
            algorithm: "bcrypt",
            cost: 4.5,
          }),
        ).toThrow("Rounds must be an integer between 4 and 31");

        expect(() =>
          hash(placeholder, {
            algorithm: "argon2id",
            timeCost: 2 ** 32 + 2,
          }),
        ).toThrow("Time cost must be an integer between 1 and 4294967295");

        expect(() =>
          hash(placeholder, {
            algorithm: "argon2id",
            timeCost: 1.5,
          }),
        ).toThrow("Time cost must be an integer between 1 and 4294967295");

        expect(() =>
          hash(placeholder, {
            algorithm: "argon2id",
            memoryCost: 2 ** 32 + 4608,
          }),
        ).toThrow("Memory cost must be an integer between 8 and 4294967295");

        expect(() =>
          hash(placeholder, {
            algorithm: "argon2id",
            memoryCost: 8.5,
          }),
        ).toThrow("Memory cost must be an integer between 8 and 4294967295");

        // Non-finite values: NaN and -Infinity fail the lower-bound check,
        // +Infinity fails the integer/upper-bound check.
        for (const timeCost of [NaN, -Infinity]) {
          expect(() => hash(placeholder, { algorithm: "argon2id", timeCost })).toThrow(
            "Time cost must be greater than 0",
          );
        }
        expect(() => hash(placeholder, { algorithm: "argon2id", timeCost: Infinity })).toThrow(
          "Time cost must be an integer between 1 and 4294967295",
        );
        for (const memoryCost of [NaN, -Infinity]) {
          expect(() => hash(placeholder, { algorithm: "argon2id", memoryCost })).toThrow(
            "Memory cost must be at least 8",
          );
        }
        expect(() => hash(placeholder, { algorithm: "argon2id", memoryCost: Infinity })).toThrow(
          "Memory cost must be an integer between 8 and 4294967295",
        );
      });

      test("a password that is neither a string nor bytes throws", () => {
        for (const value of notBytes) {
          // @ts-expect-error
          expect(() => hash(value, { algorithm: "bcrypt", cost: 4 })).toThrow(mustBeBytes("password"));
        }
      });

      for (let ArrayBufferView of [
        Uint8Array,
        Uint16Array,
        Uint32Array,
        Int8Array,
        Int16Array,
        Int32Array,
        Float16Array,
        Float32Array,
        Float64Array,
        ArrayBuffer,
      ]) {
        test(`empty ${ArrayBufferView.name} throws`, () => {
          expect(() => hash(new ArrayBufferView(0))).toThrow("password must not be empty");
        });
      }
    }
  });
});

describe("verify", () => {
  describe("arguments parsing", () => {
    for (let verify of [password.verify, password.verifySync]) {
      test("minimum args", () => {
        const invalidArgument = expect.objectContaining({ name: "TypeError", code: "ERR_INVALID_ARG_TYPE" });
        // @ts-expect-error
        expect(() => verify()).toThrow(invalidArgument);
        // @ts-expect-error
        expect(() => verify("")).toThrow(invalidArgument);
        // @ts-expect-error
        expect(() => verify(undefined, "$")).toThrow("password must be a string");
        // @ts-expect-error
        expect(() => verify("$", undefined)).toThrow("hash must be a string");
      });

      test("empty values return false", async () => {
        expect(await verify("", "$")).toBeFalse();
        expect(await verify("$", "")).toBeFalse();
      });

      test("invalid algorithm throws", () => {
        // @ts-expect-error
        expect(() => verify(placeholder, "$", "scrpyt")).toThrow();
        // @ts-expect-error
        expect(() => verify(placeholder, "$", 123)).toThrow();
      });

      test("a password or a hash that is neither a string nor bytes throws", () => {
        for (const value of notBytes) {
          // @ts-expect-error
          expect(() => verify(value, "$")).toThrow(mustBeBytes("password"));
          // @ts-expect-error
          expect(() => verify("$", value)).toThrow(mustBeBytes("hash"));
        }
      });

      for (let ArrayBufferView of [
        Uint8Array,
        Uint16Array,
        Uint32Array,
        Int8Array,
        Int16Array,
        Int32Array,
        Float32Array,
        Float64Array,
        ArrayBuffer,
      ]) {
        test(`empty ${ArrayBufferView.name} returns false`, async () => {
          expect(await verify(new ArrayBufferView(0), new ArrayBufferView(0))).toBeFalse();
          expect(await verify("", new ArrayBufferView(0))).toBeFalse();
          expect(await verify(new ArrayBufferView(0), "")).toBeFalse();
        });
      }
    }
  });
});

// The async hashing tests below only await the thread-pooled password.hash /
// password.verify on closure-local inputs (no shared mutable state, no RSS
// assertions), so they can safely overlap.
test.concurrent.each([
  ["an ArrayBuffer", (bytes: Uint8Array<ArrayBuffer>) => bytes.buffer],
  [
    "a SharedArrayBuffer",
    (bytes: Uint8Array<ArrayBuffer>) => {
      const shared = new SharedArrayBuffer(bytes.length);
      new Uint8Array(shared).set(bytes);
      return shared;
    },
  ],
  ["a DataView", (bytes: Uint8Array<ArrayBuffer>) => new DataView(bytes.buffer)],
  ["a Uint16Array", (bytes: Uint8Array<ArrayBuffer>) => new Uint16Array(bytes.buffer)],
  [
    "a part of a larger buffer",
    (bytes: Uint8Array<ArrayBuffer>) => {
      const larger = new Uint8Array(bytes.length + 8).fill(0x61);
      larger.set(bytes, 4);
      return larger.subarray(4, 4 + bytes.length);
    },
  ],
])("a password and a hash can be %s", async (_, wrap) => {
  const bytesOf = (text: string) => wrap(new TextEncoder().encode(text)) as Bun.StringOrBuffer;
  const options = { algorithm: "bcrypt", cost: 4 } as const;
  const hashed = await password.hash(bytesOf("abcd"), options);
  expect({
    string: await password.verify("abcd", hashed),
    password: await password.verify(bytesOf("abcd"), hashed),
    hash: await password.verify("abcd", bytesOf(hashed)),
    other: await password.verify(bytesOf("abce"), hashed),
    sync: password.verifySync(bytesOf("abcd"), bytesOf(password.hashSync(bytesOf("abcd"), options))),
  }).toEqual({ string: true, password: true, hash: true, other: false, sync: true });
});

test.concurrent("verifySync() takes a hash in memory that another thread is writing", async () => {
  const script = `
    const { Worker } = require("node:worker_threads");
    // Of a version that is refused, so that each call only parses.
    const text = "$argon2id$v=18$m=8,t=1,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA";
    const hash = new Uint8Array(new SharedArrayBuffer(text.length));
    hash.set(Buffer.from(text));
    new Worker(
      \`const hash = require("node:worker_threads").workerData;
        for (;;) {
          hash[10] = 0x80;
          hash[10] = 0x76;
        }\`,
      { eval: true, workerData: hash },
    );
    while (Atomics.load(hash, 10) !== 0x80);
    for (let i = 0; i < ${isDebug ? 1000 : 5000}; i++) {
      try {
        Bun.password.verifySync("password", hash);
      } catch {}
    }
    console.log("done");
    process.exit(0);
  `;
  await using proc = Bun.spawn({ cmd: [bunExe(), "-e", script], env: bunEnv, stdout: "pipe", stderr: "inherit" });
  const [stdout, exitCode] = await Promise.all([proc.stdout.text(), proc.exited]);
  expect({ stdout, exitCode }).toEqual({ stdout: "done\n", exitCode: 0 });
});

test.concurrent("bcrypt uses the SHA-512 of passwords longer than 72 characters", async () => {
  const boop = Buffer.from("hey".repeat(100));
  const hashed = await password.hash(boop, "bcrypt");
  expect(await password.verify(boop, hashed, "bcrypt")).toBeTrue();
  const boop2 = Buffer.from("hey".repeat(24));
  expect(await password.verify(boop2, hashed, "bcrypt")).toBeFalse();
});

test.concurrent("bcrypt pre-hashing does not break compatibility across Bun versions", async () => {
  // hash generated by Bun 1.2.4
  // if we change the mechanism used to pre-hash long passwords so bcrypt doesn't truncate them,
  // then this hash will not be considered valid by later versions of Bun.
  const hash = "$2b$10$PsJ3/W82mzNJoP0rSblfvet2ab9jZg2aH7tIxr1B8uFLJwuWk/jTi";
  const secret = "hello".repeat(100);
  expect(await password.verify(secret, hash)).toBeTrue();
});

test.concurrent("argon2 memoryCost at the 8 minimum is encoded faithfully (regression for #30960)", async () => {
  const hashed = await password.hash("test", {
    algorithm: "argon2id",
    memoryCost: 8,
    timeCost: 1,
  });
  // The encoded PHC string must reflect the user-provided memoryCost, not a
  // silently clamped value. Before the fix, values below 8 were rounded up
  // while still reporting `m=8`; this pins the minimum at 8 as advertised.
  expect(hashed).toContain("m=8,t=1,p=1");
  expect(await password.verify("test", hashed)).toBeTrue();
});

describe.concurrent("argon2 hashes with memoryCost below 8 from earlier Bun versions still verify", () => {
  // Generated by Bun 1.3.14, which accepted memoryCost < 8.
  const legacy = {
    argon2id:
      "$argon2id$v=19$m=4,t=1,p=1$jaFm03353WIBtbqnvp4hx6Pd0Pk2keYfomedORTs6bI$Q+62iWiDQhCP3VFQvnMnGptmDAHFQGqY3d/dmRcGVOw",
    argon2i:
      "$argon2i$v=19$m=4,t=1,p=1$ccFUBS8pl1c6HrbfKTnDVnFuL7ZzrWWfn/HmEmPhXZs$SnmF2IobheA3dXrQ6PTAIFOI2mW7cmXaEdYOyeepuCc",
    argon2d:
      "$argon2d$v=19$m=4,t=1,p=1$l/aF7c94XVVjN+DEIojRJp2DueSSsSnIugDMmAm1h1E$h7CusZJfNR1nJQPyQsJMoHVpwlC/rCjYBS7Mc1bQdD0",
    "argon2id m=1":
      "$argon2id$v=19$m=1,t=1,p=1$BigwogH2c6TyJp0Po2odtNo1utvkW2MJbgm3liMV4xU$cw5OZZOZRBfd+bOnf1knGDZ67UwQN9j4nzpzt8P6JDY",
  };

  for (const [name, hash] of Object.entries(legacy)) {
    test(name, async () => {
      expect(await password.verify("hello", hash)).toBeTrue();
      expect(await password.verify("hellp", hash)).toBeFalse();
      expect(password.verifySync("hello", hash)).toBeTrue();
      expect(password.verifySync("hellp", hash)).toBeFalse();
    });
  }

  test("hashing with memoryCost below 8 is still rejected", () => {
    expect(() => password.hashSync("hello", { algorithm: "argon2id", memoryCost: 4 })).toThrow(
      "Memory cost must be at least 8",
    );
  });
});

const defaultAlgorithm = "argon2id";
const algorithms = [undefined, "argon2id", "bcrypt"];
const argons = ["argon2i", "argon2id", "argon2d"];

for (let algorithmValue of algorithms) {
  const prefix = algorithmValue === "bcrypt" ? "$2" : "$" + (algorithmValue || defaultAlgorithm);

  describe(algorithmValue ? algorithmValue : "default", () => {
    const hash = (value: string | NodeJS.TypedArray) => {
      return algorithmValue ? password.hash(value, algorithmValue as any) : password.hash(value);
    };

    const hashSync = (value: string | NodeJS.TypedArray) => {
      return algorithmValue ? password.hashSync(value, algorithmValue as any) : password.hashSync(value);
    };

    const verify = (pw: string | NodeJS.TypedArray, value: string | NodeJS.TypedArray) => {
      return algorithmValue ? password.verify(pw, value, algorithmValue as any) : password.verify(pw, value);
    };

    const verifySync = (pw: string | NodeJS.TypedArray, value: string | NodeJS.TypedArray) => {
      return algorithmValue ? password.verifySync(pw, value, algorithmValue as any) : password.verifySync(pw, value);
    };

    // Argon2 with the default `interactive_2id` params (64 MiB / 2 iter)
    // is too slow under debug/ASAN to finish inside the per-test timeout;
    // those invocations live in `password sync` (implicit default) and in
    // the `runSlowTest` branch below (explicit default per algorithm). Gate
    // them on release so the rest of the file still exercises the
    // fast-path (bcrypt, arg-parsing, explicit `memoryCost: 8`).
    const isArgonDefaults = algorithmValue === undefined || algorithmValue === "argon2id";
    const skipSlowArgonOnDebug = isDebug && isArgonDefaults;

    for (let input of [placeholder, Buffer.from(placeholder)]) {
      describe(typeof input === "string" ? "string" : "buffer", () => {
        test.skipIf(skipSlowArgonOnDebug)("password sync", () => {
          const hashed = hashSync(input);
          expect(hashed).toStartWith(prefix);
          expect(verifySync(input, hashed)).toBeTrue();
          expect(() => verifySync(hashed, input)).toThrow();
          expect(verifySync(input + "\0", hashed)).toBeFalse();
        });

        describe("password", async () => {
          async function runSlowTest(algorithm = algorithmValue as any) {
            const hashed = await password.hash(input, algorithm);
            const prefix = "$" + algorithm;
            expect(hashed).toStartWith(prefix);
            expect(await password.verify(input, hashed, algorithm)).toBeTrue();
            expect(() => password.verify(hashed, input, algorithm)).toThrow();
            expect(await password.verify(input + "\0", hashed, algorithm)).toBeFalse();
          }

          async function runSlowTestWithOptions(algorithmLabel: any) {
            const algorithm = { algorithm: algorithmLabel, timeCost: 5, memoryCost: 8 };
            const hashed = await password.hash(input, algorithm);
            const prefix = "$" + algorithmLabel;
            expect(hashed).toStartWith(prefix);
            expect(hashed).toContain("t=5");
            expect(hashed).toContain("m=8");
            expect(hashed).toContain("p=1");
            expect(await password.verify(input, hashed, algorithmLabel)).toBeTrue();
            expect(() => password.verify(hashed, input, algorithmLabel)).toThrow();
            expect(await password.verify(input + "\0", hashed, algorithmLabel)).toBeFalse();
          }

          async function runSlowBCryptTest() {
            const algorithm = { algorithm: "bcrypt", cost: 4 } as const;
            const hashed = await password.hash(input, algorithm);
            const prefix = "$" + "2b";
            expect(hashed).toStartWith(prefix);
            expect(await password.verify(input, hashed, "bcrypt")).toBeTrue();
            expect(() => password.verify(hashed, input, "bcrypt")).toThrow();
            expect(await password.verify(input + "\0", hashed, "bcrypt")).toBeFalse();
          }

          if (algorithmValue === defaultAlgorithm) {
            // these tests are very slow
            // run the hashing tests in parallel
            for (const a of argons) {
              // `runSlowTest` uses default params; only `runSlowTestWithOptions`
              // (memoryCost: 8) is fast enough for debug/ASAN.
              test.concurrent(`${a}`, async () => {
                if (!isDebug) await runSlowTest(a);
                await runSlowTestWithOptions(a);
              });
            }
            return;
          }

          async function defaultTest() {
            const hashed = await hash(input);
            expect(hashed).toStartWith(prefix);
            expect(await verify(input, hashed)).toBeTrue();
            expect(() => verify(hashed, input)).toThrow();
            expect(await verify(input + "\0", hashed)).toBeFalse();
          }

          if (algorithmValue === "bcrypt") {
            test.concurrent("bcrypt", async () => {
              await defaultTest();
              await runSlowBCryptTest();
            });
          } else {
            test.skipIf(skipSlowArgonOnDebug)("default", async () => {
              await defaultTest();
            });
          }
        });
      });
    }
  });
}

test("verify rejects encoded argon2 hashes with cost parameters above the supported maximums", async () => {
  // Hash with small, fast parameters so this test stays cheap on debug builds.
  const hashed = password.hashSync("correct horse", {
    algorithm: "argon2id",
    memoryCost: 8,
    timeCost: 1,
  });
  expect(hashed).toContain("$m=8,t=1,p=1$");

  // The untampered hash still verifies.
  expect(password.verifySync("correct horse", hashed)).toBeTrue();

  // A time cost far above the verification ceiling embedded in the encoded
  // hash must be rejected up front instead of being honored.
  const hugeTime = hashed.replace(",t=1,", ",t=100000,");
  expect(hugeTime).not.toBe(hashed);
  expect(() => password.verifySync("correct horse", hugeTime)).toThrow("WeakParameters");
  await expect(password.verify("correct horse", hugeTime)).rejects.toThrow("WeakParameters");

  // A memory cost above the ceiling is rejected before any allocation is
  // sized from the encoded string.
  const hugeMemory = hashed.replace("$m=8,", "$m=4294967294,");
  expect(hugeMemory).not.toBe(hashed);
  expect(() => password.verifySync("correct horse", hugeMemory)).toThrow("WeakParameters");
  await expect(password.verify("correct horse", hugeMemory)).rejects.toThrow("WeakParameters");

  // A parallelism value above the ceiling is rejected as well.
  const hugeParallelism = hashed.replace(",p=1$", ",p=65$");
  expect(hugeParallelism).not.toBe(hashed);
  expect(() => password.verifySync("correct horse", hugeParallelism)).toThrow("WeakParameters");
  await expect(password.verify("correct horse", hugeParallelism)).rejects.toThrow("WeakParameters");

  // The argon2 decoder accepts a leading `+` on the cost fields (Rust's integer
  // grammar), so the ceiling check must too rather than skipping the field.
  const plusMemory = hashed.replace("$m=8,", "$m=+4294967294,");
  expect(plusMemory).not.toBe(hashed);
  expect(() => password.verifySync("correct horse", plusMemory)).toThrow("WeakParameters");
  await expect(password.verify("correct horse", plusMemory)).rejects.toThrow("WeakParameters");

  // A cost field the decoder can't parse is rejected up front as well.
  const junkMemory = hashed.replace("$m=8,", "$m=8x,");
  expect(() => password.verifySync("correct horse", junkMemory)).toThrow("InvalidEncoding");
  await expect(password.verify("correct horse", junkMemory)).rejects.toThrow("InvalidEncoding");
});

// argon2 allocates memoryCost KiB up front. verify() reads the cost from the encoded hash.
describe("argon2 when memoryCost can't be allocated", () => {
  const script = (memoryCost: number) => /* js */ `
    const { password } = Bun;
    const describeError = e => ({ name: e.name, code: e.code, message: e.message });
    const options = { algorithm: "argon2id", memoryCost: ${memoryCost}, timeCost: 1 };
    const small = { algorithm: "argon2id", memoryCost: 8, timeCost: 1 };
    const encoded = password.hashSync("hunter2", small).replace("$m=8,", "$m=${memoryCost},");
    const results = {};
    try {
      password.hashSync("hunter2", options);
      results.hashSync = "resolved";
    } catch (e) {
      results.hashSync = describeError(e);
    }
    results.hash = await password.hash("hunter2", options).then(() => "resolved", describeError);
    try {
      results.verifySync = password.verifySync("hunter2", encoded);
    } catch (e) {
      results.verifySync = describeError(e);
    }
    results.verify = await password.verify("hunter2", encoded).then(v => v, describeError);
    results.afterwards = await password.verify("hunter2", await password.hash("hunter2", small));
    console.log(JSON.stringify(results));
  `;
  const outOfMemory = (verb: string) => ({
    name: "Error",
    code: "PASSWORD_OUT_OF_MEMORY",
    message: `Password ${verb} failed with error "OutOfMemory"`,
  });
  const expected = {
    hashSync: outOfMemory("hashing"),
    hash: outOfMemory("hashing"),
    verifySync: outOfMemory("verification"),
    verify: outOfMemory("verification"),
    afterwards: true,
  };

  async function runChild(cmd: string[], env: NodeJS.Dict<string>) {
    await using proc = Bun.spawn({ cmd, env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    // stderr isn't checked because ASAN prints a warning for every allocation it rejects.
    return { result: JSON.parse(stdout.trim() || JSON.stringify({ stdout, stderr, exitCode })), exitCode };
  }

  test.skipIf(!isASAN)("throws PASSWORD_OUT_OF_MEMORY (ASAN allocation cap)", async () => {
    const { result, exitCode } = await runChild([bunExe(), "-e", script(65536)], {
      ...bunEnv,
      ASAN_OPTIONS: [bunEnv.ASAN_OPTIONS, "allocator_may_return_null=1", "max_allocation_size_mb=32"]
        .filter(Boolean)
        .join(":"),
    });
    expect(result).toEqual(expected);
    expect(exitCode).toBe(0);
  });

  test.skipIf(isASAN || !isLinux)("throws PASSWORD_OUT_OF_MEMORY (address-space limit)", async () => {
    // 4 GiB is the largest cost verify() accepts. ASAN builds can't start under this limit.
    const gib = 1024 * 1024; // in KiB, the unit of both ulimit -v and memoryCost
    const { result, exitCode } = await runChild(
      ["/bin/sh", "-c", `ulimit -v ${4 * gib} && exec "$0" "$@"`, bunExe(), "-e", script(4 * gib)],
      bunEnv,
    );
    expect(result).toEqual(expected);
    expect(exitCode).toBe(0);
  });
});

test("verifySync reads the password buffer only after every argument has been coerced", () => {
  const hashed = password.hashSync("correct horse", { algorithm: "argon2id", memoryCost: 8, timeCost: 1 });
  const passwordBytes = new TextEncoder().encode("correct horse");
  const hashObject = new String(hashed);
  hashObject.toString = () => {
    structuredClone(passwordBytes.buffer, { transfer: [passwordBytes.buffer] });
    Bun.gc(true);
    return hashed;
  };
  expect(password.verifySync(passwordBytes, hashObject as any)).toBeFalse();
  expect(passwordBytes.byteLength).toBe(0);
});

/** What `call` throws before it returns. A promise that it returns and that rejects is not that. */
function thrownBy(call: () => unknown) {
  try {
    call();
  } catch (error) {
    return error;
  }
}

const invalidArgument = (message: string | RegExp) =>
  expect.objectContaining({
    name: "TypeError",
    code: "ERR_INVALID_ARG_TYPE",
    message: typeof message === "string" ? message : expect.stringMatching(message),
  });

describe("secret", () => {
  // The smallest costs, so that a debug build hashes in milliseconds.
  const fast = { algorithm: "argon2id", memoryCost: 8, timeCost: 1 } as const;
  const secret = "a pepper that is kept out of the database";
  const noSecretForBcrypt = invalidArgument("secret is not supported by bcrypt, only by argon2");

  for (const algorithm of ["argon2id", "argon2i", "argon2d"] as const) {
    test.concurrent(`an ${algorithm} hash verifies with its secret and with no other`, async () => {
      const options = { algorithm, memoryCost: 8, timeCost: 1, secret };
      for (const hashed of [await password.hash("hunter2", options), password.hashSync("hunter2", options)]) {
        // The secret is a key. It is not in the string, which is as long as one without a secret.
        expect(hashed).toMatch(
          new RegExp(`^\\$${algorithm}\\$v=19\\$m=8,t=1,p=1\\$[A-Za-z0-9+/]{43}\\$[A-Za-z0-9+/]{43}$`),
        );
        expect({
          secret: await password.verify("hunter2", hashed, { secret }),
          secretSync: password.verifySync("hunter2", hashed, { secret }),
          secretAsBytes: await password.verify("hunter2", hashed, { secret: Buffer.from(secret) }),
          secretAndAlgorithm: password.verifySync("hunter2", hashed, { algorithm, secret }),
          otherPassword: await password.verify("hunter3", hashed, { secret }),
          otherSecret: await password.verify("hunter2", hashed, { secret: secret + "!" }),
          otherSecretSync: password.verifySync("hunter2", hashed, { secret: secret + "!" }),
          noSecret: await password.verify("hunter2", hashed),
          noSecretSync: password.verifySync("hunter2", hashed),
          noSecretAndAlgorithm: await password.verify("hunter2", hashed, algorithm),
          emptyOptions: password.verifySync("hunter2", hashed, {}),
        }).toEqual({
          secret: true,
          secretSync: true,
          secretAsBytes: true,
          secretAndAlgorithm: true,
          otherPassword: false,
          otherSecret: false,
          otherSecretSync: false,
          noSecret: false,
          noSecretSync: false,
          noSecretAndAlgorithm: false,
          emptyOptions: false,
        });
      }
    });
  }

  test("is the secret of crypto.argon2Sync()", () => {
    const hashed = password.hashSync("hunter2", { ...fast, secret });
    const [salt, tag] = hashed.split("$").slice(4);
    const parameters = {
      message: "hunter2",
      nonce: Buffer.from(salt, "base64"),
      parallelism: 1,
      tagLength: 32,
      memory: 8,
      passes: 1,
    };
    const tagOf = (secret?: string) =>
      argon2Sync("argon2id", { ...parameters, secret })
        .toString("base64")
        .replaceAll("=", "");
    expect(tagOf(secret)).toBe(tag);
    expect(tagOf()).not.toBe(tag);
  });

  test("verifies stored hashes that were made with a secret", () => {
    // Made with the costs of `fast` and with `secret`. Node.js 26.3.0, which computes argon2 with OpenSSL, gives the
    // tag of each from its salt and `secret`, and another tag without `secret`.
    for (const hashed of [
      "$argon2id$v=19$m=8,t=1,p=1$YWhmtDVTMK1IacMNLK4awBTzkPgpLbYkVb0C1XToWZ4$rfQTKq9sgl0ofzjdIi71VTqBlSKO9LJ/BSo3OIxEj94",
      "$argon2i$v=19$m=8,t=1,p=1$NQuq18TF9XvH2UshK3X2HvdbyWPRI77+2ifHmfcpLMQ$Gh0BrhHdAXXGiRDTKWrvuMatty+vXU7HOkN7RMGwwLQ",
      "$argon2d$v=19$m=8,t=1,p=1$ahGjakl6WbgKsvF0I3ZMMPHJ/UodvzxYfiGAwVRedhE$L1bjBv9ZJhBYVb5n3vkmMTZ+fnSOxnYeyGURXTzm5P4",
    ]) {
      expect(password.verifySync("hunter2", hashed, { secret })).toBeTrue();
      expect(password.verifySync("hunter2", hashed)).toBeFalse();
    }
  });

  test("a string is its UTF-8 bytes, and a view is the bytes it covers", () => {
    // A Latin-1 string, a UTF-16 string, and one that is longer than the buffer a short string is converted into.
    const pepper = "p\u00e9pper \u{1f336}";
    for (const text of ["p\u00e9pper", pepper, Array.from({ length: 40 }, () => pepper).join("")]) {
      const bytes = new TextEncoder().encode(text).slice();
      const padded = new Uint8Array(bytes.length + 4);
      padded.set(bytes, 2);
      const shared = new Uint8Array(new SharedArrayBuffer(bytes.length));
      shared.set(bytes);

      const hashed = password.hashSync("hunter2", { ...fast, secret: text });
      expect({
        typedArray: password.verifySync("hunter2", hashed, { secret: bytes }),
        arrayBuffer: password.verifySync("hunter2", hashed, { secret: bytes.buffer }),
        subarray: password.verifySync("hunter2", hashed, { secret: padded.subarray(2, 2 + bytes.length) }),
        shared: password.verifySync("hunter2", hashed, { secret: shared }),
        stringObject: password.verifySync("hunter2", hashed, { secret: new String(text) as unknown as string }),
        bufferOfSubarray: password.verifySync("hunter2", hashed, { secret: padded }),
        latin1: password.verifySync("hunter2", hashed, { secret: Buffer.from(text, "latin1") }),
      }).toEqual({
        typedArray: true,
        arrayBuffer: true,
        subarray: true,
        shared: true,
        stringObject: true,
        bufferOfSubarray: false,
        latin1: false,
      });
      expect(
        password.verifySync("hunter2", password.hashSync("hunter2", { ...fast, secret: bytes }), { secret: text }),
      ).toBeTrue();
    }

    // Bytes that are not UTF-8, as a key from a key management service is.
    const binary = new Uint8Array([0xff, 0x00, 0xfe, 0x80]);
    const keyed = password.hashSync("hunter2", { ...fast, secret: binary });
    expect(password.verifySync("hunter2", keyed, { secret: binary })).toBeTrue();
    expect(password.verifySync("hunter2", keyed, { secret: binary.subarray(0, 3) })).toBeFalse();
    expect(password.verifySync("hunter2", keyed, { secret: Buffer.from(binary).toString("latin1") })).toBeFalse();
  });

  test("hash() and verify() keep a copy of the secret", async () => {
    const key = () => new Uint8Array(32).fill(7);

    const overwritten = key();
    const hashing = password.hash("hunter2", { ...fast, secret: overwritten });
    overwritten.fill(8);
    const hashed = await hashing;
    expect(password.verifySync("hunter2", hashed, { secret: key() })).toBeTrue();
    expect(password.verifySync("hunter2", hashed, { secret: overwritten })).toBeFalse();

    const detached = key();
    const verifying = password.verify("hunter2", hashed, { secret: detached });
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    expect(detached.byteLength).toBe(0);
    expect(await verifying).toBeTrue();
  });

  test("undefined and null are no secret", () => {
    const hashed = password.hashSync("hunter2", { ...fast, secret: undefined });
    expect({
      none: password.verifySync("hunter2", hashed),
      undefined: password.verifySync("hunter2", hashed, { secret: undefined }),
      null: password.verifySync("hunter2", hashed, { secret: null! }),
      hashedWithNull: password.verifySync("hunter2", password.hashSync("hunter2", { ...fast, secret: null! })),
      algorithm: password.verifySync("hunter2", hashed, { algorithm: "argon2id" }),
      undefinedAlgorithm: password.verifySync("hunter2", hashed, { algorithm: undefined }),
      secret: password.verifySync("hunter2", hashed, { secret }),
    }).toEqual({
      none: true,
      undefined: true,
      null: true,
      hashedWithNull: true,
      algorithm: true,
      undefinedAlgorithm: true,
      secret: false,
    });
  });

  test("an empty secret throws", () => {
    const hashed = password.hashSync("hunter2", fast);
    const detached = new Uint8Array(32).fill(7);
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    const empty = invalidArgument("secret must not be empty");
    for (const secret of ["", new Uint8Array(0), new ArrayBuffer(0), detached]) {
      expect(thrownBy(() => password.hash("hunter2", { ...fast, secret }))).toEqual(empty);
      expect(thrownBy(() => password.hashSync("hunter2", { ...fast, secret }))).toEqual(empty);
      expect(thrownBy(() => password.verify("hunter2", hashed, { secret }))).toEqual(empty);
      expect(thrownBy(() => password.verifySync("hunter2", hashed, { secret }))).toEqual(empty);
      expect(thrownBy(() => password.needsRehash(hashed, { ...fast, secret }))).toEqual(empty);
    }
  });

  test("a secret that is not a string or a buffer throws", () => {
    const hashed = password.hashSync("hunter2", fast);
    const wrongType = invalidArgument("Expected options.secret to be a string, ArrayBuffer or ArrayBufferView");
    for (const secret of [123, 1n, true, false, {}, [1, 2, 3], () => {}, Symbol("secret"), new Blob(["x"])] as any[]) {
      expect(thrownBy(() => password.hash("hunter2", { ...fast, secret }))).toEqual(wrongType);
      expect(thrownBy(() => password.hashSync("hunter2", { ...fast, secret }))).toEqual(wrongType);
      expect(thrownBy(() => password.verify("hunter2", hashed, { secret }))).toEqual(wrongType);
      expect(thrownBy(() => password.verifySync("hunter2", hashed, { secret }))).toEqual(wrongType);
      expect(thrownBy(() => password.needsRehash(hashed, { ...fast, secret }))).toEqual(wrongType);
    }
  });

  test("bcrypt has no secret: hash(), verify() and needsRehash() throw", async () => {
    const cost4 = { algorithm: "bcrypt", cost: 4 } as const;
    const crypt = password.hashSync("hunter2", cost4);
    // The salt and the digest of a "$2b$" hash are base64 in an alphabet of bcrypt. The PHC format has the usual one.
    const bcryptAlphabet = "./ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const base64 = (text: string) => text.replace(/./g, character => base64Alphabet[bcryptAlphabet.indexOf(character)]);
    const phc = `$bcrypt$r=4$${base64(crypt.slice(7, 29))}$${base64(crypt.slice(29))}`;

    // @ts-expect-error
    expect(thrownBy(() => password.hash("hunter2", { algorithm: "bcrypt", cost: 4, secret }))).toEqual(
      noSecretForBcrypt,
    );
    // @ts-expect-error
    expect(thrownBy(() => password.hashSync("hunter2", { algorithm: "bcrypt", cost: 4, secret }))).toEqual(
      noSecretForBcrypt,
    );
    // @ts-expect-error
    expect(thrownBy(() => password.needsRehash(crypt, { algorithm: "bcrypt", cost: 4, secret }))).toEqual(
      noSecretForBcrypt,
    );
    // @ts-expect-error
    expect(thrownBy(() => password.hashSync("hunter2", { algorithm: "bcrypt", secret: "" }))).toEqual(
      noSecretForBcrypt,
    );

    // A hash that says it is bcrypt was not made with the secret. verify() does not fall back to a check without it.
    for (const hashed of [crypt, crypt.replace("$2b$", "$2a$"), crypt.replace("$2b$", "$2y$"), phc]) {
      expect(password.verifySync("hunter2", hashed)).toBeTrue();
      expect(thrownBy(() => password.verify("hunter2", hashed, { secret }))).toEqual(noSecretForBcrypt);
      expect(thrownBy(() => password.verifySync("hunter2", hashed, { secret }))).toEqual(noSecretForBcrypt);
      expect(thrownBy(() => password.verifySync("hunter2", hashed, { algorithm: "bcrypt", secret }))).toEqual(
        noSecretForBcrypt,
      );
      const asArgon2 = { name: "Error", code: "PASSWORD_INVALID_ENCODING" };
      expect(() => password.verifySync("hunter2", hashed, { algorithm: "argon2id", secret })).toThrow(
        expect.objectContaining(asArgon2),
      );
      await expect(password.verify("hunter2", hashed, { algorithm: "argon2id", secret })).rejects.toMatchObject(
        asArgon2,
      );
    }

    // The empty values that are false with no secret are false with one.
    expect(await password.verify("", crypt, { secret })).toBeFalse();
    expect(password.verifySync("hunter2", "", { secret })).toBeFalse();
    expect(thrownBy(() => password.verifySync("", crypt, { algorithm: "bcrypt", secret }))).toEqual(noSecretForBcrypt);
  });

  test("the third argument of verify() is the name of an algorithm or the options", async () => {
    const hashed = password.hashSync("hunter2", fast);
    const notTheOptions = invalidArgument("Expected algorithm to be a string or an object for 'verify'.");
    const unknownAlgorithm = invalidArgument(/^Expected algorithm to be a unknown algorithm, .* for 'verify'\.$/);
    for (const verify of [password.verify, password.verifySync]) {
      expect(verify.length).toBe(2);

      // A String object is a name, as it was before the options.
      expect(await verify("hunter2", hashed, new String("argon2id") as any)).toBeTrue();
      expect(thrownBy(() => verify("hunter2", hashed, new String("scrypt") as any))).toEqual(unknownAlgorithm);
      // bcrypt does not read an argon2 hash, under either spelling of the argument.
      expect(await verify("hunter2", hashed, "bcrypt")).toBeFalse();
      expect(await verify("hunter2", hashed, new String("bcrypt") as any)).toBeFalse();
      expect(await verify("hunter2", hashed, { algorithm: "bcrypt" })).toBeFalse();
      // @ts-expect-error
      expect(thrownBy(() => verify("hunter2", hashed, { algorithm: "scrypt" }))).toEqual(unknownAlgorithm);
      // @ts-expect-error
      expect(thrownBy(() => verify("hunter2", hashed, { algorithm: 123 }))).toEqual(
        invalidArgument("options.algorithm must be a string"),
      );

      // A plain object is the options. It is not converted to a name.
      const notAName = { toString: () => "bcrypt" };
      // @ts-expect-error
      expect(await verify("hunter2", hashed, notAName)).toBeTrue();

      // A secret in the place of the options, the callback of bcrypt.compare(), and what was never taken.
      for (const argument of [Buffer.from(secret), new ArrayBuffer(8), () => {}, [], ["argon2id"], 123, 1n, true]) {
        expect(thrownBy(() => verify("hunter2", hashed, argument as any))).toEqual(notTheOptions);
      }
    }
  });
});

describe("needsRehash", () => {
  // The two hashes of the documentation. Nothing is hashed here: only the algorithm and the costs of a string are read.
  const argon2id =
    "$argon2id$v=19$m=65536,t=2,p=1$tFq+9AVr1bfPxQdh6E8DQRhEXg/M/SqYCNu6gVdRRNs$GzJ8PuBi+K+BVojzPfS5mjnC8OpLGtv8KJqF99eP6a4";
  const bcrypt = "$2b$10$Lyj9kHYZtiyfxh2G60TEfeqs7xkkGiEFFDi3iJGc50ZG/XJ1sxIFi";

  test("is false for a hash of the algorithm and the costs", () => {
    expect({
      default: password.needsRehash(argon2id),
      undefined: password.needsRehash(argon2id, undefined),
      label: password.needsRehash(argon2id, "argon2id"),
      defaultCosts: password.needsRehash(argon2id, { algorithm: "argon2id" }),
      costs: password.needsRehash(argon2id, { algorithm: "argon2id", memoryCost: 65536, timeCost: 2 }),
      buffer: password.needsRehash(Buffer.from(argon2id)),
      argon2i: password.needsRehash(argon2id.replace("$argon2id$", "$argon2i$"), "argon2i"),
      argon2d: password.needsRehash(argon2id.replace("$argon2id$", "$argon2d$"), "argon2d"),
      bcrypt: password.needsRehash(bcrypt, "bcrypt"),
      bcryptCost: password.needsRehash(bcrypt, { algorithm: "bcrypt", cost: 10 }),
      bcryptBuffer: password.needsRehash(new TextEncoder().encode(bcrypt), "bcrypt"),
    }).toEqual({
      default: false,
      undefined: false,
      label: false,
      defaultCosts: false,
      costs: false,
      buffer: false,
      argon2i: false,
      argon2d: false,
      bcrypt: false,
      bcryptCost: false,
      bcryptBuffer: false,
    });
  });

  test("is true for a hash of other costs, higher or lower", () => {
    expect({
      memoryCost: password.needsRehash(argon2id, { algorithm: "argon2id", memoryCost: 131072 }),
      lowerMemoryCost: password.needsRehash(argon2id, { algorithm: "argon2id", memoryCost: 32768 }),
      timeCost: password.needsRehash(argon2id, { algorithm: "argon2id", timeCost: 3 }),
      lowerTimeCost: password.needsRehash(argon2id, { algorithm: "argon2id", timeCost: 1 }),
      // hash() always makes one lane. Other libraries make four.
      parallelism: password.needsRehash(argon2id.replace(",p=1$", ",p=4$")),
      bcryptCost: password.needsRehash(bcrypt, { algorithm: "bcrypt", cost: 12 }),
      lowerBcryptCost: password.needsRehash(bcrypt, { algorithm: "bcrypt", cost: 4 }),
    }).toEqual({
      memoryCost: true,
      lowerMemoryCost: true,
      timeCost: true,
      lowerTimeCost: true,
      parallelism: true,
      bcryptCost: true,
      lowerBcryptCost: true,
    });
  });

  test("is true for a hash of another algorithm", () => {
    expect({
      argon2idAsArgon2i: password.needsRehash(argon2id, "argon2i"),
      argon2idAsArgon2d: password.needsRehash(argon2id, "argon2d"),
      argon2idAsBcrypt: password.needsRehash(argon2id, "bcrypt"),
      argon2iAsArgon2id: password.needsRehash(argon2id.replace("$argon2id$", "$argon2i$")),
      argon2dAsArgon2id: password.needsRehash(argon2id.replace("$argon2id$", "$argon2d$")),
      bcryptAsArgon2id: password.needsRehash(bcrypt),
      bcryptAsArgon2i: password.needsRehash(bcrypt, { algorithm: "argon2i", memoryCost: 8, timeCost: 1 }),
    }).toEqual({
      argon2idAsArgon2i: true,
      argon2idAsArgon2d: true,
      argon2idAsBcrypt: true,
      argon2iAsArgon2id: true,
      argon2dAsArgon2id: true,
      bcryptAsArgon2id: true,
      bcryptAsArgon2i: true,
    });
  });

  test("reads the other forms of a hash that verify() reads", () => {
    const fast = { algorithm: "argon2id", memoryCost: 8, timeCost: 1 } as const;
    const cost4 = { algorithm: "bcrypt", cost: 4 } as const;
    const argon2 = password.hashSync("hunter2", fast);
    const crypt = password.hashSync("hunter2", cost4);
    // The salt and the digest of a "$2b$" hash are base64 in an alphabet of bcrypt. The PHC format has the usual one.
    const bcryptAlphabet = "./ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const base64 = (text: string) => text.replace(/./g, character => base64Alphabet[bcryptAlphabet.indexOf(character)]);
    const forms = {
      // verify() takes an argon2 hash that has no version for version 19.
      unversioned: argon2.replace("$v=19$", "$"),
      "2a": crypt.replace("$2b$", "$2a$"),
      "2x": crypt.replace("$2b$", "$2x$"),
      "2y": crypt.replace("$2b$", "$2y$"),
      phc: `$bcrypt$r=4$${base64(crypt.slice(7, 29))}$${base64(crypt.slice(29))}`,
    };
    expect(forms.unversioned).toStartWith("$argon2id$m=8,t=1,p=1$");

    for (const [form, hashed] of Object.entries(forms)) {
      const [same, other] = form === "unversioned" ? [fast, { ...fast, timeCost: 2 }] : [cost4, { ...cost4, cost: 5 }];
      expect({
        form,
        verifies: password.verifySync("hunter2", hashed),
        needsRehash: password.needsRehash(hashed, same),
        needsRehashForOtherCost: password.needsRehash(hashed, other),
      }).toEqual({ form, verifies: true, needsRehash: false, needsRehashForOtherCost: true });
    }

    // verify() reads this spelling only when it is told the algorithm, so it is not a form to keep.
    const capitalized = argon2.replace("$argon2id$", "$Argon2id$");
    expect(password.verifySync("hunter2", capitalized, "argon2id")).toBeTrue();
    expect(() => password.verifySync("hunter2", capitalized)).toThrow(
      expect.objectContaining({ name: "Error", code: "PASSWORD_UNSUPPORTED_ALGORITHM" }),
    );
    expect(password.needsRehash(capitalized, fast)).toBeTrue();
  });

  test("is true for a string that does not have the form of a hash", () => {
    const strings = [
      "",
      "$",
      "hunter2",
      "$argon2id$",
      "argon2id$v=19$m=65536,t=2,p=1$c2FsdHNhbHQ$dGFn",
      "$argon2id$v=19$m=65536,t=2,p=1",
      "$argon2id$v=19$m=65536,t=2,p=1$",
      "$argon2id$v=19$m=65536,t=2,p=1$c2FsdHNhbHQ",
      "$argon2id$v=19$m=65536,t=2,p=1$c2FsdHNhbHQ$",
      "$argon2id$v=19$m=65536,t=2,p=1$$dGFn",
      argon2id + "$",
      argon2id.replace("$v=19$", "$v=16$"),
      argon2id.replace("$v=19$", "$v=19$v=19$"),
      argon2id.replace("$argon2id$", "$argon2$"),
      argon2id.replace("$argon2id$", "$ARGON2ID$"),
      argon2id.replace("$tFq+", "$tFq\u00e9"),
      argon2id.replace("m=65536", "m=65536x"),
      argon2id.replace("m=65536", "m=-65536"),
      argon2id.replace("m=65536", "m=4294967296"),
      argon2id.replace("m=65536", "m="),
      argon2id.replace("m=65536,t=2", "t=2,m=65536"),
      argon2id.replace(",p=1$", "$"),
      argon2id.replace(",p=1$", ",p=1,keyid=a2V5$"),
      "$scrypt$ln=16,r=8,p=1$aM15713r3Xsvxbi31lqr1Q$nFNh2CVHVjNldFVKDHDlm4CbdRSCdEBsjjJxD+iCs5E",
      bcrypt.slice(0, -1),
      bcrypt + "i",
      // 60 bytes, as a hash of bcrypt has, and not ASCII.
      bcrypt.slice(0, -2) + "\u00e9",
      bcrypt.replace("$2b$", "$2c$"),
      bcrypt.replace("$2b$", "$2$b"),
      bcrypt.replace("$10$", "$1x$"),
      bcrypt.replace("$10$", "$100"),
      "$bcrypt$r=10$",
      "$bcrypt$r=10$il0DMPmSpDzvybeM5c19EA",
      "$bcrypt$r=10$$1QW+zMrO4HHCdWf1H+C9YdvK31hhTKw",
      "$bcrypt$r=10$il0DMPmSpDzvybeM5c19EA$1QW+zMrO4HHCdWf1H+C9YdvK31hhTKw$",
      "$bcrypt$r=10$il0DMPmSpDzvybeM5c19EA$1QW+zMrO4HHCdWf1H+C9YdvK31hhTKw$1QW+",
      "$bcrypt$r=x$il0DMPmSpDzvybeM5c19EA$1QW+zMrO4HHCdWf1H+C9YdvK31hhTKw",
      "$bcrypt$r=256$il0DMPmSpDzvybeM5c19EA$1QW+zMrO4HHCdWf1H+C9YdvK31hhTKw",
    ];
    expect(strings.filter(string => !password.needsRehash(string))).toEqual([]);
    expect(strings.filter(string => !password.needsRehash(string, "bcrypt"))).toEqual([]);
  });

  test("reads the costs of a hash and computes nothing", () => {
    // A hash of these costs takes hours and four terabytes to verify.
    const costly = argon2id.replace("m=65536,t=2", "m=4294967295,t=4294967295");
    const options = { algorithm: "argon2id", memoryCost: 4294967295, timeCost: 4294967295 } as const;
    expect(password.needsRehash(costly, options)).toBeFalse();
    expect(password.needsRehash(costly)).toBeTrue();
    expect(password.needsRehash(argon2id, options)).toBeTrue();
    expect(password.needsRehash(bcrypt.replace("$10$", "$31$"), { algorithm: "bcrypt", cost: 31 })).toBeFalse();
  });

  test("takes the second argument of hash()", () => {
    expect(password.needsRehash.length).toBe(1);
    const hashIsRequired = invalidArgument("hash must be a string, ArrayBuffer or ArrayBufferView");
    // @ts-expect-error
    expect(thrownBy(() => password.needsRehash())).toEqual(hashIsRequired);
    // @ts-expect-error
    expect(thrownBy(() => password.needsRehash(undefined, "bcrypt"))).toEqual(hashIsRequired);
    // @ts-expect-error
    expect(thrownBy(() => password.needsRehash(123))).toEqual(hashIsRequired);
    // @ts-expect-error
    expect(thrownBy(() => password.needsRehash(argon2id, "scrypt"))).toEqual(
      invalidArgument(/^Expected algorithm to be a unknown algorithm, .* for 'needsRehash'\.$/),
    );
    // @ts-expect-error
    expect(thrownBy(() => password.needsRehash(argon2id, {}))).toEqual(
      invalidArgument("Expected options.algorithm to be a string for 'needsRehash'."),
    );
    // @ts-expect-error
    expect(thrownBy(() => password.needsRehash(argon2id, { algorithm: "argon2id", timeCost: "2" }))).toEqual(
      invalidArgument("Expected timeCost to be a number for 'needsRehash'."),
    );
    expect(thrownBy(() => password.needsRehash(argon2id, { algorithm: "argon2id", memoryCost: 4 }))).toEqual(
      invalidArgument("Memory cost must be at least 8"),
    );
    expect(thrownBy(() => password.needsRehash(argon2id, { algorithm: "argon2id", timeCost: 0 }))).toEqual(
      invalidArgument("Time cost must be greater than 0"),
    );
    expect(thrownBy(() => password.needsRehash(bcrypt, { algorithm: "bcrypt", cost: 32 }))).toEqual(
      invalidArgument("Rounds must be an integer between 4 and 31"),
    );

    // A hash does not hold its secret, so a secret makes no difference.
    expect(password.needsRehash(argon2id, { algorithm: "argon2id", secret: "pepper" })).toBeFalse();
    expect(password.needsRehash(argon2id, { algorithm: "argon2id", timeCost: 3, secret: "pepper" })).toBeTrue();
  });

  test("is false for what hash() and hashSync() return", async () => {
    const all = [
      { algorithm: "argon2id", memoryCost: 8, timeCost: 1 },
      { algorithm: "argon2i", memoryCost: 16, timeCost: 2 },
      { algorithm: "argon2d", memoryCost: 24, timeCost: 3 },
      { algorithm: "argon2id", memoryCost: 8, timeCost: 1, secret: "pepper" },
      { algorithm: "bcrypt", cost: 4 },
      { algorithm: "bcrypt", cost: 5 },
    ] as const;
    const hashes = await Promise.all(all.map(options => password.hash("hunter2", options)));
    hashes.push(...all.map(options => password.hashSync("hunter2", options)));
    // Each hash against each of the options: only its own, and the one that differs in the secret, need no new hash.
    expect(hashes.map(hash => all.map(options => (password.needsRehash(hash, options) ? "x" : ".")).join(""))).toEqual([
      ".xx.xx",
      "x.xxxx",
      "xx.xxx",
      ".xx.xx",
      "xxxx.x",
      "xxxxx.",
      ".xx.xx",
      "x.xxxx",
      "xx.xxx",
      ".xx.xx",
      "xxxx.x",
      "xxxxx.",
    ]);
  });

  test("after verify(), tells when to store a new hash", async () => {
    const old = { algorithm: "bcrypt", cost: 4 } as const;
    const current = { algorithm: "argon2id", memoryCost: 8, timeCost: 2 } as const;
    let stored = await password.hash("hunter2", old);

    async function login(input: string) {
      if (!(await password.verify(input, stored))) return false;
      if (password.needsRehash(stored, current)) stored = await password.hash(input, current);
      return true;
    }

    expect(await login("hunter3")).toBeFalse();
    expect(stored).toStartWith("$2b$04$");
    expect(await login("hunter2")).toBeTrue();
    expect(stored).toStartWith("$argon2id$v=19$m=8,t=2,p=1$");
    const rehashed = stored;
    expect(await login("hunter2")).toBeTrue();
    expect(stored).toBe(rehashed);
  });
});
