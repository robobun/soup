import { $ } from "bun";
import { describe, expect, test } from "bun:test";
import { bunEnv, bunExe, isWindows, tempDir } from "harness";
import { readdirSync } from "node:fs";

// Every way to write a background command (`cmd &`), in every place where one
// can start. What a row prints follows from its parts: each job prints its
// token once, and `end` comes last where something waits for the jobs.

// Ends once the file `go` exists. The `touch go` of a row comes after the `&`,
// so a row with a gate only ends if the job really runs in the background.
const gate = "(until [[ -e go ]]; do true; done)";

const shapes: [name: string, print: (token: string) => string, posixOnly?: true][] = [
  ["a command", t => `echo ${t}`],
  ["an && list", t => `true && echo ${t}`],
  ["an || list", t => `false || echo ${t}`],
  ["a pipeline", t => `echo ${t} | cat`],
  ["a subshell", t => `(echo ${t})`],
  ["an if", t => `if true; then echo ${t}; fi`],
  ["a for loop", t => `for x in ${t}; do echo $x; done`],
  ["a while loop", t => `while [[ -z $stop ]]; do echo ${t}; stop=1; done`],
  ["a command substitution", t => `echo $(echo ${t})`],
  ["a process", t => `sh -c 'echo ${t}'`, true],
];

// `ordered`: something waits for the jobs before `end` is printed.
const places: [name: string, script: (jobs: string) => string, ordered: boolean][] = [
  ["the script", jobs => `${jobs} touch go; wait; echo end`, true],
  ["an if", jobs => `if true; then ${jobs} touch go; fi; wait; echo end`, true],
  ["a for loop", jobs => `for k in 1; do ${jobs} touch go; done; wait; echo end`, true],
  ["a while loop", jobs => `while [[ -z $w ]]; do w=1; ${jobs} touch go; done; wait; echo end`, true],
  ["a subshell", jobs => `(${jobs} touch go); echo end`, false],
  ["a subshell that waits", jobs => `(${jobs} touch go; wait); echo end`, true],
  ["another job", jobs => `(${jobs} touch go; wait) & wait; echo end`, true],
  ["a pipeline", jobs => `(${jobs} touch go; wait) | cat; echo end`, true],
  ["a command substitution", jobs => `echo "$(${jobs} touch go)"; echo end`, true],
];

type Row = { name: string; script: string; tokens: string[]; ordered: boolean; posixOnly: boolean; mini: boolean };

const rows: Row[] = [];
for (const [place, script, ordered] of places) {
  for (const [shape, print, posixOnly] of shapes) {
    for (const gated of [false, true]) {
      rows.push({
        name: `${shape}${gated ? " that is held back" : ""}, started in ${place}`,
        script: script(`${gated ? `${gate} && ` : ""}${print("one")} &`),
        tokens: ["one"],
        ordered,
        posixOnly: posixOnly === true,
        // One builtin and one process for each place run under `bun exec` as well.
        mini: gated && (shape === "a command" || shape === "a process"),
      });
    }
  }
  rows.push({
    name: `two jobs that are held back, started in ${place}`,
    script: script(`${gate} && echo one & ${gate} && echo two &`),
    tokens: ["one", "two"],
    ordered,
    posixOnly: false,
    mini: true,
  });
}

function check(row: Row, stdout: string) {
  const lines = stdout.split("\n");
  expect(lines.pop()).toBe("");
  if (row.ordered) {
    expect(lines.pop()).toBe("end");
    expect(lines.sort()).toEqual(row.tokens);
  } else {
    expect(lines.sort()).toEqual([...row.tokens, "end"].sort());
  }
}

describe("background commands: every job, in every place", () => {
  for (const row of rows) {
    test.skipIf(row.posixOnly && isWindows)(row.name, async () => {
      using dir = tempDir("shell-background", {});
      const { stdout, stderr, exitCode } = await $`${{ raw: row.script }}`.cwd(String(dir)).quiet().nothrow();
      expect(stderr.toString()).toBe("");
      check(row, stdout.toString());
      expect(exitCode).toBe(0);
    });
  }
});

describe.concurrent("background commands under bun exec", () => {
  for (const row of rows.filter(row => row.mini)) {
    test.skipIf(row.posixOnly && isWindows)(row.name, async () => {
      using dir = tempDir("shell-background-exec", {});
      await using proc = Bun.spawn({
        cmd: [bunExe(), "exec", row.script],
        cwd: String(dir),
        env: bunEnv,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      expect(stderr).toBe("");
      check(row, stdout);
      expect(exitCode).toBe(0);
    });
  }

  // A loop gives the event loop a turn every 128 rounds. These cross that line
  // with several loops at once.
  const lines = (line: string, count: number) => Buffer.alloc(line.length * count, line).toString();
  const loop = "for i in $(seq 1 60); do /bin/true; done";
  const loops = [
    {
      name: "four loops in a pipeline, without a job",
      script: `${[loop, loop, loop, loop].join(" | ")}; echo end`,
      stdout: "end\n",
    },
    {
      name: "six jobs that loop over a process",
      script: `for j in 1 2 3 4 5 6; do (i=0; while [[ $i -lt 60 ]]; do /bin/true; i=$((i + 1)); done; echo done) & done; wait; echo end`,
      stdout: `${lines("done\n", 6)}end\n`,
    },
    {
      name: "a loop of 200 rounds that starts a job in each",
      script: `for i in $(seq 1 200); do echo job & done; wait; echo end`,
      stdout: `${lines("job\n", 200)}end\n`,
    },
    {
      name: "two jobs that are pipelines of a loop",
      script: `(for i in $(seq 1 300); do echo x; done | cat) & (for i in $(seq 1 300); do echo x; done | cat) & wait; echo end`,
      stdout: `${lines("x\n", 600)}end\n`,
    },
  ];
  for (const { name, script, stdout: expected } of loops) {
    test.skipIf(isWindows)(name, async () => {
      await using proc = Bun.spawn({
        cmd: [bunExe(), "exec", script],
        env: bunEnv,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      expect(stderr).toBe("");
      expect(stdout).toBe(expected);
      expect(exitCode).toBe(0);
    });
  }
});

test("a loop that starts jobs which loop gives the thread up with them", async () => {
  // Each job writes a file and then runs a loop that asks for the event loop's
  // turn. `.run()` comes back at the first such turn: the loop around the jobs
  // has to stop there too, and not start the other 29 first.
  using dir = tempDir("shell-background-yield", {});
  const script = $`for j in $(seq 1 30); do (echo x > started$j; for i in $(seq 1 200); do true; done) & done; wait`
    .cwd(String(dir))
    .quiet()
    .run();
  const started = readdirSync(String(dir)).length;
  const { exitCode } = await script;
  expect(started).toBeLessThanOrEqual(2);
  expect(readdirSync(String(dir)).length).toBe(30);
  expect(exitCode).toBe(0);
});
