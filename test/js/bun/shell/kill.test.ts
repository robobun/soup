import { $ } from "bun";
import { describe, expect, test } from "bun:test";
import { bunEnv, bunExe, isLinux, isPosix, tempDir } from "harness";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// A process that outlives every test: a test that fails to stop it times out.
// It does end on its own, so that a failing run leaves nothing behind.
const idle = "setTimeout(() => {}, 30_000)";

// Makes `cat` the builtin on every platform, as it is on Windows.
const builtinCat = { BUN_ENABLE_EXPERIMENTAL_SHELL_BUILTINS: "1" };

// A script that tells the test it is up by fetching `url`.
function readyServer() {
  const { promise, resolve } = Promise.withResolvers<void>();
  const server = Bun.serve({
    port: 0,
    fetch() {
      resolve();
      return new Response("ok");
    },
  });
  return { server, ready: promise, url: `http://localhost:${server.port}/` };
}

// Runs `body` (which sets `result`) in its own process, where a builtin that
// does not stop cannot outlive the test. Returns what it printed as JSON.
async function inChild(
  body: string,
  { env = {}, stdin = "pipe" }: { env?: Record<string, string>; stdin?: "pipe" | "ignore" } = {},
) {
  await using proc = Bun.spawn({
    cmd: [
      bunExe(),
      "-e",
      `
      import { $ } from "bun";
      import { existsSync } from "node:fs";
      // A script that does not stop must not outlive a failed test.
      setTimeout(() => process.exit(124), 30_000).unref();
      let result;
      ${body}
      console.log(JSON.stringify({ stdout: result.stdout.toString(), exitCode: result.exitCode }));
      `,
    ],
    env: { ...bunEnv, ...env },
    stdin,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  // A script that is not quiet writes to the same stdout first.
  return JSON.parse(stdout.trimEnd().split("\n").at(-1)!) as { stdout: string; exitCode: number };
}

describe.concurrent("ShellPromise.kill()", () => {
  test("stops the running process and everything after it", async () => {
    const p = $`${bunExe()} -e ${idle}; echo after`.env(bunEnv).quiet().nothrow().run();
    p.kill();
    const result = await p;
    expect(result.stdout.toString()).toBe("");
    expect(result.exitCode).toBe(128 + 15);
  });

  test("rejects with a ShellError like any other exit code", async () => {
    const p = $`${bunExe()} -e ${idle}`.env(bunEnv).quiet().throws(true).run();
    p.kill();
    let error: unknown;
    try {
      await p;
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf($.ShellError);
    expect((error as $.ShellError).exitCode).toBe(143);
  });

  test("takes a signal name or number", async () => {
    const byName = $`${bunExe()} -e ${idle}`.env(bunEnv).quiet().nothrow().run();
    byName.kill("SIGKILL");
    const byNumber = $`${bunExe()} -e ${idle}`.env(bunEnv).quiet().nothrow().run();
    byNumber.kill(2);
    expect((await byName).exitCode).toBe(128 + 9);
    expect((await byNumber).exitCode).toBe(128 + 2);
  });

  test("does not run && and || branches", async () => {
    const and = $`${bunExe()} -e ${idle} && echo and`.env(bunEnv).quiet().nothrow().run();
    const or = $`${bunExe()} -e ${idle} || echo or`.env(bunEnv).quiet().nothrow().run();
    and.kill();
    or.kill();
    const [a, o] = await Promise.all([and, or]);
    expect({ stdout: a.stdout.toString(), exitCode: a.exitCode }).toEqual({ stdout: "", exitCode: 143 });
    expect({ stdout: o.stdout.toString(), exitCode: o.exitCode }).toEqual({ stdout: "", exitCode: 143 });
  });

  test("stops every member of a pipeline", async () => {
    const p = $`${bunExe()} -e ${idle} | ${bunExe()} -e ${idle}; echo after`.env(bunEnv).quiet().nothrow().run();
    p.kill();
    const result = await p;
    expect(result.stdout.toString()).toBe("");
    expect(result.exitCode).toBe(143);
  });

  test("stops a command substitution and the command waiting for it", async () => {
    const p = $`echo before $(${bunExe()} -e ${idle}) after`.env(bunEnv).quiet().nothrow().run();
    p.kill();
    const result = await p;
    expect(result.stdout.toString()).toBe("");
    expect(result.exitCode).toBe(143);
  });

  test("stops a subshell and an if", async () => {
    const subshell = $`(${bunExe()} -e ${idle}; echo inside); echo after`.env(bunEnv).quiet().nothrow().run();
    const cond = $`if ${bunExe()} -e ${idle}; then echo yes; else echo no; fi; echo after`
      .env(bunEnv)
      .quiet()
      .nothrow()
      .run();
    subshell.kill();
    cond.kill();
    const [s, c] = await Promise.all([subshell, cond]);
    expect({ stdout: s.stdout.toString(), exitCode: s.exitCode }).toEqual({ stdout: "", exitCode: 143 });
    expect({ stdout: c.stdout.toString(), exitCode: c.exitCode }).toEqual({ stdout: "", exitCode: 143 });
  });

  test("stops the yes builtin, which never ends", async () => {
    // Once into the buffer that `.quiet()` collects, once into the child's stdout pipe.
    for (const quiet of [".quiet()", ""]) {
      const result = await inChild(`
        const p = $\`yes; echo after\`${quiet}.nothrow().run();
        p.kill();
        const { stdout, exitCode } = await p;
        result = { stdout: stdout.includes("after") ? "after" : "", exitCode };
      `);
      expect(result).toEqual({ stdout: "", exitCode: 143 });
    }
  });

  test("keeps what was written before it", async () => {
    const { server, ready, url } = readyServer();
    using _ = server;
    const script = `console.log("started"); await fetch(${JSON.stringify(url)}); ${idle}`;
    const p = $`echo first; ${bunExe()} -e ${script}; echo after`.env(bunEnv).quiet().nothrow().run();
    await ready;
    p.kill();
    const result = await p;
    expect(result.stdout.toString()).toBe("first\nstarted\n");
    expect(result.exitCode).toBe(143);
  });

  test("before the script has started: nothing runs", async () => {
    using dir = tempDir("shell-kill", {});
    const p = $`echo hi; touch ran`.cwd(String(dir)).quiet().nothrow();
    p.kill();
    const result = await p;
    expect(result.stdout.toString()).toBe("");
    expect(result.exitCode).toBe(143);
    expect(existsSync(join(String(dir), "ran"))).toBe(false);
  });

  test("after the script has finished: nothing happens", async () => {
    const p = $`echo done`.quiet();
    const result = await p;
    p.kill();
    p.kill("SIGKILL");
    expect(result.stdout.toString()).toBe("done\n");
    expect(result.exitCode).toBe(0);
    expect((await p).exitCode).toBe(0);
  });

  test("the first signal decides the exit code", async () => {
    const p = $`${bunExe()} -e ${idle}`.env(bunEnv).quiet().nothrow().run();
    p.kill("SIGINT");
    p.kill("SIGKILL");
    expect((await p).exitCode).toBe(128 + 2);
  });

  test.skipIf(!isPosix)("a process that handles the signal still ends the script as killed", async () => {
    const { server, ready, url } = readyServer();
    using _ = server;
    const script = `
      process.on("SIGTERM", () => { console.log("bye"); process.exit(0); });
      await fetch(${JSON.stringify(url)});
      ${idle}`;
    const p = $`${bunExe()} -e ${script}; echo after`.env(bunEnv).quiet().nothrow().run();
    await ready;
    p.kill();
    const result = await p;
    expect(result.stdout.toString()).toBe("bye\n");
    expect(result.exitCode).toBe(143);
  });

  test.skipIf(!isPosix)("a second signal reaches a process that ignored the first", async () => {
    const { server, ready, url } = readyServer();
    using _ = server;
    const { promise: gotSigterm, resolve } = Promise.withResolvers<void>();
    using ack = Bun.serve({
      port: 0,
      fetch() {
        resolve();
        return new Response("ok");
      },
    });
    const script = `
      process.on("SIGTERM", () => { fetch("http://localhost:${ack.port}/"); });
      await fetch(${JSON.stringify(url)});
      ${idle}`;
    const p = $`${bunExe()} -e ${script}`.env(bunEnv).quiet().nothrow().run();
    await ready;
    p.kill();
    await gotSigterm;
    p.kill("SIGKILL");
    expect((await p).exitCode).toBe(143);
  });

  // The pids that `sh` writes to `pidfile`, once they are all there.
  async function pidsFrom(pidfile: string, count: number) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const pids = existsSync(pidfile) ? readFileSync(pidfile, "utf8").trim().split(/\s+/).map(Number) : [];
      if (pids.length === count && pids.every(pid => pid > 0)) return pids;
      await Bun.sleep(5);
    }
    throw new Error("no pids in " + pidfile);
  }

  test.skipIf(!isPosix)("does not wait for a grandchild that holds the output pipe", async () => {
    using dir = tempDir("shell-kill-grandchild", {});
    const pidfile = join(String(dir), "pid");
    // `sh` dies of the signal; its `sleep` inherits stdout and outlives it.
    const p = $`sh -c ${`sleep 60 & echo $! > ${pidfile}; wait`}`.quiet().nothrow().run();
    const [pid] = await pidsFrom(pidfile, 1);
    try {
      p.kill();
      expect((await p).exitCode).toBe(143);
      // The grandchild is still there: the promise did not wait for it.
      expect(() => process.kill(pid, 0)).not.toThrow();
    } finally {
      process.kill(pid, "SIGKILL");
    }
  });

  test.skipIf(!isPosix)("does not wait for a grandchild of a process that had exited before the kill", async () => {
    using dir = tempDir("shell-kill-orphan", {});
    const pidfile = join(String(dir), "pid");
    // `sh` starts `sleep`, prints and exits; `sleep` keeps stdout open, so the
    // command is still waiting for the end of its output.
    const p = $`sh -c ${`sleep 60 & echo $$ $! > ${pidfile}; echo started`}; echo after`.quiet().nothrow().run();
    const [sh, sleep] = await pidsFrom(pidfile, 2);
    try {
      // Gone from the process table: the shell has seen `sh` exit.
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        try {
          process.kill(sh, 0);
        } catch {
          break;
        }
        await Bun.sleep(5);
      }
      p.kill();
      const result = await p;
      expect(result.stdout.toString()).toBe("started\n");
      expect(result.exitCode).toBe(143);
      expect(() => process.kill(sleep, 0)).not.toThrow();
    } finally {
      process.kill(sleep, "SIGKILL");
    }
  });

  test.skipIf(!isPosix)("ends a builtin that reads a pipe which a grandchild holds", async () => {
    using dir = tempDir("shell-kill-pipe", {});
    const pidfile = join(String(dir), "pid");
    // `sh` dies of the signal, but its `sleep` still holds the pipe into `cat`.
    try {
      const result = await inChild(
        `
        const p = $\`sh -c \${${JSON.stringify(`sleep 60 & echo $! > ${pidfile}; wait`)}} | cat; echo after\`
          .quiet()
          .nothrow()
          .run();
        while (!existsSync(${JSON.stringify(pidfile)})) await Bun.sleep(5);
        p.kill();
        result = await p;
        `,
        { env: builtinCat },
      );
      expect(result).toEqual({ stdout: "", exitCode: 143 });
    } finally {
      const [pid] = await pidsFrom(pidfile, 1);
      process.kill(pid, "SIGKILL");
    }
  });

  test("a builtin that waits for the script's stdin sees it end", async () => {
    // `cat` reads the child's stdin, a pipe that nothing writes to or closes.
    // With the flag it is the builtin on every platform.
    const result = await inChild(
      `
      const p = $\`cat; echo after\`.quiet().nothrow().run();
      p.kill();
      result = await p;
      `,
      { env: builtinCat },
    );
    expect(result).toEqual({ stdout: "", exitCode: 143 });
  });

  test("a builtin that read the script's stdin to its end earlier is left alone", async () => {
    using dir = tempDir("shell-kill-stale", {});
    const marker = JSON.stringify(join(String(dir), "marker"));
    // stdin is empty: `cat` is long done, and its node belongs to another
    // command, when the kill walks the listeners of stdin.
    const result = await inChild(
      `
      const p = $\`cat; echo between; touch \${${marker}}; \${process.execPath} -e \${${JSON.stringify(idle)}}; echo after\`
        .quiet()
        .nothrow()
        .run();
      while (!existsSync(${marker})) await Bun.sleep(5);
      p.kill();
      result = await p;
      `,
      { env: builtinCat, stdin: "ignore" },
    );
    expect(result).toEqual({ stdout: "between\n", exitCode: 143 });
  });

  test.skipIf(!isPosix)("a builtin that turns to the script's stdin after the kill sees it ended", async () => {
    using dir = tempDir("shell-kill-head", { "lines.txt": "1\n2\n" });
    // `head` is at its first operand when the kill arrives, and stdin is a pipe
    // that nothing closes.
    const result = await inChild(`
      const p = $\`head \${${JSON.stringify(join(String(dir), "lines.txt"))}} -\`.quiet().nothrow().run();
      p.kill();
      const { exitCode } = await p;
      result = { stdout: "", exitCode };
    `);
    expect(result).toEqual({ stdout: "", exitCode: 143 });
  });

  test.skipIf(!isLinux)("leaves no file descriptor and no interpreter behind", async () => {
    // In a process of its own: the tests around this one open and close pipes too.
    const result = await inChild(`
      const { heapStats } = require("bun:jsc");
      const { readdirSync } = require("node:fs");
      const fds = () => readdirSync("/proc/self/fd").length;
      const scripts = [
        () => $\`sleep 5; echo after\`,
        () => $\`sleep 5 | cat\`,
        () => $\`sh -c \${"sleep 1 & wait"}\`,
        () => $\`echo $(sleep 5)\`,
        () => $\`sleep 5 > \${Buffer.alloc(16)}\`,
      ];
      async function round(count) {
        for (let i = 0; i < count; i++) {
          const p = scripts[i % scripts.length]().quiet().nothrow().run();
          if (i % 2) await Bun.sleep(1);
          p.kill();
          if ((await p).exitCode !== 143) throw new Error("not killed");
        }
      }
      await round(scripts.length);
      const before = fds();
      await round(scripts.length * 6);
      Bun.gc(true);
      const { ShellInterpreter = 0 } = heapStats().objectTypeCounts;
      result = { stdout: JSON.stringify({ leaked: fds() - before, collected: ShellInterpreter <= 3 }), exitCode: 0 };
    `);
    expect(JSON.parse(result.stdout)).toEqual({ leaked: 0, collected: true });
  });

  test("rejects a signal that does not exist", () => {
    expect(() => $`true`.kill("SIGNOPE" as any)).toThrow(/signal must be one of/);
    expect(() => $`true`.kill(0)).toThrow("Invalid signal");
    expect(() => $`true`.kill(99)).toThrow("Invalid signal");
    expect(() => $`true`.kill(-1)).toThrow("Invalid signal");
    expect(() => $`true`.kill({} as any)).toThrow("Invalid signal");
    expect(() => $`true`.killSignal("SIGNOPE" as any)).toThrow(/signal must be one of/);
    expect(() => $`true`.killSignal(0)).toThrow("Invalid signal");
  });
});

