import { SyncSubprocess } from "bun";
import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "fs";
import { bunEnv, bunExe, isWindows, tempDir, tmpdirSync } from "harness";
import { tmpdir } from "os";
import { join, sep } from "path";

// Prints whether the code around it runs in strict mode. A plain function call
// sees `this === undefined` only in strict mode, and assigning to an undeclared
// name throws only in strict mode.
const strictModeProbe = `
var thisIsUndefined = (function () { return this === undefined; })();
var undeclaredThrows = false;
try {
  someUndeclaredNameForTheStrictModeProbe = 1;
} catch (e) {
  undeclaredThrows = e instanceof ReferenceError;
}
console.log(JSON.stringify({ thisIsUndefined, undeclaredThrows }));
`;
const strictResult = JSON.stringify({ thisIsUndefined: true, undeclaredThrows: true }) + "\n";
const sloppyResult = JSON.stringify({ thisIsUndefined: false, undeclaredThrows: false }) + "\n";

for (const flag of ["-e", "--print"]) {
  describe(`bun ${flag}`, () => {
    test("it works", async () => {
      const input = flag === "--print" ? '"hello world"' : 'console.log("hello world")';
      let { stdout } = Bun.spawnSync({
        cmd: [bunExe(), flag, input],
        env: bunEnv,
      });
      expect(stdout.toString("utf8")).toEqual("hello world\n");
    });

    test("import, tsx, require in esm, import.meta", async () => {
      const ref = await import("react");
      const input =
        flag === "--print"
          ? 'import {version} from "react"; console.log(JSON.stringify({version,file:import.meta.path,require:require("react").version})); <hello>world</hello>'
          : 'import {version} from "react"; console.log(JSON.stringify({version,file:import.meta.path,require:require("react").version})); console.log(<hello>world</hello>);';

      let { stdout } = Bun.spawnSync({
        cmd: [bunExe(), flag, input],
        env: bunEnv,
      });
      const json = {
        version: ref.version,
        file: join(process.cwd(), "[eval]"),
        require: ref.version,
      };
      expect(stdout.toString("utf8")).toEqual(JSON.stringify(json) + "\n<hello>world</hello>\n");
    });

    test("error has source map info 1", async () => {
      let { stderr } = Bun.spawnSync({
        cmd: [bunExe(), flag, '(throw new Error("hi" as 2))'],
        env: bunEnv,
      });
      expect(stderr.toString("utf8")).toInclude('"hi" as 2');
      expect(stderr.toString("utf8")).toInclude("Unexpected throw");
    });

    test("process.argv", async () => {
      function testProcessArgv(args: string[], expected: string[]) {
        const input = flag === "--print" ? "process.argv" : "console.log(process.argv)";
        let { stdout, stderr, exitCode } = Bun.spawnSync({
          cmd: [bunExe(), flag, input, ...args],
          env: bunEnv,
        });

        expect(stderr.toString("utf8")).toBe("");
        expect(JSON.parse(stdout.toString("utf8"))).toEqual(expected);
        expect(exitCode).toBe(0);
      }

      // replace the trailin
      const exe = isWindows ? bunExe().replaceAll("/", "\\") : bunExe();
      testProcessArgv([], [exe]);
      testProcessArgv(["abc", "def"], [exe, "abc", "def"]);
      testProcessArgv(["--", "abc", "def"], [exe, "abc", "def"]);
      // testProcessArgv(["--", "abc", "--", "def"], [exe, "abc", "--", "def"]);
    });

    test("process._eval", async () => {
      const code = flag === "--print" ? "process._eval" : "console.log(process._eval)";
      const { stdout } = Bun.spawnSync({
        cmd: [bunExe(), flag, code],
        env: bunEnv,
      });
      expect(stdout.toString("utf8")).toEqual(code + "\n");
    });

    // The eval source is UTF-8; reading it back as Latin-1 turns every
    // multi-byte character into mojibake. The expected text is compared here
    // in the parent -- comparing inside the child would pass either way, since
    // a Latin-1-decoded source corrupts the literal and process._eval alike.
    test("process._eval round-trips multi-byte UTF-8", async () => {
      const marker = "/* 한글-🎉-café */";
      const code = (flag === "--print" ? "process._eval" : "console.log(process._eval)") + ` ${marker}`;
      const { stdout } = Bun.spawnSync({
        cmd: [bunExe(), flag, code],
        env: bunEnv,
      });
      expect(stdout.toString("utf8")).toEqual(code + "\n");
    });

    test("does not crash in non-latin1 directory", async () => {
      const dir = join(tmpdirSync(), "eval-test-开始学习");
      await Bun.write(join(dir, "index.js"), "console.log('hello world')");

      const { stdout, stderr, exitCode } = Bun.spawnSync({
        cmd: [bunExe(), flag, "import './index.js'"],
        env: bunEnv,
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      });

      expect(stderr.toString("utf8")).toBe("");
      expect(stdout.toString("utf8")).toEqual("hello world\n" + (flag === "--print" ? "undefined\n" : ""));
      expect(exitCode).toBe(0);
    });
  });
}

