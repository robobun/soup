// Runs the vendored Web Platform Tests for Web Storage (webstorage/*.window.js) against
// `localStorage` and `sessionStorage`. The .window.js files are byte-identical to upstream;
// every adaptation lives in the fixture, ../wpt-testharness-shim.ts and this driver, following
// the test/js/third_party/wpt-streams pattern.
//
// Vendored from web-platform-tests/wpt @ 1d2c5fb36a6e477c8f915bde7eca027be6abe792
// (see UPSTREAM.md for the file list and exclusions).
//
// `localStorage` exists only in a process that was started with --localstorage-file, so the
// files run in one child process (wpt-webstorage-fixture.ts) and this file checks what it
// reports. Every subtest that does not pass is listed in expectations.json, keyed by
// "<file> :: <subtest name>". Everything else must pass, and a listed subtest that starts to
// pass fails the run, which is the signal to take it off the list.

import { expect, test } from "bun:test";
import { bunEnv, bunExe, tempDir } from "harness";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import expectations from "./expectations.json";

type Result = { file: string; name: string; error?: string };

const expectedFailures = expectations.failures as Record<string, string>;

// These MUST be updated on purpose whenever the vendored set changes. They pin how many files
// were found and how many subtests ran, so that a file that stops evaluating turns the suite
// red and not shorter.
const EXPECTED_FILES = 21;
const EXPECTED_SUBTESTS = 1238;

const files = readdirSync(join(import.meta.dir, "webstorage"))
  .filter(name => name.endsWith(".window.js"))
  .sort();

// The child runs before the tests are registered, so that no test waits for it: the two quota
// files fill ten megabytes one kilobyte at a time.
const results: Result[] = await (async () => {
  using dir = tempDir("wpt-webstorage", {});
  await using proc = Bun.spawn({
    cmd: [
      bunExe(),
      "--localstorage-file",
      join(String(dir), "wpt.localstorage"),
      join(import.meta.dir, "wpt-webstorage-fixture.ts"),
    ],
    env: bunEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  if (exitCode !== 0) throw new Error(`the fixture exited with code ${exitCode}:\n${stderr}`);
  return JSON.parse(stdout);
})();

for (const file of files) {
  test(file, () => {
    const subtests = results.filter(result => result.file === file);
    expect(subtests.length).toBeGreaterThan(0);
    const problems: string[] = [];
    for (const { name, error } of subtests) {
      const expected = expectedFailures[`${file} :: ${name}`];
      if (error !== undefined && expected === undefined) problems.push(`unexpected FAIL: ${name}: ${error}`);
      else if (error === undefined && expected !== undefined)
        problems.push(`listed in expectations.json but passed: ${name}`);
    }
    expect(problems).toEqual([]);
  });
}

test("the vendored set is what this file expects", () => {
  expect(files.length).toBe(EXPECTED_FILES);
  expect(results.length).toBe(EXPECTED_SUBTESTS);
  // A key of expectations.json that names no subtest would rot without a word.
  const names = new Set(results.map(({ file, name }) => `${file} :: ${name}`));
  expect(Object.keys(expectedFailures).filter(key => !names.has(key))).toEqual([]);
});
