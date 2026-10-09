// Watch mode of Bun.build: `Bun.build({ watch: true })` returns a BuildWatcher.
//
// A rebuild is a whole Bun.build() of the same options. What starts one is a change to a file
// the last build read: the bundle thread hands back the paths of its input files with every
// result, also with a failed one. Their directories are watched with fs.watch, one watcher for
// each directory, and an event counts when it names one of those files. Watching the directory
// and not the file is what survives an editor that saves by renaming a new file over the old
// one, and a file that is deleted and made again.
//
// A build that failed also depends on what does not exist yet: the file of an import that did
// not resolve, an entry point that is missing. For those the nearest directory that exists is
// watched for the one name that is the missing thing, or the next step on the way to it.
//
// Two things can happen between the moment a build reads a directory and the moment that
// directory is watched: a file the build read changes, or a file it missed appears. Both are
// looked for when a build has ended, and when one is found the next build starts at once. That
// build does not look again, so a build that fails the same way twice is not made a third time.

import type { BuildConfig, BuildOutput } from "bun";
import type { FSWatcher } from "node:fs";

// Not "node:fs", and the functions of "node:path" as they are now: what a program does to those
// modules later is not meant for this one.
const fs = require("internal/fs/binding");
const { watch } = require("internal/fs/watch");
const { basename, dirname, isAbsolute, join, resolve, sep } = require("node:path");

// Bun.build() for a watcher. A failed build resolves with `success: false`, and by the time the
// promise settles `inputs` has the files on disk that the build read, apart from those in
// node_modules.
const build: (options: BuildConfig, inputs: string[]) => Promise<BuildOutput> = $newRustFunction(
  "JSBundler.rs",
  "jsBuildForWatch",
  2,
);

/** How long to wait after a change for more of them, in milliseconds. */
const DELAY = 50;

const { setTimeout, clearTimeout } = globalThis;
const ArrayPrototypeSlice = Array.prototype.slice;
const DateNow = Date.now;
const ObjectGetOwnPropertyNames = Object.getOwnPropertyNames;
const ObjectGetPrototypeOf = Object.getPrototypeOf;
const ObjectKeys = Object.keys;
const ObjectPrototype = Object.prototype;
const PromiseWithResolvers = Promise.withResolvers.bind(Promise);
const SymbolAsyncDispose = Symbol.asyncDispose;
const SymbolAsyncIterator = Symbol.asyncIterator;

// The name in an event is the one on disk. Where the file system ignores case (and, on macOS,
// how an accented letter is composed), the import that found the file may have spelled it
// another way.
const foldCase: (name: string) => string =
  process.platform === "darwin"
    ? name => name.normalize("NFC").toLowerCase()
    : process.platform === "win32"
      ? name => name.toLowerCase()
      : name => name;

const nodeModules = `${sep}node_modules${sep}`;

interface Directory {
  watcher: FSWatcher;
  /** The names of the build's input files in this directory. */
  files: Set<string>;
  /** After a failed build: the names under which what is missing would appear here. */
  missing: string[];
  /** What `watcher` watches. Another inode at the same path is another directory. */
  ino: bigint;
  /** ext4 gives a new directory the inode number of one that was just removed. */
  birthtime: bigint;
}

interface Wanted {
  files: Set<string>;
  missing: string[];
}

interface WatcherState {
  /** The names of the files that start a rebuild, by the directory they are in. */
  watched: Record<string, string[]>;
  /** After a failed build: the names that start a rebuild when they appear, by directory. */
  missing: Record<string, string[]>;
  /** The builds that were started. */
  builds: number;
  /** A build is running, or one is about to start. */
  pending: boolean;
  /** The file named by the last event of a watched directory. */
  lastEvent: string | null | undefined;
}

/** `undefined` for what is not there, and for what cannot be looked at (a loop of links, no permission). */
function statOf(file: string) {
  try {
    return fs.statSync(file, { bigint: true, throwIfNoEntry: false }) as import("node:fs").BigIntStats | undefined;
  } catch {
    return undefined;
  }
}