describe("--print for cjs/esm", () => {
  test("eval result between esm imports", async () => {
    let cwd = tmpdirSync();
    writeFileSync(join(cwd, "foo.js"), "'foo'");
    writeFileSync(join(cwd, "bar.js"), "'bar'");
    let { stdout, stderr, exitCode } = Bun.spawnSync({
      cmd: [bunExe(), "--print", 'import "./foo.js"; 123; import "./bar.js"'],
      cwd: cwd,
      env: bunEnv,
    });
    expect(stderr.toString("utf8")).toBe("");
    expect(stdout.toString("utf8")).toEqual("123\n");
    expect(exitCode).toBe(0);
    rmSync(cwd, { recursive: true, force: true });
  });
  // https://github.com/oven-sh/bun/issues/30207
  describe.each([
    { expr: "(await 1) + 1", expected: "2" },
    { expr: 'await Promise.resolve("hello") + " world"', expected: "hello world" },
    { expr: "(await 1) + (await 2)", expected: "3" },
    // no top-level await — still returns the expression value.
    { expr: "1 + 1", expected: "2" },
  ])("bun -p $expr", ({ expr, expected }) => {
    test(`→ ${expected}`, async () => {
      const { stdout, stderr, exitCode } = Bun.spawnSync({
        cmd: [bunExe(), "-p", expr],
        env: bunEnv,
      });
      expect(stderr.toString("utf8")).toBe("");
      expect(stdout.toString("utf8")).toBe(`${expected}\n`);
      expect(exitCode).toBe(0);
    });
  });
  test("forced cjs", async () => {
    let { stdout, stderr, exitCode } = Bun.spawnSync({
      cmd: [bunExe(), "--print", "module.exports; 123"],
      env: bunEnv,
    });
    expect(stderr.toString("utf8")).toBe("");
    expect(stdout.toString("utf8")).toEqual("123\n");
    expect(exitCode).toBe(0);
  });
  test("module, exports, require, __filename, __dirname", async () => {
    let { stdout, stderr, exitCode } = Bun.spawnSync({
      cmd: [
        bunExe(),
        "--print",
        `
        console.log(typeof module, typeof exports, typeof require, typeof __filename, typeof __dirname); 123
      `,
      ],
      env: bunEnv,
    });
    expect(stderr.toString("utf8")).toBe("");
    expect(stdout.toString("utf8")).toEqual("object object function string string\n123\n");
    expect(exitCode).toBe(0);
  });
  test("module._compile is require('module').prototype._compile", async () => {
    const { stdout, exitCode } = Bun.spawnSync({
      cmd: [bunExe(), "-p", "module._compile === require('module').prototype._compile"],
      env: bunEnv,
    });
    expect(stdout.toString()).toBe("true\n");
    expect(exitCode).toBe(0);
  });

  // The hoist patterns in [install] are regexes. Compiling them while
  // bunfig.toml loaded initialized JSC before `bun -p` could turn on eval
  // mode, so the script's completion value was dropped and every --print
  // printed undefined.
  describe.each(["hoistPattern", "publicHoistPattern"])("with install.%s in bunfig.toml", key => {
    test.concurrent.each([
      { expr: "Math.max(1, 9)", expected: "9" },
      { expr: "[1, 2].map(x => x * 2)", expected: "[ 2, 4 ]" },
      { expr: "1 + 1", expected: "2" },
      { expr: "(await 1) + 1", expected: "2" },
    ])("bun -p $expr", async ({ expr, expected }) => {
      using dir = tempDir("eval-install-pattern", {
        "bunfig.toml": `[install]\n${key} = ["*eslint*", "!eslint-plugin-*"]\n`,
      });
      await using proc = Bun.spawn({
        cmd: [bunExe(), "-p", expr],
        cwd: String(dir),
        env: bunEnv,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      expect(stderr).toBe("");
      expect(stdout).toBe(`${expected}\n`);
      expect(exitCode).toBe(0);
    });
  });
});

// `scriptArgv` is what `process.argv` holds after the executable: `-` when it asked for stdin.
function group(run: (code: string) => SyncSubprocess<"pipe", "inherit">, scriptArgv: string[] = ["-"]) {
  test("it works", async () => {
    const { stdout } = run('console.log("hello world")');
    expect(stdout.toString("utf8")).toEqual("hello world\n");
  });

  test("it gets a correct specifer", async () => {
    const { stdout } = run("console.log(import.meta.path)");
    expect(stdout.toString("utf8")).toEndWith(sep + "[stdin]\n");
  });

  test("it can require", async () => {
    const { stdout } = run(`
        const process = require("node:process");
        console.log(process.platform);
      `);
    expect(stdout.toString("utf8")).toEqual(process.platform + "\n");
  });

  test("it can import", async () => {
    const { stdout } = run(`
        import * as process from "node:process";
        console.log(process.platform);
      `);
    expect(stdout.toString("utf8")).toEqual(process.platform + "\n");
  });

  test("process.argv", async () => {
    const { stdout } = run("console.log(process.argv)");
    const exe = isWindows ? bunExe().replaceAll("/", "\\") : bunExe();
    expect(JSON.parse(stdout.toString("utf8"))).toEqual([exe, ...scriptArgv]);
  });

  test("process._eval", async () => {
    const code = "console.log(process._eval)";
    const { stdout } = run(code);

    // the file piping one on windows can include extra carriage returns
    if (isWindows) {
      expect(stdout.toString("utf8")).toInclude(code);
    } else {
      expect(stdout.toString("utf8")).toEqual(code + "\n");
    }
  });

  test('a leading "use strict" makes the script strict', async () => {
    const { stdout } = run(`"use strict";` + strictModeProbe);
    expect(stdout.toString("utf8")).toEqual(strictResult);
  });
}

describe("bun run - < file-path.js", () => {
  function run(code: string) {
    // bash only supports / as path separator
    const file = join(tmpdir(), "bun-run-eval-test.js").replaceAll("\\", "/");
    require("fs").writeFileSync(file, code);
    try {
      let result;
      if (process.platform === "win32") {
        result = Bun.spawnSync(["powershell", "-c", `Get-Content ${file} | ${bunExe()} run -`], {
          env: bunEnv,
          stderr: "inherit",
        });
      } else {
        result = Bun.spawnSync(["bash", "-c", `${bunExe()} run - < ${file}`], {
          env: bunEnv,
          stderr: "inherit",
        });
      }

      if (!result.success) {
        queueMicrotask(() => {
          throw new Error("bun run - < file-path.js failed");
        });
      }

      return result;
    } finally {
      try {
        require("fs").unlinkSync(file);
      } catch (e) {}
    }
  }

  group(run);
});

describe("echo | bun run -", () => {
  function run(code: string) {
    const result = Bun.spawnSync([bunExe(), "run", "-"], {
      env: bunEnv,
      stdin: Buffer.from(code),
      stderr: "inherit",
    });
    if (!result.success) {
      queueMicrotask(() => {
        throw new Error("bun run - failed");
      });
    }

    return result;
  }

  group(run);
});

describe("echo | bun", () => {
  function run(code: string) {
    const result = Bun.spawnSync([bunExe()], {
      env: bunEnv,
      stdin: Buffer.from(code),
      stderr: "inherit",
    });
    if (!result.success) {
      queueMicrotask(() => {
        throw new Error("echo | bun failed");
      });
    }

    return result;
  }

  // Nothing on the command line names the script, so `process.argv` has no `-`, as in Node.
  group(run, []);
});

describe.concurrent("a script on a stdin that is not a terminal, without `-`", () => {
  // `pipe` is written to a pipe, which is then closed.
  async function run(
    stdin: Bun.SpawnOptions.Writable | { pipe: string },
    { args = [], cwd, argv0 }: { args?: string[]; cwd?: string; argv0?: string } = {},
  ) {
    const piped = typeof stdin === "object" && "pipe" in stdin ? stdin.pipe : undefined;
    await using proc = Bun.spawn({
      cmd: [bunExe(), ...args],
      argv0,
      cwd,
      env: bunEnv,
      stdin: piped === undefined ? (stdin as Bun.SpawnOptions.Writable) : "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    if (piped !== undefined) {
      const sink = proc.stdin as Bun.FileSink;
      if (piped) sink.write(piped);
      await sink.end();
    }
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    return { stdout, stderr, exitCode };
  }

  test("is TypeScript, with top-level await", async () => {
    const script = `const answer: number = await Promise.resolve(42);\nconsole.log(answer satisfies number);\n`;
    expect(await run(Buffer.from(script))).toEqual({ stdout: "42\n", stderr: "", exitCode: 0 });
  });

  test("echo | bun, through a pipe", async () => {
    expect(await run({ pipe: `console.log("through a pipe");` })).toEqual({
      stdout: "through a pipe\n",
      stderr: "",
      exitCode: 0,
    });
  });

  test("bun < script.ts", async () => {
    using dir = tempDir("bun-stdin-file", {
      "script.ts": `console.log(import.meta.path.endsWith("[stdin]"), "from a file" as string);`,
    });
    expect(await run(Bun.file(join(String(dir), "script.ts")), { cwd: String(dir) })).toEqual({
      stdout: "true from a file\n",
      stderr: "",
      exitCode: 0,
    });
  });

  test("the flags in front of it apply", async () => {
    using dir = tempDir("bun-stdin-flags", {
      "preload.ts": `globalThis.preloaded = "preloaded";`,
    });
    const script = `console.log(globalThis.preloaded, JSON.stringify(process.argv.slice(1)));`;
    expect(await run(Buffer.from(script), { args: ["--preload", "./preload.ts"], cwd: String(dir) })).toEqual({
      stdout: "preloaded []\n",
      stderr: "",
      exitCode: 0,
    });
  });

  test("the exit code is the script's", async () => {
    expect(await run(Buffer.from(`console.log("before"); process.exit(3);`))).toEqual({
      stdout: "before\n",
      stderr: "",
      exitCode: 3,
    });
  });

  test("an uncaught error is reported with [stdin] as its file", async () => {
    const { stdout, stderr, exitCode } = await run(Buffer.from(`throw new Error("thrown on stdin");`));
    expect(stdout).toBe("");
    expect(stderr).toContain("error: thrown on stdin");
    expect(stderr).toContain("[stdin]:1:");
    expect(exitCode).toBe(1);
  });

  test("a stdin that holds nothing gets the help, as before", async () => {
    using dir = tempDir("bun-stdin-empty", { "empty.ts": "" });
    for (const stdin of ["ignore", Bun.file(join(String(dir), "empty.ts")), { pipe: "" }] as const) {
      const { stdout, exitCode } = await run(stdin);
      expect(stdout).toContain("Usage: bun <command>");
      expect(exitCode).toBe(0);
    }
  });

  test("bun run without a script still prints the help of run", async () => {
    const { stdout, exitCode } = await run(Buffer.from(`console.log("the script ran");`), { args: ["run"] });
    expect(stdout).toContain("Usage: bun run");
    expect(stdout).not.toContain("the script ran");
    expect(exitCode).toBe(0);
  });

  test("-e keeps stdin for its code", async () => {
    expect(await run({ pipe: "not a script" }, { args: ["-e", "console.log(await Bun.stdin.text())"] })).toEqual({
      stdout: "not a script\n",
      stderr: "",
      exitCode: 0,
    });
  });

  test.each([
    ["an -e without code", ["--smol", "-e", ""]],
    ["a flag that is not known", ["--not-a-flag-of-bun"]],
  ])("%s does not run stdin", async (_, args) => {
    const { stdout, exitCode } = await run({ pipe: `console.log("the script ran");` }, { args });
    expect(stdout).toContain("Usage: bun <command>");
    expect(stdout).not.toContain("the script ran");
    expect(exitCode).toBe(0);
  });

  test.skipIf(isWindows)("a stdin that cannot be read is an error", async () => {
    using dir = tempDir("bun-stdin-directory", {});
    await using proc = Bun.spawn({
      cmd: ["sh", "-c", 'exec "$0" < "$1"', bunExe(), String(dir)],
      env: bunEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect(stdout).toBe("");
    expect(stderr).toContain("Failed to read the script from stdin");
    expect(exitCode).toBe(1);
  });

  describe("as node", () => {
    test("the script runs, and process.argv has no script in it", async () => {
      const script = `console.log("as node", JSON.stringify(process.argv.slice(1)), require("node:path").basename(__filename));`;
      expect(await run({ pipe: script }, { argv0: "node" })).toEqual({
        stdout: "as node [] [stdin]\n",
        stderr: "",
        exitCode: 0,
      });
    });

    test("node - a b passes a b to the script", async () => {
      const script = `console.log(JSON.stringify(process.argv.slice(1)));`;
      expect(await run({ pipe: script }, { argv0: "node", args: ["-", "a", "b"] })).toEqual({
        stdout: `["-","a","b"]\n`,
        stderr: "",
        exitCode: 0,
      });
    });

    test("an empty stdin runs nothing and exits with 0", async () => {
      expect(await run("ignore", { argv0: "node" })).toEqual({ stdout: "", stderr: "", exitCode: 0 });
    });

    test("a flag that is not known does not run stdin", async () => {
      const { stdout, stderr, exitCode } = await run(
        { pipe: `console.log("the script ran");` },
        { argv0: "node", args: ["--not-a-flag-of-node"] },
      );
      expect(stdout).toBe("");
      expect(stderr).toContain("Missing script to execute");
      expect(exitCode).toBe(1);
    });
  });
});

test.concurrent.each(["-", "run -"])("bun %s with an empty stdin runs nothing", async args => {
  await using proc = Bun.spawn({
    cmd: [bunExe(), ...args.split(" ")],
    env: bunEnv,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  expect({ stdout, stderr, exitCode }).toEqual({ stdout: "", stderr: "", exitCode: 0 });
});

test("process._eval (undefined for normal run)", async () => {
  const cwd = tmpdirSync();
  const file = join(cwd, "test.js");
  writeFileSync(file, "console.log(typeof process._eval)");

  const { stdout } = Bun.spawnSync({
    cmd: [bunExe(), "run", file],
    cwd: cwd,
    env: bunEnv,
  });
  expect(stdout.toString("utf8")).toEqual("undefined\n");

  rmSync(cwd, { recursive: true, force: true });
});

test("uncaught error from a CommonJS-sniffed eval entry reports and exits 1", async () => {
  // The presence of require() makes the eval source evaluate as CommonJS,
  // which used to swallow a top-level throw entirely: no stderr output and
  // exit code 0.
  await using proc = Bun.spawn({
    cmd: [bunExe(), "-e", `require("assert"); throw new Error("eval-cjs-uncaught");`],
    env: bunEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  expect(stderr).toContain("eval-cjs-uncaught");
  expect(stdout).toBe("");
  expect(exitCode).toBe(1);
});

test("uncaught error from a CommonJS-sniffed stdin entry reports and exits 1", async () => {
  await using proc = Bun.spawn({
    cmd: [bunExe(), "-"],
    env: bunEnv,
    stdin: Buffer.from(`require("assert"); throw new Error("stdin-cjs-uncaught");`),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  expect(stderr).toContain("stdin-cjs-uncaught");
  expect(stdout).toBe("");
  expect(exitCode).toBe(1);
});

// The eval entry point (-e, -p, stdin) is transpiled as CommonJS without the
// module wrapper and then evaluated as a classic script. The directive prologue
// of the script is the first thing in the printed text, as it is in node.
describe.concurrent('"use strict" in the eval entry point', () => {
  async function runBun(args: string[], cwd?: string) {
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

  test("bun -e honors a leading directive", async () => {
    const { stdout, stderr, exitCode } = await runBun(["-e", `"use strict"; module.exports;` + strictModeProbe]);
    expect(stderr).toBe("");
    expect(stdout).toBe(strictResult);
    expect(exitCode).toBe(0);
  });

  test("bun -e stays sloppy without the directive", async () => {
    // `module.exports` forces CommonJS. Without it the eval source is an ES
    // module, which is always strict.
    const { stdout, stderr, exitCode } = await runBun(["-e", `module.exports;` + strictModeProbe]);
    expect(stderr).toBe("");
    expect(stdout).toBe(sloppyResult);
    expect(exitCode).toBe(0);
  });

  test("bun -e is strict when the directive follows a comment", async () => {
    const { stdout, stderr, exitCode } = await runBun([
      "-e",
      `// leading comment\n'use strict'; module.exports;` + strictModeProbe,
    ]);
    expect(stderr).toBe("");
    expect(stdout).toBe(strictResult);
    expect(exitCode).toBe(0);
  });

  test("bun -e is strict when another directive comes first", async () => {
    const { stdout, stderr, exitCode } = await runBun([
      "-e",
      `"use client"; "use strict"; module.exports;` + strictModeProbe,
    ]);
    expect(stderr).toBe("");
    expect(stdout).toBe(strictResult);
    expect(exitCode).toBe(0);
  });

  test("bun -e as an ES module is strict", async () => {
    // An import statement makes the eval source an ES module, which is strict
    // with or without the directive.
    const code = `"use strict"; import { ok } from "node:assert"; ok(true);` + strictModeProbe;
    const { stdout, stderr, exitCode } = await runBun(["-e", code]);
    expect(stderr).toBe("");
    expect(stdout).toBe(strictResult);
    expect(exitCode).toBe(0);
  });

  test("bun -p honors a leading directive", async () => {
    const { stdout, stderr, exitCode } = await runBun([
      "-p",
      `"use strict"; module.exports; (function () { return this === undefined; })()`,
    ]);
    expect(stderr).toBe("");
    expect(stdout).toBe("true\n");
    expect(exitCode).toBe(0);
  });

  test("bun -p is strict when another directive comes first", async () => {
    // Both directives are printed in source order, ahead of every statement.
    const { stdout, stderr, exitCode } = await runBun([
      "-p",
      `"use client"; "use strict"; module.exports; (function () { return this === undefined; })()`,
    ]);
    expect(stderr).toBe("");
    expect(stdout).toBe("true\n");
    expect(exitCode).toBe(0);
  });

  test("bun -p prints a lone directive like node does", async () => {
    const { stdout, stderr, exitCode } = await runBun(["-p", `"use strict"`]);
    expect(stderr).toBe("");
    expect(stdout).toBe("use strict\n");
    expect(exitCode).toBe(0);
  });

  test("bun -p prints the last directive, a repeated one too", async () => {
    // A directive is an expression statement. No directive is removed, so the
    // result of the script is the value of the last one.
    const { stdout, stderr, exitCode } = await runBun(["-p", `"a"; "b"; "a"`]);
    expect(stderr).toBe("");
    expect(stdout).toBe("a\n");
    expect(exitCode).toBe(0);
  });

  test("a required CommonJS file is strict when another directive comes first", async () => {
    // The same prologue, inside the CommonJS module wrapper of a required file.
    using dir = tempDir("eval-use-strict", {
      "strict-after-directive.cjs": `"use client";\n"use strict";\nmodule.exports = (function () { return this === undefined; })();\n`,
    });
    const { stdout, stderr, exitCode } = await runBun(["-p", `require("./strict-after-directive.cjs")`], String(dir));
    expect(stderr).toBe("");
    expect(stdout).toBe("true\n");
    expect(exitCode).toBe(0);
  });
});
