import { spawn } from "bun";
import { dlopen } from "bun:ffi";
import { beforeEach, describe, expect, it } from "bun:test";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { bunEnv, bunExe, isASAN, isDebug, isLinux, isWindows, tempDir, tmpdirSync, waitForFileToExist } from "harness";
import { join } from "path";

const timeout = isDebug ? Infinity : 10_000;
const longTimeout = isDebug ? Infinity : 30_000;

/**
 * Helper to parse stderr from a --hot process that throws errors.
 * Drives the reload cycle: reads error lines from stderr, verifies them,
 * and calls onReload to trigger the next file change.
 *
 * This fixes the original `continue outer` pattern which discarded any
 * remaining buffered lines from the current chunk when a duplicate error
 * was encountered, potentially losing data and causing test hangs.
 */
async function driveErrorReloadCycle(
  runner: Bun.Subprocess<"ignore", "ignore", "pipe">,
  opts: {
    targetCount: number;
    onReload: (counter: number) => void;
    verifyLine?: (errorLine: string, nextLine: string | undefined, counter: number) => void | "retry";
  },
): Promise<number> {
  const { targetCount, onReload, verifyLine } = opts;
  let reloadCounter = 0;
  let str = "";

  for await (const chunk of runner.stderr) {
    str += new TextDecoder().decode(chunk);
    // Need at least one error line followed by a newline, then another line followed by a newline
    if (!/error: .*[0-9]\n.*?\n/g.test(str)) continue;

    const lines = str.split("\n");
    // Preserve trailing partial line for the next chunk
    str = lines.pop() ?? "";
    let triggered = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes("error:")) {
        // Don't silently swallow a watcher-thread death-rattle — surface it so the
        // post-loop "Expected 50, Received N" becomes an actionable failure.
        if (/Watcher crashed|panic:|oh no:/.test(line)) {
          throw new Error("child --hot died: " + line);
        }
        continue;
      }

      if (reloadCounter >= targetCount) {
        runner.kill();
        return reloadCounter;
      }

      // Windows: writeHotFileAtomicSync's rm+rename has a brief gap where the
      // entry file doesn't exist. A reload that lands in it prints one of
      // "Module not found" / "ENOENT reading" / "EPERM reading" (delete
      // pending). Skip it; the rename's own watcher event drives the real
      // reload, so re-saving here would only race that. POSIX rename is
      // atomic, so these showing up there would be a real bug.
      if (isWindows && /Module not found|\w+ reading "/.test(line)) continue;

      // If we see the previous error repeated, the pending reload hasn't
      // taken effect yet. Re-save the file and put remaining unprocessed
      // lines back into the buffer so they aren't lost.
      if (line.includes(`error: ${reloadCounter - 1}`)) {
        const remaining = lines.slice(i + 1).join("\n");
        if (remaining) {
          str = `${remaining}\n${str}`;
        }
        onReload(reloadCounter);
        triggered = false; // onReload already called; skip post-loop call
        break;
      }

      expect(line).toContain(`error: ${reloadCounter}`);

      const nextLine = lines[i + 1];
      if (verifyLine) {
        const result = verifyLine(line, nextLine, reloadCounter);
        if (result === "retry") {
          // Partial bundle read (e.g. --hot picked up the outfile before the
          // inline sourcemap trailer was flushed). Re-trigger the write and
          // re-buffer remaining lines, same as the stale-counter branch above.
          const remaining = lines.slice(i + 1).join("\n");
          if (remaining) {
            str = `${remaining}\n${str}`;
          }
          onReload(reloadCounter);
          triggered = false;
          break;
        }
        i++; // Skip the next line (stack trace)
      }

      reloadCounter++;
      triggered = true;

      if (reloadCounter >= targetCount) {
        runner.kill();
        return reloadCounter;
      }
    }

    if (triggered) {
      onReload(reloadCounter);
    }
  }

  return reloadCounter;
}

let hotRunnerRoot: string = "",
  cwd = "";
beforeEach(() => {
  const hotPath = tmpdirSync();
  hotRunnerRoot = join(hotPath, "hot-runner-root.js");
  rmSync(hotPath, { recursive: true, force: true });
  cpSync(import.meta.dir, hotPath, { recursive: true, force: true });
  cwd = hotPath;
});

it("preload not found should exit with code 1 and not time out", async () => {
  const root = hotRunnerRoot;
  const runner = spawn({
    cmd: [bunExe(), "--preload=/dev/foobarbarbar", "--hot", root],
    env: bunEnv,
    stdout: "inherit",
    stderr: "pipe",
    stdin: "ignore",
  });
  await runner.exited;
  expect(runner.signalCode).toBe(null);
  expect(runner.exitCode).toBe(1);
  expect(await new Response(runner.stderr).text()).toContain("preload not found");
});

