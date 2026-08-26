import { $ } from "bun";
import { describe, expect, test } from "bun:test";
import { isPosix } from "harness";
import { createTestBuilder } from "../test_builder";
const TestBuilder = createTestBuilder(import.meta.path);

const A = "l1\nl2\nl3\nl4\nl5\n";
// The last line has no trailing newline; tail prints it as it is.
const B = "x\ny\nlast";

describe("tail", async () => {
  test("is a builtin", async () => {
    const { stdout, stderr, exitCode } = await $`seq 1 5 | tail -n 1`.env({ PATH: "" }).quiet();
    expect(stdout.toString()).toBe("5\n");
    expect(stderr.toString()).toBe("");
    expect(exitCode).toBe(0);
  });

  TestBuilder.command`seq 1 200000 | tail -n 2`
    .stdout("199999\n200000\n")
    .stderr("")
    .runAsTest("keeps only the last lines of a large pipe");

  TestBuilder.command`seq 1 200000 | tail -n 1000 | wc -l`
    .stdout("1000\n")
    .stderr("")
    .runAsTest("keeps many lines of a large pipe");

  TestBuilder.command`seq 1 200000 | tail -n +199999`
    .stdout("199999\n200000\n")
    .stderr("")
    .runAsTest("-n +K streams a large pipe from line K on");

  TestBuilder.command`seq 1 200000 | tail -c 7`
    .stdout("200000\n")
    .stderr("")
    .runAsTest("keeps only the last bytes of a large pipe");

  TestBuilder.command`seq 1 20 | tail`
    .stdout("11\n12\n13\n14\n15\n16\n17\n18\n19\n20\n")
    .stderr("")
    .runAsTest("ten lines by default");

  TestBuilder.command`seq 1 5 | tail -n 2`.stdout("4\n5\n").stderr("").runAsTest("-n");

  TestBuilder.command`seq 1 5 | tail -n2`.stdout("4\n5\n").stderr("").runAsTest("-n with the value attached");

  TestBuilder.command`seq 1 5 | tail -2`.stdout("4\n5\n").stderr("").runAsTest("-N is -n N");

  TestBuilder.command`seq 1 5 | tail -n -2`.stdout("4\n5\n").stderr("").runAsTest("-n -N is -n N");

  TestBuilder.command`seq 1 5 | tail --lines=2`.stdout("4\n5\n").stderr("").runAsTest("--lines=N");

  TestBuilder.command`seq 1 5 | tail -n +4`.stdout("4\n5\n").stderr("").runAsTest("-n +K prints from line K on");

  TestBuilder.command`seq 1 5 | tail -n +1`.stdout("1\n2\n3\n4\n5\n").stderr("").runAsTest("-n +1 prints everything");

  TestBuilder.command`seq 1 5 | tail -n +0`.stdout("1\n2\n3\n4\n5\n").stderr("").runAsTest("-n +0 is -n +1");

  TestBuilder.command`seq 1 5 | tail -n +9`.stdout("").stderr("").runAsTest("-n +K past the end prints nothing");

  TestBuilder.command`seq 1 5 | tail -n 0`.stdout("").stderr("").runAsTest("-n 0 prints nothing");

  TestBuilder.command`seq 1 5 | tail -c 4`.stdout("4\n5\n").stderr("").runAsTest("-c");

  TestBuilder.command`seq 1 5 | tail --bytes=3`.stdout("\n5\n").stderr("").runAsTest("--bytes=N");

  TestBuilder.command`seq 1 5 | tail -c +9`.stdout("5\n").stderr("").runAsTest("-c +K prints from byte K on");

  TestBuilder.command`seq 1 5 | tail -n 3 -c 2`.stdout("5\n").stderr("").runAsTest("the last of -n and -c wins");

  TestBuilder.command`tail -n 1 b.txt`
    .file("b.txt", B)
    .stdout("last")
    .stderr("")
    .runAsTest("an unterminated last line is a line and is printed as it is");

  TestBuilder.command`tail -n 2 b.txt`
    .file("b.txt", B)
    .stdout("y\nlast")
    .stderr("")
    .runAsTest("-n 2 with an unterminated last line");

  TestBuilder.command`tail -n 2 a.txt`.file("a.txt", A).stdout("l4\nl5\n").stderr("").runAsTest("file operand");

  TestBuilder.command`tail -n 2 < a.txt`
    .file("a.txt", A)
    .stdout("l4\nl5\n")
    .stderr("")
    .runAsTest("stdin redirected from a file");

  TestBuilder.command`tail -n 2 < ${new Blob(["a\nb\nc\n"])}`
    .stdout("b\nc\n")
    .stderr("")
    .runAsTest("stdin redirected from a Blob");

  TestBuilder.command`tail -n 1 a.txt b.txt`
    .file("a.txt", A)
    .file("b.txt", B)
    .stdout("==> a.txt <==\nl5\n\n==> b.txt <==\nlast")
    .stderr("")
    .runAsTest("several files get headers separated by blank lines");

  TestBuilder.command`tail -q -n 1 a.txt b.txt`
    .file("a.txt", A)
    .file("b.txt", B)
    .stdout("l5\nlast")
    .stderr("")
    .runAsTest("-q suppresses headers");

  TestBuilder.command`tail -v -n 1 a.txt`
    .file("a.txt", A)
    .stdout("==> a.txt <==\nl5\n")
    .stderr("")
    .runAsTest("-v prints a header for a single file");

  TestBuilder.command`echo hi | tail -v`
    .stdout("==> standard input <==\nhi\n")
    .stderr("")
    .runAsTest("stdin is named in headers");

  TestBuilder.command`echo hi | tail -n 1 a.txt -`
    .file("a.txt", A)
    .stdout("==> a.txt <==\nl5\n\n==> standard input <==\nhi\n")
    .stderr("")
    .runAsTest("- reads stdin among file operands");

  TestBuilder.command`tail -n 1 empty.txt`.file("empty.txt", "").stdout("").stderr("").runAsTest("empty file");

  TestBuilder.command`tail -n 1 a.txt > out.txt`
    .file("a.txt", A)
    .fileEquals("out.txt", "l5\n")
    .stdout("")
    .stderr("")
    .runAsTest("stdout redirected to a file");

  TestBuilder.command`echo $(seq 1 5 | tail -n 1)`.stdout("5\n").stderr("").runAsTest("inside command substitution");

  TestBuilder.command`seq 1 5 | tail -n 3 | head -n 1`.stdout("3\n").stderr("").runAsTest("in a pipeline of builtins");

  TestBuilder.command`tail -n 1 a.txt missing.txt b.txt`
    .file("a.txt", A)
    .file("b.txt", B)
    .exitCode(1)
    .stdout("==> a.txt <==\nl5\n\n==> b.txt <==\nlast")
    .stderr("tail: missing.txt: No such file or directory\n")
    .runAsTest("an unreadable operand is reported and the rest are still printed");

  TestBuilder.command`tail -n 1 missing.txt 2> err.txt`
    .ensureTempDir()
    .exitCode(1)
    .stdout("")
    .stderr("")
    .fileEquals("err.txt", "tail: missing.txt: No such file or directory\n")
    .runAsTest("errors go to a redirected stderr");

  if (isPosix) {
    TestBuilder.command`mkdir dir; tail dir`
      .ensureTempDir()
      .exitCode(1)
      .stdout("")
      .stderr("tail: dir: Is a directory\n")
      .runAsTest("directory operand");
  }

  TestBuilder.command`tail -n x a.txt`
    .file("a.txt", A)
    .exitCode(1)
    .stdout("")
    .stderr("tail: invalid number of lines: 'x'\n")
    .runAsTest("a count that is not a number");

  TestBuilder.command`tail -c`
    .exitCode(1)
    .stdout("")
    .stderr("tail: option requires an argument -- c\n")
    .runAsTest("-c without a value");

  TestBuilder.command`tail -x`.exitCode(1).stdout("").stderr("tail: illegal option -- x\n").runAsTest("illegal option");

  TestBuilder.command`tail -f a.txt`
    .file("a.txt", A)
    .exitCode(1)
    .stdout("")
    .stderr("tail: unsupported option, please open a GitHub issue -- -f\n")
    .runAsTest("-f is reported as unsupported");
});
