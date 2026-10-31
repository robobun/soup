import { describe, expect, test } from "bun:test";
import { bunEnv, bunExe, isLinux, isWindows, tempDir } from "harness";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Every file of a fixture appends lines to one log, so a test can read what ran, where and in which order.
const log = `const log = (line: string) => require("node:fs").appendFileSync(process.env.GS_LOG!, line + "\\n");\n`;

const testFile = (name: string, body = "") =>
  `import { test, expect } from "bun:test";\n${log}test("${name}", async () => {\n  log("test ${name}");\n${body}});\n`;

const setupFile = (name = "setup", body = "") =>
  `${log}export default async function () {\n  log("${name}");\n${body}  return async () => {\n    log("teardown of ${name}");\n  };\n}\n`;

const bunfig = (setup: string | string[], teardown?: string | string[]) =>
  `[test]\nglobalSetup = ${JSON.stringify(setup)}\n` +
  (teardown === undefined ? "" : `globalTeardown = ${JSON.stringify(teardown)}\n`);

const twoTests = { "a.test.ts": testFile("a"), "b.test.ts": testFile("b") };

function project(files: Record<string, string>) {
  const dir = tempDir("global-setup", { "package.json": JSON.stringify({ name: "global-setup-test" }), ...files });
  const cwd = String(dir);
  const logPath = join(cwd, "log.txt");
  // Some CI lanes run every test with BUN_FEATURE_FLAG_NO_ORPHANS=1, which decides what happens
  // to the setup process when the test process is killed. The tests that are about it say so.
  const { BUN_FEATURE_FLAG_NO_ORPHANS: _, ...inherited } = bunEnv;
  const env = { ...inherited, GS_LOG: logPath, XDG_CACHE_HOME: join(cwd, ".cache") };
  return {
    cwd,
    env,
    logPath,
    async run(args: string[] = [], extraEnv: Record<string, string> = {}) {
      await using proc = Bun.spawn({
        cmd: [bunExe(), "test", ...args],
        cwd,
        env: { ...env, ...extraEnv },
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      return { stdout, stderr, exitCode, log: this.log() };
    },
    /** The lines of the log at this moment. */
    log() {
      return existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n").filter(Boolean) : [];
    },
    [Symbol.dispose]() {
      dir[Symbol.dispose]();
    },
  };
}

/** The first line, the lines between in any order, the last line. */
function shape(lines: string[]) {
  return { first: lines[0], between: lines.slice(1, -1).sort(), last: lines.at(-1) };
}

const modes: [string, string[]][] = [
  ["one process", []],
  ["--isolate", ["--isolate"]],
  ["--parallel", ["--parallel=2"]],
];

describe.concurrent("bun test globalSetup", () => {
  describe.each(modes)("%s", (_, flags) => {
    test("the setup runs once before the first file and its teardown once after the last", async () => {
      using p = project({
        "bunfig.toml": bunfig("./global-setup.ts"),
        "global-setup.ts": setupFile("setup", `  process.env.GS_VALUE = "from the setup";\n`),
        "a.test.ts": testFile("a", `  expect(process.env.GS_VALUE).toBe("from the setup");\n`),
        "b.test.ts": testFile("b", `  expect(process.env.GS_VALUE).toBe("from the setup");\n`),
      });
      const result = await p.run(flags);
      expect(result.stderr).toContain("2 pass");
      expect(shape(result.log)).toEqual({ first: "setup", between: ["test a", "test b"], last: "teardown of setup" });
      expect(result.exitCode).toBe(0);
    });

    test("what the setup starts stays up for every file", async () => {
      using p = project({
        "bunfig.toml": bunfig("./global-setup.ts"),
        "global-setup.ts": `${log}
          export default async function () {
            let requests = 0;
            const server = Bun.serve({ port: 0, fetch: () => new Response("request " + ++requests) });
            const child = Bun.spawn({ cmd: [process.execPath, "-e", "setInterval(() => {}, 1000)"], stdio: ["ignore", "ignore", "ignore"] });
            process.env.GS_URL = server.url.href;
            process.env.GS_CHILD = String(child.pid);
            return async () => {
              log("requests " + requests);
              child.kill();
              await child.exited;
              await server.stop(true);
            };
          }`,
        ...Object.fromEntries(
          ["a", "b", "c"].map(name => [
            `${name}.test.ts`,
            testFile(
              name,
              `  expect(await (await fetch(process.env.GS_URL!)).text()).toStartWith("request ");
                 // Signal 0 only asks whether the process is there.
                 expect(process.kill(Number(process.env.GS_CHILD), 0)).toBe(true);\n`,
            ),
          ]),
        ),
      });
      const result = await p.run(flags);
      expect(result.stderr).toContain("3 pass");
      expect(result.log.sort()).toEqual(["requests 3", "test a", "test b", "test c"]);
      expect(result.exitCode).toBe(0);
    });

    test("what the setup sets, changes and deletes in process.env reaches the files", async () => {
      using p = project({
        "bunfig.toml": bunfig("./global-setup.ts"),
        "global-setup.ts": `
          export default function () {
            process.env.GS_NEW = "new = with = equals\\nand a second line";
            process.env.GS_CHANGED = "changed";
            delete process.env.GS_DELETED;
            process.env.TZ = "America/New_York";
          }`,
        "a.test.ts": testFile(
          "a",
          `  log(JSON.stringify([process.env.GS_NEW, process.env.GS_CHANGED, process.env.GS_DELETED ?? null, process.env.GS_KEPT]));
             log(Intl.DateTimeFormat().resolvedOptions().timeZone + " " + new Date(0).getHours());\n`,
        ),
        // A second file, so that a file which runs after a global was swapped is asked too.
        "b.test.ts": testFile("b", `  log(Intl.DateTimeFormat().resolvedOptions().timeZone);\n`),
      });
      const result = await p.run(flags, { GS_CHANGED: "before", GS_DELETED: "before", GS_KEPT: "kept" });
      expect(result.stderr).toContain("2 pass");
      expect(result.log.sort()).toEqual([
        "America/New_York",
        "America/New_York 19",
        JSON.stringify(["new = with = equals\nand a second line", "changed", null, "kept"]),
        "test a",
        "test b",
      ]);
      expect(result.exitCode).toBe(0);
    });

    test("the setup shares nothing but the environment with the files", async () => {
      using p = project({
        "bunfig.toml": bunfig("./global-setup.ts"),
        "state.ts": `export const state = { startedBy: "nobody" };\n`,
        "global-setup.ts": `
          import { state } from "./state";
          export default function () {
            state.startedBy = "the setup";
            globalThis.startedBy = "the setup";
            process.env.GS_PID = String(process.pid);
          }`,
        "a.test.ts": `import { state } from "./state";\n${testFile(
          "a",
          `  log(JSON.stringify([state.startedBy, typeof globalThis.startedBy, typeof process.env.GS_PID, process.pid === Number(process.env.GS_PID)]));\n`,
        )}`,
      });
      const result = await p.run(flags);
      expect(result.log).toEqual(["test a", JSON.stringify(["nobody", "undefined", "string", false])]);
      expect(result.exitCode).toBe(0);
    });

    test("a setup that throws fails the run before any file is loaded", async () => {
      using p = project({
        "bunfig.toml": bunfig(["./first.ts", "./second.ts", "./third.ts"], "./global-teardown.ts"),
        "first.ts": setupFile("first"),
        "second.ts": `${log}export default async function () {\n  log("second");\n  throw new Error("the database did not start");\n}\n`,
        "third.ts": setupFile("third"),
        "global-teardown.ts": `${log}export default () => log("global teardown");\n`,
        ...twoTests,
      });
      const result = await p.run(flags);
      expect(result.stderr).toContain("error: the database did not start");
      expect(result.stderr).toContain("the global setup failed, so no test file was run");
      expect(result.stderr).not.toContain("a.test.ts:");
      // What was set up is torn down. A teardown file is the other half of a setup that completed.
      expect(result.log).toEqual(["first", "second", "teardown of first"]);
      expect(result.exitCode).toBe(1);
    });

    test("a teardown that throws fails a run whose tests passed", async () => {
      using p = project({
        "bunfig.toml": bunfig(["./first.ts", "./second.ts"]),
        "first.ts": setupFile("first"),
        "second.ts": `${log}export default () => () => {\n  log("teardown of second");\n  throw new Error("the container did not stop");\n};\n`,
        ...twoTests,
      });
      const result = await p.run(flags);
      expect(result.stderr).toContain("2 pass");
      expect(result.stderr).toContain("error: the container did not stop");
      expect(result.stderr).toContain("the global teardown failed");
      // The teardowns after the one that threw still run.
      expect(shape(result.log)).toEqual({
        first: "first",
        between: ["teardown of second", "test a", "test b"],
        last: "teardown of first",
      });
      expect(result.exitCode).toBe(1);
    });
  });

  test.each([
    ["--rerun-each=2", ["--rerun-each=2"], ["test a", "test a", "test b", "test b"]],
    ["--shard=1/2", ["--shard=1/2"], ["test a"]],
    ["--parallel=1", ["--parallel=1"], ["test a", "test b"]],
    ["--parallel --no-isolate", ["--parallel=2", "--no-isolate"], ["test a", "test b"]],
  ] as [string, string[], string[]][])("once per run with %s", async (_, flags, tests) => {
    using p = project({ "bunfig.toml": bunfig("./global-setup.ts"), "global-setup.ts": setupFile(), ...twoTests });
    const result = await p.run(flags);
    expect(shape(result.log)).toEqual({ first: "setup", between: tests, last: "teardown of setup" });
    expect(result.exitCode).toBe(0);
  });

  test.skipIf(isWindows).each(modes)("a PATH that the setup extends finds its programs, %s", async (_, flags) => {
    using p = project({
      "bunfig.toml": bunfig("./global-setup.ts"),
      "tools/gs-tool": `#!/bin/sh\necho the tool ran\n`,
      "global-setup.ts": `
        import { chmodSync } from "node:fs";
        export default () => {
          chmodSync("./tools/gs-tool", 0o755);
          process.env.PATH = process.cwd() + "/tools:" + process.env.PATH;
        };`,
      "a.test.ts": testFile(
        "a",
        `  log(String(Bun.which("gs-tool")).endsWith("/tools/gs-tool") + ", " + Bun.spawnSync(["gs-tool"]).stdout.toString().trim());\n`,
      ),
      "b.test.ts": testFile("b"),
    });
    const result = await p.run(flags);
    expect(result.log.sort()).toEqual(["test a", "test b", "true, the tool ran"]);
    expect(result.exitCode).toBe(0);
  });

  test("setup files run in order, their teardowns in reverse, then the teardown files", async () => {
    using p = project({
      "bunfig.toml": bunfig(["./first.ts", "./second.ts"], ["./teardown-a.ts", "./teardown-b.ts"]),
      "first.ts": setupFile("first"),
      "second.ts": setupFile("second"),
      "teardown-a.ts": `${log}export default async () => log("teardown file a");\n`,
      "teardown-b.ts": `${log}export default async () => log("teardown file b");\n`,
      "a.test.ts": testFile("a"),
    });
    const result = await p.run();
    expect(result.log).toEqual([
      "first",
      "second",
      "test a",
      "teardown of second",
      "teardown of first",
      "teardown file a",
      "teardown file b",
    ]);
    expect(result.exitCode).toBe(0);
  });

  test("a setup file can export functions named setup and teardown", async () => {
    using p = project({
      "bunfig.toml": bunfig("./global-setup.ts"),
      "global-setup.ts": `${log}
        let server: ReturnType<typeof Bun.serve>;
        export async function setup() {
          server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
          log("setup");
        }
        export async function teardown() {
          await server.stop(true);
          log("teardown");
        }`,
      "a.test.ts": testFile("a"),
    });
    const result = await p.run();
    expect(result.log).toEqual(["setup", "test a", "teardown"]);
    expect(result.exitCode).toBe(0);
  });

  test("a setup file can export the names of node:test, globalSetup and globalTeardown", async () => {
    using p = project({
      "bunfig.toml": bunfig("./global-hooks.mjs"),
      // The module that run({ globalSetupPath }) takes.
      "global-hooks.mjs": `
        import { appendFileSync } from "node:fs";
        const log = line => appendFileSync(process.env.GS_LOG, line + "\\n");
        export const globalSetup = async () => log("globalSetup");
        export const globalTeardown = async () => log("globalTeardown");`,
      "a.test.ts": testFile("a"),
    });
    const result = await p.run();
    expect(result.log).toEqual(["globalSetup", "test a", "globalTeardown"]);
    expect(result.exitCode).toBe(0);
  });

  test("the two files of Jest share a process: a global of the setup is there in the teardown", async () => {
    using p = project({
      "bunfig.toml": bunfig("./setup.cjs", "./teardown.cjs"),
      "setup.cjs": `
        module.exports = async function () {
          globalThis.__SERVER__ = Bun.serve({ port: 0, fetch: () => new Response("ok") });
          process.env.GS_URL = globalThis.__SERVER__.url.href;
        };`,
      "teardown.cjs": `
        module.exports = async function () {
          await globalThis.__SERVER__.stop(true);
          require("node:fs").appendFileSync(process.env.GS_LOG, "stopped " + (globalThis.__SERVER__.url.href === process.env.GS_URL) + "\\n");
        };`,
      "a.test.ts": testFile("a", `  expect(await (await fetch(process.env.GS_URL!)).text()).toBe("ok");\n`),
    });
    const result = await p.run();
    expect(result.stderr).toContain("1 pass");
    expect(result.log).toEqual(["test a", "stopped true"]);
    expect(result.exitCode).toBe(0);
  });

  test("a teardown file needs no setup file", async () => {
    using p = project({
      "bunfig.toml": `[test]\nglobalTeardown = "./global-teardown.ts"\n`,
      "global-teardown.ts": `${log}export default () => log("global teardown");\n`,
      ...twoTests,
    });
    const result = await p.run();
    expect(result.log).toEqual(["test a", "test b", "global teardown"]);
    expect(result.exitCode).toBe(0);
  });

  test("--global-setup and --global-teardown replace the keys of bunfig.toml", async () => {
    using p = project({
      "bunfig.toml": bunfig("./from-bunfig.ts", "./teardown-from-bunfig.ts"),
      "from-bunfig.ts": setupFile("bunfig"),
      "teardown-from-bunfig.ts": `${log}export default () => log("teardown file of bunfig");\n`,
      "setups/one.ts": setupFile("flag one"),
      "setups/two.ts": setupFile("flag two"),
      "teardown-from-flag.ts": `${log}export default () => log("teardown file of the flag");\n`,
      "a.test.ts": testFile("a"),
    });
    const result = await p.run([
      // With and without "./", like a test file on the command line.
      "--global-setup=setups/one.ts",
      "--global-setup",
      "./setups/two.ts",
      "--global-teardown",
      "./teardown-from-flag.ts",
    ]);
    expect(result.log).toEqual([
      "flag one",
      "flag two",
      "test a",
      "teardown of flag two",
      "teardown of flag one",
      "teardown file of the flag",
    ]);
    expect(result.exitCode).toBe(0);
  });

  test("a path can name a file of a package", async () => {
    using p = project({
      "bunfig.toml": bunfig("a-preset/setup"),
      "node_modules/a-preset/package.json": JSON.stringify({ name: "a-preset", version: "1.0.0" }),
      "node_modules/a-preset/setup.js": `module.exports = async () => {\n  process.env.GS_PRESET = "from the package";\n};\n`,
      "a.test.ts": testFile("a", `  log(String(process.env.GS_PRESET));\n`),
    });
    const result = await p.run();
    expect(result.log).toEqual(["test a", "from the package"]);
    expect(result.exitCode).toBe(0);
  });

  test("the setup file is loaded with the flags of the run that decide how code is loaded", async () => {
    using p = project({
      "bunfig.toml": bunfig("./global-setup.ts"),
      "global-setup.ts": `${log}declare const BUILD: string;\nexport default () => log("setup " + BUILD);\n`,
      "a.test.ts": `declare const BUILD: string;\n${testFile("a", `  log("test " + BUILD);\n`)}`,
    });
    const result = await p.run(["--define", `BUILD="defined"`]);
    expect(result.log).toEqual(["setup defined", "test a", "test defined"]);
    expect(result.exitCode).toBe(0);
  });

  test("what the environment says to the test process alone is not for the setup process", async () => {
    using p = project({
      "bunfig.toml": bunfig("./global-setup.ts"),
      "from-options.ts": `${log}log("preload of BUN_OPTIONS");\n`,
      "global-setup.ts": setupFile(),
      // The test file still has the variable: only the setup process starts without it.
      "a.test.ts": testFile("a", `  log(String(process.env.BUN_OPTIONS));\n`),
    });
    const result = await p.run([], { BUN_OPTIONS: "--preload=./from-options.ts" });
    expect(result.log).toEqual([
      "setup",
      "preload of BUN_OPTIONS",
      "test a",
      "--preload=./from-options.ts",
      "teardown of setup",
    ]);
    expect(result.exitCode).toBe(0);
  });

  test("a run that has an IPC channel to its parent", async () => {
    using p = project({
      "bunfig.toml": bunfig("./global-setup.ts"),
      "global-setup.ts": setupFile("setup", `  process.env.GS_VALUE = "from the setup";\n`),
      "a.test.ts": testFile("a", `  process.send!(process.env.GS_VALUE);\n`),
    });
    const message = Promise.withResolvers<unknown>();
    await using proc = Bun.spawn({
      cmd: [bunExe(), "test"],
      cwd: p.cwd,
      env: p.env,
      stdout: "ignore",
      stderr: "pipe",
      stdin: "ignore",
      // The channel is descriptor 3 of the test process, which is what the setup process reports on.
      ipc: received => message.resolve(received),
      serialization: "json",
    });
    const [stderr, exitCode] = await Promise.all([proc.stderr.text(), proc.exited]);
    expect(stderr).toContain("1 pass");
    expect(await message.promise).toBe("from the setup");
    expect(p.log()).toEqual(["setup", "test a", "teardown of setup"]);
    expect(exitCode).toBe(0);
  });

  test("the setup and the teardown print to the terminal of the run", async () => {
    using p = project({
      "bunfig.toml": bunfig("./global-setup.ts"),
      "global-setup.ts": `
        export default () => {
          console.log("setup on stdout");
          console.error("setup on stderr");
          return () => console.log("teardown on stdout");
        };`,
      "a.test.ts": testFile("a"),
    });
    const result = await p.run();
    expect(result.stdout.split("\n").filter(line => line.includes("on stdout"))).toEqual([
      "setup on stdout",
      "teardown on stdout",
    ]);
    // Before the first file and after the summary.
    expect(result.stderr.indexOf("setup on stderr")).toBeLessThan(result.stderr.indexOf("a.test.ts:"));
    expect(result.exitCode).toBe(0);
  });

  describe("errors", () => {
    test("a setup file that does not exist", async () => {
      using p = project({ "bunfig.toml": bunfig("./missing.ts"), ...twoTests });
      const result = await p.run();
      expect(result.stderr).toContain(`globalSetup not found: "./missing.ts"`);
      expect(result.log).toEqual([]);
      expect(result.exitCode).toBe(1);
    });

    test("a teardown file that does not exist fails before the setup runs", async () => {
      using p = project({
        "bunfig.toml": bunfig("./global-setup.ts", "./missing.ts"),
        "global-setup.ts": setupFile(),
        ...twoTests,
      });
      const result = await p.run();
      expect(result.stderr).toContain(`globalTeardown not found: "./missing.ts"`);
      expect(result.log).toEqual([]);
      expect(result.exitCode).toBe(1);
    });

    test("a setup file that exports no function", async () => {
      using p = project({
        "bunfig.toml": bunfig("./global-setup.ts"),
        "global-setup.ts": `export default { setup() {} };\nexport const port = 3000;\n`,
        ...twoTests,
      });
      const result = await p.run();
      expect(result.stderr).toContain(
        `global-setup.ts: a global setup file exports a function as its default export, or functions named "setup" and "teardown"`,
      );
      expect(result.log).toEqual([]);
      expect(result.exitCode).toBe(1);
    });

    test("a teardown file that exports no function", async () => {
      using p = project({
        "bunfig.toml": bunfig("./global-setup.ts", "./global-teardown.ts"),
        "global-setup.ts": setupFile(),
        "global-teardown.ts": `export const nothing = 1;\n`,
        "a.test.ts": testFile("a"),
      });
      const result = await p.run();
      expect(result.stderr).toContain("1 pass");
      expect(result.stderr).toContain(
        "global-teardown.ts: a global teardown file exports a function as its default export",
      );
      expect(result.stderr).toContain("the global teardown failed");
      expect(result.log).toEqual(["setup", "test a", "teardown of setup"]);
      expect(result.exitCode).toBe(1);
    });

    test("a setup that ends its process", async () => {
      using p = project({
        "bunfig.toml": bunfig("./global-setup.ts"),
        "global-setup.ts": `export default () => process.exit(0);\n`,
        ...twoTests,
      });
      const result = await p.run();
      expect(result.stderr).toContain("the global setup process ended before the setup was over");
      expect(result.log).toEqual([]);
      expect(result.exitCode).toBe(1);
    });

    test("an error that nobody catches while the tests run fails the run, after the teardown", async () => {
      using p = project({
        "bunfig.toml": bunfig("./global-setup.ts"),
        "global-setup.ts": `${log}
          export default function () {
            const server = Bun.serve({
              port: 0,
              fetch() {
                Promise.reject(new Error("nobody awaits this"));
                return new Response("ok");
              },
            });
            process.env.GS_URL = server.url.href;
            return async () => {
              await server.stop(true);
              log("teardown");
            };
          }`,
        "a.test.ts": testFile("a", `  expect(await (await fetch(process.env.GS_URL!)).text()).toBe("ok");\n`),
        "b.test.ts": testFile("b", `  expect(await (await fetch(process.env.GS_URL!)).text()).toBe("ok");\n`),
      });
      const result = await p.run();
      expect(result.stderr).toContain("2 pass");
      expect(result.stderr).toContain("error: nobody awaits this");
      expect(result.stderr).toContain("the global teardown failed");
      expect(result.log).toEqual(["test a", "test b", "teardown"]);
      expect(result.exitCode).toBe(1);
    });

    test("an empty path", async () => {
      using p = project({ "bunfig.toml": `[test]\nglobalSetup = ["./a.ts", ""]\n`, ...twoTests });
      const result = await p.run();
      expect(result.stderr).toContain("globalSetup cannot be an empty string");
      expect(result.exitCode).toBe(1);

      const flag = await p.run(["--global-teardown="]);
      expect(flag.stderr).toContain("--global-teardown expects a file path");
      expect(flag.exitCode).toBe(1);
    });
  });

  describe("a run that runs nothing has no setup", () => {
    const files = { "bunfig.toml": bunfig("./global-setup.ts"), "global-setup.ts": setupFile(), ...twoTests };

    test("a filter that matches no file", async () => {
      using p = project(files);
      expect((await p.run(["a.test"])).log).toEqual(["setup", "test a", "teardown of setup"]);
      rmSync(p.logPath);

      const result = await p.run(["no-such-file"]);
      expect(result.log).toEqual([]);
      expect(result.exitCode).toBe(1);
    });

    test("--dry-run", async () => {
      using p = project(files);
      expect((await p.run(["a.test"])).log).toEqual(["setup", "test a", "teardown of setup"]);
      rmSync(p.logPath);

      const result = await p.run(["--dry-run"]);
      expect(result.stderr).toContain("2 pending");
      expect(result.log).toEqual([]);
      expect(result.exitCode).toBe(0);
    });
  });

  // Only a process that waited for the teardown can say that it failed, and exit with 1 because of
  // it. With and without --no-orphans, which kills the children of a process when it exits.
  describe.each([
    ["", {}],
    [" with --no-orphans", { BUN_FEATURE_FLAG_NO_ORPHANS: "1" }],
  ] as [string, Record<string, string>][])("bun test waits for the teardown%s", (_, noOrphans) => {
    const failingTeardown = `${log}export default () => async () => {\n  log("teardown");\n  throw new Error("the teardown fails");\n};\n`;

    test("--bail", async () => {
      using p = project({
        "bunfig.toml": bunfig("./global-setup.ts"),
        "global-setup.ts": failingTeardown,
        "a.test.ts": testFile("a", `  expect(1).toBe(2);\n`),
        "b.test.ts": testFile("b"),
      });
      const result = await p.run(["--bail"], noOrphans);
      expect(result.stderr).toContain("Bailed out after 1 failure");
      expect(result.stderr).toContain("error: the global teardown failed");
      expect(result.log).toEqual(["test a", "teardown"]);
      expect(result.exitCode).toBe(1);
    });

    test("process.exit(0) in a test file, which a teardown that fails turns into 1", async () => {
      using p = project({
        "bunfig.toml": bunfig("./global-setup.ts"),
        "global-setup.ts": failingTeardown,
        "a.test.ts": testFile("a", `  process.exit(0);\n`),
      });
      const result = await p.run([], noOrphans);
      expect(result.stderr).toContain("error: the global teardown failed");
      expect(result.log).toEqual(["test a", "teardown"]);
      expect(result.exitCode).toBe(1);
    });

    test("process.exit(7) in a test file", async () => {
      using p = project({
        "bunfig.toml": bunfig("./global-setup.ts"),
        "global-setup.ts": setupFile(),
        "a.test.ts": testFile("a", `  process.exit(7);\n`),
      });
      const result = await p.run([], noOrphans);
      expect(result.log).toEqual(["setup", "test a", "teardown of setup"]);
      expect(result.exitCode).toBe(7);
    });

    test.skipIf(isWindows)("a signal that stops the workers of --parallel", async () => {
      using p = project({
        "bunfig.toml": bunfig("./global-setup.ts"),
        "global-setup.ts": failingTeardown,
        // Each file tells the test that it runs, and then never ends.
        "a.test.ts": testFile("a", `  await fetch(process.env.GS_STARTED!);\n  await new Promise(() => {});\n`),
        "b.test.ts": testFile("b", `  await fetch(process.env.GS_STARTED!);\n  await new Promise(() => {});\n`),
      });
      const started = Promise.withResolvers<void>();
      using server = Bun.serve({
        port: 0,
        fetch() {
          started.resolve();
          return new Response("ok");
        },
      });
      await using proc = Bun.spawn({
        cmd: [bunExe(), "test", "--parallel=2", "--timeout=600000"],
        cwd: p.cwd,
        env: { ...p.env, ...noOrphans, GS_STARTED: server.url.href },
        stdout: "ignore",
        stderr: "pipe",
        stdin: "ignore",
      });
      await started.promise;
      proc.kill("SIGTERM");
      const [stderr, exitCode] = await Promise.all([proc.stderr.text(), proc.exited]);
      expect(stderr).toContain("Interrupted");
      expect(stderr).toContain("error: the global teardown failed");
      expect(p.log().at(-1)).toBe("teardown");
      expect(exitCode).toBe(128 + 15);
    });
  });

  // A server that closes once its clients are gone, which is what `net.Server#close` and the
  // shutdown of a database wait for. The test process still holds a connection a test left open.
  describe("what a test file left open does not hold the teardown up", () => {
    const files = (body = "") => ({
      "bunfig.toml": bunfig("./global-setup.ts"),
      "global-setup.ts": `${log}
        import net from "node:net";
        export default async function () {
          const server = net.createServer(socket => {
            socket.on("data", data => socket.write(data));
            socket.on("error", () => {});
          });
          await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
          process.env.GS_PORT = String((server.address() as net.AddressInfo).port);
          return async () => {
            await new Promise<void>(resolve => server.close(() => resolve()));
            log("teardown");
          };
        }`,
      "a.test.ts": testFile("a"),
      "leak.test.ts": `import net from "node:net";\n${testFile(
        "leak",
        `  const socket = net.connect(Number(process.env.GS_PORT), "127.0.0.1");
           globalThis.leaked = socket;
           const echoed = await new Promise<string>(resolve => {
             socket.once("data", data => resolve(String(data)));
             socket.write("ping");
           });
           expect(echoed).toBe("ping");\n${body}`,
      )}`,
    });

    test.each([
      ["one process", []],
      ["--isolate", ["--isolate"]],
    ] as [string, string[]][])("at the end of a run, %s", async (_, flags) => {
      using p = project(files());
      // The file with the leak is the last one: nothing comes after it that could clean up.
      const result = await p.run([...flags, "./a.test.ts", "./leak.test.ts"]);
      expect(result.stderr).toContain("2 pass");
      expect(result.log).toEqual(["test a", "test leak", "teardown"]);
      expect(result.exitCode).toBe(0);
    });

    test("--bail", async () => {
      using p = project(files(`  expect(1).toBe(2);\n`));
      const result = await p.run(["--bail", "./leak.test.ts", "./a.test.ts"]);
      expect(result.stderr).toContain("Bailed out after 1 failure");
      expect(result.log).toEqual(["test leak", "teardown"]);
      expect(result.exitCode).toBe(1);
    });

    test("process.exit()", async () => {
      using p = project(files(`  process.exit(3);\n`));
      const result = await p.run(["./leak.test.ts", "./a.test.ts"]);
      expect(result.log).toEqual(["test leak", "teardown"]);
      expect(result.exitCode).toBe(3);
    });
  });

  describe("bun test --check", () => {
    // Type-checks without the types of Bun, which this project does not install.
    const checked = (line: string) =>
      `declare const test: (name: string, fn: () => void) => void;
       declare const process: { env: Record<string, string> };
       declare function require(name: string): { appendFileSync(path: string, text: string): void };
       ${line}
       test("a", () => require("node:fs").appendFileSync(process.env.GS_LOG, "test a\\n"));\n`;

    test("the setup waits for the type check, and a type error sets nothing up", async () => {
      using p = project({
        "bunfig.toml": bunfig("./global-setup.ts"),
        "global-setup.ts": setupFile(),
        "a.test.ts": checked(`const count: number = "three";`),
      });
      const failed = await p.run(["--check"]);
      expect(failed.stderr).toContain("error TS2322");
      expect(failed.log).toEqual([]);
      expect(failed.exitCode).toBe(1);

      writeFileSync(join(p.cwd, "a.test.ts"), checked(`const count: number = 3;`));
      const passed = await p.run(["--check"]);
      expect(passed.stderr).toContain("1 pass");
      expect(passed.log).toEqual(["setup", "test a", "teardown of setup"]);
      expect(passed.exitCode).toBe(0);
      // Two runs, each with a type check.
    }, 30_000);
  });

  test.skipIf(isWindows)("the teardown runs when the test process is killed", async () => {
    using p = project({
      "bunfig.toml": bunfig("./global-setup.ts"),
      // The teardown tells the test that it ran: nothing else is left to wait for.
      "global-setup.ts": `${log}export default () => async () => {\n  log("teardown");\n  await fetch(process.env.GS_EVENTS + "teardown");\n};\n`,
      "a.test.ts": testFile("a", `  await fetch(process.env.GS_EVENTS + "started");\n  await new Promise(() => {});\n`),
    });
    const started = Promise.withResolvers<void>();
    const tornDown = Promise.withResolvers<void>();
    using server = Bun.serve({
      port: 0,
      fetch(request) {
        (new URL(request.url).pathname === "/started" ? started : tornDown).resolve();
        return new Response("ok");
      },
    });
    await using proc = Bun.spawn({
      cmd: [bunExe(), "test", "--timeout=600000"],
      cwd: p.cwd,
      env: { ...p.env, GS_EVENTS: server.url.href },
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    await started.promise;
    proc.kill("SIGKILL");
    await proc.exited;
    await tornDown.promise;
    expect(p.log()).toEqual(["test a", "teardown"]);
  });

  test.skipIf(isWindows)("a setup that the test process does not live to see the end of is torn down", async () => {
    using p = project({
      "bunfig.toml": bunfig(["./first.ts", "./second.ts", "./third.ts"], "./global-teardown.ts"),
      "first.ts": setupFile("first"),
      // Tells the test that the setup is in here, and goes on when the test answers.
      "second.ts": setupFile("second", `  await fetch(process.env.GS_EVENTS + "in-setup");\n`),
      "third.ts": setupFile("third"),
      "global-teardown.ts": `${log}export default () => log("global teardown");\n`,
      "a.test.ts": testFile("a"),
    });
    const inSetup = Promise.withResolvers<void>();
    const goOn = Promise.withResolvers<void>();
    const tornDown = Promise.withResolvers<void>();
    using server = Bun.serve({
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname === "/torn-down") {
          tornDown.resolve();
        } else {
          inSetup.resolve();
          await goOn.promise;
        }
        return new Response("ok");
      },
    });
    // The last teardown to run tells the test that all of them did.
    writeFileSync(
      join(p.cwd, "first.ts"),
      `${log}export default () => {\n  log("first");\n  return async () => {\n    log("teardown of first");\n    await fetch(process.env.GS_EVENTS + "torn-down");\n  };\n};\n`,
    );
    await using proc = Bun.spawn({
      cmd: [bunExe(), "test"],
      cwd: p.cwd,
      env: { ...p.env, GS_EVENTS: server.url.href },
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    await inSetup.promise;
    proc.kill("SIGKILL");
    await proc.exited;
    goOn.resolve();
    await tornDown.promise;
    // The setup stops after the file it was in. No test ran, and no teardown file either.
    expect(p.log()).toEqual(["first", "second", "teardown of second", "teardown of first"]);
  });

  // The kernel ends the setup process with its parent there. Elsewhere its own watch on the parent
  // does, a moment later.
  test.skipIf(!isLinux)("--no-orphans: the setup process goes down with a test process that is killed", async () => {
    using p = project({
      "bunfig.toml": bunfig("./global-setup.ts"),
      // The setup holds a connection to the test, which hears of its end that way.
      "global-setup.ts": `${log}
        import net from "node:net";
        export default async () => {
          log("setup");
          const socket = net.connect(Number(process.env.GS_PORT), "127.0.0.1");
          await new Promise(resolve => socket.once("connect", resolve));
          return async () => {
            // Slower than the signal that ends this process.
            await fetch(process.env.GS_EVENTS + "torn-down").catch(() => {});
            log("teardown");
          };
        };`,
      "a.test.ts": testFile("a", `  await fetch(process.env.GS_EVENTS + "started");\n  await new Promise(() => {});\n`),
    });
    const started = Promise.withResolvers<void>();
    const gone = Promise.withResolvers<void>();
    using events = Bun.serve({
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/started") started.resolve();
        return new Response("ok");
      },
    });
    using listener = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data() {},
        close() {
          gone.resolve();
        },
      },
    });
    await using proc = Bun.spawn({
      cmd: [bunExe(), "test", "--timeout=600000"],
      cwd: p.cwd,
      env: { ...p.env, BUN_FEATURE_FLAG_NO_ORPHANS: "1", GS_EVENTS: events.url.href, GS_PORT: String(listener.port) },
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    await started.promise;
    proc.kill("SIGKILL");
    await proc.exited;
    await gone.promise;
    expect(p.log()).toEqual(["setup", "test a"]);
  });

  test("--watch: a setup that fails is run again when its file changes", async () => {
    using p = project({
      "bunfig.toml": bunfig("./global-setup.ts"),
      "global-setup.ts": `${log}export default () => {\n  log("setup fails");\n  throw new Error("not yet");\n};\n`,
      "a.test.ts": testFile("a"),
    });
    const tornDown = Promise.withResolvers<void>();
    using server = Bun.serve({
      port: 0,
      fetch() {
        tornDown.resolve();
        return new Response("ok");
      },
    });
    await using proc = Bun.spawn({
      cmd: [bunExe(), "test", "--watch"],
      cwd: p.cwd,
      env: { ...p.env, GS_EVENTS: server.url.href },
      stdout: "ignore",
      stderr: "pipe",
      stdin: "ignore",
    });
    // Once the run says that it failed, it watches: no test file was loaded, so the setup file
    // is all that the watcher has of this project.
    let stderr = "";
    for await (const chunk of proc.stderr.pipeThrough(new TextDecoderStream())) {
      stderr += chunk;
      if (stderr.includes("the global setup failed, so no test file was run")) break;
    }
    writeFileSync(
      join(p.cwd, "global-setup.ts"),
      `${log}export default () => {\n  log("setup");\n  return async () => {\n    log("teardown");\n    await fetch(process.env.GS_EVENTS!);\n  };\n};\n`,
    );
    await tornDown.promise;
    proc.kill();
    await proc.exited;
    expect(p.log()).toEqual(["setup fails", "setup", "test a", "teardown"]);
  }, 60_000);

  // --no-orphans on Linux is the kernel ending the setup process when the thread that started it
  // ends, and a restart ends it. So the run that a change interrupts is not torn down there.
  describe.each([
    ["", {}, true],
    [" with --no-orphans", { BUN_FEATURE_FLAG_NO_ORPHANS: "1" }, !isLinux],
  ] as [string, Record<string, string>, boolean][])("--watch%s", (_, noOrphans, tornDownOnRestart) => {
    test.skipIf(isWindows)(
      "a run that a change interrupts is torn down before the next one is set up",
      async () => {
        using p = project({
          "bunfig.toml": bunfig("./global-setup.ts"),
          "global-setup.ts": `${log}
            export default () => {
              // What the setup of the run before did to the environment is not there any more.
              log("setup " + process.env.GS_ONCE);
              process.env.GS_ONCE = "set";
              return async () => {
                // Long enough for the next run to start, if it did not wait.
                await Bun.sleep(250);
                log("teardown");
                await fetch(process.env.GS_EVENTS + "torn-down");
              };
            };`,
          // The first run never ends by itself. The second one, of the file as the test rewrites it, does.
          "a.test.ts": testFile(
            "a",
            `  await fetch(process.env.GS_EVENTS + "started");\n  await new Promise(() => {});\n`,
          ),
        });
        const started = Promise.withResolvers<void>();
        const allTornDown = Promise.withResolvers<void>();
        let tornDown = 0;
        using server = Bun.serve({
          port: 0,
          fetch(request) {
            if (new URL(request.url).pathname === "/started") started.resolve();
            else if (++tornDown === (tornDownOnRestart ? 2 : 1)) allTornDown.resolve();
            return new Response("ok");
          },
        });
        await using proc = Bun.spawn({
          cmd: [bunExe(), "test", "--watch", "--timeout=600000"],
          cwd: p.cwd,
          env: { ...p.env, ...noOrphans, GS_EVENTS: server.url.href },
          stdout: "ignore",
          stderr: "ignore",
          stdin: "ignore",
        });
        await started.promise;
        writeFileSync(join(p.cwd, "a.test.ts"), testFile("a again", `  log(String(process.env.GS_ONCE));\n`));
        await allTornDown.promise;
        proc.kill();
        await proc.exited;
        expect(p.log()).toEqual([
          "setup undefined",
          "test a",
          ...(tornDownOnRestart ? ["teardown"] : []),
          "setup undefined",
          "test a again",
          "set",
          "teardown",
        ]);
      },
      60_000,
    );
  });

  describe("node:test run()", () => {
    // A run() is a chain of processes: the runner, a bun test per file, and what that starts.
    const RUN_TIMEOUT = 30_000;
    const nodeTest = (name: string, body = "") =>
      `const { test } = require("node:test");
       const log = line => require("node:fs").appendFileSync(process.env.GS_LOG, line + "\\n");
       test("${name}", async () => {
         log("test ${name}");
       ${body}});\n`;
    // Exits with 0 when every test passed, with 1 when one failed and with 2 when the run itself failed.
    const runner = (files: string[], options = "") => `
      import { run } from "node:test";
      let failed = 0;
      try {
        const stream = run({ files: ${JSON.stringify(files)}, ${options} });
        stream.on("test:fail", () => failed++);
        for await (const _ of stream);
      } catch (error) {
        console.error("run() failed: " + error.message);
        process.exit(2);
      }
      console.log("runner " + process.pid);
      process.exit(failed ? 1 : 0);`;
    const hooks = (body: string) =>
      `import { appendFileSync } from "node:fs";\nconst log = line => appendFileSync(process.env.GS_LOG, line + "\\n");\n${body}\n`;

    async function runRunner(p: ReturnType<typeof project>) {
      await using proc = Bun.spawn({
        cmd: [bunExe(), "runner.mjs"],
        cwd: p.cwd,
        env: p.env,
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      return { stdout, stderr, exitCode, log: p.log(), pid: stdout.match(/runner (\d+)/)?.[1] };
    }

    test(
      "the files of run() do not each set up the globalSetup of bunfig.toml",
      async () => {
        using p = project({
          "bunfig.toml": bunfig("./global-setup.ts"),
          "global-setup.ts": setupFile(),
          "runner.mjs": runner(["a.test.js", "b.test.js"]),
          "a.test.js": nodeTest("a", `  log(JSON.stringify([process.argv.length, process.execArgv]));\n`),
          "b.test.js": nodeTest("b"),
        });
        // A bun test of the same project sets it up.
        expect((await p.run(["./b.test.js"])).log).toEqual(["setup", "test b", "teardown of setup"]);
        rmSync(p.logPath);

        const result = await runRunner(p);
        // The run is the runner's. Its files are told so in a way that their own code does not see.
        expect(result.log).toEqual(["test a", "[2,[]]", "test b"]);
        expect(result.exitCode).toBe(0);
      },
      RUN_TIMEOUT,
    );

    test(
      "globalSetupPath: once, in the process that called run()",
      async () => {
        using p = project({
          "runner.mjs": runner(["a.test.js", "b.test.js"], `globalSetupPath: "./hooks.mjs"`),
          "hooks.mjs": hooks(`
          export async function globalSetup() {
            log("globalSetup " + process.pid);
            process.env.GS_VALUE = "from globalSetup";
          }
          export async function globalTeardown() {
            log("globalTeardown " + process.pid);
          }
          // Only the two names above count, as in Node.js.
          export default function () {
            log("default export");
          }`),
          "a.test.js": nodeTest("a", `  log(String(process.env.GS_VALUE));\n`),
          "b.test.js": nodeTest("b", `  log(String(process.env.GS_VALUE));\n`),
        });
        const result = await runRunner(p);
        expect(result.log).toEqual([
          `globalSetup ${result.pid}`,
          "test a",
          "from globalSetup",
          "test b",
          "from globalSetup",
          `globalTeardown ${result.pid}`,
        ]);
        expect(result.exitCode).toBe(0);
      },
      RUN_TIMEOUT,
    );

    test(
      "globalSetupPath: a module with a teardown alone",
      async () => {
        using p = project({
          "runner.mjs": runner(["a.test.js"], `globalSetupPath: "./hooks.mjs"`),
          "hooks.mjs": hooks(`export const globalTeardown = () => log("globalTeardown");`),
          "a.test.js": nodeTest("a"),
        });
        const result = await runRunner(p);
        expect(result.log).toEqual(["test a", "globalTeardown"]);
        expect(result.exitCode).toBe(0);
      },
      RUN_TIMEOUT,
    );

    test(
      "globalSetupPath: a setup that throws runs no file and no teardown",
      async () => {
        using p = project({
          "runner.mjs": runner(["a.test.js"], `globalSetupPath: "./hooks.mjs"`),
          "hooks.mjs": hooks(`
          export function globalSetup() {
            log("globalSetup");
            throw new Error("the setup fails");
          }
          export const globalTeardown = () => log("globalTeardown");`),
          "a.test.js": nodeTest("a"),
        });
        const result = await runRunner(p);
        expect(result.stderr).toContain("run() failed: the setup fails");
        expect(result.log).toEqual(["globalSetup"]);
        expect(result.exitCode).toBe(2);
      },
      RUN_TIMEOUT,
    );

    test(
      "globalSetupPath: a teardown that throws fails the run",
      async () => {
        using p = project({
          "runner.mjs": runner(["a.test.js"], `globalSetupPath: "./hooks.mjs"`),
          "hooks.mjs": hooks(`
          export function globalTeardown() {
            log("globalTeardown");
            throw new Error("the teardown fails");
          }`),
          "a.test.js": nodeTest("a"),
        });
        const result = await runRunner(p);
        expect(result.stderr).toContain("run() failed: the teardown fails");
        expect(result.log).toEqual(["test a", "globalTeardown"]);
        expect(result.exitCode).toBe(2);
      },
      RUN_TIMEOUT,
    );

    test(
      "a bun test that a file of run() starts is a run of its own, with its own setup",
      async () => {
        using p = project({
          "runner.mjs": runner(["a.test.js"]),
          "inner/bunfig.toml": bunfig("./global-setup.ts"),
          "inner/global-setup.ts": setupFile("inner setup"),
          "inner/x.test.ts": testFile("x"),
          "a.test.js": nodeTest(
            "a",
            `  const inner = Bun.spawnSync({ cmd: [process.execPath, "test"], cwd: __dirname + "/inner", env: process.env });
             log("inner exit " + inner.exitCode);\n`,
          ),
        });
        const result = await runRunner(p);
        expect(result.log).toEqual(["test a", "inner setup", "test x", "teardown of inner setup", "inner exit 0"]);
        expect(result.exitCode).toBe(0);
      },
      RUN_TIMEOUT,
    );
  });
});
