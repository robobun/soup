import type { BuildOutput, BuildWatcher, BunPlugin } from "bun";
import { buildWatcherState } from "bun:internal-for-testing";
import { describe, expect, spyOn, test } from "bun:test";
import { bunEnv, bunExe, tempDir } from "harness";
import { mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The results of the watcher, up to and including the first one that `accept` takes. A save can
// be more than one rebuild, so a test waits for the result it means and not for "the next one".
// A result that never comes fails the test by its timeout.
async function until(watcher: BuildWatcher, accept: (output: BuildOutput) => boolean | Promise<boolean>) {
  const seen: BuildOutput[] = [];
  for (;;) {
    const { value, done } = await watcher.next();
    if (done) throw new Error(`the watcher ended after ${seen.length} results, none of them the expected one`);
    seen.push(value);
    if (await accept(value)) return seen;
  }
}

// Resolves as soon as the watcher is told of an event for the file `name`, with the state of the
// watcher at that moment. Call it before the change. Events of one directory come in the order
// of the changes, so by then the watcher has decided about every change before that one.
function told(watcher: BuildWatcher, name: string) {
  const { promise, resolve } = Promise.withResolvers<ReturnType<typeof buildWatcherState>>();
  buildWatcherState(watcher, state => {
    if (state.lastEvent === name) resolve(state);
  });
  return promise;
}

// Takes results until no build is running or about to start. A watcher builds a second time when
// a file changed while its first build was reading it, and a file that was written in the few
// milliseconds before the watcher was made looks like one. A test that counts builds, or that
// looks at the next result, lets that pass first.
async function settled(watcher: BuildWatcher) {
  while (buildWatcherState(watcher).pending) await watcher.next();
  return buildWatcherState(watcher);
}

const succeeded = (output: BuildOutput) => output.success;
const failed = (output: BuildOutput) => !output.success;
const contains = (text: string) => async (output: BuildOutput) =>
  output.success && (await output.outputs[0].text()).includes(text);

// Counts the builds of the watcher it is a plugin of, and how many of them run at once.
function counter() {
  const counts = { setup: 0, start: 0, end: 0, running: 0, most: 0 };
  const plugin: BunPlugin = {
    name: "count",
    setup(build) {
      counts.setup++;
      build.onStart(() => {
        counts.start++;
        counts.most = Math.max(counts.most, ++counts.running);
      });
      build.onEnd(() => {
        counts.end++;
        counts.running--;
      });
    },
  };
  return { counts, plugin };
}

// Not concurrent: every build of every watcher is made by the one bundle thread, and in a debug
// build a test that waits behind the builds of twenty others runs into its timeout.
describe("Bun.build({ watch: true })", () => {
  test("delivers the first build, then a rebuild for a change to the entry point", async () => {
    using dir = tempDir("build-watch-entry", { "index.ts": `console.log("one");` });
    const outfile = join(String(dir), "out", "index.js");

    await using watcher = Bun.build({
      entrypoints: [join(String(dir), "index.ts")],
      outdir: join(String(dir), "out"),
      watch: true,
    });
    expect(watcher).not.toBeInstanceOf(Promise);
    expect(watcher[Symbol.asyncIterator]()).toBe(watcher);

    const first = await watcher.next();
    expect(first.done).toBe(false);
    expect(Object.keys(first.value!)).toEqual(["outputs", "success", "logs"]);
    expect(first.value!.success).toBe(true);
    expect(first.value!.outputs.map(artifact => artifact.path)).toEqual([outfile]);
    expect(readFileSync(outfile, "utf8")).toContain(`"one"`);

    writeFileSync(join(String(dir), "index.ts"), `console.log("two");`);
    await until(watcher, contains(`"two"`));
    expect(readFileSync(outfile, "utf8")).toContain(`"two"`);
  });

  test("rebuilds for a change to an imported file in another directory", async () => {
    using dir = tempDir("build-watch-import", {
      "index.ts": `import { value } from "./lib/value";\nconsole.log(value);`,
      "lib/value.ts": `export const value = "one";`,
    });
    await using watcher = Bun.build({ entrypoints: [join(String(dir), "index.ts")], watch: true });
    await until(watcher, contains(`"one"`));
    expect(buildWatcherState(watcher)).toMatchObject({
      watched: { [String(dir)]: ["index.ts"], [join(String(dir), "lib")]: ["value.ts"] },
      missing: {},
    });

    writeFileSync(join(String(dir), "lib", "value.ts"), `export const value = "two";`);
    await until(watcher, contains(`"two"`));
  });

  test("rebuilds when a file is saved by renaming another over it", async () => {
    using dir = tempDir("build-watch-rename", { "index.ts": `console.log("one");` });
    await using watcher = Bun.build({ entrypoints: [join(String(dir), "index.ts")], watch: true });
    await until(watcher, contains(`"one"`));

    writeFileSync(join(String(dir), "index.ts.tmp"), `console.log("two");`);
    renameSync(join(String(dir), "index.ts.tmp"), join(String(dir), "index.ts"));
    await until(watcher, contains(`"two"`));

    // The file is another inode now, and still watched.
    writeFileSync(join(String(dir), "index.ts.tmp"), `console.log("three");`);
    renameSync(join(String(dir), "index.ts.tmp"), join(String(dir), "index.ts"));
    await until(watcher, contains(`"three"`));
  });

  test("a failed build is a result with success: false, and the next change builds again", async () => {
    using dir = tempDir("build-watch-error", { "index.ts": `console.log("one");` });
    // `throw` is for the promise of a build without `watch`. A watcher does not reject for a failed build.
    await using watcher = Bun.build({ entrypoints: [join(String(dir), "index.ts")], watch: true, throw: true });
    await until(watcher, contains(`"one"`));

    writeFileSync(join(String(dir), "index.ts"), `console.log("two"`);
    const failure = (await until(watcher, failed)).at(-1)!;
    expect(Object.keys(failure)).toEqual(["outputs", "success", "logs"]);
    expect(failure.outputs).toEqual([]);
    expect(failure.logs.length).toBeGreaterThan(0);
    expect(failure.logs[0].level).toBe("error");
    expect(failure.logs[0].position?.file).toBe(join(String(dir), "index.ts"));

    writeFileSync(join(String(dir), "index.ts"), `console.log("three");`);
    await until(watcher, contains(`"three"`));
  });

  test("the first build may fail", async () => {
    using dir = tempDir("build-watch-first-error", { "index.ts": `console.log("one"` });
    await using watcher = Bun.build({ entrypoints: [join(String(dir), "index.ts")], watch: true });
    const first = await watcher.next();
    expect(first.value!.success).toBe(false);

    writeFileSync(join(String(dir), "index.ts"), `console.log("two");`);
    await until(watcher, contains(`"two"`));
  });

  test("rebuilds when an imported file is deleted, and again when it is back", async () => {
    using dir = tempDir("build-watch-delete", {
      "index.ts": `import { value } from "./lib/value";\nconsole.log(value);`,
      "lib/value.ts": `export const value = "one";`,
    });
    await using watcher = Bun.build({ entrypoints: [join(String(dir), "index.ts")], watch: true });
    await until(watcher, contains(`"one"`));

    unlinkSync(join(String(dir), "lib", "value.ts"));
    const failure = (await until(watcher, failed)).at(-1)!;
    expect(failure.logs[0].message).toContain(`Could not resolve: "./lib/value"`);

    writeFileSync(join(String(dir), "lib", "value.ts"), `export const value = "two";`);
    await until(watcher, contains(`"two"`));
  });

  test("rebuilds when another directory is renamed over the directory of an imported file", async () => {
    using dir = tempDir("build-watch-replace-dir", {
      "index.ts": `import { value } from "./lib/value";\nconsole.log(value);`,
      "lib/value.ts": `export const value = "one";`,
      "next/value.ts": `export const value = "two";`,
    });
    await using watcher = Bun.build({ entrypoints: [join(String(dir), "index.ts")], watch: true });
    await until(watcher, contains(`"one"`));

    // No file is written: the directory is what changes.
    renameSync(join(String(dir), "lib"), join(String(dir), "previous"));
    renameSync(join(String(dir), "next"), join(String(dir), "lib"));
    await until(watcher, contains(`"two"`));

    // The watcher of the directory that was there first is of no use for this one.
    writeFileSync(join(String(dir), "lib", "value.ts"), `export const value = "three";`);
    await until(watcher, contains(`"three"`));
  });

  test("rebuilds when the directory of an imported file is removed and made again", async () => {
    using dir = tempDir("build-watch-remake-dir", {
      "index.ts": `import { value } from "./lib/value";\nconsole.log(value);`,
      "lib/value.ts": `export const value = "one";`,
    });
    await using watcher = Bun.build({ entrypoints: [join(String(dir), "index.ts")], watch: true });
    await until(watcher, contains(`"one"`));

    // The new directory can have the inode number of the old one.
    rmSync(join(String(dir), "lib"), { recursive: true });
    mkdirSync(join(String(dir), "lib"));
    writeFileSync(join(String(dir), "lib", "value.ts"), `export const value = "two";`);
    await until(watcher, contains(`"two"`));

    writeFileSync(join(String(dir), "lib", "value.ts"), `export const value = "three";`);
    await until(watcher, contains(`"three"`));
  });

  test("rebuilds when the file of an import that did not resolve is created", async () => {
    using dir = tempDir("build-watch-missing", {
      "index.ts": `import { a } from "./a";\nimport { b } from "./deep/er/b";\nimport { c } from "./pkg";\nconsole.log(a, b, c);`,
      "pkg/readme.txt": "no index here yet",
    });
    await using watcher = Bun.build({ entrypoints: [join(String(dir), "index.ts")], watch: true });
    const first = await watcher.next();
    expect(first.value!.success).toBe(false);
    expect(first.value!.logs.map(log => log.message).sort()).toEqual([
      `Could not resolve: "./a"`,
      `Could not resolve: "./deep/er/b"`,
      `Could not resolve: "./pkg"`,
    ]);
    // What would be each of them, or the next step on the way to it.
    expect(buildWatcherState(watcher)).toMatchObject({
      watched: { [String(dir)]: ["index.ts"], [join(String(dir), "pkg")]: [] },
      missing: { [String(dir)]: ["a", "deep", "pkg"], [join(String(dir), "pkg")]: ["index"] },
    });

    // Next to the file that imports it.
    writeFileSync(join(String(dir), "a.ts"), `export const a = "a1";`);
    await until(watcher, output => failed(output) && output.logs.length === 2);

    // As the index of a directory that is there.
    writeFileSync(join(String(dir), "pkg", "index.ts"), `export const c = "c1";`);
    await until(watcher, output => failed(output) && output.logs.length === 1);

    // In a directory that does not exist yet, one level at a time.
    mkdirSync(join(String(dir), "deep"));
    await until(watcher, failed);
    mkdirSync(join(String(dir), "deep", "er"));
    await until(watcher, failed);
    writeFileSync(join(String(dir), "deep", "er", "b.ts"), `export const b = "b1";`);
    await until(watcher, contains(`"b1"`));
    expect(buildWatcherState(watcher).missing).toEqual({});
  });

  test("a file that appears while the build that misses it is running starts another build", async () => {
    using dir = tempDir("build-watch-missed", { "index.ts": `console.log("one");` });
    let created = false;
    const plugin: BunPlugin = {
      name: "create",
      setup(build) {
        // The build has looked for the file by the time it ends, and nothing watches for it yet.
        build.onEnd(result => {
          if (result.success || created) return;
          created = true;
          writeFileSync(join(String(dir), "a.ts"), `export const a = "a1";`);
        });
      },
    };
    await using watcher = Bun.build({ entrypoints: [join(String(dir), "index.ts")], plugins: [plugin], watch: true });
    await until(watcher, contains(`"one"`));
    await settled(watcher);

    writeFileSync(join(String(dir), "index.ts"), `import { a } from "./a";\nconsole.log(a);`);
    const results = await until(watcher, contains(`"a1"`));
    expect(results[0].success).toBe(false);
  });

  test("after a failed build, only what was missing starts a build", async () => {
    using dir = tempDir("build-watch-failing", { "index.ts": `import { a } from "./a";\nconsole.log(a);` });
    await using watcher = Bun.build({ entrypoints: [join(String(dir), "index.ts")], watch: true });
    const first = await watcher.next();
    expect(first.value!.success).toBe(false);
    const { builds } = await settled(watcher);
    expect(buildWatcherState(watcher)).toMatchObject({
      watched: { [String(dir)]: ["index.ts"] },
      missing: { [String(dir)]: ["a"] },
    });

    // What a build that keeps failing, its plugins and an editor leave in the directory.
    const seen = told(watcher, "last");
    writeFileSync(join(String(dir), "other.ts"), `export const a = "other";`);
    mkdirSync(join(String(dir), "out"));
    writeFileSync(join(String(dir), ".0bafa7d4a973ca4b-00000001.bun-build"), "");
    unlinkSync(join(String(dir), ".0bafa7d4a973ca4b-00000001.bun-build"));
    writeFileSync(join(String(dir), "last"), "");
    expect(await seen).toMatchObject({ pending: false, builds });

    writeFileSync(join(String(dir), "a.ts"), `export const a = "a1";`);
    await until(watcher, contains(`"a1"`));
  });

  test("rebuilds when an entry point that did not exist is created", async () => {
    using dir = tempDir("build-watch-missing-entry", {});
    await using watcher = Bun.build({ entrypoints: [join(String(dir), "index.ts")], watch: true });
    const first = await watcher.next();
    expect(first.value!.success).toBe(false);

    writeFileSync(join(String(dir), "index.ts"), `console.log("one");`);
    await until(watcher, contains(`"one"`));
  });

  test("goes on when the directory of the entry point is removed, and builds when it is back", async () => {
    using dir = tempDir("build-watch-entry-dir", { "src/index.ts": `console.log("one");` });
    await using watcher = Bun.build({ entrypoints: [join(String(dir), "src", "index.ts")], watch: true });
    await until(watcher, contains(`"one"`));

    // Without the directory a build does not even start: Bun.build() throws.
    rmSync(join(String(dir), "src"), { recursive: true });
    const failure = (await until(watcher, failed)).at(-1)!;
    expect(failure.outputs).toEqual([]);
    expect(failure.logs).toHaveLength(1);

    mkdirSync(join(String(dir), "src"));
    writeFileSync(join(String(dir), "src", "index.ts"), `console.log("two");`);
    await until(watcher, contains(`"two"`));
  });

  test("watches a file from the build that first imports it, and no longer than it is imported", async () => {
    using dir = tempDir("build-watch-new-import", {
      "index.ts": `console.log("one");`,
      "other/value.ts": `export const value = "two";`,
    });
    await using watcher = Bun.build({ entrypoints: [join(String(dir), "index.ts")], watch: true });
    await until(watcher, contains(`"one"`));
    expect(buildWatcherState(watcher).watched).toEqual({ [String(dir)]: ["index.ts"] });

    writeFileSync(join(String(dir), "index.ts"), `import { value } from "./other/value";\nconsole.log(value);`);
    await until(watcher, contains(`"two"`));
    expect(buildWatcherState(watcher).watched).toEqual({
      [String(dir)]: ["index.ts"],
      [join(String(dir), "other")]: ["value.ts"],
    });

    writeFileSync(join(String(dir), "other", "value.ts"), `export const value = "three";`);
    await until(watcher, contains(`"three"`));

    writeFileSync(join(String(dir), "index.ts"), `console.log("four");`);
    await until(watcher, contains(`"four"`));
    expect(buildWatcherState(watcher).watched).toEqual({ [String(dir)]: ["index.ts"] });
  });

  test("a change while the first build is running starts a rebuild", async () => {
    using dir = tempDir("build-watch-during-first", {
      "index.ts": `import { value } from "./value";\nconsole.log(value);`,
      "value.ts": `export const value = "one";`,
    });
    // The build has read the file by the time it ends, and nothing watches the file yet.
    let changed = false;
    const plugin: BunPlugin = {
      name: "change",
      setup(build) {
        build.onEnd(() => {
          if (changed) return;
          changed = true;
          writeFileSync(join(String(dir), "value.ts"), `export const value = "two";`);
        });
      },
    };
    await using watcher = Bun.build({ entrypoints: [join(String(dir), "index.ts")], plugins: [plugin], watch: true });
    await until(watcher, contains(`"two"`));
  });

  test("a change to a newly imported file while the rebuild that imports it is running starts another", async () => {
    using dir = tempDir("build-watch-during-rebuild", {
      "index.ts": `console.log("one");`,
      "other/value.ts": `export const value = "two";`,
    });
    let changed = false;
    const plugin: BunPlugin = {
      name: "change",
      setup(build) {
        build.onEnd(async result => {
          // The build that has read other/value.ts, for the first time, and does not watch it yet.
          if (changed || !(await contains(`"two"`)(result))) return;
          changed = true;
          writeFileSync(join(String(dir), "other", "value.ts"), `export const value = "three";`);
        });
      },
    };
    await using watcher = Bun.build({ entrypoints: [join(String(dir), "index.ts")], plugins: [plugin], watch: true });
    await until(watcher, contains(`"one"`));

    writeFileSync(join(String(dir), "index.ts"), `import { value } from "./other/value";\nconsole.log(value);`);
    await until(watcher, contains(`"three"`));
  });

  test("a change while a build is running starts the next one when that one has ended", async () => {
    using dir = tempDir("build-watch-dirty", {
      "index.ts": `import { value } from "./value";\nconsole.log(value);`,
      "value.ts": `export const value = "v1";`,
    });
    const { counts, plugin } = counter();
    // Holds a build after it has read value.ts.
    let loading: PromiseWithResolvers<void> | undefined;
    let gate: PromiseWithResolvers<void> | undefined;
    const hold: BunPlugin = {
      name: "hold",
      setup(build) {
        build.onLoad({ filter: /value\.ts$/ }, async ({ path }) => {
          const contents = await Bun.file(path).text();
          loading?.resolve();
          await gate?.promise;
          return { contents, loader: "ts" };
        });
      },
    };
    await using watcher = Bun.build({
      entrypoints: [join(String(dir), "index.ts")],
      plugins: [plugin, hold],
      watch: true,
    });
    await until(watcher, contains(`"v1"`));
    const { builds } = await settled(watcher);

    loading = Promise.withResolvers();
    gate = Promise.withResolvers();
    writeFileSync(join(String(dir), "value.ts"), `export const value = "v2";`);
    await loading.promise;

    // The build that is running has read "v2". The watcher hears of "v3" before it ends.
    const seen = told(watcher, "value.ts");
    writeFileSync(join(String(dir), "value.ts"), `export const value = "v3";`);
    expect(await seen).toMatchObject({ pending: true, builds: builds + 1 });
    gate.resolve();
    gate = undefined;

    const results = await until(watcher, contains(`"v3"`));
    expect(await results[0].outputs[0].text()).toContain(`"v2"`);
    expect(counts.most).toBe(1);
  });

  test("many writes at once are one rebuild", async () => {
    using dir = tempDir("build-watch-burst", {
      "index.ts": `import { value } from "./value";\nconsole.log(value);`,
      "value.ts": `export const value = "v0";`,
    });
    const { counts, plugin } = counter();
    await using watcher = Bun.build({ entrypoints: [join(String(dir), "index.ts")], plugins: [plugin], watch: true });
    await until(watcher, contains(`"v0"`));
    const { builds } = await settled(watcher);

    for (let i = 1; i <= 50; i++) {
      writeFileSync(join(String(dir), "value.ts"), `export const value = "v${i}";`);
      writeFileSync(join(String(dir), "index.ts"), `import { value } from "./value";\nconsole.log(value, ${i});`);
    }
    const results = await until(watcher, contains(`"v50"`));
    // One for the hundred writes, and one more if the last events only arrive while that one runs.
    expect(results.length).toBeLessThanOrEqual(2);
    expect(counts.start - builds).toBeLessThanOrEqual(2);
  });

  test("waits 50 ms after the last change before it builds", async () => {
    using dir = tempDir("build-watch-delay", { "index.ts": `console.log("one");` });
    // When the watcher was last told of a change before the rebuild started, and when that started.
    let toldAt = 0;
    let startedAt = 0;
    let changed = false;
    const plugin: BunPlugin = {
      name: "time",
      setup(build) {
        build.onStart(() => {
          if (changed && startedAt === 0) startedAt = performance.now();
        });
      },
    };
    await using watcher = Bun.build({ entrypoints: [join(String(dir), "index.ts")], plugins: [plugin], watch: true });
    await until(watcher, contains(`"one"`));
    await settled(watcher);

    changed = true;
    buildWatcherState(watcher, () => {
      if (startedAt === 0) toldAt = performance.now();
    });
    writeFileSync(join(String(dir), "index.ts"), `console.log("two");`);
    await until(watcher, contains(`"two"`));
    // A slow machine makes this longer, never shorter.
    expect(startedAt - toldAt).toBeGreaterThanOrEqual(45);
  });

  test("does not rebuild for a file that is not an input, or for its own output", async () => {
    using dir = tempDir("build-watch-unrelated", {
      "index.ts": `console.log("one");`,
      "unrelated.ts": `console.log("unrelated");`,
    });
    const { counts, plugin } = counter();
    // The output is written next to the input.
    await using watcher = Bun.build({
      entrypoints: [join(String(dir), "index.ts")],
      outdir: String(dir),
      naming: "bundle.js",
      plugins: [plugin],
      watch: true,
    });
    await until(watcher, succeeded);
    let { builds } = await settled(watcher);
    expect(buildWatcherState(watcher).watched).toEqual({ [String(dir)]: ["index.ts"] });

    let seen = told(watcher, "last");
    writeFileSync(join(String(dir), "unrelated.ts"), `console.log("changed");`);
    writeFileSync(join(String(dir), "created.ts"), `console.log("created");`);
    unlinkSync(join(String(dir), "created.ts"));
    writeFileSync(join(String(dir), "bundle.js"), `console.log("overwritten");`);
    writeFileSync(join(String(dir), "last"), "");
    expect(await seen).toMatchObject({ pending: false, builds });
    expect(counts.start).toBe(builds);

    // The build of a change to the input writes the output again, and is not started by that either.
    writeFileSync(join(String(dir), "index.ts"), `console.log("two");`);
    await until(watcher, contains(`"two"`));
    expect(readFileSync(join(String(dir), "bundle.js"), "utf8")).toContain(`"two"`);
    ({ builds } = await settled(watcher));
    seen = told(watcher, "last again");
    writeFileSync(join(String(dir), "last again"), "");
    expect(await seen).toMatchObject({ pending: false, builds });
    expect(counts.start).toBe(builds);
  });

  test("does not watch node_modules", async () => {
    using dir = tempDir("build-watch-node-modules", {
      "index.ts": `import { value } from "dependency";\nconsole.log(value, "one");`,
      "node_modules/dependency/package.json": JSON.stringify({ name: "dependency", main: "index.js" }),
      "node_modules/dependency/index.js": `export const value = "d1";`,
    });
    await using watcher = Bun.build({ entrypoints: [join(String(dir), "index.ts")], watch: true });
    await until(watcher, contains(`"d1"`));
    expect(buildWatcherState(watcher).watched).toEqual({ [String(dir)]: ["index.ts"] });

    // The next build reads what changed there all the same.
    writeFileSync(join(String(dir), "node_modules", "dependency", "index.js"), `export const value = "d2";`);
    writeFileSync(join(String(dir), "index.ts"), `import { value } from "dependency";\nconsole.log(value, "two");`);
    await until(watcher, contains(`"d2"`));
    expect(buildWatcherState(watcher).watched).toEqual({ [String(dir)]: ["index.ts"] });
  });

  test("a watcher with nothing to watch ends after its build", async () => {
    using dir = tempDir("build-watch-nothing", {
      "node_modules/dependency/index.js": `console.log("dependency");`,
    });
    const watcher = Bun.build({
      entrypoints: [join(String(dir), "node_modules", "dependency", "index.js")],
      watch: true,
    });
    const first = await watcher.next();
    expect(first.value!.success).toBe(true);
    expect(await watcher.next()).toEqual({ value: undefined, done: true });
    expect(buildWatcherState(watcher)).toMatchObject({ watched: {}, pending: false, builds: 1 });
  });

  test("next() returns the newest result that was not taken yet", async () => {
    using dir = tempDir("build-watch-latest", { "index.ts": `console.log("build 1");` });
    // Three builds are made while nobody takes a result: each but the last changes the file when it ends.
    const third = Promise.withResolvers<void>();
    let builds = 0;
    const plugin: BunPlugin = {
      name: "again",
      setup(build) {
        build.onEnd(() => {
          builds++;
          if (builds < 3) writeFileSync(join(String(dir), "index.ts"), `console.log("build ${builds + 1}");`);
          else third.resolve();
        });
      },
    };
    await using watcher = Bun.build({ entrypoints: [join(String(dir), "index.ts")], plugins: [plugin], watch: true });
    await third.promise;

    // The third, or the second when the third has ended but is not the watcher's yet. Never the first.
    const results = await until(watcher, contains(`"build 3"`));
    expect(results.length).toBeLessThanOrEqual(2);
  });

  test("each build is returned once", async () => {
    using dir = tempDir("build-watch-once", { "index.ts": `console.log("one");` });
    await using watcher = Bun.build({ entrypoints: [join(String(dir), "index.ts")], watch: true });
    // Two calls are waiting. The first build is for the first of them only.
    const first = watcher.next();
    const second = watcher.next();
    expect(await contains(`"one"`)((await first).value!)).toBe(true);

    writeFileSync(join(String(dir), "index.ts"), `console.log("two");`);
    expect(await contains(`"two"`)((await second).value!)).toBe(true);
  });

  test("leaving a for await loop stops the watcher", async () => {
    using dir = tempDir("build-watch-break", { "index.ts": `console.log("one");` });
    const watcher = Bun.build({ entrypoints: [join(String(dir), "index.ts")], watch: true });

    let results = 0;
    for await (const output of watcher) {
      if (++results === 1) writeFileSync(join(String(dir), "index.ts"), `console.log("two");`);
      if (await contains(`"two"`)(output)) break;
    }
    expect(results).toBeGreaterThanOrEqual(2);
    expect(await watcher.next()).toEqual({ value: undefined, done: true });
    expect(buildWatcherState(watcher)).toMatchObject({ watched: {}, pending: false });
  });

  test("stop() waits for the build that is running, and then ends a next() that is waiting", async () => {
    using dir = tempDir("build-watch-stop", { "index.ts": `console.log("one");` });
    const { counts, plugin } = counter();
    const watcher = Bun.build({ entrypoints: [join(String(dir), "index.ts")], plugins: [plugin], watch: true });

    // The first build is still running.
    let ended: number | undefined;
    const pending = watcher.next().then(result => {
      ended = counts.end;
      return result;
    });
    expect(counts.end).toBe(0);
    await watcher.stop();
    expect(counts.end).toBe(1);
    expect(await pending).toEqual({ value: undefined, done: true });
    expect(ended).toBe(1);
    expect(await watcher.next()).toEqual({ value: undefined, done: true });
    expect(buildWatcherState(watcher)).toEqual({
      watched: {},
      missing: {},
      builds: 1,
      pending: false,
      lastEvent: undefined,
    });

    // A second time is fine, and so is return().
    await watcher.stop();
    expect(await watcher.return()).toEqual({ value: undefined, done: true });
  });

  test("await using stops the watcher", async () => {
    using dir = tempDir("build-watch-using", { "index.ts": `console.log("one");` });
    let outer: BuildWatcher;
    {
      await using watcher = Bun.build({ entrypoints: [join(String(dir), "index.ts")], watch: true });
      outer = watcher;
      await until(watcher, contains(`"one"`));
      expect(buildWatcherState(watcher).watched).toEqual({ [String(dir)]: ["index.ts"] });
    }
    expect(buildWatcherState(outer)).toMatchObject({ watched: {}, pending: false });
    expect(await outer.next()).toEqual({ value: undefined, done: true });
  });

  test("plugins are set up again for every build, and a file a plugin loads is watched", async () => {
    using dir = tempDir("build-watch-plugin", {
      "index.ts": `import value from "virtual:value";\nimport text from "./data.txt";\nconsole.log(value, text);`,
      "data.txt": "t1",
    });
    let setups = 0;
    const plugin: BunPlugin = {
      name: "virtual",
      setup(build) {
        const setup = ++setups;
        build.onResolve({ filter: /^virtual:value$/ }, () => ({ path: "value", namespace: "virtual" }));
        build.onLoad({ filter: /.*/, namespace: "virtual" }, () => ({
          contents: `export default "setup ${setup}";`,
          loader: "js",
        }));
        build.onLoad({ filter: /\.txt$/ }, async ({ path }) => ({
          contents: `export default ${JSON.stringify("plugin:" + (await Bun.file(path).text()))};`,
          loader: "js",
        }));
      },
    };
    await using watcher = Bun.build({ entrypoints: [join(String(dir), "index.ts")], plugins: [plugin], watch: true });
    const [first] = await until(watcher, succeeded);
    const text = await first.outputs[0].text();
    expect(text).toContain(`"setup 1"`);
    expect(text).toContain(`"plugin:t1"`);
    // What the plugin made up is not a file.
    expect(buildWatcherState(watcher).watched).toEqual({ [String(dir)]: ["data.txt", "index.ts"] });

    writeFileSync(join(String(dir), "data.txt"), "t2");
    const rebuilt = (await until(watcher, contains(`"plugin:t2"`))).at(-1)!;
    const setup = Number((await rebuilt.outputs[0].text()).match(/"setup (\d+)"/)?.[1]);
    expect(setup).toBeGreaterThanOrEqual(2);
    expect(setup).toBeLessThanOrEqual(setups);
  });

  test("a change during an async setup() does not start a second build inside the first", async () => {
    using dir = tempDir("build-watch-async-setup", { "index.ts": `console.log("one");` });
    const { counts, plugin } = counter();
    let watcher: BuildWatcher;
    let change = false;
    let during: ReturnType<typeof buildWatcherState> | undefined;
    const slow: BunPlugin = {
      name: "slow",
      async setup() {
        if (!change) return;
        change = false;
        // Bun.build() runs the event loop until this has settled, and the watcher is told of
        // the change from in there.
        const seen = told(watcher, "index.ts");
        writeFileSync(join(String(dir), "index.ts"), `console.log("three");`);
        during = await seen;
      },
    };
    watcher = Bun.build({ entrypoints: [join(String(dir), "index.ts")], plugins: [slow, plugin], watch: true });
    await using _ = watcher;
    await until(watcher, contains(`"one"`));
    const { builds } = await settled(watcher);

    change = true;
    writeFileSync(join(String(dir), "index.ts"), `console.log("two");`);
    await until(watcher, contains(`"three"`));
    // The build whose setup() it was had started, and no other has.
    expect(during).toMatchObject({ pending: true, builds: builds + 1 });
    await settled(watcher);
    expect(counts.most).toBe(1);
  });

  test("a plugin that throws makes a failed build, and the watcher goes on", async () => {
    using dir = tempDir("build-watch-throws", { "index.ts": `console.log("one");` });
    let throwing: "setup" | "end" | undefined;
    const plugin: BunPlugin = {
      name: "throws",
      setup(build) {
        if (throwing === "setup") throw new Error("setup threw");
        build.onEnd(() => {
          if (throwing === "end") throw new Error("onEnd threw");
        });
      },
    };
    await using watcher = Bun.build({ entrypoints: [join(String(dir), "index.ts")], plugins: [plugin], watch: true });
    await until(watcher, contains(`"one"`));
    await settled(watcher);

    // Bun.build() throws this one, so there is no build.
    throwing = "setup";
    writeFileSync(join(String(dir), "index.ts"), `console.log("two");`);
    let failure = (await until(watcher, failed)).at(-1)!;
    expect(failure.outputs).toEqual([]);
    expect(failure.logs).toHaveLength(1);
    expect(failure.logs[0]).toBeInstanceOf(Error);
    expect(failure.logs[0].message).toBe("setup threw");
    await settled(watcher);

    // And the promise of Bun.build() rejects with this one.
    throwing = "end";
    writeFileSync(join(String(dir), "index.ts"), `console.log("three");`);
    failure = (await until(watcher, failed)).at(-1)!;
    expect(failure.logs).toHaveLength(1);
    expect(failure.logs[0].message).toBe("onEnd threw");
    await settled(watcher);

    throwing = undefined;
    writeFileSync(join(String(dir), "index.ts"), `console.log("four");`);
    await until(watcher, contains(`"four"`));
  });

  test("the options are read when the watcher is made", async () => {
    using dir = tempDir("build-watch-options", {
      "index.ts": `console.log(VALUE);`,
      "other.ts": `console.log("other");`,
    });
    let late = 0;
    const banner: BunPlugin = {
      name: "banner",
      setup(build) {
        // A plugin may change the options of its build. A rebuild does not start from what it left.
        build.config.banner = (build.config.banner ?? "") + "// banner\n";
      },
    };
    // `outdir` is inherited, which Bun.build() takes.
    const config = Object.assign(Object.create({ outdir: join(String(dir), "out") }), {
      entrypoints: [join(String(dir), "index.ts")],
      define: { VALUE: `"one"` },
      plugins: [banner],
      watch: true as const,
    });
    await using watcher = Bun.build(config);
    const [first] = await until(watcher, contains(`"one"`));
    expect(first.outputs.map(artifact => artifact.path)).toEqual([join(String(dir), "out", "index.js")]);
    expect((await first.outputs[0].text()).match(/\/\/ banner/g)).toHaveLength(1);

    config.define.VALUE = `"two"`;
    config.define = { VALUE: `"three"` };
    config.entrypoints.push(join(String(dir), "other.ts"));
    config.plugins.push({
      name: "late",
      setup() {
        late++;
      },
    });
    writeFileSync(join(String(dir), "index.ts"), `console.log(VALUE, "again");`);
    const rebuilt = (await until(watcher, contains(`"again"`))).at(-1)!;
    expect(rebuilt.outputs).toHaveLength(1);
    const text = await rebuilt.outputs[0].text();
    expect(text).toContain(`"one"`);
    expect(text.match(/\/\/ banner/g)).toHaveLength(1);
    expect(late).toBe(0);
  });

  test("invalid options throw when the watcher is made", () => {
    // @ts-expect-error
    expect(() => Bun.build({ entrypoints: ["./index.ts"], watch: "yes" })).toThrow("watch");
    // @ts-expect-error
    expect(() => Bun.build({ entrypoints: ["./index.ts"], watch: {} })).toThrow("watch");
    // @ts-expect-error
    expect(() => Bun.build({ entrypoints: "./index.ts", watch: true })).toThrow("entrypoints");
    // @ts-expect-error
    expect(() => Bun.build({ entrypoints: ["./index.ts"], watch: true, target: "nowhere" })).toThrow("target");
  });

  test("watch: false and watch: undefined are a build without watch", async () => {
    using dir = tempDir("build-watch-false", { "index.ts": `console.log("one");` });
    for (const watch of [false, undefined]) {
      const promise = Bun.build({ entrypoints: [join(String(dir), "index.ts")], watch });
      expect(promise).toBeInstanceOf(Promise);
      const output = await (promise as Promise<BuildOutput>);
      expect(Object.keys(output)).toEqual(["outputs", "success", "logs"]);
      expect(output.success).toBe(true);
    }
  });

  test("a failed build is printed as long as nothing has asked for a result", async () => {
    using dir = tempDir("build-watch-unobserved", { "index.ts": `console.log("one"` });
    const printed: unknown[][] = [];
    const first = Promise.withResolvers<void>();
    const error = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      printed.push(args);
      first.resolve();
    });
    try {
      await using watcher = Bun.build({ entrypoints: [join(String(dir), "index.ts")], watch: true });
      await first.promise;
      expect(printed).toHaveLength(1);
      expect(printed[0]).toHaveLength(1);
      const [failure] = printed[0] as [AggregateError];
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure.message).toBe("Bundle failed");
      expect(failure.errors[0].position.file).toBe(join(String(dir), "index.ts"));

      // The result is still there for the first next(). From then on the results are somebody's.
      const { value } = await watcher.next();
      expect(value!.success).toBe(false);
      writeFileSync(join(String(dir), "index.ts"), `console.log("two"; // still not`);
      await until(watcher, failed);
      writeFileSync(join(String(dir), "index.ts"), `console.log("three");`);
      await until(watcher, contains(`"three"`));
      expect(printed).toHaveLength(1);
    } finally {
      error.mockRestore();
    }
  });

  test("keeps the process alive until it is stopped", async () => {
    using dir = tempDir("build-watch-process", {
      "index.ts": `console.log("one");`,
      // No top-level await, which keeps a process alive by itself.
      "watch.ts": `
        const watcher = Bun.build({ entrypoints: ["./index.ts"], outdir: "./out", watch: true });
        let builds = 0;
        (async () => {
          for await (const output of watcher) {
            console.log("build", ++builds, output.success);
            if (builds === 2) break;
          }
          console.log("stopped");
        })();
      `,
    });
    await using proc = Bun.spawn({
      cmd: [bunExe(), "watch.ts"],
      cwd: String(dir),
      env: bunEnv,
      stdout: "pipe",
      stderr: "pipe",
    });

    let stdout = "";
    const decoder = new TextDecoder();
    const reader = proc.stdout.getReader();
    while (!stdout.includes("build 1 true\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      stdout += decoder.decode(value, { stream: true });
    }
    expect(stdout).toBe("build 1 true\n");

    writeFileSync(join(String(dir), "index.ts"), `console.log("two");`);
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      stdout += decoder.decode(value, { stream: true });
    }
    const [stderr, exitCode] = await Promise.all([proc.stderr.text(), proc.exited]);
    expect(stderr).toBe("");
    expect(stdout).toBe("build 1 true\nbuild 2 true\nstopped\n");
    expect(readFileSync(join(String(dir), "out", "index.js"), "utf8")).toContain(`"two"`);
    expect(exitCode).toBe(0);
  });

  test("a watcher that a Bun.ModuleGraph made ends when the graph is disposed", async () => {
    using dir = tempDir("build-watch-module-graph", {
      "index.ts": `console.log("one");`,
      "tenant.ts": `
        export const watcher = Bun.build({
          entrypoints: [import.meta.dir + "/index.ts"],
          outdir: import.meta.dir + "/out",
          watch: true,
        });
        export const first = watcher.next().then(({ value }) => value.success);
      `,
      "host.ts": `
        const graph = new Bun.ModuleGraph({});
        const tenant = await graph.import(import.meta.dir + "/tenant.ts");
        console.log("first build", await graph.run(() => tenant.first));
        graph.dispose();
        console.log("disposed");
      `,
    });
    await using proc = Bun.spawn({
      cmd: [bunExe(), "host.ts"],
      cwd: String(dir),
      env: bunEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    // The process ends by itself: nothing of the watcher keeps it alive.
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect(stderr).toBe("");
    expect(stdout).toBe("first build true\ndisposed\n");
    expect(exitCode).toBe(0);
  });
});
