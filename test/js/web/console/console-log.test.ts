import { file, spawn } from "bun";
import { describe, expect, it } from "bun:test";
import { bunEnv, bunExe } from "harness";
import { join } from "node:path";

it("should log to console correctly", async () => {
  const { stdout, stderr, exited } = spawn({
    cmd: [bunExe(), join(import.meta.dir, "console-log.js")],
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
    env: bunEnv,
  });
  const exitCode = await exited;
  const err = (await stderr.text()).replaceAll("\r\n", "\n");
  const out = (await stdout.text()).replaceAll("\r\n", "\n");
  const expected = (await new Response(file(join(import.meta.dir, "console-log.expected.txt"))).text()).replaceAll(
    "\r\n",
    "\n",
  );

  const errMatch = err === "uh oh\n";
  const outmatch = out === expected;

  if (errMatch && outmatch && exitCode === 0) {
    expect().pass();
    return;
  }

  console.error(err);
  console.log("Length of output:", out.length);
  console.log("Length of expected:", expected.length);
  console.log("Exit code:", exitCode);

  expect(out).toBe(expected);
  expect(err).toBe("uh oh\n");
  expect(exitCode).toBe(0);
});

it("long arrays get cutoff", () => {
  // console.log(x) === Bun.inspect(x) + "\n" written to stdout.
  expect(Bun.inspect(Array(1000).fill(0))).toEqual(
    "[\n" +
      "  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,\n" +
      "  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,\n" +
      "  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,\n" +
      "  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,\n" +
      "  ... 900 more items\n" +
      "]",
  );
});

it("console.group", async () => {
  const filepath = join(import.meta.dir, "console-group.fixture.js").replaceAll("\\", "/");
  const proc = Bun.spawnSync({
    cmd: [bunExe(), filepath],
    env: { ...bunEnv, "BUN_JSC_showPrivateScriptsInStackTraces": "0" },
    stdio: ["inherit", "pipe", "pipe"],
  });
  expect(proc.exitCode).toBe(0);
  let stdout = proc.stdout
    .toString("utf8")
    .replaceAll("\r\n", "\n")
    .replaceAll("\\", "/")
    .trim()
    .replaceAll(filepath, "<file>");
  let stderr = proc.stderr
    .toString("utf8")
    .replaceAll("\r\n", "\n")
    .replaceAll("\\", "/")
    .trim()
    .replaceAll(filepath, "<file>")
    // Normalize line numbers for consistency between debug and release builds
    .replace(/\(\d+:\d+\)/g, "(N:NN)")
    .replace(/<file>:\d+:\d+/g, "<file>:NN:NN");
  expect(stdout).toMatchInlineSnapshot(`
"Basic group
  Inside basic group
Outer group
  Inside outer group
  Inner group
    Inside inner group
  Back to outer group
Level 1
  Level 2
    Level 3
      Deep inside
undefined
Empty nested
Test extra end
  Inside
Different logs
  Regular log
  Info log
  Debug log
Complex types
  {
    a: 1,
    b: 2,
  }
  [ 1, 2, 3 ]
null
  undefined
    0
      false
        
          Inside falsy groups
🎉 Unicode!
  Inside unicode group
  Tab\tNewline
Quote"Backslash
    Special chars"
`);
  expect(stderr).toMatchInlineSnapshot(`
"Warning log
  warn: console.warn an error
      at <file>:NN:NN

  52 | console.group("Different logs");
53 | console.log("Regular log");
54 | console.info("Info log");
55 | console.warn("Warning log");
56 | console.warn(new Error("console.warn an error"));
57 | console.error(new Error("console.error an error"));
                       ^
error: console.error an error
      at <file>:NN:NN

  53 | console.log("Regular log");
54 | console.info("Info log");
55 | console.warn("Warning log");
56 | console.warn(new Error("console.warn an error"));
57 | console.error(new Error("console.error an error"));
58 | console.error(new NamedError("console.error a named error"));
                   ^
NamedError: console.error a named error
      at <file>:NN:NN

  NamedError: console.warn a named error
      at <file>:NN:NN

  Error log"
`);
});

