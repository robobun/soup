import { expect, test } from "bun:test";
import { bunEnv, bunExe, normalizeBunSnapshot, tempDir } from "harness";
import { readFileSync } from "node:fs";
import path from "path";

test("coverage crash", () => {
  using dir = tempDir("cov", {
    "demo.test.ts": `class Y {
  #hello
}`,
  });
  const result = Bun.spawnSync([bunExe(), "test", "--coverage"], {
    cwd: dir,
    env: {
      ...bunEnv,
    },
    stdio: ["inherit", "inherit", "inherit"],
  });
  expect(result.exitCode).toBe(0);
  expect(result.signalCode).toBeUndefined();
});

test("lcov coverage reporter", () => {
  using dir = tempDir("cov", {
    "demo2.ts": `
import { Y } from "./demo1";

export function covered() {
  // this function IS covered
  return Y;
}

export function uncovered() {
  // this function is not covered
  return 42;
}

covered();
`,
    "demo1.ts": `
export class Y {
#hello;
};
    `,
  });
  const result = Bun.spawnSync([bunExe(), "test", "--coverage", "--coverage-reporter", "lcov", "./demo2.ts"], {
    cwd: dir,
    env: {
      ...bunEnv,
    },
    stdio: ["inherit", "inherit", "inherit"],
  });
  expect(result.exitCode).toBe(0);
  expect(result.signalCode).toBeUndefined();
  expect(normalizeBunSnapshot(readFileSync(path.join(dir, "coverage", "lcov.info"), "utf-8"), dir)).toMatchSnapshot(
    "lcov-coverage-reporter-output",
  );
});

test("coverage excludes node_modules directory", () => {
  using dir = tempDir("cov", {
    "node_modules/pi/index.js": `
    export const pi = 3.14;
    `,
    "demo.test.ts": `
    import { pi } from 'pi';
    console.log(pi);
    `,
  });
  const result = Bun.spawnSync([bunExe(), "test", "--coverage"], {
    cwd: dir,
    env: {
      ...bunEnv,
    },
    stdio: [null, null, "pipe"],
  });
  expect(result.stderr.toString("utf-8")).toContain("demo.test.ts");
  expect(result.stderr.toString("utf-8")).not.toContain("node_modules");
  expect(result.exitCode).toBe(0);
  expect(result.signalCode).toBeUndefined();
});

test("coveragePathIgnorePatterns - single pattern string", () => {
  using dir = tempDir("cov", {
    "bunfig.toml": `
[test]
coveragePathIgnorePatterns = "ignore-me.ts"
coverageSkipTestFiles = false
`,
    "include-me.ts": `
export function includeMe() {
  return "included";
}
`,
    "ignore-me.ts": `
export function ignoreMe() {
  return "ignored";
}
`,
    "test.test.ts": `
import { test, expect } from "bun:test";
import { includeMe } from "./include-me";
import { ignoreMe } from "./ignore-me";

test("should call both functions", () => {
  expect(includeMe()).toBe("included");
  expect(ignoreMe()).toBe("ignored");
});
`,
  });

  const result = Bun.spawnSync([bunExe(), "test", "--coverage"], {
    cwd: dir,
    env: {
      ...bunEnv,
    },
    stdio: [null, null, "pipe"],
  });

  let stderr = result.stderr.toString("utf-8");
  // Normalize output for cross-platform consistency
  stderr = normalizeBunSnapshot(stderr, dir);

  expect(stderr).toMatchInlineSnapshot(`
"test.test.ts:
(pass) should call both functions
---------------|---------|---------|-------------------
File           | % Funcs | % Lines | Uncovered Line #s
---------------|---------|---------|-------------------
All files      |  100.00 |  100.00 |
 include-me.ts |  100.00 |  100.00 | 
 test.test.ts  |  100.00 |  100.00 | 
---------------|---------|---------|-------------------

 1 pass
 0 fail
 2 expect() calls
Ran 1 test across 1 file."
`);
  expect(result.exitCode).toBe(0);
});