function isSameDirectory(dir: string, directory: Directory): boolean {
  const stat = statOf(dir);
  return stat !== undefined && stat.ino === directory.ino && stat.birthtimeNs === directory.birthtime;
}

/**
 * Whether `file` may have changed at `time` or later, and `gone` when it is not there. The
 * change time counts as well as the modification time: a file that is renamed into place keeps
 * the latter. The clock a kernel stamps a file with can be a tick behind, and a file system that
 * keeps whole seconds (or every other one) rounds down, so a change that came later can carry a
 * time a little earlier.
 */
function changedSince(file: string, time: number, gone: boolean): boolean {
  const stat = statOf(file);
  if (stat === undefined) return gone;
  const mtime = Number(stat.mtimeMs);
  const ctime = Number(stat.ctimeMs);
  const changed = mtime > ctime ? mtime : ctime;
  return changed >= time - (changed % 1000 === 0 ? 2000 : 10);
}

/** Whether `name` is `wanted`, or `wanted` with an extension. */
function isNamed(name: string, wanted: string): boolean {
  return (
    name === wanted || (name.length > wanted.length && name.charCodeAt(wanted.length) === 46 && name.startsWith(wanted))
  );
}

/** Whether `dir` has an entry that is `wanted`, or `wanted` with an extension. */
function hasNamed(dir: string, wanted: string): boolean {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return false;
  }
  for (const entry of entries) if (isNamed(foldCase(entry), wanted)) return true;
  return false;
}

function isPathSpecifier(specifier: unknown): specifier is string {
  return (
    typeof specifier === "string" &&
    (specifier.startsWith("./") || specifier.startsWith("../") || isAbsolute(specifier))
  );
}

/** A copy of an array or of a plain object, and anything else as it is. */
function copyOption(value: unknown): unknown {
  if ($isJSArray(value)) return ArrayPrototypeSlice.$call(value);
  if ($isObject(value)) {
    const prototype = ObjectGetPrototypeOf(value);
    if (prototype === ObjectPrototype || prototype === null) return { ...(value as object) };
  }
  return value;
}

/**
 * The options of `config` as Bun.build() would read them now: its own and those it inherits.
 * Arrays and plain objects are copied, so that what the program does to them later is no part
 * of a rebuild.
 */
function readOptions(config: object): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  for (let object = config; object != null && object !== ObjectPrototype; object = ObjectGetPrototypeOf(object)) {
    for (const name of ObjectGetOwnPropertyNames(object)) {
      // `watch` has been read, and the builds of a watcher do not look at it.
      if (name !== "watch" && !(name in options)) options[name] = copyOption((config as Record<string, unknown>)[name]);
    }
  }
  return options;
}

/** The options for one build. What the `setup()` of a plugin does to them stays in that build. */
function copyOptions(options: Record<string, unknown>): BuildConfig {
  const copy: Record<string, unknown> = {};
  for (const name of ObjectKeys(options)) copy[name] = copyOption(options[name]);
  return copy as unknown as BuildConfig;
}

/** What a build that threw, or whose promise rejected, is to a watcher: a build that failed. */
function failure(error: unknown): BuildOutput {
  return { outputs: [], success: false, logs: [error as BuildMessage] };
}

let stateOf: (watcher: BuildWatcher, listener?: (state: WatcherState) => void) => WatcherState;

class BuildWatcher {
  #options: Record<string, unknown>;
  #directories = new Map<string, Directory>();
  /** The files the last build read. A build that did not get to read any leaves them as they are. */
  #inputs: string[] = [];
  /** What the last successful build wrote. A file is not both written and watched. */
  #outputs = new Set<string>();
  #building = false;
  /** A file changed while a build was running, so its result is already out of date. */
  #dirty = false;
  /** The build that is running was started by what was found after the one before it. */
  #catchingUp = false;
  #stopped = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** The newest result that no next() has taken. */
  #latest: BuildOutput | undefined;
  #waiting: Array<PromiseWithResolvers<IteratorResult<BuildOutput>>> = [];
  /** What ended the watcher, until a next() has reported it. */
  #error: { value: unknown } | undefined;
  /** Settles when the build that is running has ended. */
  #running: Promise<void> | undefined;
  /** Whether next() was ever called. Until then nobody hears of a failed build. */
  #observed = false;
  /** For `bun:internal-for-testing`. */
  #lastEvent: string | null | undefined;
  #builds = 0;
  #listener: ((state: WatcherState) => void) | undefined;

