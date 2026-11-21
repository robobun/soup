// Runs the vendored Web Platform Tests for `unhandledrejection`, `rejectionhandled` and
// `PromiseRejectionEvent` (html/webappapis/scripting/processing-model-2/unhandled-promise-rejections).
// The vendored files are byte-identical to upstream; every adaptation lives in the fixture,
// ../wpt-testharness-shim.ts and this driver, following the test/js/third_party/wpt-webstorage pattern.
//
// Vendored from web-platform-tests/wpt @ 9986bb32c9e97707eff870ab284ebc5cc7ae8d21
// (see UPSTREAM.md for the file list and exclusions).
//
// The thread that runs `bun test` keeps its unhandled rejections for the runner and does not
// dispatch the two events, so the files run in a child process
// (wpt-unhandled-promise-rejections-fixture.ts): once on its main thread and once in a Worker,
// as upstream runs them in a window and in a dedicated worker. Every subtest that does not pass
// is listed in expectations.json, keyed by "<file> :: <subtest name>". Everything else must
// pass, and a listed subtest that starts to pass fails the run, which is the signal to take it
// off the list.

import { expect, test } from "bun:test";
import { bunEnv, bunExe } from "harness";
import { join } from "node:path";
import expectations from "./expectations.json";

type Result = { file: string; name: string; error?: string };

const expectedFailures = expectations.failures as Record<string, string>;

// This MUST be updated on purpose whenever the vendored set changes. It pins how many subtests
// ran in each place, so that a file that stops evaluating turns the suite red and not shorter.
const EXPECTED_SUBTESTS = 44;

const results: Record<string, Result[]> = await (async () => {
  await using proc = Bun.spawn({
    cmd: [bunExe(), join(import.meta.dir, "wpt-unhandled-promise-rejections-fixture.ts")],
    env: bunEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  if (exitCode !== 0) throw new Error(`the fixture exited with code ${exitCode}:\n${stderr}`);
  return JSON.parse(stdout);
})();

test.each(["main thread", "worker"])("on the %s", where => {
  const subtests = results[where];
  const problems: string[] = [];
  for (const { file, name, error } of subtests) {
    const expected = expectedFailures[`${file} :: ${name}`];
    if (error !== undefined && expected === undefined) problems.push(`unexpected FAIL: ${file} :: ${name}: ${error}`);
    else if (error === undefined && expected !== undefined)
      problems.push(`listed in expectations.json but passed: ${file} :: ${name}`);
  }
  expect(problems).toEqual([]);
  expect(subtests.length).toBe(EXPECTED_SUBTESTS);
  // A key of expectations.json that names no subtest would rot without a word.
  const names = new Set(subtests.map(({ file, name }) => `${file} :: ${name}`));
  expect(Object.keys(expectedFailures).filter(key => !names.has(key))).toEqual([]);
});
