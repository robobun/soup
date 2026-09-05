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
`src/jsc/bindings/webcore/streams/JSReadableStream.cpp`, `src/runtime/webcore/response.classes.ts`,
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

Files: `src/runtime/api/INIObject.rs`, `src/runtime/api.rs`, `src/runtime/api/BunObject.rs`,
`src/runtime/Cargo.toml`, `Cargo.lock`, `src/ini/lib.rs` (optional env, BOM),
`src/install_jsc/ini_jsc.rs`, `src/jsc/bindings/BunObject.cpp`, `src/jsc/bindings/BunObject+exports.h`,
`packages/bun-types/bun.d.ts`, `docs/runtime/ini.mdx`, `docs/docs.json`, `docs/runtime/bun-apis.mdx`,
`test/js/bun/ini/ini.test.ts`, `test/integration/bun-types/fixture/ini.ts`.

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

Files: `src/runtime/api/CSVObject.rs`, `src/runtime/api.rs`, `src/runtime/api/BunObject.rs`,
`src/jsc/bindings/BunObject.cpp`, `src/jsc/bindings/BunObject+exports.h`, `packages/bun-types/bun.d.ts`,
`docs/runtime/csv.mdx`, `docs/docs.json`, `docs/runtime/bun-apis.mdx`, `test/js/bun/csv/csv.test.ts`,
`test/integration/bun-types/fixture/csv.ts`.

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
install side reads the range from the cached root package.json at the single point every install
path parses it (`root_package_json_source`, which runs before the manifest fetches). The run side
adds an `engines` map to the resolver's `PackageJSON`, filled only when `scripts` are (the project's
own package.json, not the thousands in node_modules), and checks it when a script is found. Left for
later: `devEngines` (`{ "runtime": { "name": "bun", "version": ">=1.3", "onFail": "error" } }`),
which needs a decision about what `"name": "node"` should mean to bun, and a check in `bunx`.

Files: `src/install/engines.rs`, `src/install/lib.rs`,
`src/install/PackageManager/install_with_manager.rs`, `src/resolver/package_json.rs`,
`src/runtime/cli/run_command.rs`, `docs/pm/cli/install.mdx`, `docs/runtime/index.mdx`,
`test/cli/install/bun-install.test.ts`, `test/cli/install/bun-run.test.ts`.

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