  constructor(config: BuildConfig) {
    this.#options = readOptions(config);
    this.#start();
  }

  /** Starts a build. Throws what Bun.build() throws before there is a build. */
  #start() {
    const startedAt = DateNow();
    const inputs: string[] = [];
    const ended = PromiseWithResolvers<void>();
    // Before the call and not after it: the `setup()` of a plugin can be async, and Bun.build()
    // runs the event loop until it has settled. A change, a timer or a stop() that comes in from
    // there has to find a build running.
    this.#building = true;
    this.#dirty = false;
    this.#running = ended.promise;
    this.#builds++;
    let pending: Promise<BuildOutput>;
    try {
      pending = build(copyOptions(this.#options), inputs);
    } catch (error) {
      this.#building = false;
      ended.resolve();
      throw error;
    }
    pending.$then(
      output => this.#ended(output, inputs, startedAt, ended),
      error => this.#ended(failure(error), inputs, startedAt, ended),
    );
  }

  /** A rebuild. One that cannot start is a build that failed, and the next change tries again. */
  #rebuild() {
    const startedAt = DateNow();
    try {
      this.#start();
    } catch (error) {
      this.#ended(failure(error), [], startedAt, undefined);
    }
  }

  #ended(output: BuildOutput, inputs: string[], startedAt: number, ended: PromiseWithResolvers<void> | undefined) {
    this.#building = false;
    const look = !this.#catchingUp;
    this.#catchingUp = false;
    try {
      if (this.#stopped) return;
      if (inputs.length > 0 || output.success) this.#inputs = inputs;

      const found = this.#watch(output, startedAt, look);
      this.#deliver(output);

      if (this.#dirty) {
        this.#rebuild();
      } else if (found) {
        this.#catchingUp = true;
        this.#rebuild();
      } else if (this.#directories.size === 0) {
        // Nothing that can change went into this build, so there will be no other.
        this.#close();
        this.#finished();
      }
    } catch (error) {
      this.#fail(error);
    } finally {
      ended?.resolve();
    }
  }

