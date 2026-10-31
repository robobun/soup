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
// fd 4, from `bun test`: one byte when the run is going to happen, which is when the setup starts.
// If the pipe ends without it (the type check of `bun test --check` failed), nothing is set up.
// After that nothing is written to it. `bun test` closes it when the run is over, and it closes by
// itself when that process dies, so the teardown runs either way.
import fs from "node:fs";
import path from "node:path";

const setupFiles: string[] = __GLOBAL_SETUP_FILES__;
const teardownFiles: string[] = __GLOBAL_TEARDOWN_FILES__;

const REPORT_FD = 3;
const CONTROL_FD = 4;

const envBefore = { ...process.env };
const teardowns: (() => unknown)[] = [];
let failed = false;

function report(status: "R" | "E" | "D" | "F", records: string[] = []) {
  let message = Buffer.from(status + records.map(record => record + "\0").join("") + "\0");
  try {
    while (message.length > 0) message = message.subarray(fs.writeSync(REPORT_FD, message));
  } catch {
    // The test process is gone. The teardown still has to run.
  }
}

function fail(error: unknown) {
  failed = true;
  console.error(error);
}

function envChanges(): string[] {
  const records: string[] = [];
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && envBefore[name] !== value && !value.includes("\0")) records.push(`+${name}=${value}`);
  }
  for (const name of Object.keys(envBefore)) {
    if (!(name in process.env)) records.push(`-${name}`);
  }
  return records;
}

const relative = (file: string) => path.relative(process.cwd(), file) || file;

// The names of Vitest, and those of `run({ globalSetupPath })` in `node:test`.
async function runSetupFile(file: string) {
  const module = await import(file);
  const setup = typeof module.default === "function" ? module.default : (module.setup ?? module.globalSetup);
  let teardown = module.teardown ?? module.globalTeardown;
  if (typeof setup !== "function" && typeof teardown !== "function") {
    throw new TypeError(
      `${relative(file)}: a global setup file exports a function as its default export, or functions named "setup" and "teardown"`,
    );
  }
  if (typeof setup === "function") {
    const returned = await setup();
    if (typeof returned === "function") teardown = returned;
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

// The end of the run: the control pipe reached its end, or a signal asked this process to stop.
const stop = Promise.withResolvers<void>();
let stopping = false;
function requestStop() {
  stopping = true;
  stop.resolve();
}
const control = Bun.file(CONTROL_FD).stream().getReader();
if ((await control.read()).done) process.exit(0);
(async () => {
  try {
    while (!(await control.read()).done);
  } catch {}
  requestStop();
})();

let ready = false;
try {
  for (const file of setupFiles) {
    // The test process died in the middle of the setup: what is set up is torn down again.
    if (stopping) break;
    await runSetupFile(file);
  }
  ready = !stopping;
} catch (error) {
  fail(error);
}

if (ready) {
  report("R", envChanges());
  // Ctrl-C in a terminal goes to this process too, and what stops the test process may be sent
  // to its children as well. While the tests run, a signal starts the teardown. During the
  // teardown it ends the process, as it would end any other.
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of signals) process.on(signal, requestStop);
  // An error that nobody catches while the tests run (a server handler that rejects) fails the run
  // when it is over. It does not end this process, which still owes the teardown.
  process.on("uncaughtException", fail);
  process.on("unhandledRejection", fail);
  await stop.promise;
  for (const signal of signals) process.off(signal, requestStop);
} else {
  report("E");
}

for (const teardown of teardowns.reverse()) {
  try {
    await teardown();
  } catch (error) {
    fail(error);
  }
}
// As in Jest, a teardown file is the other half of a setup that completed.
if (ready) {
  for (const file of teardownFiles) {
    try {
      await runTeardownFile(file);
    } catch (error) {
      fail(error);
    }
  }
}

if (ready) report(failed ? "F" : "D");
process.exit(failed ? 1 : 0);