test("coveragePathIgnorePatterns - partial coverage without nan", () => {
  using dir = tempDir("cov", {
    "bunfig.toml": `
[test]
coveragePathIgnorePatterns = "ignore-me.ts"
coverageSkipTestFiles = false
`,
    "include-me.ts": `
export function includeMe() {
  return "included";
}

export function neverCalled() {
  return "never called";
}
`,
    "ignore-me.ts": `
export function ignoreMe() {
  return "ignored";
}
`,
    "test.test.ts": `
import { test, expect } from "bun:test";
import { includeMe } from "./include-me";
import { ignoreMe } from "./ignore-me";

test("should call only some functions", () => {
  expect(includeMe()).toBe("included");
  expect(ignoreMe()).toBe("ignored");
  // Note: neverCalled() is not called, so coverage should be partial
});
`,
  });

  const result = Bun.spawnSync([bunExe(), "test", "--coverage"], {
    cwd: dir,
    env: {
      ...bunEnv,
    },
    stdio: [null, null, "pipe"],
  });

  let stderr = result.stderr.toString("utf-8");
  // Normalize output for cross-platform consistency
  stderr = normalizeBunSnapshot(stderr, dir);

  expect(stderr).toMatchInlineSnapshot(`
"test.test.ts:
(pass) should call only some functions
---------------|---------|---------|-------------------
File           | % Funcs | % Lines | Uncovered Line #s
---------------|---------|---------|-------------------
All files      |   75.00 |   83.33 |
 include-me.ts |   50.00 |   66.67 | 6
 test.test.ts  |  100.00 |  100.00 | 
---------------|---------|---------|-------------------

 1 pass
 0 fail
 2 expect() calls
Ran 1 test across 1 file."
`);
  expect(result.exitCode).toBe(0);
});

test("coveragePathIgnorePatterns - array of patterns", () => {
  using dir = tempDir("cov", {
    "bunfig.toml": `
[test]
coveragePathIgnorePatterns = ["utils/**", "*.config.ts"]
coverageSkipTestFiles = false
`,
    "src/main.ts": `
export function main() {
  return "main";
}
`,
    "utils/helper.ts": `
export function helper() {
  return "helper";
}
`,
    "build.config.ts": `
export const config = { build: true };
`,
    "test.test.ts": `
import { test, expect } from "bun:test";
import { main } from "./src/main";
import { helper } from "./utils/helper";
import { config } from "./build.config";

test("should call all functions", () => {
  expect(main()).toBe("main");
  expect(helper()).toBe("helper");
  expect(config.build).toBe(true);
});
`,
  });

  const result = Bun.spawnSync([bunExe(), "test", "--coverage"], {
    cwd: dir,
    env: {
      ...bunEnv,
    },
    stdio: [null, null, "pipe"],
  });

  let stderr = result.stderr.toString("utf-8");
  // Normalize output for cross-platform consistency
  stderr = normalizeBunSnapshot(stderr, dir);

  expect(stderr).toMatchInlineSnapshot(`
"test.test.ts:
(pass) should call all functions
--------------|---------|---------|-------------------
File          | % Funcs | % Lines | Uncovered Line #s
--------------|---------|---------|-------------------
All files     |  100.00 |  100.00 |
 src/main.ts  |  100.00 |  100.00 | 
 test.test.ts |  100.00 |  100.00 | 
--------------|---------|---------|-------------------

 1 pass
 0 fail
 3 expect() calls
Ran 1 test across 1 file."
`);
  expect(result.exitCode).toBe(0);
});

test("coveragePathIgnorePatterns - glob patterns", () => {
  using dir = tempDir("cov", {
    "bunfig.toml": `
[test]
coveragePathIgnorePatterns = ["**/*.spec.ts", "test-utils/**"]
coverageSkipTestFiles = false
`,
    "src/feature.ts": `
export function feature() {
  return "feature";
}
`,
    "src/feature.spec.ts": `
export function featureSpec() {
  return "spec";
}
`,
    "test-utils/index.ts": `
export function testUtils() {
  return "utils";
}
`,
    "main.test.ts": `
import { test, expect } from "bun:test";
import { feature } from "./src/feature";
import { featureSpec } from "./src/feature.spec";
import { testUtils } from "./test-utils";

test("should call all functions", () => {
  expect(feature()).toBe("feature");
  expect(featureSpec()).toBe("spec");
  expect(testUtils()).toBe("utils");
});
`,
  });

  const result = Bun.spawnSync([bunExe(), "test", "--coverage"], {
    cwd: dir,
    env: {
      ...bunEnv,
    },
    stdio: [null, null, "pipe"],
  });

  let stderr = result.stderr.toString("utf-8");
  // Normalize output for cross-platform consistency
  stderr = normalizeBunSnapshot(stderr, dir);

  expect(stderr).toMatchInlineSnapshot(`
"main.test.ts:
(pass) should call all functions

src/feature.spec.ts:
----------------|---------|---------|-------------------
File            | % Funcs | % Lines | Uncovered Line #s
----------------|---------|---------|-------------------
All files       |  100.00 |  100.00 |
 main.test.ts   |  100.00 |  100.00 | 
 src/feature.ts |  100.00 |  100.00 | 
----------------|---------|---------|-------------------

 1 pass
 0 fail
 3 expect() calls
Ran 1 test across 2 files."
`);
  expect(result.exitCode).toBe(0);
});