it("console.log with SharedArrayBuffer", () => {
  // console.log(x) === Bun.inspect(x) + "\n" written to stdout.
  expect(Bun.inspect(new ArrayBuffer(0))).toBe("ArrayBuffer(0) []");
  expect(Bun.inspect(new SharedArrayBuffer(0))).toBe("SharedArrayBuffer(0) []");
  expect(Bun.inspect(new ArrayBuffer(3))).toBe("ArrayBuffer(3) [ 0, 0, 0 ]");
  expect(Bun.inspect(new SharedArrayBuffer(3))).toBe("SharedArrayBuffer(3) [ 0, 0, 0 ]");
});

describe.concurrent("%c", () => {
  // FORCE_COLOR picks the color depth: 1 is 16 colors, 2 is 256, 3 is 24-bit.
  async function run(code: string, FORCE_COLOR?: "1" | "2" | "3") {
    await using proc = spawn({
      cmd: [bunExe(), "-e", code],
      env: { ...bunEnv, FORCE_COLOR },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    return { stdout, stderr, exitCode };
  }

  it("styles the rest of the message in a color terminal", async () => {
    const { stdout, exitCode } = await run(
      `console.log("%cbold red%c plain %cunderlined on blue", "color: red; font-weight: bold", "", "text-decoration: underline; background-color: rgb(0 0 255 / 50%)")`,
      "3",
    );
    expect(stdout).toBe("\x1b[1;38;2;255;0;0mbold red\x1b[0m plain \x1b[4;48;2;0;0;255munderlined on blue\x1b[0m\n");
    expect(exitCode).toBe(0);
  });

  it("uses the closest color the terminal can show", async () => {
    const code = `console.log("%cx", "color: #ff0000; background: hsl(120 100% 25%)")`;
    expect((await run(code, "3")).stdout).toBe("\x1b[38;2;255;0;0;48;2;0;128;0mx\x1b[0m\n");
    expect((await run(code, "2")).stdout).toBe("\x1b[38;5;196;48;5;28mx\x1b[0m\n");
    expect((await run(code, "1")).stdout).toBe("\x1b[91;42mx\x1b[0m\n");
  });

  it("only consumes its argument when colors are off", async () => {
    const { stdout, exitCode } = await run(`console.log("%cbold%c plain", "font-weight: bold", "", "extra")`);
    expect(stdout).toBe("bold plain extra\n");
    expect(exitCode).toBe(0);
  });

  it("supports italic, line-through and overline, and later declarations win", async () => {
    const { stdout } = await run(
      `console.log("%cx", "font-style: italic; text-decoration: line-through overline; font-weight: 700; font-weight: normal; color: red; color: inherit !important")`,
      "3",
    );
    expect(stdout).toBe("\x1b[3;9;53mx\x1b[0m\n");
  });

  it("ignores properties and values a terminal cannot show", async () => {
    const { stdout } = await run(
      `console.log("%cx%cy", "font-size: 20px; padding: 2px; color: notacolor; color: red blue; font-weight: heavy", "background: url(a;b) no-repeat; text-decoration: wavy")`,
      "3",
    );
    expect(stdout).toBe("xy\n");
  });

  it("reads strings only and never calls toString()", async () => {
    const code = `console.log("%cx", { toString() { throw new Error("toString called"); } })`;
    for (const color of ["3", undefined] as const) {
      const { stdout, stderr, exitCode } = await run(code, color);
      expect(stdout).toBe("x\n");
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
    }
  });

  it("puts the style back after a substitution that prints its own colors", async () => {
    const { stdout } = await run(`console.log("%ca %o b %s c", "color: green", 1, "str")`, "3");
    const green = "\x1b[38;2;0;128;0m";
    expect(stdout).toStartWith(green + "a ");
    expect(stdout).toEndWith(green + " b str c\x1b[0m\n");
    // %s with a string prints no escape codes, so the style is not repeated for it.
    expect(stdout.split(green)).toHaveLength(3);
  });

  it("works with console.error and resets before the remaining arguments", async () => {
    const { stderr } = await run(`console.error("%cwarn", "color: rgb(255, 165, 0)", "tail")`, "3");
    expect(Bun.stripANSI(stderr)).toBe("warn tail\n");
    expect(stderr).toContain("\x1b[38;2;255;165;0mwarn\x1b[0m");
    expect(stderr.indexOf("\x1b[0m", stderr.indexOf("warn"))).toBeLessThan(stderr.indexOf("tail"));
  });
});
