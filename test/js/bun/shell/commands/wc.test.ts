import { $ } from "bun";
import { describe, expect, test } from "bun:test";
import { isPosix } from "harness";
import { createTestBuilder } from "../test_builder";
const TestBuilder = createTestBuilder(import.meta.path);

// a.txt: 3 newlines, 7 words, 34 bytes. The last line has no trailing newline
// and, like wc(1), does not count as a line.
const A = "hello world\nfoo bar baz\n\nlast line";
const B = "x\n";

describe("wc", async () => {
  test("is a builtin", async () => {
    const { stdout, stderr, exitCode } = await $`echo hi | wc -l`.env({ PATH: "" }).quiet();
    expect(stdout.toString()).toBe("1\n");
    expect(stderr.toString()).toBe("");
    expect(exitCode).toBe(0);
  });

  TestBuilder.command`echo hello world | wc`.stdout(" 1  2 12\n").stderr("").runAsTest("stdin, default counts");

  TestBuilder.command`echo hello world | wc -l`.stdout("1\n").stderr("").runAsTest("-l");

  TestBuilder.command`echo hello world | wc -w`.stdout("2\n").stderr("").runAsTest("-w");

  TestBuilder.command`echo hello world | wc -c`.stdout("12\n").stderr("").runAsTest("-c");

  TestBuilder.command`echo ${"héllo"} | wc -m`.stdout("6\n").stderr("").runAsTest("-m counts UTF-8 characters");

  TestBuilder.command`echo ${"héllo"} | wc -c`.stdout("7\n").stderr("").runAsTest("-c counts bytes");

  TestBuilder.command`echo ${"héllo wörld"} | wc -c -m -l -w`
    .stdout(" 1  2 12 14\n")
    .stderr("")
    .runAsTest("columns are always printed in lines, words, chars, bytes order");

  TestBuilder.command`echo hello world | wc -cl`.stdout(" 1 12\n").stderr("").runAsTest("flags can be combined");

  TestBuilder.command`echo hello world | wc --words --lines`.stdout("1 2\n").stderr("").runAsTest("long flags");

  TestBuilder.command`wc a.txt`.file("a.txt", A).stdout(" 3  7 34 a.txt\n").stderr("").runAsTest("file operand");

  TestBuilder.command`wc -l a.txt`
    .file("a.txt", A)
    .stdout("3 a.txt\n")
    .stderr("")
    .runAsTest("single count, single file");

  TestBuilder.command`wc a.txt b.txt`
    .file("a.txt", A)
    .file("b.txt", B)
    .stdout(" 3  7 34 a.txt\n 1  1  2 b.txt\n 4  8 36 total\n")
    .stderr("")
    .runAsTest("multiple files get a total line with aligned columns");

  TestBuilder.command`wc -l b.txt a.txt`
    .file("a.txt", A)
    .file("b.txt", B)
    .stdout("1 b.txt\n3 a.txt\n4 total\n")
    .stderr("")
    .runAsTest("rows follow operand order");

  TestBuilder.command`wc empty.txt`
    .file("empty.txt", "")
    .stdout("0 0 0 empty.txt\n")
    .stderr("")
    .runAsTest("empty file");

  TestBuilder.command`wc -w ws.txt`
    .file("ws.txt", "a\r\nb\tc\vd\fe")
    .stdout("5 ws.txt\n")
    .stderr("")
    .runAsTest("every ASCII whitespace character separates words");

  TestBuilder.command`wc -m -c utf8.txt`
    .file("utf8.txt", "héllo wörld\n")
    .stdout("12 14 utf8.txt\n")
    .stderr("")
    .runAsTest("-m and -c on a file");

  TestBuilder.command`wc -l < a.txt`
    .file("a.txt", A)
    .stdout("3\n")
    .stderr("")
    .runAsTest("stdin redirected from a file");

  TestBuilder.command`wc -l < ${new Blob(["a\nb\nc\n"])}`
    .stdout("3\n")
    .stderr("")
    .runAsTest("stdin redirected from a Blob");

  TestBuilder.command`echo $(echo a b c | wc -w)`.stdout("3\n").stderr("").runAsTest("inside command substitution");

  TestBuilder.command`wc -l a.txt > out.txt`
    .file("a.txt", A)
    .fileEquals("out.txt", "3 a.txt\n")
    .stdout("")
    .stderr("")
    .runAsTest("stdout redirected to a file");

  TestBuilder.command`wc -l a.txt missing.txt b.txt`
    .file("a.txt", A)
    .file("b.txt", B)
    .exitCode(1)
    .stdout("3 a.txt\n1 b.txt\n4 total\n")
    .stderr("wc: missing.txt: No such file or directory\n")
    .runAsTest("an unreadable operand is reported and the rest are still counted");

  TestBuilder.command`wc -l missing1 missing2`
    .ensureTempDir()
    .exitCode(1)
    .stdout("0 total\n")
    .stderr("wc: missing1: No such file or directory\nwc: missing2: No such file or directory\n")
    .runAsTest("total line is printed even when every operand fails");

  TestBuilder.command`wc -l missing.txt a.txt 2> err.txt`
    .file("a.txt", A)
    .exitCode(1)
    .stdout("3 a.txt\n3 total\n")
    .stderr("")
    .fileEquals("err.txt", "wc: missing.txt: No such file or directory\n")
    .runAsTest("errors go to a redirected stderr and counting continues afterwards");

  if (isPosix) {
    TestBuilder.command`mkdir dir; wc -l dir`
      .ensureTempDir()
      .exitCode(1)
      .stdout("0 dir\n")
      .stderr("wc: dir: Is a directory\n")
      .runAsTest("directory operand");
  }

  TestBuilder.command`wc -x`.exitCode(1).stdout("").stderr("wc: illegal option -- x\n").runAsTest("illegal option");

  TestBuilder.command`wc -L a.txt`
    .file("a.txt", A)
    .exitCode(1)
    .stdout("")
    .stderr("wc: unsupported option, please open a GitHub issue -- -L\n")
    .runAsTest("-L is reported as unsupported");
});