test("coveragePathIgnorePatterns - lcov reporter", () => {
  using dir = tempDir("cov", {
    "bunfig.toml": `
[test]
coveragePathIgnorePatterns = "ignore-me.ts"
coverageSkipTestFiles = false
`,
    "include-me.ts": `
export function includeMe() {
  return "included";
}
`,
    "ignore-me.ts": `
export function ignoreMe() {
  return "ignored";
}
`,
    "test.test.ts": `
import { test, expect } from "bun:test";
import { includeMe } from "./include-me";
import { ignoreMe } from "./ignore-me";

test("should call both functions", () => {
  expect(includeMe()).toBe("included");
  expect(ignoreMe()).toBe("ignored");
});
`,
  });

  const result = Bun.spawnSync([bunExe(), "test", "--coverage", "--coverage-reporter", "lcov"], {
    cwd: dir,
    env: {
      ...bunEnv,
    },
    stdio: [null, null, "pipe"],
  });

  let lcovContent = readFileSync(path.join(dir, "coverage", "lcov.info"), "utf-8");
  // Normalize LCOV content for cross-platform consistency
  lcovContent = normalizeBunSnapshot(lcovContent, dir);

  expect(lcovContent).toMatchInlineSnapshot(`
"TN:
SF:include-me.ts
FNF:1
FNH:1
DA:2,11
DA:3,17
LF:2
LH:2
end_of_record
TN:
SF:test.test.ts
FNF:1
FNH:1
DA:2,40
DA:3,41
DA:4,39
DA:6,42
DA:7,39
DA:8,36
DA:9,2
LF:7
LH:7
end_of_record"
`);
  expect(result.exitCode).toBe(0);
});

test("coveragePathIgnorePatterns - invalid config type", () => {
  using dir = tempDir("cov", {
    "bunfig.toml": `
[test]
coveragePathIgnorePatterns = 123
coverageSkipTestFiles = false
`,
    "test.test.ts": `
import { test, expect } from "bun:test";

test("should pass", () => {
  expect(true).toBe(true);
});
`,
  });

  const result = Bun.spawnSync([bunExe(), "test", "--coverage"], {
    cwd: dir,
    env: {
      ...bunEnv,
    },
    stdio: [null, null, "pipe"],
  });

  let stderr = result.stderr.toString("utf-8");
  // Normalize error output for cross-platform consistency
  stderr = normalizeBunSnapshot(stderr, dir);

  expect(stderr).toMatchInlineSnapshot(`
"3 | coveragePathIgnorePatterns = 123
                                 ^
error: coveragePathIgnorePatterns must be a string or array of strings
    at <dir>/bunfig.toml:3:30

Invalid Bunfig: failed to load bunfig"
`);
  expect(result.exitCode).toBe(1);
});

test("coveragePathIgnorePatterns - invalid array item", () => {
  using dir = tempDir("cov", {
    "bunfig.toml": `
[test]
coveragePathIgnorePatterns = ["valid-pattern", 123]
coverageSkipTestFiles = false
`,
    "test.test.ts": `
import { test, expect } from "bun:test";

test("should pass", () => {
  expect(true).toBe(true);
});
`,
  });

  const result = Bun.spawnSync([bunExe(), "test", "--coverage"], {
    cwd: dir,
    env: {
      ...bunEnv,
    },
    stdio: [null, null, "pipe"],
  });

  let stderr = result.stderr.toString("utf-8");
  // Normalize error output for cross-platform consistency
  stderr = normalizeBunSnapshot(stderr, dir);

  expect(stderr).toMatchInlineSnapshot(`
"3 | coveragePathIgnorePatterns = ["valid-pattern", 123]
                                                   ^
error: coveragePathIgnorePatterns array must contain only strings
    at <dir>/bunfig.toml:3:48

Invalid Bunfig: failed to load bunfig"
`);
  expect(result.exitCode).toBe(1);
});