it(
  "should hot reload when file is overwritten",
  async () => {
    const root = hotRunnerRoot;
    try {
      var runner = spawn({
        cmd: [bunExe(), "--hot", "run", root],
        env: bunEnv,
        cwd,
        stdout: "pipe",
        stderr: "inherit",
        stdin: "ignore",
      });

      var reloadCounter = 0;

      async function onReload() {
        writeFileSync(root, readFileSync(root, "utf-8"));
      }

      var str = "";
      for await (const line of runner.stdout) {
        str += new TextDecoder().decode(line);
        var any = false;
        if (!/\[#!root\].*[0-9]\n/g.test(str)) continue;

        for (let line of str.split("\n")) {
          if (!line.includes("[#!root]")) continue;
          reloadCounter++;
          str = "";

          if (reloadCounter === 3) {
            runner.unref();
            runner.kill();
            break;
          }

          expect(line).toContain(`[#!root] Reloaded: ${reloadCounter}`);
          any = true;
        }

        if (any) await onReload();
      }

      expect(reloadCounter).toBeGreaterThanOrEqual(3);
    } finally {
      // @ts-ignore
      runner?.unref?.();
      // @ts-ignore
      runner?.kill?.(9);
    }
  },
  timeout,
);

it.each(["hot-file-loader.file", "hot-file-loader.css"])(
  "should hot reload when `%s` is overwritten",
  async (targetFilename: string) => {
    const root = hotRunnerRoot;
    const target = join(cwd, targetFilename);
    try {
      var runner = spawn({
        cmd: [bunExe(), "--hot", "run", root],
        env: bunEnv,
        cwd,
        stdout: "pipe",
        stderr: "inherit",
        stdin: "ignore",
      });

      var reloadCounter = 0;

      async function onReload() {
        writeFileSync(target, readFileSync(target, "utf-8"));
      }

      var str = "";
      for await (const line of runner.stdout) {
        str += new TextDecoder().decode(line);
        var any = false;
        if (!/\[#!root\].*[0-9]\n/g.test(str)) continue;

        for (let line of str.split("\n")) {
          if (!line.includes("[#!root]")) continue;
          reloadCounter++;
          str = "";

          if (reloadCounter === 3) {
            runner.unref();
            runner.kill();
            break;
          }

          expect(line).toContain(`[#!root] Reloaded: ${reloadCounter}`);
          any = true;
        }

        if (any) await onReload();
      }

      expect(reloadCounter).toBeGreaterThanOrEqual(3);
    } finally {
      // @ts-ignore
      runner?.unref?.();
      // @ts-ignore
      runner?.kill?.(9);
    }
  },
  timeout,
);

it(
  "should recover from errors",
  async () => {
    const root = hotRunnerRoot;
    try {
      var runner = spawn({
        cmd: [bunExe(), "--hot", "run", root],
        env: bunEnv,
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      });

      let reloadCounter = 0;
      const input = readFileSync(root, "utf-8");
      function onReloadGood() {
        writeFileSync(root, input);
      }

      function onReloadError() {
        writeFileSync(root, "throw new Error('error');\n");
      }

      var queue = [onReloadError, onReloadGood, onReloadError, onReloadGood];
      var errors: string[] = [];
      var onError: (...args: any[]) => void;
      (async () => {
        for await (let line of runner.stderr) {
          var str = new TextDecoder().decode(line);
          errors.push(str);
          // @ts-ignore
          onError && onError(str);
        }
      })();

      var str = "";
      for await (const line of runner.stdout) {
        str += new TextDecoder().decode(line);
        var any = false;
        if (!/\[#!root\].*[0-9]\n/g.test(str)) continue;

        for (let line of str.split("\n")) {
          if (!line.includes("[#!root]")) continue;
          reloadCounter++;
          str = "";

          if (reloadCounter === 3) {
            runner.unref();
            runner.kill();
            break;
          }

          expect(line).toContain(`[#!root] Reloaded: ${reloadCounter}`);
          any = true;
        }

        if (any) {
          queue.shift()!();
          await new Promise<void>((resolve, reject) => {
            if (errors.length > 0) {
              errors.length = 0;
              resolve();
              return;
            }

            onError = resolve;
          });

          queue.shift()!();
        }
      }

      expect(reloadCounter).toBe(3);
    } finally {
      // @ts-ignore
      runner?.unref?.();
      // @ts-ignore
      runner?.kill?.(9);
    }
  },
  timeout,
);

it(
  "should not hot reload when a random file is written",
  async () => {
    const root = hotRunnerRoot;
    try {
      var runner = spawn({
        cmd: [bunExe(), "--hot", "run", root],
        env: bunEnv,
        cwd,
        stdout: "pipe",
        stderr: "inherit",
        stdin: "ignore",
      });

      // First await the initial run's output — racing this against a fixed
      // sleep meant a slow CI box's >200 ms subprocess startup lost the race
      // and `reloadCounter` stayed 0.
      const reader = runner.stdout.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (!/\[#!root\] Reloaded: 1\n/.test(buf)) {
        const { value, done } = await reader.read();
        if (done) throw new Error("subprocess exited before initial run output");
        buf += dec.decode(value);
      }
      // Now write+unlink an unrelated file and assert it does NOT trigger a
      // second reload. Only the bounded "did anything else arrive?" check is
      // time-based; the condition we care about (initial output) is awaited.
      const code = readFileSync(root, "utf-8");
      writeFileSync(root + ".another.yet.js", code);
      unlinkSync(root + ".another.yet.js");
      buf = "";
      const sawSecond = await Promise.race([
        Bun.sleep(200).then(() => false),
        (async () => {
          while (true) {
            const { value, done } = await reader.read();
            if (done) return false;
            buf += dec.decode(value);
            if (/\[#!root\] Reloaded: 2/.test(buf)) return true;
          }
        })(),
      ]);
      reader.releaseLock();
      runner.kill(0);
      runner.unref();

      expect(sawSecond).toBe(false);
    } finally {
      // @ts-ignore
      runner?.unref?.();
      // @ts-ignore
      runner?.kill?.(9);
    }
  },
  timeout,
);

it(
  "should hot reload when a file is deleted and rewritten",
  async () => {
    try {
      const root = hotRunnerRoot + ".tmp.js";
      copyFileSync(hotRunnerRoot, root);
      var runner = spawn({
        cmd: [bunExe(), "--hot", "run", root],
        env: bunEnv,
        cwd,
        stdout: "pipe",
        stderr: "inherit",
        stdin: "ignore",
      });

      var reloadCounter = 0;

      async function onReload() {
        const contents = readFileSync(root, "utf-8");
        rmSync(root);
        writeFileSync(root, contents);
      }

      var str = "";
      for await (const line of runner.stdout) {
        str += new TextDecoder().decode(line);
        var any = false;
        if (!/\[#!root\].*[0-9]\n/g.test(str)) continue;

        for (let line of str.split("\n")) {
          if (!line.includes("[#!root]")) continue;
          reloadCounter++;
          str = "";

          if (reloadCounter === 3) {
            runner.unref();
            runner.kill();
            break;
          }

          expect(line).toContain(`[#!root] Reloaded: ${reloadCounter}`);
          any = true;
        }

        if (any) await onReload();
      }
      rmSync(root);
      expect(reloadCounter).toBe(3);
    } finally {
      // @ts-ignore
      runner?.unref?.();
      // @ts-ignore
      runner?.kill?.(9);
    }
  },
  timeout,
);

it(
  "should hot reload when a file is renamed() into place",
  async () => {
    const root = hotRunnerRoot + ".tmp.js";
    copyFileSync(hotRunnerRoot, root);
    try {
      var runner = spawn({
        cmd: [bunExe(), "--hot", "run", root],
        env: bunEnv,
        cwd,
        stdout: "pipe",
        stderr: "inherit",
        stdin: "ignore",
      });

      var reloadCounter = 0;

      async function onReload() {
        const contents = readFileSync(root, "utf-8");
        rmSync(root + ".tmpfile", { force: true });
        await 1;
        writeFileSync(root + ".tmpfile", contents);
        await 1;
        rmSync(root);
        await 1;
        renameSync(root + ".tmpfile", root);
        await 1;
      }

      var str = "";
      for await (const line of runner.stdout) {
        str += new TextDecoder().decode(line);
        var any = false;
        if (!/\[#!root\].*[0-9]\n/g.test(str)) continue;

        for (let line of str.split("\n")) {
          if (!line.includes("[#!root]")) continue;
          reloadCounter++;
          str = "";

          if (reloadCounter === 3) {
            runner.unref();
            runner.kill();
            break;
          }

          expect(line).toContain(`[#!root] Reloaded: ${reloadCounter}`);
          any = true;
        }

        if (any) await onReload();
      }
      rmSync(root);
      expect(reloadCounter).toBe(3);
    } finally {
      // @ts-ignore
      runner?.unref?.();
      // @ts-ignore
      runner?.kill?.(9);
    }
  },
  timeout,
);

const comment_line = "//" + Buffer.alloc(2000, "B").toString() + "\n";
const comment_spam = Buffer.alloc(comment_line.length * 1000, comment_line).toString();

// writeFileSync of a ~2MB file is non-atomic (truncate + N×write); each write
// emits a watcher event so --hot can re-read mid-write (Linux: EBADF /
// "Unexpected ..." / :1:12 mis-remap; Windows: ReadDirectoryChangesW
// internal-buffer overflow → nbytes==0 → WindowsWatcher.next() ESHUTDOWN →
// watcher thread dies → child exits → reloadCounter<50). Atomic write+rename
// so the watched path only ever flips between complete versions.
function writeHotFileAtomicSync(path: string, content: string) {
  const tmp = path + ".next";
  writeFileSync(tmp, content);
  // rmSync first on Windows so renameSync doesn't EPERM on the existing target.
  // driveErrorReloadCycle skips the transient "Module not found"/ENOENT/EPERM
  // that --hot can print when a reload lands in the gap between rm and rename.
  if (process.platform === "win32") {
    try {
      rmSync(path);
    } catch {}
  }
  renameSync(tmp, path);
}

it(
  "should work with sourcemap generation",
  async () => {
    writeFileSync(
      hotRunnerRoot,
      `// source content
${comment_spam}
throw new Error('0');`,
    );
    await using runner = spawn({
      cmd: [bunExe(), "--smol", "--hot", "run", hotRunnerRoot],
      env: bunEnv,
      cwd,
      stdout: "ignore",
      stderr: "pipe",
      stdin: "ignore",
    });
    const reloadCounter = await driveErrorReloadCycle(runner, {
      targetCount: 50,
      onReload: counter => {
        writeHotFileAtomicSync(
          hotRunnerRoot,
          `// source content
${comment_spam}
${Buffer.alloc(counter * 2, " ").toString()}throw new Error(${counter});`,
        );
      },
      verifyLine: (errorLine, nextLine, counter) => {
        if (!nextLine) throw new Error(errorLine);
        const match = nextLine.match(/\s*at.*?:1003:(\d+)$/);
        if (!match) throw new Error("invalid string: " + nextLine);
        const col = match[1];
        expect(Number(col)).toBe(1 + "throw new ".length + counter * 2);
      },
    });
    await runner.exited;
    expect(reloadCounter).toBe(50);
  },
  timeout,
);

it(
  "should not remap against a stale sourcemap after a partial-file reload",
  async () => {
    // Regression: the watcher can deliver a second reload Task between the
    // moment a module's eval rejects and the moment that rejection is
    // printed. The second reload re-transpiles and overwrites
    // source_mappings[path] in place, so the still-unreported error gets
    // remapped against the wrong map and transpiled coordinates leak
    // through — or, since the new pending promise replaces the old one,
    // the error is dropped entirely.
    //
    // To make the window deterministic the hot file truncates itself to a
    // comment-only stub immediately before throwing, guaranteeing a fresh
    // watcher event lands between reject and report.
    const writeFull = (counter: number) =>
      writeHotFileAtomicSync(
        hotRunnerRoot,
        `// source content
${comment_spam}require("fs").writeFileSync(__filename, "// stub ${counter}\\n");
${Buffer.alloc(counter * 2, " ").toString()}throw new Error('${counter}');`,
      );
    writeFull(0);
    await using runner = spawn({
      cmd: [bunExe(), "--smol", "--hot", "run", hotRunnerRoot],
      env: bunEnv,
      cwd,
      stdout: "ignore",
      stderr: "pipe",
      stdin: "ignore",
    });
    const reloadCounter = await driveErrorReloadCycle(runner, {
      targetCount: 20,
      onReload: writeFull,
      verifyLine: (errorLine, nextLine, counter) => {
        if (!nextLine) throw new Error(errorLine);
        const match = nextLine.match(/\s*at.*?:(\d+):(\d+)\)?$/);
        if (!match) throw new Error("no :line:col in: " + JSON.stringify(nextLine));
        if (match[1] !== "1003") throw new Error("expected :1003: but got: " + JSON.stringify(nextLine));
        expect(Number(match[2])).toBe(1 + "throw new ".length + counter * 2);
      },
    });
    await runner.exited;
    expect(reloadCounter).toBe(20);
  },
  longTimeout,
);

it(
  "should work with sourcemap loading",
  async () => {
    let bundleIn = join(cwd, "bundle_in.ts");
    rmSync(hotRunnerRoot);
    writeFileSync(
      bundleIn,
      `// source content
//
//
throw new Error('0');`,
    );
    await using bundler = spawn({
      cmd: [bunExe(), "build", "--watch", bundleIn, "--target=bun", "--sourcemap=inline", "--outfile", hotRunnerRoot],
      env: bunEnv,
      cwd,
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    waitForFileToExist(hotRunnerRoot, 20);
    await using runner = spawn({
      cmd: [bunExe(), "--hot", "run", hotRunnerRoot],
      env: bunEnv,
      cwd,
      stdout: "ignore",
      stderr: "pipe",
      stdin: "ignore",
    });
    let done = false;
    const reloadCounter = await Promise.race([
      driveErrorReloadCycle(runner, {
        targetCount: 50,
        onReload: counter => {
          writeFileSync(
            bundleIn,
            `// source content
// etc etc
// etc etc
${Buffer.alloc(counter * 2, " ").toString()}throw new Error(${counter});`,
          );
        },
        verifyLine: (_errorLine, nextLine, counter) => {
          if (!nextLine) throw new Error(_errorLine);
          // Partial bundle read: --hot picked up the outfile before --watch finished
          // writing the inline sourcemap trailer. Retry the write.
          if (nextLine.includes("hot-runner-root.js")) return "retry";
          expect(nextLine).toInclude("bundle_in.ts");
          const match = nextLine.match(/\s*at.*?:4:(\d+)$/);
          if (!match) throw new Error("invalid stack trace: " + nextLine);
          const col = match[1];
          expect(Number(col)).toBe(1 + "throw ".length + counter * 2);
        },
      }).finally(() => {
        done = true;
      }),
      bundler.exited.then(code => {
        if (!done) throw new Error(`bundler exited early with code ${code}`);
        return -1; // Ignored — race already resolved
      }),
    ]);
    expect(reloadCounter).toBe(50);
    bundler.kill();
  },
  timeout,
);

const long_comment = Buffer.alloc(400000, "BBBB").toString();

it(
  "should work with sourcemap loading with large files",
  async () => {
    let bundleIn = join(cwd, "bundle_in.ts");
    rmSync(hotRunnerRoot);
    writeFileSync(
      bundleIn,
      `// ${long_comment}
//
console.error("RSS: %s", process.memoryUsage.rss());
throw new Error('0');`,
    );
    await using bundler = spawn({
      cmd: [
        //
        bunExe(),
        "build",
        "--watch",
        bundleIn,
        "--target=bun",
        "--sourcemap=inline",
        "--outfile",
        hotRunnerRoot,
      ],
      env: bunEnv,
      cwd,
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    waitForFileToExist(hotRunnerRoot, 20);
    await using runner = spawn({
      cmd: [
        //
        bunExe(),
        "--hot",
        "run",
        hotRunnerRoot,
      ],
      env: bunEnv,
      cwd,
      stdout: "ignore",
      stderr: "pipe",
      stdin: "ignore",
    });
    let done2 = false;
    const reloadCounter = await Promise.race([
      driveErrorReloadCycle(runner, {
        targetCount: 50,
        onReload: counter => {
          writeHotFileAtomicSync(
            bundleIn,
            `// ${long_comment}
console.error("RSS: %s", process.memoryUsage.rss());
//
${Buffer.alloc(counter * 2, " ").toString()}throw new Error(${counter});`,
          );
        },
        verifyLine: (_errorLine, nextLine, counter) => {
          if (!nextLine) throw new Error(_errorLine);
          // Partial bundle read: --hot picked up the outfile before --watch finished
          // writing the inline sourcemap trailer. Retry the write.
          if (nextLine.includes("hot-runner-root.js")) return "retry";
          expect(nextLine).toInclude("bundle_in.ts");
          const match = nextLine.match(/\s*at.*?:4:(\d+)$/);
          if (!match) throw new Error("invalid stack trace: " + nextLine);
          const col = match[1];
          expect(Number(col)).toBe(1 + "throw ".length + counter * 2);
        },
      }).finally(() => {
        done2 = true;
      }),
      bundler.exited.then(code => {
        if (!done2) throw new Error(`bundler exited early with code ${code}`);
        return -1; // Ignored — race already resolved
      }),
    ]);
    expect(reloadCounter).toBe(50);
    bundler.kill();
    await runner.exited;
    // TODO: bun has a memory leak when --hot is used on very large files
  },
  longTimeout,
);

describe("import.meta.hot", () => {
  interface GenerationOptions {
    /** Contents of `entry` for generations 1, 2, ...; by default `files[entry]` is saved again each time. */
    sources?: string[];
    /** Arguments placed before the entry point, e.g. `--preload`. */
    args?: string[];
    /** Runs after a generation printed its line and before the save that starts the next one. */
    afterGeneration?: (line: Record<string, unknown>) => Promise<void>;
  }

  /**
   * Writes `files` into the test cwd, runs `bun --hot` on `entry`, and after
   * every JSON line the fixture prints to stdout saves `entry` to trigger the
   * next reload, until `generations` lines have been collected.
   */
  async function collectGenerations(
    entry: string,
    files: Record<string, string>,
    generations: number,
    { sources, args = [], afterGeneration }: GenerationOptions = {},
  ) {
    const root = join(cwd, entry);
    const sourceFor = (generation: number) =>
      sources ? sources[generation - 1] : `${files[entry]}\n// generation ${generation}\n`;
    for (const [name, contents] of Object.entries(files)) {
      mkdirSync(join(cwd, name, ".."), { recursive: true });
      writeFileSync(join(cwd, name), contents);
    }
    writeFileSync(root, sourceFor(1));
    // A rename, so that the child never reads half of a save. On Windows a save is one write.
    const save = isWindows ? writeFileSync : writeHotFileAtomicSync;

    await using runner = spawn({
      cmd: [bunExe(), "--hot", "--no-clear-screen", ...args, root],
      env: bunEnv,
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });

    let stderr = "";
    const stderrDone = (async () => {
      for await (const chunk of runner.stderr) stderr += new TextDecoder().decode(chunk);
    })().catch(() => {});

    const lines: Record<string, unknown>[] = [];
    let buf = "";
    outer: for await (const chunk of runner.stdout) {
      buf += new TextDecoder().decode(chunk);
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.startsWith("{")) continue;
        const parsed = JSON.parse(line);
        lines.push(parsed);
        await afterGeneration?.(parsed);
        if (lines.length >= generations) break outer;
        save(root, sourceFor(lines.length + 1));
      }
    }

    const finished = lines.length >= generations;
    if (finished) runner.kill();
    await runner.exited;
    await stderrDone;
    if (!finished) {
      throw new Error(
        `bun --hot ended after ${lines.length} of ${generations} generations` +
          ` (exit code ${runner.exitCode}, signal ${runner.signalCode})\n` +
          `stdout lines: ${JSON.stringify(lines)}\nstderr: ${stderr}`,
      );
    }
    return { lines, stderr };
  }

  const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

  it("is undefined and unguarded calls are no-ops without --hot", async () => {
    await using proc = spawn({
      cmd: [
        bunExe(),
        "-e",
        `
          if (import.meta.hot !== undefined) throw new Error("expected undefined, got " + typeof import.meta.hot);
          if (typeof import.meta.hot?.dispose !== "undefined") throw new Error("optional chain");
          // Unguarded calls to the HMR API must not throw at runtime; outside
          // --hot the transpiler folds these away.
          import.meta.hot.dispose(() => { throw new Error("should not run"); });
          import.meta.hot.accept();
          import.meta.hot.on("bun:beforeUpdate", () => {});
          const state = (import.meta.hot.data.state ??= { reloads: 0 });
          console.log(JSON.stringify({ ok: true, reloads: state.reloads }));
        `,
      ],
      env: bunEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect({ stdout, stderr, exitCode }).toEqual({ stdout: '{"ok":true,"reloads":0}\n', stderr: "", exitCode: 0 });
  });

  it(
    "runs dispose callbacks and persists data across reloads",
    async () => {
      const source = `
        const gen = (globalThis.__gen = (globalThis.__gen ?? 0) + 1);
        const listener = () => {};
        process.on("beforeExit", listener);
        const iv = setInterval(() => {}, 1_000_000);

        const hot = import.meta.hot;
        if (typeof hot !== "object" || hot === null) {
          console.log(JSON.stringify({ gen, error: "hot is " + typeof hot }));
          process.exit(1);
        }
        const prevGen = hot.data.prevGen;
        hot.data.prevGen = gen;
        const intervals = globalThis.__intervals ??= new Set();
        intervals.add(iv);
        hot.dispose((data) => {
          clearInterval(iv);
          intervals.delete(iv);
          process.off("beforeExit", listener);
          globalThis.__disposed = { gen, data: { ...data } };
        });

        const noopNames = ["accept", "decline", "on", "off", "prune", "invalidate", "send"];
        console.log(JSON.stringify({
          gen,
          tag: Object.prototype.toString.call(hot),
          sameObject: hot === import.meta.hot,
          keys: Object.keys(hot),
          protoKeys: Object.getOwnPropertyNames(Object.getPrototypeOf(hot)).sort(),
          prevGen: prevGen ?? null,
          listenerCount: process.listenerCount("beforeExit"),
          liveIntervals: intervals.size,
          disposed: globalThis.__disposed ?? null,
          noops: noopNames.filter(n => typeof hot[n] === "function" && hot[n]() === undefined),
        }));
      `;
      const { lines } = await collectGenerations("import-meta-hot-app.ts", { "import-meta-hot-app.ts": source }, 3);

      const shape = {
        tag: "[object ImportMetaHot]",
        sameObject: true,
        keys: [],
        protoKeys: ["accept", "data", "decline", "dispose", "invalidate", "off", "on", "prune", "send"],
        listenerCount: 1,
        liveIntervals: 1,
        noops: ["accept", "decline", "on", "off", "prune", "invalidate", "send"],
      };
      expect(lines).toEqual([
        { ...shape, gen: 1, prevGen: null, disposed: null },
        { ...shape, gen: 2, prevGen: 1, disposed: { gen: 1, data: { prevGen: 1 } } },
        { ...shape, gen: 3, prevGen: 2, disposed: { gen: 2, data: { prevGen: 2 } } },
      ]);
    },
    timeout,
  );

  it(
    "data can be reassigned and dispose receives the module's current data",
    async () => {
      const source = `
        const gen = (globalThis.__gen = (globalThis.__gen ?? 0) + 1);
        const hot = import.meta.hot;
        const before = { ...hot.data };
        // Registered before the reassignment below: dispose must still be
        // handed whatever data is current when the reload happens.
        hot.dispose((data) => {
          globalThis.__disposeGot = { ...data };
        });
        if (gen === 1) {
          hot.data = { created: 1 };
        } else {
          hot.data.mutatedBy = gen;
        }
        console.log(JSON.stringify({
          gen,
          before,
          after: { ...hot.data },
          disposeGot: globalThis.__disposeGot ?? null,
        }));
      `;
      const { lines } = await collectGenerations("import-meta-hot-data.ts", { "import-meta-hot-data.ts": source }, 3);
      expect(lines).toEqual([
        { gen: 1, before: {}, after: { created: 1 }, disposeGot: null },
        { gen: 2, before: { created: 1 }, after: { created: 1, mutatedBy: 2 }, disposeGot: { created: 1 } },
        {
          gen: 3,
          before: { created: 1, mutatedBy: 2 },
          after: { created: 1, mutatedBy: 3 },
          disposeGot: { created: 1, mutatedBy: 2 },
        },
      ]);
    },
    timeout,
  );

  it(
    "keeps data and dispose per module and runs dispose in registration order",
    async () => {
      // Each module stamps its own data and records which data its dispose
      // callback was handed. The dependency is never edited; it is
      // re-evaluated because the entry changed (via the async transpiler path).
      const entry = `
        import { depData, depSeen } from "./import-meta-hot-dep.ts";
        const gen = (globalThis.__gen = (globalThis.__gen ?? 0) + 1);
        const data = import.meta.hot.data;
        const entrySeen = { who: data.who ?? null, gen: data.gen ?? null };
        data.who = "entry";
        data.gen = gen;
        import.meta.hot.dispose(handed => globalThis.__disposed.push(["entry", handed.who, handed === data]));
        console.log(JSON.stringify({
          gen,
          entrySeen,
          depSeen,
          separateData: depData !== data,
          disposedSinceLastGeneration: globalThis.__disposed ?? [],
        }));
        globalThis.__disposed = [];
      `;
      const dep = `
        export const depData = import.meta.hot.data;
        export const depSeen = { who: depData.who ?? null, gen: depData.gen ?? null };
        depData.who = "dep";
        depData.gen = (depData.gen ?? 0) + 1;
        import.meta.hot.dispose(handed => globalThis.__disposed.push(["dep", handed.who, handed === depData]));
      `;
      const { lines } = await collectGenerations(
        "import-meta-hot-entry.ts",
        { "import-meta-hot-entry.ts": entry, "import-meta-hot-dep.ts": dep },
        3,
      );
      const nothing = { who: null, gen: null };
      // The dependency evaluates (and so registers) before the entry does.
      const bothDisposed = [
        ["dep", "dep", true],
        ["entry", "entry", true],
      ];
      expect(lines).toEqual([
        { gen: 1, entrySeen: nothing, depSeen: nothing, separateData: true, disposedSinceLastGeneration: [] },
        {
          gen: 2,
          entrySeen: { who: "entry", gen: 1 },
          depSeen: { who: "dep", gen: 1 },
          separateData: true,
          disposedSinceLastGeneration: bothDisposed,
        },
        {
          gen: 3,
          entrySeen: { who: "entry", gen: 2 },
          depSeen: { who: "dep", gen: 2 },
          separateData: true,
          disposedSinceLastGeneration: bothDisposed,
        },
      ]);
    },
    timeout,
  );

  it(
    "runs the dispose callbacks of a module the next generation no longer loads",
    async () => {
      const entry = `
        const gen = (globalThis.__gen = (globalThis.__gen ?? 0) + 1);
        if (gen === 1) await import("./import-meta-hot-dropped.ts");
        console.log(JSON.stringify({ gen, droppedDisposeRuns: globalThis.__droppedDisposeRuns ?? 0 }));
      `;
      const dropped = `
        import.meta.hot.dispose(() => {
          globalThis.__droppedDisposeRuns = (globalThis.__droppedDisposeRuns ?? 0) + 1;
        });
      `;
      const { lines } = await collectGenerations(
        "import-meta-hot-dropping-entry.ts",
        { "import-meta-hot-dropping-entry.ts": entry, "import-meta-hot-dropped.ts": dropped },
        3,
      );
      expect(lines).toEqual([
        { gen: 1, droppedDisposeRuns: 0 },
        { gen: 2, droppedDisposeRuns: 1 },
        { gen: 3, droppedDisposeRuns: 1 },
      ]);
    },
    timeout,
  );

  it(
    "waits for every promise returned from dispose, including ones that reject, before re-evaluating",
    async () => {
      const source = `
        const gen = (globalThis.__gen = (globalThis.__gen ?? 0) + 1);
        const order = (globalThis.__order ??= []);
        order.push("evaluate " + gen);
        const macrotask = () => new Promise(resolve => setImmediate(resolve));
        // A is registered first but settles last, by rejecting; B resolves
        // first. The reload must wait for both.
        import.meta.hot.dispose(async () => {
          order.push("dispose A " + gen);
          await macrotask();
          await macrotask();
          order.push("reject A " + gen);
          throw new Error("dispose-a-rejected-" + gen);
        });
        import.meta.hot.dispose(async data => {
          order.push("dispose B " + gen);
          await macrotask();
          order.push("resolve B " + gen);
          data.lastDisposed = gen;
        });
        console.log(JSON.stringify({ gen, order: order.splice(0), lastDisposed: import.meta.hot.data.lastDisposed ?? null }));
      `;
      const { lines, stderr } = await collectGenerations(
        "import-meta-hot-async.ts",
        { "import-meta-hot-async.ts": source },
        3,
      );
      expect(lines).toEqual([
        { gen: 1, order: ["evaluate 1"], lastDisposed: null },
        { gen: 2, order: ["dispose A 1", "dispose B 1", "resolve B 1", "reject A 1", "evaluate 2"], lastDisposed: 1 },
        { gen: 3, order: ["dispose A 2", "dispose B 2", "resolve B 2", "reject A 2", "evaluate 3"], lastDisposed: 2 },
      ]);
      expect([count(stderr, "dispose-a-rejected-1"), count(stderr, "dispose-a-rejected-2")]).toEqual([1, 1]);
    },
    timeout,
  );

  it(
    "resumes a reload parked on dispose after a generation that failed to evaluate",
    async () => {
      const print = (gen: number) => `
        console.log(JSON.stringify({
          gen: ${gen},
          x: import.meta.hot.data.x ?? null,
          disposedGenerations: globalThis.__disposedGenerations ?? [],
        }));
      `;
      const sources = [
        `
          import.meta.hot.data.x = "set by generation 1";
          import.meta.hot.dispose(() => { (globalThis.__disposedGenerations ??= []).push(1); });
          ${print(1)}
        `,
        // Prints, registers an async dispose, then fails to evaluate: the
        // reload that follows has to get past the reported rejection of this
        // generation's entry promise both before and after parking on dispose.
        `
          import.meta.hot.dispose(async () => {
            await new Promise(resolve => setImmediate(resolve));
            (globalThis.__disposedGenerations ??= []).push(2);
          });
          ${print(2)}
          const failing = 2;
          throw new Error("generation-" + failing + "-failed");
        `,
        print(3),
      ];
      const { lines, stderr } = await collectGenerations("import-meta-hot-broken.ts", {}, 3, { sources });
      expect(lines).toEqual([
        { gen: 1, x: "set by generation 1", disposedGenerations: [] },
        { gen: 2, x: "set by generation 1", disposedGenerations: [1] },
        { gen: 3, x: "set by generation 1", disposedGenerations: [1, 2] },
      ]);
      expect(count(stderr, "generation-2-failed")).toBe(1);
    },
    timeout,
  );

  it(
    "a server stopped from dispose is replaced by the next generation's Bun.serve on the same port",
    async () => {
      // The recipe from docs/runtime/watch-mode.mdx: without the dispose
      // callback the reload hands the new fetch handler to the existing server.
      const source = `
        const gen = (globalThis.__gen = (globalThis.__gen ?? 0) + 1);
        const server = Bun.serve({
          hostname: "127.0.0.1",
          port: import.meta.hot.data.port ?? 0,
          fetch: () => new Response("generation " + gen),
        });
        import.meta.hot.data.port = server.port;
        import.meta.hot.dispose(() => {
          server.stop();
        });
        console.log(JSON.stringify({ gen, port: server.port, newServer: server !== globalThis.__server }));
        globalThis.__server = server;
      `;
      const responses: string[] = [];
      const { lines } = await collectGenerations(
        "import-meta-hot-serve.ts",
        { "import-meta-hot-serve.ts": source },
        3,
        {
          async afterGeneration(line) {
            const response = await fetch(`http://127.0.0.1:${line.port}/`, { headers: { connection: "close" } });
            responses.push(await response.text());
          },
        },
      );
      const port = lines[0].port as number;
      expect(port).toBeGreaterThan(0);
      expect({ lines, responses }).toEqual({
        lines: [
          { gen: 1, port, newServer: true },
          { gen: 2, port, newServer: true },
          { gen: 3, port, newServer: true },
        ],
        responses: ["generation 1", "generation 2", "generation 3"],
      });
    },
    timeout,
  );

  const preload = `
    globalThis.__preloadEvaluations = (globalThis.__preloadEvaluations ?? 0) + 1;
    import.meta.hot.dispose(() => {
      globalThis.__preloadDisposeRuns = (globalThis.__preloadDisposeRuns ?? 0) + 1;
    });
  `;
  const reportPreload = `
    const gen = (globalThis.__gen = (globalThis.__gen ?? 0) + 1);
    console.log(JSON.stringify({
      gen,
      preloadEvaluations: globalThis.__preloadEvaluations,
      preloadDisposeRuns: globalThis.__preloadDisposeRuns ?? 0,
    }));
  `;

  it(
    "a --preload script is evaluated once, so a dispose registered there runs once",
    async () => {
      const { lines } = await collectGenerations(
        "import-meta-hot-preload-entry.ts",
        { "import-meta-hot-preload-entry.ts": reportPreload, "import-meta-hot-preload.ts": preload },
        3,
        { args: ["--preload", "./import-meta-hot-preload.ts"] },
      );
      expect(lines).toEqual([
        { gen: 1, preloadEvaluations: 1, preloadDisposeRuns: 0 },
        { gen: 2, preloadEvaluations: 1, preloadDisposeRuns: 1 },
        { gen: 3, preloadEvaluations: 1, preloadDisposeRuns: 1 },
      ]);
    },
    timeout,
  );

  it(
    "a --preload script the entry point imports is reloaded like any other module",
    async () => {
      const { lines } = await collectGenerations(
        "import-meta-hot-preload-importing-entry.ts",
        {
          "import-meta-hot-preload-importing-entry.ts": `import "./import-meta-hot-preload.ts";\n${reportPreload}`,
          "import-meta-hot-preload.ts": preload,
        },
        3,
        { args: ["--preload", "./import-meta-hot-preload.ts"] },
      );
      expect(lines).toEqual([
        { gen: 1, preloadEvaluations: 1, preloadDisposeRuns: 0 },
        { gen: 2, preloadEvaluations: 2, preloadDisposeRuns: 1 },
        { gen: 3, preloadEvaluations: 3, preloadDisposeRuns: 2 },
      ]);
    },
    timeout,
  );

  it(
    "reports throwing and rejecting dispose callbacks and still reloads",
    async () => {
      const source = `
        const gen = (globalThis.__gen = (globalThis.__gen ?? 0) + 1);
        // Touching \`process\` and then going idle is what makes a later
        // uncaught exception fatal; dispose errors must not take that path.
        process.on("exit", () => {});
        import.meta.hot.dispose(() => { throw new Error("sync-throw-" + gen); });
        // Already rejected by the time it is returned; a rejection that
        // happens later is covered by the ordering test above.
        import.meta.hot.dispose(async () => { throw new Error("async-reject-" + gen); });
        import.meta.hot.dispose(() => { globalThis.__last = gen; });
        console.log(JSON.stringify({ gen, lastRan: globalThis.__last ?? null }));
      `;
      const { lines, stderr } = await collectGenerations(
        "import-meta-hot-throws.ts",
        { "import-meta-hot-throws.ts": source },
        3,
      );
      expect(lines).toEqual([
        { gen: 1, lastRan: null },
        { gen: 2, lastRan: 1 },
        { gen: 3, lastRan: 2 },
      ]);
      expect(
        ["sync-throw-1", "async-reject-1", "sync-throw-2", "async-reject-2"].map(message => count(stderr, message)),
      ).toEqual([1, 1, 1, 1]);
    },
    timeout,
  );

  it(
    "exists in CommonJS modules, once per query string, and however the property is read",
    async () => {
      const entry = `
        const gen = (globalThis.__gen = (globalThis.__gen ?? 0) + 1);
        const cjs = require("./import-meta-hot-commonjs.cjs");
        const a = await import("./import-meta-hot-query.ts?a");
        const b = await import("./import-meta-hot-query.ts?b");
        const meta = import.meta;
        const { hot } = import.meta;
        console.log(JSON.stringify({
          gen,
          cjs,
          queries: [a.count, b.count],
          separateData: a.data !== b.data,
          sameObject: [meta.hot === import.meta.hot, hot === meta.hot, import.meta["hot"] === hot],
          inOperator: "hot" in import.meta,
          optionalChain: typeof import.meta?.hot?.dispose,
        }));
      `;
      const commonjs = `
        const data = import.meta.hot.data;
        data.count = (data.count ?? 0) + 1;
        import.meta.hot.dispose(() => {
          globalThis.__commonjsDisposed = (globalThis.__commonjsDisposed ?? 0) + 1;
        });
        module.exports = {
          isCommonJS: typeof module === "object" && module.exports === exports,
          count: data.count,
          disposed: globalThis.__commonjsDisposed ?? 0,
        };
      `;
      const query = `
        export const data = import.meta.hot.data;
        data.count = (data.count ?? 0) + (import.meta.url.endsWith("?a") ? 1 : 10);
        export const count = data.count;
      `;
      const { lines } = await collectGenerations(
        "import-meta-hot-kinds.ts",
        {
          "import-meta-hot-kinds.ts": entry,
          "import-meta-hot-commonjs.cjs": commonjs,
          "import-meta-hot-query.ts": query,
        },
        3,
      );
      const shape = {
        separateData: true,
        sameObject: [true, true, true],
        inOperator: true,
        optionalChain: "function",
      };
      expect(lines).toEqual([
        { ...shape, gen: 1, cjs: { isCommonJS: true, count: 1, disposed: 0 }, queries: [1, 10] },
        { ...shape, gen: 2, cjs: { isCommonJS: true, count: 2, disposed: 1 }, queries: [2, 20] },
        { ...shape, gen: 3, cjs: { isCommonJS: true, count: 3, disposed: 2 }, queries: [3, 30] },
      ]);
    },
    timeout,
  );

  it(
    "waits for a dispose callback that waits for a loop of its run, also after a run that failed",
    async () => {
      // An uncaught error stops the timers of its run. They run again while a reload waits for the
      // dispose callbacks: a callback can wait for a timer, or for a loop of the run that one wakes.
      const source = (gen: number, tail: string) => `
        const order = (globalThis.__order ??= []);
        let stopped = false;
        const loop = (async () => {
          while (!stopped) await new Promise(resolve => setTimeout(resolve, 1));
        })();
        import.meta.hot.dispose(async () => {
          order.push("dispose ${gen} starts");
          stopped = true;
          await loop;
          await new Promise(resolve => setTimeout(resolve, 1));
          order.push("dispose ${gen} ends");
        });
        console.log(JSON.stringify({ gen: ${gen}, order: order.splice(0) }));
        ${tail}
      `;
      const sources = [
        source(1, `const failing = 1;\nthrow new Error("generation-" + failing + "-failed");`),
        source(2, ""),
        source(3, ""),
      ];
      const { lines, stderr } = await collectGenerations("import-meta-hot-timer.ts", {}, 3, { sources });
      expect(lines).toEqual([
        { gen: 1, order: [] },
        { gen: 2, order: ["dispose 1 starts", "dispose 1 ends"] },
        { gen: 3, order: ["dispose 2 starts", "dispose 2 ends"] },
      ]);
      expect(count(stderr, "generation-1-failed")).toBe(1);
    },
    timeout,
  );

  it(
    "an uncaught error during the wait for dispose does not end the wait",
    async () => {
      // The callback waits for a timer that is due after the error. Each generation prints from a
      // timer: the timers of the run after that reload work.
      const source = `
        const gen = (globalThis.__gen = (globalThis.__gen ?? 0) + 1);
        const order = (globalThis.__order ??= []);
        order.push("load " + gen);
        import.meta.hot.dispose(async () => {
          order.push("dispose " + gen + " starts");
          await new Promise(resolve =>
            setTimeout(() => {
              setTimeout(resolve, 1);
              throw new Error("thrown-in-the-wait-of-" + gen);
            }, 1),
          );
          order.push("dispose " + gen + " ends");
        });
        setTimeout(() => console.log(JSON.stringify({ gen, order: order.splice(0) })), 1);
      `;
      const { lines, stderr } = await collectGenerations(
        "import-meta-hot-error-in-wait.ts",
        { "import-meta-hot-error-in-wait.ts": source },
        3,
      );
      expect(lines).toEqual([
        { gen: 1, order: ["load 1"] },
        { gen: 2, order: ["dispose 1 starts", "dispose 1 ends", "load 2"] },
        { gen: 3, order: ["dispose 2 starts", "dispose 2 ends", "load 3"] },
      ]);
      expect(count(stderr, "thrown-in-the-wait-of-1")).toBe(1);
    },
    timeout,
  );

  it(
    "a dispose promise can settle while a later callback runs",
    async () => {
      // The second callback drains the microtasks, as `server.stop(true)` does when it closes a
      // connection: the promise of the first settles inside the call. Generation 2 has no third.
      const source = `
        const gen = (globalThis.__gen = (globalThis.__gen ?? 0) + 1);
        const order = (globalThis.__order ??= []);
        if (gen === 1) process.on("unhandledRejection", error => order.push("unhandledRejection: " + error));
        import.meta.hot.dispose(async () => {
          order.push("first " + gen);
        });
        import.meta.hot.dispose(() => {
          require("bun:jsc").drainMicrotasks();
          order.push("second " + gen);
        });
        if (gen !== 2) {
          import.meta.hot.dispose(async () => {
            await new Promise(resolve => setTimeout(resolve, 1));
            order.push("third " + gen);
          });
        }
        setTimeout(() => console.log(JSON.stringify({ gen, order: order.splice(0) })), 1);
      `;
      const { lines } = await collectGenerations("import-meta-hot-drain.ts", { "import-meta-hot-drain.ts": source }, 4);
      expect(lines).toEqual([
        { gen: 1, order: [] },
        { gen: 2, order: ["first 1", "second 1", "third 1"] },
        { gen: 3, order: ["first 2", "second 2"] },
        { gen: 4, order: ["first 3", "second 3", "third 3"] },
      ]);
    },
    timeout,
  );

  it(
    "a save during the wait for dispose is part of the reload that waits",
    async () => {
      const root = join(cwd, "import-meta-hot-save-during-wait.ts");
      const released = join(cwd, "import-meta-hot-released");
      const source = (version: string) => `
        const gen = (globalThis.__gen = (globalThis.__gen ?? 0) + 1);
        import.meta.hot.dispose(async () => {
          console.log("disposing");
          const { existsSync } = require("node:fs");
          while (!existsSync(${JSON.stringify(released)})) await new Promise(resolve => setTimeout(resolve, 1));
        });
        console.log(JSON.stringify({ gen, version: ${JSON.stringify(version)} }));
      `;
      writeFileSync(root, source("first"));
      await using runner = spawn({
        cmd: [bunExe(), "--hot", "--no-clear-screen", root],
        env: bunEnv,
        cwd,
        stdout: "pipe",
        stderr: "inherit",
        stdin: "ignore",
      });
      const stdout = follow(runner.stdout);
      expect(await stdout(JSON.stringify({ gen: 1, version: "first" }))).toBe(true);

      writeFileSync(root, source("never evaluated"));
      expect(await stdout("disposing")).toBe(true);
      // The reload is waiting. What it evaluates is the file as it is once the wait is over.
      writeFileSync(root, source("saved during the wait"));
      writeFileSync(released, "");
      expect(await stdout(JSON.stringify({ gen: 2, version: "saved during the wait" }))).toBe(true);
    },
    timeout,
  );

  it(
    "reloads without a dispose promise that nothing is left to settle",
    async () => {
      // Each generation prints from beforeExit, so the save that follows finds an idle process.
      const source = `
        const gen = (globalThis.__gen = (globalThis.__gen ?? 0) + 1);
        import.meta.hot.dispose(() => new Promise(() => {}));
        process.once("beforeExit", () => console.log(JSON.stringify({ gen })));
      `;
      const { lines } = await collectGenerations("import-meta-hot-never.ts", { "import-meta-hot-never.ts": source }, 3);
      expect(lines).toEqual([{ gen: 1 }, { gen: 2 }, { gen: 3 }]);
    },
    timeout,
  );

  it(
    "a dispose promise that settles after its reload went on does not end the wait of a later reload",
    async () => {
      // Nothing is left to settle the promise of generation 1, so its reload goes on without it.
      // Generation 2 settles it while the next reload waits for generation 2's own promise.
      const source = `
        const gen = (globalThis.__gen = (globalThis.__gen ?? 0) + 1);
        const order = (globalThis.__order ??= []);
        order.push("load " + gen);
        if (gen === 1) {
          import.meta.hot.dispose(() => new Promise(resolve => (globalThis.__late = resolve)));
        } else {
          import.meta.hot.dispose(async () => {
            order.push("dispose " + gen + " starts");
            globalThis.__late();
            for (let turn = 0; turn < 5; turn++) await new Promise(resolve => setTimeout(resolve, 1));
            order.push("dispose " + gen + " ends");
          });
        }
        process.once("beforeExit", () => console.log(JSON.stringify({ gen, order: order.splice(0) })));
      `;
      const { lines } = await collectGenerations("import-meta-hot-late.ts", { "import-meta-hot-late.ts": source }, 3);
      expect(lines).toEqual([
        { gen: 1, order: ["load 1"] },
        { gen: 2, order: ["load 2"] },
        { gen: 3, order: ["dispose 2 starts", "dispose 2 ends", "load 3"] },
      ]);
    },
    timeout,
  );

  it(
    "reloads while a beforeExit listener keeps the event loop alive",
    async () => {
      const source = `
        const gen = (globalThis.__gen = (globalThis.__gen ?? 0) + 1);
        import.meta.hot.dispose(() => {});
        if (gen === 1) process.on("beforeExit", () => setTimeout(() => {}, 20));
        console.log(JSON.stringify({ gen }));
      `;
      const { lines } = await collectGenerations(
        "import-meta-hot-before-exit.ts",
        { "import-meta-hot-before-exit.ts": source },
        3,
      );
      expect(lines).toEqual([{ gen: 1 }, { gen: 2 }, { gen: 3 }]);
    },
    timeout,
  );

  it(
    "a package in node_modules keeps the fold",
    async () => {
      // Its `if (import.meta.hot)` has meant "a dev server is driving me" so far.
      const entry = `
        import { seen } from "hot-dependency";
        const gen = (globalThis.__gen = (globalThis.__gen ?? 0) + 1);
        console.log(JSON.stringify({ gen, own: typeof import.meta.hot, seen, disposed: globalThis.__packageDisposed ?? 0 }));
      `;
      const dependency = `
        const meta = import.meta;
        import.meta.hot.dispose(() => {
          globalThis.__packageDisposed = (globalThis.__packageDisposed ?? 0) + 1;
        });
        export const seen = {
          guard: import.meta.hot ? "hot" : "cold",
          dot: typeof import.meta.hot,
          alias: typeof meta.hot,
          inOperator: "hot" in meta,
        };
      `;
      const { lines } = await collectGenerations(
        "import-meta-hot-with-package.ts",
        {
          "import-meta-hot-with-package.ts": entry,
          "node_modules/hot-dependency/package.json": JSON.stringify({ name: "hot-dependency", module: "index.js" }),
          "node_modules/hot-dependency/index.js": dependency,
        },
        2,
      );
      // The property is on the prototype that every import.meta of the program has, with no value here.
      const seen = { guard: "cold", dot: "undefined", alias: "undefined", inOperator: true };
      expect(lines).toEqual([
        { gen: 1, own: "object", seen, disposed: 0 },
        { gen: 2, own: "object", seen, disposed: 0 },
      ]);
    },
    timeout,
  );

  // What the parser makes of the expression and what the property answers are one decision, so
  // every way to read it agrees. The call without a guard tells a folded expression, whose call
  // the transpiler removes, from one that is kept and reads `undefined`.
  const readings = `{
    dot: typeof import.meta.hot,
    index: typeof import.meta["hot"],
    alias: typeof ((meta) => meta.hot)(import.meta),
    inOperator: "hot" in import.meta,
    optionalCall: typeof import.meta?.hot?.dispose,
    unguardedCall: (() => { try { import.meta.hot.dispose(() => {}); return "returns"; } catch { return "throws"; } })(),
  }`;
  const everyReading = (hot: boolean, inOperator = hot, unguardedCall = "returns") => ({
    dot: hot ? "object" : "undefined",
    index: hot ? "object" : "undefined",
    alias: hot ? "object" : "undefined",
    inOperator,
    optionalCall: hot ? "function" : "undefined",
    unguardedCall,
  });

  it(
    "is undefined by every way to read it wherever a reload evaluates nothing again",
    async () => {
      const print = `console.log(JSON.stringify(${readings})); process.exit(0);`;
      const files: Record<string, string> = {
        "import-meta-hot-readings.ts": print,
        "import-meta-hot-readings.test.ts": `require("bun:test").test("readings", () => { ${print} });`,
        "import-meta-hot-readings-worker.ts": `self.postMessage(${readings});`,
        "import-meta-hot-readings-worker-main.ts": `
          const worker = new Worker(new URL("./import-meta-hot-readings-worker.ts", import.meta.url).href);
          worker.onmessage = event => { console.log(JSON.stringify(event.data)); process.exit(0); };
        `,
        "import-meta-hot-readings-macro.ts": `export function readings() { return ${readings}; }`,
        "import-meta-hot-readings-macro-main.ts": `
          import { readings } from "./import-meta-hot-readings-macro.ts" with { type: "macro" };
          console.log(JSON.stringify(readings())); process.exit(0);
        `,
        "import-meta-hot-readings-realm.ts": `export const readings = JSON.stringify(${readings});`,
        "import-meta-hot-readings-realm-main.ts": `
          console.log(await new ShadowRealm().importValue("./import-meta-hot-readings-realm.ts", "readings"));
          process.exit(0);
        `,
        "node_modules/hot-readings/bin.js": print,
      };
      for (const [name, contents] of Object.entries(files)) {
        mkdirSync(join(cwd, name, ".."), { recursive: true });
        writeFileSync(join(cwd, name), contents);
      }
      // `onPrototype`: the module shares the ImportMeta prototype of the modules that do have the
      // object, so `in` finds the property, with no value.
      // `keepsTheCall`: the parse of a realm's module is the parse of the program's modules, and
      // the realm has no property.
      type Context = { args: string[]; stdin?: string; onPrototype?: true; keepsTheCall?: true };
      const contexts: Record<string, Context> = {
        "without --hot": { args: ["import-meta-hot-readings.ts"] },
        "--watch": { args: ["--watch", "--no-clear-screen", "import-meta-hot-readings.ts"] },
        "--hot -e": { args: ["--hot", "--no-clear-screen", "-e", print], onPrototype: true },
        "--hot, from standard input": { args: ["--hot", "--no-clear-screen", "-"], stdin: print, onPrototype: true },
        "bun test --hot": { args: ["test", "--hot", "./import-meta-hot-readings.test.ts"] },
        "a Worker": { args: ["--hot", "--no-clear-screen", "import-meta-hot-readings-worker-main.ts"] },
        "a macro": {
          args: ["--hot", "--no-clear-screen", "import-meta-hot-readings-macro-main.ts"],
          onPrototype: true,
        },
        "a ShadowRealm": {
          args: ["--hot", "--no-clear-screen", "import-meta-hot-readings-realm-main.ts"],
          keepsTheCall: true,
        },
        "an entry point in node_modules": {
          args: ["--hot", "--no-clear-screen", "node_modules/hot-readings/bin.js"],
          onPrototype: true,
        },
      };
      const results = await Promise.all(
        Object.entries(contexts).map(async ([context, { args, stdin }]) => {
          await using proc = spawn({
            cmd: [bunExe(), ...args],
            env: bunEnv,
            cwd,
            stdout: "pipe",
            stderr: "pipe",
            stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
          });
          const [stdout, stderr] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
          const line = stdout.split("\n").find(line => line.startsWith("{"));
          return [context, line === undefined ? { stdout, stderr } : JSON.parse(line)];
        }),
      );
      expect(Object.fromEntries(results)).toEqual(
        Object.fromEntries(
          Object.entries(contexts).map(([context, { onPrototype, keepsTheCall }]) => [
            context,
            everyReading(false, onPrototype === true, keepsTheCall ? "throws" : "returns"),
          ]),
        ),
      );
    },
    timeout,
  );

  it(
    "is an object by every way to read it in the module that used a macro and a ShadowRealm",
    async () => {
      // The modules of the entry point are not changed by what else the process loads.
      const source = `
        import { readings } from "./import-meta-hot-readings-macro.ts" with { type: "macro" };
        const gen = (globalThis.__gen = (globalThis.__gen ?? 0) + 1);
        readings();
        await new ShadowRealm().importValue("./import-meta-hot-readings-realm.ts", "readings");
        console.log(JSON.stringify({ gen, readings: ${readings} }));
      `;
      const { lines } = await collectGenerations(
        "import-meta-hot-readings-entry.ts",
        {
          "import-meta-hot-readings-entry.ts": source,
          "import-meta-hot-readings-macro.ts": `export function readings() { return ${readings}; }`,
          "import-meta-hot-readings-realm.ts": `export const readings = JSON.stringify(${readings});`,
        },
        2,
      );
      expect(lines).toEqual([
        { gen: 1, readings: everyReading(true) },
        { gen: 2, readings: everyReading(true) },
      ]);
    },
    timeout,
  );

  it.skipIf(isDebug || isASAN)("is undefined in a compiled executable that runs with --hot", async () => {
    // Its modules were transpiled when it was built.
    const root = join(cwd, "import-meta-hot-compiled.ts");
    const executable = join(cwd, isWindows ? "import-meta-hot-compiled.exe" : "import-meta-hot-compiled");
    writeFileSync(root, `console.log(JSON.stringify(${readings})); process.exit(0);`);
    await using build = spawn({
      cmd: [bunExe(), "build", "--compile", root, "--outfile", executable],
      env: bunEnv,
      cwd,
      stdout: "ignore",
      stderr: "pipe",
    });
    expect({ stderr: await build.stderr.text(), exitCode: await build.exited }).toMatchObject({ exitCode: 0 });
    await using proc = spawn({
      cmd: [executable],
      env: { ...bunEnv, BUN_OPTIONS: "--hot" },
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect({ stdout: stdout.trim(), stderr, exitCode }).toEqual({
      stdout: JSON.stringify(everyReading(false)),
      stderr: "",
      exitCode: 0,
    });
  });

  it(
    "clears the terminal before the dispose callbacks run, so what they print stays on it",
    async () => {
      const root = join(cwd, "import-meta-hot-clear-screen.ts");
      const source = `
        const gen = (globalThis.__gen = (globalThis.__gen ?? 0) + 1);
        import.meta.hot.dispose(() => console.log("disposed " + gen));
        console.log("loaded " + gen);
      `;
      writeFileSync(root, source);
      const env: typeof bunEnv = { ...bunEnv, FORCE_COLOR: "1" };
      delete env.NO_COLOR;
      // stderr is piped, not inherited: the clear sequence would otherwise wipe the terminal that runs the tests.
      await using runner = spawn({
        cmd: [bunExe(), "--hot", root],
        env,
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      });
      const stderr = runner.stderr.text();
      const stdout = follow(runner.stdout);
      expect(await stdout("loaded 1\n")).toBe(true);
      (isWindows ? writeFileSync : writeHotFileAtomicSync)(root, `${source}\n// saved\n`);
      expect(await stdout("loaded 2\n")).toBe(true);
      runner.kill();
      await stderr;

      const clearScreen = "\x1b[2J\x1b[3J\x1b[H";
      const text = (await stdout("\0")) as string;
      expect(text.slice(0, text.indexOf("loaded 2\n"))).toBe(`loaded 1\n${clearScreen}disposed 1\n`);
    },
    timeout,
  );

  it("dispose() validates its argument", async () => {
    const root = join(cwd, "import-meta-hot-invalid.ts");
    writeFileSync(
      root,
      `
        const results = [];
        try {
          import.meta.hot.dispose(123);
          results.push("no-throw");
        } catch (e) {
          results.push(e?.code ?? e?.name);
        }
        // The methods read the module they belong to from \`this\`.
        try {
          import.meta.hot.dispose.call({}, () => {});
          results.push("no-throw");
        } catch (e) {
          results.push(e?.code ?? e?.name);
        }
        console.log(JSON.stringify(results));
        process.exit(0);
      `,
    );
    await using proc = spawn({
      cmd: [bunExe(), "--hot", "--no-clear-screen", root],
      env: bunEnv,
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect({ stdout: stdout.trim(), stderr, exitCode }).toEqual({
      stdout: JSON.stringify(["ERR_INVALID_ARG_TYPE", "ERR_INVALID_THIS"]),
      stderr: "",
      exitCode: 0,
    });
  });

  it("is undefined inside workers even under --hot", async () => {
    const workerPath = join(cwd, "import-meta-hot-worker.ts");
    const mainPath = join(cwd, "import-meta-hot-worker-main.ts");
    writeFileSync(
      workerPath,
      `
        // Workers are not reloaded under --hot, so import.meta.hot is undefined
        // and unguarded calls fold away at transpile time.
        import.meta.hot.dispose(() => { throw new Error("should not run"); });
        self.postMessage({ hot: typeof import.meta.hot });
      `,
    );
    writeFileSync(
      mainPath,
      `
        const w = new Worker(${JSON.stringify(workerPath)});
        w.onmessage = (e) => {
          console.log(JSON.stringify({ main: typeof import.meta.hot, worker: e.data.hot }));
          w.terminate();
          process.exit(0);
        };
        w.onerror = (e) => {
          console.error(String(e?.message ?? e));
          process.exit(1);
        };
      `,
    );
    await using proc = spawn({
      cmd: [bunExe(), "--hot", "--no-clear-screen", mainPath],
      env: bunEnv,
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect({ stdout: stdout.trim(), stderr, exitCode }).toEqual({
      stdout: JSON.stringify({ main: "object", worker: "undefined" }),
      stderr: "",
      exitCode: 0,
    });
  });
});

it(
  "should import a module again after a hot reload while its import() was still loading its dependencies",
  async () => {
    using dir = tempDir("hot-reload-import-in-flight", {
      "a.mjs": `import "./dependency.mjs"; export const evaluation = (globalThis.evaluations = (globalThis.evaluations ?? 0) + 1);`,
      "dependency.mjs": `export {};`,
      "entry.mjs": `
        import { readFileSync, writeFileSync } from "node:fs";
        globalThis.runs = (globalThis.runs ?? 0) + 1;
        if (globalThis.runs === 1) {
          Bun.plugin({
            name: "hold the dependency's load open until the reload",
            setup(build) {
              build.onLoad({ filter: /dependency\\.mjs$/ }, () => {
                const loaded = { contents: "export {}", loader: "js" };
                if (globalThis.dependencyMayLoad) return loaded;
                const { promise, resolve } = Promise.withResolvers();
                globalThis.dependencyMayLoad = () => resolve(loaded);
                writeFileSync(import.meta.path, readFileSync(import.meta.path));
                return promise;
              });
            },
          });
          globalThis.inFlight = import("./a.mjs");
        } else {
          globalThis.dependencyMayLoad();
          try {
            console.log("in flight: evaluation", (await globalThis.inFlight).evaluation);
            console.log("next: evaluation", (await import("./a.mjs")).evaluation);
            process.exit(0);
          } catch (error) {
            // --hot would keep the process alive after an uncaught error.
            console.log("rejected:", error);
            process.exit(1);
          }
        }
      `,
    });
    await using proc = spawn({
      cmd: [bunExe(), "--hot", "entry.mjs"],
      cwd: String(dir),
      env: bunEnv,
      stdout: "pipe",
      stderr: "inherit",
    });
    const [stdout, exitCode] = await Promise.all([proc.stdout.text(), proc.exited]);
    expect(stdout).toBe("in flight: evaluation 1\nnext: evaluation 2\n");
    expect(exitCode).toBe(0);
  },
  timeout,
);

it("holds the promise of the entry point itself, which it looks at on every tick", async () => {
  const source = (comment: string) => `
    globalThis.loads = (globalThis.loads ?? 0) + 1;
    const load = globalThis.loads;
    setTimeout(() => {
      Bun.gc(true);
      const { nodes, nodeClassNames, edges } = require("bun:jsc").generateHeapSnapshotForDebugging();
      const className = new Map();
      for (let i = 0; i < nodes.length; i += 7) className.set(nodes[i], nodeClassNames[nodes[i + 2]]);
      let held = 0;
      for (let i = 0; i < edges.length; i += 4)
        if (className.get(edges[i]) === "StrongRootBlock" && className.get(edges[i + 1]) === "Promise") held++;
      console.log("load " + load + ": " + held + " held");
    }, 0);
    // ${comment}
  `;
  using dir = tempDir("hot-entry-promise", { "main.js": source("first") });
  await using runner = spawn({
    cmd: [bunExe(), "--hot", "--no-clear-screen", "main.js"],
    env: bunEnv,
    cwd: String(dir),
    stdout: "pipe",
    stderr: "inherit",
    stdin: "ignore",
  });
  const reader = runner.stdout.getReader();
  let stdout = "";
  const line = async (prefix: string) => {
    for (;;) {
      const found = stdout
        .split("\n")
        .slice(0, -1)
        .find(line => line.startsWith(prefix));
      if (found) return found;
      const { value, done } = await reader.read();
      if (done) return stdout;
      stdout += Buffer.from(value).toString();
    }
  };
  expect(await line("load 1:")).toBe("load 1: 1 held");
  writeFileSync(join(String(dir), "main.js"), source("second"));
  expect(await line("load 2:")).toBe("load 2: 1 held");
});

// The cell of a collected promise goes to the next promise that is made.
it.each([
  ["pending", `new Promise(() => {})`],
  ["rejected and handled", `Promise.reject(new Error("not the entry point's"))`],
])("does not take a promise of the program's, %s, for that of the entry point", async (_, promise) => {
  using dir = tempDir("hot-entry-promise-reused", { "main.js": `console.log("first load");` });
  await using runner = spawn({
    cmd: [bunExe(), "--hot", "--no-clear-screen", "main.js"],
    env: bunEnv,
    cwd: String(dir),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const reader = runner.stdout.getReader();
  let stdout = "";
  const line = async (expected: string) => {
    while (!stdout.split("\n").slice(0, -1).includes(expected)) {
      const { value, done } = await reader.read();
      if (done) break;
      stdout += Buffer.from(value).toString();
    }
  };
  await line("first load");
  // What is left on the stack can keep it alive, and differs with where a collection starts from.
  writeFileSync(
    join(String(dir), "main.js"),
    `
      globalThis.kept = [];
      require("fs").readFile(__filename, () => {
        Bun.gc(true);
        setImmediate(() => {
          Bun.gc(true);
          require("crypto").randomBytes(8, () => {
            Bun.gc(true);
            for (let i = 0; i < 20000; i++) {
              const promise = ${promise};
              promise.catch(() => {});
              kept.push(promise);
            }
            console.log("collected");
          });
        });
      });
    `,
  );
  await line("collected");
  writeFileSync(join(String(dir), "main.js"), `console.log("third load"); process.exit(0);`);
  await line("third load");
  const stderr = (await runner.stderr.text()).split("\n").filter(line => line && !line.startsWith("DEBUG: "));
  expect({ stdout: stdout.split("\n"), stderr }).toEqual({
    stdout: ["first load", "collected", "third load", ""],
    stderr: [],
  });
});

/** Returns a function that resolves to `true` once the stream's text includes `wanted`, or to the full text at EOF. */
function follow(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  let text = "";
  return async (wanted: string) => {
    while (!text.includes(wanted)) {
      const { value, done } = await reader.read();
      if (done) return text;
      text += Buffer.from(value).toString();
    }
    return true;
  };
}

/** Windows only. Suspends the process while `change` runs, so all of its file events are queued on resume. */
function whileSuspended(pid: number, change: () => void) {
  const kernel32 = dlopen("kernel32.dll", {
    OpenProcess: { args: ["u32", "i32", "u32"], returns: "ptr" },
    CloseHandle: { args: ["ptr"], returns: "i32" },
  });
  const ntdll = dlopen("ntdll.dll", {
    NtSuspendProcess: { args: ["ptr"], returns: "i32" },
    NtResumeProcess: { args: ["ptr"], returns: "i32" },
  });
  const PROCESS_SUSPEND_RESUME = 0x0800;
  const handle = kernel32.symbols.OpenProcess(PROCESS_SUSPEND_RESUME, 0, pid);
  expect(handle).not.toBeNull();
  let resumed: number;
  try {
    expect(ntdll.symbols.NtSuspendProcess(handle)).toBe(0);
    change();
  } finally {
    resumed = ntdll.symbols.NtResumeProcess(handle);
    kernel32.symbols.CloseHandle(handle);
    kernel32.close();
    ntdll.close();
  }
  expect(resumed).toBe(0);
}

it.if(isWindows)("notices a deleted import in a burst of file events", async () => {
  using dir = tempDir("hot-burst", {
    "main.js": `import "./mods/a.js";\nimport "./mods/b.js";\nconsole.log("loaded");\n`,
    "mods/a.js": "export {};",
    "mods/b.js": "export {};",
    "other/keep": "",
  });
  const root = String(dir);
  await using runner = spawn({
    cmd: [bunExe(), "--hot", "--no-clear-screen", "main.js"],
    env: bunEnv,
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const stdout = follow(runner.stdout);
  const stderr = follow(runner.stderr);
  expect(await stdout("loaded")).toBe(true);

  whileSuspended(runner.pid, () => {
    // The pending read completes with only the first change.
    writeFileSync(join(root, "other", "first"), "");
    unlinkSync(join(root, "mods", "b.js"));
    for (let i = 0; i < 200; i++) writeFileSync(join(root, "other", String(i)), "");
  });
  expect(await stderr("Cannot find module './mods/b.js'")).toBe(true);

  writeFileSync(join(root, "main.js"), `import "./mods/a.js";\nconsole.log("reloaded");\n`);
  expect(await stdout("reloaded")).toBe(true);
});

it.if(isWindows)("dev server survives a burst of file events that includes a deleted import", async () => {
  // The watcher dispatches at most 128 events per batch, so use more files than that.
  const count = 150;
  const main = (from: number, log: string) =>
    Array.from({ length: count - from }, (_, i) => `import "./mods/${from + i}.ts";\n`).join("") +
    `console.log(${JSON.stringify(log)});\n`;
  using dir = tempDir("dev-server-burst", {
    "index.html": `<script type="module" src="./main.ts"></script>`,
    "main.ts": main(0, "first bundle"),
    ...Object.fromEntries(Array.from({ length: count }, (_, i) => [`mods/${i}.ts`, `console.log(${i});`])),
    "other/keep": "",
    "server.ts": `
        import html from "./index.html";
        const server = Bun.serve({ port: 0, development: true, routes: { "/": html } });
        await Bun.write("url", server.url.href);
        console.log("listening");
      `,
  });
  const root = String(dir);
  await using runner = spawn({
    cmd: [bunExe(), "server.ts"],
    env: bunEnv,
    cwd: root,
    stdout: "pipe",
    stderr: "inherit",
    stdin: "ignore",
  });
  expect(await follow(runner.stdout)("listening")).toBe(true);
  const url = readFileSync(join(root, "url"), "utf8");
  const bundle = async () => {
    // A failed build's page has no script, and the build fails while main.ts imports the deleted file.
    const src = /src="([^"]+)"/.exec(await (await fetch(url)).text())?.[1];
    return src ? await (await fetch(new URL(src, url))).text() : "";
  };
  expect(await bundle()).toContain("first bundle");

  whileSuspended(runner.pid, () => {
    // The pending read completes with only the first change.
    writeFileSync(join(root, "other", "first"), "");
    unlinkSync(join(root, "mods", "0.ts"));
    for (let i = 1; i < count; i++) writeFileSync(join(root, "mods", `${i}.ts`), `console.log(${i}, "again");`);
  });

  writeFileSync(join(root, "main.ts"), main(1, "second bundle"));
  while (!(await bundle()).includes("second bundle"));
});

// Other platforms evict the deleted import and stop watching its path, so "second" is never printed.
it.todoIf(!isWindows)("reloads when a deleted import is recreated", async () => {
  using dir = tempDir("hot-import-back", {
    "main.js": `import "./imported.js";\n`,
    "imported.js": `console.log("first");`,
  });
  const root = String(dir);
  await using runner = spawn({
    cmd: [bunExe(), "--hot", "--no-clear-screen", "main.js"],
    env: bunEnv,
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const stdout = follow(runner.stdout);
  const stderr = follow(runner.stderr);
  expect(await stdout("first")).toBe(true);

  unlinkSync(join(root, "imported.js"));
  expect(await stderr("Cannot find module './imported.js'")).toBe(true);

  writeFileSync(join(root, "imported.js"), `console.log("second");`);
  expect(await stdout("second")).toBe(true);
});

// The Windows watcher never reads the cached listing.
it.skipIf(isWindows)("survives a directory event for a folder whose cached listing failed to read", async () => {
  using dir = tempDir("hot-dir-read-error", {
    "trace.log": "",
    "src/lib/a.ts": `export {};`,
    "src/fence/f.ts": `export {};`,
    "src/main.ts": `
      import "./lib/a.ts";
      import "./fence/f.ts";
      import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
      // The watch follows the renamed folder. Listing "lib" now fails with ENOTDIR.
      renameSync("lib", "lib.away");
      writeFileSync("lib", "");
      // The watcher logs each batch before handling it, so the first batch is done once the second is logged.
      const trace = process.env.BUN_WATCHER_TRACE;
      for (let i = 0; i < 2; i++) {
        const from = statSync(trace).size;
        mkdirSync("fence/" + i);
        while (!readFileSync(trace, "latin1").slice(from).includes("/fence/")) await Bun.sleep(1);
      }
      await import("./lib/b.ts").catch(() => console.log("import failed"));
      writeFileSync("lib.away/c.ts", "");
      console.log("ready");
      setInterval(() => {}, 1e6);
    `,
  });
  const cwd = join(String(dir), "src");
  await using runner = spawn({
    cmd: [bunExe(), "--hot", "--no-clear-screen", "main.ts"],
    env: { ...bunEnv, BUN_WATCHER_TRACE: join(String(dir), "trace.log") },
    cwd,
    stdout: "pipe",
    stderr: "inherit",
    stdin: "ignore",
  });
  const stdout = follow(runner.stdout);
  expect(await stdout("import failed\nready")).toBe(true);

  writeFileSync(join(cwd, "main.ts"), `console.log("reloaded");\nprocess.exit(0);\n`);
  expect(await stdout("reloaded")).toBe(true);
  expect(await runner.exited).toBe(0);
});

// Only inotify reports the changed entry's name, and PATH_MAX is 1024 on macOS.
it.skipIf(!isLinux).each([
  ["a new file whose path is longer than PATH_MAX", Buffer.alloc(247, "n") + ".ts"],
  ["an import whose path is PATH_MAX long", Buffer.alloc(245, "n") + ".png"],
])("survives %s", async (_, name) => {
  using dir = tempDir("hot-long-path", {});
  // Folder + separator + name is 4097 bytes for the first name and 4096 bytes for the second.
  const folderLength = 3846;
  let cwd = realpathSync(String(dir));
  while (folderLength - cwd.length > 256) cwd = join(cwd, Buffer.alloc(200, "d").toString());
  cwd = join(cwd, Buffer.alloc(folderLength - cwd.length - 1, "e").toString());
  mkdirSync(cwd, { recursive: true });
  // The absolute path is too long for a syscall, so use a relative path.
  const create = `require("node:fs").writeFileSync("${name}", "");`;
  const isImport = name.endsWith(".png");
  if (isImport) {
    await using setup = spawn({ cmd: [bunExe(), "-e", create], cwd, env: bunEnv });
    expect(await setup.exited).toBe(0);
  }
  writeFileSync(
    join(cwd, "main.ts"),
    `${isImport ? `import "./${name}";` : create}\nconsole.log("ready");\nsetInterval(() => {}, 1e6);\n`,
  );
  await using runner = spawn({
    cmd: [bunExe(), "--hot", "--no-clear-screen", "main.ts"],
    env: bunEnv,
    cwd,
    stdout: "pipe",
    stderr: "inherit",
    stdin: "ignore",
  });
  const stdout = follow(runner.stdout);
  expect(await stdout("ready")).toBe(true);

  writeFileSync(join(cwd, "main.ts"), `console.log("reloaded");\nprocess.exit(0);\n`);
  expect(await stdout("reloaded")).toBe(true);
  expect(await runner.exited).toBe(0);
});

// BUN_DESTRUCT_VM_ON_EXIT frees the VM at exit. The writes make sure the watcher thread is busy at that point.
it.skipIf(!isASAN)("stops the file watcher thread before the VM is freed at exit", async () => {
  async function run() {
    using dir = tempDir("hot-exit", {
      "main.js": `
        import "./dep.js";
        globalThis.loads = (globalThis.loads ?? 0) + 1;
        if (globalThis.loads === 3) process.exit(0);
      `,
      "dep.js": `export default 0;`,
    });
    await using runner = spawn({
      cmd: [bunExe(), "--hot", "--no-clear-screen", "main.js"],
      env: { ...bunEnv, BUN_DESTRUCT_VM_ON_EXIT: "1" },
      cwd: String(dir),
      stdout: "ignore",
      stderr: "inherit",
      stdin: "ignore",
    });
    let exited = false;
    runner.exited.then(() => (exited = true));
    for (let i = 0; !exited; i++) {
      for (let j = 0; j < 20; j++) writeFileSync(join(String(dir), "dep.js"), `export default ${i};`);
      await new Promise(resolve => setImmediate(resolve));
    }
    return await runner.exited;
  }
  expect(await Promise.all([run(), run(), run(), run()])).toEqual([0, 0, 0, 0]);
});

// --hot and --watch intern a module's transpiled text in the VM.
it("throws ERR_STRING_TOO_LONG for a module whose transpiled text exceeds the string limit", async () => {
  using dir = tempDir("hot-string-limit", {
    "big.cjs": `const s = ${JSON.stringify(Buffer.alloc(200 * 1024, "x").toString())};\nmodule.exports = { len: s.length };\n`,
    "small.cjs": `module.exports = { ok: 2 };\n`,
    "entry.cjs": `
      let big;
      try {
        big = "loaded:" + require("./big.cjs").len;
      } catch (e) {
        big = "caught:" + (e?.code ?? e?.name);
      }
      console.log(JSON.stringify({ big, small: require("./small.cjs").ok }));
      process.exit(0);
    `,
  });
  await using proc = spawn({
    cmd: [bunExe(), "--hot", "--no-clear-screen", "entry.cjs"],
    cwd: String(dir),
    env: { ...bunEnv, BUN_FEATURE_FLAG_SYNTHETIC_MEMORY_LIMIT: String(64 * 1024) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  expect({ stdout, stderr, exitCode }).toEqual({
    stdout: JSON.stringify({ big: "caught:ERR_STRING_TOO_LONG", small: 2 }) + "\n",
    stderr: "",
    exitCode: 0,
  });
});

it.each(["--hot", "--watch"])("%s keeps running and reloading after uncaught exceptions", async flag => {
  using dir = tempDir("hot-uncaught", {
    "main.js": `
      const server = Bun.serve({
        port: 0,
        fetch(req) {
          queueMicrotask(() => {
            throw new Error("from " + new URL(req.url).pathname);
          });
          return new Response("ok");
        },
      });
      (async () => {
        for (let i = 1; i <= 2; i++) await fetch(new URL("/" + i, server.url));
        console.log("still running");
      })();
      // The timers of a run stop at its first uncaught exception. On Windows, libuv goes on firing them.
      if (process.platform !== "win32") setTimeout(() => process.exit(1), 1);
      throw new Error("from the entry point");
    `,
  });
  await using runner = spawn({
    cmd: [bunExe(), flag, "--no-clear-screen", "main.js"],
    env: bunEnv,
    cwd: String(dir),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const stdout = follow(runner.stdout);
  const stderr = follow(runner.stderr);
  expect(await stdout("still running")).toBe(true);
  expect(await stderr("error: from /2")).toBe(true);

  writeFileSync(
    join(String(dir), "main.js"),
    `setTimeout(() => {\n  console.log("timer fired");\n  process.exit(0);\n}, 1);\n`,
  );
  expect(await stdout("timer fired")).toBe(true);
  expect(await runner.exited).toBe(0);
});

it.each([
  [
    "a throw",
    `setInterval(() => console.log("failed run's interval in run " + globalThis.run), 1);\nthrow new Error("the bug");`,
  ],
  ["a syntax error", `const = ;`],
])("--hot keeps the timers of earlier runs when a save fixes %s", async (_, bug) => {
  const source = (run: number, tail: string) => `
    globalThis.run = ${run};
    globalThis.kept ??= setInterval(() => console.log("kept interval in run " + globalThis.run), 1);
    require("fs").watchFile("watched", { interval: 1 }, () => {
      console.log("watchFile listener of run ${run}");
      if (${run} === 3) process.exit(0);
    });
    ${tail}
  `;
  using dir = tempDir("hot-kept-timers", { "main.js": source(1, ""), "watched": "" });
  await using runner = spawn({
    cmd: [bunExe(), "--hot", "--no-clear-screen", "main.js"],
    env: bunEnv,
    cwd: String(dir),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const stdout = follow(runner.stdout);
  const stderr = follow(runner.stderr);
  expect(await stdout("kept interval in run 1")).toBe(true);

  writeFileSync(join(String(dir), "main.js"), source(2, bug));
  expect(await stderr("error: ")).toBe(true);

  writeFileSync(join(String(dir), "main.js"), source(3, ""));
  expect(await stdout("kept interval in run 3")).toBe(true);
  writeFileSync(join(String(dir), "watched"), "changed");
  expect(await stdout("watchFile listener of run 3")).toBe(true);
  expect(await stdout("failed run's interval in run 3")).not.toBe(true);
  expect(await runner.exited).toBe(0);
});

it("--hot does not emit beforeExit to the listeners of a failed run", async () => {
  using dir = tempDir("hot-failed-before-exit", {
    "main.js": `process.on("beforeExit", () => process.exit(1));\nthrow new Error("the bug");`,
  });
  await using runner = spawn({
    cmd: [bunExe(), "--hot", "--no-clear-screen", "main.js"],
    env: bunEnv,
    cwd: String(dir),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const stdout = follow(runner.stdout);
  const stderr = follow(runner.stderr);
  expect(await stderr("error: the bug")).toBe(true);

  writeFileSync(join(String(dir), "main.js"), `console.log("fixed");`);
  expect(await stdout("fixed")).toBe(true);
  writeFileSync(join(String(dir), "main.js"), `console.log("still running");\nprocess.exit();`);
  expect(await stdout("still running")).toBe(true);
  expect(await runner.exited).toBe(0);
});

// Environment variables are read once at startup, so a soft reload cannot
// apply a changed .env file. Editing one restarts the process (global state
// starts over), while editing a module still soft reloads.
it("--hot restarts the process when a loaded .env file changes", async () => {
  using dir = tempDir("hot-dotenv", {
    ".env": "GREETING=hello\n",
    "app.js": `globalThis.runs = (globalThis.runs ?? 0) + 1;
console.log(process.env.GREETING + " " + globalThis.runs);
setInterval(() => {}, 1000);
`,
  });
  await using runner = spawn({
    cmd: [bunExe(), "--hot", "app.js"],
    cwd: String(dir),
    env: bunEnv,
    stdout: "pipe",
    stderr: "inherit",
    stdin: "ignore",
  });

  const reader = runner.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  const waitFor = async (needle: string) => {
    while (!output.includes(needle)) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`stream closed, output so far: ${JSON.stringify(output)}`);
      output += decoder.decode(value, { stream: true });
    }
  };

  await waitFor("hello 1\n");

  // A module edit soft reloads: globalThis survives, so the counter advances.
  const app = join(String(dir), "app.js");
  writeFileSync(app, readFileSync(app, "utf-8") + "// edited\n");
  await waitFor("hello 2\n");

  // A .env edit restarts the process: the counter starts over with the new value.
  writeFileSync(join(String(dir), ".env"), "GREETING=bye\n");
  await waitFor("bye 1\n");

  reader.releaseLock();
  runner.kill("SIGKILL");
  await runner.exited;
});
