import { $ } from "bun";
import { describe, expect, test } from "bun:test";
import { bunEnv, bunExe, isLinux, isPosix, isWindows, tempDir } from "harness";
import { closeSync, openSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestBuilder } from "../test_builder";
const TestBuilder = createTestBuilder(import.meta.path);

// On POSIX `cut` is the system binary unless this flag is set. On Windows the builtin is the default.
const flag = "BUN_ENABLE_EXPERIMENTAL_SHELL_BUILTINS";
const builtinEnv = { ...bunEnv, [flag]: "1" };
// The flag is read once, from the environment that the process starts with.
const builtinIsOn = isWindows || process.env[flag] === "1";

// With an empty PATH the commands below can only be builtins.
const builtinsOnly = { PATH: "" };

// Runs the builtin with `input` on stdin.
async function cut(args: string[], input: string | Uint8Array) {
  const { stdout, stderr, exitCode } = await $`cut ${args} < ${Buffer.from(input)}`.env(builtinsOnly).nothrow().quiet();
  return { stdout: stdout.toString("latin1"), stderr: stderr.toString(), exitCode };
}
// The bytes of a string, one per character, for inputs and outputs that are not UTF-8.
const utf8 = (text: string) => Buffer.from(text, "utf8").toString("latin1");

// Runs `script` in a child that has a real stdin, and returns its output with an `exit=<code>` line at the end.
async function runScript(script: string, stdin: string | number) {
  const run = `Bun.$\`\${{ raw: ${JSON.stringify(script)} }}\`.nothrow().quiet()`;
  const print = `process.stdout.write(r.stdout); process.stderr.write(r.stderr); process.stdout.write("exit=" + r.exitCode + "\\n");`;
  await using proc = Bun.spawn({
    cmd: [bunExe(), "-e", `const r = await ${run}; ${print}`],
    env: builtinEnv,
    stdin: typeof stdin === "number" ? stdin : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (typeof stdin === "string") {
    proc.stdin!.write(stdin);
    proc.stdin!.end();
  }
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

if (!builtinIsOn) {
  test("cut (builtin): this file in a process that starts with the flag", async () => {
    await using proc = Bun.spawn({
      cmd: [bunExe(), "test", import.meta.path],
      env: builtinEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    if (exitCode !== 0) console.error(stdout + stderr);
    expect(stderr).toContain(" 0 fail");
    expect(exitCode).toBe(0);
  }, 300_000);
} else {
  describe("cut", () => {
    test("is a builtin", async () => {
      const { stdout, stderr, exitCode } = await $`echo a,b,c | cut -d, -f2`.env(builtinsOnly).quiet();
      expect({ stdout: stdout.toString(), stderr: stderr.toString(), exitCode }).toEqual({
        stdout: "b\n",
        stderr: "",
        exitCode: 0,
      });
    });

    // GNU cut 9.7 prints the same for every row of this table. The test under it checks that where it can.
    const table = [
      ["-b N-M", ["-b1-3"], "abcdefgh\n", "abc\n"],
      ["-b with a list", ["-b", "1-3,5"], "abcdefgh\n", "abce\n"],
      ["-b N-", ["-b3-"], "abcdefgh\nxy\n", "cdefgh\n\n"],
      ["-b -M", ["-b-2"], "abcdefgh\nx\n\n", "ab\nx\n\n"],
      ["positions are printed in the order of the line", ["-b5-6,1-2"], "abcdefgh\n", "abef\n"],
      ["a position is printed once", ["-b2,2,1-3"], "abcdefgh\n", "abc\n"],
      ["a position past the end of the line", ["-b5"], "abc\n", "\n"],
      ["--bytes", ["--bytes", "2"], "abc\n", "b\n"],
      ["-c on ASCII", ["-c2-3"], "abcdef\n", "bc\n"],
      ["--characters=", ["--characters=1,3"], "abcdef\n", "ac\n"],
      ["-f with a tab", ["-f2"], "a\tb\tc\n", "b\n"],
      ["-f with a list", ["-f1,3"], "a\tb\tc\n", "a\tc\n"],
      ["a line without the delimiter is printed whole", ["-f2"], "a\tb\nnone\n", "b\nnone\n"],
      ["-s leaves out a line without the delimiter", ["-s", "-f2"], "a\tb\nnone\n", "b\n"],
      ["-s keeps a line whose fields are not in the list", ["-s", "-d,", "-f3"], "a,b\n", "\n"],
      ["--only-delimited", ["--only-delimited", "-f1"], "a\tb\nnone\n", "a\n"],
      ["-d", ["-d,", "-f1,3"], "a,b,c\nx\n,,\n", "a,c\nx\n,\n"],
      ["-d as the next argument", ["-d", ",", "-f", "2"], "a,b,c\n", "b\n"],
      ["--delimiter= and --fields=", ["--fields=2", "--delimiter=:"], "a:b:c\n", "b\n"],
      ["options in one cluster", ["-sf2", "-d:"], "a:b\nc\n", "b\n"],
      ["a field that the line does not have", ["-d,", "-f4"], "a,b,c\n", "\n"],
      ["no delimiter after the last field that is there", ["-d,", "-f1,4"], "a,b,c\n", "a\n"],
      ["-f N-", ["-d,", "-f2-"], "a,b,c\n", "b,c\n"],
      ["-f -M", ["-d,", "-f-2"], "a,b,c\n", "a,b\n"],
      ["empty fields", ["-d,", "-f1-"], "a,,c,\n", "a,,c,\n"],
      ["fields are printed in the order of the line", ["-d,", "-f3,1"], "a,b,c\n", "a,c\n"],
      ["a list separated by blanks", ["-d ", "-f1 3"], "a b c\n", "a c\n"],
      ["an empty -d is the NUL byte", ["-d", "", "-f2"], "a\0b\n", "b\n"],
      ["--output-delimiter with -f", ["-d,", "-f1,3", "--output-delimiter= "], "a,b,c\n", "a c\n"],
      ["a longer --output-delimiter", ["-d,", "-f1-", "--output-delimiter", " | "], "a,b,c\n", "a | b | c\n"],
      ["an empty --output-delimiter is the NUL byte", ["-d,", "-f1,3", "--output-delimiter="], "a,b,c\n", "a\0c\n"],
      ["the same between ranges of bytes", ["-b1-2,4-5", "--output-delimiter", ""], "abcdef\n", "ab\0de\n"],
      [
        "--output-delimiter between ranges of bytes",
        ["-b1-3,5-6", "--output-delimiter=:"],
        "abcdefgh\nab\n",
        "abc:ef\nab\n",
      ],
      ["ranges that touch are two ranges", ["-b1-3,4-6", "--output-delimiter=:"], "abcdefgh\n", "abc:def\n"],
      ["ranges that overlap are one range", ["-b5-6,1-3,2-4", "--output-delimiter=:"], "abcdefgh\n", "abcd:ef\n"],
      ["--complement with -b", ["-b2", "--complement"], "abcdefgh\n", "acdefgh\n"],
      ["--complement with -c", ["-c2-3", "--complement"], "abcdef\n", "adef\n"],
      ["--complement with -f", ["-d,", "-f2", "--complement"], "a,b,c\n", "a,c\n"],
      ["--complement and --output-delimiter", ["-c2-3", "--complement", "--output-delimiter=|"], "abcdef\n", "a|def\n"],
      ["-z", ["-z", "-d,", "-f2"], "a,b\0c,d\0", "b\0d\0"],
      ["--zero-terminated keeps newlines in a line", ["--zero-terminated", "-b1-3"], "a\nbc\0de", "a\nb\0de\0"],
      ["a last line without a newline gets one", ["-d,", "-f1"], "no trailing newline,x", "no trailing newline\n"],
      ["no input", ["-b1"], "", ""],
      ["empty lines", ["-b1"], "\n\n", "\n\n"],
      ["-- ends the options", ["-f1", "--"], "a\tb\n", "a\n"],
      // A delimiter that is the line terminator: the lines of the input are the fields of one record.
      ["-d with a newline selects lines", ["-d", "\n", "-f2"], "a\nb\nc\n", "b\n"],
      ["and joins them with it", ["-d", "\n", "-f1-2"], "a\nb\nc\n", "a\nb\n"],
      ["or with --output-delimiter", ["-d", "\n", "-f1,3", "--output-delimiter=:"], "a\nb\nc\n", "a:c\n"],
      ["a last line without a newline is a field", ["-d", "\n", "-f3-"], "a\nb\nc", "c\n"],
      ["a line that is not there is an empty record", ["-d", "\n", "-f4"], "a\nb\nc\n", "\n"],
      ["one line without a newline has no delimiter", ["-s", "-d", "\n", "-f1"], "a", ""],
      ["-s and one line whose field is not in the list", ["-s", "-d", "\n", "-f2"], "a\n", ""],
      ["no input is no record", ["-d", "\n", "-f1"], "", ""],
      ["-z and an empty -d", ["-z", "-d", "", "-f2"], "a\0b\0c\0", "b\0"],
    ] as const;
    describe.each(table)("%s", (_, args, input, expected) => {
      test(`cut ${args.join(" ")}`, async () => {
        expect(await cut([...args], input)).toEqual({ stdout: expected, stderr: "", exitCode: 0 });
      });
    });

    const systemCut = isLinux ? Bun.which("cut") : null;
    const isGnu97 =
      systemCut !== null &&
      Bun.spawnSync([systemCut, "--version"]).stdout.toString().startsWith("cut (GNU coreutils) 9.7\n");
    test.skipIf(!isGnu97)("the table is what GNU cut 9.7 prints", () => {
      for (const [name, args, input, expected] of table) {
        const gnu = Bun.spawnSync({
          cmd: [systemCut!, ...args],
          stdin: Buffer.from(input),
          env: { LC_ALL: "C" },
          stdout: "pipe",
          stderr: "pipe",
        });
        expect([name, gnu.stdout.toString("latin1"), gnu.stderr.toString(), gnu.exitCode]).toEqual([
          name,
          expected,
          "",
          0,
        ]);
      }
    });

    // Text is UTF-8, whatever the locale says. GNU cut does the same since 9.11, in a UTF-8 locale.
    describe("characters", () => {
      test.each([
        [["-c2"], "héllo\n", "é\n"],
        [["-c1,3-"], "héllo wörld\n", "hllo wörld\n"],
        [["-c2-3"], "日本語のテキスト\n", "本語\n"],
        [["-c1", "--complement"], "😀 smile\n", " smile\n"],
        [["-c1,3", "--output-delimiter=:"], "añb\n", "a:b\n"],
        [["-d→", "-f2"], "a→b→c\n", "b\n"],
        // -n: a character goes with its last byte. `é` is bytes 2 and 3.
        [["-n", "-b1-2"], "héllo\n", "h\n"],
        [["-n", "-b1-3"], "héllo\n", "hé\n"],
        [["-n", "-b2"], "héllo\n", "\n"],
        [["-n", "-b3"], "héllo\n", "é\n"],
        [["-n", "-b3-"], "héllo\n", "éllo\n"],
        [["-n", "-b1,3", "--output-delimiter=:"], "héllo\n", "h:é\n"],
      ] as const)("cut %j of %j", async (args, input, expected) => {
        expect(await cut([...args], input)).toEqual({ stdout: utf8(expected), stderr: "", exitCode: 0 });
      });

      test("-b without -n counts bytes", async () => {
        expect(await cut(["-b2-3"], "héllo\n")).toEqual({ stdout: utf8("é\n"), stderr: "", exitCode: 0 });
        expect(await cut(["-b2"], "héllo\n")).toEqual({ stdout: "\xc3\n", stderr: "", exitCode: 0 });
      });

      // A byte that is not part of a well-formed sequence is a character of its own, so a file in
      // another encoding keeps its columns.
      test.each([
        ["Windows-1252", ["-c2"], [0x41, 0xe9, 0x42, 0x0a], [0xe9, 0x0a]],
        ["Windows-1252, after the byte", ["-c3"], [0x41, 0xe9, 0x42, 0x0a], [0x42, 0x0a]],
        ["two such bytes in a row", ["-c3-"], [0xe9, 0xe8, 0x41, 0x42, 0x0a], [0x41, 0x42, 0x0a]],
        ["a continuation byte alone", ["-c1"], [0x80, 0x41, 0x0a], [0x80, 0x0a]],
        ["a lead byte without its continuation", ["-c2"], [0xc3, 0x41, 0x0a], [0x41, 0x0a]],
        ["a sequence that the line cuts short", ["-c2"], [0x41, 0xe2, 0x82, 0x0a], [0xe2, 0x0a]],
        ["bytes that no sequence starts with", ["-c2-"], [0x61, 0xff, 0xfe, 0x62, 0x0a], [0xff, 0xfe, 0x62, 0x0a]],
      ] as const)("%s", async (_, args, input, expected) => {
        const { stdout, exitCode } = await $`cut ${args} < ${new Uint8Array(input)}`.env(builtinsOnly).quiet();
        expect([...stdout]).toEqual([...expected]);
        expect(exitCode).toBe(0);
      });
    });

    describe("usage errors", () => {
      // A bad list or delimiter has the message of GNU cut. A bad option has the one of the other builtins.
      test.each([
        [[], "cut: you must specify a list of bytes, characters, or fields\n"],
        [["-f"], "cut: option requires an argument -- f\n"],
        [["--fields"], "cut: option '--fields' requires an argument\n"],
        [["-f0"], "cut: fields are numbered from 1\n"],
        [["-b0"], "cut: byte/character positions are numbered from 1\n"],
        [["-f1,,2"], "cut: fields are numbered from 1\n"],
        [["-f3-1"], "cut: invalid decreasing range\n"],
        [["-f", "-"], "cut: invalid range with no endpoint: -\n"],
        [["-fx"], "cut: invalid field value 'x'\n"],
        [["-b", "1-x"], "cut: invalid byte/character position 'x'\n"],
        [["-b1", "-f2"], "cut: only one list may be specified\n"],
        [["-f1", "-f2"], "cut: only one list may be specified\n"],
        [["-d,", "-b1"], "cut: an input delimiter may be specified only when operating on fields\n"],
        [["-s", "-b1"], "cut: suppressing non-delimited lines makes sense\n\tonly when operating on fields\n"],
        [["-dab", "-f1"], "cut: the delimiter must be a single character\n"],
        [["-f1", "-q"], "cut: illegal option -- q\n"],
        [["-f1", "--nope"], "cut: illegal option -- -\n"],
        // GNU cut takes a long option by any prefix that names one. The builtins take it in full.
        [["--delim=:", "-f1"], "cut: illegal option -- -\n"],
        [["-w", "-f1"], "cut: unsupported option, please open a GitHub issue -- -w\n"],
      ] as const)("cut %j", async (args, stderr) => {
        expect(await cut([...args], "a\tb\n")).toEqual({ stdout: "", stderr, exitCode: 1 });
      });
    });

    TestBuilder.command`cut -d, -f2 a.csv`
      .env(builtinsOnly)
      .file("a.csv", "a,b,c\nd,e,f\n")
      .stdout("b\ne\n")
      .stderr("")
      .runAsTest("file operand");

    TestBuilder.command`cut -f2 a.tsv b.tsv`
      .env(builtinsOnly)
      .file("a.tsv", "one\ttwo\n")
      .file("b.tsv", "three\tfour\n")
      .stdout("two\nfour\n")
      .stderr("")
      .runAsTest("several files");

    TestBuilder.command`cut -b1-2 a.txt b.txt`
      .env(builtinsOnly)
      .file("a.txt", "no newline at the end")
      .file("b.txt", "second\n")
      .stdout("no\nse\n")
      .stderr("")
      .runAsTest("the last line of a file does not run into the next file");

    TestBuilder.command`cut -d ${"\n"} -f2 a.txt b.txt`
      .env(builtinsOnly)
      .file("a.txt", "a1\na2\n")
      .file("b.txt", "b1\nb2\n")
      .stdout("a2\nb2\n")
      .stderr("")
      .runAsTest("with a newline as the delimiter every file is a record");

    // The options come first, as in POSIX. GNU cut also takes them behind an operand.
    TestBuilder.command`cut a.csv -d, -f2`
      .env(builtinsOnly)
      .file("a.csv", "a,b,c\n")
      .exitCode(1)
      .stdout("")
      .stderr("cut: you must specify a list of bytes, characters, or fields\n")
      .runAsTest("an option behind an operand is an operand");

    TestBuilder.command`cut -f1 missing.txt a.tsv`
      .env(builtinsOnly)
      .file("a.tsv", "one\ttwo\n")
      .exitCode(1)
      .stdout("one\n")
      .stderr("cut: missing.txt: No such file or directory\n")
      .runAsTest("an unreadable operand is reported and the rest are still cut");

    TestBuilder.command`cut -f1 missing.txt a.tsv 2> err.txt`
      .env(builtinsOnly)
      .file("a.tsv", "one\ttwo\n")
      .exitCode(1)
      .stdout("one\n")
      .stderr("")
      .fileEquals("err.txt", "cut: missing.txt: No such file or directory\n")
      .runAsTest("the message goes to a redirected stderr and the rest are still cut");

    if (isPosix) {
      TestBuilder.command`mkdir dir; cut -f1 dir a.tsv`
        .env(builtinsOnly)
        .file("a.tsv", "one\ttwo\n")
        .exitCode(1)
        .stdout("one\n")
        .stderr("cut: dir: Is a directory\n")
        .runAsTest("a directory operand");
    }

    if (isLinux) {
      TestBuilder.command`cut -f1 missing.txt a.tsv 2> /dev/full`
        .env(builtinsOnly)
        .file("a.tsv", "one\ttwo\n")
        .exitCode(1)
        .stdout("one\n")
        .stderr("")
        .runAsTest("the rest are still cut when stderr does not take the message");

      TestBuilder.command`cut -b1 a.txt b.txt > /dev/full || echo write-failed`
        .env(builtinsOnly)
        .file("a.txt", "abc\n")
        .file("b.txt", "def\n")
        .stdout("write-failed\n")
        .stderr("cut: write error: No space left on device\n")
        .runAsTest("a stdout that fails ends the command with a message and exit code 1");
    }

    TestBuilder.command`echo from,stdin | cut -d, -f1 a.csv - b.csv`
      .env(builtinsOnly)
      .file("a.csv", "a,1\n")
      .file("b.csv", "b,2\n")
      .stdout("a\nfrom\nb\n")
      .stderr("")
      .runAsTest("the operand - is stdin, in its place among the files");

    TestBuilder.command`echo once,only | cut -d, -f1 - -`
      .env(builtinsOnly)
      .stdout("once\n")
      .stderr("")
      .runAsTest("stdin is read once");

    TestBuilder.command`cut -d: -f1 < in.txt`
      .env(builtinsOnly)
      .file("in.txt", "root:x:0\nbun:x:1000\n")
      .stdout("root\nbun\n")
      .stderr("")
      .runAsTest("stdin redirected from a file");

    TestBuilder.command`cut -d: -f2 in.txt > out.txt`
      .env(builtinsOnly)
      .file("in.txt", "a:b\nc:d\n")
      .stdout("")
      .stderr("")
      .fileEquals("out.txt", "b\nd\n")
      .runAsTest("stdout redirected to a file");

    TestBuilder.command`echo $(echo a:b:c | cut -d: -f3)`
      .env(builtinsOnly)
      .stdout("c\n")
      .stderr("")
      .runAsTest("inside command substitution");

    TestBuilder.command`echo "a b c" | cut -d " " -f 2 | wc -c`
      .env(builtinsOnly)
      .stdout("2\n")
      .stderr("")
      .runAsTest("in the middle of a pipeline");

    test("lines that are read in more than one piece", async () => {
      // More than a pipe holds, so lines are split between reads and the reader waits for the writer.
      const fields = ["first", Buffer.alloc(80, "m").toString(), "last"];
      const lines = 20_000;
      using dir = tempDir("cut-large", { "in.csv": (fields.join(",") + "\n").repeat(lines) });
      const { stdout, stderr, exitCode } = await $`cut -d, -f1,3 < in.csv | head -n ${lines}`
        .cwd(String(dir))
        .env(builtinsOnly)
        .quiet();
      expect(stderr.toString()).toBe("");
      expect(stdout.toString() === "first,last\n".repeat(lines)).toBe(true);
      expect(exitCode).toBe(0);
    });

    test("a large file operand", async () => {
      const lines = 20_000;
      using dir = tempDir("cut-large-file", { "in.txt": "0123456789abcdefghijklmnopqrstuvwxyz\n".repeat(lines) });
      const { stdout, exitCode } = await $`cut -c1,11,36 in.txt`.cwd(String(dir)).env(builtinsOnly).quiet();
      expect(stdout.toString() === "0az\n".repeat(lines)).toBe(true);
      expect(exitCode).toBe(0);
    });

    test("it ends when what reads its stdout ends", async () => {
      const { stdout, exitCode } = await $`yes abc | cut -b2 | head -n 2`.env(builtinsOnly).quiet();
      expect({ stdout: stdout.toString(), exitCode }).toEqual({ stdout: "b\nb\n", exitCode: 0 });
    });

    test("any number of operands that are dealt with at once", async () => {
      // One native frame per such operand would end the process here.
      const script = `
        const operands = Array(100_000).fill("-");
        const r = await Bun.$\`cut -b1 \${operands} < \${Buffer.from("xyz\\n")}\`.env({ PATH: "" }).nothrow().quiet();
        process.stdout.write(r.stdout);
      `;
      await using proc = Bun.spawn({ cmd: [bunExe(), "-e", script], env: builtinEnv, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      expect({ stdout, stderr }).toEqual({ stdout: "x\n", stderr: "" });
      expect(exitCode).toBe(0);
    }, 60_000);

    // Every `cut` that reads the stdin of the shell listens to one shared reader.
    describe("on the stdin of the process", () => {
      test.each([
        ["cut -b1; echo ---; cut -b1", "hi\nyo\n", "h\ny\n---\n"],
        ["cut -b1 - -; echo ---; cut -b2", "hi\n", "h\n---\n"],
        ["echo ab | (cut -b1; echo ---; cut -b1)", "", "a\n---\n"],
      ] as const)("a later cut reads the end: %s", async (script, input, expected) => {
        expect(await runScript(script, input)).toEqual({ stdout: `${expected}exit=0\n`, stderr: "", exitCode: 0 });
      });

      test.skipIf(isWindows)("a stdin that cannot be read", async () => {
        // read() fails on a directory.
        const fd = openSync(import.meta.dir, "r");
        try {
          expect(await runScript("cut -b1 || echo failed", fd)).toEqual({
            stdout: "failed\nexit=0\n",
            stderr: "cut: stdin: Is a directory\n",
            exitCode: 0,
          });
        } finally {
          closeSync(fd);
        }
      });
    });

    test.skipIf(isWindows).each(["cut -b1-", "cut -d, -f1"])(
      "%s stops reading while nothing takes its output",
      async command => {
        using dir = tempDir("shell-cut-backpressure", {});
        const release = join(String(dir), "release");
        expect(await Bun.spawn(["mkfifo", release]).exited).toBe(0);
        // The next stage never reads its stdin. It exits when the test writes to the FIFO.
        // With an empty PATH the first stage can only be the builtin.
        const script = `await Bun.$\`${command} | /bin/sh -c 'read line < release'\`.env({ PATH: "" }).nothrow();`;
        await using proc = Bun.spawn({
          cmd: [bunExe(), "-e", script],
          env: builtinEnv,
          cwd: String(dir),
          stdin: "pipe",
          stdout: "inherit",
          stderr: "pipe",
        });
        const chunk = Buffer.from("some,line,of,text\n".repeat(4096));
        const limit = 16 * 1024 * 1024;
        let taken = 0;
        while (taken < limit) {
          proc.stdin.write(chunk);
          // A flush that stays pending means the pipe is full and cut has stopped.
          const flushed = Promise.resolve(proc.stdin.flush()).then(() => true);
          if (!(await Promise.race([flushed, Bun.sleep(500).then(() => false)]))) break;
          taken += chunk.length;
        }
        writeFileSync(release, "\n");
        expect(taken).toBeLessThan(limit / 4);
        expect(await proc.stderr.text()).toBe("");
        expect(await proc.exited).toBe(0);
      },
    );

    test.skipIf(!isLinux)("descriptors are closed, also when the command ends early", async () => {
      using dir = tempDir("cut-fds", { "a.txt": "abc\n", "b.txt": "def\n" });
      const count = () => readdirSync("/proc/self/fd").length;
      const run = async () => {
        await $`cut -b1 a.txt missing.txt b.txt`.cwd(String(dir)).env(builtinsOnly).nothrow().quiet();
        await $`yes abc | cut -b2 | head -n 1`.cwd(String(dir)).env(builtinsOnly).nothrow().quiet();
        await $`cut -b1 a.txt b.txt > /dev/full`.cwd(String(dir)).env(builtinsOnly).nothrow().quiet();
      };
      // Before the count, for what the shell opens once.
      await run();
      Bun.gc(true);
      const before = count();
      for (let i = 0; i < 100; i++) await run();
      // The interpreter of a command closes its descriptors when it is collected.
      Bun.gc(true);
      expect(count() - before).toBeLessThanOrEqual(5);
    });

    describe("in the shell of bun exec and bun run", () => {
      test("bun exec", async () => {
        using dir = tempDir("cut-exec", { "in.csv": "a,b,c\nd,e,f\n" });
        await using proc = Bun.spawn({
          cmd: [bunExe(), "exec", "cut -d, -f2 missing.csv in.csv | wc -l; cut -d, -f3 in.csv"],
          cwd: String(dir),
          env: { ...builtinEnv, PATH: "" },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
        expect({ stdout: stdout.replaceAll(" ", ""), stderr }).toEqual({
          stdout: "2\nc\nf\n",
          stderr: "cut: missing.csv: No such file or directory\n",
        });
        expect(exitCode).toBe(0);
      });

      test("a package.json script under --shell=bun", async () => {
        using dir = tempDir("cut-run", {
          "package.json": JSON.stringify({ name: "cut-run", scripts: { second: "cut -d, -f2 in.csv" } }),
          "in.csv": "a,b,c\nd,e,f\n",
        });
        await using proc = Bun.spawn({
          cmd: [bunExe(), "run", "--silent", "--shell=bun", "second"],
          cwd: String(dir),
          env: { ...builtinEnv, PATH: "" },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
        expect({ stdout, stderr }).toEqual({ stdout: "b\ne\n", stderr: "" });
        expect(exitCode).toBe(0);
      });
    });
  });
}
