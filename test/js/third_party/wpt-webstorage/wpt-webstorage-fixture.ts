// Runs every vendored webstorage/*.window.js file in this process and prints the outcome of
// each subtest as one JSON array. It is a process of its own because `localStorage` is only
// there when bun is started with --localstorage-file (see wpt-webstorage.test.ts).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
// For the assert_* globals. Its test() is asynchronous, which is what bun:test needs and not
// what these files need.
import "../wpt-testharness-shim";

type Result = { file: string; name: string; error?: string };

// The .window.js global.
(globalThis as any).window = globalThis;

const root = join(import.meta.dir, "webstorage");
const results: Result[] = [];
let file = "";

// What the files use of the Test of testharness.js.
class Test {
  cleanups: (() => void)[] = [];
  failure: string | undefined;
  constructor(public name: string) {}
  add_cleanup(cleanup: () => void) {
    this.cleanups.push(cleanup);
  }
  unreached_func(description: string) {
    return () => {
      this.failure ??= `assert_unreached: ${description}`;
      throw new Error(this.failure);
    };
  }
}

// test() of testharness.js: the body runs where test() is called, with the Test as `this` and
// as the argument, and its cleanups have run when test() returns. The files count on all of
// it. storage_setitem.window.js calls test() in a loop over a `var` that the bodies read,
// set.window.js reads `this.name` and undoes what it did to Storage.prototype in a cleanup,
// and storage_key.window.js calls test() from inside a test.
function test(body: (this: Test, t: Test) => void, name: string) {
  const t = new Test(name);
  const result: Result = { file, name };
  try {
    body.call(t, t);
  } catch (e: any) {
    result.error = String(e?.message ?? e);
  }
  for (const cleanup of t.cleanups) {
    try {
      cleanup();
    } catch (e: any) {
      result.error ??= `cleanup: ${String(e?.message ?? e)}`;
    }
  }
  if (t.failure !== undefined) result.error ??= t.failure;
  results.push(result);
}

for (file of readdirSync(root)
  .filter(name => name.endsWith(".window.js"))
  .sort()) {
  try {
    new Function("test", readFileSync(join(root, file), "utf8"))(test);
  } catch (e) {
    results.push({ file, name: "harness: file failed to evaluate", error: String(e) });
  }
}

process.stdout.write(JSON.stringify(results));