  /**
   * Watch what `output` was made from, and nothing else. With `look`, returns whether something
   * that this build read or missed has changed since, without the watcher having been told.
   */
  #watch(output: BuildOutput, startedAt: number, look: boolean): boolean {
    const failed = !output.success;
    if (!failed) {
      const written = (this.#outputs = new Set<string>());
      // Without an `outdir` nothing is written, and the path of an artifact is not a file's.
      for (const { path } of output.outputs) {
        if (!isAbsolute(path)) continue;
        written.add(path);
        // An input is named by the path that is left when every link in it is followed.
        try {
          written.add(fs.realpathNativeSync(path));
        } catch {}
      }
    }
    const outputs = this.#outputs;

    const wanted = new Map<string, Wanted>();
    const want = (dir: string): Wanted => {
      let entry = wanted.get(dir);
      if (entry === undefined) wanted.set(dir, (entry = { files: new Set(), missing: [] }));
      return entry;
    };
    for (const input of this.#inputs) {
      if (!outputs.has(input)) want(dirname(input)).files.add(foldCase(basename(input)));
    }

    let found = false;
    if (failed) {
      // What is missing appears in the nearest directory that exists, as the next part of its path.
      const missing = (file: string) => {
        if (file.includes(nodeModules)) return;
        let name = basename(file);
        let dir = dirname(file);
        let last = true;
        while (statOf(dir)?.isDirectory() !== true) {
          const parent = dirname(dir);
          if (parent === dir) return;
          name = basename(dir);
          dir = parent;
          last = false;
        }
        name = foldCase(name);
        want(dir).missing.push(name);
        if (!last) return;
        // `./value` is `./value.ts`, and it is `./value/index.ts`.
        const index = statOf(file)?.isDirectory() === true;
        if (index) want(file).missing.push("index");
        // Is it there after all? Then it came while the build was running.
        if (look && !found) found = index ? hasNamed(file, "index") : hasNamed(dir, name);
      };

      const { entrypoints } = this.#options;
      if ($isJSArray(entrypoints)) {
        for (const entrypoint of entrypoints) {
          if (typeof entrypoint !== "string") continue;
          const file = resolve(entrypoint);
          if (statOf(file) === undefined) missing(file);
          // There now, but the build may have looked before it was.
          else if (look && !found) found = changedSince(file, startedAt, false);
        }
      }
      for (const log of output.logs) {
        const specifier = (log as { specifier?: unknown } | undefined)?.specifier;
        const importer = log?.position?.file;
        if (isPathSpecifier(specifier) && typeof importer === "string" && isAbsolute(importer)) {
          missing(resolve(dirname(importer), specifier));
        }
      }
    }

    // The files that were not watched while this build read them.
    const unwatched: string[] = [];

    const directories = this.#directories;
    for (const [dir, directory] of directories) {
      const entry = wanted.get(dir);
      if (entry !== undefined && isSameDirectory(dir, directory)) {
        for (const name of entry.files) if (!directory.files.has(name)) unwatched.push(join(dir, name));
        directory.files = entry.files;
        directory.missing = entry.missing;
        wanted.delete(dir);
      } else {
        directory.watcher.close();
        directories.delete(dir);
      }
    }

    for (const [dir, { files, missing }] of wanted) {
      for (const name of files) unwatched.push(join(dir, name));
      const stat = statOf(dir);
      // Not there (any more). What was in it is found to be gone below.
      if (stat?.isDirectory() !== true) continue;
      const directory: Directory = { watcher: undefined!, files, missing, ino: stat.ino, birthtime: stat.birthtimeNs };
      try {
        directory.watcher = watch(dir, undefined, (_event: string, filename: string | null) => {
          this.#onEvent(dir, directory, filename);
        });
      } catch (error) {
        const code = (error as { code?: unknown } | undefined)?.code;
        if (code === "ENOENT" || code === "ENOTDIR") continue;
        throw error;
      }
      directory.watcher.on("error", (error: unknown) => this.#onWatcherError(dir, directory, error));
      directories.set(dir, directory);
    }

    if (look && !found) {
      // A file that is gone makes a build that succeeded out of date. One that failed stays failed.
      for (const file of unwatched) {
        if (changedSince(file, startedAt, !failed)) {
          found = true;
          break;
        }
      }
    }
    return found;
  }

  #onEvent(dir: string, directory: Directory, filename: string | null) {
    this.#lastEvent = filename;
    if (this.#counts(dir, directory, filename)) this.#changed();
    this.#listener?.(stateOf(this));
  }

  #counts(dir: string, directory: Directory, filename: string | null): boolean {
    if (this.#stopped || this.#directories.get(dir) !== directory) return false;
    if (filename == null) return true;
    // Its own name: the directory was removed or moved, or only touched. (Or it is about a file
    // of that name in it.) Removed or moved, this watcher has heard its last event, and the
    // next build watches what is at the path then.
    if (filename === basename(dir) && !isSameDirectory(dir, directory)) {
      directory.watcher.close();
      this.#directories.delete(dir);
      return true;
    }
    const name = foldCase(filename);
    if (directory.files.has(name)) return true;
    for (const missing of directory.missing) if (isNamed(name, missing)) return true;
    return false;
  }

  #onWatcherError(dir: string, directory: Directory, error: unknown) {
    if (this.#stopped || this.#directories.get(dir) !== directory) return;
    if (isSameDirectory(dir, directory)) return this.#fail(error);
    // A directory that was removed or replaced is a change like any other.
    directory.watcher.close();
    this.#directories.delete(dir);
    this.#changed();
  }

  #changed() {
    if (this.#stopped) return;
    if (this.#building) {
      this.#dirty = true;
      return;
    }
    // One save is several events, and a checkout is many files. Wait until they stop.
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      if (!this.#stopped && !this.#building) this.#rebuild();
    }, DELAY);
  }

