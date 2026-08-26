import { $ } from "bun";
import { describe, expect, test } from "bun:test";
import { isPosix } from "harness";
import { createTestBuilder } from "../test_builder";
const TestBuilder = createTestBuilder(import.meta.path);

const A = "l1\nl2\nl3\nl4\nl5\n";
// The last line has no trailing newline; head prints it as it is.
const B = "x\ny\nlast";

describe("head", async () => {
  test("is a builtin", async () => {
    const { stdout, stderr, exitCode } = await $`echo hi | head -n 1`.env({ PATH: "" }).quiet();
    expect(stdout.toString()).toBe("hi\n");
    expect(stderr.toString()).toBe("");
    expect(exitCode).toBe(0);
  });

  test("stops reading an endless pipe once it has enough lines", async () => {
    const { stdout, stderr, exitCode } = await $`yes | head -n 3`.quiet();
    expect(stdout.toString()).toBe("y\ny\ny\n");
    expect(stderr.toString()).toBe("");
    expect(exitCode).toBe(0);
  });

  test("stops reading an endless pipe once it has enough bytes", async () => {
    const { stdout, exitCode } = await $`yes | head -c 5`.quiet();
    expect(stdout.toString()).toBe("y\ny\ny");
    expect(exitCode).toBe(0);
  });

  test("-n 0 reads nothing", async () => {
    const { stdout, exitCode } = await $`yes | head -n 0`.quiet();
    expect(stdout.toString()).toBe("");
    expect(exitCode).toBe(0);
  });

  TestBuilder.command`seq 1 200000 | head -n 3`
    .stdout("1\n2\n3\n")
    .stderr("")
    .runAsTest("stops a large pipe after the first lines");

  TestBuilder.command`seq 1 200000 | head -n -199998`
    .stdout("1\n2\n")
    .stderr("")
    .runAsTest("-n -N streams a large pipe");

  TestBuilder.command`seq 1 20 | head`
    .stdout("1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n")
    .stderr("")
    .runAsTest("ten lines by default");

  TestBuilder.command`seq 1 5 | head -n 2`.stdout("1\n2\n").stderr("").runAsTest("-n");

  TestBuilder.command`seq 1 5 | head -n2`.stdout("1\n2\n").stderr("").runAsTest("-n with the value attached");

  TestBuilder.command`seq 1 5 | head -2`.stdout("1\n2\n").stderr("").runAsTest("-N is -n N");

  TestBuilder.command`seq 1 5 | head --lines=2`.stdout("1\n2\n").stderr("").runAsTest("--lines=N");

  TestBuilder.command`seq 1 5 | head --lines 2`.stdout("1\n2\n").stderr("").runAsTest("--lines N");

  TestBuilder.command`seq 1 5 | head -c 4`.stdout("1\n2\n").stderr("").runAsTest("-c");

  TestBuilder.command`seq 1 5 | head --bytes=3`.stdout("1\n2").stderr("").runAsTest("--bytes=N");

  TestBuilder.command`seq 1 5 | head -n -2`
    .stdout("1\n2\n3\n")
    .stderr("")
    .runAsTest("-n -N prints all but the last N lines");

  TestBuilder.command`seq 1 5 | head -c -3`
    .stdout("1\n2\n3\n4")
    .stderr("")
    .runAsTest("-c -N prints all but the last N bytes");

  TestBuilder.command`seq 1 5 | head -n -0`.stdout("1\n2\n3\n4\n5\n").stderr("").runAsTest("-n -0 prints everything");

  TestBuilder.command`seq 1 5 | head -c 2 -n 3`.stdout("1\n2\n3\n").stderr("").runAsTest("the last of -n and -c wins");

  TestBuilder.command`head -n 3 b.txt`
    .file("b.txt", B)
    .stdout("x\ny\nlast")
    .stderr("")
    .runAsTest("an unterminated last line is printed as it is");

  TestBuilder.command`head -n 2 a.txt`.file("a.txt", A).stdout("l1\nl2\n").stderr("").runAsTest("file operand");

  TestBuilder.command`head -n 2 < a.txt`
    .file("a.txt", A)
    .stdout("l1\nl2\n")
    .stderr("")
    .runAsTest("stdin redirected from a file");

  TestBuilder.command`head -n 2 < ${new Blob(["a\nb\nc\n"])}`
    .stdout("a\nb\n")
    .stderr("")
    .runAsTest("stdin redirected from a Blob");

  TestBuilder.command`head -n 1 a.txt b.txt`
    .file("a.txt", A)
    .file("b.txt", B)
    .stdout("==> a.txt <==\nl1\n\n==> b.txt <==\nx\n")
    .stderr("")
    .runAsTest("several files get headers separated by blank lines");

  TestBuilder.command`head -c 2 a.txt b.txt`
    .file("a.txt", A)
    .file("b.txt", B)
    .stdout("==> a.txt <==\nl1\n==> b.txt <==\nx\n")
    .stderr("")
    .runAsTest("the blank line before a header is the separator, not a newline added to the content");

  TestBuilder.command`head -q -n 1 a.txt b.txt`
    .file("a.txt", A)
    .file("b.txt", B)
    .stdout("l1\nx\n")
    .stderr("")
    .runAsTest("-q suppresses headers");

  TestBuilder.command`head -qn1 a.txt b.txt`
    .file("a.txt", A)
    .file("b.txt", B)
    .stdout("l1\nx\n")
    .stderr("")
    .runAsTest("flags can be clustered");

  TestBuilder.command`head -v -n 1 a.txt`
    .file("a.txt", A)
    .stdout("==> a.txt <==\nl1\n")
    .stderr("")
    .runAsTest("-v prints a header for a single file");

  TestBuilder.command`echo hi | head -v`
    .stdout("==> standard input <==\nhi\n")
    .stderr("")
    .runAsTest("stdin is named in headers");

  TestBuilder.command`echo hi | head -n 1 - b.txt`
    .file("b.txt", B)
    .stdout("==> standard input <==\nhi\n\n==> b.txt <==\nx\n")
    .stderr("")
    .runAsTest("- reads stdin among file operands");

  TestBuilder.command`head -v empty.txt a.txt`
    .file("empty.txt", "")
    .file("a.txt", A)
    .stdout("==> empty.txt <==\n\n==> a.txt <==\nl1\nl2\nl3\nl4\nl5\n")
    .stderr("")
    .runAsTest("an empty file still gets its header");

  TestBuilder.command`head -n 1 a.txt > out.txt`
    .file("a.txt", A)
    .fileEquals("out.txt", "l1\n")
    .stdout("")
    .stderr("")
    .runAsTest("stdout redirected to a file");

  TestBuilder.command`echo $(seq 1 5 | head -n 1)`.stdout("1\n").stderr("").runAsTest("inside command substitution");

  TestBuilder.command`seq 1 5 | head -n 3 | head -n 1`.stdout("1\n").stderr("").runAsTest("in a pipeline of builtins");

  TestBuilder.command`head -n 1 a.txt missing.txt b.txt`
    .file("a.txt", A)
    .file("b.txt", B)
    .exitCode(1)
    .stdout("==> a.txt <==\nl1\n\n==> b.txt <==\nx\n")
    .stderr("head: missing.txt: No such file or directory\n")
    .runAsTest("an unreadable operand is reported and the rest are still printed");

  TestBuilder.command`head -n 1 missing.txt 2> err.txt`
    .ensureTempDir()
    .exitCode(1)
    .stdout("")
    .stderr("")
    .fileEquals("err.txt", "head: missing.txt: No such file or directory\n")
    .runAsTest("errors go to a redirected stderr");

  if (isPosix) {
    TestBuilder.command`mkdir dir; head dir`
      .ensureTempDir()
      .exitCode(1)
      .stdout("")
      .stderr("head: dir: Is a directory\n")
      .runAsTest("directory operand");
  }

  TestBuilder.command`head -n x a.txt`
    .file("a.txt", A)
    .exitCode(1)
    .stdout("")
    .stderr("head: invalid number of lines: 'x'\n")
    .runAsTest("a count that is not a number");

  TestBuilder.command`head -c 1k a.txt`
    .file("a.txt", A)
    .exitCode(1)
    .stdout("")
    .stderr("head: invalid number of bytes: '1k'\n")
    .runAsTest("size suffixes are not accepted");

  TestBuilder.command`head -n`
    .exitCode(1)
    .stdout("")
    .stderr("head: option requires an argument -- n\n")
    .runAsTest("-n without a value");

  TestBuilder.command`head -x`.exitCode(1).stdout("").stderr("head: illegal option -- x\n").runAsTest("illegal option");

  TestBuilder.command`head -z a.txt`
    .file("a.txt", A)
    .exitCode(1)
    .stdout("")
    .stderr("head: unsupported option, please open a GitHub issue -- -z\n")
    .runAsTest("-z is reported as unsupported");
});
