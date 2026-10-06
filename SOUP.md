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
`src/runtime/test_runner/jest.classes.ts`, `src/runtime/test_runner/expect.rs`
(`counts_as_assertion`, `js_dont_count_as_assertion`), `src/runtime/test_runner/timers/FakeTimers.rs`,
`src/codegen/generate-js2native.ts`, `packages/bun-types/test.d.ts`, `docs/test/writing-tests.mdx`,
`test/js/bun/test/expect-poll.test.ts`, `test/integration/bun-types/fixture/test.ts`.

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
and whose tree both the tarball and `normalized_package` print; `published_files` runs after it.
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
`src/runtime/api/Shell.classes.ts`, `src/runtime/api/ParsedShellScript.classes.ts`,
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
  new one: it is refreshed with a plain `git fetch`, which in a `--bare` clone (no fetch refspec)
  updates no ref at all. So with a warm cache `bun update` never moved, and a range that only a
  new tag satisfies failed until `bun pm cache rm`. The refresh is now `git fetch --tags --force`.
  That is the tag half of what oven-sh/bun#35566 proposes upstream (the other half, branches, is
  left to it: oven-sh/bun#13769), and it also makes a plain `#v1.5.0` that was tagged after the
  first install resolve (oven-sh/bun#18947). `github:` ranges always ask the remote.
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
`max_satisfying_tag`), `src/install/git_runner.rs` (`Step::Tags`, the refresh of a cached clone),
`src/install/PackageManager/PackageManagerEnqueue.rs` (the `github:` lookup),
`src/install/PackageManager/runTasks.rs` (`alloc_github_remote_url`, `alloc_github_url_at`, the
error messages), `src/install/PackageManagerTask.rs`, `docs/pm/cli/add.mdx`,
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

It is all JavaScript, in the layer the three adapters share. Every query ends in one of two
`handle.run(connection, query)` calls in `src/js/bun/sql.ts` (the pool's, and the one transactions
and reserved connections use), and the hook sits in front of both. The text is not stored on the
query: the hook runs `normalizeQuery()` again, so only a debugged query pays for it, and without
`debug` the whole cost is one more bound argument per query. The printer goes through
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

Files: `src/js/bun/sql.ts` (`debugQuery`, the frame in `queryFromPoolHandler`),
`src/js/internal/sql/shared.ts` (`parseDebugOption`, `printQuery`), `packages/bun-types/sql.d.ts`,
`docs/runtime/sql.mdx`, `docs/runtime/debugger.mdx`, `docs/runtime/environment-variables.mdx`,
`test/js/sql/sql-debug.test.ts` (new), `test/integration/bun-types/fixture/sql.ts`.

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
registry's lifetime), `src/runtime/test_runner/expect.rs`, `src/runtime/test_runner/mod.rs`,
`src/runtime/test_runner/diff_format.rs`, `packages/bun-types/test.d.ts`, `docs/test/snapshots.mdx`,
`docs/test/writing-tests.mdx`, `test/js/bun/test/snapshot-tests/snapshots/snapshot.test.ts`,
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
| `bun pm pack`, `bun publish`, `bun prune`                          | as before: the parse error, exit 1                                                                                                          |

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
  for, and a plain dependency that follows an `npm:` alias of its own name. That last rule was a
  loop inside `enqueue_dependency_with_main_and_success_fn`. It is a function now,
  `follows_npm_alias`, and the resolver and the merge call the same one.
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

Files: `src/install/lockfile/merge_conflict.rs` (new), `src/install/lockfile.rs`
(`load_from_cwd_for_install`, `LoadResultOk::merged_conflict`, the parse-error arm),
`src/install/lockfile/bun.lock.rs` (`LoadMode`),
`src/install/PackageManager/install_with_manager.rs` (`report_merged_conflict`, `OpenEdges`),
`src/install/PackageManager/PackageManagerEnqueue.rs` (`follows_npm_alias`),
`src/install/PackageManager.rs`, `src/install/dedupe.rs`,
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

## Dropped

Nothing yet.