test("coveragePathIgnorePatterns - empty array", () => {
  using dir = tempDir("cov", {
    "bunfig.toml": `
[test]
coveragePathIgnorePatterns = []
coverageSkipTestFiles = false
`,
    "include-me.ts": `
export function includeMe() {
  return "included";
}
`,
    "test.test.ts": `
import { test, expect } from "bun:test";
import { includeMe } from "./include-me";

test("should call function", () => {
  expect(includeMe()).toBe("included");
});
`,
  });

  const result = Bun.spawnSync([bunExe(), "test", "--coverage"], {
    cwd: dir,
    env: {
      ...bunEnv,
    },
    stdio: [null, null, "pipe"],
  });

  let stderr = result.stderr.toString("utf-8");
  // Normalize output for cross-platform consistency
  stderr = normalizeBunSnapshot(stderr, dir);

  expect(stderr).toMatchInlineSnapshot(`
"test.test.ts:
(pass) should call function
---------------|---------|---------|-------------------
File           | % Funcs | % Lines | Uncovered Line #s
---------------|---------|---------|-------------------
All files      |  100.00 |  100.00 |
 include-me.ts |  100.00 |  100.00 | 
 test.test.ts  |  100.00 |  100.00 | 
---------------|---------|---------|-------------------

 1 pass
 0 fail
 1 expect() calls
Ran 1 test across 1 file."
`);
  expect(result.exitCode).toBe(0);
});

test("coveragePathIgnorePatterns - ignore all files", () => {
  using dir = tempDir("cov", {
    "bunfig.toml": `
[test]
coveragePathIgnorePatterns = "**"
coverageSkipTestFiles = false
`,
    "include-me.ts": `
export function includeMe() {
  return "included";
}
`,
    "test.test.ts": `
import { test, expect } from "bun:test";
import { includeMe } from "./include-me";

test("should call function", () => {
  expect(includeMe()).toBe("included");
});
`,
  });

  const result = Bun.spawnSync([bunExe(), "test", "--coverage"], {
    cwd: dir,
    env: {
      ...bunEnv,
    },
    stdio: [null, null, "pipe"],
  });

  let stderr = result.stderr.toString("utf-8");
  // Normalize output for cross-platform consistency
  stderr = normalizeBunSnapshot(stderr, dir);

  expect(stderr).toMatchInlineSnapshot(`
"test.test.ts:
(pass) should call function
-----------|---------|---------|-------------------
File       | % Funcs | % Lines | Uncovered Line #s
-----------|---------|---------|-------------------
All files  |    0.00 |    0.00 |
-----------|---------|---------|-------------------

 1 pass
 0 fail
 1 expect() calls
Ran 1 test across 1 file."
`);
  expect(result.exitCode).toBe(0);
});

