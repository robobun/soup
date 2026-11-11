import { $ } from "bun";
import { describe, expect, test } from "bun:test";
import { createTestBuilder } from "../test_builder";
const TestBuilder = createTestBuilder(import.meta.path);

// A job that ends once the file `go` exists.
const gate = { raw: "(until [[ -e go ]]; do true; done)" };

describe("wait", () => {
  test("is a builtin", async () => {
    const { stdout, stderr, exitCode } = await $`wait; echo done`.env({ PATH: "" }).quiet();
    expect(stdout.toString()).toBe("done\n");
    expect(stderr.toString()).toBe("");
    expect(exitCode).toBe(0);
  });

  TestBuilder.command`wait`.runAsTest("with no jobs it returns at once");

  TestBuilder.command`${gate} && echo job & touch go; wait; echo after`
    .ensureTempDir()
    .stdout("job\nafter\n")
    .runAsTest("waits for a job that is still running");

  TestBuilder.command`${gate} && echo one & ${gate} && echo two & touch go; wait; echo after`
    .ensureTempDir()
    .stdout(out => {
      const lines = out.split("\n");
      expect(lines.slice(0, 2).sort()).toEqual(["one", "two"]);
      expect(lines.slice(2)).toEqual(["after", ""]);
    })
    .runAsTest("waits for every job");

  TestBuilder.command`echo job & wait; wait; echo after`.stdout("job\nafter\n").runAsTest("twice");

  TestBuilder.command`echo one & wait; echo two & wait; echo after`
    .stdout("one\ntwo\nafter\n")
    .runAsTest("again for a job that started after the first wait");

  TestBuilder.command`false & wait`.exitCode(0).runAsTest("exits with 0 when a job failed");

  describe("waits for the jobs of its own environment only", () => {
    // Each of these ends only if the inner `wait` returns while the job of the
    // script is still running: that job ends when the inner command writes `go`.
    TestBuilder.command`${gate} && echo job & (wait; touch go); wait; echo after`
      .ensureTempDir()
      .stdout("job\nafter\n")
      .runAsTest("in a subshell");

    TestBuilder.command`${gate} && echo job & x=$(wait; touch go); wait; echo after`
      .ensureTempDir()
      .stdout("job\nafter\n")
      .runAsTest("in a command substitution");

    TestBuilder.command`${gate} && echo job & wait | cat; touch go; wait; echo after`
      .ensureTempDir()
      .stdout("job\nafter\n")
      .runAsTest("in a pipeline");

    TestBuilder.command`${gate} && echo job & (wait; touch go) & wait; echo after`
      .ensureTempDir()
      .stdout("job\nafter\n")
      .runAsTest("in another job");

    TestBuilder.command`(${gate} && echo inner & wait; echo "inner done") & touch go; wait; echo after`
      .ensureTempDir()
      .stdout("inner\ninner done\nafter\n")
      .runAsTest("a job waits for the jobs it launched");
  });

  describe("operands", () => {
    TestBuilder.command`wait 12345`
      .exitCode(127)
      .stderr("wait: 12345: not a child of this shell\n")
      .runAsTest("a pid is not known");

    TestBuilder.command`echo job & wait %1; wait; echo after`
      .stdout("job\nafter\n")
      .stderr("wait: %1: not a child of this shell\n")
      .runAsTest("nor is a job id");
  });
});
