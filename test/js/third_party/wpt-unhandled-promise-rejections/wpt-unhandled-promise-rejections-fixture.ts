// Runs the vendored unhandled-promise-rejections files in this process and prints the outcome of
// each subtest as one JSON array: once on the main thread, and once more in a Worker that this
// file starts of itself. It is a process of its own because the thread that runs `bun test` does
// not dispatch `unhandledrejection` (see wpt-unhandled-promise-rejections.test.ts).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isMainThread, parentPort, Worker } from "node:worker_threads";
// For the assert_* globals, async_test() and promise_test().
import { setRegistrar, wptTest } from "../wpt-testharness-shim";

type Result = { file: string; name: string; error?: string };

const root = join(import.meta.dir, "unhandled-promise-rejections");
// In the order they run. The two .html files have one inline script each, which is what runs.
const files = [
  "promise-rejection-event-constructor.html",
  "promise-rejection-events-attached-in-event.html",
  "support/promise-rejection-events.js",
  "support/promise-rejection-events-many-promises.js",
];

const g = globalThis as any;
// The files reject promises that nobody handles, which is what they are about. A listener of
// `process` comes after the ones of the global object, and keeps the process alive.
process.on("unhandledRejection", () => {});
// testharness.js: these two tell a real harness how to report. The outcomes are collected below.
g.setup = () => {};
g.done = () => {};
// promise-rejection-events-attached-in-event.html says `window.onunhandledrejection`.
g.window = globalThis;

function scriptOf(file: string): string {
  const source = readFileSync(join(root, file), "utf8");
  if (!file.endsWith(".html")) return source;
  const scripts = [...source.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (scripts.length !== 1) throw new Error(`${file}: expected one inline script, found ${scripts.length}`);
  return scripts[0][1];
}

async function runFile(file: string): Promise<Result[]> {
  const results: Result[] = [];
  const pending: Promise<void>[] = [];
  // testharness.js runs one promise_test after the other, and everything else where it is declared.
  let lastPromiseTest = Promise.resolve();
  setRegistrar((name, run, kind) => {
    const outcome = (started: Promise<void>) =>
      started.then(
        () => void results.push({ file, name }),
        error => void results.push({ file, name, error: String(error?.message ?? error) }),
      );
    if (kind === "promise_test") {
      lastPromiseTest = lastPromiseTest.then(() => outcome(run()));
      pending.push(lastPromiseTest);
    } else {
      pending.push(outcome(run()));
    }
  });
  try {
    new Function("test", scriptOf(file))(wptTest);
  } catch (error) {
    results.push({ file, name: "harness: file failed to evaluate", error: String(error) });
  }
  // A promise_test is added to `pending` when the one before it ends.
  for (let i = 0; i < pending.length; i++) await pending[i];
  return results;
}

async function runAll(): Promise<Result[]> {
  const results: Result[] = [];
  for (const file of files) results.push(...(await runFile(file)));
  return results;
}

if (isMainThread) {
  const onMainThread = await runAll();
  const inWorker = await new Promise<Result[]>((resolve, reject) => {
    const worker = new Worker(import.meta.path);
    worker.on("message", resolve);
    worker.on("error", reject);
    worker.on("exit", code => reject(new Error(`the worker exited with code ${code} before it reported`)));
  });
  process.stdout.write(JSON.stringify({ "main thread": onMainThread, "worker": inWorker }));
  process.exit(0);
} else {
  parentPort!.postMessage(await runAll());
}