describe.concurrent("ShellPromise.signal()", () => {
  test("kills the script when the signal aborts", async () => {
    const controller = new AbortController();
    const p = $`${bunExe()} -e ${idle}; echo after`.env(bunEnv).quiet().nothrow().signal(controller.signal).run();
    controller.abort();
    const result = await p;
    expect(result.stdout.toString()).toBe("");
    expect(result.exitCode).toBe(143);
  });

  test("rejects with a ShellError unless nothrow() is set", async () => {
    const controller = new AbortController();
    const p = $`${bunExe()} -e ${idle}`.env(bunEnv).quiet().throws(true).signal(controller.signal).run();
    controller.abort(new Error("the reason is not what the promise rejects with"));
    let error: unknown;
    try {
      await p;
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf($.ShellError);
    expect((error as $.ShellError).exitCode).toBe(143);
  });

  test("already aborted: nothing runs", async () => {
    using dir = tempDir("shell-signal", {});
    const result = await $`echo hi; touch ran`.cwd(String(dir)).quiet().nothrow().signal(AbortSignal.abort());
    expect(result.stdout.toString()).toBe("");
    expect(result.exitCode).toBe(143);
    expect(existsSync(join(String(dir), "ran"))).toBe(false);
  });

  test("sends the signal set with killSignal()", async () => {
    const controller = new AbortController();
    const p = $`${bunExe()} -e ${idle}`
      .env(bunEnv)
      .quiet()
      .nothrow()
      .killSignal("SIGKILL")
      .signal(controller.signal)
      .run();
    controller.abort();
    expect((await p).exitCode).toBe(137);
  });

  test("aborting after the script has finished does nothing", async () => {
    const controller = new AbortController();
    const result = await $`echo done`.quiet().signal(controller.signal);
    controller.abort();
    expect(result.stdout.toString()).toBe("done\n");
    expect(result.exitCode).toBe(0);
  });

  test("works with AbortSignal.timeout()", async () => {
    const result = await $`${bunExe()} -e ${idle}`.env(bunEnv).quiet().nothrow().signal(AbortSignal.timeout(1));
    expect(result.exitCode).toBe(143);
  });

  test("needs an AbortSignal, before the script starts", async () => {
    expect(() => $`true`.signal({} as any)).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE", name: "TypeError" }),
    );
    expect(() => $`true`.signal(undefined as any)).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }));
    const p = $`true`.quiet().run();
    expect(() => p.signal(new AbortController().signal)).toThrow("Shell is already running");
    expect(() => p.timeout(1000)).toThrow("Shell is already running");
    expect(() => p.killSignal("SIGKILL")).toThrow("Shell is already running");
    await p;
  });
});