// https://github.com/oven-sh/bun/issues/39930
// One worker executes count(), the other only imports the module. The
// import-only worker reports the unexecuted function's whole line range
// (blank line 5 included) as executable with zero hits. The merge must not
// let that over-approximation mark the fully executed function as
// partially covered.
test("--parallel merges line coverage across workers", async () => {
  using dir = tempDir("cov-parallel-merge", {
    "subject.ts": `await Bun.sleep(100);

export default function count(values: string[]) {
  const count = values.length;

  return count;
}
`,
    "execute.test.ts": `
import { expect, test } from "bun:test";
import count from "./subject.ts";

test("executes the function", () => {
  expect(count(["first", "second"])).toBe(2);
});
`,
    "importOnly.test.ts": `
import { expect, test } from "bun:test";
import count from "./subject.ts";

test("only imports the function", () => {
  expect(typeof count).toBe("function");
});
`,
  });
  await using proc = Bun.spawn({
    cmd: [bunExe(), "test", "--coverage", "--coverage-reporter=text", "--coverage-reporter=lcov", "--parallel=2"],
    env: bunEnv,
    cwd: String(dir),
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([proc.stderr.text(), proc.exited]);

  const lcov = readFileSync(path.join(String(dir), "coverage", "lcov.info"), "utf-8");
  const record = lcov.split("end_of_record").find(r => r.includes("SF:subject.ts"));
  expect(record).toBeDefined();
  // Blank line 5 is only "executable" in the worker that never ran count().
  expect(record).not.toContain("DA:5,");
  expect(record).toMatch(/LF:4\nLH:4\n/);

  expect(stderr).toMatch(/ subject\.ts +\| +100\.00 +\| +100\.00 +\| +\n/);
  expect(exitCode).toBe(0);
});

// https://github.com/oven-sh/bun/issues/40586
// Each worker executes a different function of the same module; the merged
// report must count a function as covered if any worker ran it.
test("--parallel merges function coverage across workers", async () => {
  // Each test file waits at import time until the other has started, so the
  // two can only make progress in two different workers.
  const rendezvous = (me: string, other: string) => `
await Bun.write("${me}.started", "");
for (const deadline = Date.now() + 60_000; !(await Bun.file("${other}.started").exists()); ) {
  if (Date.now() > deadline) throw new Error("${other} never started in another worker");
  await Bun.sleep(5);
}
`;
  using dir = tempDir("cov-parallel-fn-merge", {
    "bunfig.toml": `[test]\ncoverageSkipTestFiles = true\ncoverageThreshold = { lines = 1.0, functions = 1.0 }\n`,
    "subject.ts": `export function first() {
  return 1;
}
export function second() {
  return 2;
}
`,
    "first.test.ts": `${rendezvous("first", "second")}
import { expect, test } from "bun:test";
import { first } from "./subject.ts";

test("calls first", () => {
  expect(first()).toBe(1);
});
`,
    "second.test.ts": `${rendezvous("second", "first")}
import { expect, test } from "bun:test";
import { second } from "./subject.ts";

test("calls second", () => {
  expect(second()).toBe(2);
});
`,
  });
  await using proc = Bun.spawn({
    cmd: [bunExe(), "test", "--coverage", "--coverage-reporter=text", "--coverage-reporter=lcov", "--parallel=2"],
    env: { ...bunEnv, BUN_TEST_PARALLEL_SCALE_MS: "0" },
    cwd: String(dir),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);

  expect(stderr).toContain("2 pass");
  expect(stderr).toMatch(/ subject\.ts +\| +100\.00 +\| +100\.00 +\| +\n/);
  const lcov = readFileSync(path.join(String(dir), "coverage", "lcov.info"), "utf-8");
  const record = lcov.split("end_of_record").find(r => r.includes("SF:subject.ts"));
  expect(record).toMatch(/FNF:2\nFNH:2\n/);
  expect(exitCode).toBe(0);
});

// https://github.com/oven-sh/bun/issues/7662
// In these fixtures a line that has to be missing from the report says
// "ignored", and a line that has to be reported as never run says "uncovered".
function linesThatSay(source: string, word: string) {
  return source.split("\n").flatMap((text, index) => (text.includes(word) ? [index + 1] : []));
}

// What lcov.info says about `file`: functions hit/found, the lines with no
// hits, and the lines it lists although the source says they are ignored.
function readLcov(dir: string, file: string, source: string) {
  const lcov = readFileSync(path.join(dir, "coverage", "lcov.info"), "utf-8");
  const record = lcov.split("end_of_record").find(record => record.includes(`SF:${file}\n`));
  if (!record) return undefined;
  const lines = [...record.matchAll(/^DA:(\d+),(\d+)$/gm)].map(match => [Number(match[1]), Number(match[2])]);
  const ignored = linesThatSay(source, "ignored");
  return {
    functions: `${/^FNH:(\d+)$/m.exec(record)![1]}/${/^FNF:(\d+)$/m.exec(record)![1]}`,
    uncovered: lines.filter(([, hits]) => hits === 0).map(([line]) => line),
    ignoredButListed: lines.map(([line]) => line).filter(line => ignored.includes(line)),
  };
}

const ignoreHintFixtures = {
  "bunfig.toml": `[test]\ncoverageSkipTestFiles = true\n`,
  "lines.ts": `export function run(flag: boolean) {
  if (flag) {
    /* v8 ignore next */
    console.log("ignored");
    console.log("uncovered");
  }
  if (flag) {
    // c8 ignore next 2
    console.log("ignored");
    console.log("ignored");
    console.log("uncovered");
  }
  if (flag) {
    console.log("ignored: the hint is after code"); /* istanbul ignore next */
    console.log("uncovered");
  }
  /* node:coverage disable */
  if (flag) { // ignored
    console.log("ignored");
  } // ignored
  /* node:coverage enable */
  /** v8 ignore start -- a reason, or @preserve for other tools */
  if (flag) { // ignored
    console.log("ignored");
  } // ignored
  /* v8 ignore stop */
  if (flag) {
    /* node:coverage ignore next 1 */
    console.log("ignored");
    console.log("uncovered");
  }
  if (flag) {
    /* istanbul ignore next: with a reason */
    console.log("ignored");
    console.log("ignored: after a string with // in it", "http://host/*"); // v8 ignore next
    console.log("uncovered");
  }
  return "done";
}
`,
  // A function that starts on an ignored line is ignored with its body and
  // with the functions inside it, whether it ran (debug) or not.
  "functions.ts": `export class Shape {
  sides: number;
  constructor() {
    this.sides = 4;
  }
  area() {
    return this.sides;
  }
  /* v8 ignore next */
  debug() { // ignored
    const inner = () => { // ignored
      return "ignored";
    }; // ignored
    return inner(); // ignored
  }
  // The first token of these has no source mapping of its own. Each is
  // followed by a method that is not ignored and has to stay in the report.
  get corners() {
    return this.sides;
  }
  /* v8 ignore next */
  async ignoredAsync() {
    return "ignored";
  }
  get edges() {
    return this.sides;
  }
  /* v8 ignore next */
  static async *ignoredGenerator() {
    yield "ignored";
  }
  set edges(value: number) {
    this.sides = value;
  }
  /* v8 ignore next */
  get ignoredGetter() {
    return "ignored";
  }
  ["computed"]() {
    return this.sides;
  }
  /* v8 ignore next */
  ["ignoredComputed"]() {
    return "ignored";
  }
  perimeter() {
    return this.sides;
  }
}

// c8 ignore next
export const ignoredArrow = (x: number) => {
  return "ignored" + x;
};

/* istanbul ignore next */
export function ignoredDeclaration() {
  return "ignored";
}
`,
  // A function at the very start of the transpiled code.
  "first-statement.ts": `/* v8 ignore next */
function ignoredHelper() {
  return "ignored";
}
export function used() {
  return 1;
}
`,
  // JSC lists a module without functions as one function. It does not start
  // on line 2, and the hint must not take the whole file with it.
  "no-functions.ts": `/* v8 ignore next */
export const a = process.env.NEVER_SET_BY_ANYONE ?? "ignored";
export const b = 1;
export const c = b + 1;
`,
  // The function that wraps a CommonJS module has no line of its own: it
  // must not count as starting on line 2 and take the whole file with it.
  "commonjs.cjs": `/* v8 ignore next */
const optional = process.env.NEVER_SET_BY_ANYONE ? require("./never") : "ignored";
function used(flag) {
  if (flag) {
    return "uncovered";
  }
  return "used";
}
module.exports = { used, optional };
`,
  "crlf.js": `export function crlf(flag) {\r\n  if (flag) {\r\n    /* v8 ignore next */\r\n    console.log("ignored");\r\n    console.log("uncovered");\r\n  }\r\n  return 1;\r\n}\r\n`,
  "not-hints.ts": `export function notHints(flag: boolean) {
  if (flag) {
    /* v8 ignore if */
    console.log("uncovered");
    /* v8 ignores next */
    console.log("uncovered");
    /* eslint-disable-next-line -- v8 ignore next */
    console.log("uncovered");
    /* v8 ignore next
     */
    console.log("uncovered");
    /* v8 ignore stop */
    console.log("uncovered");
  }
  return 1;
}
`,
  "unterminated.ts": `export function first() {
  return 1;
}
/* v8 ignore start */
export function second() {
  return "ignored";
}
`,
  "whole-file.ts": `// A header comment.
/* istanbul ignore file */
export function a() {
  return 1;
}
export function b() {
  return 2;
}
`,
  "hints.test.ts": `
import { expect, test } from "bun:test";
import { run } from "./lines";
import { Shape } from "./functions";
import { used } from "./commonjs.cjs";
import { crlf } from "./crlf.js";
import { notHints } from "./not-hints";
import { first } from "./unterminated";
import { a } from "./whole-file";
import { used as usedAfterHelper } from "./first-statement";
import { c } from "./no-functions";

test("runs some of it", () => {
  expect(run(false)).toBe("done");
  const shape = new Shape();
  expect(shape.area()).toBe(4);
  expect(shape.debug()).toBe("ignored");
  shape.edges = 4;
  expect([shape.corners, shape.edges, shape.computed(), shape.perimeter()]).toEqual([4, 4, 4, 4]);
  expect(usedAfterHelper()).toBe(1);
  expect(c).toBe(2);
  expect(used(false)).toBe("used");
  expect(crlf(false)).toBe(1);
  expect(notHints(false)).toBe(1);
  expect(first()).toBe(1);
  expect(a()).toBe(1);
});
`,
  // A second file, so that --parallel has something to hand to a worker.
  "more.test.ts": `
import { expect, test } from "bun:test";
import { run } from "./lines";

test("runs it again", () => {
  expect(run(false)).toBe("done");
});
`,
};

test.concurrent.each([
  ["in one process", []],
  ["in --parallel workers", ["--parallel=2"]],
])("coverage ignore hints %s", async (_, flags) => {
  using dir = tempDir("cov-ignore-hints", ignoreHintFixtures);
  await using proc = Bun.spawn({
    cmd: [bunExe(), "test", "--coverage", "--coverage-reporter=text", "--coverage-reporter=lcov", ...flags],
    // Start both workers at once instead of when the first one is busy.
    env: { ...bunEnv, BUN_TEST_PARALLEL_SCALE_MS: "0" },
    cwd: String(dir),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);

  expect(stderr).toContain("2 pass");
  const functions = {
    "lines.ts": "1/1",
    // The constructor, area, corners, both edges, computed and perimeter.
    "functions.ts": "7/7",
    "first-statement.ts": "1/1",
    "commonjs.cjs": "2/2",
    "crlf.js": "1/1",
    "not-hints.ts": "1/1",
    "unterminated.ts": "1/1",
  };
  for (const [file, expected] of Object.entries(functions)) {
    const source = ignoreHintFixtures[file as keyof typeof ignoreHintFixtures];
    expect({ file, ...readLcov(String(dir), file, source) }).toEqual({
      file,
      functions: expected,
      uncovered: linesThatSay(source, "uncovered"),
      ignoredButListed: [],
    });
  }
  expect(readLcov(String(dir), "whole-file.ts", "")).toBeUndefined();
  // Line 2 is gone, lines 3 and 4 are still there.
  expect(readLcov(String(dir), "no-functions.ts", ignoreHintFixtures["no-functions.ts"])).toMatchObject({
    uncovered: [],
    ignoredButListed: [],
  });
  expect(stderr).toMatch(/ no-functions\.ts +\| +\d+\.\d+ +\| +100\.00 +\| *\n/);
  expect(stderr).toMatch(/ lines\.ts +\| +100\.00 +\| +\d+\.\d+ +\| 5,11,15,30,36\n/);
  expect(stderr).not.toContain("whole-file.ts");
  expect(exitCode).toBe(0);
});

test.concurrent("coverage ignore hints count towards coverageThreshold", async () => {
  const source = (hint: string) => `export function parse(input: string) {
  ${hint}
  if (typeof input !== "string") {
    throw new TypeError("never happens in the tests");
  }
  return input.trim();
}
`;
  const files = (hint: string) => ({
    "bunfig.toml": `[test]\ncoverageSkipTestFiles = true\ncoverageThreshold = 1.0\n`,
    "parse.ts": source(hint),
    "parse.test.ts": `
import { expect, test } from "bun:test";
import { parse } from "./parse";

test("parse", () => {
  expect(parse(" a ")).toBe("a");
});
`,
  });
  using without = tempDir("cov-ignore-threshold", files("// no hint here"));
  using withHint = tempDir("cov-ignore-threshold", files("/* v8 ignore next 3 */"));
  const run = async (cwd: string) => {
    await using proc = Bun.spawn({
      cmd: [bunExe(), "test", "--coverage"],
      env: bunEnv,
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    return { row: / parse\.ts +\|[^\n]*/.exec(stderr)?.[0].replace(/ +/g, " "), exitCode };
  };
  expect(await Promise.all([run(String(without)), run(String(withHint))])).toEqual([
    { row: " parse.ts | 100.00 | 80.00 | 4", exitCode: 1 },
    { row: " parse.ts | 100.00 | 100.00 | ", exitCode: 0 },
  ]);
});
