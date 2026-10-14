import { spawnSync } from "bun";
import { beforeAll, describe, expect, it, test } from "bun:test";
import {
  bunEnv,
  bunExe,
  isLinux,
  isWindows,
  normalizeBunSnapshot,
  tempDir,
  tempDirWithFiles,
  tmpdirSync,
} from "harness";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

describe("bun test", () => {
  test("running a non-existent absolute file path is a 1 exit code", () => {
    const spawn = Bun.spawnSync({
      cmd: [bunExe(), "test", join(import.meta.dirname, "non-existent.test.ts")],
      env: bunEnv,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    });
    expect(spawn.exitCode).toBe(1);
  });
  test("can provide no arguments", () => {
    const stderr = runTest({
      args: [],
      input: [
        `
          import { test, expect } from "bun:test";
          test("test #1", () => {
            expect(true).toBe(true);
          });
        `,
        `
          import { test, expect } from "bun:test";
          test.todo("test #2");
        `,
        `
          import { test, expect } from "bun:test";
          test("test #3", () => {
            expect(true).toBe(false);
          });
        `,
      ],
    });
    expect(stderr).toContain("test #1");
    expect(stderr).toContain("test #2");
    expect(stderr).toContain("test #3");
  });
  test("can provide a relative file", () => {
    const path = join("path", "to", "relative.test.ts");
    const cwd = createTest(
      `
      import { test, expect } from "bun:test";
      test("${path}", () => {
        expect(true).toBe(true);
      });
    `,
      path,
    );
    const stderr = runTest({
      cwd,
      args: [path],
    });
    expect(stderr).toContain(path);
  });
  // This fails on macOS because /private/var symlinks to /var
  test.todo("can provide an absolute file", () => {
    const path = join("path", "to", "absolute.test.ts");
    const cwd = createTest(
      `
      import { test, expect } from "bun:test";
      test("${path}", () => {
        expect(true).toBe(true);
      });
    `,
      path,
    );
    const absolutePath = resolve(cwd, path);
    const stderr = runTest({
      cwd,
      args: [absolutePath],
    });
    expect(stderr).toContain(path);
  });
  test("can provide a relative directory", () => {
    const path = join("path", "to", "relative.test.ts");
    const dir = dirname(path);
    const cwd = createTest(
      `
      import { test, expect } from "bun:test";
      test("${dir}", () => {
        expect(true).toBe(true);
      });
    `,
      path,
    );
    const stderr = runTest({
      cwd,
      args: [dir],
    });
    expect(stderr).toContain(dir);
  });
  test.todo("can provide an absolute directory", () => {
    const path = join("path", "to", "absolute.test.ts");
    const cwd = createTest(
      `
      import { test, expect } from "bun:test";
      test("${path}", () => {
        expect(true).toBe(true);
      });
    `,
      path,
    );
    const absoluteDir = resolve(cwd, dirname(path));
    const stderr = runTest({
      cwd,
      args: [absoluteDir],
    });
    expect(stderr).toContain(path);
  });

  test.each([
    ["arrays and objects", "i % 2 ? [value] : { a: value }"],
    ["instances of a class", "new (class A { a = value; })()"],
    ["JSX children", `{ $$typeof: Symbol.for("react.element"), type: "div", props: { children: value } }`],
    ["JSX props", `{ $$typeof: Symbol.for("react.element"), type: "div", props: { a: value } }`],
    ["the data of events", `new MessageEvent("message", { data: value })`],
    ["asymmetric matchers", "expect.objectContaining({ a: value })"],
  ])("%s nested too deeply to print are a RangeError", (_, wrap) => {
    const stderr = runTest({
      input: `
        import { test, expect } from "bun:test";
        function thrownFor(depth) {
          let value = 1;
          for (let i = 0; i < depth; i++) value = ${wrap};
          try {
            expect(value).toMatchInlineSnapshot('"x"');
          } catch (error) {
            return error.constructor.name;
          }
        }
        test("deep", () => {
          expect([thrownFor(10), thrownFor(100_000)]).toEqual(["Error", "RangeError"]);
        });
      `,
      expectExitCode: 0,
    });
    expect(stderr).toContain("1 pass");
  });
  describe("when filters are provided", () => {
    let dir: string;
    beforeAll(() => {
      const makeTest = (name: string, pass = true) => `
      import { test, expect } from "bun:test";
      test("${name}", () => {
        expect(1).toBe(${pass ? 1 : 0});
      });
      `;
      dir = tempDirWithFiles("bun-test-filtering", {
        "foo.test.js": makeTest("foo"),
        bar: {
          "bar1.spec.tsx": makeTest("bar1"),
          "bar2.spec.ts": makeTest("bar2"),
        },
      });
    });

    it("if that filter is a path to a directory, will run all tests in that directory", () => {
      const stderr = runTest({ cwd: dir, args: ["./bar"] });
      expect(stderr).toContain("2 pass");
      expect(stderr).not.toContain("foo");
    });
  });

  test("works with require", () => {
    const stderr = runTest({
      args: [],
      input: [
        `
          const { test, expect } = require("bun:test");
          test("test #1", () => {
            expect().pass();
          })
        `,
      ],
    });
    expect(stderr).toContain("test #1");
  });
  test("works with dynamic import", () => {
    const stderr = runTest({
      args: [],
      input: `
        const { test, expect } = await import("bun:test");
        test("test #1", () => {
          expect().pass();
        })
      `,
    });
    expect(stderr).toContain("test #1");
  });
  test("works with cjs require", () => {
    const cwd = createTest(
      `
        const { test, expect } = require("bun:test");
        test("test #1", () => {
          expect().pass();
        })
      `,
      "test.test.cjs",
    );
    const stderr = runTest({
      cwd,
    });
    expect(stderr).toContain("test #1");
  });
  test("works with cjs dynamic import", () => {
    const cwd = createTest(
      `
        const { test, expect } = await import("bun:test");
        test("test #1", () => {
          expect().pass();
        })
      `,
      "test.test.cjs",
    );
    const stderr = runTest({
      cwd,
    });
    expect(stderr).toContain("test #1");
  });
  test.todo("can provide a mix of files and directories");
  describe("--rerun-each", () => {
    test.todo("can rerun with a default value");
    test.todo("can rerun with a provided value");
  });
  describe("--todo", () => {
    test("should not run todo by default", () => {
      const stderr = runTest({
        input: `
          import { test, expect } from "bun:test";
          test.todo("todo", async () => {
            console.error("should not run");
          });
        `,
      });
      expect(stderr).not.toContain("should not run");
    });
    test("should run todo when enabled", () => {
      const stderr = runTest({
        args: ["--todo"],
        input: `
          import { test, expect } from "bun:test";
          test.todo("todo", async () => {
            console.error("should run");
          });
        `,
      });
      expect(stderr).toContain("should run");
    });
  });
  describe("only", () => {
    test("should run nested describe.only", () => {
      const stderr = runTest({
        args: [],
        input: `
            import { test, describe } from "bun:test";
            describe("outer", () => {
              describe.only("inner (nested)", () => {
                test("test", () => {
                  console.error("reachable");
                })
              })
              describe("inner (skipped)", () => {
                test("test", () => {
                  console.error("unreachable");
                })
              })
            })
            `,
        env: { CI: "false" },
      });
      expect(stderr).toContain("reachable");
      expect(stderr).not.toContain("unreachable");
      expect(stderr.match(/reachable/g)).toHaveLength(1);
    });
    test("should skip non-only tests", () => {
      const stderr = runTest({
        args: [],
        input: `
          import { test, describe } from "bun:test";
          test("test #1", () => {
            console.error("unreachable");
          });
          test.only("test #2", () => {
            console.error("reachable");
          });
          test("test #3", () => {
            console.error("unreachable");
          });
          test.skip("test #4", () => {
            console.error("unreachable");
          });
          test.todo("test #5");
          describe("describe #1", () => {
            test("test #6", () => {
              console.error("unreachable");
            });
            test.only("test #7", () => {
              console.error("reachable");
            });
          });
          describe.only("describe #2", () => {
            test("test #8", () => {
              console.error("unreachable");
            });
            test.skip("test #9", () => {
              console.error("unreachable");
            });
            test.only("test #10", () => {
              console.error("reachable");
            });
          });
        `,
        env: { CI: "false" },
      });
      expect(stderr).toContain("reachable");
      expect(stderr).not.toContain("unreachable");
      expect(stderr.match(/reachable/g)).toHaveLength(3);
    });
  });
  describe.concurrent("--dry-run", () => {
    // Every callback logs "RAN ..." to stdout, so stdout doubles as proof that nothing executed.
    const files = {
      "a.test.ts": `
        import { test, describe, beforeAll, beforeEach, afterEach, afterAll } from "bun:test";
        beforeAll(() => console.log("RAN beforeAll"));
        beforeEach(() => console.log("RAN beforeEach"));
        afterEach(() => console.log("RAN afterEach"));
        afterAll(() => console.log("RAN afterAll"));
        describe("math", () => {
          test("adds", () => console.log("RAN adds"));
          test.skip("subtracts", () => console.log("RAN subtracts"));
          test.todo("multiplies");
          test.todo("divides", () => console.log("RAN divides"));
          test.failing("throws", () => console.log("RAN throws"));
          test.each([1, 2])("squares %i", () => console.log("RAN squares"));
        });
        test("top level", () => console.log("RAN top level"));
      `,
      "b.test.ts": `
        import { test, describe } from "bun:test";
        describe.skip("disabled", () => {
          test("inside", () => console.log("RAN inside"));
        });
        test("b works", () => console.log("RAN b works"));
      `,
      "only.test.ts": `
        import { test, describe } from "bun:test";
        test("a", () => console.log("RAN a"));
        test.only("b", () => console.log("RAN b"));
        describe("d", () => {
          test("c", () => console.log("RAN c"));
          test.only("e", () => console.log("RAN e"));
        });
      `,
      "broken.test.ts": `
        import { test } from "bun:test";
        test("never listed", () => console.log("RAN never listed"));
        throw new Error("boom at load time");
      `,
      "preload.ts": `
        import { beforeAll, afterAll } from "bun:test";
        beforeAll(() => console.log("RAN preload beforeAll"));
        afterAll(() => console.log("RAN preload afterAll"));
      `,
    };

    async function dryRun(args: string[], env: Record<string, string> = {}) {
      using dir = tempDir("bun-test-dry-run", files);
      await using proc = Bun.spawn({
        cmd: [bunExe(), "test", "--dry-run", ...args],
        env: { ...bunEnv, ...env },
        cwd: String(dir),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      return {
        stdout: normalizeBunSnapshot(stdout, String(dir)),
        stderr: normalizeBunSnapshot(stderr, String(dir)),
        exitCode,
      };
    }

    test("lists every test with the result it would get, without running tests or hooks", async () => {
      const { stdout, stderr, exitCode } = await dryRun(["--preload", "./preload.ts", "./a.test.ts", "./b.test.ts"]);
      expect(stdout).toBe("bun test <version> (<revision>) DRY RUN");
      expect(stderr).toMatchInlineSnapshot(`
        "a.test.ts:
        (pending) math > adds
        (skip) math > subtracts
        (todo) math > multiplies
        (todo) math > divides
        (pending) math > throws
        (pending) math > squares 1
        (pending) math > squares 2
        (pending) top level

        b.test.ts:
        (skip) disabled > inside
        (pending) b works

         6 pending
         2 skip
         2 todo
        Found 10 tests across 2 files."
      `);
      expect(exitCode).toBe(0);
    });

    test("--todo makes todo tests with a callback pending", async () => {
      const { stdout, stderr, exitCode } = await dryRun(["--todo", "./a.test.ts"]);
      expect(stdout).not.toContain("RAN");
      expect(stderr).toContain("(pending) math > divides");
      expect(stderr).toContain("(todo) math > multiplies");
      expect(stderr).toContain(" 6 pending");
      expect(stderr).toContain(" 1 todo");
      expect(exitCode).toBe(0);
    });

    test("applies -t like a real run", async () => {
      const { stdout, stderr, exitCode } = await dryRun(["-t", "adds", "./a.test.ts", "./b.test.ts"]);
      expect(stdout).not.toContain("RAN");
      expect(stderr).toMatchInlineSnapshot(`
        "a.test.ts:
        (pending) math > adds

        b.test.ts:
        (skip) disabled > inside

         1 pending
         1 skip
        Found 2 tests across 2 files."
      `);
      expect(exitCode).toBe(0);
    });

    test("still fails when -t matches nothing", async () => {
      const { stdout, stderr, exitCode } = await dryRun(["-t", "no such test", "./a.test.ts"]);
      expect(stdout).toBe("bun test <version> (<revision>) DRY RUN");
      expect(stderr).toContain('regex "no such test" matched 0 tests');
      expect(exitCode).toBe(1);
    });

    test("honors .only", async () => {
      const { stdout, stderr, exitCode } = await dryRun(["./only.test.ts"], { CI: "false" });
      expect(stdout).not.toContain("RAN");
      expect(stderr).toMatchInlineSnapshot(`
        "only.test.ts:
        (pending) b
        (pending) d > e

         2 pending
        Found 2 tests across 1 file."
      `);
      expect(exitCode).toBe(0);
    });

    test("a file that fails to load is reported and fails the run", async () => {
      const { stderr, exitCode } = await dryRun(["./broken.test.ts", "./b.test.ts"]);
      expect(stderr).toContain("boom at load time");
      expect(stderr).not.toContain("(pending) never listed");
      expect(stderr).toContain("(pending) b works");
      expect(stderr).toContain(" 1 fail");
      expect(exitCode).toBe(1);
    });

    test("lists each file once, in this process, even with --rerun-each and --parallel", async () => {
      const { stdout, stderr, exitCode } = await dryRun(["--rerun-each=3", "--parallel=2", "./b.test.ts"]);
      expect(stdout).toBe("bun test <version> (<revision>) DRY RUN");
      expect(stderr.match(/b\.test\.ts:/g)).toHaveLength(1);
      expect(stderr).toContain("Found 2 tests across 1 file.");
      expect(exitCode).toBe(0);
    });

    test("writes pending tests to the junit report as skipped", async () => {
      using dir = tempDir("bun-test-dry-run-junit", files);
      await using proc = Bun.spawn({
        cmd: [bunExe(), "test", "--dry-run", "--reporter=junit", "--reporter-outfile=report.xml", "./b.test.ts"],
        env: bunEnv,
        cwd: String(dir),
        stdout: "ignore",
        stderr: "pipe",
      });
      const [stderr, exitCode] = await Promise.all([proc.stderr.text(), proc.exited]);
      expect(stderr).toContain("Found 2 tests across 1 file.");
      expect(exitCode).toBe(0);
      const report = await Bun.file(join(String(dir), "report.xml")).text();
      expect(report).toContain(
        '<testsuite name="b.test.ts" file="b.test.ts" tests="2" assertions="0" failures="0" skipped="2"',
      );
      expect(report).toMatch(/<testcase name="b works"[^>]*>\s*<skipped message="dry run" \/>/);
      expect(report).toMatch(/<testcase name="inside"[^>]*>\s*<skipped \/>/);
    });
  });
  describe.concurrent("--reporter=json", () => {
    const files = {
      "a.test.ts": `
        import { test, describe, expect } from "bun:test";
        describe("math", () => {
          test("adds", () => {
            expect(1 + 1).toBe(2);
          });
          test("subtracts", () => {
            expect(2 - 1).toBe(2);
          });
          describe("nested", () => {
            test.skip("skipped", () => {});
            test.todo("todo");
          });
        });
        test("top level", () => {});
        test("times out", async () => {
          await new Promise(() => {});
        }, { timeout: 10 });
        test.failing("failing passes", () => {});
      `,
      "b.test.ts": `
        import { test } from "bun:test";
        test.skip("only skipped", () => {});
      `,
      "broken.test.ts": `
        import { test } from "bun:test";
        test("never listed", () => {});
        throw new Error("boom at load time");
      `,
    };

    type Report = {
      numTotalTestSuites: number;
      numPassedTestSuites: number;
      numFailedTestSuites: number;
      numPendingTestSuites: number;
      numRuntimeErrorTestSuites: number;
      numTotalTests: number;
      numPassedTests: number;
      numFailedTests: number;
      numPendingTests: number;
      numTodoTests: number;
      startTime: number;
      success: boolean;
      testResults: {
        name: string;
        status: string;
        startTime: number;
        endTime: number;
        message: string;
        assertionResults: {
          ancestorTitles: string[];
          fullName: string;
          title: string;
          status: string;
          duration: number;
          failureMessages: string[];
          location: { line: number; column: number } | null;
        }[];
      }[];
    };

    async function run(args: string[], outfile?: string, extraFiles: Record<string, string> = {}) {
      using dir = tempDir("bun-test-json-reporter", { ...files, ...extraFiles });
      await using proc = Bun.spawn({
        cmd: [bunExe(), "test", ...args],
        env: bunEnv,
        cwd: String(dir),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      const report: Report = JSON.parse(outfile ? await Bun.file(join(String(dir), outfile)).text() : stdout);
      return { stdout, stderr, exitCode, report, dir: realpathSync(String(dir)) };
    }

    test("writes a Jest-compatible document with every test and the errors", async () => {
      const { stderr, exitCode, report, dir } = await run(
        ["--reporter=json", "--reporter-outfile=report.json", "./a.test.ts", "./b.test.ts", "./broken.test.ts"],
        "report.json",
      );
      // The console reporter is unchanged.
      expect(stderr).toContain("(fail) math > subtracts");
      expect(stderr).toContain("Ran 9 tests across 3 files.");
      expect(exitCode).toBe(1);

      const { testResults, startTime, ...counts } = report;
      expect(counts).toEqual({
        numTotalTestSuites: 3,
        numPassedTestSuites: 0,
        numFailedTestSuites: 2,
        numPendingTestSuites: 1,
        numRuntimeErrorTestSuites: 1,
        numTotalTests: 8,
        numPassedTests: 2,
        numFailedTests: 3,
        numPendingTests: 2,
        numTodoTests: 1,
        success: false,
      });
      expect(startTime).toBeGreaterThan(1_600_000_000_000);

      expect(testResults.map(f => [basename(f.name), f.status])).toEqual([
        ["a.test.ts", "failed"],
        ["b.test.ts", "skipped"],
        ["broken.test.ts", "failed"],
      ]);
      for (const file of testResults) {
        expect(file.name).toBe(join(dir, basename(file.name)));
        expect(file.endTime).toBeGreaterThanOrEqual(file.startTime);
        expect(file.startTime).toBeGreaterThanOrEqual(startTime);
      }

      const [a, b, broken] = testResults;
      expect(a.message).toBe("");
      expect(a.assertionResults.map(t => ({ ...t, duration: typeof t.duration }))).toEqual([
        {
          ancestorTitles: ["math"],
          fullName: "math adds",
          title: "adds",
          status: "passed",
          duration: "number",
          failureMessages: [],
          location: { line: 4, column: 11 },
        },
        {
          ancestorTitles: ["math"],
          fullName: "math subtracts",
          title: "subtracts",
          status: "failed",
          duration: "number",
          failureMessages: [
            expect.stringMatching(
              /^AssertionError: expect\(received\)\.toBe\(expected\)\n\nExpected: 2\nReceived: 1\n\n\s+at .*a\.test\.ts:8:27\n$/,
            ),
          ],
          location: { line: 7, column: 11 },
        },
        {
          ancestorTitles: ["math", "nested"],
          fullName: "math nested skipped",
          title: "skipped",
          status: "pending",
          duration: "number",
          failureMessages: [],
          location: { line: 11, column: 18 },
        },
        {
          ancestorTitles: ["math", "nested"],
          fullName: "math nested todo",
          title: "todo",
          status: "todo",
          duration: "number",
          failureMessages: [],
          location: { line: 12, column: 18 },
        },
        {
          ancestorTitles: [],
          fullName: "top level",
          title: "top level",
          status: "passed",
          duration: "number",
          failureMessages: [],
          location: { line: 15, column: 9 },
        },
        {
          ancestorTitles: [],
          fullName: "times out",
          title: "times out",
          status: "failed",
          duration: "number",
          failureMessages: ["TimeoutError: test timed out"],
          location: { line: 16, column: 9 },
        },
        {
          ancestorTitles: [],
          fullName: "failing passes",
          title: "failing passes",
          status: "failed",
          duration: "number",
          failureMessages: ["AssertionError: test marked with .failing() did not throw"],
          location: { line: 19, column: 14 },
        },
      ]);
      expect(a.assertionResults[5].duration).toBeGreaterThan(0);

      expect(b.assertionResults).toEqual([
        {
          ancestorTitles: [],
          fullName: "only skipped",
          title: "only skipped",
          status: "pending",
          duration: 0,
          failureMessages: [],
          location: { line: 3, column: 14 },
        },
      ]);

      // A file that throws while loading has no tests; the error is its message.
      expect(broken.assertionResults).toEqual([]);
      expect(broken.message).toMatch(/^Error: boom at load time\n\s+at .*broken\.test\.ts:4:19\n$/);
    });

    test("prints the document to stdout when there is no outfile, with nothing else", async () => {
      const { stdout, stderr, exitCode, report } = await run(["--reporter=json", "./b.test.ts"]);
      expect(stdout).toStartWith("{\n");
      expect(stdout).toEndWith("}\n");
      expect(stderr).toContain("(skip) only skipped");
      expect(report.success).toBe(true);
      expect(report.numTotalTests).toBe(1);
      expect(report.testResults.map(f => f.status)).toEqual(["skipped"]);
      expect(exitCode).toBe(0);
    });

    test("reads the outfile from bunfig.toml", async () => {
      const { stdout, exitCode, report } = await run(["./b.test.ts"], "from-bunfig.json", {
        "bunfig.toml": `
          [test.reporter]
          json = "from-bunfig.json"
        `,
      });
      expect(stdout).toStartWith("bun test v");
      expect(report.numPendingTests).toBe(1);
      expect(exitCode).toBe(0);
    });

    test("is written when --bail stops the run", async () => {
      const { exitCode, report } = await run(["--bail", "--reporter=json", "./a.test.ts"]);
      expect(report.success).toBe(false);
      expect(report.numTotalTests).toBe(2);
      expect(report.testResults[0].assertionResults.map(t => t.status)).toEqual(["passed", "failed"]);
      expect(exitCode).toBe(1);
    });

    test("leaves out the tests -t filters out, and lists --dry-run tests as pending", async () => {
      const filtered = await run(["--reporter=json", "-t", "adds", "./a.test.ts"]);
      expect(filtered.report.numTotalTests).toBe(1);
      expect(filtered.report.testResults[0].assertionResults.map(t => t.fullName)).toEqual(["math adds"]);
      expect(filtered.exitCode).toBe(0);

      const dry = await run(["--reporter=json", "--dry-run", "./a.test.ts"]);
      expect(dry.report.success).toBe(true);
      expect(dry.report.testResults[0].assertionResults.map(t => t.status)).toEqual([
        "pending",
        "pending",
        "pending",
        "todo",
        "pending",
        "pending",
        "pending",
      ]);
      expect(dry.exitCode).toBe(0);
    });

    test("rejects an unknown reporter", async () => {
      using dir = tempDir("bun-test-json-reporter-unknown", files);
      await using proc = Bun.spawn({
        cmd: [bunExe(), "test", "--reporter=yaml", "./b.test.ts"],
        env: bunEnv,
        cwd: String(dir),
        stdout: "ignore",
        stderr: "pipe",
      });
      const [stderr, exitCode] = await Promise.all([proc.stderr.text(), proc.exited]);
      expect(stderr).toContain("unsupported reporter format 'yaml'");
      expect(stderr).toContain("'json'");
      expect(exitCode).toBe(1);
    });
  });
  describe("--bail", () => {
    test("must provide a number bail", () => {
      const stderr = runTest({
        args: ["--bail=foo"],
      });
      expect(stderr).toContain("expects a number");
    });

    test("must provide non-negative bail", () => {
      const stderr = runTest({
        args: ["--bail=-1"],
      });
      expect(stderr).toContain("expects a number");
    });

    test("should not be 0", () => {
      const stderr = runTest({
        args: ["--bail=0"],
      });
      expect(stderr).toContain("expects a number");
    });

    test("bail should be 1 by default", () => {
      const stderr = runTest({
        args: ["--bail"],
        input: `
          import { test, expect } from "bun:test";
          test("test #1", () => {
            expect(true).toBe(false);
          });
          test("test #2", () => {
            expect(true).toBe(true);
          });
        `,
      });
      expect(stderr).toContain("Bailed out after 1 failure");
      expect(stderr).not.toContain("test #2");
    });

    test("should bail out after 3 failures", () => {
      const stderr = runTest({
        args: ["--bail=3"],
        input: `
          import { test, expect } from "bun:test";
          test("test #1", () => {
            expect(true).toBe(false);
          });
          test("test #2", () => {
            expect(true).toBe(false);
          });
          test("test #3", () => {
            expect(true).toBe(false);
          });
          test("test #4", () => {
            expect(true).toBe(true);
          });
        `,
      });
      expect(stderr).toContain("Bailed out after 3 failures");
      expect(stderr).not.toContain("test #4");
    });
  });
  describe("--timeout", () => {
    test("must provide a number timeout", () => {
      const stderr = runTest({
        args: ["--timeout", "foo"],
      });
      expect(stderr).toContain("Invalid timeout");
    });
    test("must provide non-negative timeout", () => {
      const stderr = runTest({
        args: ["--timeout", "-1"],
      });
      expect(stderr).toContain("Invalid timeout");
    });
    // TODO: https://github.com/oven-sh/bun/issues/8069
    // This test crashes, which will pass because stderr contains "timed out"
    // but the crash can also mean it hangs, which will end up failing.
    // Possibly fixed by https://github.com/oven-sh/bun/pull/8076/files
    test("timeout can be set to 30ms", () => {
      const stderr = runTest({
        args: ["--timeout", "30"],
        input: `
          import { test, expect } from "bun:test";
          import { sleep } from "bun";
          test("ok", async () => {
            await expect(sleep(1)).resolves.toBeUndefined();
          });
          test("timeout", async () => {
            await expect(sleep(64)).resolves.toBeUndefined();
          });
        `,
      });
      expect(stderr).toHaveTestTimedOutAfter(30);
    });
    test("timeout should default to 5000ms", () => {
      const time = process.platform === "linux" ? 5005 : 5500;
      const stderr = runTest({
        input: `
          import { test, expect } from "bun:test";
          import { sleep } from "bun";
          test("timeout", async () => {
            await sleep(${time});
          });
        `,
      });
      expect(stderr).toHaveTestTimedOutAfter(5000);
    }, 10000);
  });
  describe("support for Github Actions", () => {
    test("should not group logs by default", () => {
      const stderr = runTest({
        env: {
          GITHUB_ACTIONS: undefined,
        },
      });
      expect(stderr).not.toContain("::group::");
      expect(stderr).not.toContain("::endgroup::");
    });
    test("should not group logs when disabled", () => {
      const stderr = runTest({
        env: {
          GITHUB_ACTIONS: "false",
        },
      });
      expect(stderr).not.toContain("::group::");
      expect(stderr).not.toContain("::endgroup::");
    });
    test("should group logs when enabled", () => {
      const stderr = runTest({
        env: {
          GITHUB_ACTIONS: "true",
        },
      });
      expect(stderr).toContain("::group::");
      expect(stderr.match(/::group::/g)).toHaveLength(1);
      expect(stderr).toContain("::endgroup::");
      expect(stderr.match(/::endgroup::/g)).toHaveLength(1);
    });
    test("should group logs with multiple files", () => {
      const stderr = runTest({
        input: [
          `
            import { test, expect } from "bun:test";
            test("pass", () => {
              expect(true).toBe(true);
            });
          `,
          `
            import { test, expect } from "bun:test";
            test.skip("skip", () => {});
          `,
          `
            import { test, expect } from "bun:test";
            test("fail", () => {
              expect(true).toBe(false);
            });
          `,
        ],
        env: {
          GITHUB_ACTIONS: "true",
        },
      });
      expect(stderr).toContain("::group::");
      expect(stderr.match(/::group::/g)).toHaveLength(3);
      expect(stderr).toContain("::endgroup::");
      expect(stderr.match(/::endgroup::/g)).toHaveLength(3);
    });
    test("should group logs with --rerun-each", () => {
      const stderr = runTest({
        args: ["--rerun-each", "3"],
        input: [
          `
            import { test, expect } from "bun:test";
            test("pass", () => {
              expect(true).toBe(true);
            });
          `,
          `
            import { test, expect } from "bun:test";
            test("fail", () => {
              expect(true).toBe(false);
            });
          `,
        ],
        env: {
          GITHUB_ACTIONS: "true",
        },
      });
      expect(stderr).toContain("::group::");
      expect(stderr.match(/::group::/g)).toHaveLength(6);
      expect(stderr).toContain("::endgroup::");
      expect(stderr.match(/::endgroup::/g)).toHaveLength(6);
    });
    test("should not annotate errors by default", () => {
      const stderr = runTest({
        input: `
          import { test, expect } from "bun:test";
          test("fail", () => {
            expect(true).toBe(false);
          });
        `,
        env: {
          GITHUB_ACTIONS: undefined,
        },
      });
      expect(stderr).not.toContain("::error");
    });
    test("should not annotate errors with inspect() by default", () => {
      const stderr = runTest({
        input: `
          import { test } from "bun:test";
          import { inspect } from "bun";
          test("inspect", () => {
            inspect(new TypeError());
            console.error(inspect(new TypeError()));
          });
        `,
        env: {
          GITHUB_ACTIONS: undefined,
        },
      });
      expect(stderr).not.toContain("::error");
    });
    test("should not annotate errors with inspect() when enabled", () => {
      const stderr = runTest({
        input: `
          import { test } from "bun:test";
          import { inspect } from "bun";
          test("inspect", () => {
            inspect(new TypeError());
            console.error(inspect(new TypeError()));
          });
        `,
        env: {
          GITHUB_ACTIONS: "true",
        },
      });
      expect(stderr).not.toContain("::error");
    });
    test("should annotate errors in the global scope", () => {
      const stderr = runTest({
        input: `
          throw new Error();
        `,
        env: {
          GITHUB_ACTIONS: "true",
        },
      });
      expect(stderr).toMatch(/::error file=.*,line=\d+,col=\d+,title=error::/);
    });
    test.each(["test", "describe"])("should annotate errors in a %s scope", type => {
      const stderr = runTest({
        input: `
          import { ${type} } from "bun:test";
          ${type}("fail", () => {
            throw new Error();
          });
        `,
        env: {
          GITHUB_ACTIONS: "true",
        },
      });
      expect(stderr).toMatch(/::error file=.*,line=\d+,col=\d+,title=error::/);
    });
    test.each(["beforeAll", "beforeEach", "afterEach", "afterAll"])("should annotate errors in a %s callback", type => {
      const stderr = runTest({
        input: `
          import { test, ${type} } from "bun:test";
          ${type}(() => {
            throw new Error();
          });
          test("test", () => {});
        `,
        env: {
          GITHUB_ACTIONS: "true",
        },
      });
      expect(stderr).toMatch(/::error file=.*,line=\d+,col=\d+,title=error::/);
    });
    test("should annotate errors with escaped strings", () => {
      const stderr = runTest({
        input: `
          import { test, expect } from "bun:test";
          test("fail", () => {
            expect(true).toBe(false);
          });
        `,
        env: {
          FORCE_COLOR: "1",
          GITHUB_ACTIONS: "true",
        },
      });
      expect(stderr).toMatch(/::error file=.*,line=\d+,col=\d+,title=.*::/);
      expect(stderr).toMatch(/error: expect\(received\)\.toBe\(expected\)/); // stripped ansi
      expect(stderr).toMatch(/Expected: false%0AReceived: true%0A/); // escaped newlines
    });
    test("should annotate errors without a stack", () => {
      const stderr = runTest({
        input: `
          import { test, expect } from "bun:test";
          test("fail", () => {
            throw "Oops!";
          });
        `,
        env: {
          FORCE_COLOR: "1",
          GITHUB_ACTIONS: "true",
        },
      });
      expect(stderr).toMatch(/::error file=.*,line=\d+,col=\d+,title=error: Oops!::/m);
    });
    test("should annotate an error message containing non-ASCII bytes", () => {
      const stderr = runTest({
        input: `
          import { test } from "bun:test";
          test("fail", () => {
            throw "hello é world";
          });
        `,
        env: {
          FORCE_COLOR: "1",
          GITHUB_ACTIONS: "true",
        },
      });
      const annotation = stderr.split("\n").find(l => l.startsWith("::error"));
      expect(annotation).toMatch(/^::error file=.*,line=\d+,col=\d+,title=error: hello é world::%0A {6}at /);
    });
    test("should annotate an error message containing emoji and newlines", () => {
      const stderr = runTest({
        input: `
          import { test } from "bun:test";
          test("fail", () => {
            throw "before 😋 after\\nsecond 😋 line";
          });
        `,
        env: {
          FORCE_COLOR: "1",
          GITHUB_ACTIONS: "true",
        },
      });
      const annotation = stderr.split("\n").find(l => l.startsWith("::error"));
      expect(annotation).toMatch(
        /^::error file=.*,line=\d+,col=\d+,title=error: before 😋 after::second 😋 line%0A {6}at /,
      );
    });
    test("should percent-encode metacharacters in the annotation file property", () => {
      const stderr = runTest({
        input: [
          {
            filename: "odd,name%path.test.ts",
            contents: `
              import { test } from "bun:test";
              test("fail", () => {
                throw new Error("boom");
              });
            `,
          },
        ],
        env: {
          GITHUB_ACTIONS: "true",
        },
      });
      const annotation = stderr.split("\n").find(l => l.startsWith("::error"));
      expect(annotation).toMatch(
        /^::error file=(.*[\\/])?odd%2Cname%25path\.test\.ts,line=\d+,col=\d+,title=error: boom::/,
      );
    });
    test("should percent-encode metacharacters in the annotation title", () => {
      const stderr = runTest({
        input: `
          import { test } from "bun:test";
          test("fail", () => {
            const err = new Error("alpha: one, two 100%\\nbeta: three, four");
            err.name = "Odd:Name,With%Chars";
            throw err;
          });
        `,
        env: {
          FORCE_COLOR: "1",
          GITHUB_ACTIONS: "true",
        },
      });
      const annotation = stderr.split("\n").find(l => l.startsWith("::error"));
      expect(annotation).toMatch(
        /^::error file=.*,line=\d+,col=\d+,title=Odd%3AName%2CWith%25Chars: alpha%3A one%2C two 100%25::beta: three, four%0A {6}at /,
      );
    });
    test("should keep a function name containing a newline on the annotation line", () => {
      const stderr = runTest({
        input: `
          import { test } from "bun:test";
          function inner() {
            throw new Error("boom");
          }
          Object.defineProperty(inner, "name", { value: "odd\\nname" });
          test("fail", () => {
            inner();
          });
        `,
        env: {
          FORCE_COLOR: "1",
          GITHUB_ACTIONS: "true",
        },
      });
      const annotation = stderr.split("\n").find(l => l.startsWith("::error"));
      expect(annotation).toMatch(/^::error file=.*,line=\d+,col=\d+,title=error: boom::/);
      expect(annotation).toContain("%0A      at odd%0Aname (");
    });
    test("should annotate a test timeout", () => {
      const stderr = runTest({
        input: `
          import { test } from "bun:test";
          test("time out", async () => {
            await Bun.sleep(1000);
          }, { timeout: 1 });
        `,
        env: {
          FORCE_COLOR: "1",
          GITHUB_ACTIONS: "true",
        },
      });
      expect(stderr).toMatch(/::error title=error: Test \"time out\" timed out after \d+ms::/);
    });
    test("should annotate an error thrown from a source whose URL is longer than a path buffer", () => {
      // Longer than a path buffer on every platform (98302 bytes on Windows).
      const padding = 100_000;
      const dataUrlModule = 'export default function fromDataUrl() { throw new Error("boom"); }//';
      const base64 = btoa(dataUrlModule + Buffer.alloc(padding, "x").toString());
      const longPath = "/" + Buffer.alloc(padding, "y").toString();
      const stderr = runTest({
        input: `
          import { test } from "bun:test";
          test("data url", async () => {
            const source = ${JSON.stringify(dataUrlModule)} + Buffer.alloc(${padding}, "x").toString();
            const m = await import("data:text/javascript;base64," + btoa(source));
            m.default();
          });
          test("long sourceURL", () => {
            const sourceURL = "/" + Buffer.alloc(${padding}, "y").toString();
            (0, eval)("(function fromLongPath() { throw new Error('boom'); })\\n//# sourceURL=" + sourceURL)();
          });
        `,
        env: {
          GITHUB_ACTIONS: "true",
        },
        expectExitCode: 1,
      });
      const annotations = stderr.split("\n").filter(line => line.startsWith("::error"));
      expect(annotations).toHaveLength(2);
      const [dataUrl, longSourceUrl] = annotations;
      expect(dataUrl).toStartWith(`::error file=data%3Atext/javascript;base64%2C${base64},line=1,col=`);
      expect(dataUrl).toContain(`%0A      at fromDataUrl (data:text/javascript;base64,${base64}:1:`);
      expect(longSourceUrl).toStartWith(`::error file=${longPath},line=1,col=`);
      expect(longSourceUrl).toContain(`%0A      at fromLongPath (${longPath}:1:`);
    });
    test("should make the annotation file relative to GITHUB_WORKSPACE only when it is a path", () => {
      const cwd = createTest([
        {
          filename: "workspace.test.ts",
          contents: `
            import { test } from "bun:test";
            test("in the test file", () => {
              throw new Error("boom");
            });
            test("in a sourceURL that is not a path", () => {
              (0, eval)("(function fromSourceUrl() { throw new Error('boom'); })\\n//# sourceURL=webpack://app/./src/x.ts")();
            });
          `,
        },
      ]);
      const stderr = runTest({
        cwd,
        env: {
          GITHUB_ACTIONS: "true",
          GITHUB_WORKSPACE: dirname(cwd),
        },
        expectExitCode: 1,
      });
      const annotations = stderr.split("\n").filter(line => line.startsWith("::error"));
      expect(annotations).toHaveLength(2);
      const [testFile, sourceUrl] = annotations;
      expect(testFile).toStartWith(`::error file=${basename(cwd)}${sep}workspace.test.ts,line=4,col=`);
      expect(sourceUrl).toStartWith("::error file=webpack%3A//app/./src/x.ts,line=1,col=");
      expect(sourceUrl).toContain("%0A      at fromSourceUrl (webpack://app/./src/x.ts:1:");
    });
  });
  describe(".each", () => {
    test("should run tests with test.each", () => {
      const numbers = [
        [1, 2, 3],
        [1, 1, 2],
        [3, 4, 7],
      ];

      const stderr = runTest({
        args: [],
        input: `
          import { test, expect } from "bun:test";

          test.each(${JSON.stringify(numbers)})("%i + %i = %i", (a, b, e) => {
            expect(a + b).toBe(e);
          });
        `,
      });
      numbers.forEach(numbers => {
        expect(stderr).toContain(`${numbers[0]} + ${numbers[1]} = ${numbers[2]}`);
      });
    });
    test("should allow tests run with test.each to be skipped", () => {
      const numbers = [
        [1, 2, 3],
        [1, 1, 2],
        [3, 4, 7],
      ];

      const stderr = runTest({
        args: ["-t", "$a"],
        input: `
          import { test, expect } from "bun:test";

          test.each(${JSON.stringify(numbers)})("%i + %i = %i", (a, b, e) => {
            expect(a + b).toBe(e);
          });
        `,
      });
      numbers.forEach(numbers => {
        expect(stderr).not.toContain(`(pass) ${numbers[0]} + ${numbers[1]} = ${numbers[2]}`);
      });
    });
    test("should allow tests run with test.each to be matched", () => {
      const numbers = [
        [1, 2, 3],
        [1, 1, 2],
        [3, 4, 7],
      ];

      const stderr = runTest({
        args: ["-t", "1 \\+"],
        input: `
          import { test, expect } from "bun:test";

          test.each(${JSON.stringify(numbers)})("%i + %i = %i", (a, b, e) => {
            expect(a + b).toBe(e);
          });
        `,
      });
      numbers.forEach(numbers => {
        if (numbers[0] === 1) {
          expect(stderr).toContain(`(pass) ${numbers[0]} + ${numbers[1]} = ${numbers[2]}`);
        } else {
          expect(stderr).not.toContain(`(pass) ${numbers[0]} + ${numbers[1]} = ${numbers[2]}`);
        }
      });
    });
    test("should run tests with describe.each", () => {
      const numbers = [
        [1, 2, 3],
        [1, 1, 2],
        [3, 4, 7],
      ];

      const stderr = runTest({
        args: [],
        input: `
          import { test, expect, describe } from "bun:test";

          describe.each(${JSON.stringify(numbers)})("%i + %i = %i", (a, b, e) => {\
            test("addition", () => {
              expect(a + b).toBe(e);
            });
          });
        `,
      });
      numbers.forEach(numbers => {
        expect(stderr).toContain(`${numbers[0]} + ${numbers[1]} = ${numbers[2]}`);
      });
    });
    test("check formatting for %i", () => {
      const numbers = [
        [1, 2, 3],
        [1, 1, 2],
        [3, 4, 7],
      ];

      const stderr = runTest({
        args: [],
        input: `
          import { test, expect } from "bun:test";

          test.each(${JSON.stringify(numbers)})("%i + %i = %i", (a, b, e) => {
            expect(a + b).toBe(e);
          });
        `,
      });
      numbers.forEach(numbers => {
        expect(stderr).toContain(`${numbers[0]} + ${numbers[1]} = ${numbers[2]}`);
      });
    });
    test("check formatting for %f", () => {
      const numbers = [
        [1.4, 2.9, 4.3],
        [1, 1, 2],
        [3.1, 4.5, 7.6],
      ];

      const stderr = runTest({
        args: [],
        input: `
          import { test, expect } from "bun:test";

          test.each(${JSON.stringify(numbers)})("%f + %f = %d", (a, b, e) => {
            expect(a + b).toBe(e);
          });
        `,
      });
      numbers.forEach(numbers => {
        expect(stderr).toContain(`${numbers[0]} + ${numbers[1]} = ${numbers[2]}`);
      });
    });
    test("check formatting for %d", () => {
      const numbers = [
        [1.4, 2.9, 4.3],
        [1, 1, 2],
        [3.1, 4.5, 7.6],
      ];

      const stderr = runTest({
        args: [],
        input: `
          import { test, expect } from "bun:test";

          test.each(${JSON.stringify(numbers)})("%f + %f = %d", (a, b, e) => {
            expect(a + b).toBe(e);
          });
        `,
      });
      numbers.forEach(numbers => {
        expect(stderr).toContain(`${numbers[0]} + ${numbers[1]} = ${numbers[2]}`);
      });
    });
    test("check formatting for %s", () => {
      const strings = ["hello", "world", "foo"];

      const stderr = runTest({
        args: [],
        input: `
          import { test, expect } from "bun:test";

          test.each(${JSON.stringify(strings)})("with a string: %s", (s) => {
            expect(s).toBeType("string");
          });
        `,
      });
      strings.forEach(s => {
        expect(stderr).toContain(`with a string: ${s}`);
      });
    });
    test("check formatting for %j", () => {
      const input = [
        {
          foo: "bar",
          nested: {
            again: {
              a: 2,
            },
          },
        },
      ];

      const stderr = runTest({
        args: [],
        input: `
          import { test, expect } from "bun:test";

          test.each(${JSON.stringify(input)})("with an object: %o", (o) => {
            expect(o).toBe(o);
          });
        `,
      });
      expect(stderr).toContain(`with an object: ${JSON.stringify(input[0])}`);
    });
    test("check formatting for %o", () => {
      const input = [
        {
          foo: "bar",
          nested: {
            again: {
              a: 2,
            },
          },
        },
      ];

      const stderr = runTest({
        args: [],
        input: `
          import { test, expect } from "bun:test";

          test.each(${JSON.stringify(input)})("with an object: %o", (o) => {
            expect(o).toBe(o);
          });
        `,
      });
      expect(stderr).toContain(`with an object: ${JSON.stringify(input[0])}`);
    });
    test("check formatting for %#", () => {
      const numbers = [
        [1, 2, 3],
        [1, 1, 2],
        [3, 4, 7],
      ];

      const stderr = runTest({
        args: [],
        input: `
          import { test, expect } from "bun:test";

          test.each(${JSON.stringify(numbers)})("test number %#: %i + %i = %i", (a, b, e) => {
            expect(a + b).toBe(e);
          });
        `,
      });
      numbers.forEach((_, idx) => {
        expect(stderr).toContain(`test number ${idx}:`);
      });
    });
    test("check formatting for %%", () => {
      const numbers = [
        [1, 2, 3],
        [1, 1, 2],
        [3, 4, 7],
      ];

      const stderr = runTest({
        args: [],
        input: `
          import { test, expect } from "bun:test";

          test.each(${JSON.stringify(numbers)})("test number %#: %i + %i = %i %%", (a, b, e) => {
            expect(a + b).toBe(e);
          });
        `,
      });
      expect(stderr).toContain(`%`);
    });
    test.todo("check formatting for %p", () => {});

    describe("$variable syntax", () => {
      test("should replace $variables with object properties in test names", () => {
        const cases = [
          { a: 1, b: 2, expected: 3 },
          { a: 5, b: 5, expected: 10 },
          { a: -1, b: 1, expected: 0 },
        ];

        const stderr = runTest({
          args: [],
          input: `
            import { test, expect } from "bun:test";
            
            const cases = ${JSON.stringify(cases)};
            test.each(cases)('$a + $b = $expected', ({ a, b, expected }) => {
              expect(a + b).toBe(expected);
            });
          `,
        });

        expect(stderr).toContain("(pass) 1 + 2 = 3");
        expect(stderr).toContain("(pass) 5 + 5 = 10");
        expect(stderr).toContain("(pass) -1 + 1 = 0");
        expect(stderr).toContain("3 pass");
      });

      test("should show $variable literal when property doesn't exist", () => {
        const cases = [{ a: 1 }, { a: 2 }];

        const stderr = runTest({
          args: [],
          input: `
            import { test, expect } from "bun:test";
            
            const cases = ${JSON.stringify(cases)};
            test.each(cases)('value $a with missing $nonexistent', ({ a }) => {
              expect(a).toBeDefined();
            });
          `,
        });

        expect(stderr).toContain("(pass) value 1 with missing $nonexistent");
        expect(stderr).toContain("(pass) value 2 with missing $nonexistent");
        expect(stderr).toContain("2 pass");
      });

      test("should work with describe.each", () => {
        const cases = [
          { module: "fs", method: "readFile" },
          { module: "path", method: "join" },
        ];

        const stderr = runTest({
          args: [],
          input: `
            import { test, expect, describe } from "bun:test";
            
            const cases = ${JSON.stringify(cases)};
            describe.each(cases)('$module module', ({ module, method }) => {
              test('has $method', () => {
                const mod = require(module);
                expect(mod).toHaveProperty(method);
              });
            });
          `,
        });

        expect(stderr).toContain("fs module > has $method");
        expect(stderr).toContain("path module > has $method");
        expect(stderr).toContain("2 pass");
      });

      test("should work with complex property names", () => {
        const cases = [
          { user_name: "john_doe", age: 30, is_active: true },
          { user_name: "jane_smith", age: 25, is_active: false },
        ];

        const stderr = runTest({
          args: [],
          input: `
            import { test, expect } from "bun:test";
            
            const cases = ${JSON.stringify(cases)};
            test.each(cases)('user $user_name age $age active $is_active', ({ user_name, age, is_active }) => {
              expect(user_name).toBeDefined();
              expect(age).toBeGreaterThan(0);
              expect(typeof is_active).toBe('boolean');
            });
          `,
        });

        expect(stderr).toContain("(pass) user john_doe age 30 active true");
        expect(stderr).toContain("(pass) user jane_smith age 25 active false");
        expect(stderr).toContain("2 pass");
      });

      test("should coexist with % formatting for arrays", () => {
        const numbers = [
          [1, 2, 3],
          [5, 5, 10],
        ];

        const stderr = runTest({
          args: [],
          input: `
            import { test, expect } from "bun:test";
            
            test.each(${JSON.stringify(numbers)})('%i + %i = %i', (a, b, expected) => {
              expect(a + b).toBe(expected);
            });
          `,
        });

        expect(stderr).toContain("(pass) 1 + 2 = 3");
        expect(stderr).toContain("(pass) 5 + 5 = 10");
        expect(stderr).toContain("2 pass");
      });

      test("should support nested property access", () => {
        const cases = [
          {
            user: { name: "Alice", profile: { city: "NYC" } },
            expected: "Alice from NYC",
          },
          {
            user: { name: "Bob", profile: { city: "LA" } },
            expected: "Bob from LA",
          },
        ];

        const stderr = runTest({
          args: [],
          input: `
            import { test, expect } from "bun:test";
            
            const cases = ${JSON.stringify(cases)};
            test.each(cases)('$user.name from $user.profile.city', ({ user, expected }) => {
              expect(\`\${user.name} from \${user.profile.city}\`).toBe(expected);
            });
          `,
        });

        expect(stderr).toContain("(pass) Alice from NYC");
        expect(stderr).toContain("(pass) Bob from LA");
        expect(stderr).toContain("2 pass");
      });

      test("should support array indexing with dot notation", () => {
        const cases = [
          {
            users: [{ name: "Alice" }, { name: "Bob" }],
            first: "Alice",
          },
          {
            users: [{ name: "Carol" }, { name: "Dave" }],
            first: "Carol",
          },
        ];

        const stderr = runTest({
          args: [],
          input: `
            import { test, expect } from "bun:test";
            
            const cases = ${JSON.stringify(cases)};
            test.each(cases)('first user is $users.0.name', ({ users, first }) => {
              expect(users[0].name).toBe(first);
            });
          `,
        });

        expect(stderr).toContain("(pass) first user is Alice");
        expect(stderr).toContain("(pass) first user is Carol");
        expect(stderr).toContain("2 pass");
      });

      test("handles edge cases with underscores and invalid identifiers", () => {
        const cases = [
          {
            _valid: "underscore",
            $dollar: "dollar",
            _123mix: "mix",
            "123invalid": "invalid",
            "has-dash": "dash",
            "has space": "space",
          },
        ];

        const stderr = runTest({
          args: [],
          input: `
            import { test, expect } from "bun:test";
            
            const cases = ${JSON.stringify(cases)};
            test.each(cases)('Edge: $_valid | $$dollar | $_123mix | $123invalid | $has-dash | $has space', (obj) => {
              expect(obj).toBeDefined();
            });
          `,
        });

        expect(stderr).toContain("underscore");
        expect(stderr).toContain("dollar");
        expect(stderr).toContain("mix");
        expect(stderr).toContain("$123invalid");
        expect(stderr).toContain("$hasdash");
        expect(stderr).toContain("$hasspace");
      });

      test("handles deeply nested properties with arrays", () => {
        const cases = [
          {
            data: {
              users: [
                { name: "Alice", tags: ["admin", "user"] },
                { name: "Bob", tags: ["user"] },
              ],
              count: 2,
            },
          },
        ];

        const stderr = runTest({
          args: [],
          input: `
            import { test, expect } from "bun:test";
            
            const cases = ${JSON.stringify(cases)};
            test.each(cases)('First user: $data.users.0.name with tag: $data.users.0.tags.0', (obj) => {
              expect(obj).toBeDefined();
            });
          `,
        });

        expect(stderr).toContain("First user: Alice with tag: admin");
      });

      test("surfaces a throwing custom formatter in the interpolated value as a test error", () => {
        // The declaration throw aborts module evaluation, so each variant
        // needs its own file to be verified independently.
        const throwing = (message: string) =>
          `({ [Symbol.for("nodejs.util.inspect.custom")]() { throw new Error(${JSON.stringify(message)}); } })`;
        const stderr = runTest({
          args: [],
          expectExitCode: 1,
          input: [
            {
              filename: "test-each-path.test.ts",
              contents: `
                import { test } from "bun:test";
                test.each([{ a: { b: ${throwing("boom from test.each $path")} } }])("case $a.b", () => {});
              `,
            },
            {
              filename: "test-each-p.test.ts",
              contents: `
                import { test } from "bun:test";
                test.each([[${throwing("boom from test.each %p")}]])("case %p", () => {});
              `,
            },
            {
              filename: "describe-each-path.test.ts",
              contents: `
                import { test, describe } from "bun:test";
                describe.each([{ a: { b: ${throwing("boom from describe.each $path")} } }])("suite $a.b", () => {
                  test("inner", () => {});
                });
              `,
            },
            {
              filename: "describe-each-p.test.ts",
              contents: `
                import { test, describe } from "bun:test";
                describe.each([[${throwing("boom from describe.each %p")}]])("suite %p", () => {
                  test("inner", () => {});
                });
              `,
            },
          ],
        });

        expect(stderr).toContain("boom from test.each $path");
        expect(stderr).toContain("boom from test.each %p");
        expect(stderr).toContain("boom from describe.each $path");
        expect(stderr).toContain("boom from describe.each %p");
      });

      test("handles missing properties gracefully", () => {
        const cases = [{ a: 1 }];

        const stderr = runTest({
          args: [],
          input: `
            import { test, expect } from "bun:test";
            
            const cases = ${JSON.stringify(cases)};
            test.each(cases)('$a | $missing | $a.b.c | $a', ({ a }) => {
              expect(a).toBe(1);
            });
          `,
        });

        expect(stderr).toContain("1 | $missing| $a.b.c| 1");
      });
    });
  });

  test("Prints error when no test matches", () => {
    const stderr = runTest({
      args: ["-t", "not-a-test"],
      input: `
        import { test, expect } from "bun:test";
        test("test", () => {});
      `,
      expectExitCode: 1,
    });
    expect(
      stderr
        .replace(/bun-test-(.*)\.test\.ts/, "bun-test-*.test.ts")
        .trim()
        .replace(/\[[\d.]+m?s\]/, "[xx ms]"),
    ).toMatchInlineSnapshot(`
      "bun-test-*.test.ts:

      error: regex "not-a-test" matched 0 tests. Searched 1 file (skipping 1 test) [xx ms]"
    `);
  });

  test("Does not print the regex error when a test fails", () => {
    const stderr = runTest({
      args: ["-t", "not-a-test"],
      input: `
        import { test, expect } from "bun:test";
        test("not-a-test", () => {
          expect(false).toBe(true);
        });
      `,
      expectExitCode: 1,
    });
    expect(stderr).not.toContain("error: regex");
    expect(stderr).toContain("1 fail");
  });

  test("Does not print the regex error when a test matches and a test passes", () => {
    const stderr = runTest({
      args: ["-t", "not-a-test"],
      input: `
        import { test, expect } from "bun:test";
        test("not-a-test", () => {
          expect(false).toBe(true); 
        });
        test("not-a-test", () => {
          expect(true).toBe(true);
        });
      `,
      expectExitCode: 1,
    });
    expect(stderr).not.toContain("error: regex");
    expect(stderr).toContain("1 fail");
    expect(stderr).toContain("1 pass");
  });

  test("path to a non-test.ts file will work", () => {
    const stderr = runTest({
      args: ["./index.ts"],
      input: [
        {
          filename: "index.ts",
          contents: `
            import { test, expect } from "bun:test";
            test("test #1", () => {
              expect(true).toBe(true);
            });
          `,
        },
      ],
    });
    expect(stderr).toContain("test #1");
  });

  test("path to a non-test.ts without ./ will print a helpful hint", () => {
    const stderr = runTest({
      args: ["index.ts"],
      input: [
        {
          filename: "index.ts",
          contents: `
            import { test, expect } from "bun:test";
            test("test #1", () => {
              expect(true).toBe(true);
            });
          `,
        },
      ],
    });
    expect(stderr).not.toContain("test #1");
    expect(stderr).toContain("index.ts");
  });

  test("Skipped and todo tests are filtered out when not matching -t filter", () => {
    const stderr = runTest({
      args: ["-t", "should match"],
      input: `
        import { test, describe } from "bun:test";

        describe("group 1", () => {
          test("should match filter", () => {
            console.log("this test should run");
          });

          test("should not match filter", () => {
            console.log("this test should be filtered out");
          });

          test.skip("skipped test that should not match", () => {
            console.log("this skipped test should be filtered out");
          });

          test.todo("todo test that should not match", () => {
            console.log("this todo test should be filtered out");
          });
        });

        describe("group 2", () => {
          test("another test that should match filter", () => {
            console.log("this test should run");
          });

          test.skip("another skipped test", () => {
            console.log("this skipped test should be filtered out");
          });

          test.todo("another todo test", () => {
            console.log("this todo test should be filtered out");
          });
        });
      `,
    });
    expect(
      stderr
        .replace(/bun-test-(.*)\.test\.ts/, "bun-test-*.test.ts")
        .replace(/ \[[\d.]+m?s\]/g, "") // Remove all timings
        .replace(/Ran \d+ tests across \d+ files?\.\s*$/, "Ran 2 tests across 1 file.") // Normalize test counts
        .trim(),
    ).toMatchInlineSnapshot(`
      "bun-test-*.test.ts:
      (pass) group 1 > should match filter
      (pass) group 2 > another test that should match filter

       2 pass
       5 filtered out
       0 fail
      Ran 2 tests across 1 file."
    `);
  });

  test("--tsconfig-override works", () => {
    using dir = tempDir("test-tsconfig-override", {
      "math.test.ts": `
        import { describe, test, expect } from "bun:test";
        import { add } from "@utils/math";
        
        describe("math", () => {
          test("addition", () => {
            expect(add(2, 3)).toBe(5);
          });
        });
      `,
      "src/math.ts": `
        export function add(a: number, b: number) {
          return a + b;
        }
      `,
      "tsconfig.json": `
        {
          "compilerOptions": {
            "paths": {
              "@utils/*": ["./wrong/*"]
            }
          }
        }
      `,
      "test-tsconfig.json": `
        {
          "compilerOptions": {
            "paths": {
              "@utils/*": ["./src/*"]
            }
          }
        }
      `,
    });

    // Test without --tsconfig-override (should fail)
    const failResult = spawnSync({
      cmd: [bunExe(), "test", "math.test.ts"],
      env: bunEnv,
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(failResult.exitCode).not.toBe(0);
    expect(failResult.stderr?.toString() || "").toContain("Cannot find module");

    // Test with --tsconfig-override (should succeed)
    const successResult = spawnSync({
      cmd: [bunExe(), "test", "--tsconfig-override", "test-tsconfig.json", "math.test.ts"],
      env: bunEnv,
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(successResult.exitCode).toBe(0);
    const stdout = successResult.stdout?.toString() || "";
    const stderr = successResult.stderr?.toString() || "";
    const output = stdout + stderr;
    expect(output).toContain("1 pass");
    expect(output).toContain("addition");
  });

  test("--tsconfig-override works with monorepo spec tsconfig", () => {
    using dir = tempDir("test-tsconfig-monorepo", {
      "packages/app/src/index.ts": `
        export function getMessage() {
          return "Hello from app";
        }
      `,
      "packages/app/src/index.test.ts": `
        import { test, expect } from "bun:test";
        import { getMessage } from "@app/index";
        import { formatMessage } from "@shared/utils";
        
        test("app message", () => {
          expect(getMessage()).toBe("Hello from app");
          expect(formatMessage("test")).toBe("Formatted: test");
        });
      `,
      "packages/shared/utils.ts": `
        export function formatMessage(msg: string) {
          return "Formatted: " + msg;
        }
      `,
      "packages/app/tsconfig.json": `
        {
          "compilerOptions": {
            "paths": {
              "@app/*": ["./src/*"]
            }
          }
        }
      `,
      "packages/app/tsconfig.spec.json": `
        {
          "extends": "./tsconfig.json",
          "compilerOptions": {
            "baseUrl": "../..",
            "paths": {
              "@app/*": ["packages/app/src/*"],
              "@shared/*": ["packages/shared/*"]
            }
          }
        }
      `,
    });

    const result = spawnSync({
      cmd: [
        bunExe(),
        "test",
        "--tsconfig-override",
        "./packages/app/tsconfig.spec.json",
        "./packages/app/src/index.test.ts",
      ],
      env: bunEnv,
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    const stdout = result.stdout?.toString() || "";
    const stderr = result.stderr?.toString() || "";
    const output = stdout + stderr;
    expect(output).toContain("1 pass");
    expect(output).toContain("app message");
  });

  // jest and vitest never run a test file's process.on('exit') listeners; node's test harness asserts from them.
  describe.concurrent("process.on('exit') listeners", () => {
    async function runFiles(files: Record<string, string>, ...args: string[]) {
      using dir = tempDir("bun-test-exit-listener", files);
      await using proc = Bun.spawn({
        cmd: [bunExe(), "test", ...args],
        env: bunEnv,
        cwd: String(dir),
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      return { stdout, stderr, exitCode };
    }

    function runFile(name: string, contents: string) {
      return runFiles({ [name]: contents }, name);
    }

    const bunTestFile = (n: number) => `
      import { test } from "bun:test";
      process.on("exit", () => {
        console.log("exit listener ${n} ran");
        process.exit(1);
      });
      test("test ${n}", () => {});
    `;
    const nodeTestFile = (n: number) => `
      import { test } from "node:test";
      process.on("exit", () => process.exit(1));
      test("test ${n}", () => {});
    `;

    test("are not run for a bun:test file", async () => {
      const { stdout, stderr, exitCode } = await runFile("exit.test.ts", bunTestFile(1));
      expect(stdout).not.toContain("exit listener");
      expect(stderr).toContain("1 pass");
      expect(exitCode).toBe(0);
    });

    test("are not run for a file that registers globals-style tests", async () => {
      const { stdout, stderr, exitCode } = await runFile(
        "globals.test.ts",
        `
          process.on("exit", () => {
            console.log("exit listener ran");
            process.exit(1);
          });
          test("a passing test", () => {});
        `,
      );
      expect(stdout).not.toContain("exit listener ran");
      expect(stderr).toContain("1 pass");
      expect(exitCode).toBe(0);
    });

    test("are not run when node:test is only imported", async () => {
      const { stdout, stderr, exitCode } = await runFile(
        "node-import-only.test.ts",
        `
          import { test } from "bun:test";
          import { mock } from "node:test";
          void mock;
          process.on("exit", () => {
            console.log("exit listener ran");
            process.exit(1);
          });
          test("a passing test", () => {});
        `,
      );
      expect(stdout).not.toContain("exit listener ran");
      expect(stderr).toContain("1 pass");
      expect(exitCode).toBe(0);
    });

    test("are not run when only a Worker uses node:test", async () => {
      const { stdout, stderr, exitCode } = await runFiles(
        {
          "worker-uses-node-test.test.ts": `
            import { test } from "bun:test";
            process.on("exit", () => {
              console.log("exit listener ran");
              process.exit(1);
            });
            test("a Worker uses node:test", async () => {
              const worker = new Worker(new URL("./worker.ts", import.meta.url));
              await new Promise((resolve, reject) => {
                worker.addEventListener("message", resolve, { once: true });
                worker.addEventListener("error", e => reject(e.error ?? new Error(e.message)), { once: true });
              });
              worker.terminate();
            });
          `,
          "worker.ts": `
            import { mock } from "node:test";
            mock.fn(() => {});
            postMessage("used");
          `,
        },
        "worker-uses-node-test.test.ts",
      );
      expect(stdout).not.toContain("exit listener ran");
      expect(stderr).toContain("1 pass");
      expect(exitCode).toBe(0);
    });

    test("still run when the file itself calls process.exit()", async () => {
      const { stdout, exitCode } = await runFile(
        "explicit-exit.test.ts",
        `
          import { test } from "bun:test";
          process.on("exit", code => console.log("exit listener ran with", code));
          test("exits", () => process.exit(3));
        `,
      );
      expect(stdout).toContain("exit listener ran with 3");
      expect(exitCode).toBe(3);
    });

    test("run once a node:test API registers a test", async () => {
      const { stdout, stderr, exitCode } = await runFile(
        "node.test.ts",
        `
          import { test } from "node:test";
          process.on("exit", code => console.log("exit listener ran with", code));
          test("a passing test", () => {});
        `,
      );
      expect(stdout).toContain("exit listener ran with 0");
      expect(stderr).toContain("1 pass");
      expect(exitCode).toBe(0);
    });

    test("can fail the run once node:test registered a test, like node's common.mustCall()", async () => {
      const { stderr, exitCode } = await runFile("node-exit-code.test.ts", nodeTestFile(1));
      expect(stderr).toContain("1 pass");
      expect(exitCode).toBe(1);
    });

    test("run for a bun:test file under BUN_TEST_DRAIN_EVENT_LOOP, which the vendored node tests set", async () => {
      using dir = tempDir("bun-test-exit-listener", { "drain.test.ts": bunTestFile(1) });
      await using proc = Bun.spawn({
        cmd: [bunExe(), "test", "drain.test.ts"],
        env: { ...bunEnv, BUN_TEST_DRAIN_EVENT_LOOP: "1" },
        cwd: String(dir),
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      expect(stdout).toContain("exit listener 1 ran");
      expect(stderr).toContain("1 pass");
      expect(exitCode).toBe(1);
    });

    test("are not run in --parallel workers for bun:test files", async () => {
      const { stdout, stderr, exitCode } = await runFiles(
        { "a.test.ts": bunTestFile(1), "b.test.ts": bunTestFile(2) },
        "--parallel=2",
        "a.test.ts",
        "b.test.ts",
      );
      // Worker output is relayed on the coordinator's stderr.
      expect(stdout + stderr).not.toContain("exit listener");
      expect(stderr).toContain("2 pass");
      expect(exitCode).toBe(0);
    });

    // --parallel implies --isolate, and a file's listeners are torn down with its global before the worker exits.
    test("--parallel workers exit cleanly after node:test files; listeners do not reach the run's exit code", async () => {
      const { stderr, exitCode } = await runFiles(
        { "a.test.ts": nodeTestFile(1), "b.test.ts": nodeTestFile(2) },
        "--parallel=2",
        "a.test.ts",
        "b.test.ts",
      );
      expect(stderr).not.toContain("worker crashed");
      expect(stderr).toContain("2 pass");
      expect(exitCode).toBe(0);
    });
  });
});

function createTest(input?: string | (string | { filename: string; contents: string })[], filename?: string): string {
  const cwd = tmpdirSync();
  const inputs = Array.isArray(input) ? input : [input ?? ""];
  for (const input of inputs) {
    const contents = typeof input === "string" ? input : input.contents;
    const name = typeof input === "string" ? (filename ?? `bun-test-${Math.random()}.test.ts`) : input.filename;

    const path = join(cwd, name);
    try {
      writeFileSync(path, contents);
    } catch {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
    }
  }
  return cwd;
}

function runTest({
  input = "",
  cwd,
  args = [],
  env = {},
  expectExitCode = undefined,
}: {
  input?: string | (string | { filename: string; contents: string })[];
  cwd?: string;
  args?: string[];
  env?: Record<string, string | undefined>;
  expectExitCode?: number;
} = {}): string {
  cwd ??= createTest(input);
  try {
    const { stderr, exitCode } = spawnSync({
      cwd,
      cmd: [bunExe(), "test", ...args],
      env: { ...bunEnv, AGENT: "0", ...env },
      stderr: "pipe",
      stdout: "ignore",
    });
    if (expectExitCode !== undefined) {
      expect(exitCode).toBe(expectExitCode);
    }
    return stderr.toString();
  } finally {
    rmSync(cwd, { recursive: true });
  }
}

describe.concurrent("test file discovery (scanner)", () => {
  test("discovers tests in deeply nested directories and prunes dot-dirs and node_modules", async () => {
    const files: Record<string, string> = {
      "a_first.test.ts": `import { test } from "bun:test"; test("a", () => { console.log("RAN a_first"); });`,
      "b_second.test.ts": `import { test } from "bun:test"; test("b", () => { console.log("RAN b_second"); });`,
      "styles.spec.tsx": `import { test } from "bun:test"; test("spec", () => { console.log("RAN spec"); });`,
      "not-a-test.ts": `console.log("SHOULD NOT RUN plain");`,
      "nested/deep/inner.test.ts": `import { test } from "bun:test"; test("inner", () => { console.log("RAN inner"); });`,
      "nested/util.ts": `export const x = 1;`,
      ".hidden/skipped.test.ts": `import { test } from "bun:test"; test("hidden", () => { console.log("SHOULD NOT RUN hidden"); });`,
      "node_modules/pkg/skipped.test.ts": `import { test } from "bun:test"; test("nm", () => { console.log("SHOULD NOT RUN node_modules"); });`,
    };
    // Long directory chain so the scanner's directory FIFO and per-directory
    // reads are exercised many times in a single scan.
    let prefix = "chain";
    for (let i = 0; i < 32; i++) {
      prefix += `/d${i}`;
      files[`${prefix}/leaf${i}.test.ts`] = `import { test } from "bun:test"; test("leaf${i}", () => {});`;
    }
    using dir = tempDir("scanner-discovery", files);

    await using proc = Bun.spawn({
      cmd: [bunExe(), "test"],
      env: bunEnv,
      cwd: String(dir),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);

    expect(stdout).toContain("RAN a_first");
    expect(stdout).toContain("RAN b_second");
    expect(stdout).toContain("RAN spec");
    expect(stdout).toContain("RAN inner");
    expect(stdout).not.toContain("SHOULD NOT RUN");
    // 4 named tests + 32 chain leaves
    expect(stderr).toContain(" 36 pass");
    expect(exitCode).toBe(0);
  });

  test("scanning a relative subdirectory only runs tests under it", async () => {
    using dir = tempDir("scanner-subdir", {
      "root_only.test.ts": `import { test } from "bun:test"; test("root", () => { console.log("RAN root"); });`,
      "nested/inner.test.ts": `import { test } from "bun:test"; test("inner", () => { console.log("RAN inner"); });`,
      "nested/deeper/most.test.ts": `import { test } from "bun:test"; test("most", () => { console.log("RAN most"); });`,
    });

    await using proc = Bun.spawn({
      cmd: [bunExe(), "test", "./nested"],
      env: bunEnv,
      cwd: String(dir),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);

    expect(stdout).toContain("RAN inner");
    expect(stdout).toContain("RAN most");
    expect(stdout).not.toContain("RAN root");
    expect(stderr).toContain(" 2 pass");
    expect(exitCode).toBe(0);
  });

  test("scanning a relative file path that is not a directory runs that single file", async () => {
    using dir = tempDir("scanner-single-file", {
      "solo.test.ts": `import { test } from "bun:test"; test("solo", () => { console.log("RAN solo"); });`,
      "other.test.ts": `import { test } from "bun:test"; test("other", () => { console.log("RAN other"); });`,
    });

    await using proc = Bun.spawn({
      cmd: [bunExe(), "test", "./solo.test.ts"],
      env: bunEnv,
      cwd: String(dir),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);

    expect(stdout).toContain("RAN solo");
    expect(stdout).not.toContain("RAN other");
    expect(stderr).toContain(" 1 pass");
    expect(exitCode).toBe(0);
  });

  // The scanner builds every absolute path in a PathBuffer of MAX_PATH_BYTES:
  // 4096 on Linux, 1024 on every other POSIX (src/bun_core/util.rs). On Windows
  // it is 32767*3+1 bytes, more than a command line or an NT path can hold, so
  // the overflow is unreachable there.
  const maxPathBytes = isLinux ? 4096 : 1024;
  const existsTest = `import { test } from "bun:test"; test("exists", () => {});`;

  for (const [kind, prefix, len] of [
    ["absolute", "/", 5000],
    ["absolute", "/", 100_000],
    ["relative", "./", 5000],
  ] as const) {
    test.skipIf(isWindows)(
      `${kind} path argument of ${len} bytes (longer than MAX_PATH_BYTES) reports no match instead of panicking`,
      async () => {
        using dir = tempDir("scanner-long-arg", { "exists.test.ts": existsTest });
        const longArg = prefix + Buffer.alloc(len, "a").toString() + ".test.ts";

        await using proc = Bun.spawn({
          cmd: [bunExe(), "test", longArg],
          env: bunEnv,
          cwd: String(dir),
          stderr: "pipe",
        });
        const [stderr, exitCode] = await Promise.all([proc.stderr.text(), proc.exited]);

        expect(stderr).toContain("had no matches");
        expect(exitCode).toBe(1);
      },
    );
  }

  test.skipIf(isWindows)(
    "a path argument longer than MAX_PATH_BYTES is skipped like a missing path when other arguments match",
    async () => {
      using dir = tempDir("scanner-long-arg-mixed", { "exists.test.ts": existsTest });
      const longArg = "/" + Buffer.alloc(5000, "a").toString() + ".test.ts";

      await using proc = Bun.spawn({
        cmd: [bunExe(), "test", "./exists.test.ts", longArg],
        env: bunEnv,
        cwd: String(dir),
        stderr: "pipe",
      });
      const [stderr, exitCode] = await Promise.all([proc.stderr.text(), proc.exited]);

      expect(stderr).toContain("Ran 1 test across 1 file.");
      expect(exitCode).toBe(0);
    },
  );

  // The directory walk joins parent + entry name for every directory it
  // descends into and every candidate test file. With pathIgnorePatterns
  // configured it additionally joins each directory before queueing it, so the
  // same tree is scanned once per configuration to reach both code paths.
  for (const [config, files] of [
    ["no bunfig", {}],
    ["pathIgnorePatterns configured", { "bunfig.toml": `[test]\npathIgnorePatterns = ["unrelated/**"]\n` }],
  ] as const) {
    test.skipIf(isWindows)(
      `entries whose absolute path exceeds MAX_PATH_BYTES are skipped during the directory walk (${config})`,
      async () => {
        using dir = tempDir("scanner-deep-tree", {
          ...files,
          "shallow.test.ts": `import { test } from "bun:test"; test("shallow", () => {});`,
        });
        const root = String(dir);
        // Each level adds "/" + segment = 255 bytes. The deepest directory the
        // scanner can still open is the last one whose path is at most
        // maxPathBytes - 1 (it reserves one byte for the NUL); the directory
        // below it is skipped. A 255-byte name in the deepest directory
        // overflows too: that directory is at most 254 bytes short of the limit
        // and the name adds 256. The deepest directory gets three such entries:
        // a test file, a subdirectory, and a symlink. readdir does not report a
        // symlink's kind, so the scanner stats it first, and that stat builds
        // the path through the resolver (RealFS::kind) rather than through the
        // scanner's own joins.
        const segment = Buffer.alloc(254, "d").toString();
        const longTestFile = Buffer.alloc(247, "f").toString() + ".test.ts";
        const longTestLink = Buffer.alloc(247, "l").toString() + ".test.ts";
        const fitDepth = Math.floor((maxPathBytes - 1 - root.length) / (segment.length + 1));
        expect([longTestFile.length, longTestLink.length]).toEqual([255, 255]);
        expect(root.length + fitDepth * 255 + 256).toBeGreaterThan(maxPathBytes);

        // The over-long entries cannot be addressed by absolute path
        // (ENAMETOOLONG), so walk down the chain and create them relative to
        // the deepest directory.
        const script = ["set -e"];
        for (let level = 1; level <= fitDepth; level++) {
          script.push(`mkdir ${segment} && cd ${segment}`);
        }
        script.push(`touch ${longTestFile}`, `ln -s ${longTestFile} ${longTestLink}`, `mkdir ${segment}`);
        await using setup = Bun.spawn({
          cmd: ["bash", "-c", script.join("\n")],
          env: bunEnv,
          cwd: root,
          stderr: "pipe",
        });
        const [setupStderr, setupExitCode] = await Promise.all([setup.stderr.text(), setup.exited]);
        expect(setupStderr).toBe("");
        expect(setupExitCode).toBe(0);

        await using proc = Bun.spawn({
          cmd: [bunExe(), "test"],
          env: bunEnv,
          cwd: root,
          stderr: "pipe",
        });
        const [stderr, exitCode] = await Promise.all([proc.stderr.text(), proc.exited]);

        expect(stderr).toContain("shallow.test.ts:");
        expect(stderr).toContain("Ran 1 test across 1 file.");
        expect(exitCode).toBe(0);
      },
    );
  }

  // https://github.com/oven-sh/bun/issues/39852
  test.skipIf(isWindows)("does not keep a directory fd open per scanned directory", async () => {
    const N = 64;
    const files: Record<string, string> = {};
    for (let i = 0; i < N; i++) {
      files[`sub${i}/a/b/c/.gitkeep`] = "";
    }
    files["sub0/probe.test.ts"] = /* ts */ `
      import { test } from "bun:test";
      import { readdirSync } from "node:fs";
      test("probe", () => {
        console.log("OPEN_FDS=" + readdirSync(process.platform === "linux" ? "/proc/self/fd" : "/dev/fd").length);
      });
    `;
    using dir = tempDir("scanner-dir-fds", files);

    await using proc = Bun.spawn({
      cmd: [bunExe(), "test", "probe"],
      env: bunEnv,
      cwd: String(dir),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    // 4N+1 directories are scanned; none of them may stay open.
    expect(Number(stdout.match(/OPEN_FDS=(\d+)/)?.[1])).toBeLessThan(N);
    expect(stderr).toContain(" 1 pass");
    expect(exitCode).toBe(0);
  });
});

describe.concurrent("testMatch", () => {
  const passing = (name: string) =>
    `import { test, expect } from "bun:test";\ntest(${JSON.stringify(name)}, () => {\n  expect(1).toBe(1);\n});\n`;
  // Not a test, and says so when a run loads it.
  const script = `console.log("NOT A TEST");\n`;

  /** Runs `bun test` in `cwd`. `files` is the test files that ran, sorted. */
  async function run(cwd: string, args: string[] = [], env: Record<string, string> = {}) {
    await using proc = Bun.spawn({
      cmd: [bunExe(), "test", ...args],
      cwd,
      env: { ...bunEnv, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    // Every file that runs gets a line of its own: its path and a colon.
    const files = Array.from(stderr.matchAll(/^(\S+):$/gm), match => match[1].replaceAll("\\", "/")).sort();
    return { files, stdout, stderr, exitCode };
  }

  /** The file column of the `--coverage` table, without its two header rows. */
  function coveredFiles(stderr: string) {
    return stderr
      .split("\n")
      .filter(line => line.includes("|"))
      .map(line => line.split("|")[0].trim().replaceAll("\\", "/"))
      .filter(file => file !== "File" && file !== "All files" && !/^-+$/.test(file))
      .sort();
  }

  test("bunfig: the patterns replace the default names", async () => {
    using dir = tempDir("test-match", {
      "bunfig.toml": `[test]\ntestMatch = ["**/*.unit.ts", "**/*.int.ts"]\n`,
      "src/cart.unit.ts": passing("cart unit"),
      "src/db.int.ts": passing("db int"),
      "src/legacy.test.ts": passing("default name"),
      "src/cart.ts": `export const cart = [];\n`,
    });

    const { files, stderr, exitCode } = await run(String(dir));
    expect(files).toEqual(["src/cart.unit.ts", "src/db.int.ts"]);
    expect(stderr).toContain(" 2 pass");
    expect(exitCode).toBe(0);
  });

  test("bunfig: a single string, and a pattern that starts at the project root", async () => {
    using dir = tempDir("test-match", {
      "bunfig.toml": `[test]\ntestMatch = "checks/**"\n`,
      "checks/one.ts": passing("one"),
      "checks/deep/two.js": passing("two"),
      "src/checks/three.ts": passing("not at the root"),
      "other.test.ts": passing("default name"),
    });

    const { files, stderr, exitCode } = await run(String(dir));
    expect(files).toEqual(["checks/deep/two.js", "checks/one.ts"]);
    expect(stderr).toContain(" 2 pass");
    expect(exitCode).toBe(0);
  });

  test("bunfig: an empty array leaves the default names in place", async () => {
    using dir = tempDir("test-match", {
      "bunfig.toml": `[test]\ntestMatch = []\n`,
      "a.test.ts": passing("default name"),
      "b.unit.ts": passing("unit"),
    });

    const [plain, flag] = await Promise.all([run(String(dir)), run(String(dir), ["--test-match", "*.unit.ts"])]);
    expect(plain.files).toEqual(["a.test.ts"]);
    expect(plain.exitCode).toBe(0);
    expect(flag.files).toEqual(["b.unit.ts"]);
    expect(flag.exitCode).toBe(0);
  });

  test("a pattern for a directory runs the files in it that Bun loads as code", async () => {
    using dir = tempDir("test-match", {
      "bunfig.toml": `[test]\ntestMatch = ["tests/**"]\n`,
      "tests/api.ts": passing("api"),
      "tests/ui/button.tsx": passing("button"),
      "tests/data.json": `{"a": 1}\n`,
      "tests/README.md": `# tests\n`,
      "tests/styles.css": `body { color: red }\n`,
      "tests/__snapshots__/api.ts.snap": `// Bun Snapshot v1\n`,
      "src/api.test.ts": passing("default name"),
    });

    const { files, stderr, exitCode } = await run(String(dir));
    expect(files).toEqual(["tests/api.ts", "tests/ui/button.tsx"]);
    expect(stderr).toContain(" 2 pass");
    expect(exitCode).toBe(0);
  });

  test("the defaults of Jest and of Vitest work as they are written", async () => {
    const files = {
      "src/__tests__/a.js": passing("a"),
      "src/__tests__/util.tsx": passing("util"),
      "src/b.test.ts": passing("b"),
      "src/c.spec.jsx": passing("c"),
      "src/d.test.mts": passing("d"),
      "src/test.ts": passing("test"),
      "lib/e_test.ts": passing("a test for Bun only"),
      "lib/f.tests.ts": passing("not a test"),
    };
    using jest = tempDir("test-match", {
      ...files,
      "bunfig.toml": `[test]\ntestMatch = ["**/__tests__/**/*.[jt]s?(x)", "**/?(*.)+(spec|test).[jt]s?(x)"]\n`,
    });
    using vitest = tempDir("test-match", {
      ...files,
      "bunfig.toml": `[test]\ntestMatch = ["**/*.{test,spec}.?(c|m)[jt]s?(x)"]\n`,
    });

    const [asJest, asVitest] = await Promise.all([run(String(jest)), run(String(vitest))]);
    expect(asJest.files).toEqual([
      "src/__tests__/a.js",
      "src/__tests__/util.tsx",
      "src/b.test.ts",
      "src/c.spec.jsx",
      "src/test.ts",
    ]);
    expect(asJest.exitCode).toBe(0);
    expect(asVitest.files).toEqual(["src/b.test.ts", "src/c.spec.jsx", "src/d.test.mts"]);
    expect(asVitest.exitCode).toBe(0);
  });

  test("the default names of Bun, written as a pattern next to another", async () => {
    const files = {
      "top.test.ts": passing("top"),
      "src/a.test.tsx": passing("a"),
      "src/b_test.js": passing("b"),
      "src/c.spec.mjs": passing("c"),
      "src/deep/d_spec.cts": passing("d"),
      "src/e.test.d.ts": script,
      "src/f.test.helper.ts": script,
      "src/g.tests.ts": script,
      "src/test.ts": script,
      "src/h.unit.ts": passing("h"),
    };
    using defaults = tempDir("test-match", files);
    using pattern = tempDir("test-match", {
      ...files,
      "bunfig.toml": `[test]\ntestMatch = ["**/*{.,_}{test,spec}.{js,jsx,ts,tsx,mjs,cjs,mts,cts}", "**/*.unit.ts"]\n`,
    });

    const [byDefault, byPattern] = await Promise.all([run(String(defaults)), run(String(pattern))]);
    expect(byDefault.files).toEqual([
      "src/a.test.tsx",
      "src/b_test.js",
      "src/c.spec.mjs",
      "src/deep/d_spec.cts",
      "top.test.ts",
    ]);
    expect(byPattern.files).toEqual([...byDefault.files, "src/h.unit.ts"].sort());
    expect(byPattern.stdout).not.toContain("NOT A TEST");
    expect(byPattern.exitCode).toBe(0);
  });

  test("a group with alternatives needs no prefix, as in Jest", async () => {
    using dir = tempDir("test-match", {
      "src/__tests__/api.js": passing("api"),
      "src/cart.test.js": passing("cart"),
      "src/user.spec.jsx": passing("user"),
      "src/a.unit.ts": passing("unit"),
      "src/b.int.ts": passing("int"),
      "src/cart.js": script,
      "app/(marketing)/page.check.ts": passing("in a directory with parentheses"),
      "app/marketing/page.check.ts": passing("in a directory without"),
    });

    const [oldJest, suffixes, directory, both] = await Promise.all([
      // The default of old Jest versions.
      run(String(dir), ["--test-match", "**/__tests__/**/*.js?(x)", "--test-match", "**/?(*.)(spec|test).js?(x)"]),
      run(String(dir), ["--test-match", "**/*.(unit|int).ts"]),
      // Parentheses without a `|` are text.
      run(String(dir), ["--test-match", "app/(marketing)/**"]),
      run(String(dir), ["--test-match", "(src|app)/**/*.(unit|check).ts", "--test-match", "!app/(marketing)/**"]),
    ]);
    expect(oldJest.files).toEqual(["src/__tests__/api.js", "src/cart.test.js", "src/user.spec.jsx"]);
    expect(oldJest.stdout).not.toContain("NOT A TEST");
    expect(suffixes.files).toEqual(["src/a.unit.ts", "src/b.int.ts"]);
    expect(directory.files).toEqual(["app/(marketing)/page.check.ts"]);
    expect(both.files).toEqual(["app/marketing/page.check.ts", "src/a.unit.ts"]);
  });

  test("--test-match, more than once", async () => {
    using dir = tempDir("test-match", {
      "src/cart.unit.ts": passing("unit"),
      "src/cart.e2e.ts": passing("e2e"),
      "src/cart.int.ts": passing("int"),
      "src/cart.test.ts": passing("default name"),
    });

    const { files, stderr, exitCode } = await run(String(dir), [
      "--test-match",
      "**/*.unit.ts",
      "--test-match=**/*.e2e.ts",
    ]);
    expect(files).toEqual(["src/cart.e2e.ts", "src/cart.unit.ts"]);
    expect(stderr).toContain(" 2 pass");
    expect(exitCode).toBe(0);
  });

  test("--test-match replaces testMatch from bunfig.toml", async () => {
    using dir = tempDir("test-match", {
      "bunfig.toml": `[test]\ntestMatch = ["**/*.unit.ts"]\n`,
      "src/cart.unit.ts": passing("unit"),
      "src/cart.int.ts": passing("int"),
    });

    const { files, exitCode } = await run(String(dir), ["--test-match", "**/*.int.ts"]);
    expect(files).toEqual(["src/cart.int.ts"]);
    expect(exitCode).toBe(0);
  });

  test("negated patterns: the last pattern that has a say decides", async () => {
    using dir = tempDir("test-match", {
      "bunfig.toml": `[test]\ntestMatch = ["tests/**", "!**/helpers/**", "tests/helpers/kept.ts"]\n`,
      "tests/a.ts": passing("a"),
      "tests/helpers/util.ts": script,
      "tests/helpers/kept.ts": passing("kept"),
    });

    const { files, stdout, exitCode } = await run(String(dir));
    expect(files).toEqual(["tests/a.ts", "tests/helpers/kept.ts"]);
    expect(stdout).not.toContain("NOT A TEST");
    expect(exitCode).toBe(0);
  });

  test("only negated patterns take files away from the default names", async () => {
    using dir = tempDir("test-match", {
      "bunfig.toml": `[test]\ntestMatch = ["!**/fixtures/**", "!e2e/**"]\n`,
      "src/a.test.ts": passing("a"),
      "lib/b_spec.js": passing("b"),
      "fixtures/c.test.ts": passing("fixture"),
      "e2e/d.test.ts": passing("e2e"),
      "scripts/deploy.ts": script,
    });

    const { files, stdout, stderr, exitCode } = await run(String(dir));
    expect(files).toEqual(["lib/b_spec.js", "src/a.test.ts"]);
    expect(stdout).not.toContain("NOT A TEST");
    expect(stderr).toContain(" 2 pass");
    expect(exitCode).toBe(0);
  });

  test("a !(a|b) group in front takes files away, as in Jest", async () => {
    using dir = tempDir("test-match", {
      "bunfig.toml": `[test]\ntestMatch = ["**/*.test.ts", "!(fixtures|e2e)/**"]\n`,
      "src/a.test.ts": passing("a"),
      "src/a.ts": script,
      "fixtures/f.test.ts": passing("fixture"),
      "e2e/x.test.ts": passing("e2e"),
    });

    const { files, stdout, exitCode } = await run(String(dir));
    expect(files).toEqual(["src/a.test.ts"]);
    expect(stdout).not.toContain("NOT A TEST");
    expect(exitCode).toBe(0);
  });

  test("a leading ./ or <rootDir>/ is dropped from a pattern", async () => {
    using dir = tempDir("test-match", {
      "bunfig.toml": `[test]\ntestMatch = ["./unit/**/*.ts", "<rootDir>/e2e/**/*.ts", "<rootDir>smoke/*.ts", "!./unit/skip/**"]\n`,
      "unit/a.ts": passing("a"),
      "unit/skip/c.ts": passing("skipped"),
      "e2e/b.ts": passing("b"),
      "smoke/e.ts": passing("e"),
      "other/d.ts": passing("other"),
    });

    const { files, exitCode } = await run(String(dir));
    expect(files).toEqual(["e2e/b.ts", "smoke/e.ts", "unit/a.ts"]);
    expect(exitCode).toBe(0);
  });

  test("what stands behind a dropped prefix keeps its meaning", async () => {
    using dir = tempDir("test-match", {
      "(group)/page.unit.ts": passing("in the group"),
      "(group)/plain.ts": script,
      "group/y.unit.ts": passing("y"),
      "other/x.unit.ts": passing("x"),
      "other/plain.ts": script,
      "!important/a.ts": passing("important"),
    });

    const [negated, rootDir, bang] = await Promise.all([
      // Not the group `!(group)/**`, which is every other directory.
      run(String(dir), ["--test-match", "**/*.unit.ts", "--test-match", "!./(group)/**"]),
      run(String(dir), ["--test-match", "**/*.unit.ts", "--test-match", "!<rootDir>/(group)/**"]),
      // Not a negation.
      run(String(dir), ["--test-match", "./!important/**"]),
    ]);
    expect(negated.files).toEqual(["group/y.unit.ts", "other/x.unit.ts"]);
    expect(negated.stdout).not.toContain("NOT A TEST");
    expect(rootDir.files).toEqual(["group/y.unit.ts", "other/x.unit.ts"]);
    expect(bang.files).toEqual(["!important/a.ts"]);
  });

  test("positional filters narrow what testMatch names", async () => {
    using dir = tempDir("test-match", {
      "bunfig.toml": `[test]\ntestMatch = ["**/*.unit.ts"]\n`,
      "src/cart.unit.ts": passing("cart unit"),
      "src/user.unit.ts": passing("user unit"),
      "src/cart.test.ts": passing("default name"),
    });

    const { files, exitCode } = await run(String(dir), ["cart"]);
    expect(files).toEqual(["src/cart.unit.ts"]);
    expect(exitCode).toBe(0);
  });

  test("pathIgnorePatterns, node_modules and hidden directories still exclude", async () => {
    using dir = tempDir("test-match", {
      "bunfig.toml": `[test]\ntestMatch = ["**/*.unit.ts"]\npathIgnorePatterns = ["vendor/**"]\n`,
      "src/a.unit.ts": passing("a"),
      "vendor/b.unit.ts": passing("vendored"),
      "node_modules/pkg/c.unit.ts": passing("dependency"),
      ".cache/d.unit.ts": passing("hidden"),
    });

    const { files, exitCode } = await run(String(dir));
    expect(files).toEqual(["src/a.unit.ts"]);
    expect(exitCode).toBe(0);
  });

  test("a file path on the command line runs whether or not it matches", async () => {
    using dir = tempDir("test-match", {
      "bunfig.toml": `[test]\ntestMatch = ["**/*.unit.ts"]\n`,
      "a.unit.ts": passing("unit"),
      "scratch.ts": passing("scratch"),
    });

    const [scanned, named] = await Promise.all([run(String(dir)), run(String(dir), ["./scratch.ts"])]);
    expect(scanned.files).toEqual(["a.unit.ts"]);
    expect(named.files).toEqual(["scratch.ts"]);
    expect(named.exitCode).toBe(0);
  });

  test("a directory on the command line is scanned with patterns relative to the project", async () => {
    using dir = tempDir("test-match", {
      "project/bunfig.toml": `[test]\ntestMatch = ["pkg/*.unit.ts", "../sibling/*.unit.ts"]\n`,
      "project/pkg/a.unit.ts": passing("a"),
      "project/pkg/b.test.ts": passing("default name"),
      "project/pkg/nested/c.unit.ts": passing("nested"),
      "project/other/d.unit.ts": passing("other"),
      "sibling/e.unit.ts": passing("outside the project"),
      "sibling/nested/f.unit.ts": passing("nested outside"),
    });
    const project = join(String(dir), "project");

    const [inside, outside] = await Promise.all([run(project, ["./pkg"]), run(project, ["../sibling"])]);
    expect(inside.files).toEqual(["pkg/a.unit.ts"]);
    expect(inside.exitCode).toBe(0);
    expect(outside.files).toEqual(["../sibling/e.unit.ts"]);
    expect(outside.exitCode).toBe(0);
  });

  test("root: patterns stay relative to the project, and <rootDir> is root", async () => {
    const files = {
      "packages/a/checks/x.ts": passing("x"),
      "packages/a/src/y.ts": `export const y = 1;\n`,
      "packages/a/src/y.test.ts": passing("default name"),
      "packages/b/checks/z.ts": passing("z"),
      "a/checks/outside.ts": passing("outside root"),
    };
    using relative = tempDir("test-match", {
      ...files,
      "bunfig.toml": `[test]\nroot = "packages"\ntestMatch = ["packages/*/checks/*.ts"]\n`,
    });
    using rootDir = tempDir("test-match", {
      ...files,
      "bunfig.toml": `[test]\nroot = "./packages/"\ntestMatch = ["<rootDir>/a/checks/*.ts"]\n`,
    });

    const [byProject, byRootDir] = await Promise.all([run(String(relative)), run(String(rootDir))]);
    expect(byProject.files).toEqual(["packages/a/checks/x.ts", "packages/b/checks/z.ts"]);
    expect(byProject.exitCode).toBe(0);
    expect(byRootDir.files).toEqual(["packages/a/checks/x.ts"]);
    expect(byRootDir.exitCode).toBe(0);
  });

  test("an extension needs a loader for code", async () => {
    const files = {
      "a.check": passing("check"),
      "b.test.ts": passing("default name"),
    };
    using without = tempDir("test-match", {
      ...files,
      "bunfig.toml": `[test]\ntestMatch = ["**/*.check"]\n`,
    });
    using withLoader = tempDir("test-match", {
      ...files,
      "bunfig.toml": `[test]\ntestMatch = ["**/*.check"]\n\n[loader]\n".check" = "ts"\n`,
    });

    const [none, loaded] = await Promise.all([run(String(without)), run(String(withLoader))]);
    expect(none.files).toEqual([]);
    expect(none.stderr).toContain("No tests found!");
    expect(none.stderr).toContain(
      `note: Bun does not run ".check" files as code. Map the extension in bunfig.toml: [loader] ".check" = "ts"`,
    );
    expect(none.exitCode).toBe(1);
    expect(loaded.files).toEqual(["a.check"]);
    expect(loaded.stderr).toContain(" 1 pass");
    expect(loaded.exitCode).toBe(0);
  });

  test("a plugin can load what testMatch names", async () => {
    using dir = tempDir("test-match", {
      "bunfig.toml": `[test]
testMatch = ["features/**/*.feature"]
preload = ["./feature-plugin.ts"]

[loader]
".feature" = "ts"
`,
      "feature-plugin.ts": `import { plugin } from "bun";

plugin({
  name: "feature",
  setup(build) {
    build.onLoad({ filter: /\\.feature$/ }, async args => {
      const text = await Bun.file(args.path).text();
      const scenarios = Array.from(text.matchAll(/^\\s*Scenario: (.+)$/gm), match => match[1]);
      return {
        contents:
          'import { test, expect } from "bun:test";\\n' +
          scenarios.map(name => "test(" + JSON.stringify(name) + ", () => { expect(true).toBe(true); });").join("\\n"),
        loader: "ts",
      };
    });
  },
});
`,
      "features/login.feature": `Feature: Login
  Scenario: a user logs in
    Given a user
  Scenario: a wrong password is rejected
    Given a user
`,
      "features/login.test.ts": passing("default name"),
    });

    const { files, stderr, exitCode } = await run(String(dir));
    expect(files).toEqual(["features/login.feature"]);
    expect(stderr).toContain("(pass) a user logs in");
    expect(stderr).toContain("(pass) a wrong password is rejected");
    expect(stderr).toContain(" 2 pass");
    expect(exitCode).toBe(0);
  });

  test("no file matches: the message names the patterns", async () => {
    using dir = tempDir("test-match", {
      "bunfig.toml": `[test]\ntestMatch = ["**/*.unit.ts", "checks/**"]\n`,
      "a.test.ts": passing("default name"),
    });

    const [plain, filtered, allowed, agent, flag] = await Promise.all([
      run(String(dir)),
      run(String(dir), ["cart"]),
      run(String(dir), ["--pass-with-no-tests"]),
      run(String(dir), [], { AGENT: "1" }),
      run(String(dir), ["--test-match", "nothing/**"]),
    ]);

    expect(plain.files).toEqual([]);
    expect(plain.stderr).toContain("No tests found!");
    expect(plain.stderr).toContain(`Tests need a path that matches testMatch: "**/*.unit.ts", "checks/**"`);
    expect(plain.stderr).not.toContain(`".test"`);
    expect(plain.stderr).not.toContain("note:");
    expect(plain.exitCode).toBe(1);

    expect(filtered.stderr).toContain("The following filters did not match any test files:");
    expect(filtered.stderr).toContain(`note: Tests need a path that matches testMatch: "**/*.unit.ts", "checks/**"`);
    expect(filtered.stderr).not.toContain(`".test"`);
    expect(filtered.exitCode).toBe(1);

    expect(allowed.exitCode).toBe(0);

    expect(agent.stderr).toContain(`error: 0 test files matching testMatch "**/*.unit.ts", "checks/**" in --cwd=`);
    expect(agent.exitCode).toBe(1);

    // The list that the scan asked.
    expect(flag.stderr).toContain(`Tests need a path that matches testMatch: "nothing/**"`);
    expect(flag.exitCode).toBe(1);
  });

  test.each([
    [`testMatch = 123`, "testMatch must be a string or array of strings"],
    [`testMatch = ["**/*.unit.ts", 123]`, "testMatch array must contain only strings"],
    [`testMatch = ""`, "testMatch cannot be an empty string"],
    [`testMatch = ["**/*.unit.ts", ""]`, "testMatch patterns cannot be empty strings"],
  ])("bunfig: %s is an error", async (line, message) => {
    using dir = tempDir("test-match", {
      "bunfig.toml": `[test]\n${line}\n`,
      "a.test.ts": passing("default name"),
    });

    // `--test-match` replaces a list. It does not make a wrong one right.
    const [plain, flag] = await Promise.all([run(String(dir)), run(String(dir), ["--test-match", "*.test.ts"])]);
    for (const { files, stderr, exitCode } of [plain, flag]) {
      expect(stderr).toContain(message);
      expect(files).toEqual([]);
      expect(exitCode).toBe(1);
    }
  });

  test("--test-match with an empty pattern is an error", async () => {
    using dir = tempDir("test-match", {
      "a.test.ts": passing("default name"),
    });

    const { files, stderr, exitCode } = await run(String(dir), ["--test-match", ""]);
    expect(stderr).toContain("error: --test-match expects a glob pattern");
    expect(files).toEqual([]);
    expect(exitCode).toBe(1);
  });

  describe("coverageSkipTestFiles", () => {
    const project = {
      "src/math.ts": `export function add(a: number, b: number) {\n  return a + b;\n}\n`,
      // Has a default test name, and is no test where bunfig.toml has a testMatch.
      "src/shared.test.ts": `export function twice(n: number) {\n  return n * 2;\n}\n`,
      "src/math.unit.ts": `import { test, expect } from "bun:test";
import { add } from "./math";
import { twice } from "./shared.test";
test("add", () => {
  expect(twice(add(1, 2))).toBe(6);
});
`,
      "src/more.unit.ts": `import { test, expect } from "bun:test";
import { add } from "./math";
test("add again", () => {
  expect(add(2, 2)).toBe(4);
});
`,
    };

    test("leaves out the files that testMatch names", async () => {
      using skipped = tempDir("test-match", {
        ...project,
        "bunfig.toml": `[test]\ntestMatch = ["**/*.unit.ts"]\ncoverageSkipTestFiles = true\n`,
      });
      using kept = tempDir("test-match", {
        ...project,
        "bunfig.toml": `[test]\ntestMatch = ["**/*.unit.ts"]\ncoverageSkipTestFiles = false\n`,
      });

      const [skip, keep] = await Promise.all([run(String(skipped), ["--coverage"]), run(String(kept), ["--coverage"])]);

      expect(skip.files).toEqual(["src/math.unit.ts", "src/more.unit.ts"]);
      expect(coveredFiles(skip.stderr)).toEqual(["src/math.ts", "src/shared.test.ts"]);
      expect(skip.exitCode).toBe(0);

      expect(coveredFiles(keep.stderr)).toEqual([
        "src/math.ts",
        "src/math.unit.ts",
        "src/more.unit.ts",
        "src/shared.test.ts",
      ]);
      expect(keep.exitCode).toBe(0);
    });

    test("--test-match leaves out the tests it did not ask for too", async () => {
      // Without a testMatch in bunfig.toml those are the default names.
      using defaults = tempDir("test-match", {
        ...project,
        "bunfig.toml": `[test]\ncoverageSkipTestFiles = true\n`,
      });
      // With one, they are what it names.
      using listed = tempDir("test-match", {
        ...project,
        "src/math.int.ts": `import { add } from "./math";\nexport const three = add(1, 2);\n`,
        "src/helper.ts": `import "./math.int";\nexport const helper = true;\n`,
        "src/more.unit.ts": `import { test, expect } from "bun:test";
import { add } from "./math";
import "./helper";
test("add again", () => {
  expect(add(2, 2)).toBe(4);
});
`,
        "bunfig.toml": `[test]\ntestMatch = ["**/*.unit.ts", "**/*.int.ts"]\ncoverageSkipTestFiles = true\n`,
      });

      const args = ["--coverage", "--test-match", "**/*.unit.ts"];
      const [serial, parallel, other] = await Promise.all([
        run(String(defaults), args),
        run(String(defaults), [...args, "--parallel=2"]),
        run(String(listed), args),
      ]);
      expect(serial.files).toEqual(["src/math.unit.ts", "src/more.unit.ts"]);
      expect(coveredFiles(serial.stderr)).toEqual(["src/math.ts"]);
      expect(serial.exitCode).toBe(0);

      expect(parallel.stderr).toContain("Ran 2 tests across 2 files.");
      expect(coveredFiles(parallel.stderr)).toEqual(["src/math.ts"]);
      expect(parallel.exitCode).toBe(0);

      expect(other.files).toEqual(["src/math.unit.ts", "src/more.unit.ts"]);
      expect(coveredFiles(other.stderr)).toEqual(["src/helper.ts", "src/math.ts", "src/shared.test.ts"]);
      expect(other.exitCode).toBe(0);
    });

    test("a test that changes directory changes nothing", async () => {
      using dir = tempDir("test-match", {
        "bunfig.toml": `[test]\ntestMatch = ["tests/**"]\ncoverageSkipTestFiles = true\npreload = ["./setup.ts"]\n`,
        "setup.ts": `process.chdir(import.meta.dir + "/sandbox");\n`,
        "sandbox/.keep": "",
        "src/math.ts": project["src/math.ts"],
        "tests/a.ts": `import { test, expect } from "bun:test";
import { add } from "../src/math";
test("a", () => {
  expect(add(1, 2)).toBe(3);
});
`,
      });

      const { files, stderr, exitCode } = await run(String(dir), ["--coverage"]);
      expect(files).toEqual(["tests/a.ts"]);
      // The table is relative to where the run is by then.
      expect(coveredFiles(stderr)).toEqual(["../setup.ts", "../src/math.ts"]);
      expect(exitCode).toBe(0);
    });

    test("--rerun-each prints the name of the test file for every run", async () => {
      using dir = tempDir("test-match", {
        ...project,
        "bunfig.toml": `[test]\ntestMatch = ["**/math.unit.ts"]\ncoverageSkipTestFiles = true\n`,
      });

      const { stderr, exitCode } = await run(String(dir), ["--coverage", "--rerun-each=3"]);
      expect(Array.from(stderr.matchAll(/^(.+): \(run #(\d)\)$/gm), match => [match[1], match[2]])).toEqual([
        ["src/math.unit.ts", "1"],
        ["src/math.unit.ts", "2"],
        ["src/math.unit.ts", "3"],
      ]);
      expect(exitCode).toBe(0);
    });
  });
});