describe.concurrent("ShellPromise.timeout()", () => {
  test("kills the script when the time is up", async () => {
    const result = await $`${bunExe()} -e ${idle}; echo after`.env(bunEnv).quiet().nothrow().timeout(1);
    expect(result.stdout.toString()).toBe("");
    expect(result.exitCode).toBe(143);
  });

  test("rejects with a ShellError unless nothrow() is set", async () => {
    let error: unknown;
    try {
      await $`${bunExe()} -e ${idle}`.env(bunEnv).quiet().throws(true).timeout(1);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf($.ShellError);
    expect((error as $.ShellError).exitCode).toBe(143);
  });

  test("sends the signal set with killSignal()", async () => {
    const result = await $`${bunExe()} -e ${idle}`.env(bunEnv).quiet().nothrow().timeout(1).killSignal(9);
    expect(result.exitCode).toBe(137);
  });

  test("a script that finishes in time is not touched, and the timer does not keep the process alive", async () => {
    const result = await inChild("result = await $`echo quick`.quiet().timeout(2 ** 31 - 1);");
    expect(result).toEqual({ stdout: "quick\n", exitCode: 0 });
  });

  test("needs a number of milliseconds that a timer can hold", () => {
    expect(() => $`true`.timeout("1000" as any)).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }));
    expect(() => $`true`.timeout(-1)).toThrow(expect.objectContaining({ code: "ERR_OUT_OF_RANGE" }));
    expect(() => $`true`.timeout(NaN)).toThrow(expect.objectContaining({ code: "ERR_OUT_OF_RANGE" }));
    expect(() => $`true`.timeout(Infinity)).toThrow(expect.objectContaining({ code: "ERR_OUT_OF_RANGE" }));
    expect(() => $`true`.timeout(2 ** 31)).toThrow(expect.objectContaining({ code: "ERR_OUT_OF_RANGE" }));
  });
});
