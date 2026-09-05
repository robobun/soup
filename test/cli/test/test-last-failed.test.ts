import { describe, expect, test } from "bun:test";
import { bunEnv, bunExe, tempDir } from "harness";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const passing = `import { test, expect } from "bun:test";\ntest("ok", () => expect(1).toBe(1));\n`;
const failing = `import { test, expect } from "bun:test";\ntest("bad", () => expect(1).toBe(2));\n`;
const throwing = `throw new Error("boom at load");\n`;

const fixture = {
  "package.json": JSON.stringify({ name: "last-failed-test", type: "module" }),
  "a.test.ts": passing,
  "b.test.ts": failing,
  "c.test.ts": throwing,
};

/** A project plus its own cache directory, so runs do not see each other's record. */
function project(files: Record<string, string> = fixture) {
  const dir = tempDir("last-failed", { ...files, "cache/.keep": "" });
  const cwd = String(dir);
  const cacheDir = join(cwd, "cache");
  async function run(...args: string[]) {
    await using proc = Bun.spawn({
      cmd: [bunExe(), "test", ...args],
      cwd,
      env: { ...bunEnv, XDG_CACHE_HOME: cacheDir },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    return { stdout, stderr, exitCode };
  }
  /** The test files that ran, by their file header in the output. */
  function ran(stderr: string) {
    return ["a.test.ts", "b.test.ts", "c.test.ts"].filter(n => stderr.includes(n + ":"));
  }
  function records() {
    try {
      return readdirSync(join(cacheDir, "bun", "@test@")).filter(n => n.startsWith("last-failed-"));
    } catch {
      return [];
    }
  }
  return {
    cwd,
    run,
    ran,
    records,
    [Symbol.dispose]() {
      dir[Symbol.dispose]();
    },
  };
}

describe.concurrent("bun test --last-failed", () => {
  test("reruns the files that failed, until they pass", async () => {
    using p = project();

    let r = await p.run();
    expect(p.ran(r.stderr)).toEqual(["a.test.ts", "b.test.ts", "c.test.ts"]);
    expect(r.exitCode).toBe(1);
    expect(p.records()).toHaveLength(1);
    // Nothing is written into the project itself.
    expect(readdirSync(p.cwd).sort()).toEqual(["a.test.ts", "b.test.ts", "c.test.ts", "cache", "package.json"]);

    r = await p.run("--last-failed");
    expect(r.stderr).toContain("--last-failed: running 2/3 test files");
    expect(p.ran(r.stderr)).toEqual(["b.test.ts", "c.test.ts"]);
    expect(r.exitCode).toBe(1);

    writeFileSync(join(p.cwd, "b.test.ts"), passing);
    r = await p.run("--last-failed");
    expect(p.ran(r.stderr)).toEqual(["b.test.ts", "c.test.ts"]);
    expect(r.exitCode).toBe(1);

    r = await p.run("--last-failed");
    expect(r.stderr).toContain("--last-failed: running 1/3 test files");
    expect(p.ran(r.stderr)).toEqual(["c.test.ts"]);
    expect(r.exitCode).toBe(1);

    writeFileSync(join(p.cwd, "c.test.ts"), passing);
    r = await p.run("--last-failed");
    expect(p.ran(r.stderr)).toEqual(["c.test.ts"]);
    expect(r.exitCode).toBe(0);

    r = await p.run("--last-failed");
    expect(r.stderr).toContain("--last-failed: no failures last run, nothing to run");
    expect(p.ran(r.stderr)).toEqual([]);
    expect(r.exitCode).toBe(0);
  });

  test("with no previous run there is nothing to run", async () => {
    using p = project();
    const r = await p.run("--last-failed");
    expect(r.stderr).toContain("--last-failed: no previous run recorded, nothing to run");
    expect(p.ran(r.stderr)).toEqual([]);
    expect(r.exitCode).toBe(0);
    expect(p.records()).toEqual([]);
  });

  test("a partial run keeps the failures it did not rerun", async () => {
    using p = project();
    let r = await p.run();
    expect(r.exitCode).toBe(1);

    // Runs only a.test.ts: b and c stay recorded.
    r = await p.run("a.test.ts");
    expect(p.ran(r.stderr)).toEqual(["a.test.ts"]);
    expect(r.exitCode).toBe(0);

    r = await p.run("--last-failed");
    expect(p.ran(r.stderr)).toEqual(["b.test.ts", "c.test.ts"]);

    // A file that passes in a partial run leaves the set.
    writeFileSync(join(p.cwd, "b.test.ts"), passing);
    r = await p.run("b.test.ts");
    expect(r.exitCode).toBe(0);
    r = await p.run("--last-failed");
    expect(p.ran(r.stderr)).toEqual(["c.test.ts"]);
  });

  test("a deleted test file is forgotten", async () => {
    using p = project();
    let r = await p.run();
    expect(r.exitCode).toBe(1);

    rmSync(join(p.cwd, "c.test.ts"));
    r = await p.run("--last-failed");
    expect(r.stderr).toContain("--last-failed: running 1/2 test files");
    expect(p.ran(r.stderr)).toEqual(["b.test.ts"]);
    expect(r.exitCode).toBe(1);

    writeFileSync(join(p.cwd, "b.test.ts"), passing);
    r = await p.run("--last-failed");
    expect(r.exitCode).toBe(0);
  });

  test("--dry-run does not change the record", async () => {
    using p = project();
    let r = await p.run();
    expect(r.exitCode).toBe(1);

    writeFileSync(join(p.cwd, "b.test.ts"), passing);
    r = await p.run("--dry-run");
    expect(r.stderr).toContain("Found");

    r = await p.run("--last-failed");
    expect(p.ran(r.stderr)).toEqual(["b.test.ts", "c.test.ts"]);
  });

  test("--bail records the file it stopped in", async () => {
    using p = project();
    let r = await p.run("--bail");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Bailed out after 1 failure");

    // Only the file the run stopped in is recorded: whichever of b and c ran first.
    r = await p.run("--last-failed");
    expect(r.stderr).toContain("--last-failed: running 1/3 test files");
    expect(p.ran(r.stderr)).toHaveLength(1);
    expect(p.ran(r.stderr)).not.toContain("a.test.ts");
  });

  test("--parallel records failures too", async () => {
    using p = project();
    let r = await p.run("--parallel=2");
    expect(r.exitCode).toBe(1);

    r = await p.run("--last-failed", "--parallel=2");
    expect(r.stderr).toContain("--last-failed: running 2/3 test files");
    expect(r.exitCode).toBe(1);

    writeFileSync(join(p.cwd, "b.test.ts"), passing);
    writeFileSync(join(p.cwd, "c.test.ts"), passing);
    r = await p.run("--last-failed", "--parallel=2");
    expect(r.exitCode).toBe(0);
    r = await p.run("--last-failed");
    expect(r.stderr).toContain("--last-failed: no failures last run, nothing to run");
  });
});
