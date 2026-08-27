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

## Dropped

Nothing yet.
