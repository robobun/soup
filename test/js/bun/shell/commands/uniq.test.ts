import { $ } from "bun";
import { describe, expect, test } from "bun:test";
import { createTestBuilder } from "../test_builder";
const TestBuilder = createTestBuilder(import.meta.path);

const RUNS = "a\na\nb\nb\nb\nc\na\n";

describe("uniq", async () => {
  test("is a builtin", async () => {
    const { stdout, stderr, exitCode } = await $`uniq < ${new Blob(["a\na\nb\n"])}`.env({ PATH: "" }).quiet();
    expect(stdout.toString()).toBe("a\nb\n");
    expect(stderr.toString()).toBe("");
    expect(exitCode).toBe(0);
  });

  TestBuilder.command`uniq < runs.txt`
    .file("runs.txt", RUNS)
    .stdout("a\nb\nc\na\n")
    .stderr("")
    .runAsTest("stdin, adjacent repeats collapse");

  TestBuilder.command`uniq -c runs.txt`
    .file("runs.txt", RUNS)
    .stdout("      2 a\n      3 b\n      1 c\n      1 a\n")
    .stderr("")
    .runAsTest("-c prefixes the count");

  TestBuilder.command`uniq -d runs.txt`
    .file("runs.txt", RUNS)
    .stdout("a\nb\n")
    .stderr("")
    .runAsTest("-d prints repeated lines once");

  TestBuilder.command`uniq -cd runs.txt`
    .file("runs.txt", RUNS)
    .stdout("      2 a\n      3 b\n")
    .stderr("")
    .runAsTest("-cd counts only the repeated lines");

  TestBuilder.command`uniq -D runs.txt`
    .file("runs.txt", RUNS)
    .stdout("a\na\nb\nb\nb\n")
    .stderr("")
    .runAsTest("-D prints every repeated line");

  TestBuilder.command`uniq -u runs.txt`
    .file("runs.txt", RUNS)
    .stdout("c\na\n")
    .stderr("")
    .runAsTest("-u prints the lines that are not repeated");

  TestBuilder.command`uniq -du runs.txt`
    .file("runs.txt", RUNS)
    .stdout("")
    .stderr("")
    .runAsTest("-d and -u together print nothing, as in GNU uniq");

  TestBuilder.command`uniq -Du runs.txt`
    .file("runs.txt", RUNS)
    .stdout("a\nb\nb\n")
    .stderr("")
    .runAsTest("-D and -u together print the later copies only");

  TestBuilder.command`uniq -i < ${new Blob(["a\nA\nb\n"])}`.stdout("a\nb\n").stderr("").runAsTest("-i ignores case");

  TestBuilder.command`uniq -f 1 < ${new Blob(["x a\ny a\nz b\n"])}`
    .stdout("x a\nz b\n")
    .stderr("")
    .runAsTest("-f skips fields");

  TestBuilder.command`uniq -1 < ${new Blob(["x a\ny a\nz b\n"])}`
    .stdout("x a\nz b\n")
    .stderr("")
    .runAsTest("-N is -f N");

  TestBuilder.command`uniq -s 1 < ${new Blob(["xa\nya\nzb\n"])}`
    .stdout("xa\nzb\n")
    .stderr("")
    .runAsTest("-s skips characters");

  TestBuilder.command`uniq -w 2 < ${new Blob(["abc\nabd\nacd\n"])}`
    .stdout("abc\nacd\n")
    .stderr("")
    .runAsTest("-w compares a prefix");

  TestBuilder.command`uniq --count --repeated --skip-fields=1 < ${new Blob(["1 a\n2 a\n3 b\n"])}`
    .stdout("      2 1 a\n")
    .stderr("")
    .runAsTest("long options");

  TestBuilder.command`uniq < ${new Blob(["a\na"])}`
    .stdout("a\n")
    .stderr("")
    .runAsTest("a last line without a newline gets one");

  TestBuilder.command`uniq -z < ${new Blob(["a\0a\0b\0"])}`
    .stdout("a\0b\0")
    .stderr("")
    .runAsTest("-z uses NUL as the line terminator");

  TestBuilder.command`uniq in.txt out.txt`
    .file("in.txt", "a\na\nb\n")
    .fileEquals("out.txt", "a\nb\n")
    .stdout("")
    .stderr("")
    .runAsTest("a second operand is the output file");

  TestBuilder.command`uniq -c < empty.txt`.file("empty.txt", "").stdout("").stderr("").runAsTest("empty input");

  TestBuilder.command`sort words.txt | uniq -c | sort -rn`
    .file("words.txt", "pear\napple\npear\nfig\npear\napple\n")
    .stdout("      3 pear\n      2 apple\n      1 fig\n")
    .stderr("")
    .runAsTest("sort | uniq -c | sort -rn");

  TestBuilder.command`echo $(uniq runs.txt)`
    .file("runs.txt", RUNS)
    .stdout("a b c a\n")
    .stderr("")
    .runAsTest("inside command substitution");

  TestBuilder.command`uniq missing.txt`
    .ensureTempDir()
    .exitCode(1)
    .stdout("")
    .stderr("uniq: missing.txt: No such file or directory\n")
    .runAsTest("an unreadable input");

  TestBuilder.command`uniq a b c`
    .ensureTempDir()
    .exitCode(1)
    .stdout("")
    .stderr("uniq: extra operand 'c'\n")
    .runAsTest("a third operand");

  TestBuilder.command`uniq -x`.exitCode(1).stdout("").stderr("uniq: illegal option -- x\n").runAsTest("illegal option");

  TestBuilder.command`uniq -f x`
    .exitCode(1)
    .stdout("")
    .stderr("uniq: invalid number of fields to skip: 'x'\n")
    .runAsTest("-f needs a number");

  TestBuilder.command`uniq -cD`
    .exitCode(1)
    .stdout("")
    .stderr("uniq: printing all duplicated lines and repeat counts is meaningless\n")
    .runAsTest("-c and -D together");
});
