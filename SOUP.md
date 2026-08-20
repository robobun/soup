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

## Dropped

Nothing yet.
