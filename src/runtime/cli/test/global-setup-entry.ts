// The program behind `globalSetup` and `globalTeardown` of `bun test`. `bun test` runs it with
// `bun -e`, in a process of its own that lives for as long as the run (GlobalSetup.rs, next to
// this file, is the other end).
//
// fd 3, to `bun test`: one message when the setup is over and one when the teardown is. A message
// is a status byte, then records that each end with a NUL, then one more NUL.
//   "R" ("+NAME=value" | "-NAME")*   the setup is done, and this is what it did to process.env
//   "E"                              the setup failed
//   "D"                              the teardown is done
//   "F"                              the teardown failed
//   "U"                              the teardown is done, and while the tests ran an error was
//                                    not caught in this process
// fd 4, from `bun test`: one byte when the run is going to happen, which is when the setup starts.
// If the pipe ends without it (the type check of `bun test --check` failed), nothing is set up.
// After that nothing is written to it. `bun test` closes it when the run is over, and it closes by
// itself when that process dies, so the teardown runs either way.
import fs from "node:fs";
import path from "node:path";

// What this program needs of the runtime. They are bindings of its own, which `--define` and
// `--drop` of the run do not rewrite, and they are taken before a setup file can replace them.
const { Bun, Buffer, Object, Promise, Reflect, String, TypeError, console, process } = globalThis;
const writeSync = fs.writeSync;
const printError = console.error.bind(console);
const exit = process.exit.bind(process);

const files: { setup: string[]; teardown: string[] } = __GLOBAL_SETUP_FILES__;

const REPORT_FD = 3;
const CONTROL_FD = 4;

// A child that a setup starts with `process.execArgv` is not to be this program again.
const evalFlag = process.execArgv.indexOf("-e");
if (evalFlag !== -1) process.execArgv.splice(evalFlag, 2);

// Every variable with its value. Some of them are not enumerable: those that do something when
// they are assigned.
function readEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of Reflect.ownKeys(process.env)) {
    if (typeof name !== "string") continue;
    const value = process.env[name];
    if (value !== undefined) env[name] = String(value);
  }
  return env;
}

const envBefore = readEnv();
function envChanges(): string[] {
  const records: string[] = [];
  const env = readEnv();
  for (const name of Object.keys(env)) {
    if (envBefore[name] !== env[name] && !env[name].includes("\0")) records.push(`+${name}=${env[name]}`);
  }
  for (const name of Object.keys(envBefore)) {
    if (!(name in env)) records.push(`-${name}`);
  }
  return records;
}

let reports = 0;
function report(status: "R" | "E" | "D" | "F" | "U", records: string[] = []) {
  reports++;
  let message = Buffer.from(status + records.map(record => record + "\0").join("") + "\0");
  try {
    while (message.length > 0) message = message.subarray(writeSync(REPORT_FD, message));
  } catch (error) {
    // The test process is gone. The teardown still has to run.
    if ((error as NodeJS.ErrnoException)?.code !== "EPIPE") printError(error);
  }
}

// An error is an error of what this process was doing when it came: of the setup, of a
// teardown, or, while the tests run, of something that the setup left running (a server
// handler that rejects). Such an error does not end this process, which still owes the teardown.
let phase: "setup" | "tests" | "teardown" = "setup";
const failed = { setup: false, tests: false, teardown: false };
function fail(error: unknown) {
  failed[phase] = true;
  printError(error);
}
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);

const relative = (file: string) => path.relative(process.cwd(), file) || file;
const teardowns: (() => unknown)[] = [];

// The shapes of Vitest, with the names of `run({ globalSetupPath })` of `node:test` as well. A
// default export is the setup, and its teardown is the function that it returns. Without one,
// the setup and the teardown are the exports with these names, and a function that the setup
// returns is the teardown only when no teardown is exported.
async function runSetupFile(file: string) {
  const module = await import(file);
  const byDefault = typeof module.default === "function";
  const setup = byDefault ? module.default : (module.setup ?? module.globalSetup);
  let teardown = byDefault ? undefined : (module.teardown ?? module.globalTeardown);
  if (typeof setup !== "function" && typeof teardown !== "function") {
    throw new TypeError(
      `${relative(file)}: a global setup file exports a function as its default export, or functions named "setup" and "teardown" ("globalSetup" and "globalTeardown" are the same)`,
    );
  }
  if (typeof setup === "function") {
    const returned = await setup();
    if (typeof teardown !== "function" && typeof returned === "function") teardown = returned;
  }
  if (typeof teardown === "function") teardowns.push(teardown);
}

async function runTeardownFile(file: string) {
  const module = await import(file);
  const teardown = typeof module.default === "function" ? module.default : (module.teardown ?? module.globalTeardown);
  if (typeof teardown !== "function") {
    throw new TypeError(`${relative(file)}: a global teardown file exports a function as its default export`);
  }
  await teardown();
}

// The end of the run is the end of the control pipe, and nothing else. Until then the signals
// that stop a process are for `bun test`: Ctrl-C in a terminal goes to this process too, and
// what stops the test process may be sent to its children as well. When they end it, the pipe
// ends, and what is set up is torn down. During the teardown a signal ends this process, as it
// would end any other.
const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const ignoreSignal = () => {};
for (const signal of signals) process.on(signal, ignoreSignal);
const stop = Promise.withResolvers<void>();
let stopping = false;

const control = Bun.file(CONTROL_FD).stream().getReader();
// Without the pipe there is no run either.
if ((await control.read().catch(() => ({ done: true }))).done) exit(0);
(async () => {
  try {
    while (!(await control.read()).done);
  } catch {}
  stopping = true;
  for (const signal of signals) process.off(signal, ignoreSignal);
  stop.resolve();
})();

let ready = false;
try {
  let changes: string[] = [];
  for (const file of files.setup) {
    // The test process died in the middle of the setup: what is set up is torn down again.
    if (stopping) break;
    await runSetupFile(file);
  }
  if (!stopping && !failed.setup) {
    changes = envChanges();
    ready = true;
    report("R", changes);
  }
} catch (error) {
  fail(error);
}

if (ready) {
  phase = "tests";
  await stop.promise;
} else {
  report("E");
}
phase = "teardown";

// As in Jest, a teardown file is the other half of a setup that completed.
const owed = [...teardowns.reverse(), ...(ready ? files.teardown.map(file => () => runTeardownFile(file)) : [])];
const teardownStatus = () => (failed.teardown ? "F" : failed.tests ? "U" : "D");
// A teardown may end the process itself, as the last thing it does.
process.on("exit", code => {
  if (!ready || reports > 1) return;
  if (owed.length > 0) {
    failed.teardown = true;
    printError(`error: a global teardown ended the process, and ${owed.length} more did not run`);
  }
  report(code === 0 ? teardownStatus() : "F");
});
while (owed.length > 0) {
  const teardown = owed.shift()!;
  try {
    await teardown();
  } catch (error) {
    fail(error);
  }
}

if (ready) report(teardownStatus());
exit(failed.setup || failed.tests || failed.teardown ? 1 : 0);
