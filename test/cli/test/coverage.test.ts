import { beforeAll, describe, expect, test } from "bun:test";
import { bunEnv, bunExe, isWindows, normalizeBunSnapshot, tempDir } from "harness";
import { readFileSync, symlinkSync } from "node:fs";
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

// https://github.com/oven-sh/bun/issues/17502
describe("--coverage-reporter without --coverage turns coverage on", () => {
  const files = {
    "math.ts": `export function add(a: number, b: number) {
  return a + b;
}
export function sub(a: number, b: number) {
  return a - b;
}
`,
    "add.test.ts": `import { expect, test } from "bun:test";
import { add } from "./math";
test("add", () => {
  expect(add(1, 2)).toBe(3);
});
`,
    "sub.test.ts": `import { expect, test } from "bun:test";
import { sub } from "./math";
test("sub", () => {
  expect(sub(3, 2)).toBe(1);
});
`,
  };
  const cases = [
    { flags: ["--coverage-reporter=lcov"], lcov: true, table: false },
    { flags: ["--coverage-reporter", "lcov"], lcov: true, table: false },
    { flags: ["--coverage-reporter=text"], lcov: false, table: true },
    { flags: ["--coverage-reporter=text", "--coverage-reporter=lcov"], lcov: true, table: true },
    { flags: ["--coverage-reporter=lcov", "--parallel=2"], lcov: true, table: false },
  ];

  test.concurrent.each(cases.map(c => [c.flags.join(" "), c] as const))(
    "bun test %s",
    async (_, { flags, lcov, table }) => {
      using dir = tempDir("cov-reporter-alone", files);
      await using proc = Bun.spawn({
        cmd: [bunExe(), "test", ...flags],
        env: bunEnv,
        cwd: String(dir),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      const report = Bun.file(path.join(String(dir), "coverage", "lcov.info"));
      expect({
        lcov: (await report.exists()) && (await report.text()).includes("SF:math.ts"),
        table: / math\.ts +\| +100\.00 +\| +100\.00 +\|/.test(stderr),
        exitCode,
      }).toEqual({ lcov, table, exitCode: 0 });
    },
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

// JSC records coverage per SourceProvider, and a file has one for each time
// it is loaded. Each case has a subject file of its own. Where a case loads
// its subject twice, one load runs the `if` branch and the other runs the
// `return` after it.
describe("a file loaded more than once counts every load", () => {
  const esm = `export function covered(n: number): number {
  if (n > 5) {
    return n * 2;
  }
  return n + 1;
}
`;
  const cjs = `exports.covered = function covered(n) {
  if (n > 5) {
    return n * 2;
  }
  return n + 1;
};
`;
  const compiledText =
    Buffer.alloc(12, "\n").toString() +
    "exports.other = function other(n) {\n  if (n > 5) {\n    return 1;\n  }\n  return 2;\n};\nexports.other(1);\n";

  const files = {
    "host-and-graph.ts": esm,
    "two-graphs.ts": esm,
    "cjs-host-and-graph.cjs": cjs,
    "query-strings.ts": esm,
    "overlapping-imports.ts": esm,
    "require-cache.cjs": cjs,
    // https://github.com/oven-sh/bun/issues/35345
    "issue-35345.ts": `export const MODULE_SCOPE = "evaluated";

export function fnA(x: number): number {
  const a = x + 1;
  return a * 2;
}

export function fnB(x: number): number {
  const b = x + 10;
  return b * 3;
}
`,
    "functions.ts": `export function first() {
  return 1;
}
export function second() {
  return 2;
}
export function third() {
  return 3;
}
`,
    "cjs-graph-alone.cjs": cjs,
    "compile-target.cjs": cjs,
    "compile.cjs": `
const Module = require("node:module");
exports.compileAs = (filename, text) => {
  const module = new Module(filename);
  module.filename = filename;
  module._compile(text, filename);
  return module.exports;
};
`,
    // With ONE_LOAD=1 the last three cases leave out the load under test, to compare against.
    "loads.test.ts": `
import { expect, test } from "bun:test";
import { codeCoverageForFile } from "bun:jsc";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { covered as hostAndGraph } from "./host-and-graph.ts";
import { first } from "./functions.ts";
const cjsHostAndGraph = require("./cjs-host-and-graph.cjs");
const compileTarget = require("./compile-target.cjs");

const oneLoad = !!process.env.ONE_LOAD;
// codeCoverageForFile() takes the path as the module loader spells it.
const here = name => join(import.meta.dir, name);

test("host-and-graph.ts", async () => {
  expect(hostAndGraph(1)).toBe(2);
  const hostAlone = codeCoverageForFile(here("host-and-graph.ts"), false);
  using graph = new Bun.ModuleGraph({});
  const subject = await graph.import(here("host-and-graph.ts"));
  expect(graph.run(() => subject.covered(10))).toBe(20);
  console.log(JSON.stringify({ hostAlone, both: codeCoverageForFile(here("host-and-graph.ts"), false) }));
  expect(() => codeCoverageForFile(here("never-loaded.ts"), false)).toThrow("No source for file");
});

test("two-graphs.ts", async () => {
  using a = new Bun.ModuleGraph({});
  using b = new Bun.ModuleGraph({});
  const inA = await a.import(here("two-graphs.ts"));
  const inB = await b.import(here("two-graphs.ts"));
  expect(a.run(() => inA.covered(10))).toBe(20);
  expect(b.run(() => inB.covered(1))).toBe(2);
});

test("cjs-host-and-graph.cjs", async () => {
  expect(cjsHostAndGraph.covered(1)).toBe(2);
  using graph = new Bun.ModuleGraph({});
  const subject = await graph.import(here("cjs-host-and-graph.cjs"));
  expect(graph.run(() => subject.covered(10))).toBe(20);
});

test("query-strings.ts", async () => {
  const a = await import("./query-strings.ts?a");
  const b = await import("./query-strings.ts?b");
  expect(a.covered).not.toBe(b.covered);
  expect(a.covered(10)).toBe(20);
  expect(b.covered(1)).toBe(2);
});

test("overlapping-imports.ts", async () => {
  const [a, b] = await Promise.all([import("./overlapping-imports.ts"), import("./overlapping-imports.ts")]);
  expect(a).toBe(b);
  expect(a.covered(10)).toBe(20);
  expect(b.covered(1)).toBe(2);
});

test("issue-35345.ts", async () => {
  const first = await import("./issue-35345.ts?bun-spec=1");
  expect(first.fnA(1)).toBe(4);
  const second = await import("./issue-35345.ts?bun-spec=2");
  expect(second.fnB(1)).toBe(33);
});

test("require-cache.cjs", () => {
  const a = require("./require-cache.cjs");
  delete require.cache[require.resolve("./require-cache.cjs")];
  const b = require("./require-cache.cjs");
  expect(a.covered).not.toBe(b.covered);
  expect(a.covered(10)).toBe(20);
  expect(b.covered(1)).toBe(2);
});

test("functions.ts", async () => {
  expect(first()).toBe(1);
  using graph = new Bun.ModuleGraph({});
  const subject = await graph.import(here("functions.ts"));
  expect(graph.run(() => subject.second())).toBe(2);
});

test("cjs-graph-alone.cjs", async () => {
  if (oneLoad) {
    expect(require("./cjs-graph-alone.cjs").covered(10)).toBe(20);
    return;
  }
  using graph = new Bun.ModuleGraph({});
  const subject = await graph.import(here("cjs-graph-alone.cjs"));
  expect(graph.run(() => subject.covered(10))).toBe(20);
});

test("compile-target.cjs", async () => {
  expect(compileTarget.covered(1)).toBe(2);
  if (oneLoad) return;
  using graph = new Bun.ModuleGraph({});
  const { compileAs } = await graph.import(here("compile.cjs"));
  const compiled = graph.run(() => compileAs(here("compile-target.cjs"), ${JSON.stringify(compiledText)}));
  expect(compiled.other(10)).toBe(1);
});

test("changed.ts", async () => {
  if (!oneLoad) {
    writeFileSync(here("changed.ts"), ${JSON.stringify(esm)});
    const before = await import("./changed.ts?before");
    expect(before.covered(10)).toBe(20);
  }
  writeFileSync(here("changed.ts"), ${JSON.stringify("export function unused() {\n  return 0;\n}\n" + esm)});
  const after = await import("./changed.ts?after");
  expect(after.covered(1)).toBe(2);
});
`,
  };

  // A plugin's onLoad result gets a new SourceProvider for every load, under --isolate too.
  // https://github.com/oven-sh/bun/issues/40386
  const pluginFiles = {
    "bunfig.toml": `[test]\npreload = ["./plugin.ts"]\n`,
    "plugin.ts": `
import { plugin } from "bun";

plugin({
  name: "passthrough",
  setup(build) {
    build.onLoad({ filter: /plugin-loaded\\.ts$/ }, async ({ path }) => {
      return { contents: await Bun.file(path).text(), loader: "ts" };
    });
  },
});
`,
    "plugin-loaded.ts": esm,
    "a.test.ts": `
import { expect, test } from "bun:test";
import { covered } from "./plugin-loaded.ts";

test("a", () => {
  expect(covered(10)).toBe(20);
});
`,
    "b.test.ts": `
import { expect, test } from "bun:test";
import { covered } from "./plugin-loaded.ts";

test("b", () => {
  expect(covered(1)).toBe(2);
});
`,
  };

  type Row = { functions: string; lines: string; uncovered: string };
  async function run(fixture: Record<string, string>, args: string[], env: Record<string, string> = {}) {
    using dir = tempDir("cov-loaded-twice", fixture);
    await using proc = Bun.spawn({
      cmd: [bunExe(), "test", "--coverage", "--coverage-reporter=text", "--coverage-reporter=lcov", ...args],
      env: { ...bunEnv, ...env },
      cwd: String(dir),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    if (exitCode !== 0) throw new Error(stderr);
    const rows: Record<string, Row> = {};
    for (const line of stderr.split("\n")) {
      const [file, functions, lines, uncovered] = line.split("|").map(column => column.trim());
      if (uncovered !== undefined) rows[file] = { functions, lines, uncovered };
    }
    const lcov: Record<string, string> = {};
    for (const record of readFileSync(path.join(String(dir), "coverage", "lcov.info"), "utf-8").split(
      "end_of_record",
    )) {
      const file = record.match(/^SF:(.+)$/m)?.[1];
      if (file) lcov[file] = record;
    }
    return { rows, lcov, stdout };
  }

  let loaded: Awaited<ReturnType<typeof run>>;
  let oneLoad: Awaited<ReturnType<typeof run>>;
  let pluginUnderIsolate: Awaited<ReturnType<typeof run>>;
  beforeAll(async () => {
    [loaded, oneLoad, pluginUnderIsolate] = await Promise.all([
      run(files, ["./loads.test.ts"]),
      run(files, ["./loads.test.ts"], { ONE_LOAD: "1" }),
      run(pluginFiles, ["--isolate", "./a.test.ts", "./b.test.ts"]),
    ]);
  });

  const fullyCovered: Row = { functions: "100.00", lines: "100.00", uncovered: "" };

  describe.each([
    ["by the host and by a Bun.ModuleGraph", "host-and-graph.ts"],
    ["by two Bun.ModuleGraphs", "two-graphs.ts"],
    ["CommonJS, by the host and by a Bun.ModuleGraph", "cjs-host-and-graph.cjs"],
    ["under two query strings", "query-strings.ts"],
    ["by two overlapping import()s", "overlapping-imports.ts"],
    ["again after a require.cache delete", "require-cache.cjs"],
  ])("%s", (_, file) => {
    test("is fully covered", () => {
      expect(loaded.rows[file]).toEqual(fullyCovered);
    });
  });

  test("from a plugin's onLoad, by two test files under --isolate", () => {
    expect(pluginUnderIsolate.rows["plugin-loaded.ts"]).toEqual(fullyCovered);
  });

  test("lcov has the functions and the lines of both loads (#35345)", () => {
    expect(loaded.lcov["issue-35345.ts"]).toMatch(/FNF:2\nFNH:2\n/);
    expect(loaded.lcov["issue-35345.ts"]).not.toMatch(/DA:\d+,0\n/);
  });

  test("a function counts if any load ran it, and not if none did", () => {
    // The host runs first(), a graph runs second(). third() spans lines 7 to 9.
    expect(loaded.rows["functions.ts"]).toEqual({
      functions: "66.67",
      lines: expect.any(String),
      uncovered: expect.stringMatching(/^[789](-[89])?$/),
    });
  });

  test("CommonJS, by a Bun.ModuleGraph alone, reports what the host alone reports", () => {
    expect(oneLoad.rows["cjs-graph-alone.cjs"].uncovered).not.toBe("");
    expect(loaded.rows["cjs-graph-alone.cjs"]).toEqual(oneLoad.rows["cjs-graph-alone.cjs"]);
  });

  // module._compile() names a file and brings a text of its own, which no
  // line table describes. In a graph it runs under a wrapping SourceProvider,
  // like the graph's load of the file itself, and must not count as one.
  test("module._compile() in a Bun.ModuleGraph does not count as a load of the file it names", () => {
    expect(oneLoad.rows["compile-target.cjs"].uncovered).not.toBe("");
    expect(loaded.rows["compile-target.cjs"]).toEqual(oneLoad.rows["compile-target.cjs"]);
  });

  // The line table and the source map on record describe one text, so a load
  // of another text starts the file's coverage over.
  test("a file that changed between two loads reports the last text alone", () => {
    expect(oneLoad.rows["changed.ts"].functions).toBe("50.00");
    expect(loaded.rows["changed.ts"]).toEqual(oneLoad.rows["changed.ts"]);
  });

  test("bun:jsc codeCoverageForFile()", () => {
    expect(JSON.parse(loaded.stdout.split("\n").find(line => line.startsWith("{"))!)).toEqual({
      hostAlone: expect.stringMatching(/host-and-graph\.ts \| +100\.00 \| +\d+\.\d+ \| \d/),
      both: expect.stringMatching(/host-and-graph\.ts \| +100\.00 \| +100\.00 \| $/),
    });
  });
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

// https://github.com/oven-sh/bun/issues/5928
describe("collectCoverageFrom", () => {
  // The table in stderr, one entry per row: `file | % Funcs | % Lines | Uncovered Line #s`.
  function tableRows(stderr: string) {
    return stderr
      .split("\n")
      .filter(line => line.startsWith(" ") && line.split("|").length === 4)
      .map(line =>
        line
          .replaceAll("\\", "/")
          .split("|")
          .map(cell => cell.trim())
          .join(" | ")
          .trimEnd(),
      );
  }

  // lcov.info by file: functions hit/found, lines hit/found and the lines it lists.
  function lcovRecords(dir: string) {
    const records: Record<string, { functions: string; lines: string; listed: number[] }> = {};
    const lcov = readFileSync(path.join(dir, "coverage", "lcov.info"), "utf-8");
    for (const record of lcov.split("end_of_record")) {
      const file = /^SF:(.*)$/m.exec(record)?.[1];
      if (!file) continue;
      const count = (key: string) => new RegExp(`^${key}:(\\d+)$`, "m").exec(record)![1];
      records[file.replaceAll("\\", "/")] = {
        functions: `${count("FNH")}/${count("FNF")}`,
        lines: `${count("LH")}/${count("LF")}`,
        listed: [...record.matchAll(/^DA:(\d+),\d+$/gm)].map(match => Number(match[1])),
      };
    }
    return records;
  }

  async function run(cwd: string, ...args: string[]) {
    await using proc = Bun.spawn({
      cmd: [bunExe(), "test", ...args],
      // Start both workers at once instead of when the first one is busy.
      env: { ...bunEnv, BUN_TEST_PARALLEL_SCALE_MS: "0" },
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    return { stdout, stderr, exitCode, rows: tableRows(stderr) };
  }

  const lcovFlags = ["--coverage", "--coverage-reporter=text", "--coverage-reporter=lcov"];

  const unused = `// Nothing imports this file.
import { used } from "./used";

export interface Shape {
  sides: number;
}

export function first(shape: Shape) {
  // A comment and an empty line in a function that never runs.

  return shape.sides + used();
}

export const second = () => {
  return 2;
};
`;
  const unusedRow = "src/unused.ts | 0.00 | 0.00 | 2,8,11,14-15";

  const project = {
    "bunfig.toml": `[test]
coverageSkipTestFiles = true
collectCoverageFrom = ["./src/**", "!src/generated/**"]
`,
    "src/used.ts": `export function used() {
  return 1;
}
export function notCalled() {
  return 2;
}
`,
    "src/unused.ts": unused,
    "src/unused.cjs": `function first() {
  return 1;
}
module.exports = { first };
`,
    "src/constants.ts": `export const one = 1;
export const two = one + 1;
`,
    "src/view.tsx": `export function View() {
  return <div>never rendered</div>;
}
`,
    // Nothing in these can run, so there is nothing to cover.
    "src/types.ts": `export interface OnlyTypes {
  name: string;
}
export type Maybe = OnlyTypes | null;
`,
    "src/augments.ts": `declare global {
  var fromSomewhere: number;
}
export {};
`,
    // Left out for its name: what is in it would have a row.
    "src/globals.d.ts": `export const notADeclaration = 1;\n`,
    "src/empty.ts": ``,
    "src/comments.ts": `// Only a comment.\n/* And another one. */\n`,
    // A file that nothing loads must not run because the report names it.
    "src/exits.ts": `console.log("a file that nothing loaded ran");
process.exit(3);
`,
    "src/does-not-parse.ts": `export function fine() {
  return 1;
}
export function broken( {
`,
    "src/calls-a-macro.ts": `import { macro } from "./used" with { type: "macro" };
export const value = macro();
`,
    "src/generated/out.ts": `export function generated() {
  return 1;
}
`,
    "src/node_modules/dependency/index.js": `export function dependency() {
  return 1;
}
`,
    "src/not-run.test.ts": `import { test } from "bun:test";
test("is not run", () => {});
`,
    "lib/outside.ts": `export function outside() {
  return 1;
}
`,
    "a.test.ts": `import { expect, test } from "bun:test";
import { outside } from "./lib/outside";
import { used } from "./src/used";

test("a", () => {
  expect(used() + outside()).toBe(2);
});
test("another", () => {});
`,
    "b.test.ts": `import { expect, test } from "bun:test";
import { used } from "./src/used";

test("b", () => {
  expect(used()).toBe(1);
});
`,
  };

  test.concurrent.each([
    ["in one process", []],
    ["with --isolate", ["--isolate"]],
    ["with --parallel", ["--parallel=2"]],
  ])("reports the files that nothing loaded %s", async (_, flags) => {
    using dir = tempDir("cov-collect-from", project);
    const { stdout, stderr, exitCode, rows } = await run(String(dir), "a.test.ts", "b.test.ts", ...lcovFlags, ...flags);

    expect(stderr).toContain("3 pass");
    // Not in it: lib/outside.ts, which is loaded and which the list does not
    // name, and what is in src/generated, in node_modules and in a test file.
    expect(rows).toEqual([
      "src/constants.ts | 0.00 | 0.00 | 1-2",
      "src/exits.ts | 0.00 | 0.00 | 1-2",
      "src/unused.cjs | 0.00 | 0.00 | 1-2,4",
      unusedRow,
      "src/used.ts | 50.00 | 66.67 | 4",
      "src/view.tsx | 0.00 | 0.00 | 1-2",
    ]);
    const records = lcovRecords(String(dir));
    expect(records).toEqual({
      // A module without functions counts as one, as it does when it is loaded.
      "src/constants.ts": { functions: "0/1", lines: "0/2", listed: [1, 2] },
      "src/exits.ts": { functions: "0/1", lines: "0/2", listed: [1, 2] },
      // The function Bun wraps a CommonJS module in counts too.
      "src/unused.cjs": { functions: "0/2", lines: "0/3", listed: [1, 2, 4] },
      "src/unused.ts": { functions: "0/2", lines: "0/5", listed: [2, 8, 11, 14, 15] },
      "src/used.ts": { functions: "1/2", lines: "2/3", listed: [1, 2, 4] },
      "src/view.tsx": { functions: "0/1", lines: "0/2", listed: [1, 2] },
    });
    // One line each, in the order of the paths, and then the table.
    expect(stderr).toContain(
      `warn: Failed to collect coverage from ${path.join("src", "calls-a-macro.ts")}:2:22: Macros are disabled\n` +
        `warn: Failed to collect coverage from ${path.join("src", "does-not-parse.ts")}:4:26: Expected identifier but found end of file\n` +
        "---",
    );
    expect(stderr.match(/warn:/g)).toHaveLength(2);
    expect(stdout).not.toContain("a file that nothing loaded ran");
    expect(exitCode).toBe(0);
  });

  test.concurrent("--collect-coverage-from replaces the list in bunfig.toml", async () => {
    using dir = tempDir("cov-collect-from", project);
    const [repeated, once, withoutCoverage] = await Promise.all([
      run(
        String(dir),
        "a.test.ts",
        "--coverage",
        "--collect-coverage-from",
        // A glob walk cannot follow a "/" in braces. The files are found all the same.
        "{src/generated,lib}/**",
        "--collect-coverage-from=lib/*.ts",
      ),
      run(String(dir), "a.test.ts", "--coverage", "--collect-coverage-from=src/u*.ts"),
      // The list asks for nothing by itself.
      run(String(dir), "a.test.ts", "--collect-coverage-from=src/u*.ts"),
    ]);
    expect({
      repeated: repeated.rows,
      once: once.rows,
      withoutCoverage: withoutCoverage.rows,
    }).toEqual({
      repeated: ["lib/outside.ts | 100.00 | 100.00 |", "src/generated/out.ts | 0.00 | 0.00 | 1-2"],
      once: [unusedRow, "src/used.ts | 50.00 | 66.67 | 4"],
      withoutCoverage: [],
    });
    expect(withoutCoverage.stderr).toContain("2 pass");
    expect(withoutCoverage.stderr).not.toContain("warn:");
    expect([repeated.exitCode, once.exitCode, withoutCoverage.exitCode]).toEqual([0, 0, 0]);
  });

  test.concurrent.each([
    ["with --parallel", ["--parallel=2"]],
    // One test file: --parallel runs it in this process.
    ["with --parallel and one test file", ["--parallel=2", "a.test.ts"]],
  ])("reads the list of --config %s", async (_, flags) => {
    using dir = tempDir("cov-collect-from", {
      ...project,
      "bunfig.toml": `[test]\ncoverageSkipTestFiles = true\n`,
      "other.toml": `[test]\ncoverageSkipTestFiles = true\ncollectCoverageFrom = "src/*.cjs"\n`,
    });
    const { rows, exitCode } = await run(String(dir), "--coverage", "--config=other.toml", ...flags);
    expect(rows).toEqual(["src/unused.cjs | 0.00 | 0.00 | 1-2,4"]);
    expect(exitCode).toBe(0);
  });

  test.concurrent("the last pattern that matches decides", async () => {
    using dir = tempDir("cov-collect-from", {
      "bunfig.toml": `[test]\ncoverageSkipTestFiles = true\n`,
      "src/a.ts": `export const a = 1;\n`,
      "src/generated/b.ts": `export const b = 1;\n`,
      "src/generated/kept.ts": `export const kept = 1;\n`,
      "tools/c.ts": `export const c = 1;\n`,
      "only.test.ts": `import { test } from "bun:test";\ntest("loads nothing", () => {});\n`,
    });
    const list = (...patterns: string[]) =>
      run(String(dir), "--coverage", ...patterns.map(pattern => `--collect-coverage-from=${pattern}`));
    const [included, excluded, negated] = await Promise.all([
      list("src/**", "!src/generated/**", "src/generated/kept.ts"),
      list("src/generated/kept.ts", "src/a.ts", "!src/generated/**"),
      // Every file that none of them names.
      list("!src/generated/**", "!**/a.ts"),
    ]);
    expect({
      included: included.rows,
      excluded: excluded.rows,
      negated: negated.rows,
    }).toEqual({
      included: ["src/a.ts | 0.00 | 0.00 | 1", "src/generated/kept.ts | 0.00 | 0.00 | 1"],
      excluded: ["src/a.ts | 0.00 | 0.00 | 1"],
      negated: ["tools/c.ts | 0.00 | 0.00 | 1"],
    });
  });

  test.concurrent("coveragePathIgnorePatterns applies to the files that nothing loaded", async () => {
    using dir = tempDir("cov-collect-from", {
      ...project,
      "bunfig.toml": `[test]
coverageSkipTestFiles = false
collectCoverageFrom = "src/*.ts"
coveragePathIgnorePatterns = ["src/u*", "src/does-not-parse.ts", "**/calls-a-macro.ts", "**/exits.ts"]
`,
    });
    const { rows, stderr, exitCode } = await run(String(dir), "a.test.ts", "--coverage");
    // With coverageSkipTestFiles off, a test file that did not run is a file that nothing loaded.
    expect(rows).toEqual(["src/constants.ts | 0.00 | 0.00 | 1-2", "src/not-run.test.ts | 0.00 | 0.00 | 1-2"]);
    expect(stderr).not.toContain("warn:");
    expect(exitCode).toBe(0);
  });

  test.concurrent("a file that nothing loaded counts towards coverageThreshold", async () => {
    using dir = tempDir("cov-collect-from", {
      "bunfig.toml": `[test]
coverageSkipTestFiles = true
coverageThreshold = 0.6
collectCoverageFrom = ["src/**"]
`,
      "src/used.ts": project["src/used.ts"],
      "src/unused.ts": unused,
      "a.test.ts": `import { expect, test } from "bun:test";
import { notCalled, used } from "./src/used";

test("a", () => {
  expect(used() + notCalled()).toBe(3);
});
`,
    });
    const { rows, stderr, exitCode } = await run(String(dir), "--coverage");
    expect(stderr).toContain("1 pass");
    expect(rows).toEqual([unusedRow, "src/used.ts | 100.00 | 100.00 |"]);
    expect(exitCode).toBe(1);
  });

  test.concurrent("a run has to run a test file to report the files that nothing loaded", async () => {
    using dir = tempDir("cov-collect-from", {
      "bunfig.toml": `[test]
coverageSkipTestFiles = true
collectCoverageFrom = ["src/**"]
coverageThreshold = 0.9
`,
      "src/unused.ts": unused,
      "only.test.ts": `import { test } from "bun:test";\ntest("one", () => {});\ntest("two", () => {});\n`,
    });
    const [emptyShard, someTests] = await Promise.all([
      run(String(dir), "--coverage", "--shard=2/2"),
      // The test file loads no file of the list. It has a report all the same.
      run(String(dir), ...lcovFlags, "-t", "one"),
    ]);
    expect({ rows: emptyShard.rows, exitCode: emptyShard.exitCode }).toEqual({ rows: [], exitCode: 0 });
    expect({ rows: someTests.rows, exitCode: someTests.exitCode }).toEqual({ rows: [unusedRow], exitCode: 1 });
    expect(lcovRecords(String(dir))).toEqual({
      "src/unused.ts": { functions: "0/2", lines: "0/5", listed: [2, 8, 11, 14, 15] },
    });
  });

  test.concurrent("a file has one row, and a test that changes directory moves nothing", async () => {
    using dir = tempDir("cov-collect-from", {
      "bunfig.toml": `[test]\ncoverageSkipTestFiles = true\ncollectCoverageFrom = ["src/**", "shared/**"]\n`,
      "shared/loaded.ts": project["src/used.ts"],
      "shared/unused.ts": `export const unused = 1;\n`,
      "src/index.ts": isWindows
        ? `export { used } from "../shared/loaded";\n`
        : `export { used } from "./linked/loaded";\n`,
      // Relative to the directory the test changes to, "src/**" is this file.
      "elsewhere/src/decoy.ts": `export const decoy = 1;\n`,
      "a.test.ts": `import { expect, test } from "bun:test";
import { used } from "./src/index";

test("a", () => {
  process.chdir("elsewhere");
  expect(used()).toBe(1);
});
`,
    });
    if (!isWindows) {
      // shared/loaded.ts through a directory, which the test imports it by, and
      // shared/unused.ts through a file, which the list finds it by a second time.
      symlinkSync(path.join(String(dir), "shared"), path.join(String(dir), "src", "linked"), "dir");
      symlinkSync(path.join(String(dir), "shared", "unused.ts"), path.join(String(dir), "src", "alias.ts"));
      symlinkSync(path.join(String(dir), "shared", "loaded.ts"), path.join(String(dir), "src", "loaded-alias.ts"));
    }
    const { rows, stderr, exitCode } = await run(String(dir), ...lcovFlags);
    expect(stderr).toContain("1 pass");
    expect(rows).toEqual([
      "shared/loaded.ts | 50.00 | 66.67 | 4",
      "shared/unused.ts | 0.00 | 0.00 | 1",
      "src/index.ts | 100.00 | 100.00 |",
    ]);
    // Written where the run started, with the paths it started with.
    expect(Object.keys(lcovRecords(String(dir)))).toEqual(["shared/loaded.ts", "shared/unused.ts", "src/index.ts"]);
    expect(exitCode).toBe(0);
  });

  test.concurrent("a --parallel run that --bail stops reports the files its tests loaded", async () => {
    using dir = tempDir("cov-collect-from", {
      "bunfig.toml": `[test]\ncoverageSkipTestFiles = true\ncollectCoverageFrom = ["src/**"]\n`,
      "src/used.ts": project["src/used.ts"],
      "src/unused.ts": unused,
      "a.test.ts": `import { expect, test } from "bun:test";
import { used } from "./src/used";

test("fails", () => {
  expect(used()).toBe(2);
});
`,
      "b.test.ts": `import { test } from "bun:test";\ntest("b", () => {});\n`,
    });
    const [stopped, finished] = await Promise.all([
      run(String(dir), "--coverage", "--parallel=2", "--bail"),
      run(String(dir), "--coverage", "--parallel=2"),
    ]);
    expect(stopped.stderr).toContain("Bailed out after 1 failure");
    expect({ rows: stopped.rows, exitCode: stopped.exitCode }).toEqual({
      rows: ["src/used.ts | 50.00 | 66.67 | 4"],
      exitCode: 1,
    });
    expect({ rows: finished.rows, exitCode: finished.exitCode }).toEqual({
      rows: [unusedRow, "src/used.ts | 50.00 | 66.67 | 4"],
      exitCode: 1,
    });
  });

  test.concurrent("comments, coverageIgnoreSourcemaps and // @bun apply to a file that nothing loaded", async () => {
    const files = (config: string) => ({
      "bunfig.toml": `[test]\ncoverageSkipTestFiles = true\ncollectCoverageFrom = ["src/**"]\n${config}`,
      "src/hints.ts": `export function kept() {
  return 1;
}
/* v8 ignore next */
export function ignored() {
  const inner = () => 2;
  return inner();
}
export const value = 1; /* v8 ignore next */
/* v8 ignore start */
export const a = 1;
/* v8 ignore stop */
export const last = 3;
`,
      "src/whole-file.ts": `/* v8 ignore file */
export const ignored = 1;
`,
      // The transpiler leaves this one as it is. Its last line has no end
      // and a function on it.
      "src/prebuilt.js": `// @bun
export function first() {
  return 1;
}
export const second = () => 2;`,
      "only.test.ts": `import { test } from "bun:test";\ntest("loads nothing", () => {});\n`,
    });
    using mapped = tempDir("cov-collect-from", files(""));
    using unmapped = tempDir("cov-collect-from", files("coverageIgnoreSourcemaps = true\n"));
    const [withMaps, withoutMaps] = await Promise.all([
      run(String(mapped), ...lcovFlags),
      run(String(unmapped), ...lcovFlags),
    ]);
    expect([withMaps.exitCode, withoutMaps.exitCode]).toEqual([0, 0]);
    expect(lcovRecords(String(mapped))).toEqual({
      "src/hints.ts": { functions: "0/1", lines: "0/3", listed: [1, 2, 13] },
      // Without a source map a last line that does not end is on no line.
      "src/prebuilt.js": { functions: "0/1", lines: "0/4", listed: [1, 2, 3, 4] },
    });
    // The lines are those of the transpiled text, which a comment cannot name.
    expect(Object.keys(lcovRecords(String(unmapped)))).toEqual([
      "src/hints.ts",
      "src/prebuilt.js",
      "src/whole-file.ts",
    ]);
    expect(withoutMaps.rows.find(row => row.startsWith("src/prebuilt.js"))).toBe("src/prebuilt.js | 0.00 | 0.00 | 1-4");
  });

  test.concurrent("says what is wrong with the list", async () => {
    using dir = tempDir("cov-collect-from", {
      "bunfig.toml": `[test]\ncoverageSkipTestFiles = true\n`,
      "number.toml": `[test]\ncollectCoverageFrom = 1\n`,
      "empty.toml": `[test]\ncollectCoverageFrom = ["src/**", ""]\n`,
      "src/unused.ts": unused,
      "only.test.ts": `import { test } from "bun:test";\ntest("loads nothing", () => {});\n`,
    });
    const [number, empty, emptyFlag, noFile, rootDir] = await Promise.all([
      run(String(dir), "--coverage", "--config=number.toml"),
      run(String(dir), "--coverage", "--config=empty.toml"),
      run(String(dir), "--coverage", "--collect-coverage-from="),
      run(String(dir), "--coverage", "--collect-coverage-from=source/**"),
      run(String(dir), "--coverage", "--collect-coverage-from=<rootDir>/src/**"),
    ]);
    expect(number.stderr).toContain("collectCoverageFrom must be a string or array of strings");
    expect(empty.stderr).toContain("collectCoverageFrom patterns cannot be empty strings");
    expect(emptyFlag.stderr).toContain("error: --collect-coverage-from expects a glob pattern");
    expect([number.exitCode, empty.exitCode, emptyFlag.exitCode]).toEqual([1, 1, 1]);
    // A list that names nothing is more likely a mistake than a project without files.
    expect(noFile.stderr).toContain("warn: No file matches collectCoverageFrom\n---");
    expect({ rows: noFile.rows, exitCode: noFile.exitCode }).toEqual({ rows: [], exitCode: 0 });
    expect({ rows: rootDir.rows, exitCode: rootDir.exitCode }).toEqual({ rows: [unusedRow], exitCode: 0 });
  });

  // What a file reports when nothing loads it, next to what it reports when a
  // test imports it and calls nothing of it, and when a test calls all of it.
  const shapes = {
    "functions.ts": `export function a(x: number) {
  // A comment and an empty line in the function.

  return x + 1;
}
export function b(x: number) {
  return x + 2;
}
`,
    "class-field.ts": `export class WithField {
  field = 1;
  method() {
    return this.field;
  }
}
`,
    "class-method.ts": `export class WithMethod {
  method() {
    return 1;
  }
}
`,
    "no-functions.ts": `export const one = 1;
export const two = one + 1;
`,
    "commonjs.cjs": `function a(x) {
  return x + 1;
}
function b(x) {
  return x + 2;
}
module.exports = { a, b };
`,
    "last-line.ts": `export function a(x: number) {
  return x; }
export const one = 1;
`,
    "async-generator.ts": `export async function a() {
  return 1;
}
export function* b() {
  yield 1;
}
`,
    "nested.ts": `export function outer() {
  function inner() {
    return () => 1;
  }
  return inner;
}
export const arrow = () => {
  return 2;
};
`,
    "types.ts": `export interface OnlyTypes {
  name: string;
}
`,
  };
  const callEverything = `
import * as functions from "./src/functions";
import { WithField } from "./src/class-field";
import { WithMethod } from "./src/class-method";
import * as noFunctions from "./src/no-functions";
import * as commonjs from "./src/commonjs.cjs";
import * as lastLine from "./src/last-line";
import * as asyncGenerator from "./src/async-generator";
import * as nested from "./src/nested";
import "./src/types";

export async function callEverything() {
  return [
    functions.a(1),
    functions.b(1),
    new WithField().method(),
    new WithMethod().method(),
    noFunctions.two,
    commonjs.a(1),
    commonjs.b(1),
    lastLine.a(1),
    await asyncGenerator.a(),
    [...asyncGenerator.b()],
    nested.outer()()(),
    nested.arrow(),
  ];
}
`;

  test.concurrent(
    "a file that nothing loaded has the functions of one that is imported and the lines of one that ran",
    async () => {
      const files = (testFile: string) => ({
        "bunfig.toml": `[test]\ncoverageSkipTestFiles = true\ncollectCoverageFrom = ["src/**"]\n`,
        ...Object.fromEntries(Object.entries(shapes).map(([name, source]) => [`src/${name}`, source])),
        "call-everything.ts": callEverything,
        "shapes.test.ts": testFile,
      });
      using nothingLoaded = tempDir(
        "cov-collect-from",
        files(`import { test } from "bun:test";\ntest("loads nothing", () => {});\n`),
      );
      using nothingCalled = tempDir(
        "cov-collect-from",
        files(`import { test } from "bun:test";\nimport "./call-everything";\ntest("calls nothing", () => {});\n`),
      );
      using everythingCalled = tempDir(
        "cov-collect-from",
        files(`import { expect, test } from "bun:test";
import { callEverything } from "./call-everything";
test("calls everything", async () => {
  expect(await callEverything()).toHaveLength(12);
});
`),
      );
      const dirs = [nothingLoaded, nothingCalled, everythingCalled].map(String);
      const runs = await Promise.all(dirs.map(dir => run(dir, ...lcovFlags)));
      expect(runs.map(({ exitCode }) => exitCode)).toEqual([0, 0, 0]);
      const [unloaded, imported, called] = dirs.map(lcovRecords);

      const names = Object.keys(shapes).filter(name => name !== "types.ts");
      expect(Object.keys(unloaded)).toEqual(names.map(name => `src/${name}`).sort());
      for (const name of names) {
        const file = `src/${name}`;
        const source = shapes[name as keyof typeof shapes].split("\n");
        expect({
          name,
          functions: unloaded[file].functions,
          lines: unloaded[file].lines.split("/")[0],
          linesOfARunThatAreMissing: called[file].listed.filter(line => !unloaded[file].listed.includes(line)),
          linesWithoutCode: unloaded[file].listed.filter(line => /^\s*(\/\/.*)?$/.test(source[line - 1])),
        }).toEqual({
          name,
          functions: `0/${imported[file].functions.split("/")[1]}`,
          lines: "0",
          linesOfARunThatAreMissing: [],
          linesWithoutCode: [],
        });
      }
    },
  );
});
