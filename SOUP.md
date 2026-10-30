# soup

soup is a fork of [bun](https://github.com/oven-sh/bun) that gets one new feature every day.

Every feature is a single commit on top of upstream `main`. The stack is rebased onto upstream
once a day, so with `upstream` pointing at oven-sh/bun:

```sh
git log --oneline upstream/main..main   # everything soup adds, one commit per feature
git diff upstream/main...main           # the whole delta
git cherry-pick <sha>                   # take one feature
```

Rules of the house:

- One feature per day, shipped with an implementation, a test, types, and docs.
- Each feature is written the way a bun PR would be, so it can be cherry-picked as is.
- Nothing here is published anywhere. Upstreaming is bun's call.
- A feature that lands upstream, or that stops being worth carrying, is dropped from the stack
  and listed under [Dropped](#dropped).

## Features

### 2026-08-15: `Bun.semver.parse()`

`Bun.semver` could compare versions (`order`) and match them against ranges (`satisfies`), but
there was no way to get at the pieces of a version without a regex. `parse()` returns the
components, or `null` when the input is not a complete `major.minor.patch` version, so it doubles
as a validity check.

```ts
Bun.semver.parse("v1.2.3-beta.1+build.5");
// { major: 1, minor: 2, patch: 3, prerelease: ["beta", 1], build: ["build", "5"], version: "1.2.3-beta.1" }

Bun.semver.parse("^1.2.3"); // null
Bun.semver.parse(pkg.version) !== null; // valid?
```

It reuses the parser behind `order`/`satisfies`/`bun install`, so the three agree on what a
version is. The result shape follows node-semver's `SemVer` (numeric prerelease identifiers are
numbers, `version` leaves out build metadata) to make switching easy.

Files: `src/semver_jsc/SemverObject.rs`, `src/semver/Version.rs` (exposes the consumed length),
`packages/bun-types/bun.d.ts`, `docs/runtime/semver.mdx`, `test/cli/install/semver.test.ts`,
`test/integration/bun-types/fixture/bun.ts`.

### 2026-08-15: `wc` shell builtin

The first example in the Bun Shell docs pipes into `wc`, but `wc` was not a builtin, so the
example (and every `| wc -l` in a script) only worked where coreutils happened to be installed,
which on Windows is usually nowhere. `wc` is now a builtin on every platform: `-l`, `-w`, `-c` and
`-m` (UTF-8 characters), in any combination, reading stdin or any number of files, with a `total`
line for more than one file. An unreadable operand is reported on stderr, sets the exit code to 1
and does not stop the others from being counted, like wc(1).

```ts
await $`cat access.log | wc -l`.text(); // "1042\n"
await $`wc -l src/*.ts`.text();
//  12 src/a.ts
// 240 src/b.ts
// 252 total
```

Columns are padded to the widest count being printed, so a single count is a bare number and
multi-file output lines up; GNU and BSD wc pad to different fixed widths here, and scripts split on
whitespace anyway. `-L` is rejected as unsupported rather than silently ignored.

Reading files needed one fix underneath: the shell's `IOReader` always registered its fd with
epoll/kqueue, which fails with `EPERM` for regular files and `/dev/null`. Non-pollable fds are now
read on the next event-loop turn through `bun_io`'s existing unpolled read loop, so the builtin sees
the same chunk/EOF callbacks either way. This also makes the (experimental on POSIX) builtin `cat`
work on `cat file`, `cat < file` and a `/dev/null` stdin.

Files: `src/runtime/shell/builtin/wc.rs`, `src/runtime/shell/Builtin.rs`, `src/runtime/shell/mod.rs`,
`src/runtime/shell/IOReader.rs`, `src/runtime/shell/interpreter.rs` (exposes `is_pollable`),
`docs/runtime/shell.mdx`, `test/js/bun/shell/commands/wc.test.ts`, `test/js/bun/shell/exec.test.ts`.

### 2026-08-17: `bun test --dry-run`

There was no way to ask `bun test` what it was about to run. Checking a `-t` pattern, a
`--changed` or `--shard` selection, or what a leftover `.only` still covers meant running the suite
and reading the results. `--dry-run` loads the test files exactly like a real run and prints every
test with the result it would get without executing anything: tests that would run are `pending`
(`…`, or `(pending)` without colors), skip/todo tests keep their markers, and tests dropped by `-t`
or `.only` are left out, as usual. No test callback or hook runs, including hooks from `--preload`
scripts. The summary says `Found N tests across M files`; the exit code is 0 unless no files are
found, a file fails to load or the `-t` pattern matches nothing, which a real run would fail on as
well.

```sh
bun test --dry-run -t "math"
# math.test.ts:
# (pending) math > adds
# (skip) math > subtracts
# (todo) math > multiplies
#
#  1 pending
#  1 skip
#  1 todo
# Found 3 tests across 1 file. [12.00ms]
```

The runner already had a `Pending` result that the reporter knew how to print but that never
reached it, because every sequence gets a real result before it is reported. The dry run hooks in
at the collection-to-execution hand-off: instead of building the execution order it walks the
collected describe tree with the same pruning rules and hands each test to the reporter with
`Pending`, or with the skip/todo/filtered-out result that execution would have assigned to it
without running it. Because it goes through the normal reporter, `--dots`, `--only-failures`,
`--reporter=junit` (pending tests become `<skipped message="dry run" />`, so a dry run doubles as
a test inventory export) and the `-t ... matched 0 tests` error all work unchanged. Coverage,
`--rerun-each`, `--update-timings` and `--parallel` are switched off under `--dry-run`, since
nothing executes; the header reads `bun test vX.Y.Z DRY RUN` so the output cannot be mistaken for
a passing run.

Files: `src/runtime/test_runner/bun_test.rs` (dry-run walk), `src/runtime/test_runner/jest.rs`
(`Summary.pending`), `src/runtime/cli/test_command.rs` (summary, header, junit, flag interactions),
`src/runtime/cli/Arguments.rs`, `src/options_types/context.rs`, `completions/bun.zsh`,
`docs/test/discovery.mdx`, `docs/snippets/cli/test.mdx`, `test/cli/test/bun-test.test.ts`.

### 2026-08-18: `.lines()` on `ReadableStream` and `Blob`

Reading something line by line is the most common thing a script does with a file, a subprocess or
stdin, and bun had no direct way to do it: `ReadableStream` has `.text()`, `.json()`, `.bytes()` and
`.blob()`, which all read everything at once, and splitting chunks into lines by hand means
handling a line or a UTF-8 sequence cut in half by a chunk boundary. `Bun.file(path).lines()` is
also an API people already assume exists (oven-sh/bun#6692 is a report that it does not). `lines()`
now exists on `ReadableStream` and on `Blob`, so it works on `Bun.file()`, `Bun.stdin`, S3 files,
`response.body`, `proc.stdout` and in-memory blobs alike. It returns an async iterator of strings:
the stream is decoded as UTF-8 (string chunks are taken as they are), a line ends at `\n`, a `\r`
before it is dropped, the line ending is not part of the line, text after the last newline is the
final line and a trailing newline does not produce an empty extra line.

```ts
for await (const line of Bun.file("access.log").lines()) {
  if (line.includes(" 500 ")) console.log(line);
}

for await (const line of (await fetch(url)).body!.lines()) {
  handle(JSON.parse(line)); // NDJSON
}

await Array.fromAsync(Bun.stdin.lines());
```

`stream.lines()` is `for await (const chunk of stream)` plus line splitting, and keeps its
semantics: calling it locks the stream immediately, leaving the loop early cancels the stream (so a
file is closed), and an error from the source (such as `ENOENT`) surfaces where `stream.values()`
would surface it. `blob.lines()` is `blob.stream().lines()`, so a file is read incrementally and a
`slice()` is honoured. Both are small JS builtins attached to the native prototypes, the same way
`Glob.prototype.scan` is; a line that spans chunks is collected in an array and joined once, so a
huge line does not get re-copied per chunk. `.name` of the new functions is empty, which is a
pre-existing property of every builtin-backed method in bun (`Buffer.prototype.readInt8.name` is
empty too) and was reported separately.

Files: `src/js/builtins/ReadableStream.ts`, `src/js/builtins/Blob.ts`,
`src/jsc/bindings/webcore/streams/JSReadableStream.cpp`, `src/runtime/webcore/Blob.bind.ts`,
`packages/bun-types/overrides.d.ts`, `packages/bun-types/globals.d.ts`, `docs/runtime/streams.mdx`,
`docs/runtime/file-io.mdx`, `test/js/web/streams/streams.test.js`, `test/js/web/fetch/blob.test.ts`,
`test/js/bun/util/bun-file-read.test.ts`, `test/integration/bun-types/fixture/streams.ts`,
`test/integration/bun-types/bun-types.test.ts` (the global `ReadableStream` under `lib.dom` lacks the
bun methods, `lines` included, which that test records).

### 2026-08-19: `Bun.INI.parse()`

Bun ships parsers for JSON5, JSONC, TOML, YAML, XML and markdown as `Bun.*` objects, and it has had
an INI parser for years, because `bun install` reads `.npmrc` with it, but there was no way to call
that parser from JavaScript. INI is still what `.npmrc`, `.gitconfig`, `php.ini`, systemd units and
a lot of application config files are written in, so scripts end up pulling in the npm `ini` package
for a format bun can already read. `Bun.INI.parse()` (also `import { INI } from "bun"`) now exposes
it. It takes a string, UTF-8 bytes or a `Blob` like `Bun.TOML.parse()` and returns a plain object.

```ts
Bun.INI.parse(`
name = my-app
debug

[database]
host = localhost
port = 5432

[database.replicas]
host[] = db-1
host[] = db-2
`);
// { name: "my-app", debug: true,
//   database: { host: "localhost", port: "5432", replicas: { host: ["db-1", "db-2"] } } }
```

The dialect is the npm `ini` package's, which the existing parser already implements (its test
fixture is npm/ini's), so `Bun.INI.parse` is a drop-in for `ini.parse`: `;`/`#` comments, a bare key
is `true`, `true`/`false`/`null` convert and everything else unquoted is a string, a quoted value is
read as JSON, `key[]` builds arrays, `[a.b]` nests and `[a\.b]` does not, `__proto__` keys are
dropped. Two things differ from the `.npmrc` use of the parser: `${VAR}` is left as written instead
of being expanded from the environment (an npm config feature that has no business in a general
parser, and a surprise in any file that contains a literal `$`), which is done by making the parser's
environment optional, and a leading UTF-8 BOM is skipped, as `Bun.TOML.parse` and `Bun.YAML.parse`
do. The parser has no syntax errors, so the function only throws when given `undefined`/`null`. The
types give it a closed value type (`INI.Value`, `INI.Section`) in the style of `Bun.XML`, rather than
`object`. `stringify` is left for another day.

Files: `src/runtime/api/INIObject.rs`, `src/runtime/api/INIObject.bind.ts`, `src/runtime/api.rs`,
`src/runtime/Cargo.toml`, `Cargo.lock`, `src/ini/lib.rs` (optional env, BOM),
`src/install_jsc/ini_jsc.rs`, `src/jsc/bindings/BunObject.cpp`, `packages/bun-types/bun.d.ts`,
`docs/runtime/ini.mdx`, `docs/docs.json`, `docs/runtime/bun-apis.mdx`, `test/js/bun/ini/ini.test.ts`,
`test/integration/bun-types/fixture/ini.ts`.

### 2026-08-20: the rest of the common `[[ ... ]]` tests

The shell's `[[ ... ]]` knew seven tests: `-f`, `-d`, `-c`, `-z`, `-n`, `==` and `!=`. Everything else
that bash scripts reach for was a parse error ("Conditional expression operation: -e, is not
supported right now"), which is the first thing a script ported to `$` trips over: `[[ -e $f ]]`,
`[[ $COUNT -gt 0 ]]`, `[[ $a = $b ]]`, `[[ out.js -nt in.ts ]]`. The parser already had the whole
operator table and the interpreter already did its `stat` on the thread pool, so this adds the
missing evaluations rather than new machinery:

- file tests `-e`, `-s`, `-b`, `-p`, `-S`, and `-L`/`-h`, which `lstat` so a dangling link still counts;
- `-nt`, `-ot` and `-ef` on two files, comparing mtimes to the nanosecond, with bash's answers when one
  side is missing (`a -nt missing` holds, `missing -nt a` does not);
- integer comparisons `-eq`, `-ne`, `-lt`, `-le`, `-gt`, `-ge` on 64-bit decimal integers. As in bash's
  `[[ ]]`, an empty operand (an unset variable) is 0; anything else that is not an integer prints
  `[[: x: integer expression expected` and fails the test with exit 1, the way bash reports it;
- `=` as a spelling of `==`, and a negative number as the first operand (`[[ -1 -lt 0 ]]`), which the
  parser used to reject as an unknown operator.

```ts
await $`[[ dist/index.js -nt src/index.ts ]] || bun build ./src/index.ts --outdir dist`;
await $`[[ -s ${logFile} ]] && cat ${logFile}`;
if ((await $`[[ ${retries} -gt 0 ]]`.nothrow()).exitCode === 0) {
  /* ... */
}
```

The stat task now carries both operands and stats each one in the same thread-pool hop; an empty
operand is reported as missing there too, so Windows' `stat("")` (which returns the cwd) cannot make
`[[ "" -ot x ]]` lie. Still missing after today: `-r`/`-w`/`-x` (want `access(2)` plus a decision
about what executable means on Windows), `<`/`>` string ordering (the lexer reads them as
redirections inside `[[ ]]`), and `&&`/`||`/`!` inside a single `[[ ]]`, which remain parse errors as
before. The shell docs had no section on `[[ ]]` at all, so one was added with the full table. The
tests were run on Linux; the Windows and macOS builds were only type-checked (`bun run rust:check-all`),
and the Windows path reuses the existing `shell_get_path` rewriting plus `bun_sys::lstat`.

While running clippy over the stack, the day-1 `wc` builtin had one `needless_pass_by_value` hit in
its `on_io_writer_chunk`; that commit was amended to consume the error the way the other builtins do.

Files: `src/shell_parser/parse.rs` (supported table, `=`, negative operands),
`src/runtime/shell/states/CondExpr.rs`, `src/runtime/shell/dispatch_tasks.rs` (two-operand stat task),
`src/runtime/shell/interpreter.rs` (`shell_lstatat`), `src/bun_core/util.rs` (`S::ISBLK`),
`docs/runtime/shell.mdx`, `test/js/bun/shell/bunshell.test.ts`.

### 2026-08-21: `bun outdated --json`

`bun outdated` only produced a table, so anything that wanted the information (a CI check, a
dependency dashboard, an update bot, an editor) had to scrape box-drawing characters, or run
`npm outdated --json` against a project npm did not install. `bun audit`, `bun info` and the
`bun pm` commands already take `--json`, and `bun outdated` had the flag stubbed out in two comments
since the command was written (oven-sh/bun#39534, filed this week, lists JSON output as the biggest
gap against npm and pnpm). `--json` now prints an array with one object per row of the table and
nothing else on stdout, so `bun outdated --json | jq` works; the `bun outdated v1.x` header is not
printed, and errors and the manifest download progress go to stderr as before.

```sh
bun outdated --json
# [
#   {
#     "name": "eslint",
#     "current": "8.57.1",
#     "update": "8.57.1",
#     "latest": "9.20.0",
#     "type": "devDependencies",
#     "workspace": "my-app",
#     "catalog": null
#   }
# ]

# fail CI when something can be updated without changing package.json
bun outdated --json -r | jq -e 'map(select(.current != .update)) == []'
```

`name` is the name in package.json (what `bun update <name>` and the positional filters use), `type`
is the package.json section, `workspace` is always present (the table only shows the column when it
is filtered), and `catalog` is `null`, `"default"` or the catalog name, the encoding `bun audit fix
--json` already uses. Catalog rows are not folded into one `catalog (a, b)` row as in the table:
each workspace gets its own object, since a consumer can group and a folded string cannot be
ungrouped. Objects come out in the table's order (dependencies, dev, peer, optional); nothing
outdated prints `[]`, as do the early exits for an unknown root package and a dependency pattern
that cannot match. The minimum-release-age `*` marker has no JSON counterpart: the versions are the
ones the table prints, which are also the ones `bun update` would install.

The implementation keeps the three version strings the first pass already formats to size the
columns, instead of computing them a third time; that pass formatted the _current_ version with the
manifest's string buffer in the "no version satisfies the range" fallback, although the current
version comes from the lockfile, so the JSON would have carried a wrong prerelease tag there. The
fallback now uses the lockfile buffer; upstream oven-sh/bun#38649 (open) changes the same two lines,
so that part of this patch disappears when it lands. The
header moved after argument parsing so it can be skipped, which also makes `bun outdated --help`
start with `Usage:` like every other command instead of a version line. The JSON tests run against
the test registry and pin the exact documents, including a row where current, update and latest all
differ (install `no-deps@1.0.0`, then widen the range to `^1.0.0`; the lockfile keeps 1.0.0).

Files: `src/runtime/cli/outdated_command.rs`, `src/install/PackageManager.rs` (`supports_json_output`),
`src/install/PackageManager/CommandLineArguments.rs` (flag, help), `completions/bun.zsh`,
`docs/pm/cli/outdated.mdx`, `docs/snippets/cli/outdated.mdx`, `test/cli/install/bun-install-registry.test.ts`.

### 2026-08-22: `ignore` option for `Bun.Glob` scans

`Bun.Glob` could only say what to include. Leaving things out meant filtering the results afterwards,
which still walks every `node_modules` and `dist` directory first, and that walk is what makes a scan
of a project slow. It is also the first option people moving from `fast-glob`, `globby` or
`node:fs.glob` look for (oven-sh/bun#8182, open since early 2024). `scan()` and `scanSync()` now take
`ignore`: one glob pattern or an array of them, in the same syntax as the main pattern. A path that
matches an ignore pattern is left out, and a directory that matches is not entered at all, so an
ignored tree costs one `readdir` entry instead of a traversal.

```ts
const glob = new Glob("**/*.ts");

for await (const file of glob.scan({
  ignore: ["**/node_modules/**", "dist/**", "**/*.test.ts"],
})) {
  // never a test file, nothing under any node_modules or under the root dist
}
```

Patterns are matched against the path relative to `cwd`, the same string `scan` returns without
`absolute`, so `dist/**` covers only the root `dist` and `**/dist/**` every one. With `absolute: true`
the cwd prefix is stripped before matching (cwd is normalized the way the walker normalizes the paths
it joins, so a trailing slash or `/.` in `cwd` does not break it); an absolute glob pattern is matched
against the full path. Directory pruning tests the directory path both as is and with a trailing `/`,
because the matcher does not let `dist/**` match `dist` but does let it match `dist/`. Node's
`fs.glob` `exclude` decides the same way, and it gives gitignore semantics (a bare `dist` skips the
whole tree) where fast-glob only filters. For the patterns people actually write (`**/node_modules/**`,
`dist/**`, `**/*.test.ts`, a bare directory name, a brace group) the results are identical to
fast-glob's, which the tests check against the real package. Separators in ignore patterns are `/`, as
in `Glob.match()`; on Windows that matches `\` in paths as well. An `ignore` value that is not a
string or an array of strings throws.

The check lives in the walker, at the two points every result funnels through
(`prepare_matched_path` and its symlink twin) and before a directory work item is pushed, including a
followed symlink to a directory. With no patterns it is one `is_empty()` per entry. The shell's
`BunGlobWalkerZ`, the `bun install` workspace globs and `--filter` share the walker and never set
patterns, so they are unchanged. The test that proves a directory is skipped rather than filtered puts
a broken symlink inside `node_modules` and scans with `throwErrorOnBrokenSymlink`: without `ignore`
the scan throws `ENOENT`, with `"**/node_modules/**"` it does not. A pre-existing bug turned up on the
way and was reported separately rather than fixed here: an absolute pattern with no glob syntax
(`new Glob("/abs/file").scanSync()`) yields nothing, because that early-exit path never records the
match.

Files: `src/glob/GlobWalker.rs`, `src/runtime/api/glob.rs`, `packages/bun-types/bun.d.ts`,
`docs/runtime/glob.mdx`, `test/js/bun/glob/scan.test.ts`, `test/integration/bun-types/fixture/bun.ts`.

### 2026-08-23: `.env` changes restart `--watch` and `--hot`

`bun --watch` restarts the process when any imported file changes, but not when a `.env` file does,
although bun is the one that loaded it. Edit `PORT` or a database URL in `.env` while `bun --watch
server.ts` runs and nothing happens until the next source edit, which then silently picks the new
values up (oven-sh/bun#2521, open since 2023). Node's `--watch` already restarts on a change to its
`--env-file` files. Bun now watches every `.env` file it loaded at startup: the default set
(`.env`, `.env.local`, `.env.development`, ... as selected by `NODE_ENV`) and each `--env-file`, whether
relative or absolute. A change to one of them restarts the process exactly like a source change,
for `bun run --watch`, `bun test --watch` and the `--hot` variants.

```sh
bun --watch server.ts
# edit .env: the process restarts and process.env reflects the file
```

Under `--hot` the restart is deliberate rather than a soft reload: environment variables are read
once at startup, by user code but also by bun itself (`NODE_ENV`, `TZ`, proxy and TLS settings), and
`process.env` is a snapshot that user code may have written to, so re-applying a file in place would
be wrong in several ways a restart is not. The files are registered with the existing watcher right
after it starts, by the same path-only route the entry point uses, so a missing-then-created `.env`
is not picked up until the next restart. On the watcher thread a `--hot` event on one of these hashes
takes the same restart path `--watch` uses; under `--watch` nothing special is needed, the file is
just another watched file, including the `--watch-kill-signal` handling. On Windows `--hot` does not
register them, because a restart there goes through the `--watch` manager process that `--hot` does
not have. The dotenv loader now exposes the list of files it read, in the order its `[0.05ms] ".env"`
line prints them.

Files: `src/dotenv/env_loader.rs` (`Loader::loaded_files`), `src/jsc/VirtualMachine.rs`
(`add_env_files_to_watcher_if_needed`), `src/jsc/hot_reloader.rs`, `src/runtime/cli/run_command.rs`,
`src/runtime/cli/test_command.rs`, `docs/runtime/watch-mode.mdx`, `docs/runtime/environment-variables.mdx`,
`test/cli/watch/watch.test.ts`, `test/cli/hot/hot.test.ts`.

### 2026-08-24: `bun test --reporter=json`

`bun test` could report to the console, as dots, or as JUnit XML. Anything that wanted the results as
data (a CI dashboard, an editor integration, a script deciding what to rerun, `jq`) had to parse the
XML or scrape the console output, and the format the JavaScript ecosystem actually speaks is Jest's
`--json` document, which Vitest's JSON reporter emits too, so tools already exist for it
(oven-sh/bun#2984, the reporters issue, asks for a JSON reporter specifically). `--reporter=json` now
writes that document: to `--reporter-outfile` when given, otherwise to stdout once the run is over.
`bun test` prints its console output to stderr, so stdout holds only the document (the `bun test vX`
header is skipped in that mode), and the console reporter is unchanged either way.

```sh
bun test --reporter=json --reporter-outfile=results.json
bun test --reporter=json 2>/dev/null | jq '.testResults[] | select(.status == "failed") | .name'
```

```json
{
  "numTotalTestSuites": 2,
  "numPassedTestSuites": 1,
  "numFailedTestSuites": 1,
  "numPendingTestSuites": 0,
  "numRuntimeErrorTestSuites": 0,
  "numTotalTests": 3,
  "numPassedTests": 2,
  "numFailedTests": 1,
  "numPendingTests": 0,
  "numTodoTests": 0,
  "startTime": 1724500000000,
  "success": false,
  "testResults": [
    {
      "name": "/app/math.test.ts",
      "status": "failed",
      "startTime": 1724500000012,
      "endTime": 1724500000031,
      "message": "",
      "assertionResults": [
        {
          "ancestorTitles": ["math"],
          "fullName": "math subtracts",
          "title": "subtracts",
          "status": "failed",
          "duration": 1.08,
          "failureMessages": [
            "AssertionError: expect(received).toBe(expected)\n\nExpected: 1\nReceived: 2\n\n      at math.test.ts:8:19\n"
          ],
          "location": { "line": 7, "column": 3 }
        }
      ]
    }
  ]
}
```

The shape is Jest's, field for field, with the same status vocabulary (`test.skip` is `pending`,
`test.todo` is `todo`; a file is `failed`, `passed`, or `skipped` when every test in it is skipped). Two
things Jest leaves empty by default are filled in. `location` is the `test()` call's position: the
runner already captured the line for JUnit, and the C++ stack walk now also returns the column (and
feeds the source map a zero-based column, which it had been given a one-based one), so the field is
complete rather than `null`. `message` on a file entry carries errors thrown outside of any test: a
file that fails to load, a throwing `describe` body, an unhandled error between tests. Such a file is
`failed` and counted in `numRuntimeErrorTestSuites`, and as in Jest it is not a failed _test_, which is
the one place the document and the console summary count differently (the console folds a load
failure into `fail`). `failureMessages` holds the error name, message and stack the way the JUnit
`<failure>` body does; timeouts, `.failing` tests that pass and `expect.assertions` misses get fixed
messages. Tests `-t` or `.only` leave out are not listed, matching the console, and a `--dry-run`
lists every test as `pending`. The document is also written when `--bail` stops the run, and
`[test.reporter] json = "path"` in bunfig.toml configures it like `junit`.

The reporter consumes the same `TestCaseReport` record the JUnit reporter does (upstream introduced
it in oven-sh/bun#40678, and this patch was re-ported onto it on 2026-08-28): the serial runner hands
each finished test to both reporters, and under `--parallel` the coordinator forwards
`--reporter=json` to the workers, whose `TestDone` frames carry the record; the coordinator replays
them in the run's file order into its own `JsonReporter`, closing a crashed worker's file with a
failed entry. The record gained the column of the `test()` call, and the `FileDone` frame gained the
error a file threw outside of any test, so the parallel document matches the serial one. The error
capture is `TestFailure`, recorded through the `on_print_error_zig_exception` hook into
`CommandLineReporter.test_failure` for an error the runner attributes to a test, or into the new
`file_failure` slot for one it does not. While testing it, a pre-existing quirk showed up:
`bunfig.toml` is applied after the `bun test` flags are parsed, so a `junit = ...` (or `json = ...`)
path in the config wins over `--reporter-outfile` on the command line.

Files: `src/runtime/cli/test/JsonReporter.rs`, `src/runtime/cli/test_command.rs` (`TestCaseReport`,
`CommandLineReporter::file_failure`, `write_reports_if_needed`),
`src/runtime/cli/test/parallel/{Frame,Coordinator,runner,aggregate}.rs`, `src/runtime/cli/mod.rs`,
`src/runtime/cli/Arguments.rs`, `src/runtime/error.rs`, `src/options_types/context.rs`,
`src/bunfig/bunfig.rs`, `src/runtime/test_runner/{bun_test,Execution,jest,ScopeFunctions,Collection}.rs`
(`column_no`, `capture_test_location`), `src/jsc/bindings/bindings.cpp` (`Bun__CallFrame__getLineAndColumn`),
`completions/bun.zsh`, `completions/bun-cli.json`, `docs/test/reporters.mdx`, `docs/test/configuration.mdx`,
`docs/runtime/bunfig.mdx`, `docs/snippets/cli/test.mdx`, `test/cli/test/bun-test.test.ts`,
`test/cli/test/parallel.test.ts`.

### 2026-08-25: `Bun.CSV`

Bun parses JSON, JSONC, JSON5, TOML, YAML, XML, INI and markdown out of the box, and nothing for
CSV, which is still how spreadsheets, databases and most data exports hand tabular data around.
Scripts pull in papaparse or csv-parse for a format that fits in a few hundred lines; oven-sh/bun#6722
asked for CSV support in 2023 and the zig-era oven-sh/bun#19167 never landed. `Bun.CSV.parse()` and
`Bun.CSV.stringify()` (also `import { CSV } from "bun"`) now exist next to the other parsers. `parse`
takes a string, UTF-8 bytes or a `Blob` like `Bun.TOML.parse` and returns records; `stringify` writes
them back.

```ts
import { CSV } from "bun";

CSV.parse("name,age\nAda,36\nGrace,45\n");
// [{ name: "Ada", age: "36" }, { name: "Grace", age: "45" }]

CSV.parse("name,age\nAda,36\n", { header: false });
// [["name", "age"], ["Ada", "36"]]

CSV.parse("Ada\t36\n", { header: ["name", "age"], delimiter: "\t" });
// [{ name: "Ada", age: "36" }]   (typed Record<"name" | "age", string>[])

CSV.stringify([{ name: "Ada", note: 'says "hi"' }]);
// 'name,note\nAda,"says ""hi"""\n'
```

The format is RFC 4180 plus what every reader accepts in practice: `\n`, `\r\n` and a lone `\r` end a
record, a quoted field may span lines and doubles its quote to escape it, a quote inside an unquoted
field is literal, a leading byte order mark is skipped. Fields are strings, always; CSV has no types
and guessing them (`007`, `1e5`, `TRUE`) is how data gets corrupted, so no `dynamicTyping`. Options:
`header` (`true` by default: the first record names the columns and records are objects; `false` for
arrays; an array of names for a file without a header row, which also types the result), `delimiter`
and `quote` (any single character, so TSV and `;` files work), `trim` (strip spaces and tabs around
fields, and recognize a quote after them, as Python's `skipinitialspace` does), and `skipEmptyLines`
(on by default). With named columns a short record leaves the missing columns `""` and extra fields
are dropped, as d3-dsv does. An unterminated quote, or text between a closing quote and the next
delimiter, is a `SyntaxError` that names the line; silently swallowing the rest of the file into one
field, which the lenient parsers do, is worse than an error that points at the row. `stringify` takes
all-array or all-object rows, writes a header from `columns` or the first row's keys, ends every
record with `\n` so outputs concatenate, quotes only what needs it (delimiter, quote, line break, or a
leading/trailing space or tab so `trim` round-trips), and converts values the way `JSON.stringify` and
csv-stringify do: `null`/`undefined` empty, `Date` as ISO, nested objects as JSON, functions and
symbols empty.

The parser scans the UTF-8 bytes with the SIMD `index_of_any` for the next delimiter or line break,
so an unquoted field costs one scan and one string allocation, and a quoted field is handed to the
string constructor straight from the input unless it has `""` inside, which is the only case that
copies into a scratch buffer first. It goes through the same input scaffold as the other
`Bun.*.parse` functions. Column names are atomized once per parse, so the per-row property puts hit
the atom table instead of hashing the name each time. Left for later: a cached `Structure` with
`putDirectOffset` for object rows (what `Bun.sql` does for its rows), a streaming parser for files
that do not fit in memory, and `import x from "./data.csv"`.

While rebasing, upstream oven-sh/bun#40374 had renamed `JSValue::to_slice` to `to_utf8`, which the
2026-08-22 glob patch used; that commit was amended.

Files: `src/runtime/api/CSVObject.rs`, `src/runtime/api/CSVObject.bind.ts`, `src/runtime/api.rs`,
`src/jsc/bindings/BunObject.cpp`, `packages/bun-types/bun.d.ts`, `docs/runtime/csv.mdx`, `docs/docs.json`,
`docs/runtime/bun-apis.mdx`, `test/js/bun/csv/csv.test.ts`, `test/integration/bun-types/fixture/csv.ts`.

### 2026-08-26: `head` and `tail` shell builtins

After `wc`, `head` and `tail` are the commands a script most often pipes into, and neither was a
builtin, so `| head -n 5`, `tail -n +2 data.csv` (skip the header row) and `tail -n 1 app.log` only
worked where coreutils happened to be installed, which on Windows is usually nowhere. Both are now
builtins on every platform: `-n N` and `-c N` (also `-N`, `--lines=N`, `--bytes=N`), `head -n -N`
(everything but the last N), `tail -n +K` and `tail -c +K` (everything from line or byte K on), any
number of file operands with `-` for stdin, and `==> name <==` headers for more than one file (`-q`
never, `-v` always). An unreadable operand is reported on stderr, sets the exit code to 1 and does
not stop the others from being printed, like wc(1). Output matches GNU coreutils byte for byte in
every case the tests cover, including an unterminated last line, which both print as it is.

```ts
await $`git log --oneline | head -n 5`;
await $`tail -n +2 data.csv | wc -l`; // rows without the header
const last = await $`tail -n 1 app.log`.text();
await $`yes | head -n 3`; // "y\ny\ny\n", and it ends
```

The two commands are one program with the selection inverted, so they share one module:
`Head` and `Tail` differ in how they read a sign on the count (`-N` means "all but the last N" to
head and "the last N" to tail, `+K` is "from K on" to tail) and in the name on their messages. A
`Selection` is fed every chunk of an input and says which bytes to write now, so `head` and
`tail -n +K` stream: a chunk is written as it arrives, and the first lines of a 10 GB file cost
one chunk's read. The "last N" selections keep the retained suffix in a buffer that is compacted once its
dead prefix reaches half the buffer; finding where the last N lines start walks backwards over the
kept lines when fewer are kept than dropped, so `tail -n 1` of a million lines does one search per
chunk instead of a million. `head` unregisters from its reader as soon as it has what it needs, and
the shell's `IOReader` now tells the read loop to stop when no listener is left instead of draining
the source into nothing (Windows ignores that return value and keeps reading until the last `Arc`
drops, as before). When the command finishes, its end of the pipe closes and the producer sees
EPIPE, which is how `yes | head -n 3` terminates; with the builtin `cat` that is 40 ms on a
million-line file in a debug build. Left out: `tail -f` (reported as unsupported), size suffixes
on `-c`, `-z`, and `head -c -N` through a pipe still buffers N bytes, as it must.

Files: `src/runtime/shell/builtin/head_tail.rs`, `src/runtime/shell/Builtin.rs`,
`src/runtime/shell/mod.rs`, `src/runtime/shell/IOReader.rs`, `docs/runtime/shell.mdx`,
`test/js/bun/shell/commands/head.test.ts`, `test/js/bun/shell/commands/tail.test.ts`,
`test/js/bun/shell/exec.test.ts`.

### 2026-08-27: `engines.bun` in package.json

A project could not say which version of bun it needs. `"engines": { "bun": ">=1.3.0" }` is the
field everyone already writes for that (oven-sh/bun#5846, open since 2023 with 109 upvotes;
yarnpkg/yarn#9214 is the bun team asking yarn to stop warning about it), but bun never read it: a
teammate on a stale bun got a confusing failure deep inside the code instead of being told what the
project expects. Now `bun install` (with `add`, `remove`, `update`, `link` and `ci`, everything
that installs) and `bun run <script>` compare the running version against the range and stop with
exit code 1 when it does not match:

```
error: this project requires bun >=1.3.0, but bun 1.2.23 is running
note: "engines" in /home/me/my-app/package.json sets the requirement
```

```json
{
  "engines": { "bun": ">=1.3.0" }
}
```

The check runs before anything is resolved, downloaded or written, so a failing `bun add` leaves
package.json and the lockfile untouched. For `bun install` it is the workspace root's package.json,
from whichever package the command runs in; for `bun run` (and the `bun <script>` shorthand) it is
the package.json the script comes from, and running a file directly is not affected. Only the
project's own package.json is checked: the `engines` of a dependency are ignored, as are the other
entries (`node`, `npm`), since bun is not node and its emulated node version says nothing useful.
The range is parsed by the same code as a dependency version, so `>=1.3`, `1.x`, `^1.3.0 || ^2`,
`*` and an empty string (no requirement) behave as with `Bun.semver.satisfies`; a value that has no
comparator at all (`"latest"`) is an error that names the file, instead of the silent pass that
parser gives it. The running version is the bare `major.minor.patch`, so a debug or canary build of
1.4.1 is 1.4.1, which is also what `Bun.version` reports. The error has no escape hatch: pnpm and
yarn fail on the root project's `engines` the same way, and the field is the project's own.

The implementation is one small module, `bun_install::engines`, that both commands call. The
install side reads the range where `install_with_manager` parses the root package.json, which
both of its paths do before the manifest fetches (`Package::parse_checking_engines`, the parse
that was there, with the check in it). The run side adds an `engines` map to the resolver's
`PackageJSON`, filled only when `scripts` are (the project's own package.json, not the thousands
in node_modules), and checks it when a script is found. Left for later: `devEngines`
(`{ "runtime": { "name": "bun", "version": ">=1.3", "onFail": "error" } }`), which needs a
decision about what `"name": "node"` should mean to bun, and a check in `bunx`.

Changed on 2026-09-26. The first version read the range from the tree that the package.json
cache keeps for the root package.json. `bun patch` in a workspace package edits that file and
gives the cache entry the new text, and the tree still points into the old one, which is freed.
AddressSanitizer found the read in six tests of `bun-patch.test.ts`. Those tests are the
regression test: they fail on the debug build without this change and pass with it.

Files: `src/install/engines.rs`, `src/install/lib.rs`,
`src/install/PackageManager/install_with_manager.rs`, `src/install/lockfile/Package.rs`,
`src/resolver/package_json.rs`, `src/runtime/cli/run_command.rs`, `docs/pm/cli/install.mdx`,
`docs/runtime/index.mdx`, `test/cli/install/bun-install.test.ts`,
`test/cli/install/bun-run.test.ts`.

### 2026-08-28: "did you mean" for `bun run` and `bun pm`

`bun run buidl` said `error: Script not found "buidl"` and nothing else, so the next step was
always `bun run` to list the scripts, or a look at package.json. npm, pnpm, yarn and cargo all
answer a typo with the name that was probably meant. Now bun does too:

```
$ bun run buidl
error: Script not found "buidl"
note: did you mean "bun run build"?

$ bun run Buil
error: Script not found "Buil"
note: did you mean "bun run build", "bun run build:watch" or "bun run build:server"?

$ bun instal
error: Script not found "instal"
note: did you mean "bun install"?

$ bun pm lsit
error: "lsit" unknown command
note: did you mean "bun pm ls"?
```

The candidates are what `bun run <name>` could have run: the `scripts` of the enclosing
package.json, the executables in every `node_modules/.bin` that `bun run` puts on `PATH` (the
current directory's and its ancestors', so `bun run eslnt` finds `eslint` from a subdirectory),
and, for the bare `bun <name>` form only, bun's own commands, since that is where `bun instal`
ends up. A name counts as close when the edit distance is at most one per three typed bytes
(at least one, so `tset` finds `test` and `typechek` finds `typecheck`), or when what was typed is
a prefix of it, which is how `bun run build` finds `build:client` when there is no plain `build`.
The distance is the optimal string alignment distance: insertions, deletions, substitutions and a
swap of two adjacent bytes, which is the typo people make most and which plain Levenshtein counts
as two; ASCII case is ignored, so `bun run Build` is pointed at `build`. The closest three are
listed, closest first and in the order they are defined on a tie, as `bun run <script>` rather
than a bare name because `bun build` would start the bundler. A command is matched through its
aliases too but always suggested by its name: `bun uninstal` points at `bun remove`, `bun pm lsit`
at `bun pm ls`. Words reserved for later (`deploy`, `login`) and the commands bun runs on itself
(`getcompletes`) are never suggested. `Module not found` (a path or a file with a JavaScript
extension) and `File not found` (any other extension) keep their messages, and `--if-present`
still exits quietly. `bun pm <typo>` still prints the `bun pm` help first, as it did, with the note
after the error line.

The list of bun's commands is not kept by hand. `Command::which`, which turned the first argument
into a `Tag` with a chain of forty string compares, now walks `ROOT_COMMANDS`, a table of name,
aliases and `Tag`, and the suggestions read that same table, so a new command is a new line in one
place. `bun pm` keeps its `if`/`else if` chain over the subcommand word and reads its candidates
from `SUBCOMMANDS`, a list of each word with the name `bun pm --help` shows for it. (Until
2026-10-15 the chain was a `PmSubcommand` enum with an exhaustive `match`; upstream then reworked
`bun pm`, and the rebase kept upstream's dispatch.) The selection and the note live in
`cli::did_you_mean` (`closest` takes any candidate type, a word accessor and a "same command"
predicate so an alias and its name count once), on top of `bun_core::strings::typo_distance`
(`bun audit fix` and `bun pm licenses` had hard-coded "did you mean" notes, and the
`strings::edit_distance` that came later with `bun lint` is plain Levenshtein and case-sensitive).
The `.bin` directories are listed with `bun_sys::iterate_dir`, skipping dotfiles
and, on Windows, folding the `.cmd`, `.ps1`, `.bunx`, `.exe` and `.bat` shims into the one name
they wrap. The whole thing runs only on the error path, after the exact lookups have failed.

Files: `src/bun_core/string/immutable.rs` (`typo_distance`), `src/runtime/cli/did_you_mean.rs`,
`src/runtime/cli/mod.rs` (`ROOT_COMMANDS`, `RootCommand`, `Command::which`),
`src/runtime/cli/run_command.rs` (`print_did_you_mean`), `src/runtime/cli/package_manager_command.rs`
(`SUBCOMMANDS`), `docs/runtime/index.mdx`, `docs/pm/cli/pm.mdx`, `test/cli/run/run_command.test.ts`,
`test/cli/install/bun-pm.test.ts`.

### 2026-08-29: `append: true` for `Bun.write()`, `BunFile.write()` and `BunFile.writer()`

Bun's file API could create, read, copy, stream and delete a file, but not add to one: `Bun.write`
always replaced the contents, and `Bun.file(path).writer()` started at offset 0. Appending is the
most common thing a script does with a log file, so every such script fell back to
`node:fs.appendFile` (oven-sh/bun#10473, open since 2024, plus #16768, #6559 and #5821 asking for
the same in three spellings; oven-sh/bun#25751 implemented it for the Zig tree and was closed as
stale when that tree went away). All three entry points now take `append: true`:

```ts
await Bun.write("app.log", `${new Date().toISOString()} started\n`, {
  append: true,
});
await Bun.write("all.log", Bun.file("today.log"), { append: true }); // file onto file
await Bun.write("events.ndjson", await fetch(url), { append: true }); // streamed body
await Bun.file("app.log").write("one more line\n", { append: true });

const log = Bun.file("app.log").writer({ append: true });
log.write("server started\n");
await log.end();
```

The file is opened `O_APPEND` instead of `O_TRUNC`, so the bytes land after whatever is there when
each write happens (two processes appending to the same log do not overwrite each other), and it is
created, with `createPath` and `mode` honoured, when it does not exist. Every input kind appends:
strings and buffers on both the main-thread fast path and the thread-pool `WriteFile` task, a `Blob`,
a `BunFile` (the copy takes a plain read/write loop, because `copy_file_range` and `sendfile` reject
an append descriptor, `fcopyfile` writes from offset 0 and `clonefile` replaces the file), a
`Response`/`Request` whether its body is already in memory or still streaming, and a bare
`ReadableStream`. Nothing to append (`""`, an empty `Blob`) creates the file and otherwise leaves it
alone, where the default mode truncates it. A file descriptor destination keeps writing at its own
position and is never truncated; open it with `"a"` to append through it. S3 objects cannot be
appended to, so `append: true` on an `S3File`, or on `Bun.s3.write()`, is a `TypeError` rather than a
silent overwrite. `append` must be a boolean.

Three pre-existing optimizations had to step aside in append mode: the `fallocate` that the
`WriteFile` task and the file copier issue from offset 0 would have extended the file with zeros
before the appended bytes; the clone/copy syscalls above; and the copier's use of the destination's
known size as a bound on the copy, which would have cut an append short once `file.size` had been
read. On Windows the writer and the copier open the destination through libuv with `UV_FS_O_APPEND`,
which is a kernel-enforced append (`FILE_APPEND_DATA` without `FILE_WRITE_DATA`), the copier skips
`uv_fs_copyfile`, and it caps the copy at the source's starting size as the POSIX copier does, so a
file appended onto itself is doubled instead of growing until the disk is full. The tests were run on
Windows as well as Linux.

Files: `src/runtime/webcore/Blob.rs` (options, fast paths, empty source, S3 check), `src/runtime/webcore/FileSink.rs`
(`Options::append`), `src/runtime/webcore/blob/write_file.rs` (`FileOpener::open_flags`, `WriteFileWindows`),
`src/runtime/webcore/blob/copy_file.rs` (`CopyFile`, `CopyFileWindows`), `src/runtime/webcore/S3Client.rs`,
`src/runtime/webcore/S3File.rs`, `src/libuv_sys/libuv.rs` (`O::APPEND` made public), `packages/bun-types/bun.d.ts`,
`docs/runtime/file-io.mdx`, `docs/guides/write-file/append.mdx`, `test/js/bun/io/bun-write.test.js`,
`test/js/bun/util/filesink.test.ts`, `test/integration/bun-types/fixture/globals.ts`,
`test/integration/bun-types/bun-types.test.ts` (a pinned diagnostic moved four lines).

### 2026-08-30: `Bun.semver.inc()`, `maxSatisfying()` and `minSatisfying()`

`Bun.semver` could compare versions, match them against ranges and, since day one, take them
apart, but it could not produce one. The two things a release script or a registry tool does with
semver beyond that are "bump this version" and "which of these versions is the best match for this
range", and for both people still install `semver` from npm next to a runtime that has a semver
engine built in. Today adds the three `node-semver` functions that cover them, with `node-semver`'s
exact semantics, so `semver.inc`, `semver.maxSatisfying` and `semver.minSatisfying` can be replaced
one for one.

```ts
const { semver } = Bun;

semver.inc("1.2.3", "minor"); // "1.3.0"
semver.inc("1.2.3", "prerelease", "beta"); // "1.2.4-beta.0"
semver.inc("1.2.4-beta.0", "prerelease"); // "1.2.4-beta.1"
semver.inc("1.2.4-beta.1", "patch"); // "1.2.4", the release of that prerelease
semver.inc("1.2.3", "premajor", "rc", "1"); // "2.0.0-rc.1"
semver.inc("1.2.4-beta.1", "release"); // "1.2.4"

semver.maxSatisfying(["1.2.3", "1.3.0", "1.4.0-beta.1", "2.0.0"], "^1.0.0"); // "1.3.0"
semver.maxSatisfying(Object.keys(packument.versions), "^1.2.0"); // what `bun add pkg@^1.2.0` would pick
semver.minSatisfying(["1.2.3", "1.3.0", "2.0.0"], "^1.0.0"); // "1.2.3"
```

`inc(version, release, identifier?, identifierBase?)` takes the eight `node-semver` release types
(`major`, `minor`, `patch`, `premajor`, `preminor`, `prepatch`, `prerelease`, `release`) and
follows `node-semver`'s rules to the letter, which are less obvious than they look: `major`,
`minor` and `patch` on a prerelease of the next release land on that release (`2.0.0-rc.0` →
`2.0.0`, not `3.0.0`); `prerelease` counts up the last numeric identifier, wherever it sits
(`1.2.3-alpha.9.beta` → `1.2.3-alpha.10.beta`), starts one when there is none, and with an
identifier keeps the tag only when it already has that name (`beta.1` → `beta.2` for `beta`, →
`rc.0` for `rc`); `identifierBase` is `"0"`, `"1"` or `false` for a tag with no number; `release`
drops the tag and is `null` on a version that has none. Build metadata is dropped, as
`node-semver` does. The result is `null` for anything that is not a complete version, for an
identifier that is not a valid prerelease identifier, and for a prerelease that would come out
empty. Unlike `node-semver`, an unknown release type or a non-string identifier is a `TypeError`
rather than `null`, since that is a typo and not data, and that is how the rest of `Bun.*`
validates arguments. The whole of `node-semver`'s `increments.js` fixture (minus its loose-mode
rows) runs as a test table. The one place this deliberately differs from `bun pm version` is the
CLI's own bump rules, which its tests pin (`1.0.3-alpha.1` → `1.0.4` for `patch`, `1.0.0-alpha` →
`1.0.0-alpha.1` for `prerelease`); `Bun.semver.inc` is the library function JavaScript code expects,
and the CLI was left as it is.

`maxSatisfying(versions, range)` and `minSatisfying(versions, range)` parse the range once, skip
entries that are not complete versions (and entries that are not strings), decide each candidate
exactly as `satisfies()` does, so the prerelease rule is the same one `bun install` uses, and return
the winning entry as it was given (`"v1.2.3"` stays `"v1.2.3"`), first one on a tie; build metadata
does not order. A range with no comparator in it (`"latest"`, `"nope"`) yields `null`, where
`satisfies()` has always treated such a string as `*` (a pre-existing quirk that was left alone,
and that `engines.bun` already works around). A test checks the two against `satisfies()` and
`order()` over 200 versions and nine ranges.

The increment itself lives in the `bun_semver` crate (`inc.rs`), on the parsed `Version` the
lockfile and `bun install` use, so it can be reused from Rust; the JS layer in `SemverObject.rs`
only validates arguments, and `parse()`, `inc()` and the two searches now share one "is this a
complete version" check. While testing, the version parser turned out to reject a bare version
followed by a newline or tab (`"1.2.3\n"` is "Invalid SemVer" to `order()`, while `"1.2.3 "` and
`"1.2.3-rc.1\n"` are fine); that is upstream behaviour and was reported separately rather than fixed
here.

Files: `src/semver/inc.rs`, `src/semver/lib.rs`, `src/semver_jsc/SemverObject.rs`,
`packages/bun-types/bun.d.ts`, `docs/runtime/semver.mdx`, `test/cli/install/semver.test.ts`,
`test/integration/bun-types/fixture/bun.ts`.

### 2026-09-01: `EventSource`

Bun can serve server-sent events (the docs have a guide for it) but could not consume them:
`EventSource`, the web API for that, was not defined. bun-types has declared the global since 2023,
so `new EventSource(url)` type-checked and then threw `ReferenceError` at runtime. A native
implementation landed in 2023 (oven-sh/bun#3074, a hand-written HTTP/1.1 client over `Bun.connect`),
never became reachable and was removed in oven-sh/bun#14421 as "doesn't work anyway";
oven-sh/bun#8474 asks for it to come back. Streaming APIs (LLM token streams, deployment logs,
realtime databases) are mostly SSE, and Node has had `EventSource` since 22.3 (behind
`--experimental-eventsource`). `EventSource` is now a global, per the HTML spec and built on `fetch`:

```ts
const events = new EventSource("http://localhost:3000/events");
events.onopen = () => console.log("connected");
events.onmessage = event => console.log(event.data, event.lastEventId);
events.addEventListener("alert", event => console.log("alert:", event.data));
events.onerror = () => {
  if (events.readyState === EventSource.CLOSED)
    console.log("the server refused the stream");
};
events.close();

// Bun extension, like `new WebSocket(url, { headers })`:
new EventSource(url, { headers: { Authorization: `Bearer ${token}` } });
```

The request is a `GET` with `Accept: text/event-stream`. A `200` with a `text/event-stream` content
type (parameters allowed) opens the connection; any other status or type fails it, which is the spec's
"fail the connection": one `error` event, `readyState` `CLOSED`, no retry (a `404` is not retried every
three seconds). A network error or the server ending the stream "reestablishes the connection": an
`error` event with `readyState` `CONNECTING`, then a new request after the reconnection time, 3 seconds
unless the server sent `retry: <ms>`, carrying `Last-Event-ID` when an event with an `id` has been
received. The stream parser follows the spec's field rules: `data` lines join with `\n`, `event` sets
the type, `id` sets the last event ID (ignored when it contains NUL, a bare `id` resets it, a block with
only an `id` updates it without dispatching), `retry` must be ASCII digits, `:` lines are comments, a
single space after the colon is dropped, lines end at CRLF, LF or CR, and a leading byte order mark is
skipped. A CR that ends a chunk and the LF that starts the next count as one line ending; a UTF-8
sequence split across chunks is decoded whole (`TextDecoder` in stream mode). `close()` aborts the
fetch, so the server's `ReadableStream` is cancelled, and it clears the retry timer, so a closed
`EventSource` does not keep the process alive. `MessageEvent.origin` is the origin of the response URL
after redirects, `withCredentials` is stored and does nothing (Bun has no cookie jar), and the
constructor throws a `SyntaxError` `DOMException` for an invalid URL or a scheme other than `http:` and
`https:`, where browsers would fail asynchronously and retry forever. The `headers` option is the same
extension Bun's `WebSocket` client has; `Accept` is always forced and `Last-Event-ID` from the caller
is sent until the server supplies an id. The class is a TypeScript builtin (`src/js/internal/event_source.ts`)
and `undici.EventSource` (previously a stub that did nothing) is the same class.

The global is a custom getter that evaluates the module on first access, not an entry in the global
object's static property table. The static table is reified in places where JavaScriptCore cannot run
JavaScript (the debug build aborts), which is why the 2023 implementation stopped working once
oven-sh/bun#5355 moved it into that table: its callback ran JavaScript and came back `undefined`.
While testing, a pre-existing bug turned up and was reported
separately rather than fixed here: a `Request` handed to a `Bun.serve` handler loses its `url` and
`headers` once the response has completed, unless they were read inside the handler.

Files: `src/js/internal/event_source.ts`, `src/jsc/bindings/ZigGlobalObject.cpp` (`getEventSourceConstructor`),
`src/js/thirdparty/undici.js`, `packages/bun-types/globals.d.ts` (`EventSourceInit.headers`, the
constructor type), `packages/bun-types/bun.d.ts` (drops the never-implemented `ref()`/`unref()`),
`docs/guides/http/sse.mdx`, `docs/runtime/web-apis.mdx`, `docs/runtime/bun-apis.mdx`,
`test/js/web/eventsource/eventsource.test.ts`, `test/integration/bun-types/fixture/globals.ts`.

### 2026-09-04: response compression for `Bun.serve`

`Bun.serve` sent every response uncompressed. A JSON API or an HTML page went over the wire at several
times its compressed size, and the ways around that were a reverse proxy in front (Caddy, nginx) or a
middleware that redoes content negotiation on top of `Bun.gzipSync`. oven-sh/bun#2726 asks for this and
has been open since 2023, and `RequestContext` carried a comment that asked for built-in compression for
as long. `Deno.serve` compresses by default. In bun it is opt-in, through a `compress` option:

```ts
Bun.serve({
  compress: true,
  routes: { "/": homepage },
  fetch: () => Response.json(report),
});

// The encodings to use, in order of preference, and the smallest body to encode.
Bun.serve({ compress: { encodings: ["br", "gzip"], threshold: 256 }, fetch });
```

The server uses the configured encoding that the request's `Accept-Encoding` gives the highest `q`
value, and a tie goes to the one that comes first in the configuration. Browsers send no `q` values, so
in practice the configured order decides. The parser follows RFC 9110 §12.5.3: a coding with `q=0` is
refused, `*` gives its weight to every coding that the header does not name, tokens are
case-insensitive, and `x-gzip` means `gzip`. The default order is `zstd`, `br`, `gzip`. `deflate` (the
zlib format, which is what HTTP means by it) is available but not in the default list. The levels suit
compression per request: zstd 3, brotli 4, gzip 6 through libdeflate. On a 38 KB JSON body zstd takes
0.06 ms and brotli 0.2 ms, and both come out at 5 to 6% of the original. On source text the three land
near 26%.

Bodies that are in memory are compressed: strings, buffers, `Blob`s, `Response.json()`, the responses
of `error()`, and static routes. A response goes out as it is when its body is a `Bun.file()`, a file
route, or a `ReadableStream` that still produces data, when the body is smaller than the threshold (1024
bytes by default) or does not get smaller, when the response already has a `Content-Encoding`, a
`Content-Range` or status 206, when its `Cache-Control` has `no-transform`, and when its type does not
compress. A stream whose data is already in memory, such as `blob.stream()`, is compressed like a buffer.
Text (but not `text/event-stream`), JSON, JavaScript, XML, WebAssembly, SVG and the other `+json` and
`+xml` types compress, and so do TrueType and OpenType fonts and BMP and ICO images. Other images, audio,
video, archives and WOFF fonts are compressed already.

A compressed response carries `Content-Encoding`, the compressed `Content-Length`, a `Vary` that
includes `Accept-Encoding` (merged into the handler's own `Vary`), and a weak `ETag` in place of a
strong one, because the bytes differ from the original (RFC 9110 §8.8.3). nginx does the same. Bun
compares `If-None-Match` for static routes, where the weak form matches. A `fetch` handler that compares
`If-None-Match` with `===` gets the weak form back from clients, so the docs tell it to drop the `W/`
first. A response that qualifies but goes out unencoded, because the request accepts none of the
encodings, carries the `Vary` too, so a shared cache keeps the variants apart. HEAD gets the headers
that GET gets, compressed length included. `server.reload()` applies a `compress` option and keeps the
current setting without one, as it does for `fetch` and `error`.

A static route is compressed once per encoding, on the first request that asks for that encoding, and
the result is kept. The encoded copy is a static route of its own, with its own body, headers and count
of responses in flight, so backpressure, HEAD and aborted requests take the paths they always took.
Conditional requests are evaluated on the original route. The `304` then carries the `ETag` and `Vary`
of the response that a 200 would be, which is the weak `ETag` for a request that gets an encoded copy
(RFC 9110 §15.4.5), and no `Content-Encoding`, since it has no content. An HTML import that `Bun.serve`
bundles in production is a set of static routes, so its page and its JavaScript and CSS chunks are
compressed as well. That includes the first requests, which wait for the bundle: each keeps the
encoding picked from its `Accept-Encoding`. The files that `bun build` writes are file routes and are
sent as they are. A route works out whether it can be compressed on its first request with `compress`
on, so a server without the option does no extra work.

Two details of the dynamic path. The encoding is picked when the request context is created, and only
when `compress` is on, because the uWS request is gone once a handler awaits. That costs the context one
byte. `render_metadata` negotiates after it knows the content type and before it writes headers, swaps
the body for the encoded bytes, and keeps the original body until it returns, because a `File` body's
name still sets `Content-Disposition`. The `Vary` and `ETag` that it replaces are removed from the
response's headers and written again, so nothing on that path can throw.

Left for later: streaming compression for `ReadableStream` bodies (server-sent events and React's
`renderToReadableStream`), `Bun.file()` bodies and file routes, a `level` option, and precompressed
`.br` and `.gz` files for directory routes. A pre-existing bug turned up on the way and was reported
separately rather than fixed here: a HEAD response has no `Date` header.

Files: `src/runtime/server/Compression.rs` (the option, `Accept-Encoding`, the encoders),
`src/runtime/server/RequestContext.rs` (`negotiate_encoding`, `render_metadata`, HEAD),
`src/runtime/server/StaticRoute.rs` (`Compressible`, `for_encoding`, 304 headers),
`src/runtime/server/HTMLBundle.rs` (pending responses), `src/runtime/server/ServerConfig.rs`,
`src/runtime/server/server_body.rs` (reload), `src/runtime/server/mod.rs`, `packages/bun-types/serve.d.ts`,
`docs/runtime/http/server.mdx`, `test/js/bun/http/bun-serve-compress.test.ts`,
`test/integration/bun-types/fixture/serve-types.test.ts`.

### 2026-09-05: `bun test --last-failed`

After a run with failures, the next thing anyone does is rerun the failures. Until now that meant
reading the file names out of the summary and typing them back as filters. `--last-failed` runs
only the test files that failed in the previous run, the way pytest's `--lf` and Playwright's
`--last-failed` do:

```sh
bun test
# 3 pass, 2 fail across 12 files

bun test --last-failed
# --last-failed: running 2/12 test files
```

A file counts as failed when a test in it fails, when it throws outside of any test (at load, in a
`describe` body, between tests), or when its `--parallel` worker crashes. Every run updates the
record for the files it ran: a file that fails is added, a file that passes is removed, and a file
the run did not reach keeps its entry. So `--last-failed` after `--bail`, a path filter or a shard
still knows about the failures that were not rerun, and running `--last-failed` until everything
passes empties the set, at which point it says so and exits 0. A deleted test file is forgotten. A
`--bail` exit records the file it stopped in before it goes. `--dry-run` leaves the record alone,
since nothing passes or fails, and `--parallel` workers leave the recording to the coordinator.
The filter runs before `--shard`, so a shard of the failed files is a shard of the failed files.

The record lives in Bun's user cache directory, next to the transpiler cache, as
`@test@/last-failed-<hash of the project root>.json`, so nothing is written into the project and
no `node_modules` is needed. The cache-directory lookup that the transpiler cache had inline
(`$XDG_CACHE_HOME/bun`, `~/Library/Caches/bun` on macOS, else `~/.bun/install/cache`) is now a
shared `user_cache_dir(leaf)`; the leaf is spelled so it cannot collide with a package name in the
install cache. A project whose runs never fail never gets a record. The file is written atomically
through a temp file and rename, like the `--timings` table.

The name follows `--rerun-each`, `--only-failures` (which only changes what is printed) and the two
tools above; Jest's `--onlyFailures` would have clashed with the existing flag.

Files: `src/runtime/cli/test/LastFailed.rs`, `src/runtime/cli/test_command.rs`,
`src/runtime/cli/test/parallel/Coordinator.rs`, `src/runtime/cli/test/parallel/runner.rs`,
`src/runtime/cli/Arguments.rs`, `src/options_types/context.rs`, `src/runtime/cli/mod.rs`,
`src/jsc/RuntimeTranspilerCache.rs` (`user_cache_dir`), `docs/test/discovery.mdx`,
`test/cli/test/test-last-failed.test.ts`.

### 2026-09-06: `sort` and `uniq` shell builtins

After `wc`, `head` and `tail`, the next two commands a script pipes into are `sort` and `uniq`, and
`sort | uniq -c | sort -rn` is the pipeline everyone writes to count things. Neither was a builtin,
so those pipelines only worked where coreutils happened to be installed, which on Windows is usually
nowhere. Both are now builtins on every platform, and both follow GNU coreutils byte for byte in every
case a 500-run fuzz against the real tools could find (random lines, random flag combinations, exit
codes included).

`sort` takes `-r`, `-n`, `-f`, `-u`, `-s`, `-b`, `-z`, `-c`, `-o FILE`, `-t CHAR` and `-k` with the
full `F[.C][OPTS][,G[.C][OPTS]]` key syntax, plus the long spellings. `-n` reads a number as GNU
does (leading blanks, a sign, digits, a fraction; a line with no number is 0), compares the digit
strings instead of converting to a float, so nothing overflows or rounds, and ties fall back to a
byte comparison of the whole line unless `-s` or `-u` is given. A key with its own letters (`-k2,2nr`)
ignores the global options, as in GNU. `-u` keeps the first of a run of equal keys in input order.
`-o` can name an input file, because everything is read before the output is opened. `-c` prints
`sort: file:N: disorder: line` and exits 1. `uniq` takes `-c`, `-d`, `-D`, `-u`, `-i`, `-f N`, `-s N`,
`-w N`, `-z`, the historical `-N`, the long spellings, and an output file as its second operand. The
three output switches combine the way GNU's do, so `-du` prints nothing and `-Du` only the later
copies. A last line without a newline gets one, and two files are not joined at a missing newline.

```ts
await $`sort -u names.txt`;
await $`sort -t, -k2 -n data.csv | head -n 10`;
const top = await $`sort visitors.txt | uniq -c | sort -rn | head -n 5`.text();
await $`sort -o deps.txt deps.txt`; // in place
if ((await $`sort -c CHANGELOG-versions.txt`.nothrow()).exitCode !== 0) {
  /* not sorted */
}
```

The two share one module, `sort_uniq.rs`, because they share their shape: read every input to the
end (stdin, `-`, or file operands, through the same `IOReader` the other readers use), rearrange the
lines in memory, write once. A `Program` enum holds the options of whichever command is running and
turns the input into the output; the state machine around it is the one `wc` uses, with the error
messages and exit codes of each command (`sort` exits 2 on an unreadable file or a usage error,
`uniq` 1, as the real ones do). Unreadable operands are reported and skipped, and the rest are still
sorted. Left out: `sort -h`, `-V`, `-R`, `-M`, `-g` and `-m` (reported as unsupported), `uniq --group`,
and caching the parsed numeric key per line, which would make `sort -n` on a million lines about three
times faster than it is today (the output is still identical to GNU's on that input).

While running clippy over the stack, yesterday's `--last-failed` patch had a `disallowed_methods`
hit (`Output::warn` instead of the `warn!` macro); that commit was amended.

Files: `src/runtime/shell/builtin/sort_uniq.rs`, `src/runtime/shell/Builtin.rs`,
`src/runtime/shell/mod.rs`, `src/runtime/shell/IOReader.rs`, `docs/runtime/shell.mdx`,
`test/js/bun/shell/commands/sort.test.ts`, `test/js/bun/shell/commands/uniq.test.ts`,
`test/js/bun/shell/exec.test.ts`.

### 2026-09-08: `expect.poll()`

A lot of tests assert on something that becomes true a little later: a server that is still
starting, a watcher that has not written its file yet, a queue that drains in the background, a
subprocess that needs a moment. `bun:test` had nothing for this, so tests either sleep for a fixed
time (slow when generous, flaky when not, and the repo's own test guide bans it) or hand-roll a retry
loop around `expect()`. `expect.poll()` is that loop, with the matchers everyone already knows: it
takes a callback that produces the value and returns the same matchers as `expect()`, each returning
a promise. An attempt calls the callback, awaits it if it returns a promise, and runs the matcher.
While the callback throws or the matcher fails, the next attempt starts `interval` ms later (50 by
default), until one passes or `timeout` ms (1000) have gone by. The API is Vitest's `expect.poll()`,
which Playwright has as well.

```ts
await expect.poll(() => server.requests).toHaveLength(3);
await expect
  .poll(async () => (await fetch(`${url}/health`)).status, { timeout: 10_000 })
  .toBe(200);
await expect.poll(() => readdirSync(outdir)).toContain("index.js");
await expect.poll(() => queue.pending).not.toContain(job);
```

When the timeout runs out, the failure is the last attempt's matcher error under a line that says
what happened, and it points at the `expect.poll()` call rather than into a timer callback:

```txt
5 |   await expect.poll(() => queue.pending, { timeout: 500 }).toHaveLength(0);
                                                             ^
error: expect.poll() timed out: the value did not pass within 500ms (10 attempts)

expect(received).toHaveLength(expected)

Expected length: 0
Received length: 1
```

A callback that still throws at the end is reported with its last error as the `cause`, and a
promise from the callback that never settles is given up on at the deadline instead of hanging the
test until its own timeout, which is the one place this is stricter than Vitest (whose timeout only
stops new attempts). The callback runs at least once, even with `timeout: 0`, and the wait between
attempts is capped by the time remaining, so a long `interval` still gets a final attempt at the
deadline. `.not` works, custom matchers from `expect.extend()` and the mock matchers work, and
asymmetric matchers work inside arguments as usual. `.resolves` and `.rejects` (the value is awaited
anyway), `toThrow()` (a throwing callback is retried) and the snapshot matchers throw a `TypeError`
that says why. Vitest refuses the same set. The `message` option is passed through as
`expect(value, message)`, so it replaces the `expect(received).toX()` line. For `expect.assertions(n)` a poll counts once however
many attempts it took, which needed one bit on the native `Expect` (`counts_as_assertion`, cleared
for retries). Fake timers would freeze the retry loop, so `expect.poll()` rejects with "needs real
timers" while `jest.useFakeTimers()` is active rather than hanging. Making it tick in real time
regardless, as Vitest does, needs a timer kind that the fake clock does not capture and is left for
another day.

The implementation is a small internal module (`internal/test/poll`) behind a builtin `poll` on the
`Expect` constructor, the way `Glob.prototype.scan` is wired: a `Proxy` hands out one function per
matcher name found on `Expect.prototype`, and the retry loop is plain `async`/`await` over
`Bun.sleep`, with `Bun.nanoseconds()` as the clock so a mocked `Date`/`performance` cannot confuse
it. The error object is created synchronously in the matcher call, while the test is on the stack,
and gets its message filled in at the end, which is what makes the code frame land on the right line.
The types map `Matchers<T>` to promise-returning signatures and drop the unsupported ones, so custom
matcher declarations merged into `Matchers` show up on `expect.poll()` too.

Files: `src/js/internal/test/poll.ts`, `src/js/builtins/Expect.ts`,
`src/runtime/test_runner/expect.bind.ts`, `src/runtime/test_runner/expect.rs`
(`counts_as_assertion`, `js_dont_count_as_assertion`), `src/runtime/test_runner/timers/FakeTimers.rs`,
`src/codegen/generate-js2native.ts`, `src/codegen/bindgen-lib-internal.ts` and
`src/codegen/bindgen-emit.ts` (a `builtin` can be a `static` member of a class),
`docs/project/bindgen.mdx`, `test/internal/bindgen.test.ts`, `packages/bun-types/test.d.ts`,
`docs/test/writing-tests.mdx`, `test/js/bun/test/expect-poll.test.ts`,
`test/integration/bun-types/fixture/test.ts`.

### 2026-09-09: `%c` styling in `console.log()`

In browsers, `console.log("%cDone", "color: green; font-weight: bold")` prints a bold green
"Done". Deno does the same in a terminal. Node.js swallows the CSS argument and prints plain text,
and so did Bun: the formatter parsed the `%c`, took its argument off the list, and hit a
`// TODO: Implement %c`. Now, when the stream has colors on, the CSS is rendered as one SGR escape
sequence, so the one-liner everybody tries before reaching for chalk just works, and code shared
with the browser keeps its colors:

```ts
console.log("%cReady%c in %dms", "color: green; font-weight: bold", "", 120);
console.log(
  "%c DEPRECATED %c use open() instead",
  "background-color: #c0392b; color: white",
  "",
);
console.error("%cconfig file not found", "text-decoration: underline");
```

The properties a terminal can show are mapped: `color` and `background-color` (or a `background`
that is just a color), `font-weight: bold` (or `bolder`, or 600 and up), `font-style: italic`, and
`text-decoration`/`text-decoration-line` with `underline`, `line-through` and `overline`. Everything
else (`font-size`, `padding`, `border`, ...) is ignored, as are values that do not parse, and
within one `%c` a later declaration overrides an earlier one, `!important` or not, as CSS would
have it. Color values go through the CSS parser that `Bun.color()` and the bundler use, so named
colors, hex, `rgb()`/`hsl()`/`hwb()` in both syntaxes, `lab()`/`oklch()` and `color(display-p3 ...)`
all work, and they come out as 24-bit, 256-color or 16-color codes depending on what the terminal
supports (`COLORTERM`, `TERM`, `FORCE_COLOR=1/2/3`), which is the choice `Bun.color(x, "ansi")`
already makes. `transparent`, `inherit`, `initial` and `currentcolor` select the terminal's default.

Each `%c` starts from the default style rather than adding to the previous one, which is what
browsers do, so `%c` with an empty string switches styling off. The style ends where the format
string ends: a reset is written before the remaining arguments, the way Deno does it. A `%o`, `%O`
or non-string `%s` substitution inside a styled run prints its own colors and resets, so the `%c`
sequence is written again after it and the text that follows stays styled. With colors off (not a
TTY, `NO_COLOR`, `FORCE_COLOR=0`) nothing changes: the argument is consumed and nothing is printed
for it. Only string arguments are read as CSS; anything else clears the style instead of getting a
`toString()` call that would only happen on a TTY.

The xterm palette matching that `Bun.color()` had privately (tmux's cube-or-grey-ramp pick, and
the 256-to-16 table) moved to `bun_core::output` next to `ColorDepth`, as `ansi_palette` plus a
`ColorDepth::write_sgr_color()` that both callers now use; `Bun.color()`'s `ansi*` outputs are
byte-for-byte unchanged (its 1000-case test file agrees).

Files: `src/jsc/ConsoleStyle.rs` (CSS subset to SGR), `src/jsc/ConsoleObject.rs`
(`write_with_formatting`), `src/bun_core/output.rs` (`ansi_palette`, `write_sgr_color`),
`src/css_jsc/color_js.rs`, `src/css/values/color.rs` and `src/css/css_parser.rs` (two helpers made
public), `src/jsc/Cargo.toml`, `docs/runtime/console.mdx`, `test/js/web/console/console-log.test.ts`.

### 2026-09-10: `with { type: "bytes" }` imports and the `bytes` loader

Getting the bytes of a file that ships with the code took a different dance in every environment:
`Bun.file(new URL("./model.onnx", import.meta.url)).bytes()` in Bun, `fs.readFileSync` in Node,
`fetch` in a browser bundle, and none of them survives `bun build` moving the file, or `--compile`
putting it inside the executable, without more glue. The TC39 [Import Bytes](https://github.com/tc39/proposal-import-bytes)
proposal (stage 2.7) settles the syntax: `import bytes from "./photo.png" with { type: "bytes" }`
gives a `Uint8Array`, the way `type: "json"` gives an object. Deno ships it behind a flag, esbuild
has had the same thing as its `binary` loader for years, and in Bun the attribute silently fell
through to the `file` loader and produced a path string (oven-sh/bun#20824). Now it is a loader of its
own, in the runtime, in `bun build` for every target, in `bun build --compile` and in the dev server:

```ts
import wasm from "./add.wasm" with { type: "bytes" };
import font from "./Inter.ttf" with { type: "bytes" };

const { instance } = await WebAssembly.instantiate(wasm);
console.log(font.byteLength, font instanceof Uint8Array); // 310252 true

const { default: model } = await import("./model.onnx", {
  with: { type: "bytes" },
});
```

The default export is the only export (a named import is the usual "This loader type only supports
the default import" error), every import of one file shares one `Uint8Array`, and the extension does
not matter; `--loader .bin:bytes`, `[loader]` in bunfig.toml and `loader: { ".bin": "bytes" }` in
`Bun.build` apply it by extension, and a `Bun.build` plugin can return `{ contents: uint8array,
loader: "bytes" }` to generate binary modules. With TypeScript 7.1 the import is typed
`Uint8Array<ArrayBuffer>` through the same `declare module "*" with { type }` table that types
`text` and `sqlite` imports. What happens underneath depends on where the module runs:

- In the runtime the file is read when the module is first imported and the array adopts the
  buffer it was read into; `require()` works as for any other module. `bun --watch` and `--hot`
  watch the file like any other import.
- `bun build` inlines the contents as base64 and wraps them in a new runtime helper, so the output is
  `var font_default = __toBytes("AAEAAA...")`, decoded once when the module is evaluated. The bytes
  are the file's, exactly: the bundler's shared reader strips a UTF-8 byte order mark and re-encodes
  UTF-16, which is right for source text, so bytes modules read the file themselves (the `file`
  loader's copies go through that reader too and are not exact; reported separately). `__toBytes`
  calls `Uint8Array.fromBase64` where the engine has it (Bun, current Node and browsers) and falls
  back to a small table decoder (esbuild's) elsewhere, so `--target=node` output still runs on older
  Node LTS lines and a browser bundle on last year's browsers. With `--splitting` the helper is imported across chunks like
  any other runtime function; with `--minify` it all shrinks as usual; an unused bytes import is
  dropped with its base64. A dynamic `import()` without `--splitting`, or a `require()`, gives the
  module the CommonJS shape and ESM importers read it through `__toESM`, which defined one getter
  per own property of `module.exports`, that is one per byte; it now skips typed arrays, which have
  nothing to import by name (a CommonJS module that exports a `Buffer` benefits the same way). One
  base64 copy serves both the module and a CSS `url()` that points at the file, which becomes a
  `data:` URL as it does for the text loader.
- `bun build --compile` embeds the file in the executable as it is, next to `type: "file"` assets,
  and the module becomes `require("/$bunfs/...")`, which the module loader answers with a
  `Uint8Array` over a copy of the section bytes. No base64 in the binary, nothing decoded at
  startup, and `--bytecode` works since the `require` prints per output format. The copy is
  deliberate: a `Uint8Array` is writable and the section is shared (and handed out elsewhere as
  Latin-1 strings and `Blob`s). Once JavaScriptCore has immutable `ArrayBuffer`s, which the proposal
  specifies anyway, this can become a zero-copy view. Like text modules, bytes modules keep their
  `[name]-[hash]` asset path regardless of `--asset-naming` and stay out of `Bun.embeddedFiles`.
- The dev server prints lazy-export modules itself (`hmr.cjs.exports = ...`) and its chunks never
  link the bundler runtime, so there the parse step emits `hmr.require("bun:wrap").__toBytes("...")`
  and the HMR runtime's synthetic `bun:wrap` module gained `__toBytes`.

The loader is `Loader::Bytes = 22` (`api::Loader::bytes = 23`, `BUN_LOADER_BYTES` for native
plugins) and joins `text` in every table that lists loaders: printer (`with { type: "bytes" }` is
preserved by `--no-bundle`), metafile, CSS imports, `Bun.Transpiler` (rejected, there is no source
text to produce), the parallel test runner's loader names. Like `.text`, `.file` and `.sqlite`, a
`.bytes` extension now selects the loader of the same name. The
bundler's lazy-export path needed no new machinery: the parse task produces the base64
`E::String` and `generate_code_for_lazy_export` wraps it in the call and registers the runtime
import on whichever part ends up holding it, exactly as it already does for `__require` around
embedded `.node` and SQLite files. esbuild's `dataurl` and `base64` loaders, which Bun accepts by
name and silently compiles to an empty module (the bundler docs even use `dataurl` in an example),
are the obvious follow-up and would reuse all of this. While writing the plugin test a pre-existing
bug turned up and was reported separately rather than fixed here: a `Bun.build` plugin's `onLoad`
sees `args.loader` from the file extension and, when it returns no `loader`, the import attribute's
loader is ignored, so `with { type: "text" }` plus a contents-only plugin fails to parse.

The fork's bun-types workflow went red today for a reason outside the stack: the types fixture
installs `@types/node@latest`, and today's release breaks eight of bun-types' own fixture checks
upstream as well (`fs/promises` `exists`, `TextEncoderEncodeIntoResult`, `TLSSocket`, ...). One
ninth diagnostic was soup's: the 2026-09-01 `EventSource` fixture assigned `events.onerror = null`,
and the `undici-types` that the new `@types/node` pulls in types that handler as non-nullable. That
commit's fixture now assigns a function; the rest clears up when upstream catches up with
`@types/node`.

Files: `src/ast/loader.rs`, `src/options_types/schema.rs`, `src/options_types/bundle_enums.rs`,
`src/codegen/replacements.ts`, `packages/bun-native-bundler-plugin-api/bundler_plugin.h`,
`src/runtime.js` (`__toBytes`), `src/bundler/ParseTask.rs`, `src/bundler/bundle_v2.rs`,
`src/bundler/linker_context/generateCodeForLazyExport.rs`, `src/bundler/linker_context/MetafileBuilder.rs`,
`src/bundler/LinkerContext.rs`, `src/bundler/transpiler.rs`, `src/bundler_jsc/options_jsc.rs`,
`src/js_parser/p.rs`, `src/js_printer/lib.rs`, `src/runtime/jsc_hooks.rs` (`bytes_module_value`, the
standalone-graph fetch), `src/standalone_graph/StandaloneModuleGraph.rs`, `src/runtime/bake/hmr-module.ts`,
`src/runtime/bake/bake.private.d.ts`, `src/runtime/cli/test/parallel/runner.rs`, `packages/bun-types/bun.d.ts`,
`packages/bun-types/ts7.1/import-attributes.d.ts`, `docs/bundler/loaders.mdx`, `docs/runtime/file-types.mdx`,
`docs/bundler/executables.mdx`, `docs/bundler/esbuild.mdx`, `docs/bundler/index.mdx`, `docs/bundler/plugins.mdx`,
`docs/runtime/plugins.mdx`, `test/js/bun/util/bytes-loader.test.ts`, `test/bundler/bundler_loader.test.ts`,
`test/bundler/bundler_compile.test.ts`, `test/bundler/bundler_plugin.test.ts`, `test/bake/dev/bundle.test.ts`,
`test/bundler/expectBundled.ts`, `test/js/bun/transpiler/transpiler-unsupported-loader.test.ts`,
`test/integration/bun-types/fixture/ts7.1/import-attributes.ts`.

### 2026-09-11: `publishConfig` overrides in `bun pm pack` and `bun publish`

A library in a monorepo wants two different `package.json`s. While it is developed, `main`, `types`
and `exports` should point at the TypeScript sources, so the other workspaces, the editor and
`bun --hot` see a change without a build. Once published they have to point at `dist/`, because
that is all the tarball contains. pnpm and yarn solve this with `publishConfig`: an entry there
that is named after a manifest field replaces that field in the published `package.json`. bun read
only `tag` and `access` from `publishConfig`, so a package written this way was published pointing
at `./src/index.ts`, a file that is not even in the tarball (oven-sh/bun#19205; a community PR for it
was closed unmerged). Now `bun pm pack` and `bun publish` apply the overrides:

```json
{
  "name": "@acme/ui",
  "version": "1.0.0",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "bin": "./src/cli.ts",
  "files": ["dist"],
  "publishConfig": {
    "access": "public",
    "main": "./dist/index.js",
    "types": "./dist/index.d.ts",
    "exports": {
      ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" }
    },
    "bin": "./dist/cli.js"
  }
}
```

```sh
bun pm pack && tar -xzOf acme-ui-1.0.0.tgz package/package.json
# {
#   "name": "@acme/ui",
#   "version": "1.0.0",
#   "main": "./dist/index.js",
#   "types": "./dist/index.d.ts",
#   "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
#   "bin": "./dist/cli.js",
#   "files": ["dist"],
#   "publishConfig": { "access": "public" }
# }
```

The fields are pnpm's list, which contains yarn's: `bin`, `main`, `module`, `browser`, `exports`,
`imports`, `type`, `types`, `typings`, `typesVersions`, `esnext`, `es2015`, `unpkg`, `umd:main`,
`os`, `cpu` and `libc`. The semantics are pnpm's too, so a package gets the same manifest from
either tool: the value replaces the top-level field where it stands, or is appended when there is
none (in `publishConfig` order), the entry moves out of `publishConfig`, and a `publishConfig` that
ends up empty is dropped. Anything else in `publishConfig` (`access`, `tag`, `registry`,
`directory`, ...) stays put and overrides nothing, so `name`, `version`, `scripts`, `dependencies`
and `files` cannot be swapped at publish time. A `publishConfig` that is not an object is ignored.
The `package.json` on disk is only read.

An overriding `bin` is a real `bin`: the file list is computed from the edited manifest, so
`./dist/cli.js` above is packed even when `files` would not match it and gets its executable bit,
and `./src/cli.ts` is no longer pulled in as a bin. The overrides are applied after `prepack` and
`prepare` have run (they may rewrite `package.json`, and pack re-reads it), and `bun publish` builds
the registry metadata from the same edited tree, so `versions[v].main`/`exports`/`bin` in the
packument agree with the tarball. Publishing an existing tarball (`bun publish ./pkg.tgz`) leaves
its `package.json` alone, as before.

The implementation is one function, `apply_publish_config_overrides`, called from
`edit_root_package_json`, which is where pack already rewrites `workspace:` and `catalog:` versions
and whose tree both the tarball and `normalized_package` print. `published_files` reads a copy of
the manifest with the same overrides applied. A workspace that is packed as a bundled dependency
gets its own overrides too, since it contributes what its own tarball would contain.
Not done: `publishConfig.directory` (publishing a subdirectory, with its own manifest) and
`publishConfig.executableFiles`, which are separate features, and `bun pm diff`, whose local side
reads `package.json` raw (it does not resolve `workspace:` either), so for a package that uses
overrides it reports them as a `package.json` change against the registry.

The fork's bun-types workflow is still red for the reason described on 2026-09-10: it installs
`@types/node@latest`, and upstream's own pull requests fail the same checks until oven-sh/bun#42230
(or a newer `@types/node`) lands. Nothing in the stack causes it.

Files: `src/runtime/cli/pack_command.rs`, `docs/pm/cli/publish.mdx`, `docs/pm/cli/pm.mdx`,
`docs/pm/workspaces.mdx`, `test/cli/install/bun-pack.test.ts`, `test/cli/install/bun-publish.test.ts`.

### 2026-09-12: `import.meta.glob()`

Picking up a directory of pages, routes, locales, migrations or plugins without keeping a list of
them by hand is what Vite's [`import.meta.glob`](https://vite.dev/guide/features.html#glob-import)
is for, and code written against it is one of the first things that breaks when a Vite project is
run or bundled with Bun. oven-sh/bun#6060 has asked for it since 2023. RiskyMH implemented most of
it in Zig (oven-sh/bun#21459, everything but `eager`), and that pull request was closed in June only
because the Rust rewrite removed every file it touched. This redoes it against the Rust parser,
adds `eager`, and follows Vite's rules for keys and options closely enough that the Vite docs
describe it:

```ts
const pages = import.meta.glob("./pages/*.tsx");
// { "./pages/about.tsx": () => import("./pages/about.tsx"),
//   "./pages/home.tsx": () => import("./pages/home.tsx") }
const { default: Home } = await pages["./pages/home.tsx"]();

const locales = import.meta.glob<Record<string, string>>("./locales/*.json", {
  eager: true, // import statements instead of import()
  import: "default", // one export instead of the namespace
});
locales["./locales/fr.json"].hello;

const queries = import.meta.glob(["./sql/**/*.sql", "!**/*.draft.sql"], {
  with: { type: "text" }, // import attributes for every import
  import: "default",
  eager: true,
}); // { "./sql/users/by-id.sql": "select ..." }
```

It works the same in `bun run`, `bun test`, `bun build` (plain, `--splitting`, `--format=cjs`,
`--minify`, `--compile`) and the dev server, because it happens in one place: the parser's visit
pass. `import.meta.glob` as a call target becomes a new `E::Special::ImportMetaGlob`, the way
`import.meta.hot.accept` already does, and `e_call` replaces the whole call with an object literal
once the arguments have been visited and constant-folded (so a template literal or `"./a/" + "*"`
is fine, a variable is an error, and a call in dead code is never expanded). Everything after that
sees ordinary imports:

- Lazy entries go through `transpose_import`, the function behind every hand-written
  `import("...")`, so import records, `with { type }` loaders, chunk splitting and the bundler's
  dynamic-import tree shaking need nothing new. With `import: "name"` the entry is
  `async () => (await import("./a.ts")).name` and the parser records the same bookkeeping that
  expression gets when a person writes it, so `bun build` keeps only that export of each matched
  module, split chunks included.
- Eager entries queue `import * as __bun_glob_0_0 from` (or `import { name as __bun_glob_0_0 }`)
  statements that are emitted as one part ahead of the user's code, next to the JSX and runtime
  auto-imports. `ImportScanner` then treats them as it treats written imports: TypeScript's
  unused-import pass, named-import records for the linker, and the dev server's conversion to
  `hmr.imports` all apply, and an eager `import: "name"` tree-shakes like `import { name }`.

The matching itself is `bun_glob`'s walker, run from the importing file's directory (or `base`), so
directory names full of glob metacharacters (`pages/[id]/`) never enter a pattern. The rules are
Vite's: patterns start with `./` or `../` (relative to the file) or with `/` or `**` (relative to
the project root, which is the directory bun was started in), anything else is an error so that
package names and tsconfig aliases stay available; `!` patterns remove matches; keys are sorted,
`/`-separated, relative to the file unless some pattern is rooted, in which case all of them start
with `/`; the specifiers always stay relative to the file; the importing file never matches itself;
dotfiles and `node_modules` are skipped unless `exhaustive: true`; `base` moves where relative
patterns match and what the keys are relative to; `query` (string or object of literals) is
appended to every specifier. `with` is Bun's addition, since import attributes are how Bun selects
loaders, and the deprecated `as` option is rejected with a message that says what to write instead.
Options have to be literals, unknown ones are errors (a typo in `eager` should not silently turn
into lazy loading), and every error points into the call.

Two things needed care. A file whose output depends on the directory listing must not come out of
the runtime transpiler cache, which now covers files from 4 KiB up: the parser clears the cache key
for any file that expands a glob (as it does for macros), and the cache version is bumped so entries
written by a bun that left the call alone are not read back. And the call is only expanded in
modules that are files on disk: `Bun.Transpiler` input and plugin-made virtual modules have no
directory to match in, so there the call is left exactly as written.

Not done: noticing added or removed files in `--watch`, `--hot` and the dev server. Editing a
matched file reloads like any import, but a new file is only matched the next time the importing
file is transpiled. The dev server already sees the directory change and logs "nothing to bundle",
which is where a list of globbed directories per module would hook in. Patterns also cannot use
tsconfig path aliases, which Vite resolves through its plugin pipeline. While testing `query`, a gap
in `bun build` turned up and was reported separately: specifiers with a query string
(`./icon.svg?raw`, `./x.ts?v=1`) resolve in the runtime but not in the bundler, so there `query`
only works through a plugin's `onResolve` (one of the tests does exactly that) and `with` is the
portable spelling.

The fork's bun-types workflow is red for the reason described on 2026-09-10, as is upstream's on
main: the types test installs `@types/node@latest` and oven-sh/bun#42230 is still open. The new
fixture lines add no diagnostics to that run.

Files: `src/js_parser/import_meta_glob.rs` (new), `src/js_parser/fold.rs`, `src/js_parser/visit/visit_expr.rs`,
`src/js_parser/p.rs`, `src/js_parser/parse/parse_entry.rs`, `src/js_parser/scan/scan_side_effects.rs`,
`src/js_parser/lib.rs`, `src/js_parser/Cargo.toml`, `Cargo.lock`, `src/ast/e.rs`, `src/js_printer/lib.rs`,
`src/react_compiler/lowering/build_hir/expr.rs`, `src/jsc/RuntimeTranspilerCache.rs`,
`packages/bun-types/bun.d.ts`, `packages/bun-types/globals.d.ts`, `docs/runtime/glob-imports.mdx` (new),
`docs/runtime/module-resolution.mdx`, `docs/docs.json`, `test/js/bun/resolve/import-meta-glob.test.ts`,
`test/bundler/bundler_import_meta_glob.test.ts`, `test/bake/dev/bundle.test.ts`,
`test/integration/bun-types/fixture/globals.ts`.

### 2026-09-13: SOCKS5 proxies for `fetch()` and `bun install`

`fetch`'s `proxy` option and the `HTTP_PROXY`/`HTTPS_PROXY` variables took `http://` and `https://`
proxies and nothing else: a `socks5://` URL failed every request with `UnsupportedProxyProtocol`. That
leaves out the proxy `ssh -D` opens, a local Tor client, and a good share of corporate and scraping
setups. It cannot be fixed from userland either, because the HTTP client owns the socket: node's proxy
agents do not apply to Bun's `fetch`, and the packages written to fill the gap reimplement HTTP on top
of `Bun.connect` and lose everything else `fetch` does. oven-sh/bun#16812 (42 upvotes, open since
January 2025) links two older requests for the same thing, and its thread is people trading those
workarounds. Now the URL just works, in the option and in the environment, for `fetch`, `node:http`
(which sits on the same client) and `bun install`:

```ts
await fetch("https://example.com", { proxy: "socks5://127.0.0.1:1080" });

// RFC 1929 username/password, percent-decoded from the URL
await fetch("http://intranet.corp/", {
  proxy: "socks5://build:s3cr%40t@bastion.example.com",
});
```

```sh
ssh -N -D 1080 bastion.example.com &
HTTP_PROXY=socks5://127.0.0.1:1080 HTTPS_PROXY=socks5://127.0.0.1:1080 bun install
```

The hostname always goes to the proxy as a name (an IP literal as an address), so the proxy resolves
it: names only its network knows and `.onion` addresses work, and no DNS query leaves the machine.
That is what curl calls `socks5h://`; both spellings are accepted and mean the same, as in Go's
`net/http`. The port defaults to 1080. Twelve new `error.code` values say why a proxy did not connect
(`SocksProxyConnectionRefused`, `SocksProxyHostUnreachable`, `SocksProxyAuthenticationFailed`,
`SocksProxyInvalidResponse` when the URL points at something that is not a SOCKS5 server, ...), each
with a one-line message, and `verbose: true` prints the negotiation.

The protocol lives in `src/http/socks5.rs` as a `Handshake` that does no I/O: it is built with the
three messages it may have to send (greeting, username/password, CONNECT), is fed whatever the socket
read, buffers a partial reply, and says "need more", "established" (with any bytes that followed the
reply) or which error. A reply whose first byte cannot start a SOCKS message is rejected at once, so
an HTTP server on the proxy port fails fast instead of waiting for a timeout, and at most 262 bytes are
ever buffered. `HTTPClient` drives it from three hooks, all gated on the proxy URL's scheme so that
nothing changes for other requests: `on_writable` starts the negotiation on a fresh connection instead
of writing the request (the request stage parks at `ProxyHandshake`, where a CONNECT proxy's does),
`on_data` feeds replies in, and `send_initial_request_payload` writes an ordinary origin-form request
once the socket is a pipe to the origin. For an `https://` target the end of the negotiation is where
a `200` to `CONNECT` leaves an HTTP proxy's socket, so it starts the same `ProxyTunnel`: the TLS
handshake with the origin, certificate verification against the origin's name, `checkServerIdentity`
and the `tls` options all run inside it unchanged, and so does keep-alive, since the pool already
files a tunnel under proxy, target and credentials.

Pooling is where the care went. A socket that has been through a SOCKS CONNECT reaches one target,
but the pool files a tunnel-less socket under the address it was dialed at, which is the proxy's. So a
plain `http://` request through SOCKS is neither taken from the pool (it could be handed a socket to
an HTTP proxy listening on the same port, which "mixed port" proxies do) nor parked there: each one
opens its own connection through the proxy. A redirect renegotiates for every hop, and may change
proxy kind on the way when `HTTP_PROXY` and `HTTPS_PROXY` differ. The tunnel pool key hashes the
scheme and the URL's raw username and password, not the `Proxy-Authorization` value it is built from
for HTTP proxies: a self-review showed that one goes missing when `proxy.headers` carries its own or
when the userinfo is not valid percent-encoding, and two SOCKS identities must never share a
connection, because Tor hands out circuits per credential. A `unix:` socket request ignores a SOCKS
proxy from the environment, as it in effect ignores any other. The timer follows the client's rule
that reads do not extend a deadline: each message the proxy has to answer gets one window, and the TLS
handshake inside the tunnel gets a fresh one.

Not done: SOCKS4/4a (still `UnsupportedProxyProtocol`), GSSAPI, resolving the name locally for
`socks5://` the way curl does, keep-alive for `http://` origins (a pool key with the target in it would
do), and `WebSocket`'s `proxy` option, which has its own client. `ALL_PROXY` was on this list until
upstream added the variable on 2026-09-15 (oven-sh/bun#42692). Upstream leaves a `socks5://` value in
it alone because its client cannot speak SOCKS; this patch lets `socks5://` and `socks5h://` through,
so `ALL_PROXY=socks5://127.0.0.1:1080`, the usual way to name a SOCKS proxy, works for `fetch` and
`bun install`. Three older bugs turned up while testing and were reported separately rather than
fixed here: a proxy URL with a username and no password (`http://user@host:8080`, the usual shape of a
Tor isolation token) was parsed as the hostname `user@host` (fixed upstream in the same PR since);
`bun install --cafile`/`--ca` does not reach the TLS handshake inside any proxy tunnel, so
a private registry behind a proxy fails certificate verification (the install test here uses
`NODE_TLS_REJECT_UNAUTHORIZED=0` for that reason); and `verbose: true` has lost the `>` in front of
request lines.

The fork's bun-types workflow should be green again with this push: a newer `@types/node` ended the
breakage described on 2026-09-10, and the types test passes locally on the rebased stack.

Files: `src/http/socks5.rs` (new), `src/http/lib.rs`, `src/http/HTTPThread.rs`, `src/http/InternalState.rs`,
`src/http/error.rs`, `src/url/lib.rs` (`is_socks5`, default port), `src/dotenv/env_loader.rs` (`all_proxy`),
`src/runtime/webcore/fetch/FetchTasklet.rs` (error messages), `packages/bun-types/globals.d.ts`,
`packages/bun-types/bun.d.ts`, `docs/guides/http/proxy.mdx`,
`docs/runtime/networking/fetch.mdx`, `test/js/bun/http/proxy.test.ts` (43 tests against an in-process
SOCKS5 server), `test/js/bun/http/proxy-stress-errors.test.ts`, `test/integration/bun-types/fixture/fetch.ts`.

### 2026-09-14: `Bun.JWT`

Bun has the pieces of an authenticated HTTP service built in (`Bun.serve`, `Bun.password`,
`Bun.CSRF`, `Bun.Cookie`, `Bun.secrets`, the SQL and Redis clients), and then every one of those
services installs `jsonwebtoken` or `jose` to issue and check its tokens. oven-sh/bun#27727 asks for
the missing piece. `Bun.JWT` is three synchronous functions next to `Bun.CSRF`: `sign`, `verify` and
`decode`, for JWTs in the JWS compact form with every signature algorithm in common use (`HS256/384/512`,
`RS256/384/512`, `PS256/384/512`, `ES256/384/512`, `EdDSA`, plus RFC 9864's name `Ed25519`).

```ts
const token = Bun.JWT.sign({ sub: "user_123" }, secret, { expiresIn: "2h" });
const { sub } = Bun.JWT.verify(token, secret);

// Asymmetric: the algorithm follows from the key (here ES256, RS256 or EdDSA).
const privateKey = await Bun.file("private.pem").text();
const signed = Bun.JWT.sign({ sub: "user_123" }, privateKey, {
  issuer: "https://auth.example.com",
  audience: "api",
  keyId: "2026-01",
});
try {
  Bun.JWT.verify(signed, publicKey, {
    issuer: "https://auth.example.com",
    audience: "api",
    maxAge: "1h",
  });
} catch (error) {
  error.code; // "ERR_JWT_EXPIRED", "ERR_JWT_CLAIM_VALIDATION_FAILED", ...
}

// A JWKS: read the unverified header to pick the key, then verify with it.
const { kid } = Bun.JWT.decode(signed).header;
const key = jwks.keys.find(key => key.kid === kid);
Bun.JWT.verify(signed, key);
```

A key can be a secret (string or bytes), a PEM string or the bytes of a PEM file (PKCS#8, PKCS#1,
SEC1, SPKI, X.509 certificates), a `KeyObject`, a `CryptoKey` (non-extractable ones included) or a
JSON Web Key object as served by a JWKS endpoint. The option names are `jsonwebtoken`'s where it has
them (`expiresIn`, `notBefore`, `issuer`, `audience`, `subject`, `algorithms`, `clockTolerance`,
`maxAge`, `ignoreExpiration`, `complete`, ...) so that switching is mostly a find and replace, with
`jose`'s `requiredClaims` and `currentDate` added. The ones that differ (`jwtid`, `keyid`,
`clockTimestamp`) are errors that name the option that was meant, as is any other unknown name.
Failures are `JWTError`s with a `code` from `ErrorCode.ts`, and `expiredAt`, `date` or `claim` where
that helps.

The part that needed thought is what a verifier must never do, because the header that names the
algorithm is written by whoever made the token:

- The kind of key decides which algorithms are acceptable, not the token. A secret verifies `HS*` only,
  an RSA key `RS*`/`PS*`, an EC key the one `ES*` of its curve, an Ed25519 key `EdDSA`. A `CryptoKey`,
  or a JWK with an `alg`, verifies exactly the algorithm it names. `algorithms` can narrow that, never
  widen it.
- A string or buffer with a `-----BEGIN` header anywhere in it is parsed as PEM or refused. It is never
  an HMAC secret, which closes the classic confusion attack (an `HS256` token signed with the text of
  the RSA public key) for every way of passing the key. A secret `KeyObject` is the explicit way out.
- `none` does not exist, a `crit` header is refused (RFC 7515 4.1.11), five-part tokens are reported
  as unsupported JWE, and segments must be valid UTF-8 JSON objects in canonical, unpadded base64url.
  Canonical means the unused bits of the last character are zero: otherwise one signed token has up to
  16 spellings that all verify, enough to walk past a deny list keyed on the token string.
- RSA keys under 2048 bits are refused for signing and verifying (RFC 7518 3.3), an empty secret is
  refused however it is passed, ECDSA signatures must have the exact P1363 length, HMACs are compared
  in constant time.
- A JWK's `use`, `alg` and `key_ops` are respected. JWKs are plain objects, so the cache remembers the
  members an entry was made from: one that is rotated or restricted in place (`Object.assign(jwk, next)`,
  `jwk.alg = "RS256"`) does not keep verifying as what it used to be.
- The signature is checked before the payload is parsed. Options are the object's own properties, read
  exactly once onto an object without a prototype: an accessor cannot show validation one value and use
  another, and a polluted `Object.prototype` (`ignoreExpiration = true`) cannot switch a check off. A
  name that is not an option throws instead of being a check that is silently not made (`{ jwtid }`,
  `{ audiance }`, a singular `algorithm`). `requiredClaims` looks at own properties, so
  `["constructor"]` is not satisfied by every object.
- Error messages never contain the key: the generic `ERR_INVALID_ARG_VALUE` would have printed it.
- A duration string needs a unit. `jsonwebtoken` reads `"60"` as milliseconds and `60` as seconds;
  here `"60"` is an error, and so is anything that overflows to `Infinity` (JSON would write
  `"exp": null`).
- `sign` takes a plain object. A `Map`, a `Date`, a class instance with hidden fields or a promise
  that was not awaited would otherwise be signed as `{}` or as whatever it happens to contain.

About half of that list comes out of a review pass that attacked the first version (algorithm confusion
through every key form, signature malleability, the key caches, mutation testing of the test file). The
signature and algorithm rules held; the empty `oct` secret, the identity-keyed JWK cache, `key_ops`, the
non-canonical base64url, the ignored option names, the inherited `requiredClaims` and options, and the
overflowing durations were found there, and each now has a test that fails without its fix.

It is a builtin TypeScript module (`internal/jwt`, loaded the first time `Bun.JWT` is touched) over
native primitives: `Bun.CryptoHasher` for HMAC, the `node:crypto` binding's one-shot `sign`/`verify`
and key parsers for the rest, taken from the binding directly so that neither loading nor patching
`node:crypto` matters, and only built when the first asymmetric key shows up. Parsed PEM strings, JWKs, `KeyObject`s and `CryptoKey`s are cached (a `WeakMap`,
and a 16-entry map for strings), since parsing a key costs about what verifying with it does. One C++
change: `KeyObject.from()` warns (DEP0204) for non-extractable `CryptoKey`s and passing a `CryptoKey`
to `crypto.sign` warns too (DEP0203), so the body of `KeyObject.from()` moved into a helper and the
binding gained an internal entry without the warning. The `KeyObject` is used inside the module and
never returned (code that patches `KeyObject.prototype` can still see it, as it can call `KeyObject.from()`).

Checked against the examples of RFC 7515 (A.1 to A.4) and RFC 8037 (A.4), and both ways against
`jsonwebtoken` for the seven algorithms it shares. Not done: JWE, an async key resolver (JWKS
fetching and caching is a `fetch` and a `find`), `ES256K` and `Ed448` (BoringSSL has neither), and a
native fast path. I did not benchmark it and make no speed claim. If it turns out to matter, the HS256
path is small enough to move to Rust without changing the API.

Files: `src/js/internal/jwt.ts` (new), `src/jsc/bindings/BunObject.cpp`, `src/jsc/bindings/ErrorCode.ts`
(seven `ERR_JWT_*` codes), `src/jsc/bindings/node/crypto/JSKeyObjectConstructor.cpp`, `.h`,
`src/jsc/bindings/node/crypto/node_crypto_binding.cpp`, `packages/bun-types/bun.d.ts`,
`docs/runtime/jwt.mdx` (new), `docs/runtime/bun-apis.mdx`, `docs/docs.json`,
`test/js/bun/jwt/jwt.test.ts` (new), `test/integration/bun-types/fixture/jwt.ts` (new).

### 2026-09-15: `.kill()`, `.signal()` and `.timeout()` for `$`

A `$` command could not be stopped. `ShellPromise` had no `kill()`, no pid, no `AbortSignal` and no
timeout, so a dev server, a `ping`, a hung `curl` or a test run started from the shell ran until it
felt like ending, and the usual advice in oven-sh/bun#11868 (open since June 2024) is to give up the
template literal and use `Bun.spawn`. oven-sh/bun#18247 asks for the `AbortSignal` form of the same
thing; tools that run user commands (an agent's shell tool, a task runner, a test harness) need it to
cancel work. Now there are three ways in, all of which do the same thing:

```ts
await $`curl ${url}`.timeout(5000); // kill it if it is still running after 5 s

const controller = new AbortController();
const tests = $`bun test`.nothrow().signal(controller.signal);
cancelButton.onclick = () => controller.abort();
(await tests).exitCode; // 143 when cancelled

const server = $`bun run dev`.nothrow().run(); // start now, await later
server.kill(); // or .kill("SIGKILL"), .kill(9)
await server;

await $`bun run build`.timeout(60_000).killSignal("SIGKILL");
```

They stop the script, not one command. Every process it is running gets the signal (each member of a
pipeline, command substitutions, subshells, the condition of an `if`), nothing else starts (the rest
of a `;`, `&&` or `||` list, the other branch), builtins that are waiting for input see it end, and
`yes`, the one builtin with no end of its own, stops. The promise then settles the way it does for any
other exit code, with 128 plus the signal number (143 for `SIGTERM`, 137 for `SIGKILL`, on Windows
too): a `ShellError` unless `.nothrow()` was called, and `stdout`/`stderr` hold what was written until
then, which is what one wants to see of a command that hung. That is `Bun.spawn`'s model (`signal`,
`timeout`, `killSignal`, `proc.kill()`, none of which reject with an `AbortError`) rather than
`fetch`'s, and it is what #18247 proposed. The code is forced rather than taken from whatever ran
last, so a process that catches `SIGTERM` and exits 0, or a pipeline whose last member is a builtin,
cannot make a cancelled script look like a success. A script killed before it started runs nothing (an
already aborted signal counts), one that has finished ignores it, and only the first signal decides
the exit code, so `kill()` and then `kill("SIGKILL")` for whatever ignored the first one still reports 143. The signal argument is parsed by the code behind `Subprocess.kill()`; 0 is refused.

Most of the machinery was there. Upstream recently taught the interpreter to wind a script down after
a JS error (`Interpreter::fail`: kill the subprocesses, let the tree finish, start nothing new), and
`kill` is that path with a signal of the caller's choice and a normal settlement at the end. A new
`stopping()` (failed or killed) replaces `failed()` at the six places that decide whether to go on.
What was new:

- The exit code is replaced in `finish()`, the one place every ending goes through.
- Input of builtins. `IOReader::end_for_readers()` hands every listener the EOF callback it would get
  anyway, so `cat`, `wc`, `head`, `sort` and friends finish through their ordinary end-of-input path
  instead of each growing a cancel path. `kill` does that for the script's own stdin (a terminal never
  ends) and for the stdin of every running builtin (a pipe from a killed member can be held open by
  that member's children). The reader remembers it, so a builtin that only turns to stdin later
  (`head file -`) finds it ended too.
- Grandchildren. Signals go to the processes the shell started, and `sh -c "sleep 100; ..."` leaves
  a `sleep` behind that still holds the stdout pipe, so the promise would only settle when that
  exits. After a kill, a process that exits (or had exited already) has its pipes read once more and
  closed instead of waited for, which is what `Subprocess` does after its own `timeout`.
- Kill-before-run lives on `ParsedShellScript` (where `cwd`, `env` and `quiet` already wait for the
  interpreter to exist), so JS never has to turn a signal name into a number.

A review pass over the first version (two readers, one on lifetimes, one on the state machine) found
four holes, all in the two middle points above: a builtin that had read stdin to its end stayed
registered on the reader, so the kill dispatched EOF to a node that had been freed and reused
(a panic); a process that had exited before the kill never had its pipes closed; a builtin downstream
of a pipe held by a grandchild was not ended; and the `head file -` case. Each has a test now, and a
160-round stress run (32 script shapes, random kill delays, quiet and not, one and two signals) comes
back clean in the ASAN build with stdin closed and with stdin open. The first hole is older than this
feature: `on_reader_done_cb` and `on_reader_error` never dropped their listeners, so in soup
`` $`sort; wc -l` `` with an empty stdin panicked ("not sort or uniq"), and in upstream
`` $`cat; (cat)` `` does with the builtin `cat` that Windows has by default. EOF and errors now take
the listener list with them, which fixes both.

`.run()` has existed all along but was not in the types or the docs; it is now, since "start now,
await later" is how one gets something to call `kill()` on.

Not done: signalling a process group (a grandchild survives, as it does with `child_process`), an
escalation timer from `SIGTERM` to `SIGKILL`, cancelling a builtin in the middle of file system work
(`rm -rf`, `cp -r` and `ls -R` finish first) or one that is blocked writing into a pipe nobody reads,
a `killed` or `signalCode` field on the result (compare `exitCode` with 143), and defaults on `$`
itself. Three older bugs turned up while testing and were reported rather than fixed here:
`` $`yes > /dev/null` `` never returns to the event loop, because every write to a file completes
synchronously and `yes` immediately queues the next one, so no JS runs and nothing can kill it (the
test for `yes` writes to a pipe for that reason); `` $`ls -R bigdir | true` `` never settles, kill or
no kill; and the `cat; (cat)` panic above, for upstream to fix on its own schedule.

One repair to an older soup patch: `shell-pipe-read-fault.test.ts` injects faults into the pipes of
`head -c 64 /dev/zero`, which stopped being a subprocess when `head` became a builtin on 2026-08-26,
so four of its tests had been failing since. The fixtures now name the system's `head` by path; that
change is folded into the `head`/`tail` commit.

Files: `src/js/builtins/shell.ts`, `src/runtime/shell/interpreter.rs` (`kill`, `stopping`,
`killed_exit_code`), `src/runtime/shell/ParsedShellScript.rs`, `src/runtime/shell/subproc.rs`
(`close_pipes_after_kill`), `src/runtime/shell/IOReader.rs` (`end_for_readers`, listeners dropped at
EOF), `src/runtime/shell/builtin/yes.rs`, `src/runtime/shell/states/{Cmd,Pipeline,Expansion,CondExpr}.rs`,
`src/runtime/shell/interpreter.bind.ts`, `src/runtime/shell/ParsedShellScript.bind.ts`,
`packages/bun-types/shell.d.ts`, `docs/runtime/shell.mdx`, `test/js/bun/shell/kill.test.ts` (new),
`test/integration/bun-types/fixture/index.ts`.

### 2026-09-16: `/* v8 ignore next */` and friends for `bun test --coverage`

`bun test --coverage` had no way to say "this code is not worth a test". A branch for a platform the
CI never runs on, a `never` guard, the `process.exit()` in a logger: each one is an uncovered line
forever, which makes `coverageThreshold = 1.0` unusable and is the reason several people in
oven-sh/bun#7662 (32 upvotes, open since December 2023) give for staying on Vitest or Jest. Every other
coverage tool reads comment hints, and the maintainer's answer in the thread was that a first version
that works by lines would be fine. That is what this is, and it reads the hints that c8, Vitest and
Node.js already read, so code that moves over keeps working:

```ts
export function parse(input: string) {
  /* v8 ignore next 3 */
  if (typeof input !== "string") {
    throw new TypeError("input must be a string");
  }
  return input.trim();
}

log(error); /* v8 ignore next */ // after code: this line only

/* v8 ignore start */
export enum Color {
  Red, // the function an enum compiles to leaves the report too
  Green,
}
/* v8 ignore stop */

export class Shape {
  /* v8 ignore next */
  async debug() {
    // the whole method, and the functions in it, whether it ran or not
  }
}

/* v8 ignore file */
```

`c8`, `istanbul` and `node:coverage` work in place of `v8`, `/* node:coverage disable */` and
`enable` are `start` and `stop`, `// v8 ignore next` works as a line comment, and text after the hint
(a reason, `next: why`, the `-- @preserve` other transpilers need) is fine. The rules are those of
v8-to-istanbul, which c8 and Vitest's v8 provider are built on: the line of the hint and the next N
when the comment stands alone, only its own line when it follows code, `start` without `stop` runs to
the end of the file. One thing differs on purpose. c8 counts an ignored line as covered; here it
leaves the report (no `DA` record, not in `LF`/`LH`, its functions not in `FNF`), which is what
istanbul does and keeps `lcov.info` and the text table in agreement.

The one rule that goes beyond lines: a function that starts on an ignored line is ignored as a
whole, with its body and the functions inside it. Bun's report only knows lines and functions, and it
already treats a function that never ran as a unit (its whole span is marked uncovered in one go), so
the function is the natural thing for `ignore next` to take, and it is what everyone who writes
`/* istanbul ignore next */` above a method expects. Finding the line a function starts on was the
hard part, and a review pass found two ways the first version got it wrong:

- JSC's range for a method starts at `async`, `get`, `set`, `*` or `[`, none of which has a source
  mapping of its own, and on an indented line the mapping before them is a filler that repeats the
  position of the last token of the line above. So `async ignored() {}` resolved to the last line of
  the previous method, and ignoring one method could quietly drop its neighbour. The start line is
  now the first mapping at or after the function's first token (the key or the name), and a mapping
  before it is only the fallback.
- JSC also lists the module itself as a function, and so is the function Bun wraps a CommonJS module
  in. Neither has a line of its own, so a hint on line 1 made them "start" on the first statement
  and took the whole file out of the report. Ranges that span the whole source are never ignored as
  functions.

A never-called function that is ignored also no longer marks its span as uncovered before it is
removed, because that span can reach into the method above it for the reason in the first point.

Hints are read from the file on disk when the report is written, not in the parser: comments do not
survive transpiling, the transpiler cache can skip the parser altogether, and `--parallel` workers
write their own reports. The one function both the serial runner and the workers report through
(`for_each_coverage_report`) reads the file, and the coordinator merges reports that already have the
lines removed. A file without the words `ignore` or `node:coverage` costs two SIMD scans. A source
with fewer lines than the report (a plugin's output) gets no hints, and neither does anything when
`coverageIgnoreSourcemaps` is set, since the report then counts lines of transpiled code.

Not done: `ignore if` / `ignore else` and istanbul's "next syntax node" reading of `ignore next` (an
`if` that spans several lines needs `next N` or `start`/`stop`; both would need the parser), a bunfig
switch to turn hints off, and telling a hint in a string literal from one in a comment (c8 and Node
do not either). While testing, the report turned out to misattribute lines around functions that
never ran (the last line of one is reported as covered, a one-line one entirely, and a never-called
`async` or getter method marks the last line of the method above it as uncovered). Upstream already
has open PRs that rework line attribution (oven-sh/bun#41528, oven-sh/bun#38282), so that was left
alone, and the tests here only assert what does not depend on it.

Two notes on the rebase. Upstream rewrote fetch's proxy handling the day before
(oven-sh/bun#42692: `ALL_PROXY`, `NO_PROXY` grammar, `proxy: false`, `Bun.FetchSession`), which
conflicted with the SOCKS5 patch in six files. The resolution keeps upstream's code and adds one
thing: upstream ignores a `socks5://` value in `ALL_PROXY` because its client cannot speak SOCKS, and
here it can, so `ALL_PROXY=socks5://127.0.0.1:1080` now works for `fetch` and `bun install` (with a
test; `socks4://` is still left alone). And upstream now builds with LLVM 23.1.1 and Rust
nightly-2026-09-15, which is what this stack was built and tested with.

The fork's bun-types workflow will be red with this push, and it is not this stack's doing: since
2026-09-15 20:36 UTC the registry's `latest` tag of `@types/node` points at 22.20.3, whose typings the
augmentations in bun-types do not fit, so 10 of the 21 tests in `bun-types.test.ts` fail on a clean
checkout of upstream main too, with the same diagnostics. It should go green again on its own once
the tag moves back to the 26.x line, as it did after 2026-09-10.

Files: `src/sourcemap_jsc/CodeCoverage.rs` (`ignore_hints`, `Report::ignore_lines`,
`original_start_line`, `is_whole_source`), `src/runtime/cli/test_command.rs`
(`coverage::ignore_hints_for`), `docs/test/code-coverage.mdx`, `docs/test/configuration.mdx`,
`test/cli/test/coverage.test.ts`.

### 2026-09-17: `#semver:<range>` for git and GitHub dependencies

A package that is released as git tags instead of on npm (uWebSockets.js is the usual example, an
in-house library on a private git server the common one) could only be pinned: `#v20.31.0`, a
branch, or a commit. npm, pnpm and yarn all read `#semver:<range>` as "the highest version tag in
this range", which is what makes such a dependency updatable, and bun passed the text to git as a
ref: `fatal: invalid object name 'semver'`, then `no commit matching "semver:^20.31.0"`, or for a
`github:` dependency a 404 from the tarball API. oven-sh/bun#5870 has been open since September
2023, and three more reports of the same thing (#4978, #5739, #10526) have been closed since. Now it
works, for every way of writing a git dependency:

```json
{
  "dependencies": {
    "uWebSockets.js": "github:uNetworking/uWebSockets.js#semver:^20.31.0",
    "design-system": "git+ssh://git@git.example.com/acme/design-system.git#semver:~2.4",
    "protocol": "acme/protocol#semver:>=1.0.0 <3"
  }
}
```

```sh
bun add "github:uNetworking/uWebSockets.js#semver:^20.31.0"
# installed uWebSockets.js@github:uNetworking/uWebSockets.js#9ec36de   (v20.71.0 today)
bun update   # a newer 20.x has been tagged since: the lockfile moves to its commit
```

A version tag is what pnpm and pacote take for one: `1.2.3` or `v1.2.3`, with an optional
prerelease or build suffix. `v2`, `release-1.2.3` and `nightly` are not versions. The range is
parsed and matched by the code behind registry dependencies, so `^`, `~`, `x`, hyphen ranges and
`||` work and a prerelease tag is only picked by a range that names a prerelease of the same
version. `semver:%5E1.2.3` is decoded first, an empty range or `*` means the highest release, and
something that is not a range (`semver:nightly`) matches nothing rather than everything, with
`no version tag satisfying "nightly" found for "pkg" (but repository exists)`. The lockfile records
the commit the tag points to (for an annotated tag the commit, not the tag object), so an install
from the lockfile never looks at tags, and `bun update` does.

The two kinds of dependency get there differently. A git dependency already goes clone, then
"which commit is this committish" (`git log -1` in the bare clone), then checkout. For a `semver:`
committish the middle step is `git ls-remote --tags` on the bare clone instead, and everything
around it is unchanged. A `github:` dependency is never cloned: it is one tarball download from the
API, which wants a ref. For a range, the same commit task now runs first, without a clone, as
`git ls-remote --tags https://github.com/<owner>/<repo>.git`, which is what npm does, costs one
round trip, returns every tag at once (the REST API pages them, 100 at a time) and is not subject to
the API's rate limit. The tarball is then requested by commit. `GITHUB_SERVER_URL` names the host the
way `GITHUB_API_URL` already names the API, which is how both are set on a GitHub Enterprise Server
runner, and it is what lets the test serve a repository over git's dumb HTTP protocol from
`Bun.serve`. The one new requirement is `git` itself for resolving a `github:` range that is not in
the lockfile yet.

A review pass (two readers, one on the task bookkeeping, one on parsing and the tests) found no
hang and no lifetime problem, and four things that are fixed in this commit:

- A git dependency reads the tags of the bare clone in the cache, and that clone never learned of a
  new one: it was refreshed with a plain `git fetch`, which in a `--bare` clone (no fetch refspec)
  updates no ref at all. So with a warm cache `bun update` never moved, and a range that only a
  new tag satisfies failed until `bun pm cache rm`. This patch made the refresh
  `git fetch --tags --force` until 2026-10-15; upstream now fetches branches and tags with explicit
  refspecs itself, so the rebase dropped that part. `github:` ranges always ask the remote.
- `query::parse` reads any text: `nightly` gives no comparator, but `vnext` or `xyz` give one that
  everything satisfies, so `#semver:vnext` installed the highest tag. What is not a range by the
  rule that tells `"pkg": "^1.2.3"` from `"pkg": "nightly"` in `dependencies` is now turned away
  first, and so is npm-package-arg's attribute list (`#semver:^1::path:packages/foo`), because bun
  has no `path:` and the root of the repository is not what that asks for.
- `Version::parse` stops at a byte it does not know and still reports success, so a tag like
  `v9.0.0+build_1` counted as 9.0.0, and a number too large for it reads as 0. Tags are checked in
  full now, with node-semver's limit of 16 digits.
- An optional dependency whose range nothing satisfies (or whose tags cannot be listed) failed the
  whole install. It is a warning now, as when the tarball of an optional dependency fails to
  download.

Not done. npm prefers the version that `HEAD` (or a ref named `latest`) points at when it satisfies
the range, and otherwise takes the highest; this always takes the highest, as pnpm does. While
testing, a percent-encoded committish on a `github:` dependency (`#feat%2Fx`, `#semver:%5E1.0.0`)
turned out to be dropped altogether by the shorthand parser, so the default branch is installed
without a word; that predates this change, affects branches too, and was reported rather than fixed
here. Encoded ranges do work on git URLs. The fixture repositories of the new tests have a `HEAD`,
unlike the shared one in that file: `git fetch` fails in a clone of a repository without one, which
no test had run into because none refreshed a cached clone.

Rebase notes: one conflict, in the SOUP patch for SOCKS5 (`env_loader.rs`: upstream switched the
proxy variables to a new URL parser the day after rewriting them; the resolution keeps upstream's
parser and the `socks5:` exception). The fork's bun-types workflow is still red for the reason given
yesterday (`@types/node@latest` is 22.20.3), upstream main fails the same ten tests, and it has now
been reported upstream.

Files: `src/install/repository.rs` (`semver_range`, `version_of_tag`, `is_version_range`,
`max_satisfying_tag`), `src/install/git_runner.rs` (`Step::Tags`),
`src/install/PackageManager/PackageManagerEnqueue.rs` (the `github:` lookup),
`src/install/PackageManager/runTasks.rs` (`alloc_github_remote_url`, the error messages),
`src/install/PackageManagerTask.rs`, `docs/pm/cli/add.mdx`,
`docs/pm/cli/install.mdx`, `docs/guides/install/add-git.mdx`,
`test/cli/install/bun-install-git-deps.test.ts`, `test/cli/install/bun-install-offline.test.ts`.

### 2026-09-18: `globalName` for IIFE bundles

A library that a page loads with a `<script>` tag has to put its API on a global. `format: "iife"`
wraps the bundle in a function so that nothing leaks, and that includes the exports: there was no
way to get them out. esbuild has `--global-name` for this. Bun's esbuild comparison page listed it
as "Not supported", the bundler docs said the IIFE format "does not support exposing its exports
under a global name", and three tests ported from esbuild were waiting for it as `todo`. Now it
works, from the CLI and from `Bun.build`:

```sh
bun build ./src/index.ts --outdir ./dist --format iife --global-name MyLib
```

```ts
await Bun.build({
  entrypoints: ["./src/index.ts"],
  outdir: "./dist",
  format: "iife",
  globalName: "MyLib",
});
```

```js
// dist/index.js
var MyLib = (() => {
  // ...
  return __toCommonJS(exports_src);
})();
```

```html
<script src="./dist/index.js"></script>
<script>
  MyLib.version; // a named export
  MyLib.default("Bun"); // the default export
</script>
```

The variable holds the module namespace of the entry point, with live bindings and `__esModule`,
which is what `format: "cjs"` assigns to `module.exports`. A CommonJS entry point gives its
`module.exports`, and so does a JSON or text entry point. The name can be a property path:
`acme.plugins["my-lib"]` prints `var acme;` and then `((acme ||= {}).plugins ||= {})["my-lib"] =`,
so the objects along the path are only created when they are missing and several bundles can share
one namespace. That is esbuild's behaviour, in the compact form it uses for targets that have `||=`
(Bun's own helpers already use `??=`). A path that starts with `this` assigns to the global object
and declares nothing. Every entry point's output assigns to the same name. The script of an HTML
entry point gets no assignment: Bun loads it as a module, where a `var` is not global and `this` is
undefined.

The linker already had the shape for this, because it follows esbuild's: a comment in
`LinkerContext::load` even says "the IIFE format only needs this when the global name is present",
above a condition that had no global name to test. So the change is small. The entry point gets a
forced exports object for `cjs`, or for `iife` with a global name, and the existing code then keeps
`__toCommonJS`, `__export` and the exports alive. The IIFE arm of `generate_entry_point_tail_js`,
which was `// TODO: iife`, returns `__toCommonJS(exports_entry)`, or `require_entry()` for a
CommonJS entry point. `post_process_js_chunk` writes the assignment in front of the wrapper, after
the hashbang, the banner and `"use strict"`, and counts it in the source map offsets. Two things
follow for IIFE output without a global name. An ESM entry point no longer gets an exports object
that nothing can read (with the unused `__toCommonJS` helper that came with it), so that output
shrinks. And a wrapped entry point is now called: before, `bun build --format=iife` of a CommonJS
entry point printed `var require_entry = __commonJS(...)` and never called it, so the bundle did
nothing. That is a known bug with an open upstream PR (oven-sh/bun#37843). The same statement was
needed here for `return require_entry()`, so this commit has the fix too. If the upstream PR
lands first, this patch shrinks by a few lines.

The name is parsed by hand (`parse_global_name`): a variable, then `.name` and `["name"]` segments,
with no escapes inside quotes, so every name is a slice of the option text. Property names can be
reserved words. The variable cannot be one, in sloppy or in strict code, because it is declared next
to the entry point's `"use strict"`. Validation happens where the linker options are filled in, next
to the "code splitting needs esm" check, so the CLI and `Bun.build` report the same two errors:
`Invalid global name "a..b": expected a variable name or a property path, such as "MyLib" or
"app.plugins.myLib"`, and `A global name is only supported when format is set to "iife"`. An error
was chosen over making the option imply `iife`, because it can be relaxed later and the reverse
cannot. A `globalName` that is not a string is a `TypeError`, and an empty one is unset, like
`banner`.

A review pass (two readers, one on the linker and one on parsing, docs and tests) found four things
that are fixed in this commit. A non-ASCII variable name (`café`) was written as UTF-8, but Bun reads
its own `// @bun` output as Latin-1, so a `--target=bun` bundle failed to load: the assignment is
ASCII now (`var caf\u{e9} =`, `ns["caf\u00E9"]`), as the printer does for identifiers. `let`,
`static`, `eval` and the other strict mode reserved words passed as variable names and broke next to
a `"use strict"` entry point. The script of an HTML entry point got the assignment, and a `this.`
path then throws when the page loads. And the flag was missing from the hand-written CLI reference.

Not done: escapes and whitespace inside the name, `import.meta` as the start of a path (esbuild takes
all three), and rollup's `output.globals`, the other half of building for a script tag (map an
external import to a global that is already on the page, oven-sh/bun#2531). While testing, a
CommonJS entry point whose top-level statements are all function declarations turned out to print
`var __INVALID__REF__ = __commonJS(...)` (a panic in debug builds) for `esm` and `iife` output. It
predates this change and was reported rather than fixed here.

Rebase notes: three conflicts, all from upstream's `Bun.ModuleGraph` change (oven-sh/bun#42590). In
the `append` patch, `Bun.write`'s helpers now take a `cx: &JsThread` where they took a global, and
`WriteFile::create` lost its callback arguments. In the `bun:sqlite` functions patch, `close(true)`
moved into `closeWithStatements()`, and the "not from inside a user-defined function" guard now sits
in front of it. In the `$` kill patch, `interrupted()` gained `context_stopped()` upstream and keeps
`stopping()` from the patch. The fork's bun-types workflow should be green again: `@types/node@latest`
is back on the 26.x line and the types test passes locally. One older soup mistake turned up while
running the bundler suites: the `bytes` loader patch of 2026-09-10 adds 24 bytes to the minified
`__toESM` helper, and three upstream tests pin exact output (`edgecase/EmitInvalidSourceMap2`, the
`npm/ReactSSR` file size and columns, one react-compiler snapshot). Their expectations are now updated
in that commit.

Files: `src/bundler/options.rs` (`parse_global_name`, `BundleOptions::global_name`),
`src/bundler/bundle_v2.rs` (validation), `src/bundler/LinkerContext.rs`,
`src/bundler/linker_context/postProcessJSChunk.rs` (`global_name_assignment`, the IIFE tail),
`src/options_types/context.rs`, `src/runtime/cli/Arguments.rs`, `src/runtime/cli/build_command.rs`,
`src/runtime/api/JSBundler.rs`, `src/runtime/api/js_bundle_completion_task.rs`,
`packages/bun-types/bun.d.ts`, `docs/bundler/index.mdx`, `docs/bundler/esbuild.mdx`,
`docs/snippets/cli/build.mdx`, `test/bundler/bundler_iife.test.ts`,
`test/bundler/esbuild/default.test.ts`, `test/bundler/esbuild/importstar.test.ts`,
`test/bundler/expectBundled.ts`, `test/integration/bun-types/fixture/build.ts`.

### 2026-09-19: `bun serve`, a static file server

Python has `python -m http.server`, PHP has `php -S`, and the answer for Bun has been `bunx serve`,
which is a download and somebody else's package. oven-sh/bun#12986 asks for a server that is simply
there, to preview a build, to look at a folder of HTML, to move a file to the laptop across the
room. `bun serve` printed `Script not found "serve"`. Now it serves a directory:

```sh
bun serve ./dist
# Bun v1.4.3 ready in 6.12 ms
#
# ➜ http://127.0.0.1:3000/
#   serving ./dist
#
# GET / 200 0.4ms
# GET /assets/index-4f2a.js 200 0.2ms
# GET /favicon.ico 404 0.1ms

bun serve                                # the current directory
bun serve ./dist --spa                   # index.html for the routes of a single-page app
bun serve ./dist --port 8080 --cors
bun serve ~/Downloads --host 0.0.0.0     # reachable from the phone, prints the LAN addresses
```

A file is sent with the `Content-Type` of its extension, `ETag`, `Last-Modified` and
`Cache-Control: no-cache`, so the browser revalidates on every load, gets a `304` for what did not
change and never shows a stale build. `Range` works (that part is `Bun.serve`'s own handling of a
`Bun.file()` body, sendfile included). A directory gets its `index.html` or, without one, a listing
(directories first, sizes, times, light and dark, `--no-listing` turns it off), and `/docs` is
redirected to `/docs/` so the relative links in either resolve. `/about` finds `about.html`, also
when there is a directory `about/` next to it, which is the layout a static export writes. A
`404.html` in the served directory is the not found page. `--spa` answers a path that matches no
file with the app's `index.html`, except when the last segment has a dot: a missing
`/assets/app.js` that comes back as HTML with a 200 is the classic "Unexpected token <". Requests are
logged unless `--quiet`. When the default port (whatever `Bun.serve` would pick: `bun --port`,
bunfig, the environment, 3000) is taken, the next free one of the ten after it is used and printed.
A port passed as `--port` is not a suggestion, and a taken one is an error.

What it will not send: anything outside the directory, and dotfiles. `..` is resolved by the URL
parser before anything is looked up. A segment that decodes to a separator or a NUL is refused (on
Windows also `\` and `:`, which would select a drive or an alternate data stream). Every path that
is served or listed goes through one function that resolves symlinks first and then checks the real
path, so a link is followed but not out of the directory, and neither a link nor another spelling
of a name (a Windows 8.3 short name) leads into `.git`. `.env` and friends are a 404 and are left
out of listings unless `--dotfiles` is passed. `/.well-known/`, at the top only, is exempt, because
RFC 8615 defines it as public. It listens on `127.0.0.1` unless told otherwise.

`serve` is not a new command in the dispatch table, because `bun serve` already means something:
the `serve` script of a package.json (every Vue CLI project has one), a file named `serve.ts`, a
`serve` binary in `node_modules/.bin`. All of those still run, and the static server is what
happens at the end of that list, where the "Script not found" error used to be. `bun run serve` and
`bun --if-present serve` never reach it. Nothing that worked yesterday does something else today,
and the bun team can promote it to a real command whenever they like; the substance is elsewhere.
That substance is one internal module, `src/js/internal/static_server.ts`, started the way
`bun ./index.html` starts `internal/html.ts`: the VM's `main_is_html_entrypoint: bool` became a
`BuiltinEntryPoint` enum (`None`, `Html`, `StaticServer`) and the C++ loader takes it as an
argument. The server is TypeScript on `Bun.serve`, `Bun.file` and `node:fs`, and says so in its
first line. Upstream's native directory routes (`"/*": { dir }`) were the obvious base and could not
be one: a miss there ends the response with an empty 404 instead of falling through to `fetch`, so
there is no place for a listing, a `404.html`, clean URLs or the SPA rule, no way to add a CORS
header or log a request, and it sends dotfiles. A `fallthrough` option on `{ dir }` routes would let
a later version hand the file serving back to native code.

The feature was built and tested on Linux, and then run on Windows, which found three bugs that
Linux never would have. The fixture had a file named `a & <b>.txt`, which NTFS does not allow.
`fs.realpathSync()` and `fs.promises.realpath()` disagree about 8.3 short names (only the native
one expands `C:\Users\RUNNER~1`), so under a short temp directory every file was "outside" the
root: the root now goes through `realpathSync.native`. And two servers ended up on one port,
because `development: false` quietly turns `reusePort` on in `Bun.serve`, which is `SO_REUSEPORT`
load balancing on Linux and port stealing on Windows: `reusePort: false` is now explicit, and the
test holds the port with a `reusePort` server so that it fails on Linux too if that line goes away.
For the same reason the default host is `127.0.0.1` and not `localhost`: `Bun.serve` binds
`localhost` to whichever of `::1` and `127.0.0.1` is free, so a second server on the same port is
not an error and the "next free port" logic never fires.

Two review passes (one reader attacking the server, one reading the CLI glue, the tests and the
docs against the code) found more, all fixed in this commit. A request without a usable `Host`
header (`GET / HTTP/1.0`) has a bare path as `req.url`, `new URL()` threw, and the answer was a 500
with a stack trace in the log. `--host ""` listened on every interface, because that is what
`Bun.serve` does with an empty hostname. `--spa` answered traversal probes and `/.git/HEAD` with
the app and a 200, which is harmless and looks terrible in a scanner. An unreadable file was a 500
from outside the handler and an unreadable directory a 500 from inside it; both are a 403 now. The
`.well-known` exemption applied at any depth. A backslash was refused on POSIX, where it is a
legal character in a name. The 301 had no `Cache-Control`, and browsers keep a 301 forever, which
is wrong for a port that serves a different project tomorrow. `bun serve --watch` failed with
`util.parseArgs`' advice about `--`, which Bun has already stripped; the error now says that Bun's
own flags go before `serve`. Colors went into `bun serve > access.log`, because
`Bun.enableANSIColors` is about the terminal and not about stdout. The port fallback recomputed
the default port from the environment and so ignored `bun --port` and bunfig. The `--quiet`
assertion in the test could not fail, the URL regex could match a line that had only half arrived,
and `bun run serve` in a test would have found a globally installed `serve` in `$PATH`. The first
version also carried the entry point as a second bool next to `main_is_html_entrypoint`, where
both could be true. That is the enum now.

Four older bugs in Bun turned up on the way and were reported rather than fixed here. In debug
builds every response without a body (204, 304, a redirect) carries
`content-type: application/octet-stream`, because `RequestContext` recognises the fallback MIME
type by comparing a pointer against a `const`, and only release builds merge the two copies. The
`localhost` double bind above (uSockets falls through to the next address family on `EADDRINUSE`).
`Bun.serve` ignores `If-Range` on file, directory and `Bun.file()` responses, so a download that is
resumed after the file changed gets a 206 of the new bytes; `bun serve` inherits that and will
inherit the fix. And on Windows `fs.promises.realpath("C:\\")` returns `"C:"`, which means the
current directory of the drive; serving a drive root works around it in one line.

Not done: compression (soup's `compress` option for `Bun.serve` would be one line here, but this
commit should not need that one), TLS flags, `--open`, a JSON listing, shell completions and an
entry for `serve` in the "did you mean" list (both are tables of real commands), a `Host` allow-list
against DNS rebinding, a cap on the size of a listing, and closing the window between the symlink
check and the open (it needs `openat2(RESOLVE_IN_ROOT)`, which the native directory route has and
JavaScript does not). The request log shows the status the handler chose, so a Range request reads
200 where the client saw 206. And the precedence above has a cost that the docs spell out:
`bun serve` in a directory with a `serve.js` runs that file, which is how `bun <name>` has always
worked and not what somebody who read "static file server" expects in a folder they do not trust.
A `bunfig.toml` with a `preload` there has the same effect on every `bun` command, so this is not a
new hole, but it is the argument for making `serve` a hard command one day.

Rebase notes: 33 patches onto oven-sh/bun 26e7a4b369, no conflicts, nothing dropped. The fork's
three workflows were green after yesterday's push.

Files: `src/js/internal/static_server.ts` (new), `src/runtime/cli/run_command.rs`
(`exec_static_server`, `boot_with_entry_point`), `src/jsc/VirtualMachine.rs` (`BuiltinEntryPoint`),
`src/jsc/bindings/HTMLEntryPoint.cpp` (`Bun__loadBuiltinEntryPoint`), `src/runtime/cli/mod.rs`
(the help text), `docs/runtime/http/static-server.mdx` (new), `docs/runtime/http/routing.mdx`,
`docs/docs.json`, `test/cli/serve/static-server.test.ts` (new).

### 2026-09-20: query logging for `Bun.SQL`

`Bun.SQL` had no way to show the queries it runs. oven-sh/bun#22203 asks for one ("Debugging is so
painful without this"), the workaround people pass around in that thread wraps the whole instance in
a `Proxy`, and every other driver has the switch: `debug` in postgres.js, `verbose` in
better-sqlite3, `log: ["query"]` in Prisma, `logger: true` in Drizzle. Now there is one, for
PostgreSQL, MySQL and SQLite alike, and like `BUN_CONFIG_VERBOSE_FETCH` it can be turned on from
outside the program:

```ts
import { SQL } from "bun";

const sql = new SQL({ debug: true });

await sql.begin(async tx => {
  const [user] =
    await tx`INSERT INTO users ${tx({ name: "Alice", age: 30 })} RETURNING id`;
  await tx`UPDATE accounts SET owner = ${user.id} WHERE id IN ${tx([1, 2])}`;
});
// [sql] BEGIN
// [sql] INSERT INTO users ("name", "age") VALUES($1, $2)  RETURNING id [ "Alice", 30 ]
// [sql] UPDATE accounts SET owner = $1  WHERE id IN ($2, $3) [ 7, 1, 2 ]
// [sql] COMMIT
```

```sh
BUN_CONFIG_VERBOSE_SQL=1 bun run index.ts   # no code change: Bun.sql, an ORM's instance, all of them
```

```ts
const sql = new SQL({
  debug(connection, query, parameters) {
    logger.debug({
      requestId: requests.getStore(),
      connection,
      query,
      parameters,
    });
  },
});
```

`debug: true` prints one line per query to stderr, right before the query goes to its connection:
the text the database gets (the `$1` or `?` placeholders Bun wrote, the `sql()` helpers expanded,
nothing interpolated), then the parameters on the same line, with a dim `[sql]` in front when
stderr has colors. The statements Bun sends on its own (`BEGIN`, `SAVEPOINT s0`, `COMMIT`, the
`ROLLBACK` after a throw) are there too, because a log without the transaction boundaries answers
half the questions. A query that never runs is not (a fragment, a query that is built and dropped,
one that is cancelled while it waits for a connection). `BUN_CONFIG_VERBOSE_SQL=1` (or `true`, the
values `BUN_CONFIG_VERBOSE_FETCH` takes) does the same for every instance that does not set `debug`,
from the environment or a `.env` file, and `debug: false` keeps one instance quiet. A function gets
`(connection, query, parameters)`, the first three arguments postgres.js passes to its `debug`
option, so a logger written for it carries over: the index of the pooled connection (the statements
of one transaction share one, SQLite is always `0`), the text, and an array of the parameters that
is the callback's own. SQLite's named parameters arrive as one object in that array, the way
`bun:sqlite` takes them as one argument.

Two things about the callback took some thought. It is called in the async context of the code
that ran the query. That sounds automatic and is not: a query that has to wait for a connection
(every query on a cold pool, any query on a busy one) is resumed from the socket event or from the
query that released the connection, so an `AsyncLocalStorage` store in the callback would be
missing or, worse, another request's. The frame is captured when the query asks the pool for a
connection and restored around the call, and a test that goes red without those two lines pins it
on PostgreSQL and MySQL. And the callback only observes. The first version let a throw reject the
query, which is what postgres.js does and reads well until the statement is `COMMIT`: Bun clears
its "needs a rollback" flag before it sends `COMMIT`, so a logger that failed at that moment sent
neither, and the connection went back to the pool with the transaction open. The next `BEGIN` on
it is a warning in PostgreSQL, an implicit commit in MySQL and an error in SQLite. A throw is now
reported as an uncaught exception, the way the callbacks of `sql.listen()` already are, and the
statement is sent. The built-in printer cannot throw at all: a parameter whose custom inspect
function throws is printed as `[ 2 parameters ]`.

It is all JavaScript, in the layer the three adapters share. Every query ends in the one
`handle.run(connection, query)` call of `runOn()` in `src/js/bun/sql.ts` (the pool, transactions
and reserved connections all go through it), and the hook sits in front of it. The text is not
stored on the query: the hook runs `normalizeQuery()` again, so only a debugged query pays for it,
and without `debug` the whole cost is one more argument per query. The printer goes through
`console.warn`, because `console.error` paints its line red, and it asks whether stderr itself has
colors, because `Bun.enableANSIColors` is also true when only stdout is a terminal and
`2> queries.log` should stay plain.

A review pass (two readers, one on the implementation and one on the docs, types and tests) is
where the `COMMIT` problem came from. It also found that the first version kept every query's text
and parameters alive for as long as the query object (hence the recomputation), that a lone
`Uint8Array` bound by the SQLite adapter was spread into an object with one key per byte, that
`FORCE_COLOR=0` counted as forced, that the environment variable took `off` and `FALSE` for yes,
that the docs said `sql.savepoint()` for what is `tx.savepoint()` and showed `debug: false` in the
option examples, which would have switched the environment variable off for everyone who copied
them, and that three tests could not fail: the one for "before the query runs" now looks at a file
database through a second connection from inside the callback.

Not done: the `LISTEN` and `UNLISTEN` that `sql.listen()` sends on its dedicated connection are not
reported (that connection retries a failed `LISTEN` forever, and a hook in there deserves its own
look), there is no duration or row count (it would take a second hook at the end of a query, and
postgres.js has none to be compatible with), and the parameter types postgres.js passes as a fourth
argument are not known to the JavaScript layer. Two older bugs turned up on the way. The callback
of `sql.begin()` loses its `AsyncLocalStorage` store when the pool has to connect first, so the
first transaction after a start runs without its request context; that was reported rather than
fixed here. And ``await expect(sql`...`).rejects`` hangs `bun test` for good, without even the test
timeout, because a query is lazy and `.rejects` does not call `then()`; upstream has an open PR for
it (oven-sh/bun#40996), as it has for a query that is cancelled before it runs and then never
settles (oven-sh/bun#41492).

Rebase notes: 34 patches onto oven-sh/bun fc297d4658, no textual conflicts, nothing dropped. One
patch stopped compiling all the same: upstream made `SignalCode::to_exit_code()` total
(oven-sh/bun#39970), and the `$` kill patch of 2026-09-15 used its `None` to refuse signal 0 and to
compute the exit code of a killed script. Two lines, folded into that commit, and its 34 tests pass.
The fork's three workflows were green after yesterday's push.

Files: `src/js/bun/sql.ts` (`debugQuery`, `debugFrameOf`, the hook in `runOn`),
`src/js/internal/sql/options.ts` (`parseDebugOption`), `src/js/internal/sql/shared.ts` (`printQuery`),
`packages/bun-types/sql.d.ts`, `docs/runtime/sql.mdx`, `docs/runtime/debugger.mdx`,
`docs/runtime/environment-variables.mdx`, `test/js/sql/sql-debug.test.ts` (new),
`test/integration/bun-types/fixture/sql.ts`.

### 2026-09-21: the Web Locks API (`navigator.locks`)

Every codebase with more than one async task has written this mutex: a promise chain in a module
variable, or `async-mutex`, `async-lock`, `await-lock` from npm. The web platform has had a real one
since 2019, Node.js ships it since 24.5, and Bun's compatibility page listed it as missing twice
(under `navigator` and under `node:worker_threads`). Now it is there, and because the state lives in
one place for the whole process, the same call that serializes two async tasks also serializes the
main thread and its Workers:

```ts
// One holder at a time, on whichever thread. Held until the promise the callback returns settles,
// and the request resolves with the callback's result afterwards.
const rows = await navigator.locks.request("reports.db", async lock => {
  return await rebuildReport();
});

// Any number of "shared" holders, or one "exclusive" one (the default).
await navigator.locks.request("config", { mode: "shared" }, () => readConfig());

// Don't wait: the callback gets null when the lock is taken.
await navigator.locks.request(
  "cache-refresh",
  { ifAvailable: true },
  async lock => {
    if (lock) await refreshCache();
  },
);

// Give up waiting after 5 seconds. Once the lock is held the signal has no say.
await navigator.locks.request(
  "export",
  { signal: AbortSignal.timeout(5000) },
  runExport,
);

// Take it from whoever has it; their request rejects with an AbortError.
await navigator.locks.request("leader", { steal: true }, lead);

await navigator.locks.query();
// { held: [{ name: "reports.db", mode: "exclusive", clientId: "bun-4242-0" }], pending: [] }

import { locks } from "node:worker_threads"; // the same LockManager, as in Node.js
```

It follows the specification (https://w3c.github.io/web-locks/) down to the parts that are easy to
get wrong: requests for a name are granted in order, so a shared request behind a waiting exclusive
one waits too and readers cannot starve a writer; `ifAvailable` fails when there is a queue even if
the held locks would be compatible; the callback never runs inside `request()`; a signal that aborts
after the registry granted the lock but before the callback's task ran means the callback is not
called and the lock goes straight back; a stolen lock's callback keeps running and what it returns
is dropped. The twelve web-platform-tests files for the API that do not need a DOM (`acquire`,
`held`, `ifAvailable`, `lock-attributes`, `mode-*`, `query*`, `resource-names`, `signal`, `steal`:
70 subtests, two of them with a Worker) pass, run through a throwaway `testharness.js` shim that is
not part of the commit. Node's own two test files are, unmodified (`test-web-locks.js`,
`test-web-locks-query.js`), and so are the details they pin down: the stolen lock's error is an
`AbortError` that says "The operation was aborted", the callback runs in the `AsyncLocalStorage`
context of the `request()` call (it is invoked from an event-loop task, so the frame is captured and
restored by hand), and the four `locks.request.*` diagnostics channels are published to. `Lock` and
`LockManager` are not globals, as in Node.

Node's tests found the first real bug. `request()` twice in a row, the second with `steal`: the
registry grants the first, breaks it for the second, and posts "granted" and then "broken" to the
thread. The callback ran on "granted", returned, its microtasks ran, the request resolved, and only
then did "broken" arrive for a request that no longer existed. The release now reports whether the
lock was still held, and a callback that finishes holding nothing rejects the way the specification
says it must.

The design is a process-wide registry in C++ (`WebLocks.cpp`: per name, the held locks and a deque
of pending requests, behind one mutex) and a JavaScript shell (`internal/web_locks.ts`: the two
classes, WebIDL argument handling, what to do when the registry says granted, not available or
broken). The registry posts its decisions with `ScriptExecutionContext::postTaskTo()` while it still
holds the mutex, which is what guarantees that every thread hears about its requests in the order
they were decided. The per-request JavaScript state is rooted natively, by a client object that
belongs to the context whose script made the request, and that is the second half of the design: a
request is owned. When the context stops, what it held is released and what it waited for is
dropped, without running any script. A Worker that exits or is terminated is one such context. A
disposed `Bun.ModuleGraph` is another (upstream's new multi-tenant graphs: "what a graph opens is
the graph's" now includes its locks, the host gets them back on `dispose()`, and a request that a
disposed graph's leftover code still makes stays pending like everything else it starts). The global
of a finished test file under `bun test --isolate` is the third, so a test that forgets to release a
lock cannot hang the next file.

Two decisions go beyond the specification, which has no notion of a thread that exits on its own. A
pending request keeps its thread's event loop alive exactly while a lock or request of another
thread is ahead of it. Without that, a Worker whose script is one `await navigator.locks.request()`
would exit silently while it waits (it has no listener, no timer, no port), which is what happens in
Node.js 26.3: the Worker exits with code 0 and never gets the lock. With "always", two requests on
one thread where the first never releases would keep the process from exiting, where an unsettled
promise normally does not; behind only its own thread's locks a request is exactly that, an
unsettled promise. The rule costs one pass over a name's queue per change, skipped when the whole
queue belongs to one thread, so 50,000 queued requests on one name stay linear. And `query()`
reports the whole process, with the caller's own held locks first. The specification says the whole
origin, the two WPT tests with a Worker expect it, and it is the only way to see a deadlock between
threads. Node reports only the calling thread, and its test reads `held[0]` as "my lock", hence the
order.

A review pass (three readers: the C++, the JavaScript against the specification, the tests and docs)
found the second bug, in the part described two paragraphs up. When a lock went to a waiting thread,
the registry posted the end of that thread's keep-alive first and the grant second. The first post
wakes the thread, and a Worker with nothing else to do could find its event loop empty and exit
before the grant was in its queue: one hand-over in about four thousand on sixteen cores, three in
eight when pinned to one. The grant goes first now, a test hands the lock over fifty times, and the
reviewer's loop ran fifteen thousand hand-overs without losing the Worker. The same pass found that
the abort handling trusted the `abort` event too much (an earlier listener calling
`stopImmediatePropagation()` left the request queued and later unsettled for good, an `abort` event
dispatched by hand on a signal that is not aborted rejected the request and leaked its lock, a
polluted `Object.prototype.capture` kept the listener from being removed); that a returned promise
with a throwing `constructor` getter escaped `dispatch()` and leaked the lock; that a missed
`ifAvailable` request published its `end` before its callback's promise had settled; that printing
`Lock.prototype` threw and `util.inspect()` lost the class names; that the interface objects had a
`length`; that stopping a client rotated every pending queue of the process under the mutex; that
two tests could not fail (one probed the lock before the first callback had run, one checked a flag
that is still false one task after any grant); and that the first docs sample rejects until its file
exists. All fixed in this commit, the behaviors with tests.

Checked beyond the tests in the commit: a stress run with six Workers and the main thread on three
names, mixed modes, `ifAvailable` and aborts (12,000 grants, no two holders that exclude each
other); the same with a `worker.terminate()` at random several times a second under ASAN (no crash,
nothing left held or pending); 150,000 requests with flat memory. The feature was built and run on
Windows as well (the new test file and Node's two pass there), which found nothing this time.

No change to `packages/bun-types`: `navigator.locks` and `locks` are declared by `@types/node`,
which bun-types depends on, and by `lib.dom.d.ts`; lines in the `worker.ts` fixture pin that it
type-checks under both.

One thing a reader of `WebLocks.cpp` should know: the registry posts while it holds its mutex, which
is what orders the events and is harmless because a post never blocks. The one exception is the
debug-only teardown gate that `worker-late-completion.test.ts` arms, which parks posters until the
Worker drains, and a stopping Worker needs the mutex before it drains. That test has no locks in it
and should not grow any.

Not done: locks do not reach across processes (in a browser they span tabs; here that would take a
lock file or a named OS primitive and a different failure model), there is no deadlock detection
(two threads that wait for each other wait, as with any lock, and with the keep-alive rule they now
do so visibly instead of one of them exiting), the `Lock` and `LockManager` interface objects are
not exposed as globals, and the records of a disposed graph's requests are dropped without rejecting
their promises, like everything else a disposed graph was waiting for. One unrelated bug turned up
and was reported rather than fixed here: a listener added with `addEventListener()` on the global
scope is called with `this === undefined` instead of the global object, on the main thread and in a
Worker, which is how the WPT helper `worker.js` (`const target = this`) failed before the shim
worked around it.

Rebase notes: 35 patches onto oven-sh/bun 2f6284cd03, two textual conflicts, nothing dropped. Both
sides had appended tests to `filesink.test.ts` (the `append` patch of 2026-08-29), and upstream's
"Typecheck the built-in modules" (oven-sh/bun#43649) retyped the function the query logging patch of
2026-09-20 adds a parameter to. That change also means upstream now runs `tsc` and oxlint over
`src/js` in its Lint workflow, which only runs on pull requests, so the fork's push CI cannot see
it. The whole stack passes `tsc`. A lint rule upstream added in the meantime (a property read in an
`if` and again in its body) flagged the `EventSource` patch of 2026-09-01 once and the
`expect.poll()` patch of 2026-09-08 three times; the fixes are folded into those commits and their
tests pass. The MySQL third of the query logging tests could not run in today's container (its
MariaDB refuses `root` over TCP, with stock Bun too); the PostgreSQL and SQLite parts pass. The
fork's three workflows were green after yesterday's push.

Files: `src/jsc/bindings/webcore/WebLocks.cpp`, `src/jsc/bindings/webcore/WebLocks.h` (new),
`src/js/internal/web_locks.ts` (new), `src/jsc/bindings/ZigGlobalObject.cpp` (the `locks` getter of
`navigator`), `src/js/node/worker_threads.ts` (`locks`), `docs/runtime/workers.mdx`,
`docs/runtime/web-apis.mdx`, `docs/runtime/nodejs-compat.mdx`, `docs/runtime/module-graph.mdx`,
`test/js/web/locks/locks.test.ts` (new), `test/js/node/test/parallel/test-web-locks.js`,
`test/js/node/test/parallel/test-web-locks-query.js` (from Node.js, unmodified),
`test/integration/bun-types/fixture/worker.ts`.

### 2026-09-22: `expect.addSnapshotSerializer()`

`expect.addSnapshotSerializer()` existed in `bun:test` as a function that throws "Not implemented",
and the docs listed it as the one matcher "Not Yet Implemented". It is the call a Jest or Vitest
setup file makes to register a serializer (for styled components, for DOM nodes, for a project's own
`Money` or `Temporal` values), so a project that has one could not move its snapshot tests over
without deleting it and rewriting the snapshots. Now it works, with the same serializer objects
(pretty-format plugins), for all four snapshot matchers:

```ts
import { expect, test } from "bun:test";

expect.addSnapshotSerializer({
  test: value => value instanceof Money,
  serialize: (money: Money) =>
    `Money<${(money.cents / 100).toFixed(2)} ${money.currency}>`,
});

test("order total", () => {
  expect({ items: 2, total: new Money(1999, "EUR") }).toMatchInlineSnapshot(`
    {
      "items": 2,
      "total": Money<19.99 EUR>,
    }
  `);
});

// printer() formats what the serializer does not print itself, serializers included
expect.addSnapshotSerializer({
  test: value => value instanceof Stack,
  serialize(stack: Stack, config, indentation, depth, refs, printer) {
    const inner = indentation + config.indent;
    const items = stack.items.map(
      item => inner + printer(item, config, inner, depth + 1, refs) + ",\n",
    );
    return "Stack [\n" + items.join("") + indentation + "]";
  },
});

// the older interface
expect.addSnapshotSerializer({
  test: value => value instanceof Tag,
  print: (tag: Tag, print, indent) =>
    `<${tag.name}>\n${indent(print(tag.child))}\n</${tag.name}>`,
});
```

Every value is offered to the serializers before Bun prints it, the snapshot's root and everything
nested in it (object property values, array elements, Map keys and values, Set elements, JSX
children), newest serializer first. `serialize()` receives pretty-format's arguments: the `config`
object jest-snapshot formats with (`indent`, `spacingInner`, `spacingOuter`, `min`, empty `colors`,
`plugins`, ...), the indentation string of the value's line, the depth, the values it is nested in
as `refs`, and `printer`. A multi-line result at the root gets the line breaks a multi-line snapshot
starts and ends with. Matcher failure messages (`toEqual()` diffs) do not go through serializers, as
in Jest.

Bun's snapshot printer is native, so the work is where the two meet. `Formatter::format()` is the
one function every value passes through, and the hook is there: with no serializer registered it is
one `Vec::is_empty()`. `printer()` and the older `print()` are host functions that run a second
formatter into a buffer, at the indent level the serializer asked for. That formatter knows it is
nested: it does not write the line breaks a multi-line snapshot starts and ends with (the nine
`indent == 0` checks that emulate jest-snapshot's `addExtraLineBreaks` became `is_snapshot_root()`),
and a Map, a Set or a multi-line string handed straight to `printer()` starts where the serializer
puts it (Bun's printer otherwise surrounds those three with line breaks at any depth, see below).
The values that formatter is nested in are seeded from `refs` into its visited set, and the `refs` a
serializer receives are the visited set, so a cycle that runs object, serializer, `printer()`, same
object ends in `[Circular]` exactly where Jest prints it, instead of recursing. A serializer that
really never stops (it wraps its value in a new object each time) ends in a `RangeError` from a
stack check in `printer()`, under ASAN too.

The output was compared byte for byte with pretty-format 29.7.0 itself: twenty-one cases with both
interfaces, at the root and nested in objects and arrays, multi-line results inside arrays, Maps,
Sets and multi-line strings through `printer()` and `print()`, and three cycles through a
serializer, formatted by pretty-format with jest-snapshot's options and by `toMatchSnapshot()`. All
identical, including the older interface's double indentation of nested `indent(print(child))`
output, which is pretty-format's behavior and the reason the newer interface exists.

Where a serializer applies is the one decision Jest does not make for Bun. Jest gives every test
file its own module registry, so a serializer lasts for one file. Bun runs the files of a run in one
global with one module registry, and `expect.extend()` matchers simply stay. The first version of
this patch ended a file's serializers with the file and kept only those of `--preload` scripts. The
review pass found what that breaks: a helper module that registers serializers at its top level and
is imported by two test files is evaluated once, so the second file would have run without them, and
so would every repetition under `--rerun-each`. Serializers now last as long as the global they were
added in, like `expect.extend()`: the run, or one file under `--isolate` (where the list is cleared
with the global, and the preload runs again). The registry holds `Strong` references and is emptied
on the same path that drops the preload hooks before the VM exits. It is reached through a raw field
pointer, not through `&mut TestRunner`, because `toMatchInlineSnapshot()` formats while it holds the
runner and a serializer's script may register another serializer from in there.

Not done: object keys are not offered to serializers (pretty-format prints keys through `printer()`
too, so a serializer for strings also rewrites keys there), `config.plugins` lists the registered
serializers only (pretty-format's built-in plugins for React elements, DOM nodes and asymmetric
matchers are native code in Bun and have no plugin object to list), the options in `config` are
fixed and `printer()` ignores a changed `config` and `depth`, `refs` is in no particular order, and
`expect.addSnapshotSerializer()` outside `bun test` checks its argument and does nothing. The docs
list the differences. Bun's own printing is unchanged, including two places where it differs from
Jest that this work ran into and that were reported rather than fixed here: a Map or Set nested in
an object prints with stray line breaks, and so does a nested multi-line string. The new tests stay
clear of both.

A review pass (one reader, the whole diff) found the scoping problem above and that `printer()`
returned a Map, a Set and a multi-line string with the stray line breaks just mentioned, which a
pass-through serializer at the root then doubled. Both are fixed with tests, and the comments it
found stale are corrected. It found no problem with the rooting of the values (the registry's
`Strong`s for the serializers, a private array for the seeded `refs`), with exceptions (a throwing
serializer inside an object, a Map or a Set surfaces from the matcher, also under
`BUN_JSC_validateExceptionChecks=1`) or with output when no serializer is registered.

Rebase notes: 36 patches onto oven-sh/bun bf80d21c69, nothing dropped. Four textual conflicts, all
from upstream narrowing `pub` to `pub(crate)` across `bun_runtime` (`bun_test.rs` under the
`--dry-run` patch, `api.rs` under `Bun.INI` and `Bun.CSV`, `cli/mod.rs` under "did you mean",
`shell/mod.rs` under `sort`/`uniq`). Two upstream changes broke the stack without a conflict.
"event loop: remove ManagedTask" (oven-sh/bun#43675) deleted the generic callback task that the
`wc` patch of 2026-08-15 used to hop a non-pollable stdin read onto the JS loop; that hop is now its
own task type with its own tag (`ShellIOReaderUnpolledRead`), a `Taskable` impl that drops the
boxed keep-alive when the VM stops first, and arms in `dispatch.rs`, which is what upstream did for
its own nineteen users. And `bun_runtime` is now compiled with `-D unreachable-pub` (it became the
root crate when the rlibs started being linked directly, oven-sh/bun#43650), which rejected 42 `pub`
items in six patches (`wc`, `head`/`tail`, `sort`/`uniq`, `--reporter=json`, `--last-failed`,
response compression). All of it is folded into the patches it belongs to, so each still
cherry-picks on its own; the stack builds, and `test/internal/source-lints/` passes. One test in
`snapshot.test.ts` ("error snapshots") fails in a terminal without colors because its expected text
contains ANSI codes; it fails the same way with stock Bun and passes with `FORCE_COLOR=1`. The
fork's three workflows were green after yesterday's push.

Files: `src/runtime/test_runner/snapshot_serializer.rs` (new),
`src/runtime/test_runner/pretty_format.rs` (the hook, `format_for_serializer()`,
`is_snapshot_root()`, `acquire_visited_map()`), `src/runtime/test_runner/bun_test.rs` (the
registry's lifetime), `src/runtime/test_runner/expect.rs`, `src/runtime/test_runner/expect.bind.ts`,
`src/runtime/test_runner/mod.rs`, `src/runtime/test_runner/diff_format.rs`,
`packages/bun-types/test.d.ts`, `docs/test/snapshots.mdx`, `docs/test/writing-tests.mdx`,
`test/js/bun/test/snapshot-tests/snapshots/snapshot.test.ts`,
`test/integration/bun-types/fixture/test.ts`.

### 2026-09-23: `for` loops in Bun Shell, with `break` and `continue`

Bun Shell had `if` and `[[ ]]` but no loop of any kind. `` $`for i in 1 2 3; do echo $i; done` `` answered
`bun: command not found: for`, then the same for `do` and `done`. So the moment a script needed to
do something per file or per package it left the template literal for a JavaScript loop around many
small `$` calls, and a `package.json` script with a `for` in it, which works on Linux and macOS
because `bun run` hands it to `sh`, failed on Windows, where `bun run` uses Bun Shell. Now:

```ts
import { $ } from "bun";

await $`
  for file in src/*.ts; do
    echo checking $file
    bun run check.ts $file
  done
`;

// an interpolated array is one word per element, never split, never globbed
const packages = ["core", "cli", "my docs"];
await $`for pkg in ${packages}; do (cd packages/$pkg && bun run build); done`;

await $`
  for dir in packages/*; do
    [[ -f $dir/package.json ]] || continue
    for script in build test; do
      bun run --cwd $dir $script || break 2
    done
  done
`;
```

```json
{
  "scripts": {
    "build:all": "for pkg in packages/*; do bun run --cwd $pkg build; done"
  }
}
```

The words after `in` go through the same expansion as the arguments of a command (variables,
`$(...)` split into fields unless quoted, braces, globs, interpolated values), once, before the
first iteration. The variable is an ordinary shell variable: not exported, and it keeps its last
value after the loop. The loop exits with the status of the last command its body ran, or 0 if it
never ran. It can be a member of a pipeline (where it runs in a copy of the environment, like any
other member), an operand of `&&` and `||`, the condition of an `if`, and it nests. `break [n]` and
`continue [n]` are builtins. All of it was checked against bash 5.2, about sixty scripts by a review
pass on top of the tests: counts larger than the nesting end every loop, a count that is not a
positive integer is an error that also ends every loop (status 1), outside a loop they print
`break: only meaningful in a loop` and succeed, `( break )` is outside the loop while `$( break )`
and `break | cat` end what is left of the substitution or the pipeline member and never the loop
around it.

How it is built:

- Parser. `for`, `in`, `do` and `done` join `if`/`then`/`elif`/`else`/`fi` in the one mechanism the
  parser has for reserved words (`IfClauseTok`), so they get its two safety properties for free: a
  word is only reserved where the grammar looks for it (`echo done`, `for x in for in do done`, a
  variable called `in` all work), and an interpolated `${"done"}` is data and can never close a
  loop. `for x; do` without a list (it means `"$@"`, which Bun Shell does not have), an empty body
  and `done > file` are parse errors that say so, and `for $x in` explains that it wants the name.
- Interpreter. A new `For` state next to `If`: expand each word through the `Expansion` state `Cmd`
  uses, then run the body's statements once per field. An expansion that fails (a glob with no
  match) prints its error and fails the loop, not the script, through the same IOWriter path
  `[[ ]]` uses.
- `break` and `continue` unwind nothing themselves. They leave a `LoopJump { kind, levels }` in the
  shell environment and finish. Upstream already has the predicate every sequencing state (`Script`,
  `Stmt`, `If`, `&&`/`||`) asks before it starts its next child, `Interpreter::interrupted()`, added
  for Ctrl+C and script failure; a pending jump is one more reason to say yes, so `if`, `&&` and
  nested statement lists between the `break` and its loop fall away with no code of their own, and
  the loop consumes the jump (or decrements it and passes it on). The environment also counts the
  loops it is in, which is what makes `break` outside a loop a warning and lets a copy of the
  environment (subshell, substitution, pipeline member) decide whether it is still inside.
- The event loop. The shell's trampoline only returns to the event loop when something waits, and a
  body of builtins (`echo`, assignments, `[[ a == b ]]`) never does. The first version ran such a
  loop to its end in one go: the review measured a 10 ms interval timer that did not fire once
  during a 100,000-iteration loop, and soup's own `.timeout()` and `.kill()` from 2026-09-15 did
  nothing until the loop was over. Upstream's `yes` builtin has the same problem and solves it by
  re-queueing itself; `For` does the same every 128 iterations through a small boxed task
  (`ShellLoopYield`, on `enqueue_task_after_yield`, the queue upstream added for exactly this), and
  checks whether the script was stopped when it comes back. 2,000 iterations of builtins now give
  timers 15 turns, and `.timeout(200)` ends a loop of 100,000.

A review pass (one reader, the whole diff, with the debug build to run things) found no crash, leak
or unbalanced state in some sixty malformed inputs and every exit path of the loop (LSan clean,
file descriptors and RSS flat over 100,000 iterations), and four things that are fixed here: the
event loop point above, `break` inside `$( )` (it warned and carried on, bash ends the
substitution), an empty body being accepted, and a docs example whose comment promised more than
`|| break 2` does.

The work also ran into older bugs that loops make easier to meet. They are upstream's, reproduce
with stock Bun, and were reported through the hand-off instead of being fixed inside this patch.
Two matter enough to know about: a tab is not a word separator in Bun Shell's lexer, so a loop body
indented with tabs fails with `command not found: \techo` (so does a tab-indented `if`; this report
was picked up for a fix), and a comment at the end of a line swallows the newline, so
`for f in a b  # comment` joins `do` to the word list (`echo a # c` followed by `echo b` prints
`a echo b`). The others: a second builtin that reads an input which is already at its end never
finishes (`echo hi | (cat; cat)` with the builtin `cat` that Windows has by default, and so
`... | for i in 1 2; do cat; done`), and `echo *.{txt,md}` prints the two patterns next to the
matches. Glob matches are also not sorted, which a loop makes visible. The docs use spaces and
whole-line comments, and say that glob matches come unsorted and that a variable is one word
(`for x in $LIST` runs once, as everywhere in Bun Shell; interpolate an array or use `$(...)`).

Not done: `while` and `until` (the loop state and the yield task are most of what they need; they
also want `read`, and `exit` actually ending the script, which upstream's `exit` deliberately does
not, so `cmd || exit 1` in a loop does not stop it), `for x; do` over positional parameters,
redirecting a whole loop, and `$?`.

Rebase notes: 37 patches onto oven-sh/bun 6d504dd983, no textual conflict, nothing dropped, and one
break that git could not see. `dispatch.rs` asserts the number of task tags at compile time.
Upstream added a tag (`S3UploadWriterCollected`) and raised the number from 82 to 83; soup's `wc`
patch, which adds a tag of its own, had raised it from 82 to 83 as well. Both sides wrote the same
line, git merged it without a word, and the build failed because there are 84 now. Fixed in the
`wc` patch, where soup's tag comes from. Today's `ShellLoopYield` makes it 85. The patch does not touch lines other soup patches own
(the `interrupted()` change is a new line, the task tag sits apart from soup's, the tests stay
clear of soup-only builtins and skip the `kill()` test where `kill()` does not exist), so it
cherry-picks onto upstream with the count as its only conflict. `test/internal/source-lints/`
passes and the fork's three workflows were green after yesterday's push. A full run of
`test/js/bun/shell/` in the ASAN build had many timeouts in tests that start processes, on a shared
machine with a load average above 100. Run alone in a quieter moment, `kill.test.ts`,
`exec.test.ts`, `pipeline_stack.test.ts`, `file-io.test.ts` and `brace.test.ts` pass. What still
fails alone has no loop in it and fails for reasons of its own: `shell-hang.test.ts` gives a debug
build 700 ms to start, `commands/ls.test.ts` expects permission errors that root does not get, and
`shell-load`, `shell-leak-args`, `shell-blocking-pipe` and one `rm` test run out of time.

Files: `src/shell_parser/parse.rs` (`ast::For`, the reserved words, `parse_for_clause`),
`src/shell_parser/json_fmt.rs`, `src/runtime/shell/states/For.rs` (new),
`src/runtime/shell/builtin/break_continue.rs` (new), `src/runtime/shell/interpreter.rs` (`LoopJump`,
`loop_depth`, `loop_jump_pending`, the node table), `src/runtime/shell/dispatch_tasks.rs`
(`ShellLoopYieldTask`), `src/runtime/dispatch.rs`, `src/event_loop/ConcurrentTask.rs`,
`src/runtime/shell/{Builtin,IOWriter,mod}.rs`, `src/runtime/shell/states/{Pipeline,Async}.rs`,
`docs/runtime/shell.mdx`, `test/js/bun/shell/bunshell.test.ts`, `test/js/bun/shell/parse.test.ts`.

### 2026-09-24: `--watch-path` and `--watch-exclude`

`bun --watch` and `bun --hot` watch what the entry point imports and nothing else. A server that
reads its templates, its SQL or a config file with `fs` does not restart when one of them changes,
and the answer since v1.1.27 has been to import the file so that it lands in the module graph. The
opposite wish is as old: a file that is imported and must not trigger anything, because another
tool rewrites it while the server runs (a Vite build next to a `--watch`ed server restarts it in a
loop) or because it is client code the server only passes along. Both are oven-sh/bun#5278 (42
thumbs up, open since 2023). Node has `--watch-path`, Deno has `--watch=<paths>` and
`--watch-exclude`, and upstream has been taking Node's watch flags as they come
(`--watch-kill-signal` is recent), so the names are theirs:

```sh
# restart when a template or the config changes, although nothing imports them
bun --watch --watch-path ./views --watch-path ./config.json server.ts

# same, but reload in place: globalThis, the HTTP server and its connections survive
bun --hot --watch-path ./views server.ts

# --watch-path alone turns on --watch, as in Node
bun --watch-path ./views server.ts

# rerun the tests when a fixture changes
bun test --watch --watch-path ./fixtures

# another tool rewrites src/generated/ while the server runs
bun --watch --watch-exclude src/generated server.ts

# reload for server code, never for the client components it also imports
bun --hot --watch-exclude '**/*.tsx' server.ts

# Node's meaning of --watch-path: these paths and nothing else
bun --watch-path ./views --watch-exclude '!views/**' server.ts
```

`--watch-path` takes a file or a directory (recursive), relative to the working directory, and can
be repeated. Unlike Node, where the flag replaces the watching of imported modules, it adds to it,
which is what Deno does and what the issue asks for. The path does not have to exist, and neither
do the directories above it: a config file that is created later, or a `dist/client` that a build
makes, is picked up when it appears, and a directory that is deleted and made again
(`rm -rf dist && bun run build`) is watched again, under `--hot` too, where no restart would do it.
An editor that saves by renaming a temporary file over the target (vim, JetBrains, most formatters)
is seen every time, not only the first, and a symlink to a file is followed to its target. Changes
inside `node_modules` and `.git` below a watched directory are ignored, or every `bun install` and
every `git fetch` an IDE runs in the background would restart the process. `--watch-exclude` takes a
`Bun.Glob` pattern and applies to both kinds of file: an imported file it covers is never watched
(the entry point included), and a change below a `--watch-path` directory it covers is dropped. A
pattern is relative to the working directory (`../shared` works) or absolute, covers what it
matches and everything below it (`src/generated` is a whole directory, because that is what people
will type), and a leading `!` turns it around.

How it is built:

- The paths. `bun_watcher::Watcher`, the watcher behind `--watch` and `--hot`, is shaped around the
  module graph: one entry per file (on macOS one file descriptor per file), a 16-bit index, and on
  Windows nothing above the project root. A `--watch-path` is a plain tree of files, which is what
  the `fs.watch()` backend is for (inotify with new subdirectories followed, FSEvents,
  `ReadDirectoryChangesW`; recursive, anywhere on disk, no descriptor per file), and upstream
  rewrote that backend recently and says in its header that it is deliberately independent of
  `bun.Watcher` for exactly this reason. So `src/runtime/cli/watch_path.rs` creates `FSWatcher`s
  natively, with native host functions as listeners (`new_function_with_data`, the pattern
  `UpgradedDuplex` uses).
- Two watchers per path. `own` is on the path itself while it exists: recursive for a directory,
  and through the link for a symlink to a file. `above` is on the deepest directory above the path
  that exists, normally its parent, and only looks at events that name the next component on the
  way to the path. That is how a plain file is watched (a watch on the file is tied to an inode
  that a rename-save replaces), how a missing path is seen being created however many directories
  are missing, and how a directory that comes back gets a new recursive watcher. `own` is never
  kept across such an event, even when the path looks the same: the first version compared
  `(st_dev, st_ino)` and the review found that overlayfs, ext4 and xfs hand a recreated directory
  the inode number it had before. The watchers are held through `bun_jsc::Weak` on their JS
  wrappers, so closing one never touches freed memory however it went away.
- Every event. The `fs.watch()` backends drop an event that has the path and type of the one
  before it within a millisecond. For `fs.watch()` that hides the second `IN_MODIFY` of one write.
  For this feature it hid the `mkdir` of `rm -rf dist && mkdir dist` (both are `'rename'` of
  `dist`), after which nothing was watched: lost 3 times in 32 in the review's trials, 0 in 25
  after. `Arguments` of `FSWatcher` gets an `every_event` field that only this feature sets; the
  reloads it asks for are coalesced downstream anyway.
- The reload. The listeners run on the JS thread and call a new
  `hot_reloader::reload_from_js_thread`: under `--watch` that is `VirtualMachine::reload`, which
  runs the `--watch-kill-signal` handlers and replaces the process, under `--hot` it sets the
  existing `hot_reload_deferred` flag, which the run loop already turns into a reload once the
  entry point has settled, the way it does for a change that arrived during a pending top-level
  await. A file the import watcher already has on its list is left to it, so a watch path that
  covers imported files does not reload twice.
- The excludes live in one place every producer goes through. Files reach the watcher from the
  module loader, the transpiler store, the bundler, the resolver and the test runner, all through
  `Watcher::add_file`, so the check sits in `append_file_maybe_lock` and answers
  `FdOwnership::Caller`, the answer a caller already gets on Windows for a file outside the project
  root. The same `Watcher::is_excluded` is asked by the `--watch-path` listeners, so the two halves
  cannot disagree about what a pattern means. A pattern is turned into one absolute glob when the
  watcher is set up (`src/watcher/exclude.rs`: `./` and `..` resolved against the working
  directory, whose own glob characters are escaped; backslashes are separators on Windows) and
  matched against the absolute path only. Matching the relative path as well, as the first version
  did, makes a negated pattern exclude everything, because one of the two forms always fails to
  match. The entry point has reload paths of its own in the hot reloader that go by its hash and
  not by the watchlist, so an excluded entry point clears that too. `bun_watcher` gains a
  dependency on `bun_glob` (no cycle: both sit on `bun_core`/`bun_paths`/`bun_sys`). Without the
  flag the cost is one `is_empty()` per newly watched file.
- `bun test`. Works under `--watch` in every mode. `--isolate` closes what a test file left open
  together with the global it retires, `fs.watch()` watchers included, so `watch_path::restart` arms
  them again after each swap, in the new global. With `--parallel` the coordinator never swaps its
  global and nothing is lost.

A review pass (five readers with the debug build, one per area, and a skeptic who re-ran every
claim) confirmed 25 findings against the first version, none of them in the memory handling and
most of them in what the feature promised: the two ways a recreated directory was lost under
`--hot` (above), a symlinked file and a nested path with a missing parent that were never watched,
negated globs, `..`, escaped brackets and a working directory of `/` in exclude patterns, an
excluded entry point that restarted anyway, a panic on a path longer than `PATH_MAX` (both joins
are the checked kind now), a double reload, and three test assertions that could not fail: "the
excluded file does not restart the process" passed with the exclude flags removed, because one
restart picks up every change made before it. Those tests now wait for something only a process
that was not restarted can say: the fixture names its run and prints a line every few milliseconds
once it sees the new contents, and the test waits for the third line of the run that was current
before the write. With the flags removed they fail.

Four bugs in upstream turned up and were reported through the hand-off instead of being fixed
here, with one exception. On Windows, `fs.watch()` keeps one libuv handle per directory and ignores
`recursive` when a second watcher asks for the same directory, so whoever comes first decides for
everyone (stock Bun: `fs.watch(dir)` then `fs.watch(dir, { recursive: true })` never reports a
nested file). This feature puts a plain watcher on the parent of every path, usually the project
root, before user code runs, which would have silently broken a script's own recursive watcher
there, so the six-line fix (the key gets the flag, as on POSIX) and a test for it are part of this
commit; drop them when upstream has its own. Reported only: the duplicate suppression above folds a
delete and a create into one `'rename'` where Node delivers two; on macOS the FSEvents prefix match
has no path-boundary check, so by reading, a watcher on `views` also hears about `views2/` and
`views.bak`, which would make `--watch-path views` reload for them (not confirmed, no macOS machine);
and `bun --conditions build main.js` runs `bun build`, because command detection skips options
without knowing which ones take a value, so `bun --watch-path test server.ts` runs `bun test` (the
docs say to write `./test`; that report was not picked up).

Verified on Linux and on Windows Server 2019 (built there on top of plain upstream `main`: the
patch applies without the rest of the stack, and the ten new tests pass on both, the symlink one
skipped on Windows). macOS is only type-checked (`cargo check` for `aarch64-apple-darwin`) and
reasoned about from the FSEvents backend. `test/js/node/watch/` passes on Linux and
`fs.watch.test.ts` on Windows with the backend change.

Not done, and known: a change to a `--watch-path` is noticed on the JS thread, so a script that
blocks the event loop is restarted by an edit to an imported file but not by these until the loop
turns again. Serial `bun test --isolate` can miss a change that lands while one test file hands
over to the next, or during a file that never yields to the event loop; making that exact needs
native (not JS-bound) handlers in the `fs.watch()` backend, which is also what would lift the first
limit. No `bunfig.toml` section yet (`[watch]` with `path` and `exclude` is the obvious shape), no
`bun build --watch` support, no `.gitignore` awareness, and FreeBSD's kqueue backend reports no file
names, so a single-file path there reloads on any change next to it and misses saves in place.

Rebase notes: 38 patches onto oven-sh/bun 8d36bff512, no conflicts, nothing dropped, the fork's
three workflows were green after yesterday's push. The patch touches no line another soup patch
owns (its tests sit at the end of `watch.test.ts`, away from the `.env` tests of 2026-08-23, and
the `--hot` tests live there too because `hot.test.ts` only imports `tempDir` through that earlier
patch), and was built and tested on Windows without the rest of the stack.

Files: `src/runtime/cli/watch_path.rs` (new), `src/watcher/exclude.rs` (new),
`src/watcher/{Watcher.rs,lib.rs,Cargo.toml}`, `Cargo.lock`, `src/jsc/hot_reloader.rs`
(`reload_from_js_thread`, `ImportWatcher::{is_excluded,is_watching_file}`,
`HotReloaderCtx::watch_exclude_patterns`), `src/runtime/node/{node_fs_watcher,path_watcher,win_watcher}.rs`
(`every_event`, the Windows key), `src/runtime/cli/{Arguments,mod,run_command,test_command}.rs`,
`src/options_types/context.rs`, `docs/runtime/watch-mode.mdx`, `docs/snippets/cli/run.mdx`,
`docs/test/runtime-behavior.mdx`, `test/cli/watch/watch.test.ts`,
`test/js/node/watch/fs.watch.test.ts`.

### 2026-09-25: `bun install` merges a `bun.lock` with git conflict markers

When two branches change dependencies, `git merge` leaves `<<<<<<<` in `bun.lock`. Bun read the file
as JSON, failed on the first marker, printed `warn: Ignoring lockfile` and resolved the project as if
it had never been installed. Every dependency moved to the newest version its range allows, the
ones that no branch had touched included, and the install exited 0. With `--frozen-lockfile` the
same file ended in `error: lockfile had changes, but lockfile is frozen`, which says nothing about
the cause. npm, yarn and pnpm read a conflicted lockfile and merge it. For Bun that is
oven-sh/bun#17717, and the workaround in that issue (`git checkout main -- bun.lock`, then
`bun install`) gives up the versions of one side. Now:

```sh
git merge feature
# CONFLICT (content): Merge conflict in bun.lock
# resolve package.json by hand, leave bun.lock as it is

bun install
# note: bun.lock contains git merge conflict markers, using the merge of both sides

git add bun.lock
```

What the merge does:

- A package that one side has is kept, at the version that side locked.
- When the sides have two versions of a package at one path of `node_modules`, the higher version
  keeps the path, and what is below that path is taken from the side of that version. A dependency
  whose range does not take the version gets the one that its own side locked.
- When the sides have two ranges for a dependency (`^1` and `^2`), two values for an entry of
  `overrides` or `catalog`, or the dependency in two groups, package.json says which is right, as
  on every install. The packages of both sides stay in memory until it has been read, so the
  dependency gets the version that the side with that range locked.
- The registry is asked for a dependency that has a package on neither side, and for the manifest
  of a dependency that package.json has with another range than the merge. The resolver reads a
  manifest before it takes a package, also one that the lockfile has. For two branches that add
  one dependency each, that is no manifest request at all. bun 1.4.3 asks for one per package on
  the same files (3 of 3 in the test) and moves `kept` from 1.0.0 to 1.1.0.
- `overrides`, `catalog`, `catalogs`, `trustedDependencies` and `patchedDependencies` are the union
  of both sides, ours on the same key. package.json decides here too.
- The markers of `merge.conflictStyle = diff3` and `zdiff3`, a longer `conflict-marker-size`,
  `\r\n` line ends, and the longer markers that git leaves in the base of a merge with two
  ancestors are read.

What it does not merge, because bun cannot know which side is right: two tarballs or two
integrity hashes for one package, and two packages at one path of which one is a tarball, a git
repository or a folder. A side with a `lockfileVersion` that this bun does not read, markers that
do not pair up, and a side that is not a lockfile are left alone too. Such a file gets what it got
before (the parse error, `Ignoring lockfile`, everything resolved again), and one line more:
`note: bun.lock contains git merge conflict markers that bun cannot merge: one package has two
tarballs or two integrity hashes (kept@1.0.0)`.

What the commands do, each one run on a conflicted lockfile:

| Command                                                            | With markers in `bun.lock`                                                                                                                  |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun install`, `bun add`, `bun remove`, `bun update`               | merge, resolve what is open, save                                                                                                           |
| `bun install --frozen-lockfile`, `bun ci`, `--production`          | `error: bun.lock contains git merge conflict markers, but lockfile is frozen`, exit 1, nothing written                                      |
| `bun install --dry-run`, `--no-save`                               | use the merge, say that `bun.lock` is not saved                                                                                             |
| `bun pm ls`, `bun pm hash`, `bun why`, `bun outdated`, `bun audit` | read the merge and say so. When a dependency has no package in it: the error of before, and `note: ... Run bun install to merge both sides` |
| `bun dedupe`, `bun pm trust`, `bun audit fix`                      | refuse, `note: run 'bun install' first`                                                                                                     |
| `bun prune`                                                        | as before: the parse error, exit 1                                                                                                          |

How it is built:

- Where. `Lockfile::load_from_dir` is the one reader of `bun.lock` for every command, and a marker
  line can never parse as JSON (not in a key, not in a value, bun writes every string on one line).
  So the merge hangs off the arm that handles the parse error, and a lockfile that parses does
  nothing new: no scan for markers, no extra pass. What a clean load and a clean install pay is one
  `usize` read for the log position, one byte for the new `LoadResultOk::merged_conflict` (it sits
  in padding, a `const` assert holds `LoadResult` at three words), one more argument to the text
  loader, and in `install_with_manager` four branches on that byte and one empty map on the stack
  (two empty `Vec`s, no allocation). These counts are from reading the code. They are not
  measured: there is no release build of this commit, and `valgrind`, `perf` and `strace` are not
  installed where it was written.
- Two documents, one union (`src/install/lockfile/merge_conflict.rs`). The lines outside the hunks
  plus the lines of one side make the document of that side. Both are parsed with the lockfile's
  own JSON parser, so a hunk can cross any line of the file. The union is written row by row. A
  row is always taken whole from one side, its tarball and its hash never mix.
- Who keeps a path. For each key of `"packages"` the union knows the row of each document. The
  higher version keeps the key, and only the document of that row can fill the keys below it: the
  `node_modules` of a package belongs to the version that is installed there. The first version
  decided key by key. The review read from the code what that does: the `outer/leaf` that ours has
  for `outer@1.0.0` ends below the `outer@1.1.0` of theirs, and a nested row with `"bundled": true`
  makes a dependency of the other version bundled, which means never installed.
- The rows that do not keep their path are kept too. They move to a key below `:ours/` or
  `:theirs/`, with everything their document has below them. A `:` is not valid in a package name,
  so no dependency reaches such a key by path, and the package is in the graph with its own
  dependencies bound as its side had them.
- The loader gets `LoadMode`. `Recover` leaves a required dependency without a row unbound where
  `Strict` fails the load. It is read in the three arms that return an error today, after
  `may_stay_unresolved`, so the strict path has no new branch. Only the merge passes `Recover`.
- Every dependency is checked against its range, not only the rows of the hunks: in real merges
  most wrong bindings are outside the hunks, where git merged lines on its own. A dependency whose
  package does not fit goes to the version that lost the path to that package, which is what its
  side had locked, else to the highest package of the merged graph that fits, else to the
  resolver. The check has to know what bun binds out of range on purpose, or a merge turns a
  correct lockfile into work for the registry: peers, bundled dependencies, overrides (scoped ones
  too) and catalogs (through `dedupe::effective_npm_range`, shared with `bun dedupe`), two rows of
  one owner that share a folder, workspaces, optional dependencies that the registry has nothing
  for, and a plain dependency that follows an `npm:` alias of its own name. That last rule is the
  resolver's, and the merge asks the part of it that a lockfile alone can answer
  (`Group::is_satisfied_by_a_bound_of`, see the re-port note below).
- Two purposes. A command that reads the lockfile (`Purpose::Read`, the 18 call sites that load
  with `::<true>`) gets a merge only when it is complete. It is printed with the lockfile's own
  stringifier and loaded again with the strict loader, so what the command sees is what a load of
  the saved file gives. `install_with_manager` (`Purpose::Install`, through the one new entry
  `Lockfile::load_from_cwd_for_install`) gets the graph as it is, with the packages that lost
  their path and with dependencies that have no package. It compares with package.json first, the
  resolver takes the lost packages where package.json asks for them (`Lockfile::get_package_id`
  prefers a package of the lockfile), and `clean_with_logger` drops the rest before the save, as
  it does after `bun remove`. `load_from_cwd::<false>` (pack, publish, prune, the lockfile
  printer, 5 call sites) never merges. The auto-install of `bun run` moved to `::<false>`: it is
  reached only when `bun.lockb` is there, so the only thing it loses is a migration that could
  not happen.
- Dependencies without a package. `install_with_manager` hands them to the resolver after the diff
  with package.json, next to the loops that do the same for changed overrides and catalogs. The
  resolver does not look at the dependencies of a package that it takes from the lockfile, and in
  a merge such a package can have one without a package. So after the resolver is done the open
  dependencies of what it reached are handed over again, until there is none that is new.

Numbers, all from the debug build of this commit:

- A conflict hunk with the same row on both sides was put into each of the 51 `bun.lock` files of
  the repository. The merged load binds 15,832 dependencies. None differs from the clean load.
- The same for 20 lockfiles that bun wrote for shapes that are hard for a range check (aliases,
  overrides, peers outside their range, optional dependencies without a version, workspaces that a
  range binds): 69 dependencies, none differs.
- 134 conflicted merges were replayed from the history of bun's own `bun.lock` and `test/bun.lock`
  (commits off `main` that touch a lockfile, merged with `git merge-file` into `main` as it was 7
  to 224 days later). 113 load for a command that reads, with 280,985 dependencies. 246,840 of
  them have a range that a version can answer: none is outside it, and no required dependency is
  without a package. 21 do not load for a reader: in 20 a dependency has a package on neither
  side, which `bun install` resolves, and one has a folder and a package of the registry at one
  path. In these merges 338 paths have two versions. For 54 of them git wrote the row of one side
  into a hunk and took the row of the other side outside of it, so the document of a side has
  two rows for one path and its own is the one that the other document does not have.
- Tests: 70 in `test/cli/install/bun-lock.test.ts`. They spawn about 80 processes, and one of
  them is `git merge-file`. With the debug build of this commit 70 pass. With bun 1.4.3-canary.1
  66 fail. The 4 that pass pin what did not change: a lockfile without markers that lacks a
  package, `bun pm pack`, and markers in package.json.

Other suites, on the debug build of this commit with `--timeout 120000`: the 110 tests of
`bun-lock.test.ts` pass, and so do 2,160 of 2,172 tests in 33 other files of `test/cli/install`,
the ones that load a lockfile most (lockfile-only, lockfile-version-2, config-version, frozen
lockfiles, catalogs, overrides, update, workspaces, isolated-install, hoist, add, remove,
bun-lockb, pm, why, licenses, scan, link, patch, publish, prune, pm-diff, dedupe, audit,
lifecycle scripts). None of the 12 that fail loads a lockfile with markers. 3 run a lifecycle
script that does not find `node` or `bun` with the debug binary, and 1 compares an output into
which the debug build prints an error trace. They pass with bun 1.4.3. 2 fail with bun 1.4.3
too. 6 in `bun-patch.test.ts` were a use after free in the `engines.bun` patch of 2026-08-27,
which is repaired in that patch (rebase notes). The other files of the directory were run on the
first version only (bun-install-registry, bun-install and 11 more, with no failure but timeouts
and hosts that the network here blocks) or not at all (bunx, migration and 20 smaller ones).

A review pass (five readers, one per area: the text of the union, the range check, the commands,
memory and panics, tests and docs) read the first version without running it and came back with
44 findings, 35 when the ones that two readers had are counted once. Each came with the files and
the command that show it. 32 led to a change. Where that changes what bun does, a test was made
from the input of the finding, with two exceptions: the time to merge two long arrays, and the
`configVersion` that a command that only reads gets. 3 changed nothing: an optional dependency
outside its range, the commands that read the lockfile before they install (both under "Not
done"), and the hunks with two equal sides in the tests, which git does not write and which send
a lockfile through the merge as it is. The findings that changed the design, as the readers
saw them in the code (one was run against the first version, and it says so):

- The union decided who keeps a path key by key. What is below a path has to come from the side
  whose package keeps it (above).
- A merge without open dependencies was printed and loaded again before package.json was read,
  which dropped the packages that had lost their path. When package.json kept the range of that
  side, the registry was asked and the newest version came in. Now the install gets the graph as
  it is.
- The printed merge always said `"configVersion": 1`, because the printer takes that from the
  options and no command has set them when the lockfile loads. A project at configVersion 0
  with workspaces would have changed from the hoisted to the isolated linker by merging. The
  value of the sides is put back after the second load, and the install does not print at all.
- A peer dependency spoke for a dependency of the same name and owner that was outside its range.
  A dependency that one side had moved to another group was two rows of one folder, and the row
  that fit spoke for the one that did not.
- A range stayed with a tarball or a git repository that the other side had at the path.
- The resolver took a package that had lost its path and did not look at its dependencies, and
  the install ended in `failed to resolve`.
- `lockfileVersion` 0 with a workspace that has no row ended in an index out of bounds in the diff
  with package.json. A side with a `lockfileVersion` of a later bun was merged at the version of
  the other side, without a word.
- `leaf: npm:real@latest` with an override for `leaf` lost its package to the override in every
  merge: `dedupe::effective_npm_range` looks for the override under the name of the dependency
  and the resolver under the name of the package. This one was run first, and it held. The
  merge does not check such a dependency now. `bun dedupe` has a guard of its own and is not
  affected.
- A merge that fails after the loader has read the overrides left their `npm:` aliases in
  `PackageManager::known_npm_aliases`, as positions in a text that is gone. The map is put back.
  The reader wrote that a lockfile without markers has the same problem in upstream. It has:
  see below.
- The notes. `bun update --recursive` printed `Run bun install to save it` and then saved,
  `bun pm trust` printed `reading the merge` and then refused, and `--lockfile-only --dry-run`
  printed `bun.lock is not saved` and then saved (that it saves is upstream's). The commands that
  read print the note for reading now, and the loader prints only why it does not merge.
- Tests that could not fail. In every test the value that had to win was the one of theirs. Three
  tests checked the requests to the registry with the manifests of their first install in the
  cache. No test had a base in a diff3 hunk that would change the result if it leaked into a side.
  The test for optional and peer dependencies compared the saved lockfile, which cannot show
  them. It installs with the isolated linker now and compares with the same lockfile without
  markers.

The tests of these findings pass on this commit. They were not run against the first version,
which was never pushed, so "fails without the fix" is shown for the released bun only.

The rework was wrong once, and the replay of the 134 merges showed it: the first rewrite of the
path rule took a document with two rows for one path for damage, and 15 merges that the first
version had taken were refused.

One bug in upstream turned up and went to the hand-off, with a test that fails on bun 1.4.3. A
`bun.lock` without any marker that fails to load after its `overrides` were read (a row without
a hash is enough) leaves the aliases of those overrides behind. bun ignores the lockfile, and the
install that follows gives `kept@^1.0.0` the alias of an override that package.json does not
have. Its name is a position in a buffer that is gone, so bun asks the registry for `/` and ends
with `error: kept@^1.0.0 failed to resolve`. This commit puts the aliases back only around its
own loads. The loads of upstream are left for upstream's fix.

Not done, and known:

- An optional dependency that is bound to a package outside its range stays there when the merge
  has no package that fits. In a lockfile that bun wrote that means the registry had nothing, and
  a load without markers binds it the same way. After a merge it can also be what git left of a
  row that one side had. The resolver is not asked.
- A dependency on a tarball or a git repository is not checked against the package it is bound
  to. Two such packages at one path end the merge, but a range line and a row that git merged
  from two sides on its own get past it.
- `bun pm ls` and the other reading commands fail on a merge that lacks a package, and so do the
  commands that read the lockfile before they install: `bun update --recursive`, `bun update` with
  a pattern, `bun update -i`, `bun patch --commit`. `bun install` and a plain `bun update` merge
  the same file. The note says to run `bun install`.
- `bun dedupe`, `bun pm trust` and `bun audit fix` refuse a conflicted lockfile. They could merge
  first.
- When the sides have two `lockfileVersion`s, the merge loads at the later one and, when a row does
  not pass its checks, at the earlier one, and the saved file keeps the version that loaded. A row
  with a tarball outside the registry and no hash, which version 2 turns away, stays in the
  lockfile this way when it comes from a side that is still at version 1. That is what a clean
  merge of that side gives too. It is a choice for the bun team to look at.
- Conflict markers in `package-lock.json`, `yarn.lock` and `pnpm-lock.yaml` when bun migrates them.
  `bun.lockb` is binary and has no markers.
- A dependency that a clean merge (no markers) left with a package outside its range. That needs
  the check on every load, which every install would pay for. Upstream has it open as
  oven-sh/bun#43795 and oven-sh/bun#43375, and this patch stays out of its way: the check is one
  function and runs only after a conflict.
- Not run on Windows or macOS. The code has no branch for a platform, and the `\r\n` test runs on
  Linux.
- The tests spawn about 80 processes of the debug build and take 18 seconds on a calm machine.
  The machine this was written on ran at a load average of 120 to 640 from other work. In some
  runs there, up to 12 tests went over the default timeout of 5 seconds. With `--timeout 120000`
  all pass in every run.

Rebase notes: 39 patches onto oven-sh/bun 29d9638da3, one conflict, nothing dropped, the fork's
workflows were green after the push of the day before. The conflict was in
`src/runtime/jsc_hooks.rs`: upstream 4227e466c4 added a line right below the block that the
`bytes` loader patch of 2026-09-10 adds, and both are kept. This entry landed a day after its
date. The design review of where the merge should live took nine hours, and the review of the
first version found enough to write the path rule and the install flow again.

One earlier patch changed. The `engines.bun` check of 2026-08-27 read the range from the tree
that the package.json cache keeps. `bun patch` in a workspace package edits the root
package.json and puts the new text into the cache entry, and the tree still points into the old
text. AddressSanitizer reported the read after free in six tests of `bun-patch.test.ts` while
the suites ran for this entry. The check reads the range from the parse that
`install_with_manager` makes of the file now. The change is folded into the commit of
2026-08-27, so the commits from there on have new hashes.

The patch applies to upstream `main` without the rest of the stack (`git apply --check` on
29d9638da3). It was built and tested on top of the stack only. It shares six files with earlier
soup patches and none of their lines.

Re-ported on 2026-10-15. The stack was pushed without this patch for a few hours that day: the run
that added `Bun.unescapeHTML()` dropped it in its rebase, as a port that would be a rewrite. A
second run of the same day had set it aside too, tried it at the end, and found that it is not one.
oven-sh/bun#44968 rewrote most of what this patch hooks into (the loaders, `bun outdated`, `bun
audit`, `bun pm trust`, `bun pm pack`, the alias and override rules of the resolver), so the hooks
were applied again by hand on the new code. `merge_conflict.rs` is as it was but for what upstream
now does itself. The text loader no longer records `npm:` aliases: it takes the manager read-only,
and `known_npm_aliases` holds the text of an alias, not positions in a buffer. So the map is not put
back after a merge that fails, and the upstream bug that is described above is gone. The resolver's
alias rule has more conditions than the loop it replaced (the ranges have to intersect, the manifest
of the alias is asked, a rule of `overrides` for the dependency wins), so the shared
`follows_npm_alias` is gone, and the merge asks `Group::is_satisfied_by_a_bound_of`, the first of
those conditions. That is the wider question, so the merge moves fewer dependencies on its own and
the resolver decides the rest. `--lockfile-only --dry-run` no longer saves upstream, so it gets the
note that `bun.lock` is not saved. `bun pm pack` and `bun publish` no longer read `bun.lock`, which
leaves `bun prune` as the command that fails on the markers as before. `bun pm ls` lists what is on
disk and wants a `node_modules`, so the test of a command that only reads uses `bun pm hash-string`.
Two tests changed what they expect with upstream: a rule of `overrides` for the package that asks
now wins over an alias that an override declares, and an exact version that the lockfile has needs
no manifest. One test went (`bun pm pack does not merge`) and one became a row of another, so there
are 69. All pass on the debug build, and so do the 317 tests of the whole file with `--timeout
120000` (at the default 5 seconds, 61 and 105 of the tests of that file timed out in two runs on
this machine, all of them upstream's own and none of them a test of this patch).

Files: `src/install/lockfile/merge_conflict.rs` (new), `src/install/lockfile.rs`
(`load_from_cwd_for_install`, `LoadResultOk::merged_conflict`, the parse-error arm),
`src/install/lockfile/bun.lock.rs` (`LoadMode`),
`src/install/PackageManager/install_with_manager.rs` (`report_merged_conflict`, `OpenEdges`),
`src/install/PackageManager.rs` (`load_lockfile_from_cwd_or_exit`), `src/install/dedupe.rs`,
`src/runtime/cli/{package_manager_command,outdated_command,pm_trusted_command,audit_command}.rs`,
`src/install/{migration,pnpm,yarn}.rs` (the new field), `docs/pm/lockfile.mdx`,
`docs/pm/cli/install.mdx`, `test/cli/install/bun-lock.test.ts`.

### 2026-09-26: `collectCoverageFrom`, coverage for the files that no test loads

`bun test --coverage` reports the files the tests loaded. A source file that no test imports is not
in the table and not in `lcov.info`, lowers nothing, and passes every `coverageThreshold`, so the
report of a project with one test file and a hundred untested modules can say 100%. That is
oven-sh/bun#5928 (93 upvotes, open since 2023, the most of any coverage issue), and the workaround in
the thread is a test that imports everything, which runs every module's side effects and calls the
result 40% covered. Jest has `collectCoverageFrom`, Vitest `coverage.include`, c8 `--all`. The name
and the rules here are Jest's, since the `[test]` section already speaks Jest
(`coveragePathIgnorePatterns`, `coverageThreshold`):

```toml
[test]
collectCoverageFrom = ["src/**", "!src/generated/**"]
```

```sh
bun test --coverage
# -------------------|---------|---------|-------------------
# File               | % Funcs | % Lines | Uncovered Line #s
# -------------------|---------|---------|-------------------
# All files          |   33.33 |   33.33 |
#  src/billing.ts    |    0.00 |    0.00 | 1-4,7-19,22
#  src/cart.ts       |  100.00 |  100.00 |
#  src/legacy/tax.js |    0.00 |    0.00 | 1-2,5-9
# -------------------|---------|---------|-------------------

# the same list for one run; it replaces the one in bunfig.toml
bun test --coverage --collect-coverage-from 'src/**' --collect-coverage-from '!src/generated/**'
```

With the list set the report is about exactly the files the list names. A file that nothing loaded
is in it with no line and no function covered, counts towards `All files` and has to pass
`coverageThreshold`; a file that a test loads and the list does not name is left out. Patterns are
relative to the directory `bun test` runs in, are asked in order, and the last one that matches
decides; `!` takes files out, and a list of only `!` patterns names everything none of them takes
out. `node_modules`, `coverageSkipTestFiles`, `coveragePathIgnorePatterns` and the ignore comments of
2026-09-16 apply to the new rows as they do to the old ones. Without `--coverage` the list does
nothing, and without the list nothing changes.

Where it lives and how a row is made was decided before any code was written, by a design review
that put six designs next to each other (the mechanism of the closed community PR
oven-sh/bun#27694, which counts physical lines, among them):

- One place. The serial runner and the `--parallel` coordinator each collected their reports and
  called the printer. Both now hand them to one function, `finish_coverage_reports`, which is the
  only caller of the printer, and with a list set that function first makes the reports complete
  (`src/runtime/cli/test/CoverageInclude.rs`). It runs once per run in the process that prints,
  after the workers' reports are merged, where the command line, `bunfig.toml` and `--config` are
  all known. Workers do not know of the list and no flag is forwarded to them, so serial,
  `--isolate` and `--parallel` apply one list in one way. A run without the list pays one
  `is_none()`.
- The file is not loaded. It is read, parsed and printed the way the module loader does it (a copy
  of the VM's transpiler, as the transpiler thread pool makes one, with macros off and without the
  transpiler cache, the watcher or the linker), so code in it never runs: the test suite has a
  never-loaded file that calls `process.exit(3)`.
- Lines come from the source map. The printed text counts as one block that never ran, and the
  converter that loaded files go through maps it to lines. So the lines are the lines that have
  code; comments, empty lines and types are not among them, and a file with nothing else (a
  `.d.ts`, a module of interfaces, an empty file) has no row. The source map is kept next to the
  file for the length of the call and is not stored where the loader stores its maps.
- Functions come from JavaScriptCore, without running anything. A new read-only C++ function
  parses the printed text and generates the bytecode of the top level only
  (`recursivelyGenerateUnlinkedCodeBlockForModuleProgram`, which `bun build --bytecode` already
  uses), and lists the ranges JSC registers when it loads a file: the source's own range and the
  function declarations and expressions of the top-level code, and for CommonJS those of the
  wrapper function. That is the count of a file that a test imports without calling anything,
  as long as the import itself calls nothing with functions in it; a test compares the two for
  nine shapes of file. It happens in the thread's bytecode VM, not in the VM that ran the tests,
  which a guard frees when the last file is done.
- A function that never ran makes a loaded file count every line from its first to its last,
  comments and empty lines too. That widening is not applied to a file that nothing loaded: its
  lines are already known from the whole text, so they are the lines a run of the whole file would
  report (the same test checks that none is missing and none is a comment).
- What is looked for. The walk starts below the directory each pattern begins with (`src` for
  `src/**/*.ts`, the root for `**/*.ts` or a list of `!` patterns), does not enter `node_modules`
  and `.git`, and keeps the files Bun reads as JavaScript or TypeScript by their extension. A
  `.vue` file that a plugin would load is left out without a word: a list like `src/**` names
  every stylesheet and image too.
- One row per file. A file is known by device and inode, so one that a test imports through a
  symlinked directory, or that the walk finds a second time through a link, has the one row of
  the file that was loaded and not a second one at 0%.
- The root is the directory the run started in, taken before the first test file runs. A test that
  calls `process.chdir()` does not move what `src/**` means or how the rows are spelled.
- Files that nothing loaded are added when the run ran at least one test file and got to its end.
  An empty `--shard` or a `--changed` that selects nothing loads nothing and exits 0 today, and
  would fail any threshold if every source file turned up at 0%; a run that `--bail` or a crash
  cut short does not know what the rest would have loaded. Those runs, and every run with
  `--changed`, get the loaded files filtered by the list and nothing else. Under `--parallel`,
  Ctrl-C during the pass stops it between two files and exits with the signal's code.

A file the list names that Bun cannot transpile (a syntax error, a call to a macro) gets one line
and no row, and the exit code stays what it was, which is what Jest and Vitest do. A list that
names no file at all gets a line too, since an empty report passes every threshold:

```
warn: Failed to collect coverage from src/draft.ts:12:3: Unexpected }
warn: No file matches collectCoverageFrom
```

A review pass on the first version (six readers, one per area, each with the debug build, and one
skeptic per finding who had to make it happen again before it counted) reported 43 findings and
confirmed all of them. What they changed:

- A crash. A `// @bun` file, or any file under `coverageIgnoreSourcemaps`, whose last line holds a
  function and has no newline made the converter index a slice at `u32::MAX`. Upstream panics the
  same way when a test imports such a file (reported through the hand-off); the guard the
  source-map arm already had is now in the other arm too, since this feature hands it files that
  nothing ever loaded.
- Which file is which. The first version asked the resolver how the loader would spell each file
  the walk found. The resolver answers from directory listings it cached earlier in the run, by
  lowercased name, and rewrites `x.js` to `x.ts`: a file a test wrote during the run had no row, a
  valid `c.ts` next to a new `c.js` was parsed as JavaScript and warned about, and `util.ts` next
  to an imported `Util.ts` was dropped in a serial run and reported under `--parallel`. A file is
  now known by device and inode, the loaded ones and the found ones alike, so a path through a
  symlink or in another case is the same file, and the row has the path the walk found.
- What the walk finds. The glob walker silently finds nothing for a pattern with a `/` inside
  braces (`{src/generated,lib}/**`) and gives up at the first directory it cannot open, so a
  `coverageThreshold` that should fail passed. The walk now takes `**/*` below the directories
  the patterns begin with, goes on after a directory that cannot be read (with a warning), and
  the matcher that judges loaded files judges every file found.
- What has a row. A module of types that ends in `export {}` had a row of one uncovered line and
  failed thresholds; that is decided on the syntax tree now (no statement but types, directives
  and empty exports). `*` matched the `..` of a file outside the project, which kept a loaded
  file from there in the report: a path outside the root is in no list.
- `lcov.info` could not be written (ENOENT, exit 1) after a test changed directory, because the
  directory was made relative to the new one and the file opened relative to the old one.
- Memory. The line table of every file leaked (LeakSanitizer), and JSC's parser cache kept the
  text of every file until the pass ended (27 MB to 196 MB for 2,000 files of 70 KB). Both are
  freed per file.
- A hang that is not this feature's, and that it must not add: JSC's parser takes time and
  memory without end for an array or object literal nested past its stack limit (about 5,600
  levels in a release build; `import` of a file with a literal 5,000 deep does not finish on
  upstream either). The pass refuses a text with literals nested more than 256 deep, with a
  warning.
- Ten sentences in the docs that were not true, among them that the function count equals that
  of an imported file (it is the count of the top-level code; a function that runs during the
  load adds the ones inside it), that the patterns are Jest's (the order rules are; the globs are
  `Bun.Glob`'s, and `<rootDir>/` and `./` in front of a pattern are now read), and what a run
  stopped by `--bail` prints.
- Tests that could not fail: the symlink test passed with the spelling step taken out, the
  `.d.ts` fixture had no row under any name, nothing covered the ignore comments,
  `coverageIgnoreSourcemaps`, `// @bun`, the order of the warnings, the errors for a bad list, or a
  `--parallel` run that `--bail` stops. Fifteen tests now; each fails on released Bun.

Left as found: for a file without `import`, `export`, `require` or `module`, the kind of module
decides whether Bun's CommonJS wrapper counts as a function. The pass goes by the extension and
then by `"type"` in package.json; the loader's `import` path goes by package.json alone and its
`require` path by the extension, so `lcov.info` can say `FNF:2` where a load says `FNF:3` (the
table and the thresholds are not affected). A syntax error that only JavaScriptCore finds (an
invalid regular expression) is warned about without its line. Under `--parallel --config`, the
workers read `bunfig.toml` and not the file `--config` names (upstream, reported), so a file a
worker left out for a reason of its own shows up as never loaded.

Cost, on a release build of this tree (Linux x64, a shared machine with a load average near 500, so
wall time is rough; `strace`, `perf` and `valgrind` could not be installed): the best of 20 runs
over 1,000 files that nothing loaded (50 lines and 3 functions each) took 262 ms with the list and
14 ms without, which is a quarter of a millisecond a file; the medians on that machine were 789 and
183 ms, and peak memory was 4 MB higher. A run without the list reads no file and no directory it
did not read before. In the binary the new code is about 30 KB by the linker map
(`finish_coverage_reports` with what is inlined into it 19 KB, `Report::never_executed` 3 KB, the
C++ reader 2 KB, the sort 4 KB); there is no build of the tree without the patch to give the exact
difference.

Not done, and known: files loaded only in a `Worker` or a child process are files that nothing
loaded (they already have no row today). With `--changed` the pass is skipped where Vitest narrows
it to the changed files; that needs the changed set out of `ChangedFilesFilter`. A run of zero test
files prints no report where Vitest prints one at 0%, which needs a decision on
`--pass-with-no-tests` against `coverageThreshold` first. Each `--shard` job reports the files it
did not load at 0%, so an `lcov.info` merged from shards can keep a few lines of a covered file at 0
(the lines of a never-loaded record are those of the whole text, about 4% more than a load reports).
A `// @bun` file is reported by the lines of its text, the pragma's line included. The pass is
serial on the main thread, and under `--parallel` Ctrl-C is only seen between two files. And whether
a file that does not transpile should fail the run instead of warning is a question for a
maintainer: upstream's review rules say that what the user asked for by name fails loudly, Jest and
Vitest say otherwise, and it is one branch either way.

Rebase notes: 40 patches onto oven-sh/bun 36cd1514ec, one conflict. Upstream reworked how a
coverage report is put together the day before (oven-sh/bun#43158 counts every load of a file, so
`Report::generate` now folds the blocks of several SourceIDs and calls the converter itself), which
is the function the ignore comments of 2026-09-16 thread their argument through; that patch was
re-ported onto the new shape, and its tests and upstream's 13 new ones pass together. The WebKit
upgrade of the same day (oven-sh/bun#43882) made `CString::data()` a `char8_t` pointer, which broke
two lines of the `bun:sqlite` `db.function()` patch of 2026-08-31 at compile time; they use
`legacyCStringPointer()` now, as upstream's own calls to SQLite do. Nothing dropped, and the fork's
workflows were green after yesterday's push. This patch builds on the 2026-09-16 one in two places
(the `ignored_lines` argument of the converter and `ignore_hints::scan`); without that patch, drop
the argument and the three lines in `CoverageInclude.rs` that read the hints.

Files: `src/runtime/cli/test/CoverageInclude.rs` (new), `src/runtime/cli/test_command.rs`
(`finish_coverage_reports`, `has_test_file_name`),
`src/runtime/cli/test/parallel/{aggregate,runner}.rs`, `src/sourcemap_jsc/CodeCoverage.rs`
(`Report::never_executed`, `NeverExecutedPass`, the converter takes its source map as an argument),
`src/jsc/bindings/CodeCoverage.cpp` (`CodeCoverage__withFunctionsOfText`),
`src/jsc/bindings/ZigSourceProvider.{cpp,h}`,
`src/options_types/{code_coverage_options,context}.rs`, `src/runtime/cli/Arguments.rs`,
`src/bunfig/bunfig.rs`, `src/runtime/cli/mod.rs`, `completions/{bun-cli.json,bun.zsh}`,
`docs/test/code-coverage.mdx`, `docs/test/configuration.mdx`, `docs/runtime/bunfig.mdx`,
`docs/snippets/cli/test.mdx`, `docs/guides/test/migrate-from-jest.mdx`,
`test/cli/test/coverage.test.ts`.

### 2026-09-27: user-defined metadata for S3 objects

An S3 object carries the key-value pairs its uploader gives it, as `x-amz-meta-*` headers, and
Bun's S3 client could neither send nor read them. That is oven-sh/bun#17339 (21 upvotes,
"specifically the inability to add metadata to the object" keeps several people in the thread on
the AWS SDK), oven-sh/bun#16048 (23) and, for reading, oven-sh/bun#19301. A maintainer wrote it
once: oven-sh/bun#26154, for the Zig tree, which its author closed unmerged in June. This is its
API on the Rust tree, `metadata` on an upload and on what `stat()` returns:

```ts
import { s3 } from "bun";

await s3.write("invoice.pdf", pdf, {
  type: "application/pdf",
  metadata: { customer: "1042", "reviewed-by": "ana" },
});

const { metadata } = await s3.stat("invoice.pdf");
metadata; // { customer: "1042", "reviewed-by": "ana" }

// the default of every upload of a file, or of a client
const report = s3.file("report.csv", { metadata: { source: "nightly" } });
await report.write(rows); // source: "nightly"
await report.write(rows, { metadata: { source: "manual" } }); // replaced, not merged
await report.write(rows, { metadata: {} }); // none, and so is null

// a presigned upload signs them: the request has to send the same headers
const url = s3.presign("avatar.png", {
  method: "PUT",
  metadata: { user: "1042" },
});
await fetch(url, {
  method: "PUT",
  headers: { "x-amz-meta-user": "1042" },
  body,
});
```

`write()`, `writer()`, `S3Client.write()` and `Bun.write()` to an S3 file send it, whatever the
data is: a string or a buffer in one `PutObject`, a `Blob`, a local file, another S3 file, a
`Response` or a stream, and in a multipart upload with `CreateMultipartUpload` and not with the
parts. `fetch()` with `PUT` to an `s3://` URL sends the `metadata` of its `s3` option. `stat()`
returns the `x-amz-meta-*` headers of the response without the prefix and with lowercase keys,
`{}` for an object that has none, and builds the object when the property is read for the first
time.

Keys are header names, so they are case-insensitive and are sent in lowercase, and
`{ Color: "red", color: "blue" }` is an error and not a coin toss. A key has to be made of the
characters HTTP allows in a header name. A value has to be printable ASCII: a line break would be
a header of the attacker's choice in a signed request, and for other characters a client and a
server have to agree on the bytes of a header, which the S3 emulation of the tests and Bun do not
(a value in UTF-8 is a `SignatureDoesNotMatch`). botocore refuses such values too
(`validate_ascii_metadata`). A `Map` or a `Headers` is refused, because it has no properties and
would upload as nothing. All of this throws before a request is sent. What Bun does not check is
the size. Amazon S3 stops at 2 KB of keys and values, other services at other sizes, so the
`MetadataTooLarge` of the service is what the caller gets.

The signature is where the work is. Signature Version 4 signs the headers in the order of their
names, so the metadata sits between `x-amz-date` and `x-amz-request-payer`, sorted, and it signs a
value without the spaces around it and with one space for every run of spaces (`"  a   b "` is
signed as `a b` and sent as written). The list of signed headers and the canonical request are
each written by one function for requests with and without metadata, and a request without it
pays one `Option` check: the fixed buffers stay, and only a request with metadata moves the
canonical request to the heap, since 2 KB of metadata next to a session token do not fit in the
4 KB that were enough until now. `SignResult` still holds its 11 headers in an array, and the
metadata headers are added to the request in `execute_simple_s3_request`, the function that every
upload of the S3 client passes through. In a presigned URL they are signed headers
(`X-Amz-SignedHeaders=host;x-amz-meta-user`), as in #26154 and in botocore, and only for `PUT` and
`POST`: the download link of a file that has metadata does not ask its reader for headers. The AWS
SDK for JavaScript moves them into the query string instead, where the uploader does not have to
know them. That would be a second mode, and the emulation does not read metadata from a query
string, so it could not have been tested here.

Differences from #26154: no limit of 32 entries and no 2 KB check in the client, values that are
not ASCII and keys that repeat are refused, `stat()` does not hold a strong reference to an object
that nobody may read, and a presigned `GET` leaves the metadata out.

The tests run against the S3 server that upstream added the day before
(`test/packages/s3-server`, oven-sh/bun#44054). It verifies the signature of every request, so a
header that is signed in the wrong place, or a value that is signed as written, is a 403 there as
it would be at Amazon. One test talks to a raw socket, because the emulation answers with
lowercase header names and `stat()` has to read `X-Amz-Meta-Customer` too.

A review pass (three readers: the signing, the plumbing, and the docs, types and tests) found
what follows, and all of it is fixed in this commit. `fetch()` to an `s3://` URL sent the metadata
for a stream and dropped it for a string. The HTTP client sends the first 250 headers of a request
and drops the rest without a word, so 300 small keys, which fit in 2 KB, were signed and not all
sent: a 403 for valid input, or an upload that loses keys on a server that reads a missing header
as an empty one. The limit is now a constant of the HTTP client, and `metadata` takes the 238 keys
that fit next to the other headers of an upload. `metadata: null` kept the default where the rule
of the repo is that `undefined` keeps it and `null` turns it off. The JSDoc said "no control
characters" for what is "printable ASCII". One test read an object that the test before it had
made, the helpers picked the last request of an operation and not of a key, and the test for
percent-encoding compared the URL and never sent a request.

Not done. Values in other scripts are not written as RFC 2047 encoded words, which is what Amazon
S3 decodes, and the encoded words it returns are not decoded: `stat()` gives the header as it
came. `Bun.write()` has none of the S3 options in its types, `metadata` included, so the docs show
it with the metadata of the file. The retry of a failed upload sends the metadata again, by
reading, and no test makes an upload fail once.

Three older bugs turned up on the way and were reported, not fixed here. `writer()` without
arguments ignores the `storageClass`, `partSize`, `queueSize` and `retry` of its file, and
`writer()` never sends `x-amz-acl`. `contentDisposition` and `contentEncoding` given to `file()`,
which is the form the JSDoc shows, are dropped by a later `write()`. And `fetch()` to an `s3://`
URL with a body that is not a stream ignores `acl`, `storageClass` and `requestPayer`.

Rebase notes: 41 patches onto oven-sh/bun a4f1429148, nothing dropped, two conflicts, both from
oven-sh/bun#44086 ("Say the platform once"), which removes the `#[cfg]` attributes that repeat the
gate of the item around them and with that takes one level of indentation out of
`CopyFile::run_async`. The `append` patch of 2026-08-29 adds three conditions to that function
and a parameter to `write_bytes_to_file_fast`, and the watch-path patch of 2026-09-24 adds a field
to `ChangeEvent`. Both were put on the new shape without their own repeated attributes, and their
tests pass (the `--watch-path` tests need `--timeout 60000` on a debug build on this machine: each
restarts a debug bun three times). The fork's three workflows were green after yesterday's push.

Files: `src/s3_signing/metadata.rs` (new), `src/s3_signing/credentials.rs` (`sign_request`,
`SignedHeaders`, `CanonicalRequest`, `SignOptions`, `S3CredentialsWithOptions`),
`src/s3_signing/lib.rs`, `src/runtime/webcore/s3/credentials_jsc.rs` (`get_metadata`),
`src/runtime/webcore/s3/{simple_request,multipart,client}.rs`,
`src/runtime/webcore/{Blob,S3File,S3Client,S3Stat,fetch,Response}.rs`,
`src/runtime/webcore/blob/Store.rs`, `src/runtime/api/{BunObject.rs,S3Stat.classes.ts}`,
`src/jsc/webcore_types.rs` (the S3 blob store), `src/http/lib.rs` (`MAX_USER_HEADERS` is public),
`packages/bun-types/s3.d.ts`, `docs/runtime/s3.mdx`, `test/js/bun/s3/s3-metadata.test.ts` (new),
`test/integration/bun-types/fixture/s3.ts`.

### 2026-09-29: `legalComments`, where the license comments of a bundle go

A comment that starts with `/*!` or `//!` is a legal comment: the license or the copyright notice
of a package, which a bundler has to keep. Bun kept them, minified or not, in the place where they
were in the code, and that was all it could do. oven-sh/bun#8727 asks for esbuild's
`--legal-comments` ("to have the licence exported to another file or to be removed completely"),
oven-sh/bun#9795 for the same from `Bun.build` (18 upvotes). A maintainer answered both: the
comments "are already extracted and emitted but we are missing a `--legal-comments` flag to control
what happens here", and "most of the work for this would be to just copy esbuild's implementation".
The linker had the two places marked (`// TODO: extracated legal comments`,
`// TODO: maybeAppendLegalComments`), the esbuild comparison page said "Not supported", and 13 tests
ported from esbuild were skipped with "legalComments not implemented in bun build". This is the
option, with esbuild's five values:

```sh
bun build ./src/index.ts --outdir ./dist --minify --legal-comments=linked
```

```ts
await Bun.build({
  entrypoints: ["./src/index.ts"],
  outdir: "./dist",
  minify: true,
  legalComments: "linked", // "none" | "inline" | "eof" | "linked" | "external"
});
```

```txt
dist/index.js            ends with /*! For license information please see index.js.LEGAL.txt */
dist/index.js.LEGAL.txt

/*! my-app (c) 2026 Acme, Inc. */

Bundled license information:

pkg-a/index.js:
pkg-b/lib/b.js:
  /*!
   * Copyright (c) Someone
   * Released under the MIT license
   */
```

`inline` is what Bun did and stays the default. `none` removes the comments. `eof` moves them to
the end of each output file, after the wrapper of the format and before the `footer`. `linked` and
`external` write them to `<output file>.LEGAL.txt`, one more output with `kind: "asset"` and the
hash of its content (in `outputs` too when there is no `outdir`), and `linked` ends the output
file with a comment that names it, before the `sourceMappingURL` comment and with the `publicPath`
when there is one. An output file that has no legal comments gets no file and no comment. In the
three modes that move them, a text that several files of the project repeat is there once per
output file, and the comments of a file under `node_modules` are listed under the path of that file
in its package (what follows the last `node_modules`), because a notice that does not name its
package would read as the license of the whole bundle. Files with the same comments share one
entry. With `eof` that list is one comment, in which `(*` and `*)` stand for `/*` and `*/`. All of
this is esbuild's behaviour, and for the same input the text is the same: compared with esbuild
0.21.5, the version in the repo's `node_modules`, the end of the file and the `.LEGAL.txt` file
differ only in the shared entries, which esbuild has had since evanw/esbuild#4139. CSS works the
same way for the comments that Bun's CSS parser keeps, the `/*!` comments at the start of a
stylesheet.

How it is built follows esbuild too. The printer is the one place that prints an `S::Comment`, and
the parser makes that statement for legal comments only, so `js_printer::Options::legal_comments`
decides there: print it, drop it, or keep the text and return it with the code
(`PrintResultSuccess::legal_comments`, in the order of the source and each text once). That way a
comment in a function that tree shaking removes goes with the function, and the source map is that
of the code that is really there. `post_process_js_chunk` collects what the part ranges of a chunk
returned, in the order of the code, and `legalComments.rs` writes the end of the file or the
`.LEGAL.txt` file. For CSS the linker reads `StyleSheet::license_comments` and tells the CSS printer
not to print them. The file is written where the source map of a chunk is written, on both paths
(to disk and in memory), and is counted in `OutputFileList` like it. `print_ast`, which prints a
whole file for `bun build --no-bundle` and for the runtime, appends what it took out, so
`--no-bundle` has `none`, `inline` and `eof`. The `[hash]` in the name of a chunk covers the
`.LEGAL.txt` file and the mode, because the file is named after the chunk and the comment of
`linked` is added after the content is hashed. A build that does not use the option allocates
nothing for it: it pays one `match` for each legal comment it prints, and a check for "no comments"
per printed file and per chunk.

One part is not behind the option, and it is the one change to the output of a build that does not
set it. A legal comment of several lines kept the indentation it had in the source and got the
indentation of the output on top, so a comment inside a function came out as

```js
function f() {
  /*!
   * twice as deep as it was
   */
}
```

and moved to the end of the file it would have kept four spaces of a function that is no longer
around it. The parser now takes the source indentation off the lines after the first
(`comment_text_without_indent`, esbuild's `CommentTextWithoutIndent`: the column of the `/*` in
code points, or less when a line starts before it), and allocates only for a comment that has
something to take off. In the 16 MB that `test/bundler/bytecode-portability/libraries.js` bundles,
real packages with more than 70 legal comments, this changes no byte. The version of the runtime
transpiler cache is not raised: an entry that an older build wrote differs in the spaces inside a
comment.

Differences from esbuild, all on purpose. The default is `inline` where esbuild bundles with
`eof`: a change of default is a separate decision. `</script` and `</style` in a comment are not
escaped, because Bun escapes them where it writes a chunk into an HTML file and nowhere else, not
in a string either. A `*/` in the `//!` comment of a package, in the path of a package or in the
public path is written as `* /` where it would end the comment that Bun puts around it. esbuild
prints it as it is and the output is a syntax error. A file whose parts are printed in several
ranges is listed once. `linked` and `external` are an error with `compile` (there is no file next
to a chunk that lives in an executable or in an HTML file), with `--no-bundle` and with `--app`,
and the CLI wants `--outdir` for them, as it does for an external source map.

A review pass (three readers: the printer, the parser and the list, then the output files, CSS and
the checks of the options, then docs, types and tests; every finding was checked by a second
reader) found what follows, and all of it is fixed in this commit. The comment of `linked` was
escaped in two halves, so a public path that ends with `*` in front of a name that starts with `/`
ended the comment early. Two files with the same path in their packages, such as two versions of
one package under different parents, were one entry with the comments of both: the entries are by
file now, as in esbuild. `bun build --app` ignored the flag in silence. The `.LEGAL.txt` output had
the hash `00000000`. `--no-bundle` kept the `\r` of a CSS comment that the bundler takes out. The
help text lost a word in angle brackets to the formatter of the help. The docs named React in their
example, whose license Bun does not keep, and did not say which comments are not legal comments.
The three tests of closing tags ran under esbuild's names with the opposite of esbuild's
expectation: they are `todo` with esbuild's expectation again, and the behaviour of Bun has its own
tests. Two assertions could not tell the feature from its absence. Comments of several lines in
`src/` are one line each now.

Not done. `@license` and `@preserve` do not make a legal comment in Bun yet, which is how React and
lodash mark theirs. That is an open upstream PR (oven-sh/bun#41013) and is left to it, so that this
commit and that PR do not touch the same lines: the option handles whatever the parser calls a legal
comment. The same PR keeps a legal comment that is written in front of an `import()` in the same
statement, which the parser drops today in every mode. Of the 13 ported tests 7 run. The other 6
stay `todo` with the expectations of current esbuild, and a comment above them names the three
reasons: `@license` and `@preserve`, CSS comments that are not at the start of a stylesheet, and
the closing tags. The metafile does not list the `.LEGAL.txt` files (it does not list source maps
either). `Bun.Transpiler` has no such option. U+2028, U+2029 and a `\r` without `\n` do not count
as the end of a line when the indentation is taken off.

One older bug turned up and was reported, not fixed here: `bun build src/in.js
--outfile=dist/out.js` writes into `src/` as soon as the build has a second output file, a linked
source map for example. It is the reason why the CLI wants `--outdir` for a `.LEGAL.txt` file.

Rebase notes: 42 patches onto oven-sh/bun 9f70da0741, no conflicts, nothing dropped. The fork's
three workflows were green after the last push, which was on 2026-09-27. One older soup mismatch
is still open: `test/bundler/bundler_bytecode_portable.test.ts` pins the hashes of whole bundles,
and three of them (`all.js`, `libraries.js`, `happy-dom`) contain the `__toESM` helper, in which
the `bytes` loader patch of 2026-09-10 adds a condition. That line is the only difference between
what the released bun and this build print for `libraries.js`, so the snapshot belongs to that
patch and not to this one. It is not updated yet: the test needs a quarter of an hour on a debug
build.

Files: `src/options_types/bundle_enums.rs` (`LegalComments`), `src/options_types/{lib,context}.rs`,
`src/js_printer/lib.rs` (`Options::legal_comments`, `PrintResultSuccess::legal_comments`,
`print_ast`), `src/js_parser/parse/mod.rs` (`comment_text_without_indent`),
`src/bundler/linker_context/legalComments.rs` (new),
`src/bundler/linker_context/{postProcessJSChunk,postProcessCSSChunk,generateCompileResultForCssChunk,generateChunksInParallel,writeOutputFilesToDisk,OutputFileListBuilder,generateCodeForFileInChunkJS}.rs`,
`src/bundler/{Chunk,LinkerContext,bundle_v2,options,transpiler,lib}.rs`,
`src/css/{printer,css_parser}.rs` (`PrinterOptions::license_comments`),
`src/runtime/cli/{Arguments,build_command}.rs`,
`src/runtime/api/{JSBundler,js_bundle_completion_task}.rs`, `packages/bun-types/bun.d.ts`,
`docs/bundler/{index,esbuild,minifier}.mdx`, `docs/snippets/cli/build.mdx`,
`completions/bun-cli.json`, `test/bundler/bundler_comments.test.ts`, `test/bundler/cli.test.ts`,
`test/bundler/bun-build-api.test.ts`, `test/bundler/esbuild/default.test.ts`,
`test/bundler/expectBundled.ts`, `test/integration/bun-types/fixture/build.ts`.

### 2026-10-01: Web Storage: `sessionStorage`, `localStorage` and `Storage`

Node.js has had the Web Storage API without a flag since version 25, Deno has it, and every
browser does. Bun's compatibility page said "🔴 Not implemented. Bun has no `Storage`,
`localStorage` or `sessionStorage` globals", oven-sh/bun#19115 asks for it and lists the ponyfills
people use meanwhile, and `bun --localstorage-file=x app.js` took Node's flag without a word and
then threw `ReferenceError: localStorage is not defined`. Now:

```ts
// always there, kept in memory, one per Worker
sessionStorage.setItem("theme", "dark");
sessionStorage.theme; // "dark"
Object.keys(sessionStorage); // ["theme"]
sessionStorage instanceof Storage; // true
```

```ts counter.ts
// there when --localstorage-file names the file to keep it in
const runs = Number(localStorage.getItem("runs") ?? 0) + 1;
localStorage.setItem("runs", String(runs));
console.log(`run ${runs}`);
```

```sh
$ bun --localstorage-file=./local-storage.db counter.ts
run 1
$ bun --localstorage-file=./local-storage.db counter.ts
run 2
$ node --localstorage-file=./local-storage.db counter.ts   # the same file
run 3
$ bun test --localstorage-file=:memory:                    # a localStorage that is not written anywhere
```

`Storage` is the interface of the HTML specification: `length`, `key()`, `getItem()`,
`setItem()`, `removeItem()`, `clear()`, and every item as a property, so `storage.theme`,
`storage.theme = "dark"`, `delete storage.theme`, `"theme" in storage`, `Object.keys()`,
`JSON.stringify()` and a spread all do what they do in a browser. Keys and values are strings and
are kept code unit for code unit: the empty string, a NUL and a lone surrogate come back as they
went in. A storage holds 10 MB of keys and values, two bytes a code unit, and the write that would
go past that throws a `DOMException` named `QuotaExceededError` (code 22) and changes nothing.
`new Storage()` throws, and so do `Object.freeze()`, `seal()` and `preventExtensions()` of a
storage.

The file is an SQLite database with the schema of Node.js, statement for statement: the two tables,
the three triggers that keep the quota, keys and values as blobs of UTF-16 code units, WAL. So
`--localstorage-file` means the same file to both runtimes. That was checked with Node.js 26.3.0 in
both directions, with an empty key and a lone surrogate among the items, and a test does it again
wherever a `node` of version 25 or later is installed. Several processes can have the file open
(SQLite's locking, a busy timeout of three seconds), and a process sees what another one wrote the
next time it looks: no lookup on a storage is ever answered from a cache, neither Bun's own nor the
inline caches of the JIT. A `Worker` opens the same file and has a `sessionStorage` of its own. The
file is made the first time `localStorage` is used, not when the process starts. A process that
exits closes the databases of its main thread, which leaves one file with no `-wal` and `-shm`
beside it. A `Worker` that is still running at that moment keeps its connection, and then the two
files stay until the next open takes them in, as after a kill. A file that cannot be opened, or
that has tables of these names with something else in them, is an `ERR_INVALID_STATE` error of the
operation that needed it, with Node's messages for a malformed file.

Where it differs from Node.js, on purpose:

- Without `--localstorage-file`, `localStorage` is not a property of the global object at all,
  which is what it was in Bun until today: `typeof localStorage` is `"undefined"`,
  `"localStorage" in globalThis` is `false`. Node 26 defines a getter that returns `undefined` and
  prints an `ExperimentalWarning` the first time anything reads it. Every program that only asks
  `typeof localStorage !== "undefined"` to find out where it runs would start to print that warning
  under Bun, and `"localStorage" in globalThis` would start to say yes to something that is not
  there.
- A relative path is resolved against the directory the process started in. Node resolves it when
  `localStorage` is first used, so a `process.chdir()` before that moves Node's file and not Bun's.
- The two globals are plain properties and can be assigned, `globalThis.localStorage = mock`,
  which is what test setups do. In Node they are accessors.
- It follows WebIDL where Node's interceptors do not. A symbol is an ordinary property with its
  attributes (the one subtest of the Web Platform Tests that Node lists as failing,
  `symbol-props.window.js` "defineProperty not configurable", passes). An item whose name a
  property of the prototype chain has, `"length"` or `"getItem"`, is not a property of the storage:
  it is not listed by `Object.getOwnPropertyNames()`, and `delete storage.getItem` leaves it, where
  Node lists it and removes it. `getItem()` and `removeItem()` reach it either way.
- `PRAGMA optimize` is not run when the file is opened. Node runs it, and the `ANALYZE` it can
  start does not wait for a connection that is writing, so the first use of a file while another
  process wrote to it failed at once with "database is locked", in Node 26.3 too. The switch of a
  new file to WAL has the same impatience, and that one is retried for the three seconds.

The class is native (`JSStorage`, a JavaScriptCore object with the hooks of a "legacy platform
object": get, set, define, delete and list own properties, and prevent extensions). The hooks start
from what WebKit's bindings generator writes for an interface with a named getter, setter and
deleter, with three changes. The generated setter leaves a name alone that the prototype chain has,
the specification and the Web Platform Tests give every string to the setter, and this does what
the specification says. The generated list of own properties has every item, this one leaves out
the hidden ones. And the visibility check looks at the prototype chain before it looks for the
item, because the first is a hash lookup and the second is a query, so `localStorage.getItem(...)`
never asks the database whether there is an item called "getItem". The storage itself is Node's
`node_webstorage.cc` on the SQLite that `bun:sqlite` and `node:sqlite` already use, the one library
of the process (the system's, loaded on demand, on macOS), with the statements prepared once per
storage and reset after every use: a statement that is left stepped keeps its read transaction, and
with it a snapshot in which the writes of other processes do not show. The database operations
return errors and never throw, so that a lookup the engine makes for itself (a `VMInquiry`) can
drop an error where a script's lookup throws it.

What it costs a program that does not use it: two entries in the static table of the global object,
which is generated at build time. Nothing is allocated at startup, SQLite is not opened (or, on
macOS, loaded) until the first operation on a storage, and `localStorage` is one more property of
the global object only in a process that was started with the flag.

Tests. `test/js/third_party/wpt-webstorage` runs the 21 Web Platform Tests files for the interface
that need no document (1238 subtests), in a child process that has the flag. Two subtests are
listed as expected failures: they ask for the new `QuotaExceededError` interface with `quota` and
`requested`, which Bun does not have. The fixture has its own `test()`, the synchronous one of
`testharness.js`, and takes the assertions from the shim that upstream's `wpt-streams` uses, which
got the one assertion those two subtests call. `test/js/web/storage/storage.test.ts` has what the
suite does not: the globals, the flag, the file and its schema read back with `bun:sqlite`, two
live processes, six processes that use a new file at the same moment, a Worker, the quota, files
that are malformed (the cases of Node's `test-webstorage.js`, and its check that a failed open does
not leak the connection), `bun test` with the flag, with and without `--parallel`, and a loop that
runs a lookup through the optimizing tiers of the JIT and then changes the item. Both files pass on
the debug build with address sanitizer, and with JavaScriptCore's exception check validation on.
The machine this was built on was very busy with other work (a load average in the hundreds on
sixteen cores), and there the tests of `storage.test.ts` that start processes needed
`--max-concurrency=3` to stay under the default timeout of five seconds. Earlier in the day, on the
same machine with less on it, the file passed as it is in six seconds.

A review pass (three readers: the C++, the behaviour against the specification and Node, then docs,
types and tests) found what follows, and all of it is fixed in this commit, the behaviours with
tests. A write that went over the quota from a script of a `node:vm` context made the exception
with the wrong kind of global object and wrote past the end of it. The visibility check asked the
prototype chain in a mode in which JavaScript must not run, and a lazy property of `Bun` or
`process` is made by JavaScript: `Object.setPrototypeOf(sessionStorage, Bun)` and one lookup
aborted the process. `Object.freeze(localStorage)` did not throw and turned every item into the
string `"undefined"`, on disk, because a descriptor that has no value was given to the setter.
The triggers call `OCTET_LENGTH()`, which SQLite has had since 3.43, and macOS 13 has 3.39, where
every write would have failed: a library that does not have the function is now given one, which
was tried against SQLite 3.38.5. An array with a storage in its prototype chain read its holes from
it with `array[1]` and not with `join()` or `slice()`. `bun test --parallel` did not pass the flag
to its workers. `--localstorage-file=` without a value was ignored where Node exits with an error.
The first use of a file failed when another process was writing to it (the `PRAGMA optimize`
above). The first version of the Web Platform Tests fixture ran the bodies of the tests after their
file had been evaluated, so the 1076 subtests that `storage_setitem.window.js` registers in a loop
over a `var` all tested the last string of the loop. And the docs said that both storages are
shared by everything in the process, which is not true of a `sessionStorage` and a Worker.

Not done. `--no-webstorage`, Node's switch to turn it off. The `QuotaExceededError` class.
`StorageEvent`, which is for other documents. A `bunfig.toml` key for the file. The flag is for the
whole process: the `execArgv` of a `Worker` cannot give it another file, as it can in Node. Under
`bun test --isolate` the connection of a finished test file stays open until its global object is
collected. Node's own `test/parallel/test-webstorage.js` is not in the tree because it pins things
that Bun does differently or does not have. Built and run on Linux x64 only: the macOS path (the
`lazy_sqlite3.h` include that `NodeSqlite.cpp` uses, and the function for old libraries) and
Windows were not compiled here, and on Windows the path is given to SQLite as it is, without the
`\\?\` prefix that Node adds for paths longer than 260 characters.

Two things are older than this commit and were reported, not fixed here. `toMatchSnapshot()` and
the diff of `toEqual()` list the properties of an object without asking the object, so they print a
storage as `Storage {}`. And a method that `spyOn()` replaced on an object that only inherited it
stays on the object as an own property after `mockRestore()`, which on a storage shows up in
`Object.keys()`: spy on `Storage.prototype`.

A design check was started before the code (where should it live, a native class or a TypeScript
builtin with a `Proxy` as in Deno) and was stopped after five hours without a verdict, so the
choice of the native class is this commit's own: it is where upstream has been moving (the streams
rewrite, `node:sqlite`), and `JSSharedEnvMap` is the precedent for such an object in the tree.

Rebase notes: 43 patches onto oven-sh/bun 4b02e1031d, which was upstream's main when the day's run
started, two textual conflicts, nothing dropped. Upstream appended tests to
`test/cli/hot/hot.test.ts` where the `.env` patch of 2026-08-23 appends its own, and
oven-sh/bun#43571 ("honor If-Range") added a field to `RequestContext` in the three places where
the compression patch of 2026-09-04 adds `encoding`. Both sides were kept, and the `--hot` `.env`
test, the compression tests and upstream's If-Range tests pass on the rebased build. The fork's
three workflows were green after the last push, which was on 2026-09-29.

Files: `src/jsc/bindings/sqlite/JSStorage.cpp`, `src/jsc/bindings/sqlite/JSStorage.h` (new),
`src/jsc/bindings/ZigGlobalObject.{cpp,h,lut.txt}`,
`src/jsc/bindings/webcore/{DOMIsoSubspaces,DOMClientIsoSubspaces}.h`,
`src/runtime/cli/{Arguments,mod}.rs` (`--localstorage-file`), `src/runtime/node/node_process.rs`,
`src/runtime/cli/test/parallel/runner.rs`, `src/jsc/VirtualMachine.rs` (the exit hook),
`scripts/build/unified.ts`, `docs/runtime/web-apis.mdx`, `docs/runtime/nodejs-compat.mdx`,
`docs/snippets/cli/run.mdx`, `test/js/web/storage/storage.test.ts` (new),
`test/js/third_party/wpt-webstorage/` (new), `test/js/third_party/wpt-testharness-shim.ts`,
`test/integration/bun-types/fixture/globals.ts`.

### 2026-10-02: npm trusted publishing (OIDC) for `bun publish`

With npm's [trusted publishing](https://docs.npmjs.com/trusted-publishers) a CI job publishes
without a stored token. The job shows the registry an OIDC id token, the registry knows which
workflow of which repository may publish the package, and it answers with a publish token that
lives for minutes. Long-lived npm tokens have been going away since 2025, so this is how a release
workflow is meant to authenticate now. `bun publish` did not do it: on a job with
`id-token: write` and no token it sent nothing and stopped with `error: missing authentication`
(oven-sh/bun#22423), and the workflow needed `npm publish` for that one step. Now:

```yaml
permissions:
  contents: read
  id-token: write
steps:
  - uses: actions/checkout@v4
  - uses: oven-sh/setup-bun@v2
  - run: bun install --frozen-lockfile
  - run: bun publish
```

```sh
bun publish
# Tag: latest
# Access: default
# Registry: https://registry.npmjs.org/
# Auth: trusted publishing (OIDC)
#
#  + my-package@1.0.0
```

The steps are those of the npm CLI (`lib/utils/oidc.js` and `lib/commands/publish.js`, read on its
`latest` branch while this was written):

1. The id token is `NPM_ID_TOKEN` when that is set, which is how GitLab CI (`id_tokens:`) and
   CircleCI hand it over. Otherwise, on GitHub Actions, it is requested: a GET of
   `$ACTIONS_ID_TOKEN_REQUEST_URL` with `audience=npm:<hostname of the registry>` added and
   `$ACTIONS_ID_TOKEN_REQUEST_TOKEN` as the bearer. A job has those two variables only with the
   `id-token: write` permission.
2. The exchange is `POST /-/npm/v1/oidc/token/exchange/package/<name>` at the host of the registry
   that the package goes to (the registry of its scope for a scoped package), with the id token as
   the bearer and the name escaped as in the publish URL (`@scope%2fname`). Like npm, it asks at
   the root of the host even when the registry URL has a path.
3. The token in the answer is used for the upload, for the version lookup of
   `--tolerate-republish` before it, and for an OTP retry.

The exchange comes before configured credentials and replaces them when it succeeds, which is npm's
order. The reason is the placeholder: `actions/setup-node` writes `_authToken=${NODE_AUTH_TOKEN}`
and sets the variable to `XXXXX-XXXXX-XXXXX-XXXXX` when there is no secret, so "a token is
configured" says little in CI. When the registry refuses the exchange, the configured credentials
are used and nothing is printed. When there are none, or the registry then rejects them, the error
carries the registry's reason. npm shows that only with `--verbose`, and it is the first thing one
needs when a trusted publisher is set up wrong:

```
error: missing authentication (run `bunx npm login`)
note: trusted publishing (OIDC) failed: registry.npmjs.org answered the token exchange for "my-package" with HTTP 404: OIDC token exchange error - package not found
```

`--dry-run` does the exchange and stops before the upload, as in npm, so a dry run in the release
workflow tells whether the trusted publisher is right. `bun publish <tarball>` takes the same path.

Where it differs from npm:

- npm runs this only when `ci-info` says GitHub Actions, GitLab or CircleCI. Here `NPM_ID_TOKEN`
  is enough wherever it is set, so a CI that npm's registry starts to accept needs no new release
  of Bun. The request for a token is made on GitHub Actions only, as in npm.
- npm prints nothing about a failed exchange below `--verbose`. Bun prints the one `note:` above
  when the publish fails, and with `--verbose` also when it goes on with the configured token.
- The `Auth:` line of the summary is new.
- npm turns provenance on after a successful exchange from a public repository. Bun has no
  `--provenance` (oven-sh/bun#30522 is open upstream for it), so a package that is published this
  way has no attestation. The docs say so.

What a publish that does not use it pays: two environment lookups, no allocation and no request.
Requests are made only when an id token is on offer: one (the exchange) with `NPM_ID_TOKEN`, two
on a GitHub Actions job with `id-token: write`. A job that has the permission for another reason
and publishes with an ordinary token makes those two requests, gets a 404 from the exchange and
goes on with its token, which is what it does with npm.

The code is `src/runtime/cli/trusted_publishing.rs` (the two requests, and the sentence for each
way they can fail) and about forty lines in `publish()`. The registry scope of the package is
cloned with the exchanged token in it, so the upload, the lookup and the OTP flow read the token
where they read a configured one, and nothing below `publish()` changed. The flow and the test plan
follow oven-sh/bun#29374 by David Gilman, which did this for the Zig tree and was closed as stale
when the tree became Rust. That PR tried the exchange only when no credentials were configured.
This one tries it first, for the placeholder reason above.

Tests are in `test/cli/install/bun-publish.test.ts`, next to the other tests that use a mock
registry. One `Bun.serve` is GitHub's token endpoint and the registry, it records every request,
and each test asserts the whole list: method, path and credential. They cover GitHub Actions end
to end, `NPM_ID_TOKEN` with and without GitHub Actions around it, a scoped package with a scope
registry, a registry URL with a path, a configured placeholder token, the three ways to fail with
their exact stderr, a job without the permission (no request at all), `--dry-run`, a tarball and
`--tolerate-republish`. With the released binary 13 of the 14 fail. The one that passes is the job
without the permission, which must behave as before.

Not done, and not checked. Provenance, as said above. It was not run against registry.npmjs.org,
which needs a real package and a real CI identity: the requests are the ones the npm CLI makes,
and the registry's answers are mocked. The two requests do not go through a proxy, like the upload
itself. Built and tested on Linux x64 only. A design check was started twice before the code was
written and both runs were cut off when the machine restarted, so the choices above are this
commit's own, made against npm's source. No separate review pass read the diff either, for the
same reason: the machine this was built on lost the work twice and spent hours unable to write to
its disk, and the commit landed about twenty hours after the day's run began.

Rebase notes: 44 patches onto oven-sh/bun 519963edc8, two textual conflicts, nothing dropped.
oven-sh/bun#41985 appended a unit test at the end of `src/bun_core/string/immutable.rs`, where the
"did you mean" patch of 2026-08-28 appends its own, and both were kept. oven-sh/bun#44352 shortened
the error conversion on the line of `src/jsc/VirtualMachine.rs` where the `bun serve` patch of
2026-09-19 renames the call it makes, and the renamed call got upstream's `?`. The rebased stack
builds, and the fork's three workflows were green after the last push.

Files: `src/runtime/cli/trusted_publishing.rs` (new), `src/runtime/cli/publish_command.rs`,
`src/runtime/cli/mod.rs`, `src/bun_core/env_var.rs`, `docs/pm/cli/publish.mdx`,
`test/cli/install/bun-publish.test.ts`.

### 2026-10-06: `Bun.Queue`, a message queue on SQLite

"Run this job now or in ten minutes, run it again with a delay when it fails, and do not lose it
when the process restarts" takes a queue library and a Redis or a Postgres today. oven-sh/bun#10931
asks for the queue to be built in ("a simple task queue like Deno queues, which might work on top
of sqlite"). With 96 upvotes it was the most wanted open request that nobody had a pull request
for: the one attempt, oven-sh/bun#22678 for the Zig tree, kept its jobs in memory, had no retries
and was closed unfinished. Now:

```ts
const emails = new Bun.Queue<{ to: string }>("emails", {
  path: "./queue.sqlite",
});

emails.consume(
  async batch => {
    for (const message of batch.messages) {
      await sendWelcomeEmail(message.body.to);
      message.ack();
    }
  },
  {
    maxRetries: 5,
    retryDelay: attempts => 2 ** attempts,
    deadLetterQueue: "emails-failed",
  },
);

await emails.send({ to: "ada@example.com" });
await emails.send({ to: "grace@example.com" }, { delaySeconds: 600 });
```

The API is that of Cloudflare Queues, which is where upstream's newer APIs come from (`Bun.cron`,
and the `Bun.DurableObject` of oven-sh/bun#42984): `send(body, { delaySeconds, contentType })`,
`sendBatch()`, `metrics()`, and a handler that gets a `MessageBatch` whose messages have `id`,
`timestamp`, `body`, `attempts`, `ack()` and `retry({ delaySeconds })`, with `ackAll()` and
`retryAll()` on the batch. A handler that returns acknowledges what it did not retry, and one that
throws retries what it did not acknowledge. The consumer settings of a `wrangler.toml` are the
options of `consume()`: `maxBatchSize`, `maxBatchTimeout`, `maxRetries`, `retryDelay`,
`maxConcurrency`, `deadLetterQueue`. The four content types are Cloudflare's too, JSON by default,
`"v8"` for what only the structured clone algorithm can copy. The names and the rules were taken
from Cloudflare's documentation and from workerd's `queue.c++` as they were on the day.

Without a `path` the queue is in memory, shared by name inside the thread, and gone with the
process. With one it is a SQLite file that any number of processes send to and consume from. A
consumer keeps the process alive until `stop()`, which waits for the batches in flight, or
`unref()`. `bun --hot` stops the consumers of the modules it is about to evaluate again, as it
stops the jobs of `Bun.cron`: without that, the consumer of the previous version of the code kept
taking the messages. Inside a `Bun.ModuleGraph` a queue is the graph's, as upstream's rule for
everything a graph opens says: a graph has a connection of its own to a file, its queues in memory
are not the host's, the timers and the handler of its consumers run in its context, and a consumer
whose graph was disposed ends without a word.

How it works. A message is one row of one table, `bun_queue(seq, queue, id, content_type, sent_at,
visible_at, attempts, lease, bytes, body)`, and the row is deleted when the message is
acknowledged. `visible_at` is when it may next be delivered: the end of its delay, of its retry
delay, or of the lease of the consumer that has it. A consumer takes the messages with
`visible_at <= now` in one `UPDATE ... RETURNING`, which sets a lease of `visibilityTimeout`
seconds (30), counts the attempt and writes a random token, and every later write carries
`AND lease = <token>`. So two consumers never get the same row, a message whose process was killed
is simply there again when the lease has run out, and a consumer that lost its lease cannot
acknowledge a message that somebody else has by then. A consumer that is alive extends its leases
every third of the timeout, however long the handler takes. A message that was delivered
`maxRetries + 1` times goes to the dead-letter queue (the row changes its queue and keeps its id
and its timestamp) or is deleted, also when every one of those deliveries ended with the death of
a process. `ack()` and `retry()` are written before they return, so a process that dies in the
middle of a batch has kept what it acknowledged. SQLite cannot tell another process that a row
arrived, so a consumer of a file reads the index every 100 milliseconds. In one thread, `send()`
wakes the consumers of the queue. A write that SQLite refuses, because another program held the
file for longer than the busy timeout of five seconds, is kept and written again later, with a
growing pause between the tries, and reported once.

The file is in WAL mode with `synchronous = NORMAL`: what `send()` resolved for survives the death
of the process, and after a power failure the file is intact and can miss the last moments. The
docs say that.

Where it differs from Cloudflare, all of it listed in the docs. `maxBatchTimeout` is 0, not 5
seconds, since five seconds before a lone job runs is not what one expects of a local queue, and
`maxConcurrency` is 1. `ack()` and `retry()` take effect when they are called, where workerd
collects them until the handler has returned. `send()` resolves to nothing, not to the metrics.
The size of a message, of a batch and of a delay have no limit of their own, and durations can be
fractions of a second. `retryDelay` can be a function of the attempts, `visibilityTimeout` and
`onError` are new for a handler, and a handler error without `onError` is printed with
`console.error()` and does not end the process.

It is a TypeScript builtin on `bun:sqlite` (`src/js/internal/queue.ts`, 1,100 lines), loaded the
first time `Bun.Queue` is read, the way `Bun.SQL` and this fork's `Bun.JWT` are. Two pieces are
C++: the lazy property, and six lines in `GlobalObject::reload()` that call the module's
`stopConsumers` if the module was ever loaded.

What it costs. A program that does not use it: one more entry in the static table of the `Bun`
object, the module in the binary (about 30 KB of source before minification in the debug build),
and on a `--hot` reload one read of an internal field. A program that does, measured with the
module's own source run as a user module on the released bun 1.4.3 on this machine (twelve
cores, a virtual disk): `send()` to a file is as fast as a single-row `INSERT` was at the time,
25,000 to 47,000 a second over the day with the bare `INSERT` at 30,000 to 50,000, and about
200,000 a second in memory. `sendBatch()` of 100 wrote 150,000 to 370,000 messages a second to a
file. A consumer with a handler that does nothing took 30,000 to 47,000 messages a second from a
file in batches of 10 and 60,000 to 100,000 in batches of 100. `ack()` for each message in a loop
makes each one a write of its own, about 15,000 a second from a file. `ackAll()` and the end of
the handler are one write for the batch. A consumer of a file that has nothing to do wakes ten
times a second, which was 5 to 7 milliseconds of processor time per second, most of it the waking
itself. These are numbers of the JavaScript and the SQL, not of a release build of this commit,
which was not made.

Tests are `test/js/bun/queue/queue.test.ts`, 50 of them, all of which fail on the released
binary: order and batches, the content types, delays, retries and their delays, dead letters, who
wins between `ack()`, `retry()`, `ackAll()` and `retryAll()`, `maxConcurrency`,
`maxBatchTimeout`, `stop()` and `close()` from outside and from inside a handler, validation, a
file read back with `bun:sqlite`, rows that another program wrote, a lease that is extended, six
processes that open one new file at the same moment (450 messages, none lost, none twice), a
consumer process that is killed twice with SIGKILL and the message that then becomes a dead
letter, a `Worker`, a `Bun.ModuleGraph` that is disposed, `bun --hot`, a database that refuses a
write (a trigger stands in for it), and what keeps the process alive. Eleven of them are for
what the reviews below found. Ten of those, and the `--hot` test, were run against the code with
the fix taken out, and failed. The eleventh, that `ack()` is written before it returns, is for a
fault that two readers measured. The types have a fixture,
`test/integration/bun-types/fixture/queue.ts`.

A design check was started before the code (where it should live: a TypeScript builtin, a native
class on sqlite3 as in oven-sh/bun#42984, a layer on `Bun.redis`, or only a recipe in the docs, and
which of Cloudflare's, Deno's and BullMQ's shapes). It was stopped after two hours and twenty
minutes with 32 of about 150 of its agents done and no verdict, so the choices are this commit's
own. The builtin was written as a user module first, and the multi-process and the crash
behaviour were tried with the released binary before anything went into the tree.

A review pass (four readers: the delivery logic, the SQL and several processes, the C++ and the
tests, the docs and the types; the first of them returned nothing) found what follows, and all of
it is fixed in this commit, the behaviours with tests. A handler without an `await` that called
`stop()` on its own consumer did not end the round of deliveries: the handler ran for every
message that was waiting, the consumer released its database twice, and the next `send()` on the
same file said "Database has closed". The same from `onError`. A consumer whose handler held up
the thread for longer than a lease took its own message a second time when a `send()` woke it
before its timer did. The lease of a claim was measured from before the wait for the write lock,
so with a lease shorter than that wait two processes could get one message. `ack()` was written
in the microtask after the call, where the docs said at once: it is written before it returns
now. `metrics()` read the body of every message to add up their sizes, 60 to 70 milliseconds for
a thousand messages of 256 KB by the reader's measurement: the table has the size in a column of
its own and the body as its last column now. A `maxBatchSize` of 2^63 or more passed the
validation and then failed in SQL for ever, in a loop without a pause: it has to be a safe
integer, and a consumer whose database does not answer waits between its tries, longer each time.
A transaction that SQLite had already rolled back (a full disk) reported the failed `ROLLBACK` and
not the error. `Bun.Queue` was missing from upstream's test that wants every property of `Bun`
classified for `Bun.ModuleGraph`, which asked the question that the per-graph stores above answer.
In the tests: a test that depended on 200 milliseconds not passing between two lines, two
timeouts that were shorter than the ones CI gives, queue names that a second run in the same
process got again, handlers that waited for ever when an assertion failed before them, and child
processes that nobody ended when a test timed out. In the docs: a `Map` sent as JSON is not
refused but arrives as `{}`, a batch is in the order of sending and not of becoming deliverable,
a handler that blocks for most of a lease is enough for a second delivery, and so is a second
consumer in the same process, and a queue in the application's own database needs a warning.

A second pass, two readers over the code as it was after those fixes, found more, fixed here as
well. The pause that lets the event loop run during a long backlog never happened: its ten
milliseconds were counted anew by every round of deliveries, and the next round starts from a
microtask, before any timer. 20,000 waiting messages and a handler without an `await` kept a
`setInterval` from ticking for two seconds. `close()` did not wait for a consumer that was already
stopping, and a second `close()` resolved before the first. A handler ran in the
`AsyncLocalStorage` context of whoever had sent the message, and so did every later delivery
from the timers armed there. A consumer that was stopping did not try a failed write again until
its last batch ended, by which time the lease of an acknowledged message could be over. In
memory, a batch that waited to fill did not notice the messages whose delay ended meanwhile.
`onError` could stop the consumer from a place where a timer was armed right after. The consumer
trusted `batch.messages` and `message.attempts`, which a handler can assign to. And four things
had no test that failed without them: the check of the lease in every write, the transaction of
`sendBatch()`, the whole path of a write that fails, and that pause. The readers ran the module
through 2,000 rounds with injected `SQLITE_BUSY` and a matrix of 192 re-entrant calls, and found
no lost wakeup, no store released twice and no handler called after `stop()` had resolved.

Not done, and not checked.

- A `send()` cannot be part of a transaction of the application, on any connection. On the
  application's own database file it is worse than that: called while the application's
  connection in the same thread has a write transaction open, it waits five seconds for a lock
  that cannot be released and fails. The docs say so. Taking a `bun:sqlite` `Database` instead of
  a path is the follow-up.
- A claim and a retry change the size of the row (`lease` is NULL or a number), and SQLite then
  writes the row again, body included. For a body beyond a page that is the whole body in the
  WAL for every delivery: 8.5 MB for a message of 8 MB by the reader's measurement. The docs say
  to send a reference instead.
- Other processes are only found by the poll every 100 milliseconds, and an idle consumer of a
  file pays for it. Watching the WAL file would do both better.
- The retry of `SQLITE_BUSY` around the switch of a new file to WAL is tested only by chance.
  Without it, one to three of ten processes that made the file together failed with the released
  binary, but the test with its six processes still passed once when the retry was taken out.
- No priorities, no way to list, remove or purge messages, no repeating jobs (`Bun.cron` can
  send), no Redis or Postgres behind it, no exactly-once.
- `"v8"` bodies are JavaScriptCore's serialization, whose format belongs to the version of Bun
  that wrote it.
- Built and run on Linux x64 only. macOS has the system's SQLite (3.39 on macOS 13), and the SQL
  uses nothing newer than `RETURNING` (3.35), but it was not run there, and neither on Windows.
- Under heavy load on this machine (36 busy loops on 12 cores) the two tests that start several
  processes ran into the default timeout of five seconds of a local `bun test`. CI passes its own,
  longer one.

One thing is older than this commit and was found on the way, not fixed here. Under `bun --hot`,
when the entry module throws, the timers that it had armed never fire, while a server that it had
started keeps answering. The released bun 1.4.3 does the same. The fixture of the `--hot` test
ran into it: its watchdog timer did not end a process whose module had failed, so the fixture
catches the error and exits by itself.

Rebase notes: 45 patches onto oven-sh/bun 13a98b0dbd, nothing dropped, one conflict.
oven-sh/bun#44473 took version 34 of the runtime transpiler cache for a change of its own, which
is the number the `import.meta.glob()` patch of 2026-09-12 had taken, so that patch bumps it to 35
now. The rebased stack builds and the `import.meta.glob()` tests pass. Three older patches were
amended in place: the ones that add `Bun.INI` (2026-08-19), `Bun.CSV` (2026-08-25) and `Bun.JWT`
(2026-09-14) now name their property in upstream's "every property of Bun is classified" test of
`test/js/bun/module-graph/module-graph-isolation.test.ts`. Upstream added that test with
`Bun.ModuleGraph` on 2026-09-17 (oven-sh/bun#42590), and it has failed on this stack since, which
nobody saw because the fork's three workflows do not run it. They were green after the last push,
which was on 2026-10-03.

Files: `src/js/internal/queue.ts` (new), `src/jsc/bindings/BunObject.cpp` (the property),
`src/jsc/bindings/ZigGlobalObject.cpp` (`GlobalObject::reload()`), `packages/bun-types/bun.d.ts`,
`docs/runtime/queue.mdx` (new), `docs/docs.json`, `docs/runtime/bun-apis.mdx`,
`test/js/bun/queue/queue.test.ts` (new), `test/js/bun/module-graph/module-graph-isolation.test.ts`,
`test/integration/bun-types/fixture/queue.ts` (new).

### 2026-10-07: `Bun.msgpack`, MessagePack built in

JSON is text. Bytes go through base64, a `Date` comes back as a string, an integer above 2^53
comes back wrong, and the message is larger than it has to be. [MessagePack](https://msgpack.org)
is what programs use where that matters (Redis values, WebSocket frames, msgpack-rpc, Fluentd,
Neovim), most languages read it, and in JavaScript it has meant a dependency: msgpackr or
@msgpack/msgpack. oven-sh/bun#12075 asks for a native one ("msgpackr is faster than JSON in Node,
but slower in Bun"). It has 19 upvotes, no reply from a maintainer and no pull request. Upstream
has the text formats (`Bun.TOML`, `Bun.YAML`, `Bun.JSON5`, `Bun.JSONL`, `Bun.XML`) and no binary
one. Now:

```ts
const bytes = Bun.msgpack.encode({
  id: 1,
  tags: ["a", "b"],
  at: new Date("2026-10-07T08:00:00Z"),
});
// Uint8Array(24). The same value is 57 bytes of JSON.

Bun.msgpack.decode(bytes);
// { id: 1, tags: ["a", "b"], at: 2026-10-07T08:00:00.000Z }

// A stream: the values that are complete, and where the first incomplete one starts.
const { values, read, error } = Bun.msgpack.decodeChunk(pending);
pending = pending.subarray(read);
```

`encode(value)` returns a `Uint8Array`. Where MessagePack has no type of its own it does what
`JSON.stringify()` does, so there is one set of rules to remember: a property that is `undefined`,
a function or a symbol is left out, those values are nil in an array, `toJSON()` is called, boxed
primitives are unwrapped, keys come in `Object.keys` order and a cycle throws a `TypeError`. What
JSON cannot hold is written in its MessagePack type: a typed array, a `DataView` and an
`ArrayBuffer` as bin, a `Date` as the timestamp extension (in the smallest of its three formats,
and nil when the date is invalid, as JSON's `null`), a `BigInt` as a 64-bit integer (a
`RangeError` beyond 64 bits), a `Map` as a map with keys of any type, a `Set` as an array, `NaN`
and the infinities as floats. Safe integers take the smallest integer format, every other number
is a float 64, and a lone surrogate in a string becomes U+FFFD as for `TextEncoder`.

`decode(bytes)` reads exactly one value from any typed array, `DataView` or `ArrayBuffer`. A map
is an object (number keys become strings, any other key type is an error), bin is a `Uint8Array`
that shares no memory with the input, a timestamp is a `Date`, a 64-bit integer is a number while
it is a safe integer and a `BigInt` beyond, bytes that are not UTF-8 become U+FFFD as for
`TextDecoder`. Input that is not MessagePack, that ends inside the value or that goes on after it
is a `SyntaxError` that says which.

`decodeChunk(bytes, start?, end?)` is `Bun.JSONL.parseChunk` for MessagePack, with the same
result, `{ values, read, done, error }`, and the same clamping of the offsets. A value that has
not arrived completely is not an error, so a socket handler keeps `bytes.subarray(read)` and calls
again. `Bun.msgpack.Extension` is a type from -128 to 127 with its bytes: `decode()` returns one
for every extension that is not the timestamp and `encode()` writes it back as it was, so what Bun
has no type for survives a round trip (the handles of the Neovim API, for one).

The decoder is for input that nobody vouches for. Every length is checked against the bytes that
are left before anything is allocated for it, so `dd ff ff ff ff` is a `SyntaxError` and not an
array of four billion elements. Nesting ends with a `RangeError` where the stack does. A key named
`__proto__` is an ordinary property, as for `JSON.parse`. The bits of a NaN in the input do not
reach a JSValue as they are.

Where it differs from the two libraries, checked against msgpackr 2.1.0 and @msgpack/msgpack 3.1.3:

- `undefined` is nil, and left out as a property. msgpackr writes an extension of its own for it
  (`d4 00 00`), @msgpack/msgpack keeps the key with nil.
- A `BigInt` is always 64 bits. @msgpack/msgpack throws without `useBigInt64`, and without it
  reads a 64-bit integer into a number that has lost digits. msgpackr does what Bun does.
- `Map`, `Set` and `ArrayBuffer` are written as what they hold, as msgpackr does.
  @msgpack/msgpack writes `{}` for all three.
- `toJSON()` is called, so a `URL` is its string. @msgpack/msgpack does not call it.
- A lone surrogate is U+FFFD. Both libraries write `ed a0 80`, which is not UTF-8.
- An unknown extension is an `Extension`. msgpackr throws, @msgpack/msgpack has `ExtData`.
- `__proto__` stays a key. msgpackr renames it to `__proto_`, @msgpack/msgpack throws.
- The byte `0xc1` is an error. msgpackr returns an object for it.
- bin is copied out of the input. Both libraries return a view of the input.

It is C++, `src/jsc/bindings/BunMessagePack.cpp`, next to `Bun.JSONL`. The encoder takes the
property names and offsets of an object from its structure, as `JSON.stringify` does, and falls
back to `get` when a getter changes the object under it. It finds `toJSON` through the cache that
JavaScriptCore keeps on the structure for `JSON.stringify`. An array whose storage is int32 or
double is written in one loop. The first kilobyte is written on the stack, and a larger result
becomes the `ArrayBuffer` of the `Uint8Array` without a copy. The decoder makes an object the way
`JSON.parse` does: when the structure already has a transition for the next key, the key is
compared with the name of that transition and the value is stored at its offset, with no lookup of
the name. Arrays are made once, at their final length, with int32 or double storage when their
elements allow it. Short strings that repeat inside one input are one string.

Numbers, from a release build of this commit without LTO (`--profile=release --lto=off`), on the
machine this was written on, a shared virtual machine where one measurement moves by tens of
percent: the smallest time of two runs of `bench/msgpack/msgpack.mjs` (mitata).

|                                        | `Bun.msgpack` | msgpackr | @msgpack/msgpack | JSON and TextEncoder/TextDecoder |
| -------------------------------------- | ------------- | -------- | ---------------- | -------------------------------- |
| encode one object, 159 bytes           | 0.83 µs       | 0.81 µs  | 7.1 µs           | 0.88 µs                          |
| decode it                              | 0.78 µs       | 1.8 µs   | 2.3 µs           | 0.45 µs                          |
| encode 1,000 objects, 157 KB           | 0.41 ms       | 1.23 ms  | 2.93 ms          | 0.50 ms                          |
| decode them                            | 0.81 ms       | 2.79 ms  | 3.82 ms          | 1.03 ms                          |
| encode 10,000 numbers                  | 68 µs         | 235 µs   | 463 µs           | 372 µs                           |
| decode them                            | 95 µs         | 88 µs    | 147 µs           | 330 µs                           |
| encode 1,000 ASCII strings of 64 bytes | 27 µs         | 42 µs    | 367 µs           | 40 µs                            |
| decode them                            | 43 µs         | 82 µs    | 1.53 ms          | 75 µs                            |
| encode 1,000 Latin-1 strings           | 33 µs         | 77 µs    | 155 µs           | 69 µs                            |
| decode them                            | 98 µs         | 176 µs   | 395 µs           | 58 µs                            |
| encode 1,000 strings with CJK          | 34 µs         | 62 µs    | 164 µs           | 37 µs                            |
| decode them                            | 104 µs        | 192 µs   | 441 µs           | 62 µs                            |
| encode 64 KB of binary                 | 22 µs         | 8 µs     | 19 µs            | 24 µs (base64)                   |
| decode it                              | 22 µs         | 1.3 µs   | 0.7 µs           | 31 µs (base64)                   |

So: objects and strings are 1.5 to 3.5 times as fast as with msgpackr in both directions, except
that one small object is encoded at the same speed. Arrays of numbers are encoded 3.5 times as fast
and decoded at the same speed. Large binary is slower: decoding copies the bytes where the
libraries hand out a view of the input, and msgpackr encodes into a buffer that it keeps between
calls. `JSON.parse` is still ahead on strings that are not ASCII, and on one small object.

What a program that does not use it pays: one entry in the static table of the `Bun` object, one
lazy class structure in the global object (16 bytes, and one more `initLater` when a global object
is made), and 41 KB of code in the 84.9 MB release binary (the sum of the sizes of the 50 symbols
in `Bun::MessagePack`, from `nm`).

Tests are `test/js/bun/msgpack/msgpack.test.ts`, 229 of them. All fail on the released binary,
which has no `Bun.msgpack`. They have the msgpack-test-suite of Yusuke Kawasaki (MIT, 85 values in
233 encodings: every encoding must decode to the value, and `encode()` must write one of them),
the exact bytes @msgpack/msgpack writes for a mixed value, input written by msgpackr, the
boundaries of every format, the `JSON.stringify` rules one by one, getters that change the object,
proxies, cycles, every prefix of a message (each is a `SyntaxError`), lengths that promise more
than there is, 100,000 levels of nesting in both directions, a stream cut at every size, random
structured values there and back, random bytes, and every error message. The debug build ran them
with `BUN_JSC_validateExceptionChecks=1`. One test, objects of 65,535 and 65,536 properties, is
skipped in debug builds, where making such an object takes seconds. It passes on the release
build. The types have a fixture, `test/integration/bun-types/fixture/msgpack.ts`, and the docs
page is `docs/runtime/msgpack.mdx`, whose examples were run.

Not done, and not checked.

- There are no options. No way to get a `Map` back from `decode()`, to get every 64-bit integer
  as a `BigInt`, to write float 32, or to give an extension type a class.
- `decodeChunk()` starts at the first byte of an incomplete value again on every call. A value of
  many megabytes that arrives in small chunks is read that many times. A decoder that keeps its
  place would fix it and needs an object with state.
- A typed array that is not a `Uint8Array` is written as its bytes and comes back as a
  `Uint8Array`. A timestamp loses what is finer than a millisecond.
- `decode()` has no way to return bin as a view of the input, which is what makes the libraries
  faster on large binary.
- The decoder of an array of numbers fills a temporary list before it makes the array. Reading
  straight into the array would need the length to be trusted, or a second pass.
- The numbers are from one noisy machine and a build without LTO. A release build as CI ships it
  (ThinLTO, PGO) was not made, and neither was a comparison on Node.js.
- Built and run on Linux x64 only. The code has no platform-specific part, and it assumes, as the
  rest of the bindings do, that typed arrays are little-endian.
- A design check (C++ beside `Bun.JSONL`, Rust beside `Bun.TOML`, a TypeScript builtin, or only
  a recipe in the docs) was started before the code. It had returned nothing after four and a
  half hours and 113 of its agents, so it was stopped and the choices are this commit's own. No
  separate review pass read the diff.

Rebase notes: 46 patches onto oven-sh/bun bbdc5a519e, nothing dropped. Upstream's `bun check`
(oven-sh/bun#44361) met five patches. Four are textual. It added `watcher_for_threads` where the
`.env` patch of 2026-08-23 adds its function to `src/jsc/VirtualMachine.rs`, and both were kept.
It added `check` to the chain of comparisons in `which()` that the "did you mean" patch of
2026-08-28 had turned into the `ROOT_COMMANDS` table: `check` is a row of the table now, with
upstream's rule that a package.json script named `check` wins as a guard, and `bun chek` gets "did
you mean "bun check"?". It put the type check of the entry point in front of `load_entry_point` in
`run_command.rs`, where the `--watch-path` patch of 2026-09-24 starts its watcher, which now
starts before the check. It declared a module on the line where the trusted publishing patch of
2026-10-02 declares its own. The fifth did not conflict and did not compile: the parser struct `P`
got a third const generic, `SEMA`, and the `impl` block of the `import.meta.glob()` patch of
2026-09-12 had two. That patch was amended. The rebased stack builds, and the tests of the patches
that were touched by hand pass (`run_command.test.ts`, `watch.test.ts`, the two `import.meta.glob`
files). The fork's three workflows were green after the last push.

Files: `src/jsc/bindings/BunMessagePack.cpp` (new), `src/jsc/bindings/BunMessagePack.h` (new),
`src/jsc/bindings/BunObject.cpp` (the property), `src/jsc/bindings/ZigGlobalObject.h` and
`src/jsc/bindings/ZigGlobalObject.cpp` (the class structure of `Extension`),
`packages/bun-types/bun.d.ts`, `docs/runtime/msgpack.mdx` (new), `docs/docs.json`,
`docs/runtime/bun-apis.mdx`, `bench/msgpack/` (new), `test/js/bun/msgpack/msgpack.test.ts` (new),
`test/js/bun/msgpack/msgpack-test-suite.json` (new),
`test/js/bun/module-graph/module-graph-isolation.test.ts`,
`test/integration/bun-types/fixture/msgpack.ts` (new).

### 2026-10-09: `Bun.build({ watch: true })`, watch mode for the bundler API

`bun build --watch` builds again when a file changes. `Bun.build()` had nothing like it, so a build
that needs the JavaScript API (for plugins, most of all) could not watch. oven-sh/bun#5866 asks for
it: open since September 2023, and with 136 upvotes the open feature request for the bundler that
has the most. A search of the repository finds no pull request for it. The workarounds in its thread
watch a source directory with `fs.watch` and call `Bun.build()` for every event. They know nothing
of what the bundle imports, so a change outside that directory is missed and a change to a file that
is in no bundle builds again. Now:

```ts
const watcher = Bun.build({
  entrypoints: ["./src/index.tsx"],
  outdir: "./dist",
  plugins: [myPlugin],
  watch: true,
});

for await (const result of watcher) {
  if (result.success) console.log(`Built ${result.outputs.length} files`);
  else for (const message of result.logs) console.error(message);
}
```

With `watch: true`, `Bun.build()` returns a `BuildWatcher` in place of a promise. It is an async
iterator of `BuildOutput`: the first build, then a build for every change. That is the shape the
maintainer of the bundler preferred in the thread ("i like the async iterator proposal the most"),
over a callback and over the context object of esbuild that later comments ask for. Leaving the loop
stops the watcher. `watcher.stop()` does the same from outside, and so does `await using` at the end
of a block. The process stays alive until then.

What it does, point by point:

- What is watched is every file on disk that the last build read: entry points, imports, assets,
  files that the `onLoad` of a plugin handles. Files in `node_modules` are left out, as in the dev
  server. The list is taken again from every build, so a file is watched from the build that first
  imports it and no longer than the bundle imports it. A watcher whose build read no such file has
  nothing to wait for, and ends after that build.
- A rebuild is a complete `Bun.build()` of the same options, which is what `bun build --watch` is
  too (it restarts the process). The options are read once, when the watcher is made, its own and
  the ones it inherits, and arrays and plain objects in them are copied. Every build gets a copy of
  that, so what the `setup()` of a plugin does to `build.config` is gone with its build.
- A build that fails is a result with `success: false` and its `logs`. `throw` has no say: a
  rejection would end a `for await` loop and leave the watcher running behind it. What makes
  `Bun.build()` throw or reject on a rebuild is such a result too, with the error in `logs`: the
  `setup()` or `onEnd` of a plugin that throws, the directory of the entry point that is gone. The
  next change tries again.
- After a failed build the watcher also waits for what was missing. For a relative import that did
  not resolve, and for an entry point that is not there, it watches the nearest directory that
  exists for the one name that would be the missing thing (`value`, `value.ts`, or the `index` of a
  directory of that name) or the next step on the way to it. So "write the import, then create the
  file" builds without a second save, and nothing else that appears in that directory does.
- Changes that come together are one build: the watcher waits until no watched file has changed for
  50 milliseconds. A change during a build starts the next one as soon as that one has ended.
- `next()` returns the newest build that it has not returned yet. Builds that finished while the
  body of the loop was busy are skipped, so a slow consumer does not fall behind. Each build is
  returned once.
- The watcher builds whether or not anything reads the results. `Bun.build()` rejects on failure so
  that an error cannot go unseen, and a watcher has no promise to reject, so as long as nothing has
  called `next()` it prints the errors of a failed build to stderr, like the command line.
- `stop()` returns a promise. A build cannot be cancelled: one that is running writes its files, its
  result is dropped, the promise resolves when it has ended, and only then does a loop that was
  waiting end.
- One error ends the watcher: a directory that cannot be watched (the inotify limit). The `next()`
  that is waiting rejects with it, once. When none is waiting it is printed, and kept for the next
  one.

What makes it hold up, and what the review below made of the first version:

- It watches directories and not files, one `fs.watch` for each directory that has an input, and an
  event counts when it names an input. That survives an editor that saves by renaming a new file
  over the old one, a file that is deleted and made again, and a checkout.
- A watched directory can itself be removed, moved, or replaced by another at the same path, and the
  watcher of the old one hears nothing after that. Linux reports it as an event named after the
  directory. On that event, and after every build, the directory is compared with the one that is
  watched, by inode and by time of birth: ext4 gives a directory that is made right after another
  was removed the same inode number.
- A file can change between the moment a build reads it and the moment it is watched (the first
  build, and the build that first imports it). And what a failing build missed can appear while that
  build is still running. Both are looked for when a build has ended: a file that was not watched
  during the build and has a modification or change time after its start, or is gone, and a missing
  name that is there after all. Either starts another build at once. That build does not look again,
  so one that fails the same way twice is not made a third time.
- `Bun.build()` runs the event loop while it waits for an async `setup()`. The watcher says that it
  is building before it calls it, so an event or a timer that comes in from there waits for the
  build, and `stop()` waits for it too.
- A build of a watcher looks once more for an import that did not resolve, past the directory cache
  of the resolver, the way `bun build --watch` does. Without it the first build of a script that had
  just written a file failed two times in three in the debug build, with "Could not resolve" for a
  file that was there (see "not done" for the rest of that cache).

How it is made. The maintainer's outline in the thread was a native class that installs a
`bun_watcher::Watcher` on `BundleV2.bun_watcher`, the way the dev server does, with the warning that
"there are a bunch of event loop / lifetime issues". This commit does less in native code.
`Bun.build()` looks at `watch` before it reads anything else, and with `true` hands the config to
`src/js/internal/build_watcher.ts` (about 570 lines). That module calls the same native build for
every rebuild through an internal function, which differs from `Bun.build()` in three things: a
failed build resolves, an unresolved import is looked for once more, and the bundle thread copies
the paths of `graph.input_files` into the completion task, for a failed build too, which pushes them
into an array of the module before the promise settles. Files that were given in `files`, and files
that a plugin made up under a path of its own, are not among them. The module watches with the
internals of `node:fs` (not the public module, which a program may have patched). What that buys: a
rebuild goes through `JSBundleCompletionTask` like any build, so what upstream has built around it
holds without a line of new code: the ticket that makes VM teardown wait, the abort handles, and a
`Bun.ModuleGraph` whose `dispose()` closes the watchers of a build its code started, because the
context follows the code (there is a test for the last). What it costs is under "not done".

What a program that does not use it pays. Every `Bun.build()` call: one lookup of the property
`watch` on the config object. Every build: 32 bytes more in its completion task (an empty
`Option<Strong>` and an empty `Vec`), one `bool` in `BundleV2`, and three untaken branches. The
process: one internal module that is not loaded until a watcher is made (12.8 KB of JavaScript as
the debug build bundles it, without comments and not minified), one host function, one function in
C++. What that is in a release binary was not measured: no release build was made.

The types are four overloads. `watch: true` gives a `BuildWatcher`, `watch: false` a promise, a
`watch` of type `boolean` gives `Promise<BuildOutput> | BuildWatcher` so that a build script with
`watch: isDev` does not read `result.success` from a watcher, and everything else is a
`Promise<BuildOutput>` as before: a config typed as `BuildConfig`, `ReturnType<typeof Bun.build>`,
`Parameters<typeof Bun.build>`. The overloads have two prices. A type error in a config now reads
"No overload matches this call" with the error under each, at the same place as before. And a
function that is assigned to `typeof Bun.build` has to satisfy every overload, so a typed mock such
as `spyOn(Bun, "build").mockImplementation(async () => fake)` no longer compiles without a cast. A
reviewer counted 8 such errors in a file of the patterns, against none before.

Tests are `test/bundler/bun-build-watch.test.ts`, 36 of them, none of which runs on the released
binary (the file fails at its import of the testing hook, and `Bun.build()` there returns a promise
whatever `watch` is). No test waits for time to pass. `bun:internal-for-testing` tells what a
watcher watches, which names it waits for, how many builds it has started, and calls back after
every file system event it is told of, so a test can say "by the time the watcher heard of the last
of these changes, no build was pending". One test measures time, in the direction a slow machine
cannot break: a rebuild starts at least 45 ms after the last change. They cover: a change to the
entry point and to an import in another directory, a save by rename, a syntax error and its fix, a
first build that fails, a deleted and restored import, a directory that another is renamed over, a
directory removed and made again, an import that does not resolve until its file is created (next to
the importer, as the index of a directory, and two directories down one level at a time), a file
created while the failing build runs, what does not count after a failed build (other files, a new
directory, the temporary file of `compile`), a missing entry point, a removed and restored entry
directory, the watch list after an import is added and removed, a write during the first build, a
write to a new import during the rebuild that first reads it, a write during a build that is held in
`onLoad`, a hundred writes at once, the 50 ms, own output next to the input, `node_modules`, nothing
to watch, the newest result, each result once, `break`, `stop()` during a build, `await using`,
plugins (virtual modules, `onLoad` of a file, `setup()` per build, an async `setup()` with a save
inside it, `setup()` and `onEnd` that throw), the copy of the options (nested, inherited, changed by
a plugin), invalid options, the printing of a failure nobody asked for and its end once somebody
has, a child process that stays alive for exactly two builds, and one whose `Bun.ModuleGraph` is
disposed. After the last change to the module the debug build ran the file three times, one of them
with `BUN_JSC_validateExceptionChecks=1`. Before it, five times, two of those with twelve busy loops
beside it: one of the two lost the test with the two-build child process to the 5 second default of
a local run (the runner of CI gives a test 90). `tsc` on `src/js` and oxlint are clean, `tsc` on
`test/` has nothing to say about the new file, and `test/internal/source-lints/` and the types test
pass. Also run: `metafile.test.ts` and `bundler_plugin.test.ts` (131 pass), and
`bun-build-api.test.ts`, where ten concurrent tests and a test of 400 builds hit their timeouts in
the debug build. Run alone, the ten take between 3.3 and 5.1 seconds each against the limit of 5.
They were not compared with a build without this commit.

A review pass (four readers with the debug build, each with an area: the state machine of the
module, the native side, real file systems and tools, and the docs, types and tests, about 360
probes in an hour) found no crash, assertion or sanitizer report in the first version, and found it
wrong in these ways, all of which are fixed above and have a test: a save during an async `setup()`
started a second build inside the first (29 deep in one probe, a stack overflow at 172) and let
`stop()` resolve early. After a failed build every new file in a watched directory started a build,
which never ended with a `compile` that fails (it writes a temporary file next to the entry point)
or a plugin that clears its output directory. A file created while the failing build ran was never
seen. A directory removed and made again kept a dead watcher, because only the inode number was
compared. A directory replaced by rename was not noticed until something else built. An `onEnd` that
threw once, or a removed entry directory, ended the watcher for good. Inherited options were
dropped, nested ones were not copied, and what a plugin did to the options piled up from build to
build. A loop ended before the build that `stop()` waited for. An output spelled through a symlink
to the source directory built for ever. The check for a change before the watch missed a deleted
file and a file renamed into place. The testing hook could be reached from user code. Three tests
could pass with their subject broken, and two child-process tests sat on the local timeout. The
readers also confirmed what held: no lost update in 21 rounds of random writes, `process.exit()` and
`worker.terminate()` in every state, a `Bun.ModuleGraph` disposed with builds waiting, no growth of
objects or file descriptors over 300 rebuilds, and that the `Strong` in the completion task cannot
be dropped on the bundle thread.

Not done, and not checked.

- A rebuild runs in the process of the build before it, and the resolver keeps what it has read
  there. A changed `tsconfig.json` or `package.json` is not read again, a package that is installed
  after a build failed for the lack of it stays unresolved, and `.env` values that are inlined stay
  what they were. Two plain `Bun.build()` calls in one process show the same, on the released binary
  too, so it is not this commit's, and it was handed to an upstream session with two reproductions.
  Until it is fixed, those changes need the process started again, and the docs say so.
- None of these start a build either: a change to a `tsconfig.json` or a `package.json`, a file that
  a plugin reads on its own (esbuild has `watchFiles` and `watchDirs` for that, oven-sh/bun#4689), a
  macro, a new file that an import would now resolve to in place of the file it found, a symlink
  that is pointed at another file (the input is the file it pointed to), a write through another
  hard link. There is no `rebuild()` to ask for a build by hand.
- When a second watcher of the same directory is open (another `BuildWatcher`, or the program's own
  `fs.watch`) and the directory is replaced, the watcher that is made for the new one hears the old
  one: `fs.watch` reuses the watcher it has for the path. That is so for plain `fs.watch` on the
  released binary, and not in Node.js 26. It was reported to the hand-off of this session and not
  taken up.
- A file that was written or renamed in the 10 ms before a build started, and was not watched yet,
  counts as changed during it: a script that writes a file and then makes a watcher builds twice at
  the start. The other way round, a change in the first few milliseconds of a build could be missed
  without those 10 ms, because the kernel stamps files with a clock that lags by up to a tick.
- `await watcher.stop()` inside a plugin callback of the watcher's own build never resolves: the
  build waits for the callback. The docs and types say to call it without `await` there.
- There are no options: not the delay, not `node_modules`, no `AbortSignal`.
- Nothing is incremental. Every rebuild parses every file, as the command line does. The request for
  esbuild's `context()` in the thread is mostly a request for that.
- With `check: true`, a file that only the type checker reads (a type-only import) is not an input
  of the bundle and is not watched.
- Under `bun --hot`, a watcher that a reloaded module made goes on, like a timer or an `fs.watch`
  does. Stop it in the module, or keep it on `globalThis`.
- No test makes `fs.watch` fail, so the one way a watcher ends by itself is covered by reading only.
- Built and run on Linux x64 only. On macOS and Windows the names in events are compared without
  regard to case (and on macOS to how an accent is composed), and the event named after a removed
  directory is assumed to look as it does on Linux, where a directory that is replaced is also found
  after the next build. Nobody ran either. Where `fs.watch` hears nothing (some network and
  container mounts), neither does this.
- A design check was started before the code (the shape of the API: async iterator, callback or
  context object; and the layer: a native watcher on `BundleV2`, this module, or a recipe in the
  docs). It was stopped after three and a half hours with 34 of its agents done and no verdict, so
  the choices are this commit's own.

Rebase notes: 47 patches onto oven-sh/bun e655c58032, nothing dropped, four conflicts. All four are
with oven-sh/bun#44614, which fixed every type error in `test/` and touched 824 files. Two are in
fixtures of the types, where upstream and a patch both add lines at the end (`Bun.semver.parse()` of
2026-08-15 in `fixture/bun.ts`, `lines()` of 2026-08-18 in `fixture/streams.ts`): both are kept. One
is a type annotation upstream added on a line that the `#semver:` patch of 2026-09-17 had moved into
a helper of `bun-install-git-deps.test.ts`, and one is the import line of `bundler_comments.test.ts`
that the `legalComments` patch of 2026-09-29 also changes. The rebased stack builds. The tests of
the two patches with a test that was merged by hand pass (`bundler_comments.test.ts`,
`bun-install-git-deps.test.ts`), and so do `test/internal/source-lints/` and the types test. The
types test needed one change more: it names the line of `fixture/streams.ts` where `lines()` is an
error under `lib.dom`, and the lines upstream added above moved that from 92 to 109, so the
`lines()` patch is amended. Upstream's commit brought `test/` to no type errors, and says that
nothing in CI checks it. On this stack `tsc -p test` reported 43: the 2 that upstream names as known
for TypeScript 6, 5 in four files that no patch of this stack touches (`cli/check/check.test.ts`,
`bun-server.test.ts`, `webkit-upgrade-dbdca7545d.test.ts`, `s3-stream-stored-error-fixture.ts`), and
36 in the tests of ten patches. Those ten patches are amended so that the 36 are gone, which the
type checker of `bun check` confirms for the ten files: SOCKS5 (`proxy.test.ts`, 11), Web Storage
(6), zip (`archive.test.ts`, 5), `EventSource` (3), response compression (3), `expect.poll()` (2),
`Bun.JWT` (2), `legalComments` (2), Web Locks (1) and S3 metadata (1). The changes are of the kind
upstream made: `expect<unknown>(...)`, a cast, a `!`, a `@ts-expect-error` that had nothing to
expect. The transpiled output of eight of the files is the same byte for byte before and after.
`expect-poll.test.ts` differs by line breaks, and `eventsource.test.ts` now passes `url.href` to
`Response.redirect()`, whose type takes no `URL`: those two files were run again and pass. The other
eight were not run again.

Files: `src/js/internal/build_watcher.ts` (new), `src/jsc/bindings/BundlerWatch.cpp` (new),
`src/runtime/api/JSBundler.rs`, `src/runtime/api/js_bundle_completion_task.rs`,
`src/bundler/bundle_v2.rs`, `src/js/internal-for-testing.ts`, `packages/bun-types/bun.d.ts`,
`docs/bundler/index.mdx`, `docs/bundler/esbuild.mdx`, `test/bundler/bun-build-watch.test.ts` (new),
`test/integration/bun-types/fixture/build.ts`.

### 2026-10-13: `testMatch`, custom test file patterns for `bun test`

`bun test` runs the files whose name ends in `.test`, `_test`, `.spec` or `_spec` before the
extension, and nothing could change that. A project that names its tests `*.unit.ts` and
`*.int.ts`, or keeps them in `tests/` without a suffix, had to rename them or hand `bun test` a
list from `find`. oven-sh/bun#3440 asks for patterns: open since June 2023, 40 thumbs up, "Jest and
Vitest both allow us to specify a custom glob", and a maintainer's answer in the thread that "we
can do this now" that bun has globs. oven-sh/bun#26714 did it in Zig as `[test] include` in
February 2026. The sweep after the Rust rewrite closed it as stale, and nobody had reviewed it.
This is that feature on the Rust tree, under Jest's name:

```toml
# bunfig.toml
[test]
testMatch = ["**/*.unit.ts", "**/*.int.ts"]
```

```sh
# for one run: the flag replaces the list in bunfig.toml
bun test --test-match '**/*.unit.ts'
bun test --test-match 'tests/**' --test-match '!tests/fixtures/**'
```

The name is Jest's because its neighbours are: `pathIgnorePatterns` is `testPathIgnorePatterns`,
the flags of `bun test` are Jest's in kebab case, and the rule for `!` below is Jest's. The
`include` of a Vitest config works as a `testMatch` too.

What it does:

- A pattern is a `Bun.Glob` pattern, matched against the path of a file relative to the project
  root (the directory `bun test` runs in), like `pathIgnorePatterns`. `tests/**` is the `tests`
  directory of the project. A `./` in front is dropped.
- A pattern with a `!` in front takes files away, by the rule of Jest's `globsToMatcher`: the
  patterns are asked in order and the last one that has a say decides, a pattern on the paths it
  matches and a negated one on the paths it rejects.
  `["tests/**", "!tests/helpers/**", "tests/helpers/e2e.ts"]` means what it says. A `!(a|b)` group
  in front counts as a negation, as in Jest.
- A list of only negated patterns takes files away from the default names. This is not Jest's
  rule, where such a list makes every file a test. A file without tests fails a Jest run. In bun it
  runs and passes, so `testMatch = ["!e2e/**"]` would have executed every script in the project.
- A group with alternatives needs no prefix: `**/*.(spec|test).ts` is read as
  `**/*.@(spec|test).ts`. Jest's matcher (picomatch) reads a bare group that way and `Bun.Glob`
  reads it as text, and Jest lists are full of them: old versions of Jest had
  `**/?(*.)(spec|test).js?(x)` for a default. Parentheses without a `|` stay text, so
  `app/(marketing)/**` is the directory it looks like.
- `<rootDir>` in front of a pattern is the directory in `[test] root`, or the project root
  without one, with or without the slash behind it.
- Nothing else about discovery changes. A test file still needs an extension that bun loads as
  JavaScript or TypeScript (`tests/**` does not run `tests/data.json`, and a `[loader]` mapping
  counts), `node_modules` and dot directories are not scanned, `pathIgnorePatterns` and the
  positional filters still apply, and a file path on the command line runs whether or not a
  pattern matches it.
- `--test-match` replaces `testMatch` for the scan. A wrong `testMatch` in bunfig.toml is an error
  with or without the flag.
- `coverageSkipTestFiles` leaves out the files the patterns name in place of the files with a
  default name. A run with `--test-match` also leaves out the tests it did not ask for: what
  `testMatch` in bunfig.toml names, or without one the default names. So
  `bun test --coverage --test-match '**/*.unit.ts'` does not report `cart.int.ts` as source.
- When nothing matches, the message names the patterns in place of the four suffixes, and adds a
  note when a pattern ends in an extension that bun does not run (`features/**/*.feature`
  without a loader).

The cucumber case from the issue thread works and is in the docs and the tests: `testMatch =
["features/**/*.feature"]`, `[loader] ".feature" = "ts"`, and a preload plugin whose `onLoad`
turns a feature file into `test()` calls.

How it is made. `Scanner.rs` has two new types. `TestMatch` is one list: the patterns prepared
once with upstream's `bun_glob::Prepared`, and the project root as it was when the run started.
`TestFiles` is the two lists, the flag's and bunfig's. The scanner asks `TestFiles::scanned()` at
the one place where it took a file name for a test. `coverageSkipTestFiles` asks
`TestFiles::names()` through the runner, where upstream asked for the suffix, so a `--parallel`
worker answers the same (it gets `--test-match` on its command line when coverage is on, and
reads bunfig.toml itself). A pattern is rewritten once, when the list is made: the prefix goes,
a bare group gets its `@`, and what stood behind a dropped prefix is escaped where it would
otherwise join the `!` in front (`!./(old)/**` is not the group `!(old)/**`). The other places
this could have lived were weighed and left: globs as positional arguments (what `node --test`
has) would change what `bun test [id]` means today and give plain `bun test` no configuration,
and more than one `root` does nothing for suffixes.

What a project that does not use it pays. A scan: an `Option` that is `None`, asked twice for a
file. A module load under `--coverage`: the same `Option` on the runner. `TestOptions` is 48
bytes larger (two empty `Vec`s), the runner and the scanner 8 each, and `bun test` has one more
flag in its table. No release build was made, so there is no number for the binary.

Against Jest. A reviewer wrote Jest's `globsToMatcher` over the picomatch 2.3.1 and 4.0.4 that are
in `test/node_modules`, and compared real `bun test` runs with it on a tree of 77 files. Of 63
pattern lists of the kind Jest configs have, 60 now run the same files (48 before bare groups were
read Jest's way). The three that differ: `**.test.ts` and `**.spec.js`, which picomatch matches at
any depth and `Bun.Glob` only in the root, and a group without a `|`, `(*.)`. Of 200 random lists
of one to five patterns, 177 run the same files, and the 23 that differ are the lists of only
negated patterns, on purpose. The docs name what else differs: patterns are relative (Jest matches
absolute paths), `[id]` is a character class, and there is no `testRegex`.

A review pass before the push: four readers with the debug build, one each for the matcher
against picomatch, the scanner, the other `bun test` features, and the docs and tests, about 470
probes in an hour. No crash and no sanitizer report. What they found is fixed above and has a
test: a dropped `./` or `<rootDir>/` changed what the rest of a pattern meant. A `!(a|b)` group in
front added files where Jest removes them. A bare group matched nothing and said nothing. A list
of only negated patterns ran every file. `<rootDir>` ignored `root`. With `--coverage
--rerun-each` the header of the second run named a file that does not exist, because the first
version asked `resolve_path::relative()`, which answers in a buffer of the thread that
`TestCommand::run` is still reading the file name from: `TestMatch` now computes the relative
path itself. Coverage read the patterns against the directory a test had changed to. A run
narrowed with `--test-match` reported the other tests as uncovered source. An invalid bunfig
value passed with the flag and killed every `--parallel` worker without it. The hint blamed the
patterns when the extension was the reason. Two tests passed without the feature. There was no
second review after the rework. The first reviewer's harness was run again, with the numbers
above.

A bug in an older patch, found by the same readers: since `--last-failed` (2026-09-05), a test
file behind a symlink was printed under a garbled name, `linked.test.tsntation.ts:` for
`shared/implementation.ts:`, in every run. `LastFailed::begin_file` asked `relative()` after
`TestCommand::run` had taken the file name from the same buffer. It is fixed in that patch, by
asking first, with a test in `test-last-failed.test.ts`.

Tests: 31 in `describe("testMatch")` at the end of `test/cli/test/bun-test.test.ts`. All 31 fail
on the released bun (1.4.3) and pass on the debug build. The whole file in the debug build: 141
pass, 8 fail, none of the 8 in the new block. Six import `node:test` and take 5 to 7 seconds
against the local limit of 5 (they pass with `--timeout 60000`). Two make a value 100,000 levels
deep, which takes the debug build 14 seconds. They were not compared with a build without this
commit. Also run in the debug build, with `--timeout 60000` where a test does several runs:
`test-last-failed.test.ts` (8), `coverage.test.ts` (50), `test-shard.test.ts` (29),
`test-changed.test.ts` (20), `path-ignore-patterns.test.ts` (10), `concurrent-test-glob.test.ts`
(6) and `pass-with-no-tests.test.ts` (5) pass. `parallel.test.ts`: 44 pass, 3 fail. Two of the
three count worker processes by how long a file takes and fail alone as well: a file takes the
debug build longer than the 250 ms the test allows. They pass on the released bun, and were not
compared with a debug build without this stack. `test/internal/source-lints/`: 178 pass with the
released bun, which is how CI runs it. In the debug build it takes 22 minutes and three of its
tests hit the limit of 5 seconds.

Not done, and not checked:

- `coverageSkipTestFiles` asks about the path a module was loaded under. A test file behind a
  symlink is loaded under its real path, which the patterns may not name, and then it is in the
  report. The default names do not have this problem, because a suffix goes with the file.
- For a file path on the command line that bun cannot run, the note still says what `testMatch`
  needs, and a file path needs no match. Upstream's note for the default names has the same flaw.
- A `--parallel` worker reads `./bunfig.toml` and is not told of `--config`, on the released bun
  too. With `--config`, `--parallel` and `--coverage` together, a worker takes `testMatch` from the
  wrong file. Handed to an upstream session with a reproduction, and not taken up.
- `bun test --coverage` panics on the released bun when a test imports a `data:` URL of more than
  4096 bytes ("range end index 5042 out of range for slice of length 4096" when the table is
  made). `TestMatch` returns early for what is not a path, so this commit adds no second place.
  Handed to an upstream session as well, and not taken up.
- A scan still walks the whole tree. It does not start at `tests/` because the only pattern is
  `tests/**`.
- Built and run on Linux x64 only. On Windows the relative path is compared without regard to
  case and with both separators, and nobody ran it. The zsh completion was not tried in zsh.
- The design check that the harness asks for was not run. It traces a bug to its root cause, and a
  feature has none. The choices above are this commit's own.

Rebase notes: 48 patches onto oven-sh/bun c69a636b9d (37 commits since e655c58032, among them
`bun lint`, `bun fmt`, a new glob matcher and the merge of the open TLS fixes), nothing dropped.
Nine patches had conflicts. In seven, both sides are kept: three import lines
(`bunshell.test.ts`, `proxy.test.ts`, `pack_command.rs`), the module list in `cli/mod.rs`, a
section of `docs/runtime/bunfig.mdx`, the `Loader` type in three docs pages (upstream's formatter
had put it on one line, and with `"bytes"` it no longer fits), and `glob.rs` of the `ignore`
patch. Two took more. `is_ignored` in `test_command.rs` now gets prepared patterns from upstream,
so `collectCoverageFrom` prepares its list once. And upstream added `lint` and `fmt` to the chain
of compares that the "did you mean" patch had turned into the `ROOT_COMMANDS` table: they are two
rows of it now, and the check for a script of the same name is upstream's
`script_or_command::is_of_the_project`. Three patches built no longer and were changed without a
conflict. Upstream's `bun lint` brought a `strings::edit_distance` of its own (plain Levenshtein),
so the one of "did you mean" is `typo_distance`. The parser type lost a const parameter
(`import.meta.glob`). Upstream's new migration of Yarn Berry lockfiles builds a `LoadResultOk`,
which needed the `merged_conflict` field of the lockfile merge. After that the stack builds. The
tests of the patches that were touched pass in the debug build: `scan.test.ts` (215, and 6 that
compare with fast-glob time out, because fast-glob takes the debug build 142 seconds where
`Bun.Glob` takes 2.5 for the same 10,793 paths), `run_command.test.ts` and the `bun pm` test of
"did you mean", upstream's `test/cli/lint/help.test.ts` (56, it goes through the rewritten
`which()`), the SOCKS5 tests (44, five of them only when run alone), the `collectCoverageFrom`
tests (15, three only alone), both `import.meta.glob` files, the 70 lockfile merge tests, the
shell's `[[ ]]` tests, the source lints and the types test.

Files: `src/runtime/cli/test/Scanner.rs` (`TestFiles`, `TestMatch`),
`src/runtime/cli/test_command.rs`, `src/runtime/test_runner/jest.rs`,
`src/runtime/cli/test/parallel/runner.rs`,
`src/runtime/cli/Arguments.rs`, `src/bunfig/bunfig.rs`, `src/options_types/context.rs`,
`completions/bun.zsh`, `completions/bun-cli.json`, `docs/test/configuration.mdx`,
`docs/test/discovery.mdx`, `docs/test/code-coverage.mdx`, `docs/runtime/bunfig.mdx`,
`docs/guides/test/migrate-from-jest.mdx`, `docs/snippets/cli/test.mdx`,
`test/cli/test/bun-test.test.ts`.

### 2026-10-14: `bun test --coverage-reporter=html`, a coverage report to browse

`bun test --coverage` prints a table and can write `lcov.info`. The table says which lines of a file
did not run, and nothing shows them: for that one needs `genhtml` from the lcov package, an editor
extension or a coverage service. oven-sh/bun#4099 asks for the `html` reporter that Jest, Vitest, c8
and nyc have. It has been open since August 2023 and has 31 upvotes, and the last comment in it
says that `genhtml` on Bun's `lcov.info` is "not as good as" the Istanbul report. One attempt
exists, oven-sh/bun#21015 of July 2025 from the `jarred-sumner-bot` account. It was closed with CI
red and without a review. By its description it wrote one page per file under a flat name
(`src-utils.ts.html`) with the percentages and the uncovered line ranges, and not the source. A
search found no open pull request for an html reporter (oven-sh/bun#40218 adds a cobertura one).
Now:

```sh
bun test --coverage-reporter=text --coverage-reporter=html
```

```toml
[test]
coverageReporter = ["text", "html"]   # then: bun test --coverage
```

```txt
coverage/
├── index.html
└── src/
    ├── math.ts.html
    └── utils/
        └── string.ts.html
```

What it writes, point by point:

- `index.html` lists every file with the `% Funcs` and `% Lines` of the text table, the number of
  functions and lines that ran, and a bar. The "All files" row is the one of the table, made by the
  same function (`average_fraction`, which the table now calls too), so the two cannot differ. A
  number is red when it is below the threshold, by the rule the table colours with. The rows can be
  sorted by name and by either percentage, and filtered by a search box. That is the one script of
  the report, 1.2 KB, in the index alone. Without it the table is the files in the order of their
  names.
- The page of a file shows its source, one row for each line. A line that ran has a green mark, a
  line that is executable and did not run has a red mark and a red background, and a line the report
  does not count has none. The ranges of the "Uncovered Line #s" column are at the top, each a link
  to its first line, and every line has an anchor (`#L12`).
- The pages mirror the directories of the project. When a test loads a file from outside the project
  directory (the sibling package of a monorepo), the paths start at the deepest directory that holds
  the project directory and every file, so no page leaves the coverage directory. A module that is
  not a file (a `data:` or `blob:` URL, a module a plugin makes up) has one page next to the index.
- Every page carries its style (2.9 KB) and loads nothing, so a page opens alone and the directory
  can be an artifact of a CI run. It follows `prefers-color-scheme`, and on a narrow screen the index
  hides the counts and the bars.
- A page is written to a temporary file next to it and renamed, so a reader never sees half a page.
  When a file cannot be written the run ends with `Failed to write coverage/src/math.ts.html` and
  exit code 1, in a serial run and under `--parallel`.

It is one more consumer of the reports that the other two reporters print, so it follows
`--parallel` (the coordinator writes it from the merged reports), `collectCoverageFrom`,
`coveragePathIgnorePatterns`, the ignore hints and `coverageThreshold` without a line of its own for
any of them. The tests hold it to that: the marks of every row are compared with the `DA` records of
`lcov.info` of the same run, the numbers with the table.

What the pages do not show, and why. There are no hit counts. The number after the comma in Bun's
`DA:<line>,<n>` is not how often a line ran: it counts the bytes of the executed blocks that map to
the line (`DA:2,13` for a `return a + b;` that ran once), so only zero and not zero mean something,
and that is what a mark is. The marks also make visible what the table only hints at: for a function that
never ran, the report has the lines around its start and not its body, so the body has no mark, and
the line above the function can be red (upstream has oven-sh/bun#41528 open for line attribution).
The docs say so instead of promising that red means "did not run".

A page has a note in place of the source when the source on disk is not what the line numbers
count: the file cannot be read, the module is not a file, the file has fewer lines than the last
line the report marks (a test rewrote it), `coverageIgnoreSourcemaps` is set, or the file is a
`// @bun` bundle that names a source map of its own (Bun then numbers the lines of the sources the
bundle was made from). The ranges at the top are plain text then, as there is no line to link to.

The names of the pages. A segment of a path keeps its bytes except the ones Windows forbids
(`< > : " | ? *`, `\`, control characters), which become `_`. `.`, `..` and the device names of
Win32 (`aux`, `nul.js`) get a `_` in front, a directory that ends in a dot or a space gets one
behind, a segment is cut at 200 bytes, and two pages that end up with one name (also when they only
differ in case) are numbered: `a_b.ts.html`, `a_b.ts-2.html`. Every file of the report ends in
`.html`, so a directory that does (and one named `lcov.info`) gets a `_` too, and a page can never
be where the index or a directory has to be. A path that does not fit a path buffer with the
coverage directory in front of it loses its directories instead of failing the run.

How it is made. The renderer is `src/sourcemap_jsc/CodeCoverageHtml.rs` (417 lines with the style
sheet and the script), next to the `text` and `lcov` modules, because the fields of a `Report` are
private to that crate. The rows of a page are not split by a rule of its own: they come from
`LineOffsetTable::generate`, the table that numbers the lines of the report, so a row is a line of
the report by construction. `src/runtime/cli/test/CoverageHtml.rs` (336 lines) lays the pages out,
reads each source the way the module loader does (a UTF-16 file with a byte order mark is
converted), and writes the files. The hook is three lines in `print_coverage_reports_`, which the
serial runner and the `--parallel` coordinator both go through. The error of that path was a bare
`bun_sys::Error` printed as "Failed to write lcov.info" at two places, and is now a `ReportError`
that names the file.

What a run without the reporter pays: one more `bool` in `Reporters` and one branch after the lcov
branch. What a run with it pays: one read of every source file and one page, 78 bytes of markup for
a line on top of its text. For 2000 files (240,000 lines, 9.4 MB) the debug build needs 38 to 42
seconds with `--coverage-reporter=lcov` and 45 seconds with `html` (27 without coverage), and writes
42 MB. No release build was made, so there is no number for a release binary: not for the time and
not for what the two modules add to its size.

A review pass (four readers with the debug build, each with an area: the Rust code, the contents of
the pages, the file system, and the tests and docs; 87 minutes, 474 commands, 39 findings) found
these, all fixed in this commit and with a test unless it says otherwise:

- The run never ended when the coverage directory was a dangling symlink. `File::make_open` makes
  the directories with `bun_paths::make_path_with`, which goes back and forth between the link
  (`EEXIST`) and its child (`ENOENT`) for ever. The pages are now opened and their directories made
  the way the lcov reporter does it, which ends with `ENOENT`.
- The first version split lines by its own rule. The line table reads a `\n` after a byte such as a
  Latin-1 `é` as a part of that character, so in such a file every mark was one row off.
- A UTF-16 source, which Bun loads, was shown byte by byte.
- For a module that is not a file, a file of that name in the working directory was shown as its
  source. A `data:` URL became a directory for each `/` in it (470 for a URL of 3.9 KB).
- The temporary files were named by the process id, as the `--timings` file is. Two runs in two
  containers that share a directory have the same id. They have a random name now, as the one of
  `lcov.info`.
- The bar was a `<meter>`, whose colour could contradict the number beside it (yellow at a
  threshold of 1.0). It is a `<progress>` in the colour of the number.
- The index said it was sorted by name and was sorted by path, which differs for a file outside the
  project. After "filter, open a page, Back" Chrome restores the text of the filter after the script
  has run, and the list was whole again (checked by hand, as the script has no test: see below).
- The links of the uncovered ranges led nowhere on a page without source. A bundle with its own
  source map was shown with the line numbers of other files painted on it.
- A source path of 4061 bytes, which is fine for the other reporters, failed the run.
- The docs said that red means "executable and did not run", which the fixture of the tests
  disproves, linked to an anchor that does not exist, and had a `bunfig.toml` snippet that writes
  nothing as written (`coverageReporter` does not turn coverage on).
- Tests that could not fail: the marks of the line-ending test came from `lcov.info` of the same
  run alone, the regular expression of the index took either colour, and nothing looked at the
  totals of a page, at `--coverage-dir`, or at a failure under `--parallel`.

Found on the way, in upstream and not in this stack. All four are reproduced on the released
1.4.3-canary.1+367d939d9. They were handed to the hand-off of this session, which took none, so
they are written down here:

- `bun test --coverage-reporter=lcov` leaves a `.lcov.info.<hex>.tmp` in the coverage directory on
  every run after the first. `write_lcov_report` moves its temporary file with `move_file_z`, which
  swaps the two names when `lcov.info` exists, and the old file stays under the temporary name.
- The loop above is in a helper that upstream uses too. When `link` is a dangling symlink,
  `bun test --timings=link/sub/t.json --update-timings` and
  `bun build --metafile=link/sub/meta.json` never return.
- `bun test --coverage` panics (`range end index 6748 out of range for slice of length 4096`) when
  a test imports a module from a `data:` URL that is longer than a path buffer. The table and
  `lcov.info` pass the URL to `resolve_path::relative`. The html reporter does not, and gets through.
- A map that comes from a file's `sourceMappingURL` is parsed with `i32::MAX` for the number of
  lines, and the report of that file is sized by it: two bit sets of 2^31 bits and 8 GB of zero
  pages for the hits. For a bundle of 9 lines that is 1.5 seconds in a serial run and 45 seconds
  under `--parallel=2`, where every worker sends all of it to the coordinator. This is why the test
  for such a bundle is skipped in debug and ASAN builds, where the walk takes 16 seconds.

Not done, and not checked.

- The script of the index has no test. A DOM to run it in costs the debug build 17 seconds to
  import (happy-dom). It was run in Chrome 153 through `Bun.WebView`: sort by each column in both
  directions, filter, filter and Back, the links in both directions, the anchor of a line, dark
  mode, a width of 400 pixels.
- No syntax highlighting, no execution counts (see above), no branches, no page for a directory.
- A file that the `onLoad` of a plugin rewrites is shown as it is on disk, with the marks of what
  the plugin returned, unless that is longer than the file. The report has no way to tell.
- The pages of an earlier run are not deleted, and a run with nothing to report writes nothing, so
  the directory can hold an index that is older than the run. The docs say to delete it first.
- When a page cannot be written, a serial run exits before the JUnit or JSON report, the timings
  and the record of `--last-failed` are written. That is what a failure to write `lcov.info` does
  today. `--parallel` writes them first.
- `--coverage-reporter` and `--coverage-dir` on the command line lose to `coverageReporter` and
  `coverageDir` in `bunfig.toml`. That is upstream's order, and oven-sh/bun#44682 changes it.
- A threshold that fails ends the run with exit code 1 and no message when the text reporter is
  off, as with `lcov` alone.
- Built and run on Linux x64 only. The Windows rules for names are code that was read, not run:
  the tests for them run on POSIX, and the one test for a dangling symlink is skipped on Windows.
  `completions/bun-cli.json` was edited by hand, not generated.
- No design check was run before the code: the reporter has one place to live, next to the other
  two. The shape of the report (an index and a page for each file, under the coverage directory, as
  Istanbul's `html` reporter has it) is this commit's own choice.

Tests are in `test/cli/test/coverage.test.ts`: 15 in a block of their own and one with the
`collectCoverageFrom` tests. All 16 fail on the released binary. The debug build passes 15 and
skips the one for the bundle (it passed there once, in 16.8 seconds, before it was skipped). The
whole file passes there (65, 1 skipped) with a timeout above the default: eight of its older tests
need more than the 5 seconds of a local run in a debug build. `test/internal/source-lints/` passes
with the released binary (178). With the debug build four of its tests time out and the rest pass.

Rebase notes: 49 patches onto oven-sh/bun 408c9374b2, no conflict, nothing dropped. The run of
2026-10-13 was still under way when this one started. Three and a half hours into this run it
pushed `testMatch` and a change to the `--last-failed` patch, on the base of the day before. This
run had rebased the 48 patches it found in the morning, and found out when its push was refused.
It rebased the 49 of that push, which was clean, and put this commit on top, where `SOUP.md` was
the one conflict (two entries at the same place). Two sentences of the `testMatch` entry are
reflowed in its commit: prettier does not take a code span that runs over the end of a line. The
stack of 50 builds. On it the tests of this commit, the `testMatch` tests (31), the `--last-failed`
tests (8) and the source lints pass. The three workflows of the fork were green on the push before
this one.

Files: `src/sourcemap_jsc/CodeCoverageHtml.rs` (new), `src/runtime/cli/test/CoverageHtml.rs` (new),
`src/sourcemap_jsc/CodeCoverage.rs`, `src/runtime/cli/test_command.rs` (`ReportError`,
`average_fraction`, the hook), `src/runtime/cli/test/parallel/aggregate.rs`,
`src/runtime/cli/Arguments.rs`, `src/runtime/cli/mod.rs`, `src/bunfig/bunfig.rs`,
`src/options_types/code_coverage_options.rs`, `docs/test/code-coverage.mdx`,
`docs/test/configuration.mdx`, `docs/runtime/bunfig.mdx`, `docs/snippets/cli/test.mdx`,
`completions/bun-cli.json`, `test/cli/test/coverage.test.ts`.

### 2026-10-15: `Bun.unescapeHTML()`

`Bun.escapeHTML()` has been in Bun since the early releases, and nothing went the other way.
`HTMLRewriter` hands back the text of a page as it is written in the document, so `text.text` is
`Tom &amp; Jerry` and `el.getAttribute("href")` is `/search?q=1&amp;lang=en`. Feeds, scraped pages
and the HTML bodies of mail are the same. To get the text a person reads, a script installs `he`,
`html-entities` or `entities`, although the table of the 2,125 named references of HTML has been in
the binary since `Bun.markdown`. Now:

```ts
Bun.unescapeHTML("&lt;p&gt;Tom &amp; Jerry&lt;/p&gt;"); // "<p>Tom & Jerry</p>"
Bun.unescapeHTML("caf&eacute; &#9749; &copy 2026"); // "café ☕ © 2026"
Bun.unescapeHTML("5 &lt 6, &bogus; & co"); // "5 < 6, &bogus; & co"

// the value of an attribute
const href = el.getAttribute("href"); // "/search?q=1&copy=2&amp;lang=en"
Bun.unescapeHTML(href); // "/search?q=1©=2&lang=en"
Bun.unescapeHTML(href, { attribute: true }); // "/search?q=1&copy=2&lang=en"
```

It reads a character reference the way the HTML tokenizer does, which is what `he.decode()` and
`entities.decodeHTML()` implement too:

- A name with its `;`: all 2,125 of them, case-sensitive, one or two code points each
  (`&NotEqualTilde;` is two, `&Afr;` is outside the BMP).
- The 106 names of HTML 4 also without their `;` (`&amp`, `&copy`, `&nbsp`). The longest name that
  matches wins and what follows it is text: `&notin;` is `∉`, `&notit;` is `¬it;`.
- `&#38;` and `&#x26;`, with or without the `;`. `&#0;`, a surrogate and a number above U+10FFFF
  are U+FFFD, and 128 to 159 are read as Windows-1252 (`&#150;` is `–`), as pages written on Windows
  meant them.
- Everything else stays as it is, `&` included, so no input throws.
- `attribute: true` adds the rule of the tokenizer for attribute values: a name without its `;` is
  not a reference when `=`, a letter or a digit follows it. That rule exists for query strings, and
  it is why the option is there: `HTMLRewriter` returns attribute values raw, and decoding an `href`
  as text turns `&copy=2` into `©=2`.

Non-string arguments are converted to a string first, as in `Bun.escapeHTML()`. A string without a
reference is returned as it is and nothing is allocated for it. Otherwise the output is allocated
once at the length of the input, because no reference is shorter than what it stands for, and the
string is handed to JavaScriptCore without a copy. The decoder is generic over the two kinds of
JavaScript string. A Latin-1 string stays Latin-1 until a reference names a character Latin-1 does
not have, so `caf&eacute;` costs one byte per character and `&hearts;` still works, and a UTF-16
string is read as UTF-16, so a lone surrogate next to a reference passes through untouched.

The named references come from `bun_md::entity::lookup`, which is now public; the new code adds the
list of the 106 HTML 4 names and the 32 code points of the Windows-1252 block. While it was written,
the function was compared with `entities` 4.5.0 (`decodeHTML` and `decodeHTMLAttribute`) on every
name with and without its `;` in front of twelve different characters, on the numeric edge cases, and
on 300,000 random strings of fragments: 703,958 comparisons, no difference. The test in the
repository does not depend on that package. It has the cases by hand, the 106 names, a round trip
through `Bun.escapeHTML()`, both string kinds with a reference at every offset of the first 70, and
`HTMLRewriter` output for text and for an attribute.

Not done: the function takes a whole string, so a caller has to join the chunks of an
`HTMLRewriter` text node first (the docs say so and show how). There is no strict mode that
reports a malformed reference.

Rebase notes: oven-sh/bun#44968 landed upstream the evening before. It consolidates 597 package
manager pull requests in one commit that touches 699 files, and twelve patches of this stack needed
a hand merge because of it and of a few smaller upstream changes of the same day. Six were ported
again onto rewritten upstream code: `bun outdated --json` (the table is built from
`DeclaredDependencies` now, and the JSON rows are kept beside it), the "did you mean" note of `bun
pm` (upstream's dispatch is kept and the candidates come from a list, see that entry),
`publishConfig` overrides (`edit_root_package_json` was rewritten), `#semver:` for git dependencies
(the enqueue code was reshaped; the refresh of a cached clone is upstream's now), trusted publishing
(`publish()` was rewritten, the exchange now also runs once per package under `--recursive`) and zip
in `Bun.Archive` (the extraction writes through upstream's new sparse-aware writer). The patch of
2026-09-25 was dropped in that push and is back since a later push of the same day (see its entry).
After the rebase the tests of every merged patch pass. The other test files of the stack were run as
well. What does not pass in them is the debug build being slow (timeouts, and one test that needs a
worker process to start within 200 ms), one inline snapshot that expects colours, and a MySQL login
that this machine does not have.

Files: `src/runtime/api/unescape_html.rs` (new), `src/runtime/api.rs`,
`src/runtime/api/BunObject.rs`, `src/jsc/bindings/BunObject.cpp`,
`src/jsc/bindings/BunObject+exports.h`, `src/md/lib.rs`, `src/md/entity.rs` (`lookup` is public),
`packages/bun-types/bun.d.ts` (`unescapeHTML`, `UnescapeHTMLOptions`), `docs/runtime/utils.mdx`,
`docs/runtime/html-rewriter.mdx`, `docs/runtime/bun-apis.mdx`,
`test/js/bun/util/escapeHTML.test.js`, `test/integration/bun-types/fixture/bun.ts`.

### 2026-10-15: a real `performance.eventLoopUtilization()`

`performance.eventLoopUtilization()` of `node:perf_hooks` says which share of its time the event
loop spent working and which share it spent waiting for events. It is what a server reads to shed
load before it falls behind. In Bun it was a stub that returned `{ idle: 0, active: 0, utilization:
0 }` for every call, and the compatibility page said so. A program that reads it does not fail: it
sees a loop that is never busy. oven-sh/bun#34068 reports it for `@fastify/under-pressure`, whose
load shedding never triggers on Bun. Now the numbers are real:

```js
import { performance } from "node:perf_hooks";

let last = performance.eventLoopUtilization();
setInterval(() => {
  const now = performance.eventLoopUtilization();
  const { utilization } = performance.eventLoopUtilization(now, last);
  last = now;
  console.log(`event loop ${(utilization * 100).toFixed(0)}% busy`);
}, 1000).unref();
// event loop 1% busy
// event loop 72% busy      <- a second with a 1.2 s synchronous loop in it
// event loop 2% busy
```

What it counts:

- `idle` is the time the loop of the calling thread was parked in its event provider: the
  `epoll_pwait2` or `kevent64` call of `us_loop_run_bun_tick` on Linux and macOS, timed only when
  the call can block (not for a zero timeout, which is libuv's rule too), and libuv's own
  `UV_METRICS_IDLE_TIME` on Windows. `active` is the rest of the time, `utilization` is
  `active / (idle + active)`. Time in `Bun.sleepSync`, in a synchronous file read or in
  `spawnSync` is active, as in Node.js: the loop is blocked, not waiting.
- The three ways to call it are Node's, ported from `lib/internal/perf/event_loop_utilization.js`
  with its order of checks: no argument for the totals, one earlier reading for the difference
  since then, two readings for their difference without a reading of the loop.
- Every thread has its own loop, so a `Worker` that calls it gets its own numbers.
- `performance.nodeTiming.idleTime` is the same count. `performance.nodeTiming.loopStart` is the
  time at which the loop began to count, and `-1` before. Both were the constant `1`.

What it costs, and the one place where it is not Node. Node.js lets libuv time the wait of every
loop from its start. Here a loop reads the clock for this only after something has asked. The
first call of `eventLoopUtilization()` (or the first read of `nodeTiming.idleTime`) asks, the loop
takes its origin the next time it polls for events, and until then the answers are zeros and
`loopStart` is `-1`. That is what Node.js answers until its loop has started, so the usual first
call, in the main script, reads the same in both. Two things differ. The time before the first
call is in no total, so a first call that comes late in the life of a process returns zeros once
where Node.js returns the totals since its loop started. And the immediates that the turn of the
first call queues run before the count begins, where Node's loop start comes before them. What a
loop that is never asked pays: two compares of one byte in each tick, on the cache line that the
tick writes `tick_depth` to. What a loop pays after it was asked: two clock readings for each tick
that can wait. `us_internal_loop_data_t` grows by 16 bytes on Linux and macOS (208 to 224) and by 8
on Windows (216 to 224), one per loop, measured with `size_of` for three targets. These are counts
from the code. There is no release build of this commit and no benchmark.

Upstream has this three times already, which I found after the code was written: the search before
the pick was of the source, where the stub is, and not of the pull requests. oven-sh/bun#32618 is
this account's own, from June, and was closed by the stale sweep on the day of this entry.
oven-sh/bun#44627 (open) does it for the main thread on Linux and macOS. oven-sh/bun#34424 (open,
from the bun team) has it inside a larger `worker_threads` change, which I have not read. By their
descriptions the first two time every tick that waits, for every loop, from its start, and #32618
stores the count with atomics so that a parent thread can read the loop of a worker. Several of its
automated reviews asked for a maintainer to look at the cost in the hot path. So this is a fourth
take, written without their code. What is new in it is the cost model: nobody pays who does not ask.
What it lacks that #32618 and #34424 have: `worker.performance.eventLoopUtilization()`, the parent's
view of a worker, is still the stub.

Tests. Node's own `test/parallel/test-perf-hooks-eventlooputilization.js` is vendored unchanged
(from `main` of nodejs/node on 2026-10-15). On the released 1.4.3-canary.1 it never ends: it waits
for idle time to appear. On the debug build of this commit it passed 25 of 25 runs, 6 of them with
the machine oversubscribed twice over. `test/js/node/perf_hooks/perf_hooks.test.ts` has three new
tests: the wait for a timer is idle and a synchronous loop is active, with the exact relations
between the three call forms and `nodeTiming`; a worker that never waits and a main thread that only
waits for it each see their own loop; two equal readings give `NaN`. All three fail on the released
binary and pass on the debug build, also under that load. The file passes (16), and so do
`bun-server.test.ts` (82), `worker_threads.test.ts` (153), the `setImmediate` and `performance`
timer tests and six vendored Node tests of `perf_hooks`, all on the debug build. The source lints
pass with the released binary (182), as the fork's workflow runs them. With the debug build two of
them time out. `setTimeout.test.js` and `setInterval.test.js` fail four leak tests on the debug
build. Their fixtures take the ASAN threshold only for a binary named `bun-asan`, and the debug
build is an ASAN build under another name: its RSS grew by 102 MB, which is between the two
thresholds (10 MB and 192 MB).

Not done, and not checked.

- `worker.performance.eventLoopUtilization()` (above). The other values of `nodeTiming` are still
  placeholders, and the Node additions to the global `performance` still appear only after
  `node:perf_hooks` was loaded.
- Built and run on Linux x64 only. `libuv.c` was not compiled: it calls `uv_loop_configure`,
  `uv_hrtime` and `uv_metrics_idle_time`, which libuv has had since 1.39. The Rust side was checked
  with `cargo check -p bun_uws_sys` for `x86_64-pc-windows-msvc` and `aarch64-apple-darwin`.
- No design check was run before the code. The measurement has one place to live (the wait itself).
  When the count starts was decided twice: the first version counted from the first call, and
  Node's test showed that `nodeTiming.loopStart` has to agree with the totals.

Rebase notes: two runs did the work of this day. This one and the run that pushed
`Bun.unescapeHTML()` started from the same stack and the same upstream commit (oven-sh/bun
5f5799ed16, 18 commits after the last base), and each rebased the 50 patches without knowing of the
other. This one found out when it fetched before its push. It took that push as its base and put two
commits on it: the patch of 2026-09-25, which the other run had dropped (see the note in its entry),
and this one. The rest of the stack is as the other run pushed it, and nothing is dropped any more.
A `git range-diff` of the two rebases shows 42 of the 49 patches they share as identical. Two more
differ only in the lines of this file around their entries. The other five were ported again onto
upstream's rewritten package manager (oven-sh/bun#44968) by both runs, and four of them to the same
design: a table of the subcommand words for the "did you mean" note of `bun pm`, the `publishConfig`
call in the new `edit_root_package_json`, `Scope::with_issued_token` and no early check for
credentials when an id token is on offer for trusted publishing, and the `#semver:` lookup inside
upstream's merged arm for GitHub and tarball dependencies. The fifth is `bun outdated --json`: the
version that is pushed keeps the version strings of the first pass, and this run's printed them from
the rows of the table. Upstream `main` has one commit more since (a407eae88a). The stack is not on
it.

On the stack as it is pushed, these pass on the debug build: `bun-lock` (317, with `--timeout
120000`), `bun-audit` (241), `bun-dedupe` (82), `bun-prune` (158), the `outdated` tests (38),
`bun-publish` (213), `bun-pm` (122), `bun-pack` (292), `bun-install-git-deps` (113),
`bun-install-offline` (11), `run_command` (22), `escapeHTML` (21), `worker_threads` (153),
`bun-server` (82) and `perf_hooks` (16). The bun-types test (22) and the source lints (182) pass
with the released binary. The three workflows of the fork were green on the push of the other run.

Files: `packages/bun-usockets/src/eventing/epoll_kqueue.c`,
`packages/bun-usockets/src/eventing/libuv.c`, `packages/bun-usockets/src/internal/loop_data.h`,
`packages/bun-usockets/src/libusockets.h` (`us_loop_idle_time`), `src/uws_sys/InternalLoopData.rs`,
`src/uws_sys/Loop.rs` (`idle_time`), `src/runtime/node/node_perf_hooks_binding.rs` (new),
`src/runtime/node.rs`, `src/codegen/generate-js2native.ts`, `src/js/node/perf_hooks.ts`,
`docs/runtime/nodejs-compat.mdx`, `test/js/node/perf_hooks/perf_hooks.test.ts`,
`test/js/node/test/parallel/test-perf-hooks-eventlooputilization.js` (new, from Node.js).

### 2026-10-15: `bun pm sbom`, a software bill of materials from `bun.lock`

A software bill of materials (SBOM) lists what a project ships: every package with its version,
its hash, its license and the packages it depends on. Vulnerability scanners such as Grype, Trivy
and Dependency-Track read one instead of the project, and more and more customers ask a vendor for
one. npm has `npm sbom`. A Bun project had no `package-lock.json` to run it on, so it needed a
third-party generator that can read `bun.lock`. oven-sh/bun#8483 asks for the command. Now:

```sh
bun pm sbom > bom.json                            # CycloneDX 1.6
bun pm sbom --sbom-format spdx > bom.spdx.json    # SPDX 2.3
bun pm sbom --production --sbom-type application  # what the deployed application has
```

```json
{
  "bom-ref": "path-parse@1.0.6",
  "type": "library",
  "name": "path-parse",
  "version": "1.0.6",
  "scope": "required",
  "description": "Node.js path.parse() ponyfill",
  "authors": [{ "name": "Javier Blanco" }],
  "licenses": [{ "license": { "id": "MIT" } }],
  "purl": "pkg:npm/path-parse@1.0.6",
  "hashes": [
    { "alg": "SHA-512", "content": "19298e4f611b1eb20d05ff5247b08310…" }
  ],
  "externalReferences": [
    {
      "type": "distribution",
      "url": "https://registry.npmjs.org/path-parse/-/path-parse-1.0.6.tgz"
    },
    { "type": "vcs", "url": "https://github.com/jbgutierrez/path-parse.git" }
  ],
  "properties": [
    { "name": "cdx:npm:package:path", "value": "node_modules/path-parse" }
  ]
}
```

What is in the document, and where it comes from:

- The packages are the ones that `bun install` with the same flags links on this machine. The
  command uses the walk of `bun install --production` and `bun pm licenses`
  (`lockfile::reachable`), so `--production`, `--omit`, `--cpu` and `--os` mean what they mean
  there. In a workspace package, the document is about that package and what it depends on.
- Name, version, hash, tarball URL and the dependency graph come from `bun.lock`. The command works
  without `node_modules`. Without a `bun.lock` it reads the lockfile of npm, yarn or pnpm, as
  `bun install` does, and writes nothing.
- License, author, description, homepage, repository and issue tracker come from the `package.json`
  of each installed package, through the lookup of `bun pm licenses` (hoisted tree, isolated store).
  Without `node_modules` the document has none of these, a warning on stderr says so, and the
  document carries `"phase": "pre-build"`.
- A license is classified with the SPDX license list 3.29.0, which is the list of the CycloneDX 1.6
  schema: an identifier in the spelling of the list (`mit` becomes `MIT`), a valid SPDX expression
  (`(MIT OR Apache-2.0)`), or a name for any other text (`SEE LICENSE IN LICENSE.md`). The list is
  a text file in the binary (740 licenses and 86 exceptions, 11,107 bytes).
- The package URL is `pkg:npm/...`. A git dependency has `?vcs_url=`, a tarball URL has
  `?download_url=`, a private workspace has none. The repository of a git dependency is the https
  form that `bun install` clones from first (`Repository::try_https`).
- The user name and the password of a URL in `bun.lock` are not written to the document. A
  tarball dependency on `https://user:token@host/pkg.tgz` would put the token into a file that is
  made to be handed to other people.
- Scope and relationships follow `npm sbom`: a package that only `devDependencies` lead to has the
  property `cdx:npm:package:development`, a package that only `optionalDependencies` or optional
  peers lead to has the scope `optional`, and so has one that `devDependencies` lead to one way and
  `optionalDependencies` another way. SPDX has `DEPENDS_ON`, `DEV_DEPENDENCY_OF`,
  `OPTIONAL_DEPENDENCY_OF` and `HAS_PREREQUISITE` (a peer). When two dependencies of one package
  lead to the same package, the stronger one stands.
- `--sbom-format` and `--sbom-type` have the names and values of `npm sbom`, so a script written
  for npm works.

How it was checked:

- The documents of eleven projects, one of them with 799 components from the public registry,
  validate against the official JSON schemas of CycloneDX 1.6 and SPDX 2.3. The validator was ajv.
  Its `iri-reference` format takes registered schemes only, so `git+https:` fails it. The check
  used the RFC 3986 pattern of ajv-formats in its place.
- The embedded list was compared with the `license.id` enum of the CycloneDX schema: 826
  identifiers, no difference.
- For four projects whose dev, optional and peer dependencies overlap, the components, their
  scopes, the development property and the dependency edges are the same as in `npm sbom` 11.16.0.
- With `--omit`, the two differ on those projects. npm filters with a query selector and leaves
  out a direct devDependency that an installed package depends on too, although
  `npm install --omit=dev` installs it. `bun pm sbom` with a flag lists what `bun install` with
  that flag links. That was compared with `node_modules` for both linkers and five sets of flags:
  40 runs, no difference.
- The 22 tests in the repository do not depend on the schemas or on npm. They compare whole
  documents by value.

An open upstream pull request, oven-sh/bun#29512, adds a command of the same name. It was opened
on 2026-04-20 by the account that maintains this fork, has no review from a maintainer and
conflicts with `main`. It was found after this commit was written, and the two share no code. That
one reads `bun.lock` only, so its documents have no license, author or description. It lists every
package of the lockfile, has the flags `--format` and `-o`, writes CycloneDX 1.7 and gives
devDependencies the scope `excluded`. Its 67 review threads were read as a checklist for this
commit. What they found there is handled and tested here: the scope of a package that a dev path
and an optional path lead to, optional peers, two edges to one package, unique identifiers after
the SPDX character rules, the percent-encoding of versions, and a run from a workspace directory.

Costs for the commands that do not use it: two entries in the flag table of `bun pm`, and the
license list and the code in the binary. The size of the code was not measured, no release build
was made. `bun pm licenses` shares its `package.json` lookup now (`InstalledPackages`); its 82
tests pass unchanged.

Not done: no `--filter` (the command refuses it, as every `bun pm` command but `licenses` does),
no `-o` (the document goes to stdout), no CycloneDX XML, no SPDX 3. Licenses come from
`package.json` only, not from `LICENSE` files. A `file:` dependency that is not private gets a
`pkg:npm` package URL, as in `npm sbom`, although it may not be that npm package. A failed write to
stdout is not reported, as in every `bun pm` command. Not run on Windows or macOS. No design or
self-review workflow ran for this commit, because the shared GitHub token was at its rate limit
during the run. Three local review passes read the diff instead, and their findings are in the
commit: credentials in URLs, a depth limit for the license parser, stricter URL checks, the https
form of git URLs, and the line endings of the embedded list.

Notes on the day: three runs worked on this day, and the two entries above have the notes of the
other two. This run was started by hand, rebased the stack on its own, and found their pushes when
it fetched. It took their stack as it is, rebased it onto the one commit that upstream `main` has
gained since (a407eae88a, no conflicts), and put this commit on top. Its own port of the patch of
2026-09-25 is not used. The two ports differ in one piece of code, which this push adds to the
pushed one: when the sides of a conflicted lockfile cannot be merged, `load_conflicted` takes back
the `npm:` aliases that the package manager recorded while it read the sides. No test covers that
path. `cargo clippy --workspace` showed nine errors of upstream's lint level in seven patches:
`--watch-path`, `testMatch`, `collectCoverageFrom`, `globalName`, `kill()` for `$`, the HTML
coverage reporter and the patch of 2026-09-25. The lint job of upstream runs on pull requests only,
so this fork had never run it. Each one is fixed in the commit it belongs to, and the workspace is
clean now. One test of the `kill()` patch failed in two of five runs: it counted one file descriptor
fewer after its rounds than before them. Its first count is taken after a collection now, as its
second one is, and 20 runs passed.

Files: `src/runtime/cli/pm_sbom_command.rs` (new), `src/runtime/cli/spdx-license-ids.txt` (new),
`src/runtime/cli/pm_licenses_command.rs` (`InstalledPackages`, `PackageInfo` with `repository`,
`bugs`, `private`), `src/runtime/cli/package_manager_command.rs`, `src/runtime/cli/mod.rs`,
`src/install/PackageManager/CommandLineArguments.rs` (`--sbom-format`, `--sbom-type`),
`src/install/PackageManager.rs` (help), `src/install/lockfile/reachable.rs` (`edges_from`),
`src/install/lockfile/Package/Meta.rs` (`integrity()`), `src/install/integrity.rs` and
`src/install/resolution.rs` (visibility), `src/runtime/shell/builtin/ls.rs` (`civil_from_days` is
`pub(crate)`), `.gitattributes`, `docs/pm/cli/pm.mdx`, `completions/bun.{zsh,bash,fish}`,
`completions/bun-cli.json`, `test/cli/install/bun-pm-sbom.test.ts` (new).

### 2026-10-16: `while` and `until` loops in Bun Shell

Bun Shell got `for` on 2026-09-23, and that entry ended with "`while` and `until` are not supported
yet". They are the loops a script uses when it does not know how often it has to go around: wait
until a server answers, run a flaky step again until it passes, poll for a file.
`` $`until curl -sf localhost:3000; do sleep 1; done` `` answered `bun: command not found: until`,
then the same for `do` and `done`, and a `package.json` script with such a loop worked on Linux and
macOS, where `bun run` hands it to `sh`, and failed on Windows, where `bun run` uses Bun Shell. Now:

```ts
import { $ } from "bun";

// wait for a server to come up
await $`
  until curl -sf http://localhost:3000/health; do
    echo waiting for the server
    sleep 1
  done
`;

// run a flaky command again until it passes
await $`until bun test integration.test.ts; do echo "failed, trying again"; done`;

// an endless loop with a way out
await $`
  while true; do
    bun run sync.ts && break
    echo "sync failed, next attempt in 5 seconds"
    sleep 5
  done
`;
```

```json
{
  "scripts": {
    "test:retry": "until bun test; do echo retrying; done"
  }
}
```

`while` runs its body for as long as the condition exits with 0, `until` for as long as it does
not. The condition is a list of commands like the one of `if`, so it can be a program, a `[[ ]]`
test, a pipeline or several commands, of which the last one decides. The loop exits with the status
of the last command its body ran, or 0 if the body never ran. It can be a member of a pipeline, an
operand of `&&` and `||`, the condition of an `if`, and it nests with `for` and with itself.
`break [n]` and `continue [n]` work in the body and, as in bash, in the condition.

Every test script that bash can run (38 of them) was run in bash 5.2 first, and the test expects
what bash printed. The one difference is the text of the warning for a `break` outside a loop, which
the `for` patch chose. The cases that are not obvious are all about a `break` or `continue` in the
condition, and they follow from how bash's `execute_while_or_until` is written:

- The condition is inside the loop, so `break` there ends the loop and does not warn.
- `continue` in the condition starts the next round. `while continue; do ...; done` never ends.
- A condition that ends the loop uses the jump up, whichever it is: `until continue; do ...; done`
  ends at once, because `continue` succeeds and a condition that succeeds ends an `until`.
- Otherwise the body counts as run with the status the condition left, which is why
  `while break 0; ...` exits with 0 and `until break 0; ...` with 1.

How it is built:

- Parser. `while` and `until` join the reserved words of `if` and `for` (`IfClauseTok`), so they
  are only reserved where a command can start (`echo while until` prints both), and an interpolated
  `${"until"}` is data. The clause is two statement lists, parsed with the function that parses the
  lists of `if`. An empty condition, an empty body, a missing `do` or `done` and `done > file` are
  parse errors that say what is expected. Loops nest by recursion in this parser, so more than 128
  of them inside each other (`for` included) are a parse error and not a stack overflow.
- Interpreter. A `While` state next to `For`: run the statements of the condition, look at the
  status of the last one, run the statements of the body, go around. `until` is the same state
  with the test inverted. It takes the `LoopJump` that `break` and `continue` leave in the shell
  environment the way `For` does, plus the rules above for a jump that arrives from the condition.
  A statement without a command (`;;`) has no status, so it cannot decide the loop.
- A reader that is gone. bash dies of SIGPIPE when `while true; do echo y; done | head -n 3` writes
  its fourth line. Bun Shell runs `echo` in its own process, where the write only fails, and a loop
  without an end would go on failing for good. So a loop, `for` too, ends when a builtin in it has
  written to a stdout or stderr that nothing reads any more (`IOWriter` already knew).
- The event loop. A loop of builtins never waits for anything, and `while true; do true; done`
  would keep the thread for good: no timer, no I/O, no `.kill()`. Loops give the event loop a turn
  every 128 rounds through the task `for` already used.

The diff then went through an adversarial review: four readers with bash as the reference and the
ASAN build, one each for semantics, the state machine, the parser, and the tests and docs. It ran
600 generated scripts against bash without a difference in what the loops do, and it found what the
tests had not. All of this is fixed in this commit or, where `for` had the same fault since
2026-09-23, in the `for` patch:

- The dead reader above: the first version never ended in `| head`.
- `bun script.sh` and `bun run` use a small event loop of their own that only polls when no task is
  queued, and a loop that puts itself back every 128 rounds is always queued. Other pipeline
  members stalled, children that had exited were not reaped and Ctrl+C was swallowed. The task now
  polls before it queues itself. The test is a loop of builtins that can only end once the other
  side of its pipeline has seen a program exit.
- The 128 rounds were counted per loop, so loops nested with fewer rounds each never gave the event
  loop a turn: 200,000 rounds ran to their end inside `.run()` and a `.kill()` after 100 ms did
  nothing. The count is one per script now.
- A compound command that is a pipeline member (`( ... ) | cat`, a loop, an `if`) starts outside of
  every loop in bash, so `break` in it warns and a count stops at the member. Only a simple
  `break | cat` stays silent. `for` had counted the loops around the pipeline for both.
- One of the new tests was a race between `setImmediate` and a `stat` on the thread pool and failed
  6 to 10 of 60 reruns. It is deterministic now, and the tests that used `while true` where the end
  was not the point count to a bound, so a regression fails an assertion and does not hang.

The review also hit faults of upstream's shell that this change makes easier to meet. They
reproduce on released bun, so they are upstream's to fix and are not patched in this stack: a tab
is not whitespace for the lexer (a tab-indented loop body is `command not found`), a `# comment` at
the end of a line swallows the newline, a newline after `&&`, `||` or `|` is a parse error,
``x=`cmd` `` is broken, a reserved word right after a compound command is taken for a command
(`fi done` needs a `;`, and `done extra` runs `extra`), and a second builtin that reads the same
pipe waits forever (`seq 1 5 | while ...; do head -n 1; done`).

Found on 2026-10-18. The run that started on the evening of 2026-10-15 built these loops a second
time, did not know of this entry, and never pushed: its self-review took 58 hours and sent the
commit back. Three of the review's findings are about this implementation as well. All three were
confirmed on a debug build of this stack, and the first one is fixed:

- Two loops in one pipeline could hold each other back. A loop that comes back from its turn of the
  event loop asked the count of the script again, and a loop on the other side of the pipe could
  have filled it in the meantime by counting its 128 rounds and then waiting for a write. The
  script below printed its three `pass` lines after the forty others, with stderr on a pipe, under
  `bun exec` and from `$`. bash prints them in between. The count now starts again when a loop
  comes back (`Interpreter::loop_round_resumed`, in the `for` patch), and under `bun exec` the
  lines are the 3rd, 5th and 7th. The test is in `for_loop` and fails without the change.

  ```sh
  for a in $(seq 1 40); do for j in $(seq 1 127); do true; done; echo a$a 1>&2; done |
    for i in 1 2 3; do echo pass$i 1>&2; done
  ```

- With a loop that has no end, two of the lexer faults named above are no longer an error message.
  They are a script that never ends. A body that is indented with a tab,
  `while true; do<newline><tab>break<newline>done`, looks up `\tbreak` for good, and a body line
  `echo once # note` before `break` runs `echo once break` for good. bash ends both. So does the
  released 1.4.2, which prints its errors and goes on. The fixes are open upstream as
  oven-sh/bun#43861 and oven-sh/bun#41468 and are not in this stack. Until they land, a `while true`
  in a script file needs spaces for its indent and comments on lines of their own, and the docs
  say so now.
- `while ! cmd; do ...; done && next` prints `command not found: !` once, ends the loop with 0 and
  runs `next`. The released 1.4.2 fails with 1 there, and bash waits. Bun Shell has no `!`, and
  oven-sh/bun#43922 (open) makes it a parse error. The docs now say to write `until cmd`.

The same push repairs the `bun-types` workflow of the fork, which was red since the push of
2026-10-18. A new test of upstream (oven-sh/bun#45794) lists every bindgen schema next to the type
that `bun-types` publishes for it. Three schemas of this stack were missing from the list:
`CSVObject.bind.ts`, `INIObject.bind.ts` and `node_sea.bind.ts`. Each of the three patches adds its
line now, and the test passes with the released binary (24 of 24).

Not done: arithmetic expansion (`$((i + 1))`) and `read`, which the other classic `while` loops are
made of (`for i in $(seq 1 10)` covers the counting ones), and redirecting a whole loop
(`done < file`), which is a parse error that says so, as it is for `for`. `exit` does not leave a
loop: in Bun Shell it ends only its own command, on purpose, so `while true; do ...; exit 1; done`
never ends, and the docs say to use `break`. `sleep` is not a builtin, so the delay in a polling
loop is the program of the system, and Windows has none: the docs say to run
`bun -e "await Bun.sleep(1000)"` there. A `sleep` builtin is the obvious next step.

Rebase notes: upstream moved 15 commits, and three of them reached into the stack:
oven-sh/bun#45104 (one bindgen for everything), oven-sh/bun#45307 (fixes after the package manager
consolidation, with a new git runner and a new pack flow) and the WebKit upgrade of
oven-sh/bun#45303. 13 of the 53 patches needed a hand, 9 for conflicts and 4 more to compile:

- `ignore` for `Bun.Glob`: the scan options are a bindgen schema now (`Glob.bind.ts`), so `ignore`
  is a union of a string and an array of strings there and the Rust side gets it converted. The
  type error is bindgen's (`ERR_INVALID_ARG_TYPE`, "GlobScanOptions.ignore must be of type string
  or array of string"), and the test expects that text.
- zip in `Bun.Archive`: upstream gave the tar reader an `npm` mode and rewrote the read loops, so
  `open_read` takes both flags. A new upstream test (a tar hard link whose header states a size has
  no bytes) showed that "read every entry to its end" was too much: a reader now reads to the end
  only when the header states a size above 0 or no size at all, which is the streamed zip case the
  rule was for (`Entry::size_is_set`). `extract()` with a glob is upstream's code again plus that
  test.
- `publishConfig` overrides: `pack()` now lists the files before it edits a copy of the manifest.
  The overrides are applied to a copy before the listing as well, so an overriding `bin` is still
  the one that is packed. A workspace that is packed as a bundled dependency gets its own overrides
  (new test).
- `#semver:` for git dependencies: the `Tags` step is back in upstream's new git runner, and a
  `github:` dependency waits for its tags with upstream's `wait_for_remote_task`.
- `bun pm sbom`: upstream's `bun pm licenses` now lists a package whose installed copy has another
  version, so the shared `InstalledPackages` hands that copy back too (`read_or_other_version`)
  and `sbom` keeps asking for the locked version.
- Merged `bun.lock`, `engines.bun`, `import.meta.glob()` and `eventLoopUtilization()`: context
  only. The first also needed its field in a new `LoadResultOk` initializer.
- Trusted publishing: `AsyncHTTP::init_sync` has a proxy settings argument.
- `collectCoverageFrom` and `Bun.msgpack`, for the new WebKit: `VM::clearSourceProviderCaches()` is
  gone (the map is cleared directly), and `Latin1Character` is a type of its own (`byteCast`).

After the rebase the tests of these 13 patches pass, and so do the other test files of the stack
that were run (shell, bundler, Web Storage, Web Locks, EventSource, `Bun.Queue`, JWT, CSV, INI,
S3 metadata, watch, coverage, `bun pm`, `bun outdated --json`, SOCKS5, sqlite functions, streams).
What does not pass is the machine: six recursive scans of the repository in `scan.test.ts`, one
`bun pm pack` lifecycle test under load and two source lints of the new type checker's parser run
out of their 5 or 30 seconds in the debug build and pass alone or with a longer timeout,
`test/cli/install/semver.test.ts` cannot load the `semver` package this checkout never installed,
and `sql-debug.test.ts` has no MySQL login here.

Files: `src/runtime/shell/states/While.rs` (new), `src/runtime/shell/states/For.rs`,
`src/runtime/shell/states/Pipeline.rs`, `src/runtime/shell/states/Async.rs`,
`src/runtime/shell/interpreter.rs`, `src/runtime/shell/mod.rs`, `src/runtime/shell/IO.rs` and
`src/runtime/shell/IOWriter.rs` (`has_broken_pipe`), `src/runtime/shell/builtin/break_continue.rs`
(comment), `src/shell_parser/parse.rs`, `src/shell_parser/json_fmt.rs`, `docs/runtime/shell.mdx`,
`test/js/bun/shell/bunshell.test.ts`, `test/js/bun/shell/parse.test.ts`,
`test/js/bun/shell/leak.test.ts`. In the `for` patch: `src/runtime/shell/dispatch_tasks.rs`,
`src/runtime/shell/interpreter.rs` (`loop_round_should_yield`), `src/runtime/shell/states/For.rs`,
`src/runtime/shell/states/Pipeline.rs`, `src/shell_parser/parse.rs` and its tests.

### 2026-10-17: optional route parameters for `Bun.serve`, `"/users/:id?"`

A route of `Bun.serve` takes parameters (`/users/:id`) and wildcards (`/files/*`), and a parameter
was always required. A list with pages, a page with an optional locale in front, or a collection
and its items under one handler took two keys with the same value, `"/posts"` and `"/posts/:page"`,
and then the handler was typed for neither of them. Hono, Elysia, Fastify and Express 4 write this
as `:page?`. In Bun that key was accepted and did something else: it declared a parameter whose
name is `page?`, so `/posts/2` answered with `req.params["page?"]` and `/posts` was not matched at
all. oven-sh/bun#17491 asks for the `?`. Now:

```ts
Bun.serve({
  routes: {
    // GET /posts    -> page 1
    // GET /posts/3  -> page 3
    "/posts/:page?": req => {
      // req.params.page is string | undefined
      const page = Number(req.params.page ?? 1);
      return Response.json({ page });
    },

    // GET /docs/routing     -> { page: "routing" }
    // GET /de/docs/routing  -> { lang: "de", page: "routing" }
    "/:lang?/docs/:page": req => Response.json(req.params),

    // every kind of route value
    "/items/:id?": { GET: listOrGet, POST: createOrReplace },
    "/dashboard/:tab?": dashboardHtml,
    "/legacy/:anything?": false,
  },
});
```

A segment that is a parameter name followed by `?` can be left out of the request, together with
the `/` in front of it. The parameter is then not a key of `req.params`, so `req.params.page` is
`undefined` and `"page" in req.params` is `false`.

It is done where the `routes` object is read, not in the router. `"/posts/:page?"` is replaced by
the paths it stands for, `"/posts/:page"` and `"/posts"`, and each of them goes on exactly as a key
that was written out: the same handler, method object, static `Response`, HTML import or `false`,
the same validation of the parameter names, and its own cached structure for `req.params`. The
router and the request path are not touched, so a server without such a route does one scan of
each route key for a `?` when it starts, and nothing per request. What follows from the expansion:

- The expanded routes rank like any other route. `"/posts/new"` wins over `"/posts/:page?"`, and a
  wildcard `"/posts/*"` only gets what neither of the two paths matches.
- A trailing slash is not optional: `"/posts/:page?"` does not match `/posts/`, because `"/posts"`
  does not.
- Several optional parameters are allowed, anywhere in the path. `"/a/:x?/b/:y?"` is four paths.
  Where two of the paths would match the same requests, as `/files/:dir` and `/files/:name` of
  `"/files/:dir?/:name?"` do, the one that fills the leftmost parameter is kept, which is what the
  pattern means when it is read as a regular expression (Express 4). So `/files/a` sets `dir`.
- A route can have 8 optional parameters, which is at most 256 paths. A ninth is an error when the
  server starts.
- Only a `?` that ends a parameter segment is read. `"/x/:id?.json"` and a `?` in a segment that
  is not a parameter mean what they meant before.
- A key that declares one of the expanded paths again for the same method is a duplicate like
  `"/a/:x"` next to `"/a/:y"`, and as there the key that comes later in `routes` wins. Keys for
  different methods do not collide: `"/posts": { POST }` and `"/posts/:id?": { GET }` both work.

`BunRequest<"/posts/:page?">` and the inferred type of a handler's `req.params` now have `page` as
an optional key (`{ page?: string }`). Before, the key of the type was `"page?"`.

Not done: a `?` does not make a wildcard or a fixed segment optional, and there is no syntax for a
default value or for a pattern the parameter has to match.

Rebase notes: upstream #45450 moved eighteen `Bun.*` functions to the bindings generator, and with
it `Bun.semver`, `Bun.CSRF` and `Bun.unsafe` became generated namespaces. Five patches needed a
hand merge:

- `Bun.semver.parse()` and `Bun.semver.inc()`, `maxSatisfying()`, `minSatisfying()`: the table of
  host functions these patches extended is gone, so the four functions are now entries of the
  `semver` namespace in `SemverObject.bind.ts`, with `capability: "js"` and `returns: b.any`. The
  version of `parse()` and `inc()` and the range of the two searches are declared as strings and
  arrive converted. `release`, `identifier`, `identifierBase` and `versions` stay `b.any`, because
  the functions check them by hand and the tests hold the wording of those errors. One thing a
  caller can see: a string argument is now converted before the other arguments are checked, so
  `maxSatisfying("1.2.3", Symbol())` throws for the symbol and no longer for the first argument.
  Upstream's new test of the shape of `Bun.semver` lists the four functions as well.
- `Bun.CSV`, `Bun.JWT` and `Bun.unescapeHTML()`: their lines in `BunObject.cpp`,
  `BunObject+exports.h` and `BunObject.rs` sat next to lines of `CSRF`, `allocUnsafe`, `unsafe` and
  `which` that upstream rewrote or removed.

One patch merged cleanly and did not compile: response compression for `Bun.serve` named the field
`IntegerRange::always_allow_zero`, which upstream removed with its last user.

After the rebase the test files of these six patches pass, `test/cli/install/semver.test.ts`
included (484 tests; the checkout has the `semver` package now). So do the other files of the
stack that were run because upstream changed code near them: watch mode, `legalComments` and
`globalName` of the bundler, the bytes loader, `eventLoopUtilization()`, `expect.poll()`, `%c`,
`bun serve`, `bun pm sbom`, `Bun.Queue`, `Bun.INI` and the shell. `cargo clippy` is clean for
`bun_runtime` and `bun_semver_jsc`. In `test/internal/source-lints/` the two recursion lints of the
type checker's parser still run out of their 5 seconds in the debug build, as on the days before.

Files: `src/runtime/server/ServerConfig.rs` (`expand_optional_route_params`),
`packages/bun-types/serve.d.ts` (`Serve.ExtractRouteParams`, `Serve.RouteParam`),
`docs/runtime/http/routing.mdx`, `test/js/bun/http/bun-serve-routes.test.ts`,
`test/integration/bun-types/fixture/serve.ts`.

### 2026-10-17: `--filter '[rev]'`, the workspaces changed since a git revision

A monorepo could not run a script only where a branch changed something. `bun --filter '*' test`
runs every workspace, so the CI of a repository with 40 packages runs 40 test suites for a pull
request that touches one. pnpm, Turborepo, Nx and Lerna each have an answer. oven-sh/bun#27943 asks
for one as `bun run --affected`, and its latest comment, from a repository that uses only Bun,
calls it "the one piece we would otherwise adopt Turborepo or Nx for". Today `bun run --affected
test` runs `test` in the current package and says nothing about the flag it dropped. Now:

```sh
# test what this branch changed, and what depends on it
bun --filter '...[origin/main]' test

# build the workspaces with a change in the working tree and what they depend on, in dependency order
bun --filter '[HEAD]...' build

# lint everything that did not change
bun --filter '![origin/main]' lint

# every command that takes --filter takes it
bun outdated --filter '[v1.2.0]'
bun publish --filter '[v1.2.0]'
```

```yaml
# .github/workflows/test.yml, for pull requests
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
- uses: oven-sh/setup-bun@v2
- run: bun install --frozen-lockfile
- run: bun run --if-present --filter "...[origin/$BASE]" test
  env:
    BASE: ${{ github.base_ref }}
```

It is pnpm's `[<since>]` selector, next to the `{dir}` and `...` selectors that upstream took from
pnpm in oven-sh/bun#38333. `<rev>` is anything git resolves to a commit. What "changed" means:

- The working tree against the merge base of `<rev>` and `HEAD`. Commits of the branch, staged
  changes and plain edits count. So does a deleted file, and a file that moved counts for the
  workspace it left too (git runs with `--no-renames`, or that one would not be listed). A commit
  that only `<rev>` has does not count, so `[main]` keeps its meaning when `main` gets new commits.
- Untracked files that git does not ignore.
- A file belongs to the deepest workspace that contains it. A `package.json` without a name (the
  `{"type": "module"}` inside a package) is not selected, as it is not by `*`, and leaves its files
  to the workspace around it.
- `...[rev]` adds the dependents, `[rev]...` the dependencies, `^` leaves the changed ones out, `!`
  subtracts, and several patterns unite, as for every other selector.

Why a selector and not the flag of the issue. A design check ran before the code. It compared six
shapes, the reporter's own pull request among them (oven-sh/bun#27944: `--affected`, `--base`,
`--head` and `--list` on `bun run`, written in Zig and closed by the stale sweep after the Rust
rewrite, without a review). It also ran pnpm 12.14.0, Turborepo 2.11.8, Nx 23.3.0 and Lerna 10.1.1
on scratch repositories behind a `git` that logs its arguments. What decided it:

- `workspace_selection::parse()` is the one function that all twelve `--filter` entry points
  reach: `bun run` and its `--parallel` and `--sequential` forms, install, add, remove, update with
  and without names, `update -i`, outdated, prune, publish and `pm licenses`. One arm there gives
  the selector to all of them. A flag on `bun run` reaches two.
- A flag is a row in the table that every `bun <file>` start looks flags up in. The selector adds
  no row. Without `[...]` in a pattern it costs one byte compare in `parse()` and one branch in
  `select()`.
- `--base` and `--head` would become top-level flags of `bun`, and a default base (`main`?
  `origin/main`?) is a guess that is wrong in a fresh CI clone.

The price is a change to the filter grammar, and it is the question for upstream. A filter that is
only a bracket class, such as `--filter '[ab]'`, is a glob over one-letter package names today and
a git revision after this commit. It fails loudly (`git has no commit "ab"`, with a note that says
what brackets mean now) unless the repository has a ref of that name. oven-sh/bun#38333 made the
same cut for a whole-pattern `{...}`. Brackets inside a longer glob (`'pkg-[ab]'`, `'[ab]*'`,
`'[ab][cd]'`) are classes as before, and a test pins that. pnpm also has `{dir}[rev]` and
`name[rev]`. Neither is in this commit: `name[rev]` can never be told from `pkg-[ab]`, and
`{dir}[rev]` would change what `{x}[y]` means a second time, so it is better decided together with
the first cut.

How it is built:

- `changed_since.rs` (new, in `bun_install` next to the selection code) asks git with three
  processes for each distinct `<rev>`. `git rev-parse` with `--is-shallow-repository --show-cdup`
  and `<rev>...HEAD` prints whether the clone is shallow, the way up to the top of the work tree
  and, as its `^` lines, the merge base. `git diff` with `--name-only -z --no-renames` and the
  merge base lists what differs in the working tree. `git ls-files --others --exclude-standard -z`,
  run from the top, lists the untracked files of the whole work tree. The paths are joined onto
  the workspace root, so they compare byte for byte with the workspace directories whatever
  `git rev-parse --show-toplevel` would spell.
- git runs in the workspace root, not in the directory the command was started in. A member can be
  a submodule or hold a vendored clone, and from inside of it another repository would answer.
- The answer is kept for the process. `bun update <glob> --filter` selects twice, and
  `bun update -i` selects again after it has written a `package.json`. Both have to see the same
  workspaces.
- The text between the brackets is checked before any process starts: a leading `-`, `^` or `:`,
  a `..` and an empty revision are errors that repeat the pattern, so no option reaches git. The
  `diff` does not follow the user's `diff.relative`, `diff.autoRefreshIndex` or submodule
  settings, and no pathspec is used, so `GIT_LITERAL_PATHSPECS` changes nothing. A warning of git
  about the revision (a name that is both a tag and a branch) is passed on.
- A missing merge base is an error. pnpm and Nx fall back to `<rev>` itself there, which makes the
  selection depend on the depth of the clone, and these workspaces are what `bun add` and
  `bun publish` then write to. git missing, no repository, an unknown revision and a `HEAD`
  without a commit each have their own message. All of them exit with 1 before anything runs.
- A shallow clone can have a merge base that is the wrong one: an older common ancestor that a
  merged side branch still reaches, while the real one is behind a commit that was cut off. So in
  a shallow clone a merge base counts when it is `<rev>` or `HEAD` itself (an annotated tag is
  the commit it names), or when it is the only one and every commit between it and the two has
  its parents (one more process, `git rev-list --parents`, only in that case). Everything else is
  an error with a note about `git fetch --unshallow`. That refuses clones that would have been
  right: a depth that reaches the point where the branch left is not enough when a side branch
  that was merged later ends in a commit that was cut off, which is what merged pull requests
  look like. The full history always works, and so does `fetch-depth: 2` with `[HEAD^1]` on the
  merge commit that GitHub checks out for a pull request.
- A changed `bun.lock` in the root. For `bun run` it selects every workspace: any of them may
  resolve to other versions, and a pull request that only updates the lockfile must not pass with
  no test run. For the commands that read and write `bun.lock` it is a change of no workspace.
  Otherwise the second `bun add --filter '[main]'` of a branch would write to the root or to every
  `package.json` because the first one changed the lockfile, `bun update --filter '[main]'` would
  rewrite the root's ranges, and `bun publish --filter '[v1.2.0]'` would take the root along.
- A submodule or an untracked nested repository is one path for git. It changes the workspace it
  is, or the workspace it is in, and every workspace inside of it.
- Nothing changed. `bun --filter '[main]' test` on a branch without a change exits with 0, which
  is what a CI step needs, and prints
  `No workspace packages matched the filter "[main]", nothing to run`. A `[rev]` pattern that
  matches nothing is never reported as unmatched, so `bun install` and `bun outdated` stay quiet.
  A name that matches nothing next to it is still an error, and so is a `[rev]` filter when there
  is no workspace to select from (a typo in `"workspaces"`). The commands for which an empty
  selection is documented as an error (add, remove, update, prune, publish, `pm licenses`) still
  exit with 1.
- Upper-case letters in a directory name. `bun run --filter` walked the workspaces through the
  resolver's directory cache and got each name in lower case. On Linux a workspace in
  `packages/Core` made every filtered run fail with `error: FileNotFound`. On macOS and Windows
  the run worked and the directory was spelled `packages/core`, which no path from git matches, so
  a change there would have selected nothing and exited with 0. The walk gets the real name now.
  This is the change of oven-sh/bun#29941, which is open upstream, and the hunk in
  `src/resolver/lib.rs` is its diff unchanged, so it falls out of this patch when that lands. With
  it, a `./path` filter has to spell the directory as the disk does on those two systems.

What it costs those who do not use it, measured with a `git` in front of the real one that logs
each call: no git process on eleven entry points with `--filter a`, three with `--filter '[HEAD]'`,
also for `bun update 'a*' --filter '[HEAD]'`, which selects twice. A test pins both numbers for
`bun run`. The rest is from the code: a `Selector` grows by 16 bytes on the stack, `Selection` by
one `bool`, `select()` by one argument. There is no release build of this commit, so no
instruction counts and no binary size.

The review. Five readers went through the commit before the push, each with one subject (git
semantics, the commands and their selection rules, the Rust, the tests and docs, robustness), and
a second reader tried to refute each finding against the debug build. 39 findings came back and
none was refuted, many of them the same fault seen from two sides. What they changed in this
commit: git ran in the start directory (from a submodule member the selection was empty, with
exit 0); a submodule with workspaces inside selected none of them; a `{"type": "module"}`
`package.json` took the files of its package out of every selection; a typo in `"workspaces"` was
"nothing to run" with exit 0; the wrong merge base in a shallow clone; `diff.ignoreSubmodules`,
`diff.autoRefreshIndex` and `GIT_LITERAL_PATHSPECS` changed the answer; a changed `bun.lock`
selected the root for update and publish; a work tree at `/`; one directory listed by two
`"workspaces"` entries; `[HEAD]` in a repository without a commit blamed a shallow clone; the CI
example pasted `github.base_ref` into the shell line and failed when a changed workspace had no
`test` script. Each fault in the code has a test now, except the work tree at `/`. Three readers
then went through the rework in the same way and found 16 more. One was a wrong answer without
an error: in a shallow clone with two merge bases, the check for missing history passed. One
refused an annotated tag that `HEAD` reaches, because git prints the id of the tag and not of the
commit. Both are fixed and tested. The docs gained `--frozen-lockfile` in the CI example, since an
install that writes `bun.lock` makes the next step run everything. The rest were the note about
shallow clones in a complete one, a Windows detail of a test, sentences in the docs, and the two
cases of `GIT_DIR` and of partial clones that are under "Not done". The full self-review workflow
was not run: it starts with the question whether the change should exist, which the design check
had answered, and asks GitHub a few hundred times on a token that is shared.

Tests. 48 new tests in `test/cli/run/filter-workspace.test.ts` build real repositories: each
relation and combination, staged, deleted, untracked, ignored and moved files, a branch whose
`main` moved on, nested workspaces, a workspace root below the top of the repository, a start
inside another repository, a submodule, a nested repository with workspaces in it, the lockfile
rule, the user's git settings, four shallow clones, the exit code when nothing changed, the error
cases, and the count of git processes. 46 of them fail on the released 1.4.3-canary.1. The two
that pass there are guards: classes inside a longer glob, and the error when there is no workspace
at all. Four more in `test/cli/install/bun-add-filter.test.ts` cover install, add and update
against the local registry, including the second `bun add` after `bun.lock` changed. All four fail
on the released binary. On the debug build: `filter-workspace` (173 pass, 2 Windows-only skips),
`bun-add-filter` (148 pass, 1 skip), the `--filter` tests of `bun-pm-licenses` (7), `bun-prune`
(13) and `bun-update` (43), and `multi-run` (132 with `--timeout 60000`; with the default 5
seconds four tests that never reach the selection ran out of time in the debug build).
`cargo clippy` is clean for `bun_install`, `bun_resolver` and `bun_runtime`.
`bun run rust:check-all x86_64-pc-windows-msvc` passes. The source lints pass with the released
binary (182), as the fork's workflow runs them.

Not done, and not checked:

- `--affected` as a flag, and a way to only list the selection (`--list` in the issue). No
  `--filter` command prints its selection without doing its work, so a CI job matrix still needs a
  script.
- `{dir}[rev]` (above), and a range such as turbo's `[main...HEAD]`: the comparison is always with
  the working tree.
- The lockfile rule is all or nothing. Reading the `bun.lock` of the merge base and selecting only
  the workspaces whose resolved dependencies differ would narrow it. A changed root
  `tsconfig.json` or root `package.json` selects nothing in `bun run`, because nothing says which
  workspaces use them. A changed submodule selects every workspace inside of it, where asking the
  submodule would select fewer.
- A workspace without a name is not selected by a change in it, as it is not by `*`. Under
  `bun add` and `bun remove`, `![rev]` does not take out a root that another pattern named, as
  `!*` does not.
- `bun install --filter '[rev]'` selects after it has resolved, like every filter of install, and
  `--lockfile-only` never selects.
- Windows and macOS were not run. On Windows the three git calls need a uv loop before
  `bun run --filter` has made its own, and `changed_since.rs` keeps one of its own for the
  process. That code is type-checked for the Windows target and nothing more. If the `git` in
  `PATH` is a `.cmd` file there, the revision reaches `cmd.exe`, as it does for
  `bun test --changed`.
- A workspace whose directory is a symlink to a place outside of its parent is compared by the
  path of the link, and git reports the path of the target.
- In a shallow clone, a first commit between the merge base and the two commits looks like a
  commit that was cut off, and more history is asked for. A real criss-cross merge (two merge
  bases) is refused there too.
- git exports `GIT_DIR` without `GIT_WORK_TREE` to a hook, an alias or `git rebase -x` that runs
  in a linked worktree. If the workspace root is below the top of the repository then, git takes
  the root for the top and every workspace is selected. `unset GIT_DIR` in the hook helps.
- In a partial clone (`--filter=blob:none`), `git diff` may fetch blobs from the remote.
- `git diff` may rewrite `.git/index` when it refreshes it, as it does for `bun lint --changed`.

Rebase notes: this run is the timer fire of 2026-10-13, delivered on the 16th. It started on
upstream 5866b5f13d, where the stack of 54 patches already was, so its own rebase was a no-op.
While it worked, the run of the entry above rebased the stack onto upstream b28212a12c (seven
commits later, with a WebKit upgrade and oven-sh/bun#45450) and pushed. This run found that push
when it fetched before its own. It took that stack as it is and put this commit on top. None of
the seven upstream commits touches a file of this patch, and the commit applied without a conflict
outside of this file. It was built again on that base, and the test files named above pass there
with the same counts, as do the source lints, `cargo clippy` and the check for the Windows target.
Upstream has six commits more since (7f3bc6a5e0). The stack is not on them.

Files: `src/install/PackageManager/changed_since.rs` (new),
`src/install/PackageManager/workspace_selection.rs`, `src/install/PackageManager.rs`,
`src/install/PackageManager/add_remove_with_filter.rs`, `src/runtime/cli/filter_arg.rs`,
`src/resolver/lib.rs` (the hunk of oven-sh/bun#29941), `docs/pm/filter.mdx`,
`docs/runtime/index.mdx`, `test/cli/run/filter-workspace.test.ts`,
`test/cli/install/bun-add-filter.test.ts`.

### 2026-10-17: `node:sea`, on top of `bun build --compile`

`node:sea` is the Node.js API of a single executable application: `isSea()` says whether the
program runs as one, and `getAsset()` and its siblings read the files that were packed into it. It
was the one `node:` module that the compatibility page still marked "Not implemented", and it did
not resolve at all, so `import "node:sea"` threw `No such built-in module: node:sea`.
oven-sh/bun#39728 lists it, and a comment there describes the effect: code that imports the module
statically, only to ask `isSea()`, cannot load on Bun. Bun has what the module describes, under
another name: an executable made by `bun build --compile`, with files embedded in it. The module
now exists and answers from that.

```sh
bun build --compile ./cli.ts --asset ./config.json --asset ./templates --outfile mycli
```

```ts
import sea from "node:sea";

if (sea.isSea()) {
  sea.getAssetKeys(); // ["config.json", "templates/page.html"]
  const config = JSON.parse(sea.getAsset("config.json", "utf8"));
  const bytes = sea.getAsset("templates/page.html"); // an ArrayBuffer, a copy
  const page = sea.getAssetAsBlob("templates/page.html"); // a Blob of the bytes in the executable
} else {
  // under `bun run`: the files are on disk
}
```

What it does:

- `isSea()` is `true` in a compiled executable and `false` under `bun run`, the answer that
  `Bun.isStandaloneExecutable` gives.
- An asset is an embedded file, and its key is the name `Bun.embeddedFiles` has for it. A file
  passed to `--asset` is named after its last path component (`config.json`), and a file inside a
  directory passed to `--asset` after that directory and its path inside it
  (`templates/page.html`). A file imported with `with { type: "file" }` is renamed by
  `--asset-naming`, so by default its key carries a content hash, and is the `basename()` of the
  path that the import returns.
- `getAsset(key)` returns a copy in an `ArrayBuffer`, `getAsset(key, encoding)` a string from a
  `TextDecoder`, `getAssetAsBlob(key, options)` a `Blob`, and `getAssetKeys()` the keys in the
  order of `Bun.embeddedFiles`.
- Outside of an executable everything but `isSea()` throws
  `ERR_NOT_IN_SINGLE_EXECUTABLE_APPLICATION`, and a key without an asset throws
  `ERR_SINGLE_EXECUTABLE_APPLICATION_ASSET_NOT_FOUND`. The codes, the messages, the order of the
  checks (the encoding, the key, then whether this is an executable) and the `length` of each
  function were compared with Node.js 26.3.0. The bundled source code is not an asset, which is
  the rule of `Bun.embeddedFiles`.
- The module resolves with the `node:` prefix only, as in Node.js (`sea` is a package on npm),
  and is in `module.builtinModules`.

Where it differs from Node.js:

- There is no `sea-config.json`. What is embedded, and under which name, is what
  `bun build --compile` was told.
- `getRawAsset()` returns a copy. In Node.js it returns the memory of the executable, and its
  documentation warns that a write to it is likely to crash the process. A copy cannot.
- `getAssetAsBlob()` does not copy: the `Blob` shares the bytes in the executable, as the ones in
  `Bun.embeddedFiles` do. Without `options.type` it has the type of the file extension, where
  Node.js has `""`. With one it is `new Blob([blob], options)`, which shares the bytes of a single
  `Blob` part.

How it is built. `src/js/node/sea.ts` is `lib/sea.js` of Node.js. Under it are four functions
declared in `node_sea.bind.ts`, for the bindings generator that `node:os` uses, with their bodies
in `node_sea.rs`. They read the module graph of the executable and not `Bun.embeddedFiles`, which
is an ordinary array that a program can sort, empty or replace. A key is one hash lookup of its
exact bytes, then the rule that keeps source code out of `Bun.embeddedFiles`. The rest is
registration:
`HardcodedModule.rs` (prefix only), the two lists behind `isBuiltin()` and `builtinModules`, and
two error codes. A program that does not import the module runs nothing of it. There is no
release build of this commit, so no binary size.

Tests: `test/js/node/sea/sea.test.ts`, four tests. Three run in the test process: the module is a
builtin under its prefix only, `isSea()` is `false` and the other functions throw, and the
argument checks come first. The fourth compiles an executable with an `--asset` file, an
`--asset` directory and a `type: "file"` import, and compares one JSON document that the
executable prints: the keys, the text, the bytes, a Latin-1 decoding, that writing to a copy does
not reach the next read, the `Blob` with and without a type, an empty file, the errors, and that
the entry point, which is embedded too, is not an asset. All four fail on the released
1.4.3-canary.1, where the import does not resolve. `module-graph-isolation.test.ts` classifies
every builtin module, and lists `node:sea` as the host's, like `Bun.embeddedFiles`.
`node-module-module.test.js` counts `builtinModules`, 77 now.

The review. Two readers went through the work before the commit, one through this module and one
through the two parsers that the rebase ported (below). In this module they found: the test that
counts `builtinModules`; a lookup that normalized the key as a path, which on Windows panics for
a key longer than a path buffer (it is an exact lookup now); an empty asset that lost the `type`
it was asked for, because `Blob.slice()` returns a new empty blob for a size of zero (the `Blob`
constructor is used now); an assertion that could not fail, because it asked for `index.js` and
the entry point is embedded under the name of the executable; and a sentence of the docs about
how `--asset` names a file. The design review and the self-review workflows were not run: both
ask GitHub a few hundred times, and the search API of the shared token was already refusing
requests today.

Not done, and not checked:

- Reading a `sea-config.json`. Its `assets` map (key to path) could feed the embedding, so that a
  Node.js project compiles without naming its assets a second time.
- A `getRawAsset()` without the copy, and `""` as the default type of `getAssetAsBlob()`.
- The tests of Node.js for this module
  (`test/sequential/test-single-executable-application-*.js`) inject a blob into a `node` binary
  with postject. They were not ported.
- Windows and macOS were not run. Nothing in the Rust is specific to a platform, and the bundler
  writes the keys of `--asset` files with `/` on Windows.
- Found on the way and reported, not fixed here: in Bun `new Blob([blob])` with a single part
  keeps the type, the name and the `File`-ness of that part, and `file.slice()` returns a `File`.
  That is why `getAssetAsBlob()` does not build its result with the `Blob` constructor.

Rebase notes: 56 patches onto oven-sh/bun 017b2439a7, 15 commits after the last base. Two of the
15 rewrote code that the stack stands on. oven-sh/bun#45590 declares thirty-five `Bun.*` functions
with the bindings generator and removes the argument helper that `Bun.TOML.parse` and its
siblings shared. oven-sh/bun#45304 rewrites the `Bun.sql` client and much of `bun:sqlite`. Eight
patches stopped the rebase. One is dropped (see [Dropped](#dropped)), seven are resolved:

- `Bun.INI.parse()` and `Bun.CSV` used the removed helper. Both are declared in a `.bind.ts` file
  now, like the five formats next to them, and the error for a missing document is the
  generator's (`input must be a string, ArrayBuffer, ArrayBufferView or Blob`).
  `Bun.CSV.parse()` reads its options before it looks at the bytes and defines its rows where it
  pushed them, so nothing runs JavaScript while the bytes of a buffer are borrowed. Before, an
  options getter did. On the ASAN build, a getter that detaches or shrinks the buffer now gives an
  empty parse, and setters on `Object.prototype` and `Array.prototype` are not called.
- Query logging for `Bun.SQL` hooked two `handle.run()` calls of a file that no longer has them.
  It is ported to the one `runOn()` of the new client, and the option is parsed in
  `internal/sql/options.ts`. Its 22 tests pass against SQLite, PostgreSQL and MariaDB. Two of
  them started seven and four debug processes at a time, and seventeen such processes now take 5
  seconds here (the debug binary grew from 0.8 to 1.2 GB), so those two check the parsed option in
  the test process and start one process each.
- `EventSource`, `Bun.JWT`, `Bun.Queue` and `Bun.msgpack` had changed lines next to theirs
  (`undici.js`, the property table and a deleted function in `BunObject.cpp`).

Running the tests of the stack on the new base, and the second reader, found three faults that
are older than this rebase. Each is fixed in the commit it belongs to:

- `Bun.unescapeHTML` (2026-10-15) was missing from the list in
  `module-graph-isolation.test.ts` that classifies every property of `Bun`, so that test failed.
- `Bun.CSV.parse("a", { header: new Array(2 ** 32 - 1) })`, and `columns` of `stringify()`,
  reserved memory for the length of the array and aborted on a 96 GB allocation. They throw the
  `TypeError` for the first element now, with a test.
- `Bun.INI.parse()` read a `SharedArrayBuffer` in place while the parsed values point into the
  input. A writer on another thread could make the parser panic. The bytes of a shared buffer are
  copied now, as `Bun.TOML.parse()` does.

Seen and not fixed: `Bun.CSV.stringify()` writes a record whose only field is empty as an empty
line, which `parse()` skips by default, so such a row does not come back.

On the new base, with the debug build: `ini` (72), `csv` (54), `sql-debug` (22), `eventsource`
(16), `jwt` (87), `queue` (50), `msgpack` (228), `escapeHTML` (21), `storage` (36),
`wpt-webstorage` (22), `bun-write` (117), `bun-serve-compress` (22), `bun-serve-routes` (73),
`expect-poll` (16), `console-log` (13), `bytes-loader` (6), `s3-metadata` (38), `locks` (36),
`perf_hooks` (16), `static-server` (9), the shell builtins `head`, `tail`, `wc`, `sort` and `uniq`,
`kill` (34), `parse` (32), `bunshell` (599), `import-meta-glob` (36 and 16), `test-last-failed`
(8), `archive` (140), `semver` (484), `bun-pm-sbom` (22), `bun-build-watch` (36),
`filter-workspace` (173), `proxy` (147), `coverage` (65), `bundler_comments` (76), `bundler_iife`
(59), `bundler_loader` (70) and `node-module-module` (73) pass. Three files have failures that are
not the stack's: `glob/scan` (215 pass, 6 tests that walk the whole checkout run into their 30
second limit), `snapshot` (75 pass, 1 upstream test that expects colors in an error message) and
`module-graph-isolation` (338 pass; 74 tests that each start a debug process ran into the 5
second limit while another test file ran next to them, and the two that classify `Bun` and the
builtin modules pass with the fix above). The MariaDB of this container refuses `root` over TCP,
so the MySQL tests of `sql-debug` ran after its local account was changed. The install tests
were not run. The source lints pass with the released binary (182), as the fork's workflow runs
them, the bun-types test passes (23), and `bun run rust:check-all x86_64-pc-windows-msvc` passes.

Files: `src/js/node/sea.ts` (new), `src/runtime/node/node_sea.bind.ts` (new),
`src/runtime/node/node_sea.rs` (new), `src/runtime/node.rs`,
`src/resolve_builtins/HardcodedModule.rs`, `src/jsc/bindings/isBuiltinModule.cpp`,
`src/jsc/modules/NodeModuleModule.cpp`, `src/jsc/bindings/ErrorCode.ts`, `src/js/builtins.d.ts`,
`docs/bundler/executables.mdx`, `docs/runtime/nodejs-compat.mdx`,
`test/js/node/sea/sea.test.ts` (new), `test/js/node/module/node-module-module.test.js`,
`test/js/bun/module-graph/module-graph-isolation.test.ts`.

### 2026-10-18: `jsr:` dependencies

[JSR](https://jsr.io) is the registry of `@std/*`, Hono, Oak and a growing part of the TypeScript
world. pnpm (10.9), Yarn (4.9), vlt and Deno install from it with a `jsr:` specifier in
`package.json`. bun read the same specifier the way it reads `git@github.com:user/repo`, as a git
remote in scp form:

```
$ bun install          # "@std/path": "jsr:^1.0.0"
fatal: unable to access 'https://jsr/^1.0.0/': Could not resolve host: jsr
ssh: Could not resolve hostname jsr: Name or service not known
error: "git clone" for "@std/path" failed
```

so a project that someone set up with pnpm or Yarn and a JSR package did not install, and
`bun add jsr:@std/path` ended the same way. What did work is what JSR's own page says to do for
bun: `bunx jsr add`, which writes the npm alias by hand (`"@std/path": "npm:@jsr/std__path@^1.0.0"`)
and a scope into `bunfig.toml`. Now:

```sh
bun add jsr:@std/path              # "@std/path": "jsr:^1.1.0"
bun add jsr:@std/path@~1.0.0       # "@std/path": "jsr:~1.0.0"
bun add std-path@jsr:@std/path     # "std-path": "jsr:@std/path@^1.1.0", under another name
bun info jsr:@std/path versions
```

```json
{
  "dependencies": {
    "@std/path": "jsr:^1.0.0",
    "hono": "jsr:@hono/hono@^4"
  }
}
```

JSR serves every package to npm clients as `@jsr/<scope>__<name>` from a registry of its own,
`https://npm.jsr.io`. So `jsr:` is a short way to write an `npm:` alias in the `@jsr` scope, and
that is all the package manager makes of it: `jsr:^1.0.0` for `@std/path` is
`npm:@jsr/std__path@^1.0.0`. `jsr:<version>` takes the package from the name of the dependency,
`jsr:@scope/name[@version]` names it, and the version is a version, a range or a dist-tag. A name
without a scope, a name that is none, and a "version" that is a path, a URL or another protocol are
errors that point at the specifier in `package.json`. They are no longer a `git clone`.
`jsr:owner/repo.git`, which cannot be a JSR specifier, stays what it was: a git remote on a host
that is named `jsr`.

What follows from "it is the alias":

- `bun install` takes `jsr:` in every dependency group, in workspace members, in catalogs, as the
  value of an override and in its key (`"@std/path@jsr:^1": "jsr:1.0.8"`), in `packageExtensions`,
  and in the dependencies of another package, from the registry or in a folder (`npm publish`
  publishes the specifier as it is written, so such packages exist). Both linkers,
  `--frozen-lockfile`, and the runtime's auto-install (`bun index.ts` without a `node_modules`)
  work.
- `bun add` writes `jsr:` with the range it would write for any package, `bun update` and
  `bun update --latest` move the range and keep the spelling (also in a catalog),
  `bun add --catalog jsr:...` puts the specifier into the catalog or takes the entry that is
  there, and `bun remove`, `bun info` and `bun pm diff` take `jsr:@scope/name`.
- `bun pm pack` and `bun publish` write the alias into the `package.json` they publish, because
  npm and every older client cannot read `jsr:`. `bun pm diff` compares a folder against a tarball
  or a published version in that form, and two folders as they are written.
- `bun.lock` has the alias, next to the package it resolves to:

  ```jsonc
  "dependencies": { "@std/path": "npm:@jsr/std__path@^1.0.0" },
  // ...
  "@std/path": ["@jsr/std__path@1.1.0", "https://npm.jsr.io/~/11/@jsr/std__path/1.1.0.tgz", { ... }, "sha512-..."],
  ```

- While the default registry is npm's and the `@jsr` scope has no entry, the scope is fetched from
  `https://npm.jsr.io`, as in pnpm and Yarn. That also makes `npm:@jsr/...` aliases work with no
  configuration, which is what `bunx jsr add` needed its `bunfig.toml` entry for. An entry for the
  scope in `bunfig.toml` or `.npmrc` replaces it. With any other default registry nothing changes:
  `@jsr/*` is fetched from that registry like every other scope, and a project there that wants
  JSR says so (`@jsr:registry=...`).

The reference was pnpm 10.18.3, run against the same stand-in for npm.jsr.io that the tests use
(npm.jsr.io itself cannot be reached from the machine this was built on, so nothing here was run
against the real registry). For the same `package.json` the two install the same versions, and
these agree to the letter:

- what `add` writes for `jsr:@std/path`, `jsr:@std/path@1.0.0`, `name@jsr:@std/path` and
  `--save-exact`
- what `update` and `update --latest` leave behind (`jsr:^1.0.0` to `jsr:^1.1.0`,
  `jsr:@std/path@~1.0.0` to `jsr:@std/path@~1.0.8`, a pinned `jsr:1.0.0` untouched without
  `--latest`)
- what `pack` publishes (`npm:@jsr/std__path@^1.0.0`, `npm:@jsr/std__internal` for a specifier
  without a version, `npm:@jsr/std__internal@latest`)
- the two errors for a name without a scope

Two differences are bun's conventions for every package and stay: `bun add name@~1.0.0` keeps the
range as typed where pnpm writes `~1.0.8`, and bun accepts an alias as a peer dependency where
pnpm refuses it. Two more are choices, under "Not done": the registry of the scope when the
default registry is not npm's, and what another package gets that depends on the same name.

How it is built:

- One function, `jsr::stored(name, literal)`, turns a specifier into its alias, and it runs where
  a specifier is read: `package.json` (`Package::parse_with_json`, both the pass that sizes the
  string buffer and the one that fills it), a registry manifest (`Package::from_npm` and the
  look-ahead that asks for the manifests of its dependencies), a catalog, `overrides` and
  `packageExtensions`, `bun.lock`, `pnpm-lock.yaml`, the command line, and the two readers of
  `package.json` that the resolver has for auto-install. After that a `Dependency` holds the
  alias and nothing else, so the resolver, both linkers, hoisting, dedupe, prune, the audit and
  everything else that asks "is this an alias" or looks for `npm:` at the front of a literal
  (some forty places) did not change. The other way around, keeping `jsr:^1.0.0` as the literal
  of the dependency, does not work without a new lockfile format: the name of an aliased package
  is a slice of the buffer the literal is in, `@jsr/std__path` is not a slice of `jsr:^1.0.0`,
  and a lockfile is parsed again from that buffer every time it is loaded or cleaned. The mapping
  is in `bun_install_types`, the crate that the package manager and the resolver share.
- `Tag::infer` has an arm for `jsr:` (a range or a dist-tag, never git), and `parse_with_tag`
  refuses a `jsr:` literal that was not turned into its alias first, so a reader of specifiers
  that this patch missed gets "invalid" and not a clone.
- The edits of `package.json` work on text, and their helper that splits `npm:name@range` now
  also splits `jsr:name@range` and `jsr:range`, which is what keeps the spelling in `bun update`,
  in the form the entry is written in. `bun add jsr:...` is an ordinary request for the alias
  with a flag, and the flag turns the literal back when it is written. Without a version it asks
  for `latest` like `bun add <name>` does: a bare `name@npm:other` does not, it keeps what the
  lockfile has. `bun update jsr:@scope/name` is `bun update @scope/name`.
- `bun pm pack` has a third substitution next to `workspace:` and `catalog:`. Unlike those it
  needs no other `package.json`, so a package with only `jsr:` dependencies does not start to
  read the workspace.
- The registry of the scope is not an entry in the map of scopes. `scope_for_package_name`
  answers with it when the map has no `@jsr` and the default registry is npm's at that moment,
  and makes it when it is first asked. So `--registry`, `publishConfig.registry` and whatever else
  replaces the default registry need no code of their own, no credential of another registry is
  near it, and a process that never looks up an `@jsr` package makes nothing.

The review. Five readers went through the first version, each with the debug build, a stand-in
registry and pnpm: the grammar, the lockfile, the commands that edit `package.json`, the registry
and the other commands, and the tests and docs. They reproduced ten bugs, and two of them changed
the design:

- `bun.lock` kept the specifier as it was written in that version (`"@std/path": "jsr:^1.0.0"`).
  The text came from a list for the whole process that `stored` filled, keyed by the name of the
  dependency and the alias. Rows got the spelling of other rows (two workspaces that spell one
  dependency in two ways, a package of the registry that declares it), and the file depended on
  the order in which things were read: `bun install --force` right after `bun install` rewrote
  it. The list is gone and `bun.lock` has the alias, which is one text for one dependency. What
  that costs is in "Not done".
- The `@jsr` scope had its registry whatever the default registry was, as in pnpm. A project with
  a mirror as its default registry and `@jsr/*` tarballs pinned there in `bun.lock` then asked
  the mirror for them without the mirror's credentials and got a 401, with no `jsr:` anywhere in
  it. A patch must not break a project that does not use it, so the default now stands only in
  place of npm's own registry, which has no `@jsr` packages. An upstream test of the Yarn
  migration that the first version had to change passes again unchanged.
- `bun update <name>` wrote `^<resolved>` over a range that `bun update` keeps (`jsr:1.x`,
  `jsr:>=1.0.0 <2.0.0`, `jsr:*`) and re-spelled `jsr:@scope/name@range` in the short form.
- `bun update jsr:@scope/name` and `bun add --catalog jsr:@scope/name` read the missing version as
  the tag `latest`: the first wrote `jsr:latest`, the second replaced the entry of the catalog
  and moved every workspace that uses it.
- A `jsr:` dependency of a registry package made the look-ahead ask the default registry for the
  name of the dependency (`@std/path`), a package that has nothing to do with it. Auto-install
  did worse for a package in `node_modules`: it installed that other package.
- The loader of `bun.lock` refused a whole lockfile for one `jsr:` row that names no package,
  where the reader of a manifest skips it.
- `bun pm diff` of two folders rewrote `jsr:` on both sides, so a real difference did not show.
- Smaller: a version with an `@` in it was accepted, whitespace was trimmed in some positions
  only, `bun add git@jsr:owner/repo.git` was an error, an import of a dependency of the project
  with an invalid `jsr:` specifier installed `<name>@latest` from the default registry (it is an
  error now, and nothing is requested), a registry package's invalid `jsr:` dependency was
  skipped without a word (it is a warning now), `bun pm diff` did not take `jsr:` specs, and the
  docs said three things that the binary did not do.

A second pass, three readers on the reworked commit, reproduced five more, all in corners, and
all fixed:

- `bun add jsr:@scope/name` without a version took any catalog entry under that name as its
  answer, also an entry for a package of another registry, which was then installed. It takes an
  entry, or a range that the `package.json` already has, only where that is the same JSR package.
- An override value `$name` took the alias of the dependency it refers to, so a `jsr:1.0.0` that
  was written for one package pinned another to that package. `$name` is the specifier as it is
  written, read under the name that the rule is for, as in pnpm.
- An entry for the `@jsr` scope with a token and no address was moved to npm.jsr.io, which the
  first pass had asked for. With a mirror in the config files and `--registry` for npm's, that
  sent the mirror's token to npm.jsr.io. Such an entry is at the default registry again, like
  every scope's, and the registry of the scope became the lookup that is described above.
- That lookup also repairs `bun publish` of a package named `@jsr/...`, which ignored
  `publishConfig.registry` while the scope was an entry.
- One `jsr:` dependency without a scope in the root `package.json`, imported by nothing, made the
  runtime's auto-install drop the catalogs, workspaces and overrides of the project without a
  word, because the root was read as for an install and the error was swallowed.

The two passes above are the review that this commit had. No wider design review gave a result.

Found on the way, upstream's, and reported instead of fixed here:
`bun update -r --latest '<pattern>'` moves `bun.lock` for an `npm:` alias and leaves
`package.json`, so the next frozen install fails, and `bun update -i` links an alias to the
npmjs.org page of its key.

Cost for a project without `jsr:`: a four byte comparison per specifier that is read (twice for
the dependencies of a registry package, which are sized and then copied), one per npm dependency
that is parsed and per override, one more arm in a `match` on the first byte, and a comparison of
the scope name when a scoped package has no entry for its scope. No allocation, no request and
no file read. There is no release build of this commit, so no binary size.

Not done:

- An older bun and a `bun.lock` that this one wrote. Released bun reads `jsr:` in `package.json`
  as git, so its frozen install refuses a lockfile with the alias. That only matters for projects
  that released bun could install at all, and there is one kind: when it migrates a
  `pnpm-lock.yaml` with JSR packages it copies `jsr:^1.0.0` into `bun.lock`, reads it as git from
  then on, and never asks git, because the package is pinned. This bun reads such a lockfile and
  leaves it byte for byte while nothing changes, so both versions install from it. The first
  `bun add` or `bun update` writes the aliases, and from then on the project needs this bun.
- A mirror as the default registry that does not serve `@jsr/*`: `jsr:` needs an entry for the
  scope there, where pnpm and Yarn go to npm.jsr.io on their own.
- A plain override key does not reach a `jsr:` dependency (`"@std/path": "jsr:1.0.8"`), because
  no plain key overrides an alias. The key has to say `@std/path@jsr:^1`.
- A plain dependency of another package on the same name follows the `jsr:` entry of the project
  when the JSR version is in its range, as it follows an `npm:` alias. pnpm installs npm's
  package next to the JSR one. For a package that is published to both registries that is one
  copy and not two. For two unrelated packages with one name it is the wrong one.
- A `jsr:` dependency that is written with a dist-tag (`jsr:canary`) is not reached by a
  `name@jsr:` override key, like an `npm:` alias with a tag. `@jsr/<scope>__<name>` as the key
  reaches it.
- `bun update jsr:@scope/name` and `bun remove jsr:@scope/name` go by the name `@scope/name` in
  `package.json`. The package under another name is updated with that name or with
  `bun update @jsr/<scope>__<name>`.
- A registry package with a `jsr:` dependency that names no JSR package installs without that
  dependency, with a warning. If its code imports the name and the runtime auto-installs, the
  import still gets `<name>@latest` of the default registry, because the lockfile no longer knows
  that the name was declared. For the project's own `package.json` and for a package that is
  only in `node_modules` the import is an error.
- `http://registry.npmjs.org` is not npm's registry for the rule above. Only the https address is.
- `jsr:` descriptors in a Yarn `yarn.lock`. A `pnpm-lock.yaml` with them migrates (the test is
  pnpm's real output for three dependencies).
- A `bun.lockb` that an older bun wrote with a `jsr:` literal still holds it as git. The next
  install that is not frozen resolves it again.
- `bun why`, `bun outdated`, the frozen-lockfile error and the line `bun add` prints show the
  alias (`@std/path@npm:@jsr/std__path`).
- Importing `jsr:@std/path` in code, which is Deno's other use of the word, is a different
  feature.
- Windows and macOS were not run. Nothing in the change is specific to a platform.

Tests: `test/cli/install/jsr.test.ts`, 92 tests against one local server that is both registries
(`/<project>/npm/` is the default registry of a project and `/<project>/jsr/` the one of its
`@jsr` scope, with the tarballs where npm.jsr.io has them), so a test can say which registry was
asked for what. The default registry has a package of its own under the name `@std/path`, and no
`jsr:` dependency may get it. Every project has a token for its default registry, and a request
to the other registry that carries it fails the list of requests that the test expects. Ten tests
watch where an install goes when the scope is not configured, through a proxy that refuses every
connection and records the `CONNECT` lines. Where a credential goes needs a proxy that ends TLS,
which the tests do not have. That was checked by hand with such a proxy: 20 arrangements of
tokens and registries, and 35 projects without `jsr:` against released bun, which differ only in
`@jsr/*` going to npm.jsr.io in the 14 that have npm's registry and no entry for the scope. All
92 fail on the released 1.4.3-canary.1.

Rebase notes: 56 patches onto oven-sh/bun 4354b80d7b, 20 commits after the last base. The feature
took two days and upstream moved under it, so this was two rebases: onto bc1030a97b, where six
patches stopped, and then onto 4354b80d7b, where all applied as they were. The next one will
not be clean: oven-sh/bun#45828 landed while the last tests ran, it changes the entry points of
`run_command.rs` again, and `bun serve` conflicts with it. The six patches:

- `bun serve`: `bun bake` (oven-sh/bun#45682) replaced the entry point for HTML files with a list
  of builtin entry points. The static server is one more of them (`MainEntryPoint`,
  `BuiltinEntryPoint`, `BootMain` in `run_command.rs`), and its arm moved from
  `HTMLEntryPoint.cpp`, which is gone, to `BuiltinEntryPoint.cpp`.
- `--watch-path`: its two fields sit next to the new ones in `context.rs` and `Arguments.rs`, and
  the watcher starts before the new check for type errors in `run_command.rs`.
- Query logging for `Bun.SQL`: oven-sh/bun#45711 changed `dispatchToPool()` in `sql.ts`, and the
  hook is written for the new function.
- `Bun.INI`, `Bun.CSV` and `Bun.Queue`: their rows in `BunObject.cpp`, next to the rows that
  oven-sh/bun#45851 moved to the bindings generator.

On the new base, with the debug build: `jsr` (92) and these files of the package manager pass:
`bun-install` (803), `npmrc` (606), `bun-install-registry` (493), `bun-lock` (386), `bun-pack`
(349), `bun-update-transitive` (323), `run-autoinstall` (303), `bun-publish` (295),
`bun-workspaces` (290), `nested-overrides` (283), `isolated-install` (283), `bun-audit` (257),
`bun-add` (221), `frozen-lockfile-pruned` (184), `bun-update` (175), `bunx` (174),
`bun-update-lockfile-sync` (172), `pnpm-lock-v9` (168), `hoist` (160), `bun-pm` (155),
`bun-add-catalog` (153), `catalogs` (150), `bun-add-filter` (148), `config-precedence` (141),
`yarn-berry` (116), `bun-pm-why` (116), `migrate` (108), `frozen-lockfile-outdated` (107),
`overrides` (93), `frozen-lockfile-workspace-names` (91), `bun-dedupe` (82), `bun-info` (75),
`bun-pm-diff` (74), `yarn-lock-migration` (69), `bun-link` (57),
`bun-install-package-extensions` (43), `bun-remove` (37), `frozen-lockfile-member-pins` (27),
`bun-pm-sbom` (22), `pnpm-lock-migration` (18), `pnpm-migration` (14) and `pnpm-comprehensive`
(5). So do the tests of the patches that the rebase touched: `filter-workspace` (176), `watch`
(27), `static-server` (9), `ini` (72), `csv` (54), `queue` (50), `jwt` (87) and `msgpack` (228).
`sql-debug` passes for SQLite and PostgreSQL (19) and fails its three MySQL tests, because the
MariaDB of this container refuses `root` over TCP. The tests ran with `--timeout 120000`, which
is less than the CI runner gives a debug build: a test that runs a few installs in a row takes
more than the 5 seconds that `bun test` allows by default. The source lints pass with the debug
build (182). The fixes of the second review pass came after this run. `jsr`, the source lints
and the 22 files that those fixes can reach ran again after them, with the same counts:
`bun-install`, `npmrc`, `bun-install-registry`, `bun-lock`, `bun-pack`, `run-autoinstall`,
`bun-publish`, `bun-workspaces`, `nested-overrides`, `bun-add`, `bun-update`, `bunx`,
`pnpm-lock-v9`, `bun-add-catalog`, `catalogs`, `bun-add-filter`, `config-precedence`,
`yarn-berry`, `overrides`, `bun-info`, `bun-pm-diff` and `bun-install-package-extensions`. The
other files in the list ran on the build before those fixes. The other test files of the stack
were not run on this base.

Files: `src/install_types/jsr.rs` (new), `src/install_types/lib.rs`, `src/install/lib.rs`,
`src/install/dependency.rs`, `src/install/lockfile/Package.rs`,
`src/install/lockfile/CatalogMap.rs`, `src/install/lockfile/OverrideMap.rs`,
`src/install/lockfile/override_selector.rs`, `src/install/lockfile/package_extensions.rs`,
`src/install/lockfile/bun.lock.rs`, `src/install/pnpm.rs`,
`src/install/PackageManager/PackageManagerOptions.rs`,
`src/install/PackageManager/PackageManagerEnqueue.rs`,
`src/install/PackageManager/UpdateRequest.rs`,
`src/install/PackageManager/PackageJSONEditor.rs`, `src/install/PackageManager/add_catalog.rs`,
`src/resolver/package_json.rs`, `src/resolver/resolver.rs`, `src/runtime/cli/pack_command.rs`,
`src/runtime/cli/pm_diff_command.rs`, `src/runtime/cli/pm_view_command.rs`,
`docs/pm/cli/add.mdx`, `docs/pm/cli/install.mdx`, `docs/pm/cli/pm.mdx`,
`docs/pm/cli/publish.mdx`, `docs/pm/overrides.mdx`, `docs/pm/scopes-registries.mdx`,
`test/cli/install/jsr.test.ts` (new).

### 2026-10-20: `redis.multi()`, transactions for `Bun.redis`

`docs/runtime/redis.mdx` ended with one item under "Limitations we plan to address in future
versions": "Transactions (MULTI/EXEC) require raw commands". Raw commands are not only clumsy. A
client has one connection, and every command of every task that uses the client goes into the same
queue, so a command that another request handler sends between `send("MULTI")` and `send("EXEC")`
becomes part of the transaction. On Bun 1.4.3:

```ts
async function transfer() {
  await redis.send("MULTI", []);
  await redis.send("INCRBY", ["a", "10"]);
  await redis.send("INCRBY", ["b", "-10"]);
  return await redis.send("EXEC", []);
}
const [exec, got] = await Promise.all([transfer(), redis.get("a")]);
// exec: [null, 10, -10]   the GET ran inside the transaction
// got:  "QUEUED"          and its promise got the reply for a queued command
```

The typed methods are lost on that path too: nothing checks the arguments, `exists()` gives `1`
and there is no way to ask for a `Buffer`. Now:

```ts
import { redis } from "bun";

const replies = await redis
  .multi()
  .decrby("account:1", 10)
  .incrby("account:2", 10)
  .exec();
// [90, 110]

const [stored, created, found, fields, bytes] = (await redis
  .multi()
  .set("greeting", "hello") // "OK"
  .hset("user:1", { name: "Ana", plan: "pro" }) // 2
  .exists("user:1") // true, as outside a transaction
  .hgetall("user:1") // { name: "Ana", plan: "pro" }
  .getBuffer("greeting") // <Buffer 68 65 6c 6c 6f>
  .exec())!;
```

`multi()` returns a transaction. It has the command methods of the client, all of them, with the
same argument checks at the call. Each one keeps its command and returns the transaction, and the
client sends nothing before `exec()`. `exec()` sends `MULTI`, the commands and `EXEC` as one unit
and resolves with one reply per command, each converted as its method converts it outside a
transaction. In TypeScript the result of one chain is a tuple of those types. In the script above,
`transfer()` written with `multi()` gives `[10, -10]` and the `get()` gives its value.

What `exec()` does in the other cases:

- `null`: a key that was watched on the connection changed, and the server ran nothing.
- The server refused a command when it was queued (unknown command, wrong number of arguments).
  Nothing ran. `exec()` rejects with the error of the first refused command, not with `EXECABORT`.
- A command failed when the transaction ran (`WRONGTYPE`). Redis does not roll back, so the other
  commands took effect. `exec()` rejects with the error of the first failed command, which also has
  `replies` (every reply, with an error in each failed place) and `errorIndexes`. That is the shape
  of node-redis 5; ioredis resolves with `[error, value]` pairs.
- The server refused `MULTI` (an ACL rule, or a raw `MULTI` open on the connection): `exec()`
  rejects with that error, without `replies`.
- `EXEC` answered with another number of replies than the transaction has commands:
  `ERR_REDIS_INVALID_RESPONSE`, before anything is converted.
- The connection ended with the transaction in flight: `ERR_REDIS_CONNECTION_CLOSED` or
  `ERR_REDIS_IDLE_TIMEOUT`, like any command in flight. All of it ran or none of it.

A transaction is sent once: after `exec()`, that method and the command methods throw. `multi()`
takes no argument, so the array form of ioredis throws where it would have sent an empty
transaction.

Where it lives was decided before any code was written, by a design review that put six designs
next to each other: a docs-only recipe, one host function that takes an array of raw commands, a
callback like `sql.begin()`, a hidden second connection per client, guards that make the raw
`MULTI` safe, and the one built here. The reasons for it:

- One funnel in. Every command method ends in `JSValkeyClient::send`. A transaction is an object of
  the same class over a client that never connects, and `send` keeps the serialized command and its
  reply conversion instead of dialing. So the 200 methods are not written, declared or generated a
  second time: the transaction runs the client's own. The check sits in the branch `send` already
  had for "never connected", which a connected client does not take.
- One queue entry out. `exec()` hands `MULTI`, the commands and `EXEC` to the client as one entry,
  through the same admission as a command (`enqueue` now takes a command or such a unit). The flush
  moves an entry to the socket whole, and a lost connection rejects the entries in flight and keeps
  the waiting ones. So the two properties that matter need no code of their own: no other command
  of the client lands between `MULTI` and `EXEC`, and no transaction is finished on another
  connection than the one it began on. The entry is pipelined like one command, where a raw `MULTI`
  and a raw `EXEC` each wait for every earlier reply.
- One promise. The server answers the entry with N + 2 replies. How they are read is a small plan
  (the conversion of each command, the first error) in a queue beside the command queue, allocated
  with the client's first transaction. The two structs that every queued command pays for do not
  grow, which the build now asserts.
- The reply path has one test for "this pair is not settled by one reply", which pub/sub had. A
  transaction shares it (one more bit in the mask).

What a transaction refuses, each with `ERR_REDIS_INVALID_STATE` when the method is called:
`multi()`, the commands the server would run at once instead of queueing (`MULTI`, `EXEC`,
`DISCARD`, `WATCH`, `QUIT`, `RESET` through `send()`, and `UNWATCH` with them), subscriptions, and
`connect()`, `close()` and `duplicate()`. `exec()` on a client that is not a transaction throws
too, and TypeScript does not offer it there. There is no `discard()`: the server has seen nothing
before `exec()`, so dropping the object is the discard.

The type of a transaction is derived, not written out: `RedisTransaction<Replies>` maps over the
members of `RedisClient`, leaves out the thirteen names that are not commands and re-types every
overload to return the transaction with the reply added to the tuple. `exec()` is typed
`[...Replies, ...unknown[]] | null`: a transaction that statements or a loop fill has no known
replies, and its result is `unknown[]`. `RedisTransaction.ExecError` declares `replies` and
`errorIndexes`. A lint holds the list of names to the list the runtime uses, requires every
accessor of the client to be on it, and checks that no method has more overloads than the mapping
keeps (18, which `hsetex` needs).

What it costs a client that never calls `multi()`, measured on two release builds (the stack
without this commit and with it, same toolchain). One call was single-stepped in gdb after 600
warm-up rounds against a RESP stub in the same process:

|                                                          | without                                                | with              |
| -------------------------------------------------------- | ------------------------------------------------------ | ----------------- |
| `redis.get(k)`, callees included                         | 2,854 instructions, 374 conditional branches, 69 calls | 2,815, 373, 67    |
| `redis.send("GET", [k])`, callees included               | 3,351, 436, 81                                         | 3,316, 436, 79    |
| reply path (`handle_response`, its own body) for a `+OK` | 89 instructions, 10 conditional branches               | 87, 10            |
| the same for a message push on a subscribed client       | 248, 36                                                | 251, 38           |
| one client (`estimateShallowMemoryUsageOf`)              | 560 bytes                                              | 576 bytes         |
| host functions of `RedisClient`                          | 209                                                    | 211               |
| binary (`size`, text)                                    | 108,098,150 bytes                                      | 108,085,606 bytes |

So a command and a reply cost no more than they did, a pub/sub push takes two more branches (the
test for a transaction sits in the block that only subscribers and subscription requests enter),
and a client is two words larger. The binary is 12.5 KB smaller because the error path of the 200
command thunks is no longer inlined into each. The first version did cost every command a call
(2,881 instructions for `get()`): the capture serialized with the same generic function as the
queue, and asked the same helper whether a command is a subscription, and with a second caller the
compiler stopped inlining both into the send path. Both are `#[inline(always)]` now. The measured
build is from before the last lint fix (`or` to `or_else` in `settle_unit`), which none of the
measured paths runs.

What one transaction costs its caller, against the awaited raw flow, counted at a RESP stub: 1,000
transactions of two commands are 1,000 writes instead of 4,000, and a transaction of 100 commands
creates 1 promise instead of 102. `exec()` moves the serialized commands into the queue entry
without a copy.

For TypeScript, the fixture of bun-types goes from 116,137 type instantiations to 192,388 with
tsc 6.0.2, nearly all of it for the transaction chains the fixture now has. The declarations alone
cost a project that never calls `multi()` about 2,400.

Tests. `test/js/valkey/reliability/connection-failures.test.ts` has 29 new tests against a RESP
server in the test process, so they need no Redis: the order on the wire with auto-pipelining on
and off, a transaction of 4 MB that the socket takes in many writes, replies that arrive one byte
per read, every result and error shape (three encodings of the null, `EXEC` with too many and too
few replies), a refused `MULTI`, a connection lost with the transaction in flight (rejected, none
of it on the next connection) and before it was sent (sent whole on the next one), the reply plan
after each of those, a client that becomes a subscriber with a failing transaction in flight, a
`PSUBSCRIBE` with two confirmations in front of a transaction, the idle timeout, the process
lifetime and the memory estimate. `test/js/valkey/valkey.test.ts` has 8 against a real server for
each connection type (the conversions, 50 transfers with reads issued in the middle of each, the
error shapes, `WATCH` against a second connection, subscriber mode) and 19 that need no server
(what a transaction refuses, checked against the list the types use, and that every other method
of the client queues and returns the transaction). `test/js/valkey/valkey-gc.test.ts` has one that
counts the live objects: a transaction keeps its client alive, and both are collected when it is
dropped. All 57 fail on Bun 1.4.3 (`client.multi is not a function`). The existing Redis test files
pass on the new build, the raw `MULTI`/`EXEC` test in `integration/complex-operations.test.ts`
unchanged.

A review pass read the first version before the push (17.5 hours) and said not to commit it as
it was. What it found, and what this commit does about each:

- `exec()` had its own admission next to `enqueue` and started the flush whenever the client was
  connected. With auto-pipelining off that wrote a transaction while the `SELECT` of the handshake
  had no reply yet, and when the server refused the database, the transaction ran on database 0
  while `exec()` rejected. The unit now goes through `enqueue` like a command. Two tests hold it,
  and both fail on the first version.
- `exec()` was typed with the exact tuple, which is `[]` for a transaction that statements fill.
  It is the open tuple described above.
- `multi([["set", "a", "1"]])` sent an empty transaction and resolved with `[]`. It throws.
- An error reply to a queued command followed by an `EXEC` that returns an array resolved as a
  success, converted with the wrong command's rules. It rejects with the refused command's error,
  and an `EXEC` array of the wrong length rejects too.
- A transaction could be sent twice, at the price of a copy of its buffer per `exec()` and of a
  second `exec()` that silently repeats commands. It is sent once.
- `watch()` and `unwatch()`, see below.
- The tests did not prove what their names said: five "one piece" tests passed on a `multi()`
  written in JavaScript that sends N + 2 separate commands, three clauses that keep the reply plans
  in step could be deleted with every test green, and the test named for collection never
  observed one. The tests above are the rewritten set.
- The docs had a result that the page never produced, passive sentences where the reader needs the
  actor, and no word about a refused `MULTI`. 36 multi-line comments became one line each or went.

Not done, and what stays as it was:

- `watch()` and `unwatch()`. The first version had them as typed methods, with a count of the
  connections so that a transaction after `watch()` resolves with `null` when the connection that
  watched is gone. The review found that its guard was one slot per client, which the next `exec()`
  of any user of the client consumes, and that such a contract cannot be changed once it ships. It
  is taken out of this commit and is its own piece of work, with the guard carried by the
  transaction. Until then `WATCH` works through `send()` on a client from `duplicate()`, as the
  docs show, and a reconnect drops the watch without notice.
- Raw `send("MULTI")` ... `send("EXEC")` is unchanged, and still unsafe on a client that other code
  uses. The docs say so and point to `multi()`.
- A refused `MULTI` does not stop the commands: they were sent with it. Redis then runs them one by
  one (or, when a raw `MULTI` is open, queues them into that transaction, which Valkey 8 discards
  instead). ioredis and node-redis behave the same. Waiting for the reply to `MULTI` would cost
  every transaction a second write and a round trip. The error has no `replies` in this case.
- A client that becomes a subscriber while a plain command is in flight still fails its connection
  on an error reply to that command. Only the transaction is kept out of that rule.
- The collector is not told about the memory of the client objects (that is so for every
  `RedisClient`). A transaction reports the growth of its buffer, and `exec()` moves the buffer to
  the client's queue without a copy.
- The array form of ioredis and its `[error, value]` results.
- Editors show no JSDoc on the methods of a transaction, because the type is derived.
- Open upstream pull requests that touch the same lines and are not taken in: #45723 removes the
  `Result` that `JSValkeyClient::send` returns, which the refusal of a command in a transaction
  uses. #32858 takes the next bit of `Meta` (this commit uses the one after it) and counts replies
  per entry, which the plan of a transaction could move onto. #39965 and #41645 add fields to the
  promise of a command, which is why the size assertions are written relative to it.

Rebase notes: upstream moved by nine commits when the stack was rebased. It has moved by 18 more
since, which the next sync takes. One of them, #46021, changes `js_valkey.rs`,
`js_valkey_functions.rs` and `valkey-gc.test.ts`, and a trial merge takes it without a conflict in
the files of this commit. Eleven of the 57 patches needed a hand merge and none was dropped.

- Eight were lines next to lines that upstream rewrote, mostly comments: `Bun.semver.parse()`,
  `bun outdated --json`, `Bun.CSV` (the table of published types in `bun-types.test.ts`),
  `#semver:` for git dependencies, `--watch-path` (both sides add a field to `DebugOptions`), Web
  Storage (the line of `TextDecoder` in `ZigGlobalObject.lut.txt`), the `bun.lock` merge,
  `bun pm sbom` and `jsr:` (three files).
- "Did you mean" for `bun run`: upstream #45800 reads the command after the flags of `bun` in
  front of the chain of comparisons that this patch replaces with a table. Both are kept.
- `bun serve`: upstream made `bun bake` always watch and turned the type check before the first
  run into a `let ... else { unreachable!() }` that only knows a file. The static server is a
  third case there, so it stays a `match`.
- S3 metadata: upstream #45888 moved `S3Stat` from `S3Stat.classes.ts` to a schema of the
  bindings generator. `stat().metadata` is now one line in `S3Stat.bind.ts`
  (`b.record(b.string.utf8)`) and a method of the generated trait, and the hand-written getter is
  gone. The entry of 2026-09-27 names the new file.

After the rebase the stack builds, and the test files of the eleven patches pass. Three of them
(`bun-lock`, `bun-install-git-deps`, `jsr`) only do so with a longer timeout than the default 5
seconds, which the debug build with the other work on this machine did not meet: 386, 204 and 92
tests. In `test/internal/source-lints/` the two recursion lints and the `<iostream>` lint run out
of their 5 seconds in the debug build as on the days before, and pass with a longer one. `cargo
clippy` is clean for `bun_runtime`. This entry is dated for the day its work began. Two reviews of
8.5 and 17.5 hours made it the commit of the day after.

Files: `src/runtime/valkey_jsc/valkey.rs` (`Admitted`, `Unit`, `admit`, `send_unit`,
`handle_unit_reply`, `settle_unit`), `src/runtime/valkey_jsc/js_valkey.rs` (`Transaction`,
`new_transaction`, `queue_in_transaction`, `take_transaction`),
`src/runtime/valkey_jsc/js_valkey_functions.rs` (`multi`, `exec`),
`src/runtime/valkey_jsc/ValkeyCommand.rs` (`UnitPlan`, `Meta::TRANSACTION_UNIT`,
`Entry::from_parts`), `src/runtime/valkey_jsc/valkey.bind.ts`, `packages/bun-types/redis.d.ts`
(`RedisTransaction`), `docs/runtime/redis.mdx`,
`test/js/valkey/reliability/connection-failures.test.ts`, `test/js/valkey/valkey.test.ts`,
`test/js/valkey/valkey-gc.test.ts`, `test/internal/source-lints/redis-client-types.test.ts`,
`test/integration/bun-types/fixture/redis.ts`.

### 2026-10-21: `alias` for `Bun.build` and `bun build --alias`

esbuild, webpack, Rollup and Vite can all be told to bundle one package in place of another:
`react` as `preact/compat`, a Node.js module as its browser port, `@app/config` as the file for
production. `Bun.build` could not. Its migration page listed esbuild's `alias` as "Not supported",
the two tests ported from esbuild's suite (`default/PackageAlias`, `default/PackageAliasMatchLongest`)
have been todo since 2023, and `bun build` did not know the flag: `--alias react=preact/compat`
read `react=preact/compat` as a second entry point, and `--alias=react=preact/compat` did nothing.
The ways around it are a `paths` entry in tsconfig.json, which cannot name a built-in module and
is relative to the tsconfig, or an `onResolve` plugin, which the CLI does not have. Now:

```ts
await Bun.build({
  entrypoints: ["./src/index.tsx"],
  outdir: "./dist",
  alias: {
    react: "preact/compat", // and react/jsx-runtime is preact/compat/jsx-runtime
    "node:fs": "memfs",
    "@app/config": "./src/config.production.ts",
  },
});
```

```sh
bun build ./src/index.tsx --outdir dist --alias react=preact/compat --alias @app/config=./src/config.production.ts
```

The rules are esbuild's:

- A key is the name of a package as an import spells it: `react`, `@scope/pkg`, `pkg/sub`,
  `node:fs`. A relative or absolute path, a name with a trailing slash, with `.` or `..` in it or
  with a backslash is an error when the option is read (`Invalid alias name: "./local"`), and so is
  an empty value.
- A key stands for the package and for the paths in it. The longest key that is the import, or a
  directory above it, is used, and the rest of the import is kept: `pkg/foo/bar/baz` with a key
  `pkg/foo` is `<value>/bar/baz`. A key is not a prefix of a name: `react` says nothing about
  `react-dom`. `import "pkg/"`, which is how a package is told from the Node.js module of the same
  name, is the value without the slash.
- The value is looked up from the working directory, not from the file that has the import. A
  dependency somewhere in `node_modules` that imports `react` gets the `preact` of the project,
  and not one that happens to be installed next to that dependency. A relative value is relative
  to the working directory as well.
- It is used once, and first. The value is not looked up as a key (`{ a: "b", b: "./c.ts" }`
  bundles the package `b` for `a`). A built-in module can have an alias with every target.
  `external` and `packages: "external"` are asked about the value, so a library build prints
  `import ... from "preact/compat"`, in JavaScript and in a CSS `@import` or `url()`. The value can
  be one of the in-memory `files`, and a file there that is named like the import does not hide
  the alias.
- Plugins come before it. `onResolve` gets the name as the file has it and what it returns is
  used. The alias is for what no plugin resolves, and plugins are not asked about the value. A
  plugin can set `build.config.alias` in `setup()`.
- An alias that cannot be found fails the build with both names, and says where it was looked for:

  ```
  error: Could not resolve: "preact/compat" (originally "react")
  note: "react" was replaced with "preact/compat" by the "alias" option. An alias is resolved from the current working directory, not from the importing file.
  ```

  An import that is allowed to fail (`try { require("optional") } catch {}`) keeps its own name.

Where it lives was the question of the day. The first draft put the step into the resolver and a
design review moved it. The bundler reads the name of an import before the resolver does (the
shortcut that keeps built-in modules out of a `target: "bun"` bundle, then the plugins, then the
in-memory `files`) and after it (the name an external import is printed under, the text of the
error), so a step in the resolver cannot give a built-in module an alias, cannot print the new
name and cannot name both in the error. It would also put a test on every `import` and
`require()` of the runtime, which shares that function. So it is one step in
`BundleV2::resolve_import_records`, the loop every import record of a build goes through:

- Above the built-in shortcut the loop looks the name up (`alias_substitute`, on the name the file
  has, so a record that comes through the loop again is not given the alias of its alias) and,
  for a record with an alias, asks the plugins at that point. From there on every rule reads
  `specifier`, which is the value, and `(source_dir, importer)`, which are the working directory
  and a file in it. Nothing is written to the record before the resolver has answered.
- An import that a plugin's `onResolve` had no answer for used to go to a second copy of the
  lookup, `run_resolver`. A record with an alias now goes back through the loop instead, with
  `after_plugins` set, the way barrel optimization resolves the records it had put off
  (`resolve_barrel_records`, which is now `resolve_records` with the two callers). `run_resolver`
  is not touched, so the step exists once.
- The resolver, the transpiler and the runtime's module loader have no line of this:
  `git diff --stat -- src/resolver src/jsc src/bundler/transpiler.rs` is empty. A build without
  `alias` pays one emptiness test per call of the loop and one branch per import record that is
  not taken. `BundleOptions` and the CLI's `BundlerOptions` each grow by one empty `Vec` (24
  bytes).

The hunks sit next to `external` and `allowUnresolved`, which are upstream's lines, and the type is
a file of its own (`src/options_types/package_aliases.rs`), so the commit applies to upstream main
with a conflict in this file only.

A review of the finished diff raised sixteen points, and all of them held. Fixed:

- An external value was written into the text of the record's path only. A CSS `@import` prints
  another field, so the stylesheet of a library build still imported the key. The whole path is
  replaced now.
- A plugin that wraps a package answers with a module whose path is the name of the package, and
  has no answer for the import of the real one inside it. The graph looks records up by the text
  of their path, so that inner import was bound to the wrapper before the loop saw it, and the
  alias was skipped without an error. The record's index is reset before it goes back through the
  loop, and a record with an alias whose file is already in the graph takes the path of that file.
- With `target: "node"` the bundler's runtime imports `node:module` for `require()`. An alias for
  `node:module` caught that import too, and the bundle threw on its first line. The runtime's
  imports have no alias.
- Tests for what had none: the lone trailing slash, keys that are not in the order of their
  length, a declined import whose alias does not resolve, a built-in value after a plugin.

Cut, because the same review showed it is not a small thing: an entry point that is the name of a
key. The first version looked such an entry point up as a file and then as the value. Six of the
sixteen points were about it: a key with a slash in it fails earlier, where the root directory of
a single entry point is worked out; the value was not looked up in `files`; an entry point the
`browser` field disables panicked; the error named one name; and after a plugin the output was
named after the key instead of the file. An entry point is looked up as it is written, and the
docs say so. esbuild gives entry points the alias, so this is the one place the rules differ.

Not done, and for whoever picks this up:

- `Bun.build({ watch: true })` (2026-10-09) does not watch for the file a relative value names
  when that file is missing: it looks next to the importer, and the value is relative to the
  working directory.
- An external value in an HTML tag (`<script src="cdn-lib">` with an alias to a URL) builds, and
  the tag keeps its text.
- `with { type: "sqlite" }` imports and macro imports have no alias. The first is opened by the
  runtime from where the output file is, the second is resolved while its file is parsed.
- `--check` resolves imports for the type checker with tsconfig.json only.
- No `alias` in bunfig.toml or in the shell completions, and none for `bun build --app`, the dev
  server and HTML routes of `Bun.serve`. `--alias` with `--no-bundle` or `--app` is an error
  rather than a flag that does nothing.
- The working directory is the process's, read when the import is resolved, as for entry points.

Measured: the two counts above, and an A/B of one 20,000-module build (the graph of
`edgecase/DeepImportDiamondDAG`) on debug builds with and without the patch, two runs each in
turn: 112.3 s and 93.4 s without, 119.0 s and 102.4 s with. The spread between two runs of one
binary (19 s) is larger than the difference, so this shows nothing beyond "not slower by much".
Instruction counts on release builds, which would be the real number for the branch per record,
were not taken: valgrind, perf and strace are not in the build container, and no release build of
either side was made.

Rebase notes: upstream moved by 18 commits to 9b4284f788, three of them large, and 28 of the 57
patches needed a hand merge. Nothing was dropped.

This run and the run of 2026-10-20 overlapped. That run had not pushed when this one began, so this
one started from the 57 patches of 2026-10-18 and rebased them itself: over the nine upstream
commits that run had rebased over, and nine more. The commit of 2026-10-20 was then picked onto
this stack, under this one. It applies without a conflict outside this file. The eleven hand merges
its entry lists are not in this history, the ones listed here stand in for them. The first push of
this run (53dc87b3f9) left `redis.multi()` out of `main` from 14:19 to 18:34 UTC: a `git fetch` of
the fork right before `git push --force-with-lease` moves the lease to what another run has just
pushed, and the push then goes through. Before a forced push, compare the fetched tip with the
commit the run started from.

- Upstream rewrote the coverage converter (oven-sh/bun#45677): a line is executable if the source
  map has code of it, counts come from JSC's ranges, and the module itself, the function body of a
  generator or an async function and a static block are no longer functions. The three coverage
  patches were written against the converter it replaced.
  - Ignore hints (2026-09-16) keep `Report::ignore_lines` and now take the lines of a function and
    of a statement from the new converter's offsets. The function Bun wraps a CommonJS module in is
    no longer reported as a function of the file when there is a source map, so the guard that kept
    it from being ignored is for files without one.
  - `collectCoverageFrom` (2026-09-26): the report of a file that nothing loaded is one range over
    the whole text for the lines, plus the functions JSC's parser lists, through the same
    `convert`. The C++ side lists what a load lists under the new rules (no range for the module,
    none for generator and async bodies or static blocks). A module without functions now reports
    0 of 0 functions, which the table shows as 100.00 next to 0.00 for lines, as Jest does. In a
    `// @bun` file without a source map a last line without a newline is counted.
  - The HTML reporter (2026-10-14) needed its error type merged with upstream's
    `generate_code_coverage`, which returns whether the report was written.
  - The expected numbers of the fixtures changed with the converter (a function that never ran
    has its body lines uncovered now, a line with only a brace is not executable), and the tests
    were updated to them. `coverage.test.ts` passes (68 tests, 1 skipped).
- Upstream's hardening pass (oven-sh/bun#46021) reworked the shell's `IOReader`. It now drops its
  listeners after EOF and after an error, which is what the `kill()` patch (2026-09-15) had done,
  so that part of the patch is gone. Its new `cat.test.ts` found a hang in this stack: the `wc`
  patch (2026-08-15) reads a file or a directory on stdin without polling it, the reader does not
  read an fd again after a read of it failed, and so a second `cat` of a failed stdin waited
  forever. `IOReader` keeps the error now and hands it to a listener that starts later. The same
  pass added three task tags (the count the two loop tags of this stack assert is 88), a
  `bail_out` for `bun test --bail` that `--reporter=json` and `--last-failed` write their files
  in, and made `FileSystem::top_level_dir` a method, which four patches read as a field.
- `S3Stat` moved to the bindings generator (oven-sh/bun#45888). The `metadata` getter of
  2026-09-27 is a line in `S3Stat.bind.ts` (`b.record(b.string.utf8)`, cached) and a method that
  returns the pairs.
- Smaller ones: the transpiler cache is at version 38 (`import.meta.glob()`), the table of root
  commands from 2026-08-28 takes upstream's skipping of flag values, `bun serve` has an arm in
  upstream's new check of what is type-checked before a run, and a dozen test files and comments
  that both sides had added to.

After the rebase the stack builds and these test files were run on the debug build: `coverage`
(68), the shell (`wc`, `head`, `tail`, `sort`, `uniq`, `kill`, `parse`, `bunshell`, `exec`, `cat`),
`s3-metadata`, `perf_hooks`, `filesink`, `test-last-failed`, `semver` (484), `import-meta-glob`,
`bun-serve-compress`, `static-server`, `run_command`, `filter-workspace`, `bun-pm-sbom`, `storage`,
the new and changed parts of `bun-test`, `watch`, `hot`, `bun-pm` and `bun-install-git-deps`, the
type tests (24) and the source lints (186). They pass. What does not pass on this build is slow,
with or without this stack's code: the six recursive scans of `glob/scan.test.ts` (30 s each, 8 s
on the release build), three `--compile` tests of `bundler/cli.test.ts` (a debug executable is 1.2
GB), `edgecase/DeepImportDiamondDAG` and the 400-build test of `bun-build-api.test.ts` (see the A/B
above), and the memory tests of `shell/leak.test.ts`. `snapshot.test.ts` has one upstream test that
expects colors, which a run into a file does not have.

For `redis.multi()` on this stack: the build container has no Docker daemon, so the tests ran
against a local Redis 8.0.2 with the TCP port, the TLS port and the users of the test image.
`valkey.test.ts` (1084, 2 skipped), `reliability/connection-failures.test.ts` (87, 1 skipped, 1
todo) and `valkey-gc.test.ts` (26, three upstream tests of it with more than the default 5 seconds)
pass on the debug build. So do the other twelve files of `test/js/valkey/`, except for two upstream
snapshots of a message of the server: this Redis adds `, with args beginning with: ` to
`ERR unknown command`, and bun 1.4.3 fails the same two against it.

For `alias`: the two esbuild tests, 17 cases in `bundler_edgecase.test.ts`, 3 in
`bun-build-api.test.ts` and 7 in `cli.test.ts` pass on the debug build and fail on bun 1.4.3. The
bundler suites that go through the same loop pass after the change: `esbuild/default` (165),
`bundler_plugin` (68), `bundler_barrel` (70), `bundler_files` (28), `bundler_html` (25),
`bundler_browser`, `bundler_bun`, `bundler_allow_unresolved` and the rest of `bundler_edgecase`.

Files: `src/options_types/package_aliases.rs` (new), `src/options_types/lib.rs`,
`src/options_types/context.rs`, `src/bundler/options.rs`, `src/bundler/bundle_v2.rs`
(`alias_substitute`, `alias_base`, `log_aliased_resolve_error`, the step in
`resolve_import_records`, the re-entry in `on_resolve`), `src/bundler/barrel_imports.rs`
(`resolve_records`), `src/ast/lib.rs` (`Log::add_resolve_error_with_note`),
`src/runtime/api/JSBundler.rs`, `src/runtime/api/js_bundle_completion_task.rs`,
`src/runtime/cli/Arguments.rs`, `src/runtime/cli/build_command.rs`,
`packages/bun-types/bun.d.ts`, `docs/bundler/index.mdx`, `docs/bundler/esbuild.mdx`,
`docs/snippets/cli/build.mdx`, `test/bundler/expectBundled.ts`,
`test/bundler/esbuild/default.test.ts`, `test/bundler/bundler_edgecase.test.ts`,
`test/bundler/bun-build-api.test.ts`, `test/bundler/cli.test.ts`,
`test/integration/bun-types/fixture/build.ts`.

### 2026-10-23: async fake timers for `bun test`, `advanceTimersByTimeAsync()` and the other three

With `jest.useFakeTimers()` a test moves the clock itself. The four functions that do it,
`advanceTimersByTime()`, `advanceTimersToNextTimer()`, `runOnlyPendingTimers()` and
`runAllTimers()`, fire the timers back to back inside one call. Code that awaits between timers
does not come along: the loop around `await sleep(100)`, the retry with a backoff, the timer
callback that is an `async` function all continue in promise callbacks, and those run after the
call. Jest and Vitest have an async variant of each function for that. Bun had none, so a ported
suite ended in `TypeError: jest.advanceTimersByTimeAsync is not a function`. oven-sh/bun#40990
lists them among the missing parts of the Vitest API that hurt most, and the port of sinon's
suite in `test/js/bun/test/fake-timers/sinonjs/` had two tests waiting for them. Now:

```ts
import { test, expect, jest } from "bun:test";

test("retries with a growing delay", async () => {
  jest.useFakeTimers();
  const request = jest
    .fn()
    .mockRejectedValueOnce(new Error("503"))
    .mockRejectedValueOnce(new Error("503"))
    .mockResolvedValue("ok");

  async function retry() {
    for (let delay = 1000; ; delay *= 2) {
      try {
        return await request();
      } catch {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  const result = retry();
  await jest.advanceTimersByTimeAsync(3000); // 1000 ms, then 2000 ms
  expect(await result).toBe("ok");
  expect(request).toHaveBeenCalledTimes(3);
});

await vi.advanceTimersToNextTimerAsync(steps);
await vi.runOnlyPendingTimersAsync();
await vi.runAllTimersAsync();

// The most timers that runAllTimers() and runAllTimersAsync() run. `timerLimit` is Jest's name.
vi.useFakeTimers({ loopLimit: 1000 });
```

The sync functions are not a substitute. In the test above, `jest.advanceTimersByTime(3000)`
runs no timer at all: `retry()` schedules its first timer in a promise callback, and that
callback has not run when the sync function looks for timers. Code that schedules its first
timer at once gets further, but only by where the test is in the event loop. The first test of
a file has the promise callbacks of a timer run before the next timer. A test body that has
awaited one real operation does not, because it then runs inside a promise callback itself.
Jest and Vitest never run them there.

The four functions follow `tickAsync`, `nextAsync`, `runAllAsync` and `runToLastAsync` of
@sinonjs/fake-timers, which Jest and Vitest call, turn for turn:

- Each waits a turn of the real event loop before the first timer and after every timer it
  fires. An advance over N timers takes N + 1 turns. A turn is a real `setImmediate`, which
  `useFakeTimers()` does not fake in Bun, so the immediates of the program and the turns of an
  advance run in the order they were queued, as they do with sinon on Node.js.
- `advanceTimersByTimeAsync(ms)` fires the timers of the next `ms` milliseconds and then moves the
  clock to the end of that window. The window is a span and not an instant: when something else
  moves the clock (a second advance in flight, a sync advance in a timer callback), the end of
  the window moves with it. `advanceTimersByTimeAsync(30)` and `advanceTimersByTimeAsync(10)`
  started together advance the clock by 40. `ms` is read like the sync function reads it, 0
  included (it fires `setTimeout(fn, 0)`).
- `runOnlyPendingTimersAsync()` looks for the last timer that is pending in its first turn, and
  advances to it. Timers that are scheduled meanwhile fire if they are due before it.
- `runAllTimersAsync()` fires timers until none is left. After 100,000 timers with more pending
  it rejects with Jest's `Aborting after running 100000 timers, assuming an infinite loop!`.
  The sync `runAllTimers()` has the same limit now and throws that error, where it used to spin
  on a `setInterval` with no test timeout able to stop it. That half is oven-sh/bun#42744 (open),
  taken whole with its tests. `useFakeTimers({ timerLimit })` sets the number. `loopLimit`,
  Vitest's name, sets it too, and 0 means the default. The option is read the way
  oven-sh/bun#44833 reads it, with its error messages.
- `advanceTimersToNextTimerAsync(steps = 1)` is Jest's: per step the next timer, then the other
  timers that are due at that instant, and it stops when no timer is left.
- While an advance is inside its window, a zero-delay timer is due 1 ms later, as it is inside a
  timer callback. So `while (!done) await Bun.sleep(0)` moves the clock on and ends.
- If the callback of a `setTimeout` or a `setInterval` throws, the promise rejects with what was
  thrown, and the error is not reported a second time. `advanceTimersByTimeAsync()` and
  `runOnlyPendingTimersAsync()` fire the rest of their window first and reject with the first
  error. What a later timer of the same call throws is dropped, which is sinon's
  `firstException = firstException || e`. `runAllTimersAsync()` and
  `advanceTimersToNextTimerAsync()` stop at the timer that threw. The throw of an
  `AbortSignal.timeout()` listener or a `Bun.cron()` callback is reported as an uncaught error,
  as before, and the promise resolves.
- Nothing is thrown at the call. Fake timers that are not active and an argument the sync
  function refuses reject the promise, with the wording of the sync function.
- On `vi` the promise resolves with `vi`, as in Vitest. On `jest` it resolves with `undefined`,
  as in Jest. One function object serves both, so the receiver decides, and a call without a
  receiver resolves with `undefined` (`const { advanceTimersByTimeAsync } = vi`, which is how
  @testing-library/user-event takes its `advanceTimers` option).
- An advance ends with its clock. After `useRealTimers()` or another `useFakeTimers()`, its next
  turn fires nothing, moves no clock and settles the promise. `clearAllTimers()` leaves it its
  window.
- An advance ends with its test file. One that nothing awaited, or whose test timed out, is
  still in flight when the file is over. Without `--isolate` the next file runs on the same
  thread and the same clock, and the advance went on there: it fired the timers of tests that
  never touched a timer function. Now the runner ends the advances in flight when a file is
  over, in every isolation mode. Their promises stay pending, so the code that awaits them does
  not go on in the next file. The clock itself stays as the file left it, as before.
- `Bun.ModuleGraph.dispose()` cancels the immediates of the graph, and with them the next turn of
  an advance that code of the graph started. The advance ends there as well.
- `expect(promise).rejects` and `.resolves` run the event loop inside the call. On the promise of
  an advance they return in the turn that settles it: that turn wakes the loop. Without the
  wake the loop waited for I/O, with a fake timer pending and nothing real due, until the idle
  timer of the garbage collector fired a second later, or until the test timeout.

Where it lives was decided by a design review before the code was written (5.8 hours), and the
first draft lost. That draft was an internal JS module behind four builtins, with small native
steps, the way `expect.poll()` is built. The review put it next to four other designs:

- Four more rows in the table of the sync functions, each a resolved promise around its sync
  twin (the shape of oven-sh/bun#40997). It only makes the names exist: the test above still
  times out, because the sync function inside runs no timer, and `runAllTimersAsync()` with a
  `setInterval` never returns.
- The JS module. It takes the same turns, but every process would carry four more builtins, one
  more internal module and a few more entries in the table of native functions that JavaScript
  can reach, and the state of an advance would be spread over Rust, TypeScript and C++.
- One rebuilt core for the sync and the async functions. The sync half fixes nothing and moves
  eight working functions onto new code.
- The native drive of oven-sh/bun#44833 (open, "bun test: Vitest compatibility"), which has the
  same four functions and takes its turns as event loop tasks of its own
  (`Bun__FakeTimers__postStep`) and not as immediates.
- No change.

What was built is the native drive with an immediate as its turn, all of it in `FakeTimers.rs`:

- Four rows in `FAKE_TIMERS_FNS`. A call validates, makes the promise, adds a `Drive` (plain
  data: an id, the context of the caller, which control, where it is, what is left of its
  window) and queues the first turn.
- A turn is a native function that `setImmediate` calls. It fires at most one fake timer through
  the `FakeTimers::fire` the sync functions use, and queues the next turn or settles. Of the
  sync drivers only `execute_all_timers` changes, for the limit: the async functions have a
  bounded pop of their own (`pop_due`, 8 lines).
- What outlives a turn (the promise, what it resolves with, the first error) is a JS array in
  the arguments of the pending immediate. Nothing on the thread roots a JS value, and an
  immediate that `--isolate` drops takes its advance with it.
- The list of drives is the one owner of the "inside a tick" rule: `min_delay_ms()` is 1 while a
  drive is in its window. Every way a turn can stop coming ends the drive: the turn itself, a
  change of clock, `cancel_timers` for a stopped context (`jsc_hooks.rs`), and the end of the
  file (`fake_timers::end_test_file()`, called from the guard in `TestCommand::run` that already
  forgets pending module mocks). The end of a file also sets a mark: the turn of an advance that
  started before it does nothing.
- Turns are queued through `Bun__Timer__setImmediate`, the exported function that `setImmediate`
  itself goes through, so `All::set_immediate` keeps its one call site.
- `Bun__JSTimeout__call` (`NodeTimerObject.cpp`) asks `Bun__FakeTimers__captureThrow` before it
  reports what a timer callback threw. The answer is yes only for the timer object that an async
  control is firing at that moment. That is one call in the branch of a callback that threw. An
  immediate that throws while that callback runs the event loop is still reported.

The shape of the drive (one entry per call, a step per event loop task, `Tick` / `All` / `Next`)
is the one oven-sh/bun#44833 has. That pull request is 112,000 lines, pins a preview build of
WebKit and is not merged. When it lands, this commit is dropped. Two more open pull requests
overlap: oven-sh/bun#42744 (the limit of `runAllTimers()`, which this commit now contains
whole) and oven-sh/bun#40997 (four rows that resolve at once around the sync functions, which
this commit replaces). If #42744 lands first, its hunks are upstream's and the rest stays.
Three more open pull requests change lines that this commit also changes: oven-sh/bun#46165 (a
zero-delay `setTimeout` is due at once), #41571 (the `steps` of `advanceTimersToNextTimer()`)
and #42000 (docs of the fake timer functions, in the same page).

Measured, on debug builds of the stack without and with this commit:

|                                                 | without  | with       |
| ----------------------------------------------- | -------- | ---------- |
| `Bun.jest()`: `Function` cells                  | 168      | 172        |
| `Bun.jest()`: `NativeExecutable` cells          | 161      | 165        |
| `Bun.jest()`: `Structure` cells                 | 215      | 223        |
| `Bun.jest()`: `FunctionExecutable` cells        | 1        | 1          |
| `Bun.jest()`: heap size (`heapStats()`, 3 runs) | 64,721 B | 66,193 B   |
| `size_of::<FakeTimers>()`, once per JS thread   | 48 B     | 96 B       |
| turns of an advance over 0, 3 and 1000 timers   |          | 1, 4, 1001 |
| `write` calls of 1,000 async advances           |          | 1,000      |
| `write` calls of 1,000 sync advances            | 0        | 0          |

So a test file that never calls them pays 16 cells (1,472 B) for the four functions on `jest`
and `vi`, like it pays for the nine sync ones, and a thread pays 48 bytes. A timer that is not
fake pays nothing: `min_delay_ms()` looks at the list of drives only after `is_active()`, and
the call in `Bun__JSTimeout__call` is behind `scope.exception()`. That is by reading the code
and by the debug build. The end of a test file is one call that clears an empty list.
`useFakeTimers()` with an options object reads two more properties, and `runAllTimers()` counts
its timers. An async advance reads one property more than it needs for its work (`vi` of the
module, to know what to resolve with), and the turn that settles it makes one `write` to wake
the event loop. The `write` calls are the `syscw` of `/proc/self/io`, read in the test process.
Not measured: instruction counts and the size of a release binary. valgrind, perf, strace and
bloaty are not in the build container, and no release build was made.

Against the reference: the copy of @sinonjs/fake-timers that Vitest 4.1.9 bundles ran 3,000
seeded scenarios on Node.js 26, and this build ran the same 3,000. A scenario arms up to 30
timers that re-arm from their callbacks, from promise callbacks, from `async` functions and from
immediates, call `process.nextTick`, nest a sync advance or throw (up to four timers of a
scenario throw, and 1,671 scenarios have a rejection), and then runs one to three of the four
controls, alone, two at once, or next to a sync advance. All 3,000 give the same log of events
with their fake times, the same final clock and the same number of pending timers. The two
orders that the design review wrote down are tests in the repository. The scenarios are not:
they need Node.js and sinon.

Not done, and what differs:

- A sync function still reports what a timer callback throws as an uncaught error, returns, and
  goes on with the other timers. Jest and Vitest throw it from the call, and oven-sh/bun#44833
  does. So the eight functions have two error contracts for now. The worst case is a sync
  advance inside a callback that an async advance fired: Jest 29.7 and Vitest 4.1.9 reject the
  async promise (16 of 16 combinations), and here the error is reported and the promise
  resolves. The capture slot of this commit is what the sync half needs, as its own commit. A
  `test.todo` holds the reference outcome.
- The sync functions are otherwise as they were: their flush still depends on the position in
  the event loop, and `advanceTimersToNextTimer()` fires one timer and ignores `steps`
  (oven-sh/bun#41571), where the async one fires every timer of the instant.
- Timers that Bun's own modules arm under the fake clock are fake. A `node:http` server that
  starts to listen arms a 30 second interval, so `getTimerCount()` goes from 0 to 1, and
  `runAllTimers()` and `runAllTimersAsync()` end at the limit. On Node.js, Jest and Vitest leave
  those timers real. The fix is in `All::insert` and is its own change (oven-sh/bun#37987, open).
  The docs say it, with the two ways around it, and a `test.todo` holds the reference outcome.
- An advance ends with its file, not with its test. One that nothing awaited, or whose test
  timed out, goes on firing timers in the later tests of the same file. That is what Jest and
  Vitest do on one clock, and a bound at the end of a test or at its timeout is a follow-up.
- `expect(promise).rejects` and `.resolves` wait inside the call. The order that Vitest allows,
  `const assertion = expect(result).rejects.toThrow()` before the advance, never returns, not
  even at the test timeout (Bun 1.4.3 does the same with a sync advance). The docs show the two
  orders that work, and two tests pin them. The repair is in the matchers and the runner:
  oven-sh/bun#33289, #46545 and #44833 carry it, and oven-sh/bun#14950 and #23420 ask for it.
- `expect.poll()` throws while timers are fake. `vi.waitFor()` and `vi.waitUntil()` are missing
  (oven-sh/bun#24715, #44328): they poll on a real timer and do not build on the drive.
- An advance waits one turn of the event loop for each timer, as sinon does. Code that does real
  I/O between two timers (a `fetch()`, a file read) has not scheduled its next timer by then, so
  one advance does not carry it through. The docs say so and show the loop that does.
- `setImmediate` cannot be faked. Code that awaits a real `setImmediate` between fake timers
  behaves as with sinon's `toFake` without `setImmediate`, which is not Jest's default.
- `useRealTimers()` in the middle of an advance drops the timers of the old clock, so the advance
  settles without firing them.
- Still missing on `vi`: `setSystemTime()` (on `jest` and the module only: a one-line alias that
  #40997 and #44833 both carry), `getMockedSystemTime()`, `getRealSystemTime()`, `runAllTicks()`,
  `advanceTimersToNextFrame()` and `setTimerTickMode()`. Of the 12 timer members that
  oven-sh/bun#40990 lists on `vi`, this commit adds 4.
- What flips on the day oven-sh/bun#44833 replaces this commit, by its code and its tests:
  - `vi.useFakeTimers()` gets Vitest's default limit of 10,000. Here `jest` and `vi` share one
    function and one default, Jest's 100,000.
  - `advanceTimersByTime(0)` and its async twin stop moving the clock by 1 ms, and
    `setTimeout(fn, 0)` is due at once (also oven-sh/bun#46165).
  - The end of a test file puts the real clock back there (unless a preload installed the fake
    one). Here it only ends the advances in flight.
  - The sync functions throw what a timer callback throws, and run no promise callback before
    they return.
  - `setImmediate`, `process.nextTick` and `queueMicrotask` can be faked there.
  - A turn is an event loop task of its own there and an immediate here. There an advance also
    sees a timer that the code arms after one real `setImmediate`. Here it does not, as with
    sinon on Node.js.
  - A second `useFakeTimers()` starts without the timers of the first there. Here they stay
    pending, as on upstream main.

  The 48 tests that #44833 has for the four async functions ran on this build: 44 pass, and the
  4 that fail are the last two points, once for `jest` and once for `vi`.

- In `sinonjs/fake-timers.test.ts` the `tickAsync`, `nextAsync`, `runAllAsync` and
  `runToLastAsync` blocks run now: 90 tests, 77 as sinon wrote them. 13 are `it.failing`, each
  with its reason in a comment: sinon resolves with the time of the clock (4), takes a time
  string (3) or no argument (1), fires one timer per `nextAsync()` where Jest's function fires
  the instant (3), and calls a timer callback with the global object as `this` (2). The helper
  got what the blocks use of sinon and mocha (spies over `jest.fn()`, `createClock()`,
  `loopLimit`, one `this` for a test and its hooks). With it three older tests of the
  directory pass that were `it.failing`.

Before the push a review read the finished commit, ran it against Jest 29.7, Vitest 4.1.9 and
the tests of oven-sh/bun#44833, and mutated it. Self-reviewed: 36 concerns raised, 36 addressed,
28 by code or tests and 8 by text. What changed because of it:

- `jest.*Async()` resolves with `undefined`. It resolved with `jest`, which no reference does.
- A second throw in one advance is dropped. It was reported, which failed tests that pass on
  Jest, on Vitest and on #44833.
- The limit option is whole: it bounds `runAllTimers()` too, `loopLimit` is read, and 0 is the
  default. It bounded the async function only and refused 0.
- An advance ends with its test file, and with a `Bun.ModuleGraph` that is disposed. A counter of
  the advances inside a window went away with that: the list of drives is read instead, so the
  count cannot go stale when a turn never comes.
- The turn that settles an advance wakes the event loop, so `expect().rejects` on its promise
  returns.
- A comment that gave a false reason for an `unsafe` block, and a block that had none (a
  deny-level clippy lint), became one helper with the real invariant.
- 48 more tests in `fake-timers.test.ts`, and sinon's own: a test for each mutation that
  survived the first suite, the identity check of the throw capture (a two-byte patch of the
  binary that removes the check now fails a test), garbage collection between the turns, a
  control inside the callback of another, `Bun.cron()` under three controls, the end of a file.
- The docs lost a sentence that was false for its own example, and say what the review found
  users will meet next (the list above).

Parts of it that were not taken: a Worker test (3 to 5 seconds on a debug build for a path the
other tests cover), mordant in the lint workflow of the fork, and splitting the two meanings of
`Drive::count`. The changes that the review itself put into later commits are in the list
above.

Tests: `test/js/bun/test/fake-timers/fake-timers.test.ts` has 112 new tests (191 in all,
with one that needs a release build and two `test.todo`). 105 of the new ones fail on
Bun 1.4.3, and the rest pin behaviour that the commit must keep (a limit that is not reached,
0 as the default). `describe("async timer controls")` covers each function on `jest` and `vi`,
in the first test of a file (a subprocess) and after a real `await`, the two orders above, the
window (first turn, two advances in flight, a nested sync advance, an overdue timer), the
zero-delay rule inside and after a window, every error path per function, the first error
of several, the limit at 50 timers (at it and past it), what `useRealTimers()`,
`useFakeTimers()` and `clearAllTimers()` do to an advance in flight, the end of a file, a
disposed `Bun.ModuleGraph`, garbage collection between turns, a call without a receiver,
`AbortSignal.timeout()`, `Bun.cron()`, the iterator of `timers/promises`, and real turns
between timers. `describe("runAllTimers")` has the tests of oven-sh/bun#42744 for the limit and
the option. With the commit the whole directory passes on the debug build (309 tests, and
350 are todo), as do `test-timers.test.ts`, `expect-poll.test.ts`,
`in-process-cron.test.ts`, `node-timers.test.ts`, the `setImmediate` and `microtask` files of
`test/js/web/timers/`, the `callbacks`, `gc` and `io` files of `test/js/bun/module-graph/`,
`rerun-each.test.ts`, `isolation.test.ts` and `test-timeout-behavior.test.ts` of
`test/cli/test/`, the type tests and the source lints. The new tests pass with
`BUN_JSC_validateExceptionChecks=1`, and `cargo clippy -p bun_runtime` is clean.

What failed, and why it is not the commit:

- Four leak tests fail on this debug build with and without the commit. The three of
  `setTimeout.test.js` allow an ASAN build 192 MB and take only a binary named `bun-asan` for
  one, so `bun-debug` gets the 10 MB limit. The one of `setInterval.test.js` runs out of its 30
  seconds.
- Tests that need more time than they have on a debug build: four `dynamicImport` tests of
  `module-graph.test.ts` (they pass with a longer limit) and two of `timer-gc-roots.test.ts`,
  which do not use fake timers. One test of `module-graph.test.ts` that compares timings failed
  in a run of the whole file and passes alone.

`fake-timers.test.ts` takes about 25 seconds on the debug build and took about 12 before, so it
is further over the 10 second budget of a test file there. Its time on a release build was not
measured.

Built and run on Linux x64 only, as a debug build with ASAN. `cargo check -p bun_runtime`
passes for `x86_64-pc-windows-msvc` and `aarch64-apple-darwin`, and nothing was run there.

Rebase notes: upstream moved by 37 commits to 5c6d4e24cd. One of them, oven-sh/bun#46329, moved
the last 61 classes to schemas of the bindings generator and deleted `generate-classes.ts` with
every `.classes.ts` file, the `#[bun_jsc::JsClass]` macro and the `host_fn(method)` thunks. 20 of
the 59 patches needed a hand merge, and nothing was dropped. The rebased stack was pushed on its
own first (aaf380e985), and the three workflows of the fork passed on it.

- Four patches had edited a `.classes.ts` file:
  - `.lines()` (2026-08-18): `lines: { builtin: true, length: 0 }` in `Blob.bind.ts`.
  - `expect.poll()` (2026-09-08): `poll: { builtin: true, length: 2 }` in the `static` table of
    `expect.bind.ts`. The generator refused a builtin there and has a test for the refusal. It
    takes one now: three lines in `bindgen-lib-internal.ts` and `bindgen-emit.ts`, with the test
    and the table in `docs/project/bindgen.mdx` changed to match.
  - `.kill()`, `.signal()` and `.timeout()` for `$` (2026-09-15): `kill` and `setKillSignal` are
    members of `ParsedShellScript.bind.ts` and `interpreter.bind.ts`. Upstream also replaced the
    counter of pending activity with a reference to the wrapper that is strong while the script
    runs, so "is running" in `Interpreter::kill` reads that reference, and a script that was
    killed before it ran upgrades it before it finishes.
  - `redis.multi()` (2026-10-20): `multi` and `exec` are two rows of the command table in
    `valkey.bind.ts`, and `transactionParent` is an internal field there. A schema file can only
    export what it generates, so the list of what a transaction does not queue moved to
    `test/js/valkey/transaction-not-queueable.ts`, where the lint and `valkey.test.ts` read it.
    Upstream's new test that compares every schema with the published types lists `exec` as a
    member that `class RedisClient` does not declare.
- Classes whose methods upstream re-signed for the generator, with this stack's code inside them:
  `Bun.Archive` (2026-09-02: the constructor and `Archive.write` parse `format`), the `append`
  option (2026-08-29: `Bun.s3.write` moved to `S3Client::static_write`), S3 metadata
  (2026-09-27), `expect.addSnapshotSerializer()` (2026-09-22: upstream's stub in
  `expect.bind.ts` takes the serializer now) and `bun test --reporter=json` (2026-08-24).
- Response compression for `Bun.serve` (2026-09-04) merged and did not compile: the server's
  config is in a `JsCell` now, so `reload()` sets `compress` through `with_mut`.
- "Did you mean" (2026-08-28): upstream shows `bun lint` on canary builds only
  (`lint_command::IS_ENABLED`). The table of root commands has that arm, and a build without the
  command does not suggest it.
- `publishConfig` (2026-09-11) and `jsr:` (2026-10-18): upstream split `add_own_package` out of
  `add_bundled_dep` in `pack_command.rs`. The check for what makes a package.json need an edit
  is in the new function.
- `alias` (2026-10-21): upstream prints a `bun:` specifier that names no builtin as it is
  written. The branch reads the alias value there as before.
- Lines next to lines: `Bun.INI.parse()` (two lists), `import.meta.glob()` (the transpiler cache
  is at version 44), Web Storage (`ZigGlobalObject.lut.txt`), `Bun.unescapeHTML()` (the table in
  `BunObject.cpp`), `while` and `until` (`Parser::new` returns the parser), `node:sea`
  (`ErrorCode.ts`) and the `jsr:` line in `docs/pm/overrides.mdx`.

After the rebase 80 test files of the stack were run on the debug build, every file that a patch
adds or changes except the registry suite of `bun outdated --json`. Against a local Redis 8.0.2
with the ports and users of the test image: `valkey.test.ts` (1084), `connection-failures`
(90) and `valkey-gc` (26). What failed, and why it is not the stack:

- Tests that need more than their 5 seconds on a debug build and pass alone or with a longer
  limit: 39 of `module-graph-isolation.test.ts`, the six recursive scans of `glob/scan.test.ts`,
  three `bun pm ls` tests, one each in `bun-test.test.ts` and `bun-write.test.js`, the two
  high-volume pub/sub tests of `valkey.test.ts` and two of `valkey-gc.test.ts`.
- Tests that assume a timing the debug build does not have: the worker ids of `parallel.test.ts`
  (one pass in three runs), "run in parallel" of `filter-workspace.test.ts`, and one `--hot` test
  that saw two reloads for one write.
- The sandbox: the connection timeout test of `connection-failures.test.ts` gets `Connection
closed` at once for 192.0.2.1 (so does Bun 1.4.3), the MySQL half of `sql-debug.test.ts` is
  refused as `root@localhost`, and one upstream snapshot test expects colors.

After this sync upstream moved by three more commits, to a8b5e920c4, and this run did not rebase
the stack over them. One is oven-sh/bun#46540, which moved every Rust function that takes a
`CallFrame` to a schema of the bindings generator and deleted `#[bun_jsc::host_fn]`, `$rust` and
`$newRustFunction`. Seven patches use what it deleted, so the next sync moves them by hand:
`expect.poll()` (2026-09-08), `expect.addSnapshotSerializer()` (2026-09-22), `--watch-path`
(2026-09-24), watch mode for `Bun.build` (2026-10-09), `Bun.unescapeHTML()` and
`performance.eventLoopUtilization()` (2026-10-15), and this one. For this one the four async
functions, the function of a turn and the two limit options go into upstream's new
`FakeTimers.bind.ts`, whose options dictionary has only `now`. The async functions take their
arguments as `b.any`: they reject where a schema would throw.

Files: `src/runtime/test_runner/timers/FakeTimers.rs` (`Drive`, `FakeTimers::turn`, `pop_due`,
`fire_capturing`, `async_control_turn`, `start_async_control`, `async_control_value`,
`advance_ms`, `end_test_file`, `end_drives_of`, `timer_limit`, the limit in
`execute_all_timers`), `src/runtime/cli/test_command.rs` (the call at the end of a file),
`src/runtime/jsc_hooks.rs` (`cancel_timers`), `src/jsc/bindings/NodeTimerObject.cpp`,
`packages/bun-types/test.d.ts`, `docs/test/dates-times.mdx`, `docs/runtime/cron.mdx`,
`test/js/bun/test/fake-timers/fake-timers.test.ts`,
`test/js/bun/test/fake-timers/sinonjs/fake-timers.test.ts`,
`test/js/bun/test/fake-timers/sinonjs/helpers/setup-tests.ts`,
`test/js/bun/test/fake-timers/sinonjs/issue-347.test.ts`,
`test/js/bun/test/fake-timers/sinonjs/issue-516.test.ts`,
`test/js/bun/test/fake-timers/sinonjs/issue-67.test.ts`,
`test/js/bun/test/fake-timers/sinonjs/MIGRATION_NOTES.md`,
`test/integration/bun-types/fixture/test.ts`.

### 2026-10-25: server-side copy for S3, `copy()` and `copyTo()`

Bun's S3 client could not copy an object inside the service. `write()` with an S3 file as its
data downloads the object and uploads it again, and there was no other way: no request of the
client could carry `x-amz-copy-source`. oven-sh/bun#29595 (open since April, 8 upvotes) asks for
"a first-class server-side copy operation" as the second of its four items, and one comment there
describes the pipeline that needs it: an upload goes to a quarantine key, is scanned, and is then
promoted to its final key with CopyObject and `x-amz-copy-source-if-match`, so that the bytes that
passed the scan are the bytes that are promoted. That team keeps `@aws-sdk/client-s3` installed
for this one call, because a download and an upload do not fit in a 256 MB pod and lose the
condition. No pull request, open or closed, has the header. Now:

```ts
import { s3, S3Client } from "bun";

// two keys in the bucket of the client
await s3.copy("uploads/photo.jpg", "archive/photo.jpg");

// from a file: to a key next to it, or to another bucket
const photo = s3.file("uploads/photo.jpg");
await photo.copyTo("archive/photo.jpg");
await photo.copyTo("photo.jpg", { bucket: "backups" });
await S3Client.copy(photo, backups.file("photo.jpg"));

// promote the object that the scanner read, and no other
const upload = await fetch(s3.presign("quarantine/upload.bin"));
const etag = upload.headers.get("etag");
if (!upload.ok || !etag) throw new Error("cannot read the upload");
await scan(upload.body);
await s3.copy("quarantine/upload.bin", "files/upload.bin", { copySourceIfMatch: etag });

// a new object with its own type and metadata, or the same object in another storage class
await s3.copy("uploads/scan-0001.bin", "reports/january.pdf", {
  metadataDirective: "REPLACE",
  type: "application/pdf",
  metadata: { reviewed: "yes" },
});
await s3.copy("logs/2025.tar", "logs/2025.tar", { storageClass: "GLACIER_IR" });

const { etag: copied, lastModified } = await s3.copy("a.txt", "b.txt");
```

A copy is one CopyObject request: a `PUT` of the destination that has no body and names the
source in a header. It is signed with the credentials of the destination and goes to the endpoint
of the destination. The promise resolves with `{ etag, lastModified }` from the answer, the entity
tag in its quotes as `stat()` has it. Against the S3 server of the tests, a copy of 1 MiB is
one request with no body, where `write(key, s3.file(source))` is two requests and 1 MiB in each
direction.

There are three ways to call it, and they are one function underneath. Each has one rule for
where a key is:

- `client.copy(source, destination, options?)`, and so `Bun.s3.copy()`: two keys in the bucket of
  the client, or in the `bucket` of the options. As every other method of a client, it takes no
  `S3File`.
- `file.copyTo(destination, options?)`: the destination is an `S3File`, or a key at the endpoint
  and in the bucket of the file, with the credentials of the file. Nothing else of the file goes
  to the new object: not its `acl`, its storage class, its type or its metadata.
- `S3Client.copy(source, destination, options?)`: each is a key or an `S3File`. A destination key
  is read with the environment and the options, as in the other static methods, also next to a
  source `S3File`. A source key is read with the credentials of the destination.

A key is a path as in each other method: with credentials that have no `bucket`, its first part is
the bucket.

The options are those of the destination, as the options of `write()` are those of the object it
makes: its credentials, its `bucket`, its `acl` and `storageClass`. A source that is a key is in
the bucket of the destination, so `client.copy("a", "b", { bucket: "other" })` copies inside
`other`. A source in another bucket is an `S3File`, which knows its bucket. The AWS SDK has the
same two parts: its request is addressed to the destination, and the source is a path that has
its own bucket in it. `requestPayer` is the one option that is for the request and not for the
object: the request reads the bucket of the source too. So Bun sends it when the destination has
it, or the `S3File` of the source, and a call can still say `false`.

What the new object is made of follows CopyObject:

- Without `metadataDirective` it has the `type`, the `contentDisposition`, the `contentEncoding`
  and the metadata of the source, and each other header that the service keeps. The request sends
  none of them. `metadataDirective: "COPY"` is the same copy, and the request says so in
  `x-amz-metadata-directive`, for a bucket policy that asks for the header.
- With `metadataDirective: "REPLACE"` the copy stores what an upload to the destination stores:
  the four of the call, then the metadata of the file or of the client and the type of the file,
  then the type that the extension of the key gives. One test compares the headers of a copy
  with the headers of `write()` to the same destination, for settings on the client, on the file
  and on the call.
- `"REPLACE"` is all or nothing on the service. The new object has only what the request sends,
  so the `Cache-Control`, `Content-Language` and `Expires` of the source are gone too, and Bun
  has no option that sets them. That is why Bun does not turn it on for the caller: a call that
  has one of the four options without `"REPLACE"` throws. The other choices were weighed.
  To ignore the option (the REST API, the SDK) is a copy that did not do what the call said. To
  replace without a word (aws-cli v1 with `--metadata`) loses the headers that the call did not
  name. To read the source first and give everything again (aws-cli v2, rclone) is a second
  request, and needs three options that Bun does not have.
- The `acl` and the `storageClass` are never those of the source. The service takes them from the
  request, so they are the ones of the call, of the file or of the client, as for an upload. That
  is also how an object changes its storage class: a copy onto itself with `storageClass`.

Four options are conditions on the source: `copySourceIfMatch`, `copySourceIfNoneMatch`,
`copySourceIfModifiedSince` and `copySourceIfUnmodifiedSince`, named after the fields of the AWS
SDK. A time is a `Date`, as in the SDK, and goes out as an HTTP date. The first build took a
string too and sent it as it was. The self-review showed that a service does not apply a time
that it cannot read, so `"garbage"` made a copy without a condition. Only `undefined` is no
condition: `null` throws, because `headers.get("etag")` is `null` for a response that has no
entity tag, and an entity tag of spaces throws as an empty one does. `new Date(0)` is a date. A
date after the year 3000 throws: the writer of HTTP dates that Bun has does not check the result
of `gmtime_s`, which on Windows has no later year (read in the source, not run on Windows).

An error of a copy is an `S3Error` with the source in `path` and the destination in `dest`, which
is what `fs.copyFile()` gives its errors. `dest` is set where the copy fails, as a property that
a program can delete. The struct that the other eleven S3 callbacks share with C++ is as it was.
Two answers need care. CopyObject can answer 200 and carry an `<Error>` document, which is an
error here, through the check that CompleteMultipartUpload already had. And a 200 that is neither
that nor a `<CopyObjectResult>` (the page of a proxy) is the error `InvalidResponse`, not a
success with an empty entity tag. The arm of CompleteMultipartUpload still resolves for such a
page. That is upstream's behaviour, oven-sh/bun#34044 and oven-sh/bun#45701 are about it, and
this commit does not change it.

What rejects without a request, as in each other method: credentials without a key pair
(`ERR_S3_MISSING_CREDENTIALS`, and before the keys are looked at), and a source or a destination
that has no key or no bucket (`ERR_S3_INVALID_PATH`). Both are an `S3Error` with `path` and
`dest`. What throws before a promise exists:

- an argument that is not a key or an S3 file;
- a `slice()` for the source or the destination: CopyObject has no range;
- a source `S3File` at another service than the destination. The request goes to the
  destination, and a service answers 200 for a key of its own that has the same name. The design
  review saw exactly that against two servers: the copy of a stale object, and no error. Amazon
  S3 is one service in each of its three partitions, whatever the region, and a host of Amazon is
  Amazon S3 only with an `s3` label: MinIO on the host name of an EC2 instance is not. R2 is one
  service in each account and jurisdiction. Another service is one host and one path of the
  endpoint, without the bucket of a virtual hosted-style host name. The scheme is not a part of
  it;
- a `bucket` that is not the bucket of a virtual hosted-style host name. Each other method of
  such a client sends its request to the host and does not read `bucket`. A copy has to name its
  source as a bucket and a key, so the first build read `bucket` there, and one `S3File` was one
  object for `text()` and another for `copyTo()`. Now Bun reads the bucket from a host name of
  Amazon S3 or of R2, which say where it is, and needs `bucket` to be the first part of another
  host name. An access point, a PrivateLink host and a proxy whose host name does not start with
  its bucket cannot be the source of a copy;
- an option of the four without the directive, as above;
- a condition of the wrong type or value, as above;
- more than 232 metadata keys with `REPLACE`, from the call, the file or the client: an upload
  takes 238, and a copy can add six headers of its own to the 250 that the HTTP client sends.

Where it lives was decided by a design review before the code was written (4.5 hours). It traced
the request through 16 frames and found four places that have to change in any design: the
surface, one request function, the signer, and the reader of the answer. It compared six
designs:

- Sign the copy as a presigned URL, which already signs extra headers (the smallest patch). A
  bucket policy that requires `s3:authType=REST-HEADER` answers 403 to it, the signature and the
  session token are in the URL and in the verbose log, and a session token of 2,000 bytes is
  refused where header signing takes it.
- One flag per header in `SignedHeadersKey`, as the other signed headers have. The list of a full
  copy is 320 bytes and the buffer for it has 256, and `SignResult` would grow by 96 bytes in
  every S3 request.
- An open sorted list of extra headers that is merged into the canonical request after it is
  written. It reads the canonical request back on every copy, nothing can test its order, and the
  rewrite of oven-sh/bun#45440 leaves it nothing to read.
- A signer around one ordered header list for every request. That is the shape of botocore and of
  oven-sh/bun#39210 (open), and oven-sh/bun#46746 calls a generic sorted list "the right end
  state". Nothing in a copy needs it, and a new abstraction across the signer is for the
  maintainers to agree to first.
- CopyObject with a second path through UploadPartCopy for a slice or for more than 5 GB: a
  second multipart state machine that nobody asked for.
- No change.

It also ruled on `Bun.write(s3File, otherS3File)`: that stays a download and an upload. For an
object that is stored with `Content-Encoding: gzip`, the download decodes, so `write()` stores
4,096 decoded bytes where a copy stores the 40 bytes of the source, and oven-sh/bun#46863 (open)
pins the two requests of `write()` with a test. The docs of a copy say what `write()` stores.

What was built is the design it picked. The six copy headers are a closed set, named in one new
file of the signing crate (`src/s3_signing/copy.rs`), and they travel in the sorted list of signed
headers that the metadata patch of 2026-09-27 gave the signer:

- The list has a type of its own now, `AmzHeaders`. `Metadata` was that list, and six headers
  that are not metadata do not belong in a type of that name. `Metadata` keeps `insert()` for an
  `x-amz-meta-*` key and derefs to the list. The signer and the request options take the list.
  This is a name and not the generic list of the fourth design: the list is for the headers that
  sort between `x-amz-content-sha256` and `x-amz-request-payer`, and a constant assertion checks
  at compile time that each of the six names does.
- `CopyHeaders` takes the credentials and the path of the source, the four conditions and the
  directive, and gives back the list: the copy headers and, for `REPLACE`, the metadata, sorted
  by name.
- The value of `x-amz-copy-source` is `bucket/key` by the rule the signer has for the path of a
  request (one leading slash off, the bucket of the credentials or the first part of the path,
  slashes trimmed, `\` read as `/`, percent-encoded), so that a copy reads the object that
  `stat()` of the same key describes. The first build had a copy of that rule. Now the rule is
  one macro, `bucket_and_key!`, that `sign_request` and the copy both expand. A macro and not a
  function, because the macro leaves the machine code of `sign_request` as it was and a function
  does not (the self-review built both: 0 and 3,671 lines of disassembly differ).
- An endpoint can have a path, and `sign_request` puts it before the bucket and the key. Amazon S3
  and R2 have the S3 API at the root of a host, so there the path is a part of where an object is
  and the source has it. In another host the path is where the S3 API is, as the docs have it for
  Supabase, and the source does not have it.
- The two functions that write the signed headers, `SignedHeaders::write` and
  `CanonicalRequest::format`, test for the list before they write `x-amz-content-sha256` and
  `x-amz-date`, where they tested after. A request without a list writes the two names as one
  literal, as before. A request with a list writes `x-amz-content-sha256`, the entries that sort
  before `x-amz-date`, `x-amz-date`, and the rest. Metadata is all in the rest, and one compare of
  the first name says so.
- `SignResult`, `SignedHeadersKey` and the presign branch are as they were.
  `execute_simple_s3_request` is too: it already adds each entry of the list to the request after
  it is signed.
- The answer has its own arm, `Callback::Copy`. The request is `s3::client::copy`, a wrapper as
  `stat` and `delete` have one. The arguments, the options and the promise are in
  `src/runtime/webcore/s3/copy.rs`.

The window of the list is what it can carry later without a change of the signer:
`x-amz-copy-source-range`, the headers of a source that is encrypted with a key of the customer,
grants, object lock and `x-amz-expected-bucket-owner` sort inside it. `x-amz-checksum-algorithm`
sorts before `x-amz-content-sha256`. `x-amz-tagging` and `x-amz-tagging-directive`, the
encryption of the destination, the website redirect and `x-amz-source-expected-bucket-owner` sort
after `x-amz-request-payer`. None of those fits. The first of them needs the writers to split at
the fixed names around the window as they now split at `x-amz-date`, or the generic list.

What it costs a program that never copies, on two release builds (the stack without this commit
and with it, same toolchain):

|                                                                        | without                                      | with                    |
| ---------------------------------------------------------------------- | -------------------------------------------- | ----------------------- |
| `sign_request::<false>` (disassembly)                                  | 3,416 instructions, 299 conditional jumps    | the same, none differs  |
| `SignedHeaders::get`, `execute_simple_s3_request`, the `stat()` thunk  | 68, 756 and 145 instructions                 | the same, none differs  |
| `CanonicalRequest::format` for a `stat()`, callees included            | 2,780 instructions, 494 conditional branches | 2,779, 494              |
| the same for an upload without metadata                                | 2,776, 494                                   | 2,775, 494              |
| the same for an upload with 1, 3 and 10 metadata keys                  | 3,414, 4,678 and 9,232 instructions          | 3,529, 4,795 and 9,356  |
| `SignedHeaders::with_metadata` for an upload with 3 keys               | 241 instructions, 42 conditional branches    | 312, 47                 |
| `S3HttpSimpleTask::on_response` for a `stat()`, its own body           | 190 instructions, 24 conditional branches    | 190, 24                 |
| `SignResult`, `SignOptions`, the request options, the task, `Metadata` | 488, 128, 144, 3,176 and 24 bytes            | the same                |
| 21 requests and 4 presigned URLs, recorded with a fixed clock          |                                              | 0 of 25 lines differ    |
| host functions of `S3Client` and `S3File`                              | 20                                           | 23                      |
| binary (`size`, text)                                                  | 108,623,540 bytes                            | 108,656,564 bytes       |

The disassembly is `objdump` of the two binaries without addresses. In `sign_request` the only
lines that differ are two calls of `encode_uri_component`, which has the same body under another
mangled name, because the signing crate now instantiates it itself. The instruction
counts are one call that was single-stepped in gdb, the third of its kind, with the clock fixed
by a preload shim. They repeat exactly for these functions. The count of a whole `stat()` or
`write()` call does not (29,191 to 29,203 for `stat()` on one binary), so it is not in the table:
the two binaries are inside each other's range.

So a request without metadata runs the instructions it ran. An upload with metadata pays about
190 instructions more for its signature, 115 to 124 in `format` and 71 in `with_metadata`, with
12 more conditional branches and no allocation: `split_at_date` is 61 instructions in each of the two writers, and the loop over the
entries is now a function of its own. A whole `write()` with three metadata keys is about 66,500
instructions.

The binary is 33,024 bytes larger for three host functions (`client.copy`, `S3Client.copy`,
`copyTo`), three table rows and the code behind them: 28,613 bytes in 27 new functions, 148 bytes
in seven functions that were there (`on_response` with its new arm, the two writers,
`Metadata::insert`), and tables, strings and alignment for the rest. The first build was 34,304
bytes larger. Of those, 7,644 were in the eleven S3 callbacks that never copy: a fourth field in
the error struct had changed what the compiler inlines there. With `dest` set where a copy
fails, no function outside the seven changed its size.

What a copy itself costs, on the debug build: 40 calls of the allocator from the call to the
return of the promise (64 with four conditions, `REPLACE` and three metadata keys), where
`stat()` makes 28. The 12 more are the two keys, each of which becomes a file of its own with a
copy of the credentials. In the release build the call is about 35,800 instructions, where
`stat()` is about 29,200.

Not done, and what differs:

- One request copies at most 5 GB on Amazon S3. For more, the service answers `InvalidRequest`
  and Bun passes it on. This is the lasting limit of `copy()`, not a first step: a copy in parts
  (UploadPartCopy) carries nothing of the source over, so it would need a read of the headers and
  the tags of the source and options that Bun does not have, and it would answer 200 for a copy
  that lost them above 5 GB and kept them below. `write()` with the `S3File` is the route above
  5 GB, and the docs say what it stores.
- No `versionId` for the source. It is a suffix of the value of `x-amz-copy-source`, so the
  signer does not change for it.
- No `x-amz-tagging-directive`, see the window above. It belongs with the `tagging` option of
  oven-sh/bun#46746. Once `S3Options` has `tagging`, `S3CopyOptions` inherits an option that a
  copy does not send, and a copy has to throw for it as it does for `type` without `REPLACE`.
- `stat()` does not return the `contentDisposition` and the `contentEncoding` of an object, so a
  `REPLACE` in place reads them with a `HEAD` through a presigned URL, as the docs show. The
  self-review asked for the two fields on `S3Stats` in this commit. They are a feature of their
  own, with `cacheControl` and the others of oven-sh/bun#29595.
- A `<CopyObjectResult>` without an entity tag or without a time resolves, with an empty string
  or an invalid `Date`. The service made the copy, so the promise does not reject.
- A copy is not retried by the S3 client, like `stat()` and `delete()`. The HTTP client under it
  sends a request again when a connection that it used before closes before the answer, and the
  service checks the conditions again. The docs say so, and one test pins it.
- With `REPLACE`, the `contentDisposition` and `contentEncoding` that were given to `file()` or
  to `new S3Client()` are not sent, because `write()` does not send them either
  (oven-sh/bun#46863 repairs that for uploads, and the test that compares a copy with an upload
  fails on the day the two differ).
- `fetch()` with `PUT` to an `s3://` URL still drops the headers of its caller, so a copy that
  is made by hand there stores an empty object and answers 200. That is older than this commit
  and is reported upstream.
- A program that added its own `copy` to `S3Client.prototype` or `copyTo` to an `S3File` now
  shadows or is shadowed by these.
- Nothing here ran against Amazon S3, R2 or MinIO. Each statement about a service is from the
  in-repo server, which follows the documentation of Amazon S3, and the docs name Amazon S3 where
  they state its limit and its error codes.

Self-reviewed before the push (5.3 hours): 39 concerns raised, 37 addressed, none against
the design. The ones that changed behaviour are above: one rule for the bucket and the key of a
source, the bucket of a virtual hosted-style host, the scheme, `Date` only, `null`, an explicit
`"COPY"`, `requestPayer` of the source, `copyTo(key)` without the settings of the file, errors
that reject where they threw, `dest` outside the shared struct, and the type of the list. It
also found that the test server accepted signed headers in any order, so a header that both
writers misplace the same way got 200. `verify()` in `test/packages/s3-server` now sorts the
names as the service does, a request that lists them in another order gets
`SignatureDoesNotMatch`, and the 2,057 tests of that package pass. Not taken: the two fields on
`S3Stats` (above); a change of the HTTP client so that a conditional copy is not sent twice (the
docs and a test state it); one function for the defaults of a file and of a client, named as
oven-sh/bun#46746 names them (that pull request rewrites those lines, and the test that compares
a copy with an upload guards them until then); a test under a bucket policy for the explicit
`"COPY"` (the header and its signature are tested).

A second, short check looked only at what the first one had changed (four reviewers, half an
hour) and found 18 more things, of which 17 are fixed. Four were copies of another object than
the one that `stat()` of the same file reads: an endpoint of Amazon S3 or of R2 with a path, a
bucket whose name ends in `.s3`, a `bucket` option that is the first label of a longer bucket
name in a `s3-fips` host, and two MinIO servers on EC2 host names, which the first fix took for
Amazon S3. The others: two endpoints of one host with different paths were one service, the
range of a date (above), a `Buffer` key that a getter of the options could change, an error
that named the wrong argument, three checks in the tests that could not fail, a worker test
close to its time limit, and five statements in the docs. The one not taken is the empty
`<CopyObjectResult>` (above).

Open for a maintainer, if this goes upstream: that `client.copy()` takes keys only, the option
names of the AWS SDK (`copySourceIfMatch`) or shorter ones, `{ etag, lastModified }` as the
result, and the window of the list or a generic list in the signer.

Tests: `test/js/bun/s3/s3-copy.test.ts` (new, 41 tests) runs against `test/packages/s3-server`,
which verifies the signature of every request and refuses an `x-amz-*` header that is not
signed. It covers the ways to call it with keys and with files, the one request without a body,
what the new object stores with and without the directive (read from the store of the server),
the stored bytes of a gzip object, the headers that `REPLACE` drops, a copy against an upload,
the whole list of signed headers of a copy that has every header, each condition and which of two
decides, the dates at both ends of the range, nine odd keys in both directions
(`sp ace+plus?.txt`, `100%.txt`, `dir/sub/`, `a\b.txt` and others), sources in other buckets, a
Requester Pays bucket of another account, virtual hosted-style endpoints with and without
`bucket`, eight forms of host names of Amazon S3 and of R2 and endpoints with a path (through an
HTTP proxy in the test, in a child process), the hosts that are not one service, credentials
from the `S3_*` and the `AWS_*` variables with a session token, two key
pairs in one copy, the errors with `path` and `dest`, the error for more than 5 GB, a 200 with an
`<Error>`, white space before the result and a page that is neither, what rejects and what throws
before a request, a connection that closes, a request that goes out again, four workers that stop
with 24 copies in flight each, the metadata limit at 232 and at 233 keys (the request at the
limit is read from a raw socket, because `Bun.serve` takes 200 header fields), and 24 copies at
once with a garbage collection on each side. All 41 fail on Bun 1.4.3 and on the
release build of the stack without this commit. The file takes 1.2 seconds on the release build
and 10 on the debug build.

Rows for a copy are also in `s3-moved-store.test.ts` (five: a getter of the options moves and
frees the store of the source, of the destination, or of both), in the missing-credentials block
of `s3.test.ts`, in `s3-argument-validation.test.ts` and in the S3 fixture of
`module-graph-isolation.test.ts` (a copy after the graph is disposed sends nothing).
`test/packages/s3-server/test/auth.test.ts` has the row for the order of the signed headers,
which fails without the change of the server.

Also run on the debug build: the 24 files of `test/js/bun/s3` (553 pass, and 278 need the
credentials of a real service), the new file with `BUN_JSC_validateExceptionChecks=1`, every
snippet of the docs and of the JSDoc (26 copies, in a child process that has the credentials in
its environment), the type tests and the source lints. `cargo fmt`, `clang-format` and `bun fmt`
are clean, and so is the rule of upstream's comment-cop workflow: no comment of two lines or more
in `src/`.

What failed, and why it is not the commit. `s3-list-objects.test.ts` has one test that runs out
of its 5 seconds when the whole directory runs on the debug build, next to a test that parses a
large listing for 12 seconds. It passes when the file runs alone (40 of 40). Two source lints of
the type checker's parser run out of 5 seconds on the debug build and pass with the released
binary, which is how the workflow of the fork runs them (187 of 187).

Built and run on Linux x64 only. Nothing in the commit is specific to a platform.

Relation to open pull requests of upstream. This commit needs the metadata patch of 2026-09-27
(a0b5974ef8) under it, so a cherry-pick onto upstream is the two commits. It reuses the sorted
list of that patch, its heap path for a long canonical request and its loop that adds the entries
to the request. That design is oven-sh/bun#26154 by Ciro Spaciari, closed unmerged. The pair
applies to oven-sh/bun 179664ea89 with a conflict in SOUP.md only. That holds until one of these
merges, and none has a review of a maintainer:

- oven-sh/bun#46746 (`tagging`, and one carrier for the headers of an upload) and
  oven-sh/bun#46863 (defaults for the content headers) rewrite the two writers and the arguments
  of an upload. After them, `s3::client::copy` passes a `PutHeaders` where it passes six
  arguments, `copy::Defaults` is their `S3Defaults`, and the limits of 238 and 232 keys are 237
  and 231. A copy becomes a `CopyHeaders` next to `PutHeaders`.
- oven-sh/bun#45440 streams the canonical request into a hash, so `CanonicalRequest::format` and
  its loop over the entries are written again.
- oven-sh/bun#39210 rewrites `sign_request` and `simple_request.rs`. It has had conflicts since
  August.
- oven-sh/bun#44818 has a parser for the bucket of a host name. The one here reads the two host
  names that the docs show and nothing else.

Rebase notes: upstream did not move since the sync of 2026-10-24, so the 60 patches are on
oven-sh/bun 179664ea89 as they were, with no conflict and nothing dropped. The debug build of the
stack was made from scratch before the work, and the three workflows of the fork were green on
the last push. One commit landed upstream during the work (449877f3e0, `console.groupCollapsed`).
It touches no file of this commit and waits for the next sync.

Files: `src/s3_signing/copy.rs` (new), `src/s3_signing/metadata.rs` (`AmzHeaders`,
`split_at_date`), `src/s3_signing/credentials.rs` (`bucket_and_key!`, `SignedHeaders::write`,
`CanonicalRequest::format`), `src/s3_signing/lib.rs`, `src/runtime/webcore/s3/copy.rs` (new),
`src/runtime/webcore/s3/client.rs` (`copy`), `src/runtime/webcore/s3/simple_request.rs`
(`Callback::Copy`), `src/runtime/webcore/s3/xml_response.rs` (`parse_copy_object_result`),
`src/runtime/webcore/s3/credentials_jsc.rs`, `src/runtime/webcore/s3/multipart.rs`,
`src/runtime/webcore/fetch.rs`, `src/runtime/webcore/S3Client.bind.ts`,
`src/runtime/webcore/S3Client.rs`, `src/runtime/webcore/S3File.rs`,
`src/jsc/bindings/JSS3File.cpp`, `src/runtime/webcore.rs`, `packages/bun-types/s3.d.ts`,
`docs/runtime/s3.mdx`, `test/js/bun/s3/s3-copy.test.ts` (new),
`test/js/bun/s3/s3-argument-validation.test.ts`, `test/js/bun/s3/s3-moved-store.test.ts`,
`test/js/bun/s3/s3.test.ts`, `test/js/bun/module-graph/module-graph-isolation.test.ts`,
`test/packages/s3-server/src/signature.ts`, `test/packages/s3-server/test/auth.test.ts`,
`test/integration/bun-types/fixture/s3.ts`.

### 2026-10-26: cursors for `Bun.SQL`, `query.cursor()`

`await sql`...`` builds one array with every row of the result. `Bun.SQL` had no API to read a
large result in pieces at the pace of the consumer. oven-sh/bun#17181 ("Cursor support for sql",
open since February 2025, 14 upvotes) asks for it, oven-sh/bun#25307 (12 upvotes) was closed into
it in August with the words "neither shape is implemented yet", and the tracking issue
oven-sh/bun#15088 still has "Support async iterators" unchecked. Upstream main has
`debug!("TODO PortalSuspended")` where the server says that a row limit was reached. No pull
request, open or closed, has a cursor. kysely-postgres-js 5.0.1 throws `streaming queries is not
supported in Bun.SQL` at the line before its `reserved.unsafe(text, values).cursor(chunkSize)`.

A program can write `DECLARE` and `FETCH` in `sql.begin()` today, and for a `SELECT` that bounds
memory. PostgreSQL refuses `DECLARE` for `INSERT`, `UPDATE`, `DELETE` and `MERGE ... RETURNING`,
for `SHOW` and for `EXPLAIN` (42601), and the caller has the transaction, the cursor name and the
`CLOSE` to manage. The postgres package, which `Bun.SQL` takes its API from, reads all of them
through `cursor()`. Now, on PostgreSQL:

```ts
import { sql } from "bun";

// batches of at most 1,000 rows, asked for one at a time
for await (const rows of sql`SELECT * FROM events ORDER BY id`.cursor(1000)) {
  await send(rows);
}

// or a callback: the next batch is asked for when its promise has resolved
await sql`SELECT * FROM events ORDER BY id`.cursor(1000, async rows => {
  await send(rows);
});

// stop early: leave the loop, or return sql.CLOSE (sql.END is the same value)
for await (const [event] of sql`SELECT * FROM events ORDER BY id`.cursor()) {
  if (isTheOne(event)) break;
}

// in a transaction, the other statements run between two batches
await sql.begin(async tx => {
  const users = tx<{ id: number }[]>`SELECT id FROM users WHERE NOT notified ORDER BY id`;
  for await (const rows of users.cursor(500)) {
    await tx`UPDATE users SET notified = true WHERE id IN ${tx(rows.map(row => row.id))}`;
  }
});
```

The two forms and the token are those of the postgres package: `cursor(rows = 1)` is an async
iterator of batches, `cursor(rows = 1, fn)` returns the query and calls `fn` with each batch. The
iterator has `return()` and `Symbol.asyncDispose`, so `await using` ends it. The 15 cursor tests of
that package and its two tests of concurrent cursors were in `test/js/sql/sql.test.ts` as comments.
They are tests now, without their delays, and pass. MySQL and SQLite throw
`cursor() is not supported by this adapter (PostgreSQL only)` in the call, as `readable()` and
`writable()` do.

What the consumer gets:

- A batch is an array of 1 to `rows` rows, like the result of a query. Its `count` is its number of
  rows, `columns` and `statement` describe it, and `command` is `null` except on the batch that the
  statement ended with. A statement that returns no rows gives no batch.
- The query resolves when the cursor has ended, to an array without rows. `count` is the number of
  rows of all the batches, or the count of the command tag for a statement that returns none.
  `command` is `null` when the cursor stopped before the statement ended, and `affectedRows` is
  then `0`. The count is of the rows that Bun delivered, not of the tag, because the tag of an
  `Execute` counts differently before PostgreSQL 13.
- `.values()`, `.raw()`, `bigint` and a column transform apply to every batch. The values are those
  of `await query` once its statement is prepared: `int4[]` is an `Int32Array` in the first cursor
  as in the tenth. A query that runs with the simple protocol when it is awaited (`sql.unsafe()` and
  `sql.file()` without values, `.simple()`) gives the text values that it gives when awaited.
- A query has one cursor: the first `cursor()` with a callback, or the first iterator that is read.
  Another one throws `ERR_INVALID_STATE`, or rejects so at its first `next()`.

How it reads. The Bind of the statement names a portal (`C1`, `C2`, the lowest number that is free
on the connection), and its Execute has the row limit. Each later batch is one more Execute of that
portal, and it is the same native request, queued again. Every one of these requests ends with its
own Sync and its own ReadyForQuery, so between two batches the connection is where it is between
two statements of a transaction: `idle in transaction`, with the server's `statement_timeout`
counting one batch and not the time of the consumer. No `Flush` is sent. The statement of a cursor
is the unnamed one, parsed for each cursor and cached nowhere, so a cursor cannot fail because a
cached statement went stale: `DEALLOCATE ALL`, `DISCARD ALL` and `ALTER TABLE ... ADD COLUMN`
are tested. A query with the extended protocol is described first (Parse, Describe, Sync), so that
its rows come in binary from the first batch. A cursor on `sql` that reads 7 rows by 3 is 6 round
trips and 12 frontend messages: `BEGIN`, the describe, the Bind with the first Execute, two more
Executes, `COMMIT`.

Who owns the transaction. A portal lives only inside a transaction block, and the server ends it
with the block. One place in Bun sends `BEGIN`, `COMMIT` and `ROLLBACK` for a caller, the `Scope`
code of `src/js/bun/sql.ts`, and a cursor uses that place:

- On `sql`, the cursor takes one connection of the pool and runs in a private transaction scope, as
  the callback of `sql.begin()` does. The end of the loop, `break`, `return()`, `sql.CLOSE` and a
  throw of the loop body or of the callback commit. An error of the server, `cancel()`, a lost
  connection and an iterator that is dropped and collected roll back. When the statement ends, Bun
  sends `COMMIT` before it hands out the last batch, so a batch with a `command` is of a statement
  that is committed, and a `COMMIT` that fails (a deferred constraint) rejects the loop and the
  query with nothing written.
- On the handle of `sql.begin()` or of a savepoint, the cursor reads in that transaction and ends
  with a Close of its portal. It never ends the transaction. A cursor that is open when the
  callback returns fails the transaction, as an open COPY stream does.
- On a reserved connection, the cursor reads in the transaction that is open there (`BEGIN` by
  hand, or `reserved.begin()`), and never ends it. With no transaction open it rejects with
  `ERR_POSTGRES_INVALID_TRANSACTION_STATE` and nothing is written.

The last rule is enforced where the request is written, not in JavaScript. The native connection
writes the statement of a cursor only when no request waits for an answer and the last
ReadyForQuery said that a transaction is open. Until then the request waits, and in no transaction
it is rejected unwritten. So a cursor never runs in autocommit, where its portal would be gone at
the first Sync with the writes of the statement committed. That holds for every order of statements
that a caller sends by hand, and for a `BEGIN` that the server refuses.

`cancel()` between two batches ends the cursor with `ERR_POSTGRES_QUERY_CANCELLED` and leaves the
caller's transaction as it is. With a request on its way the server is asked to stop, and the
cursor rejects with what the server answers (`57014`), as any cancelled query does. A savepoint
that is rolled back ends the cursors that were opened inside it, also those whose query was made
on another handle of the transaction. The `COMMIT` or `ROLLBACK` of `reserved.begin()` ends the
cursors that were opened on the reserved handle meanwhile. Without this, the next request for
their rows would be answered with 34000 and abort the caller's transaction.

What a program that never calls `cursor()` pays. Measured on release builds of the stack without
this commit and with it. `perf`, `valgrind`, `strace` and `bloaty` are not in the container. The
instruction counts are from gdb, one step at a time, which is exact, and from `perf_event_open`
for the whole process. Syscalls are from `qemu-x86_64 -strace`.

| Per                                              | Without the commit      | With it                 |
| ------------------------------------------------ | ----------------------- | ----------------------- |
| query: bytes of the native request               | 96                      | 96                      |
| query: bytes of its JS wrapper                   | 64                      | 64                      |
| query: GC cells allocated (cached, awaited)      | 32.06                   | 32.06                   |
| query: instructions of native `run()`, cached    | 2,715                   | 2,666                   |
| query: the same with `prepare: false`            | 3,019                   | 3,008                   |
| query: the same for `.simple()`                  | 780                     | 772                     |
| query: instructions of the dispatch that writes  | 1,457                   | 1,457                   |
| query: instructions per message read             | 1,733 / 53 / 2,900      | 1,733 / 53 / 2,900      |
| query: instructions of the whole process         | 29,179 (28,914-29,391)  | 29,215 (28,518-29,655)  |
| query: the same with a result of 100 rows        | 137,322                 | 137,432                 |
| query: sendto (42 bytes), recvfrom, epoll_pwait  | 1, 1, 1                 | 1, 1, 1                 |
| `sql.begin()` with one statement: GC cells       | 124.01                  | 124.01                  |
| `reserve()` and `release()`: GC cells            | 34.57                   | 34.57                   |
| savepoint, released / rolled back: GC cells      | 214.07 / 226.07         | 214.01 / 226.08         |
| `new SQL()` on PostgreSQL: GC cells, bytes held  | 55.07, 2,893            | 55.07, 2,952            |
| process: host functions of the query prototype   | 10                      | 12                      |
| process: text of the binary                      | 108,629,396             | 108,653,497 (+24.1 KB)  |

The "whole process" rows are the slope between 20,000 and 40,000 awaited queries, the median of
five interleaved runs, and the difference is inside the spread. The lower counts of `run()` are
not an optimization: the function was split, and the compiler inlines it differently. What is
written for a plain query is byte for byte what it was, and the pinned wire tests of upstream pass
unmodified.

The first release build of this work was not free, with no new branch in the source: `run()` took 48
instructions more, 30 of them in the dispatch that it calls, and the result 31 more, because the
compiler had stopped inlining three things that got a second caller. Three changes took that back,
and they are in the commit. The writers of Bind and Execute are generic over a `Portal` type, and a
plain query passes `Unnamed`, a type without data, so it writes constants. `run()` and `fetch()`
share one tail in `queue()`. `PostgresSQLStatement::description` is `#[inline(always)]`. The request
of a cursor is found by `dispatch_next` on the status byte, through the compare that was there: the
shared `QueryStatus` has one more value, `Cursor`, and the kind of the request (open, fetch,
suspended, close) is in the one-byte `CopyStream` enum that a request had. The portal id and the row
limit are one number in the `copy` slot of the JS wrapper. A client has three more fields on its
adapter (59 bytes), a `Scope` has one.

What a cursor costs. One round trip for each batch, plus `BEGIN`, the describe and `COMMIT` on
`sql`. On loopback, 1,000,000 rows of three columns take 0.37 to 0.61 s as one array, 0.93 to 0.98 s
with `cursor(1000)` and 0.57 to 0.61 s with `cursor(10000)`. Reading 5,000,000 rows by 1,000 grows
the resident set by 25 MiB, and the same rows as one array by 486 MiB. No native request is
allocated for a batch: a test reads cursors that end in every way and counts the requests that
are alive afterwards. The consumer holds one batch: while the next one is on its way, the one
before it is collected (tested with a weak reference, in both forms).

Limits, each in the docs:

- A cursor on a reserved connection needs an open transaction. `reserved.begin()` gives one.
- With as many cursors, transactions and reservations open as the pool has connections, a query on
  `sql` inside the loop waits, and if each of them waits for such a query, none ends.
- What an `INSERT ... RETURNING` cursor on `sql` wrote is not committed until the cursor ends. The
  rows of an `UPDATE ... RETURNING` or `SELECT ... FOR UPDATE` cursor stay locked until then.
- With `max: 1`, a cursor on `sql` inside a `BEGIN` by hand ends that transaction with its own
  `COMMIT`, as `sql.begin()` does in the same place.
- PostgreSQL plans the statement for the whole result. A plan that streams stops where the consumer
  stops (tested with `nextval`). A sort, an aggregate and every `RETURNING` statement do their work
  before the first batch. PostgreSQL uses no parallel query under a row limit.
- `idle_in_transaction_session_timeout` and, from PostgreSQL 17, `transaction_timeout` count the
  time of the consumer and end the connection (25P03, 25P04).
- On `sql`, an iterator that is dropped without `return()` holds its connection until the garbage
  collector finds it. Then the cursor is rolled back.
- A statement that refuses a transaction block, such as `VACUUM`, has no cursor (25001).
- A reserved handle that is dropped without `release()` while a cursor of it is read ends that
  cursor when the handle is collected. An open COPY stream has the same rule.

Self-reviewed before the push, twice. The first review (6.6 hours) said: keep the API and the
wire, and change who owns the transaction. The first version had a second transaction manager for
cursors beside `Scope`: a conditional `BEGIN` request and a `COMMIT` that the cursors of a reserved
connection shared. The review reproduced four cases where the result and the database disagreed.
A cursor resolved `INSERT` with count 5 and 0 rows stored after a sibling cursor was cancelled. An
awaited `INSERT` on a reserved connection was rolled back by the `cancel()` of a cursor. The end
of a cursor committed a transaction that the caller began. After `DEALLOCATE ALL`, a cursor on
`sql` gave one batch, rejected with 34000 and left its rows committed, because its `BEGIN` was a
cached statement. All of that is gone with the design above, and each case is a test. Of the 59
points of that review, these changed the behaviour: the transaction of a cursor on `sql` belongs
to `Scope`, the statement waits for a transaction on the wire, no transaction is begun or ended on
a reserved connection, the statement of a cursor is the unnamed one, the cursor ends when the
statement ends and not one `next()` later, a batch is never empty, counts are of delivered rows,
the first `cursor()` has the query, portal names are per connection and do not wrap, `cancel()`
reports what the server answered, and only a cursor on `sql` is watched by the collector (inside
`sql.begin()` a collection could turn a rollback into a commit).

A second, short check looked at the rework (eight reviewers, 40 minutes) and found 26 things, of
which 23 are changed. The ones with an effect: an iterator whose `next()` was awaited with no
other reference to it could be collected while it waited, and then held its connection for ever
(a pending call keeps the iterator now). A Close that was written behind a running request kept
a cancel of that request from the server. The `COMMIT` of `reserved.begin()` was aborted by
Bun's own cancel of a cursor on the reserved handle. A savepoint rollback missed the cursors of
a sibling handle. The rest were five sentences of the docs and the types, ten points of the
tests (tests near the time limit, assertions that could not fail, a failed assertion that showed
as a timeout, five branches that no test noticed), and four costs (a walk of the running queries
at every savepoint, an out-of-line call while a statement is prepared, a bound function for each
client, a call for each evicted statement).

Not taken, and why:

- A transaction of its own for a cursor on a reserved connection that is in none. The review's
  reviewers disagreed: refuse, or begin one and refuse the caller's other statements until the
  cursor ends. Refusing can become the other later without a break. kysely-postgres-js calls
  `cursor()` on reserved connections, and its `stream()` outside a transaction needs the second.
- A new name for the `CopyStream` enum, which holds the kind of a cursor request now. It would
  touch about 30 lines of upstream's COPY code. `is_cursor()` is an exhaustive match.
- Routing on `Flags.copy` in place of `Status::Cursor`, and a flag test in `dispatchToPool` in
  place of the handler that `cursor()` swaps in. Both add a compare or a branch to every plain
  query. The numbers above are with neither.
- Plain fields for the portal id and the row limit: the request would be 104 bytes, in the
  112-byte bin of the allocator, for every query.
- `affectedRows: null` for a cursor that stopped early. `ResultMetadata.affectedRows` is a number,
  and the summary would need a type of its own. It is `0`, `command` is `null`, and the docs say
  why.
- The cursor code in a module of its own that loads on the first `cursor()`.
- A rule of its own for a reserved handle that is dropped while a cursor is read (above).

Open for a maintainer, if this goes upstream: the rule for a reserved connection (above), both
forms and the token or the iterator alone, a row-less summary and not the last batch as the
result of the query, `COMMIT` on `break` and on a throw, and what `cursor()` on `sql` does with
`max: 1` inside a `BEGIN` by hand (as `sql.begin()` today).

Tests: `test/js/sql/postgres-cursor.test.ts` (new, 106 tests). Two check that MySQL and SQLite
throw. 93 run against a real server:
both forms, row counts around the limit, `prepare: false`, `sql.unsafe()`, `sql.file()`,
`.simple()`, values against the awaited query, `pg_prepared_statements` after a cursor, every
end on `sql`, in a transaction, in savepoints and on a reserved connection with `BEGIN` by hand
in five orders, the refusal without a transaction, the four cases of the first review, a
`COMMIT` that fails, `cancel()` before the start, while it waits for a connection, between two
batches, after the last batch and with the first or a later batch on its way, a session that the
server ends in three places, the two timeouts of the server, the pool with its connections in
cursors, and the collector (a dropped iterator, an iterator with a call that waits, requests
that are freed). 11 run against a scripted server that records every frontend message: the
frames on a pool, in a transaction, with `prepare: false` and for a query of the simple
protocol, a `BEGIN` that is refused, a statement that waits for the ReadyForQuery of a `BEGIN`
by hand, `cancel()` while `BEGIN` is on its way, and tags that count as PostgreSQL 12 does. All
106 fail on Bun 1.4.3 and on the release build of the stack without this commit. The file takes
3 to 4 seconds on the release build and 18 to 22 on the debug build. The 17 tests in `sql.test.ts`,
one in `sql-debug.test.ts` (`debug` reports `BEGIN`, the statement once, and `COMMIT`, each in the
async context of the code that ran the query) and the byte tests of two new frame helpers in
`wire-frames.test.ts` pass.

Also run on the debug build: `postgres-bind-wire` (61), `postgres-dispatch` (26),
`postgres-simple-query-pipeline` (3), `postgres-prepared-pipeline-reorder` (28),
`postgres-split-prepare-reorder` (2), `postgres-copy` (75), `postgres-connection` (91),
`sql-handles` (258), `sql-pool-transaction-isolation` (18), `sql-reserve-abort` (9),
`sql-prepare-false` (8), none of them modified. Every snippet of the docs and every sentence of
the cursor section that can be tested was run, the type tests pass (24), and so do the source
lints (187, with the release build). `cargo fmt`, `bun fmt` and clippy are clean, and so is the
rule of upstream's comment-cop workflow: no comment of two lines or more in `src/`.
`cargo check -p bun_sql_jsc` passes for Windows, macOS, musl and FreeBSD.

What failed, and why it is not the commit. The MySQL blocks of `sql-debug`, `sql-pool`,
`sql-errors` and `sql-result-columns` fail in this container with "Access denied for user
'root'". Ten tests of `sql.test.ts` and one of `sql-pool.test.ts` fail with and without the
commit, because of how the server of the container is set up: `SQL_ASCII` as its encoding, no
prepared transactions, no role `bun_sql_test_md5`. The subprocess tests of `postgres-listen-notify`
run out of 5 seconds on the debug build when the file runs whole, and pass alone (9) and on both
release builds (61). A test of upstream, `test/internal/prestart-map.test.ts`, failed on the
stack before this commit: the `debug` patch of 2026-09-20 had no entry for its test file. That
patch has the entry now, and this commit has its own.

Built and run on Linux x64 only. Nothing in the commit is specific to a platform.

Relation to open pull requests of upstream. The commit applies to oven-sh/bun 449877f3e0 with
two conflicts, both next to the `debug` patch of 2026-09-20: three lines in the constructor of
`Client` in `src/js/bun/sql.ts`, and the sentence about cursors in the "Logging queries" section
of the docs, which upstream does not have. `test/js/sql/sql-debug.test.ts` is a file of that patch
too. It was not built there. None of these has a review of a maintainer:

- oven-sh/bun#46811 (pipelined `BEGIN`) and oven-sh/bun#45628 (`query.describe()`) each take
  `1 << 10` of `SQLQueryFlags`. The cursor has `1 << 12`. Both add a field to the flags of the
  native request, which is 96 bytes with no byte to spare. After #46811 the statement of a cursor
  still waits for the answer to its `BEGIN`: that wait is what keeps it out of autocommit when a
  `BEGIN` is refused.
- oven-sh/bun#44924 changes the shared `QueryStatus` too.
- oven-sh/bun#40944 and oven-sh/bun#40250 change `PostgresRequest.rs`.
- oven-sh/bun#46529 asks for streaming on the MySQL adapter. This commit is PostgreSQL only, so
  it is the PostgreSQL part of #17181 and does not close it.

Rebase notes: the 61 patches went onto oven-sh/bun 449877f3e0 with no conflict and nothing
dropped, and the three workflows of the fork were green on the last push. The `debug` patch of
2026-09-20 was amended with its line in `test/docker/prestart-map.mjs`, so the 28 patches
between it and this one have new hashes and the same content. Four commits landed upstream
during the work (1341090411 is the last). They touch no file of this commit and wait for the
next sync.

Files: `src/sql_jsc/postgres/Cursor.rs` (new), `src/sql_jsc/postgres/PostgresSQLQuery.rs`
(`queue`, `set_statement`, the cursor kinds of `CopyStream`),
`src/sql_jsc/postgres/PostgresSQLConnection.rs` (`dispatch_next`, `dispatch_extended`, the
ReadyForQuery and PortalSuspended arms), `src/sql_jsc/postgres/PostgresRequest.rs` (`Portal`,
`Unnamed`, `execute_portal`, `close_portal`), `src/sql_jsc/postgres/PostgresSQLStatement.rs`,
`src/sql_jsc/postgres/PostgresSQLQuery.bind.ts` (`fetch`, `setCursor`),
`src/sql/postgres/protocol/Close.rs` (new), `src/sql/postgres/protocol/Execute.rs`,
`src/sql/postgres/PostgresProtocol.rs`, `src/sql/lib.rs`, `src/sql/shared/QueryStatus.rs`,
`src/sql_jsc/mysql/MySQLQuery.rs`, `src/js/internal/sql/query.ts` (`cursor()`, `Cursor`,
`CursorIterator`), `src/js/internal/sql/postgres.ts` (`PortalCursor`),
`src/js/internal/sql/shared.ts`, `src/js/bun/sql.ts` (the transaction of a cursor on a pool,
`abandonCursorsAround`, `CLOSE` and `END`), `packages/bun-types/sql.d.ts`,
`docs/runtime/sql.mdx`, `test/js/sql/postgres-cursor.test.ts` (new), `test/js/sql/sql.test.ts`,
`test/js/sql/sql-debug.test.ts`, `test/js/sql/wire-frames.ts`,
`test/js/sql/wire-frames.test.ts`, `test/integration/bun-types/fixture/sql.ts`,
`test/docker/prestart-map.mjs`.

### 2026-10-27: arithmetic in Bun Shell, `$((i + 1))`

Bun Shell got `while` and `until` on 2026-10-16, and the docs of that patch had to end with "Bun
Shell has no arithmetic expansion yet". So a loop could not count without a program to do it, and
the loop every shell tutorial starts with did not run:
`` $`i=0; while [[ $i -lt 3 ]]; do echo $i; i=$((i + 1)); done` `` threw
`expected a command or assignment but got: "CmdSubstEnd"` before anything ran, because `$((` was
read as a command substitution that starts with a subshell. `$((expression))` is POSIX, so a
`package.json` script that computes a port or a count worked on Linux and macOS, where `bun run`
hands it to `sh`, and failed on Windows, where `bun run` uses Bun Shell. Upstream has no issue and
no pull request for it (its open shell work is `:` in oven-sh/bun#46375 and `${NAME}` in
oven-sh/bun#46691). Now:

```ts
import { $ } from "bun";

await $`echo $((1 + 2 * 3))`; // 7

// count the rounds of a loop
await $`
  i=0
  while [[ $i -lt 3 ]]; do
    echo attempt $i
    i=$((i + 1))
  done
`;

// a name is a variable of the shell or of the environment
await $`echo port $((PORT + 1))`.env({ ...process.env, PORT: "3000" }); // port 3001

// a value from JavaScript has to be an integer
const width = 80;
await $`echo $((${width} / 2 - 1))`; // 39
```

```json
{
  "scripts": {
    "dev": "bun run server.ts --port $((PORT + 1))"
  }
}
```

The expression language is the one of bash: C's integer operators on 64-bit signed integers that
wrap, `**`, `?:`, the comma, `=` and the ten compound assignments, and `++` and `--` on both sides
of a name. Numbers are decimal, octal (`010`), hexadecimal (`0x1F`) or `base#digits` up to base 64.
A name is a shell variable, then an environment variable, and one that is unset or empty is 0. An
assignment sets a shell variable the way `name=value` does. It works wherever a word does: in an
argument, inside double quotes, next to other parts of a word, as the value of an assignment
(`i=$((i + 1))`, `FOO=$((n * 2)) cmd`, `export N=$((2 ** 5))`), in the words of `for`, in `[[ ]]`
and in the target of a redirect. It also runs in a `.sh` file and in a `package.json` script under
`bun run --shell=bun`.

An expression that cannot be evaluated fails its command, which does not run, with exit code 1 and
bash's message on stderr: `bun: 1/0: division by 0 (error token is "0")`. The rest of the script
goes on, which is what Bun Shell already does when a glob matches nothing (bash gives up on the
whole line). The operand that C would not evaluate is read and not run, so `$((0 && 1/0))` is 0 and
`$((1 || x++))` leaves `x` alone.

One rule is not bash's, and it is the one that took the day: data is a number in an expression,
never a part of it. bash reads the value of a variable as an expression of its own, and pastes in
what `$name` and `$(command)` expand to. Then `n=$input; echo $((n + 1))` lets the input assign any
shell variable (`PATH=0`), read one, and print its value in an error message, and one variable that
names itself in a sum keeps the thread busy for 2^n steps. Bun Shell treats `$name` as one word
that is never split or globbed again, and this is the same idea:

- The value of a variable has to be an integer, as in dash. `x="1 + 2"; echo $((x * 3))` is
  `bun: 1 + 2: not an integer (error token is "1 + 2")`.
- What `$name`, `$(command)` and a nested `$(( ))` add is one operand. A signed one goes in
  parentheses, so with `n=-1`, `$((x-$n))` is 6 for `x=5` (bash reads `x--1`, decrements `x` and
  fails). It can also end a number or a name that the script starts, which keeps `$((10#$month))`,
  `$((0x$hex))` and `$((count_$i))`.
- An interpolated JavaScript value follows the same rule and is checked before the script runs:
  `${"1 + 1"}`, `${1.5}`, `${undefined}` and `${"x++"}` throw `Interpolated value in arithmetic
  expansion must be an integer`. `{ raw: "1 + 1" }` is the way to build an expression from text.

With integers in the variables, nothing is different from bash.

How it is built:

- Lexer. At `$((` a scan looks for the `))`: the `)` that closes the inner `(` has to be directly
  followed by another, and a parenthesis in a string, in a `$(...)` or in backticks does not
  count. If there is none, this is what it was before, a command substitution that starts with a
  subshell, so `$((cd src && ls) | wc -l)` keeps working. The expression is then read like the
  inside of a double-quoted string, between the new tokens `ArithBegin` and `ArithEnd`: `$x` and
  `$(cmd)` are expansions, and a `*`, a `>`, a `|`, a `;` or a `#` is just text. A double quote in
  it is dropped, as bash does for `$(("1" + 2))`.
- Parser. `SimpleAtom::Arith` holds the expression as a word of its own.
- Evaluator. `src/shell_parser/arith.rs` is a port of bash's `expr.c` in safe Rust, next to the
  brace expansion that lives in the same crate. It evaluates while it reads, with bash's look-ahead,
  so it reports an error at the token bash reports it at. It sees variables through a two-method
  trait. Parentheses, signs, `**`, `?:` and assignments recurse, so they nest 128 deep, with the
  stack check the parser uses, and then fail with bash's `expression recursion level exceeded`.
  Operators that group from the left are a loop (`1 + 1 + ...` 100,000 times is fine).
- Interpreter. `Expansion` runs a child `Expansion` for the expression, checks what each expansion
  in it added, evaluates the text and appends the number. Variables are read where `$name` reads
  them and written where `name=value` writes them, so an assignment in a subshell or a command
  substitution stays there.
- Assignments print their errors. `x=$((1/0))` failed without a word, because `Assigns` dropped the
  error of a value that did not expand (until now only a brace expansion with too many results
  could get there). It writes the message to stderr now, like `for` and `[[ ]]` do.
- Interpolated values. A string with a digit or a special character already reaches the lexer by
  reference, so the lexer can check it where it stands in an expression. A string without one
  (`x`, `x++`) is pasted into the script as text, and in an expression that text is syntax. So once
  a template has a `$((`, such a string comes by reference as well, under a second marker: in an
  expression the lexer checks it, and anywhere else it appends the bytes as the text they would
  have been, so `FOO${name}=1` and `[[ 1 -${op} 1 ]]` after an expression behave as before.

It was checked against bash 5.2 in three ways. The tests are tables: 97 expressions with the value
bash prints and 66 with the message bash prints, plus the scripts around them. A generator of
expressions (valid ones, and ones with a token inserted or removed) ran 2,381 of them through both
shells: the value, the message and the variables afterwards were the same for all but 10, and
those never reached bash's arithmetic (bash reads a `#` after a blank as a comment even inside
`$(( ))`, and `$*` is a parameter Bun Shell does not have). And the diff went through an
adversarial review, four readers with bash and the ASAN build: lexer, evaluator, interpreter,
tests and docs. The evaluator reader ran about 600,000 more generated cases against bash and found
three messages that differed (the token of a division by zero after a line break, a run of names
before a bad number, and the expression quoted for a bad number, which bash cuts at the number).
The other findings are what changed the design above or were fixed here:

- The first version evaluated variable values like bash and only checked values interpolated
  straight into an expression. The readers showed the routes around that (a variable, the
  environment, a command substitution), the sign that joins an operator (`$((x-${-1}))` was
  `x--1`), and the 2^n evaluation that `.timeout()` and `.kill()` cannot stop. Hence the rule.
- That version also passed every value by reference after a `$((`, which cut `FOO${name}=1` into
  two tokens anywhere later in the template. Hence the second marker.
- The scan for `))` did not know that `"$(echo ")")"` nests, so a command substitution that
  released bun runs, `$((echo "$(echo "))")"); echo b)`, became an unclosed expression.
- 127 nested parentheses overflowed a 2 MB stack in the debug build. Hence the stack check.
- A backtick substitution after other text in an expression gave a wrong number with exit code 0.
  The cause is upstream's (below), and the lexer now ends the text before a backtick in an
  expression.

Three faults of upstream's shell turned up on the way. They reproduce on released bun, so they
are upstream's to fix and are not patched in this stack: `echo $( (echo a) )` is a parse error when
the subshell is the last thing in a command substitution, ``echo a`echo 1` `` runs `aecho`, and the
redirect target and the prefix assignments of a command are expanded before its arguments, which
`$((n++))` now makes visible (`echo $n > out$((n++)).txt`; the docs say so).

Not in this patch: the `((expression))` command, `for ((i = 0; i < 3; i++))`, `let` and arrays.

Files: `src/shell_parser/arith.rs` (new), `src/shell_parser/parse.rs` (`arith_end`, `eat_arith`,
`arith_value`, `parse_arith`, the second marker), `src/shell_parser/json_fmt.rs`,
`src/shell_parser/lib.rs`, `src/runtime/shell/states/Expansion.rs` (`arith_expanded`,
`splice_arith_operand`, `ShellVariables`), `src/runtime/shell/states/Assigns.rs` and
`src/runtime/shell/IOWriter.rs` (the error of an assignment), `src/runtime/shell/states/Cmd.rs`,
`src/runtime/shell/interpreter.rs`, `src/runtime/shell/shell_body.rs` (`ArithSeen`, the second
marker, the tokens for the lexer tests), `docs/runtime/shell.mdx`,
`test/js/bun/shell/bunshell.test.ts`, `test/js/bun/shell/lex.test.ts`,
`test/js/bun/shell/parse.test.ts`, `test/cli/run/run-shell.test.ts`.

### 2026-10-30: `FileReader` and `ProgressEvent`

`FileReader` is how code for the browser reads a `Blob`, and it was the one class of the File API
that Bun did not have. `Blob`, `File` and `FormData` are there, so a `File` arrives from
`request.formData()`, and the library it is handed to then fails. With bun 1.4.3,
`JSZip.loadAsync(file)` rejects with `Can't read the data of 'the loaded zip file'. Is it in a
supported JavaScript type (String, Blob, ArrayBuffer, etc) ?`, because JSZip reads a blob with a
`FileReader` and takes it for something else when there is none, and `Papa.parse(file)` throws
`FileReaderSync is not defined`. A test of browser code that reads a file needs happy-dom or jsdom
for this class alone. Deno has `FileReader` and `ProgressEvent`; Node.js has neither. Upstream has
no issue and no pull request for them (a search for "FileReader" finds the Rust type of that name
behind `Bun.file().stream()`). Now:

```ts
const reader = new FileReader();
reader.onload = () => console.log(reader.result); // "data:image/png;base64,iVBORw0KGgo..."
reader.onerror = () => console.error(reader.error);
reader.readAsDataURL(Bun.file("./logo.png"));

// what a library does with the File of an upload
const form = await request.formData();
const zip = await JSZip.loadAsync(form.get("archive") as File);
Papa.parse(form.get("table") as File, { header: true, complete: result => console.log(result.data) });

// a large file, with progress
reader.onprogress = event => console.log(`${event.loaded} of ${event.total} bytes`);
reader.readAsArrayBuffer(Bun.file("./video.mp4"));
```

What is there is the interface of the File API: `readAsArrayBuffer()`, `readAsText()`,
`readAsDataURL()`, `readAsBinaryString()`, `abort()`, `readyState` with `EMPTY`, `LOADING` and
`DONE`, `result`, `error`, the six events and their `on...` attributes. `ProgressEvent` is the
interface of the XMLHttpRequest standard, a global of its own with `lengthComputable`, `loaded` and
`total`, because that is what the events are and what `instanceof` in a handler asks for. The
`undici` module exported an empty `FileReader` class and now exports this one.

- A read takes any `Blob`: a `File` of a form, a slice, a `Bun.file()`, an S3 file. It asks the
  blob for its `stream()`, so a file is read in chunks, and a subclass that overrides `stream()` is
  read through its own stream. `progress` says how far the read is, with the bytes so far in
  `loaded` and the size of the blob in `total`: one for the first chunk, then at most every 50
  milliseconds, and one more when the last chunk has arrived. An empty blob fires none. The read
  goes on when the listeners of an event have run, so the events arrive while the data is read (ten
  of them, 50 milliseconds apart, for a 256 MB file in the debug build), and `abort()` in a
  `progress` listener stops the read there.
- `readAsText()` picks the encoding the way the standard says: its argument, then the `charset` of
  the blob's type, then UTF-8, and a byte order mark wins over all three. A label that names no
  encoding is not an error, and the labels of the replacement encoding (`iso-2022-kr`,
  `hz-gb-2312` and four more) give U+FFFD. `readAsDataURL()` uses the type of the blob and
  `application/octet-stream` when it has none.
- The order is `loadstart`, `progress`, `load`, `loadend`. A read that fails fires `error` and
  `loadend`, with no `loadstart` when it fails before its first chunk. `abort()` fires `abort` and
  `loadend` before it returns, nothing of the aborted read arrives afterwards, and `error` is an
  `AbortError` then: the standard does not say so, and Chrome, Firefox and Safari all do it. A
  second read during a read throws an `InvalidStateError`. A read that a `load` listener starts, or
  the code behind an `await` of `load`, takes the place of the `loadend` of the first one, as the
  standard has it.
- `reader.error` is a `DOMException`, as in a browser: `NotFoundError` for a file or an S3 object
  that does not exist and `NotReadableError` otherwise. What the file system or S3 said (`ENOENT`,
  `EISDIR`, `NoSuchKey`) is its `cause`. What a blob throws for its `size` or its `stream()` is
  reported the same way.
- The handler attributes are what HTML says they are: a function keeps its place among the
  listeners when another one replaces it, `null` takes it away, and an object that is not a
  function is kept and not called.
- A pending read keeps the process alive until `loadend`, like a pending `fetch()`.

Both classes are TypeScript (`src/js/internal/file_reader.ts`, about 500 lines) and load when the
global is first read, the way the `EventSource` of 2026-09-01 does: a custom getter on the global
object that asks for the internal module. The globals are not enumerable and can be assigned, which
a polyfill or a test does. The members of the two prototypes are enumerable, as WebIDL has them.

What the module is built on does not come from the global object. The first read of the global can
be inside happy-dom's `GlobalRegistrator.register()`, which asks for the descriptor of every global
while its own `Event` is in place, or under a fake clock that has replaced `setImmediate`. The
first version of this patch took `Event`, `EventTarget` and `setImmediate` from the global object
at that moment. A review of it found that after `register()` and `unregister()` no `FileReader` of
the process fired an event again, that a read queued into a fake clock never ended, and that
`require("undici")` threw in a program that had replaced `Event`. Now a native binding
(`FileReaderBinding.cpp`) hands the module the `Event`, `EventTarget`, `DOMException` and
`setImmediate` of the realm, the way `Undici.cpp` and `node:worker_threads` (oven-sh/bun#40268) get
theirs. `EventSource` had the same fault, and `require("undici")` threw in a program without
`EventTarget`, which upstream's `undici` does not. It got a binding of the same kind in its own
commit (`EventSourceBinding.cpp`, with `MessageEvent` and `AbortController` too).

The part that took thought is when the events are fired. The standard queues a task for
`loadstart` and for each `progress`, and fires `load` and `loadend` from one more task. A browser
runs the promise callbacks of a listener before it fires the next event, because it calls the
listener from native code, and code depends on that: `await` one event, then add the listener for
the next. So `loadstart` and each `progress` is a native `setImmediate` task that the read waits
for. The last task fires `load`, runs the promise callbacks and ticks that wait (the microtask
checkpoint that `node:http` already runs from JavaScript, `drainMicrotasks` of
`hw_exports.bind.ts`), looks at the state again and fires `loadend`. The first version fired
`loadend` one microtask after `load`. That was enough for `await new Promise(...)` and not for
`await once(reader, "load")` of `node:events`, whose listener for `loadend` was then added too
late, and the review found the program that hung. A task of its own for `loadend` would have fixed
that and let a timer of the program run between the two events, where a read that the timer starts
silently takes the `loadend` away. The events of `abort()` are fired inside the call, as in a
browser. The native `setImmediate` is not stopped by the fake timers of `bun test`, so a read
finishes in a test that has stopped the clock. The 50 milliseconds are measured with
`Bun.nanoseconds()`, which those fake timers do stop: under them a read fires `progress` for its
first chunk and for its last.

The tests are written from the cases of the web platform tests for `FileAPI/reading-data-section`
and for the `ProgressEvent` constructor (the results of the four methods, the encodings, the order
of the events with a listener that is only added after the event before it, `abort()` at each
point, the states during each event), plus what is Bun's own: a `Bun.file()` with progress, a blob
whose `stream()` decides the chunks (`progress` at each point, `abort()` in a `progress` listener,
the exact events under fake timers), a file of /proc that says its size is 0, the three errors (a
missing file, a directory, a missing S3 object of a local server), a `File` out of `FormData`,
`once()` of `node:events` and an async function between `load` and `loadend`, the handler
attributes, a process that stays alive while its read waits for a pipe, the globals replaced before
and after they are first read, `require("undici")` without `Event` and `EventTarget`. 44 tests; all
of them fail on bun 1.4.3. Run by hand on the build: JSZip 3.10.1 and PapaParse 5.5.3 with a `File`
from `formData()` (both fail on 1.4.3 as quoted above and both work now), happy-dom 17 (`register()`
and `unregister()` before a read, and two test files of which the first registers), `mock.timers`
of `node:test`, lolex, and a program that uses `FileReader` built with `bun build --compile` and
with `bun build --compile --aot`.

Not done: `FileReaderSync`, which browsers only have in workers (PapaParse asks for it only when
there is no `FileReader`). `isTrusted` of the events is `false`, because they are dispatched from
JavaScript. No promise callback runs between two listeners of one event, as with every
`EventTarget` of Bun. `readAsDataURL()` of a `text/plain` blob says
`data:text/plain;charset=utf-8;base64,...`, because that is what `blob.type` is in Bun; a browser
keeps the type as it was given. `--trim` could not be tried: the debug build has no trim table, so
the rows that say which features the two classes keep in a trimmed executable are written after
upstream's and are not tested.

One fault of upstream turned up on the way. It reproduces on released bun, so it is upstream's to
fix and is not patched in this stack: `Bun.file(path).size` pins the size, and a file that says 0,
like those of /proc, reads as empty afterwards (`const f = Bun.file("/proc/cpuinfo"); f.size; await
f.text()` gives `""` on 1.4.3, and the contents of the file without the `f.size`). A read asks the
blob for its size to know `total`. It asks after it has the stream, so the `FileReader` reads such
a file to its end, and the caller's `BunFile` is pinned all the same.

Rebase notes: three days of upstream, 25 commits, and the largest rebase so far, because
oven-sh/bun#45631 landed: `bun build --compile --aot` compiles TypeScript to machine code ahead of
time. With it came a table of built-ins that every global, method and native binding has to be
declared in, a rule that native code loads an internal module only through
`BUN_REQUIRE_INTERNAL_MODULE`, a check that every runtime flag says what it needs in a trimmed
executable, and a check that every bundler option is classified for the compiler. The other 24
commits removed some 700 `unsafe` blocks across the shell, the test runner, the CLI, the bundler,
the package manager and usockets, which changed the signatures that soup's patches call. 26 of the
62 patches had conflicts, about ten more needed a line or two, no patch was dropped, and each patch
was brought up to date in its own commit:

- Table of built-ins: rows for `lines()` (`Blob.prototype.lines`, and the built-in function of
  `ReadableStream`), `EventSource`, `navigator.locks` and `WebLocks.cpp`, `$isAbortSignal` (which
  `$.signal()` is the first to use), `copyTo` of S3 files, `localStorage` (a global that an option
  adds, like `gc`), and `keyObjectFromCryptoKey` of the crypto binding that `Bun.JWT` reads.
  `Bun.JWT`, `Bun.Queue`, `EventSource`, `navigator.locks` and the watcher of `Bun.build` load their
  module through the new macro. The generator was run on every patch of the stack in turn, so each
  commit passes it.
- `bun build --compile --aot`, and `bun compile`, which is the same: `--alias`, `--global-name`,
  `--legal-comments=linked` and `external`, an import with the `bytes` loader and a call of
  `import.meta.glob()` stop the build with `TS100050: --aot does not support ...`, like
  `--format=iife` already does. The compiler has a front end of its own, which knows nothing of
  them. The one for `import.meta.glob()` is a new diagnostic in the lowering of a call, beside
  upstream's for `ShadowRealm`. `Bun.build({ watch: true, compile: { aot: true } })` throws,
  because such a build does not say which files it read. The docs of each option say so, and
  upstream's table of what `bun compile` does not support has three more rows. Without `--aot` all
  of them work as before.
- Runtime flags: `--watch-path`, `--watch-exclude` and `--localstorage-file` have their rows.
  `--watch-path` needs what `--watch` needs. `bun --aot serve` is refused with a message of its
  own, `bun --check --watch serve` has nothing to check, and `bun test --aot --last-failed` says
  once which files it runs (it is two processes there).
- Redis: the schema now says that a command answers `this` in a transaction and that `multi()`
  answers an object, which is what they do. Upstream's new comparison of the schemas with the
  published types found the difference.
- Shell: the readers and writers are `Rc` now, the AST nodes are handed around as references, and
  the flag parser lends slices. `wc`, `head`, `tail`, `sort`, `uniq`, `for`, `while`, `$((...))`
  and `.kill()` follow. The new task tags (the unpolled read of `wc`, the yield of a loop) are
  released through `release_in!([Shell], ...)`.
- Package manager: the lockfile loader no longer hands out the lockfile it filled, so the merge of
  a conflicted `bun.lock` reports `merged_conflict` on the result alone, and `bun install` gets the
  loader for installs through `PackageManager::load_lockfile_from_cwd_for_install`.
- Smaller ones: the idle time of the event loop reads through `&Loop` and `Cell` fields, `bun
  compile` is one more row in the table of commands behind "did you mean", the states of
  `EventSource` are a `const enum` (a new lint wants a constant that two built-in modules declare
  to have one value, and `CLOSED` is 3 in `ws`), `collectCoverageFrom` gets its VM from
  `vm.as_mut()`, cursors set `row_type` where the query object is known, the native function of
  `navigator.locks.request()` no longer asserts what it also checks (upstream now calls every native
  function with no arguments in a debug build), `EventSource`, `FileReader` and `ProgressEvent` are
  in the list of classes with an inspect method, and the docs of `node:sea`, the `bytes` loader and
  `legalComments` link to `/compiler/executables`, where upstream moved that page.

The list above is longer than the conflicts were. A review read the rebased stack against the new
compiler and found nine places where a patch and `--aot` did not know of each other: `--alias` was
silently ignored by `bun compile`, `Bun.JWT` threw for a `CryptoKey` and `localStorage` was
`undefined` in an ahead-of-time executable, `import.meta.glob()` built and then threw at the call,
and five smaller ones. Upstream's own tests of the table (`test/aot/builtins`) found the inspect
methods and the assertion.

After the rebase the whole workspace passes `cargo check`, the debug build links, and these test
files of the stack were run on it and pass: the shell (`bunshell`, `lex`, `parse`, `kill`, the five
builtins, `run-shell`), `bun test` (`coverage`, `parallel`, `test-last-failed`, `expect-poll`,
`fake-timers`, `bun-test`), the bundler (`bundler_iife`, `bundler_loader`, `bundler_comments`,
`bundler_import_meta_glob`, `bun-build-watch`), `EventSource`, Web Locks, Web Storage, `Bun.JWT`,
`Bun.Queue`, `Bun.msgpack`, `Bun.CSV`, `Bun.INI`, `unescapeHTML`, the `bytes` loader, `node:sea`,
`perf_hooks`, `bun serve`, response compression and routes of `Bun.serve`, `bun pm sbom`, `jsr:`,
the merge of `bun.lock`, S3 copy, SQL cursors, Redis, `streams`, `blob`, `console.log`,
`Bun.write`, watch mode. The bun-types tests, the source lints and upstream's checks of the table
against the build (`own-properties`, `module-exports`, `classes-with-inspect-method`,
`native-contract`) pass too. What does not pass here is not the stack: the recursive scans of
`scan.test.ts` time out in the debug build, which walks this checkout with its build directories,
and `semver.test.ts` needs the `semver` package, which this machine's `test/node_modules` did not
have.

Files: `src/js/internal/file_reader.ts` (new), `src/jsc/bindings/FileReaderBinding.cpp` and `.h`
(new), `src/jsc/bindings/ZigGlobalObject.cpp` (the two getters), `src/js/thirdparty/undici.ts`,
`src/codegen/builtins/host/globals.builtins.ts`, `features-web.builtins.ts`,
`unseen-code.builtins.ts` and `classes-with-inspect-method.ts`, `packages/bun-types/globals.d.ts`,
`packages/bun-types/bun.d.ts` (`ProgressEventInit`, `BunProgressEvent`, `BunFileReader`,
`FileReaderEventMap`), `docs/runtime/web-apis.mdx`, `test/js/web/filereader/filereader.test.ts`
(new), `test/integration/bun-types/fixture/globals.ts`.

## Dropped

- 2026-08-31, user-defined functions for `bun:sqlite` (`db.function()`): dropped on 2026-10-17.
  oven-sh/bun#45304 adds `db.function()` upstream, with the same better-sqlite3 signature and
  options, and `db.aggregate()` next to it.
- 2026-09-02, zip in `Bun.Archive`: dropped on 2026-10-27. oven-sh/bun#46638 removes libarchive
  from bun, and the patch was libarchive's zip reader and writer behind `Bun.Archive`. Upstream's
  new `src/tar` reads and writes tar only, so zip would need a reader and a writer of its own.
