import { $ } from "bun";
import { describe, expect, test } from "bun:test";
import { isPosix } from "harness";
import { createTestBuilder } from "../test_builder";
const TestBuilder = createTestBuilder(import.meta.path);

const WORDS = "banana\napple\ncherry\napple\n";
const NUMBERS = "10\n9\n-1\n2.5\n2\nx\n";
const CASES = "b\nB\na\nA\n";
const TABLE = "bob 30\nalice 25\ncarol 30\ndave 5\n";
const CSV = "x,2\ny,10\nz,1\n";

describe("sort", async () => {
  test("is a builtin", async () => {
    const { stdout, stderr, exitCode } = await $`sort < ${new Blob(["b\na\n"])}`.env({ PATH: "" }).quiet();
    expect(stdout.toString()).toBe("a\nb\n");
    expect(stderr.toString()).toBe("");
    expect(exitCode).toBe(0);
  });

  TestBuilder.command`sort < words.txt`
    .file("words.txt", WORDS)
    .stdout("apple\napple\nbanana\ncherry\n")
    .stderr("")
    .runAsTest("stdin, byte order");

  TestBuilder.command`sort -r words.txt`
    .file("words.txt", WORDS)
    .stdout("cherry\nbanana\napple\napple\n")
    .stderr("")
    .runAsTest("-r reverses");

  TestBuilder.command`sort -u words.txt`
    .file("words.txt", WORDS)
    .stdout("apple\nbanana\ncherry\n")
    .stderr("")
    .runAsTest("-u drops repeats");

  TestBuilder.command`sort -n numbers.txt`
    .file("numbers.txt", NUMBERS)
    .stdout("-1\nx\n2\n2.5\n9\n10\n")
    .stderr("")
    .runAsTest("-n compares numerically and reads a line without a number as 0");

  TestBuilder.command`sort -nu < ${new Blob(["1\n01\n1.0\n1.00\n"])}`
    .stdout("1\n")
    .stderr("")
    .runAsTest("-nu keeps the first of numerically equal lines");

  TestBuilder.command`sort -nr numbers.txt`
    .file("numbers.txt", NUMBERS)
    .stdout("10\n9\n2.5\n2\nx\n-1\n")
    .stderr("")
    .runAsTest("-nr reverses the numeric order and the tie-break");

  TestBuilder.command`sort -f cases.txt`
    .file("cases.txt", CASES)
    .stdout("A\na\nB\nb\n")
    .stderr("")
    .runAsTest("-f folds case, equal keys fall back to byte order");

  TestBuilder.command`sort -fs cases.txt`
    .file("cases.txt", CASES)
    .stdout("a\nA\nb\nB\n")
    .stderr("")
    .runAsTest("-s keeps the input order of equal keys");

  TestBuilder.command`sort -fu cases.txt`
    .file("cases.txt", CASES)
    .stdout("a\nb\n")
    .stderr("")
    .runAsTest("-u keeps the first of case-folded equal lines");

  TestBuilder.command`sort -b < ${new Blob(["  b\n a\nc\n"])}`
    .stdout(" a\n  b\nc\n")
    .stderr("")
    .runAsTest("-b ignores leading blanks");

  TestBuilder.command`sort -k2 -n table.txt`
    .file("table.txt", TABLE)
    .stdout("dave 5\nalice 25\nbob 30\ncarol 30\n")
    .stderr("")
    .runAsTest("-k picks a field, global -n applies to it");

  TestBuilder.command`sort -k2,2nr -k1,1 table.txt`
    .file("table.txt", TABLE)
    .stdout("bob 30\ncarol 30\nalice 25\ndave 5\n")
    .stderr("")
    .runAsTest("a key with its own letters ignores the global ones, the next key breaks ties");

  TestBuilder.command`sort -k 2n -s table.txt`
    .file("table.txt", TABLE)
    .stdout("dave 5\nalice 25\nbob 30\ncarol 30\n")
    .stderr("")
    .runAsTest("a key without an end runs to the end of the line");

  TestBuilder.command`sort -t, -k2 -n data.csv`
    .file("data.csv", CSV)
    .stdout("z,1\nx,2\ny,10\n")
    .stderr("")
    .runAsTest("-t sets the field separator");

  TestBuilder.command`sort --field-separator=, --key=2 --numeric-sort --reverse data.csv`
    .file("data.csv", CSV)
    .stdout("y,10\nx,2\nz,1\n")
    .stderr("")
    .runAsTest("long options");

  TestBuilder.command`sort -k1.3 < ${new Blob(["abc\nabd\nabb\n"])}`
    .stdout("abb\nabc\nabd\n")
    .stderr("")
    .runAsTest("a key can start at a character within the field");

  TestBuilder.command`sort < ${new Blob(["b\na"])}`
    .stdout("a\nb\n")
    .stderr("")
    .runAsTest("a last line without a newline gets one");

  TestBuilder.command`sort a.txt b.txt`
    .file("a.txt", "c\na")
    .file("b.txt", "b\n")
    .stdout("a\nb\nc\n")
    .stderr("")
    .runAsTest("file operands are concatenated, a missing newline does not join two lines");

  TestBuilder.command`sort a.txt - a.txt < z.txt`
    .file("a.txt", "y\n")
    .file("z.txt", "z\n")
    .stdout("y\ny\nz\n")
    .stderr("")
    .runAsTest("- reads stdin among file operands");

  TestBuilder.command`sort -o out.txt in.txt`
    .file("in.txt", "b\na\n")
    .fileEquals("out.txt", "a\nb\n")
    .stdout("")
    .stderr("")
    .runAsTest("-o writes the result to a file");

  TestBuilder.command`sort -o in.txt in.txt; sort in.txt`
    .file("in.txt", "b\na\n")
    .stdout("a\nb\n")
    .stderr("")
    .runAsTest("-o can name the input, which is read before it is truncated");

  TestBuilder.command`sort -c < ${new Blob(["a\nb\n"])}`.stdout("").stderr("").runAsTest("-c accepts sorted input");

  TestBuilder.command`sort -c < ${new Blob(["b\na\n"])}`
    .exitCode(1)
    .stdout("")
    .stderr("sort: -:2: disorder: a\n")
    .runAsTest("-c reports the first line out of order");

  TestBuilder.command`sort -cu a.txt`
    .file("a.txt", "a\na\n")
    .exitCode(1)
    .stdout("")
    .stderr("sort: a.txt:2: disorder: a\n")
    .runAsTest("-cu reports a repeated line");

  TestBuilder.command`sort -z < ${new Blob(["b\0a\0"])}`
    .stdout("a\0b\0")
    .stderr("")
    .runAsTest("-z uses NUL as the line terminator");

  TestBuilder.command`sort -n numbers.txt | head -n 1`
    .file("numbers.txt", NUMBERS)
    .stdout("-1\n")
    .stderr("")
    .runAsTest("in a pipeline");

  TestBuilder.command`echo $(sort words.txt)`
    .file("words.txt", WORDS)
    .stdout("apple apple banana cherry\n")
    .stderr("")
    .runAsTest("inside command substitution");

  TestBuilder.command`sort words.txt > out.txt`
    .file("words.txt", WORDS)
    .fileEquals("out.txt", "apple\napple\nbanana\ncherry\n")
    .stdout("")
    .stderr("")
    .runAsTest("stdout redirected to a file");

  TestBuilder.command`sort a.txt missing.txt`
    .file("a.txt", "b\na\n")
    .exitCode(2)
    .stdout("a\nb\n")
    .stderr("sort: cannot read: missing.txt: No such file or directory\n")
    .runAsTest("an unreadable operand is reported and the rest are still sorted");

  if (isPosix) {
    TestBuilder.command`mkdir dir; sort dir`
      .ensureTempDir()
      .exitCode(2)
      .stdout("")
      .stderr("sort: cannot read: dir: Is a directory\n")
      .runAsTest("directory operand");
  }

  TestBuilder.command`sort -x`.exitCode(2).stdout("").stderr("sort: illegal option -- x\n").runAsTest("illegal option");

  TestBuilder.command`sort -k`
    .exitCode(2)
    .stdout("")
    .stderr("sort: option requires an argument -- k\n")
    .runAsTest("-k without a value");

  TestBuilder.command`sort -k 0`
    .exitCode(2)
    .stdout("")
    .stderr("sort: field number is zero: invalid field specification '0'\n")
    .runAsTest("a field number of zero");

  TestBuilder.command`sort -k 1x`
    .exitCode(2)
    .stdout("")
    .stderr("sort: invalid option letter 'x' in field specification '1x'\n")
    .runAsTest("an unknown key letter");

  TestBuilder.command`sort -t ab`
    .exitCode(2)
    .stdout("")
    .stderr("sort: multi-character tab 'ab'\n")
    .runAsTest("a separator must be one character");

  TestBuilder.command`sort -V`
    .exitCode(2)
    .stdout("")
    .stderr("sort: unsupported option, please open a GitHub issue -- V\n")
    .runAsTest("-V is reported as unsupported");
});