  #deliver(output: BuildOutput) {
    const waiter = this.#waiting.shift();
    if (waiter !== undefined) {
      waiter.resolve({ value: output, done: false });
      return;
    }
    this.#latest = output;
    // Bun.build() rejects when the build fails. Nothing has asked for a result here, so say it.
    if (!output.success && !this.#observed) this.#print(new AggregateError(output.logs, "Bundle failed"));
  }

  #print(error: unknown) {
    try {
      console.error(error);
    } catch {}
  }

  /** The watcher cannot go on: stop, and tell one next(). */
  #fail(error: unknown) {
    if (this.#stopped) return;
    this.#close();
    const waiter = this.#waiting.shift();
    if (waiter !== undefined) {
      waiter.reject(error);
    } else {
      // Nothing is waiting to be told, and nothing may ever ask.
      this.#error = { value: error };
      this.#print(error);
    }
    this.#finished();
  }

  /** Stop watching. */
  #close() {
    this.#stopped = true;
    this.#dirty = false;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    for (const { watcher } of this.#directories.values()) watcher.close();
    this.#directories.clear();
  }

  /** There will be no other result: every next() that is waiting is done. */
  #finished() {
    const waiting = this.#waiting;
    this.#waiting = [];
    for (const { resolve } of waiting) resolve({ value: undefined, done: true });
  }

  next(): Promise<IteratorResult<BuildOutput>> {
    this.#observed = true;
    const latest = this.#latest;
    if (latest !== undefined) {
      this.#latest = undefined;
      return Promise.$resolve({ value: latest, done: false });
    }
    const error = this.#error;
    if (error !== undefined) {
      this.#error = undefined;
      return Promise.$reject(error.value);
    }
    if (this.#stopped) return Promise.$resolve({ value: undefined, done: true });
    const waiter = PromiseWithResolvers<IteratorResult<BuildOutput>>();
    this.#waiting.push(waiter);
    return waiter.promise;
  }

  async return(): Promise<IteratorResult<BuildOutput>> {
    await this.stop();
    return { value: undefined, done: true };
  }

  async stop(): Promise<void> {
    this.#close();
    this.#latest = undefined;
    this.#error = undefined;
    // A build cannot be cancelled. Its result is dropped, but it still writes its files, and a
    // loop that is waiting for it ends when it has.
    await this.#running;
    this.#finished();
  }

  [SymbolAsyncIterator]() {
    return this;
  }

  [SymbolAsyncDispose]() {
    return this.stop();
  }

  static {
    stateOf = (watcher, listener) => {
      if (listener !== undefined) watcher.#listener = listener;
      const watched: Record<string, string[]> = {};
      const missing: Record<string, string[]> = {};
      for (const [dir, directory] of watcher.#directories) {
        watched[dir] = [...directory.files].sort();
        if (directory.missing.length > 0) missing[dir] = [...directory.missing].sort();
      }
      return {
        watched,
        missing,
        builds: watcher.#builds,
        pending: watcher.#building || watcher.#timer !== undefined,
        lastEvent: watcher.#lastEvent,
      };
    };
  }
}

export default {
  /** `Bun.build(config)` with `watch: true`. */
  watch: (config: BuildConfig) => new BuildWatcher(config),
  /**
   * For `bun:internal-for-testing`: what `watcher` watches and what it has made of the events so
   * far. With `listener`, that is also called with the state after every event from then on.
   */
  state: (watcher: unknown, listener?: (state: WatcherState) => void) => stateOf(watcher as BuildWatcher, listener),
};