The command lists are not kept by hand. `Command::which`, which turned the first argument into a
`Tag` with a chain of forty string compares, now walks `ROOT_COMMANDS`, a table of name, aliases
and `Tag`, and the suggestions read that same table, so a new command is a new line in one place.
`bun pm` got the same treatment: its `if`/`else if` chain over the subcommand word is a
`PmSubcommand` enum parsed from one table and dispatched with an exhaustive `match`, so a
subcommand without a branch is a compile error. The selection and the note live in
`cli::did_you_mean` (`closest` takes any candidate type, a word accessor and a "same command"
predicate so an alias and its name count once), on top of `bun_core::strings::edit_distance`, the
first edit-distance helper in the tree (`bun audit fix` and `bun pm licenses` had hard-coded "did
you mean" notes). The `.bin` directories are listed with `bun_sys::iterate_dir`, skipping dotfiles
and, on Windows, folding the `.cmd`, `.ps1`, `.bunx`, `.exe` and `.bat` shims into the one name
they wrap. The whole thing runs only on the error path, after the exact lookups have failed.

Files: `src/bun_core/string/immutable.rs` (`edit_distance`), `src/runtime/cli/did_you_mean.rs`,
`src/runtime/cli/mod.rs` (`ROOT_COMMANDS`, `RootCommand`, `Command::which`),
`src/runtime/cli/run_command.rs` (`print_did_you_mean`), `src/runtime/cli/package_manager_command.rs`
(`PmSubcommand`), `docs/runtime/index.mdx`, `docs/pm/cli/pm.mdx`, `test/cli/run/run_command.test.ts`,
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

### 2026-08-31: user-defined functions for `bun:sqlite`

`bun:sqlite` could not be taught a new SQL function. `db.function()` is the one piece of the
`better-sqlite3` API it lacked that has no workaround: `x REGEXP y` is a hard error in SQLite until
the application supplies `regexp()`, a trigger cannot call back into JavaScript, and anything SQLite
cannot compute itself has to be pulled out row by row and computed in a loop (oven-sh/bun#1474, open
since 2022, is the request; three PRs have been opened against it and none merged). Meanwhile
`node:sqlite` in bun has had `function()` and `aggregate()` for a while. Today adds
`db.function(name, [options], fn)` to `bun:sqlite` in the `better-sqlite3` shape: SQLite calls `fn`
once per row with the column values, stores what it returns, and the registration returns the database
for chaining.

```ts
import { Database } from "bun:sqlite";

const db = new Database("app.db");

db.function("regexp", (re, s) => Number(new RegExp(re).test(s)));
db.query("SELECT name FROM users WHERE name REGEXP ?").all("^J");

const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
db.function("clamp", { deterministic: true }, clamp);
db.run("CREATE INDEX scores_clamped ON results (clamp(score, 0, 100))");

db.function("notify", { directOnly: true }, id => void changed.push(id));
db.run(`
  CREATE TRIGGER on_event AFTER INSERT ON events
  BEGIN SELECT notify(new.id); END
`);
```

Arguments are converted exactly like result columns (`TEXT` to `string`, `INTEGER` to `number`, or to
`bigint` with `safeIntegers`, `BLOB` to `Uint8Array`) and the return value exactly like a bound
parameter (a safe integer is `INTEGER`, any other number `REAL`, booleans `1`/`0`, `undefined` is
`NULL`); an object or a `Promise` is a `TypeError` with a message that says so, and a `bigint` outside
int64 a `RangeError`, where `node:sqlite` reports both as SQLite errors. Options are `better-sqlite3`'s:
`varargs` (otherwise the arity is `fn.length` and SQLite rejects other counts), `deterministic`
(`SQLITE_DETERMINISTIC`, required for index expressions), `directOnly` (`SQLITE_DIRECTONLY`, blocks
calls from views, triggers and defaults) and `safeIntegers`, which defaults to the database's setting.
An exception thrown by the function fails the statement and is rethrown as the same object by `.get()`,
`.all()`, `.values()`, `.run()`, the iterator, `db.run()` and even `columnTypes`; the statement is
reset on that path so its next execution does not report the stale error. Other statements on the
same database work from inside the function, which is what the trigger example relies on. The one
thing the function cannot touch is the statement that is calling it: running it again (easy to do by
accident, because `db.query()` hands out the same cached `Statement` for the same SQL string, so a
recursive `depth(id)` that queries itself hits it), finalizing it, or closing the database all throw,
because a `sqlite3_reset()` or `sqlite3_finalize()` issued from inside that statement's own
`sqlite3_step()` tears down the VDBE frame SQLite is about to return into and the next opcode reads a
freed cursor. The statement carries a `stepping` bit for exactly the duration of each `sqlite3_step()`,
so a statement merely paused between rows of an iterator can still be finalized, and the connection
counts the functions currently running on it so `close()` can refuse (`node:sqlite` defers the close
instead; for `bun:sqlite` an error is simpler and nobody closes a database from inside a row callback).

The JavaScript callback is rooted by a `Strong` handle owned by the SQLite-side registration object,
freed by `sqlite3_create_function_v2`'s destructor when the function is replaced or the connection
closes, so `db.function("f", () => 42)` with no other reference to the closure keeps working across
GCs, and a closure that captures `db` keeps the database alive, as in `better-sqlite3`. Inside the
callback a `TopExceptionScope` leaves the exception pending on the VM and fails the step with an
empty message; each of the eight `sqlite3_step()` sites checks for that pending exception and rethrows
it instead of wrapping SQLite's empty message, which reuses the pattern the `node:sqlite` binding in
the same tree established. While testing, a pre-existing bug turned up and was reported separately
rather than fixed here: `db.exec("a; b; c")` swallows a step error in `b` when `c` succeeds, because
the statement loop only breaks on a prepare error. `aggregate()` and window functions are left for
another day.

Files: `src/jsc/bindings/sqlite/JSSQLStatement.cpp` (`SQLiteUserFunction`, `jsSQLStatementCreateFunction`,
`RETURN_IF_UDF_THREW`, `JSSQLStatement::step`, `CHECK_NOT_STEPPING`, close/finalize guards),
`src/js/bun/sqlite.ts` (`Database.prototype.function`),
`packages/bun-types/sqlite.d.ts` (`FunctionOptions`, `FunctionArgument`, `FunctionResult`),
`docs/runtime/sqlite.mdx`, `test/js/bun/sqlite/sqlite.test.js`, `test/integration/bun-types/fixture/sqlite.ts`.

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

### 2026-09-02: zip in `Bun.Archive`

`Bun.Archive` could create and read tarballs, gzipped or not, and nothing else, while the archive
format most people actually get handed is zip: release downloads, GitHub source archives, uploads
from a browser, xlsx and docx, jars. Node has no zip support either, so every script pulls in
`adm-zip`, `jszip` or `archiver` for a format libarchive (which bun already links for `bun install`)
reads and writes natively (oven-sh/bun#27077 asks for exactly this). `Bun.Archive` now reads zip
files and builds them:

```ts
// Reading needs no option: tar, tar.gz and zip are detected from the bytes
const archive = new Bun.Archive(await Bun.file("release.zip").bytes());
await archive.extract("./release");
const readme = (await archive.files("README.md")).get("README.md");

// Building: each entry deflated at level 6
const zip = new Bun.Archive({ "hello.txt": "Hello" }, { format: "zip" });
await Bun.write("hello.zip", await zip.bytes());

new Bun.Archive(files, { format: "zip", level: 9 }); // deflate 1-9
new Bun.Archive(files, { format: "zip", compress: false }); // stored, for data that is already compressed
await Bun.Archive.write("bundle.zip", files, { format: "zip" });
```

The options grew a `format` (`"tar"`, the default, or `"zip"`), `compress` now also takes `"deflate"`
(the zip default, per entry) and `false` (no compression, which was already what a missing `compress`
meant for tar), and `level` is 1-9 for deflate (zlib's scale, which libarchive's zip writer uses) next
to 1-12 for gzip (libdeflate's). A tar option on a zip, or the reverse, is a `TypeError` that says which
values the format takes; `format` on existing archive bytes is one too, since those already have a
format. The zip ends at its end-of-central-directory record instead of being zero-padded to the 10 KiB
tar block, entries carry `UT` timestamps and the data descriptor every reader handles, and a file
whose method bun does not ship (bzip2, LZMA, XZ, Zstandard; PPMd is built in) or that is encrypted
rejects `files()` with libarchive's message (`Unsupported ZIP compression method (12: bzip)`) and
`extract()` with `ReadError`, instead of coming back empty.
`extract()` creates the explicit directory entries a `zip -r` archive has, symlinks with the same
escape check as tar, Unix modes from an archive made on Unix, and applies the same path traversal
checks as tar. A zip read as a stream (inside gzip, or with its central directory damaged) only
learns an entry's size after the entry's data, so all three readers (`files()`, `extract()` with and
without a glob) read every entry to its end instead of trusting the header, and a damaged entry
header fails the call instead of ending the listing early. `__MACOSX/._*` entries are listed on every
platform, as `unzip`, Python and Go do; libarchive folds them into the file they describe on macOS
only. In `Archive.write()`, `compress: false` now overrides an `Archive`'s own gzip setting, where
before it counted as "not given".

Three things under the surface had to change. libarchive's zip reader was deliberately left out of
bun's build (only tar and gzip were compiled in), so `archive_read_support_format_zip.c` and the
PPMd8 decoder it needs are now compiled, and `Bun.Archive` registers the reader; `bun install` and
`bun pm pack` still register tar only. The Rust binding over `archive_read_data_block` built a slice
from whatever pointer libarchive returned, and the zip reader returns an `ARCHIVE_OK` block with a
null pointer and zero length once a stored entry's bytes are used up (tar never does), which the
debug build's UB check caught as a panic in `extract()`. And libarchive keys the "names are UTF-8"
flag (general purpose bit 11) on the process locale, which is `"C"` in bun, so a zip bun wrote would
have told Python, macOS and Windows to read `日本.txt` as CP437, and a zip another tool wrote with
the flag set lost the name entirely on read (the conversion to the `"C"` locale fails and upstream
leaves the entry with no pathname, where its tar reader falls back to the raw bytes). A small
libarchive patch adds a `utf8-names` writer option and gives the zip reader the same raw-bytes
fallback as tar; on Windows the writer and the reader additionally get `hdrcharset=UTF-8`, because
there a name travels as a wide string and would otherwise be converted through the OEM code page on
the way out, and widened byte by byte on the way in when the flag is missing. The tests were run on
Linux and Windows, with zips built by hand in the test (local headers, central directory, end record)
so the reader is checked against the real layout and not only against bun's own writer, and bun's
zips were checked with Python's `zipfile` and `unzip -t`. Left for later: zip64 (libarchive writes
it when an entry passes 4 GiB and reads it, but no test pins that), writing symlink entries, and
converting between tar and zip.

Two pre-existing bugs turned up on the way and were reported separately rather than fixed here:
`new Bun.Archive({ "a.txt": Bun.file(path) })` writes an empty entry, because the builder takes the
in-memory view of every `Blob` and a file-backed one has none, and the docs' "Create Archive from
Directory" example does exactly that; and `Bun.write("out.tar.gz", archive)` writes the plain
tarball whatever `compress` says, which only `archive.bytes()`, `blob()` and `Bun.Archive.write()`
honour, while the docs promise a `.tar.gz`.

Files: `src/runtime/api/Archive.rs`, `src/libarchive/lib.rs`, `scripts/build/deps/libarchive.ts`,
`patches/libarchive/zip-utf8-names.patch`, `packages/bun-types/bun.d.ts`, `docs/runtime/archive.mdx`,
`test/js/bun/archive.test.ts`, `test/integration/bun-types/fixture/bun.ts`.

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

## Dropped

Nothing yet.
