<details><summary>Notes</summary>

**Repro.** Release builds, linux x64. `text` is `"\u65e5".repeat(477_218_588) + "\ud800a"`. "main" is `e655c58032` with the pin `0c06faadf6`. "this pin" is `71d0d43997` with the preview build.

| Call | main | this pin |
| --- | --- | --- |
| `Date.parse(text)` | exit 134 | `NaN` (14.1 s, peak RSS 5,489 MB) |
| `new Database(":memory:").prepare("select '" + text + "'")` (`bun:sqlite`) | exit 134 | `SQLiteError: statement too long` (7.5 s, 4,581 MB) |
| `db.run()` with the same statement | exit 134 | `SQLiteError: statement too long` |
| `new DatabaseSync(":memory:").prepare("select '" + text + "'")` (`node:sqlite`) | exit 134 | `ERR_SQLITE_ERROR: string or blob too big` (7.7 s, 4,580 MB) |
| `crypto.hkdfSync("sha256", "key", text, "info", 8)` | exit 134 | returns 8 bytes |
| `require.resolve.paths(text)` | exit 134 | returns an array |
| `new Bun.CookieMap("a=%41" + text)` | exit 134 | exit 134 |

The last row converts now and then aborts in `StringBuilder::didOverflow()` (`StringBuilder.cpp:46`), called from `decodeURIComponentSIMD` for `CookieMap.cpp:117`. That is a different limit.

**The tests.**
1. `a long 16-bit string with an unpaired surrogate converts instead of aborting`. Release builds on a machine with 12 GiB or more. The child needs 5 GB and takes 11 s. On main: exit 134.
2. `the second buffer for an unpaired surrogate has the exact size, and can fail`. Debug builds. WebKit's debug-only `maxSingleAllocationSize` option refuses every allocation over 4 MiB here. On main: `ASSERTION FAILED: Requested size (4500000) exceeds max single allocation size set for testing (4194304)`, exit 134.
3. `an unpaired surrogate converts to U+FFFD on each side of the conversion's buffer sizes`. Every build. It passes on main too: it holds the bytes of the second conversion, which is a different converter now.

**What the bump carries.** The preview is the fork's main with oven-sh/WebKit#791 on top. The fork's main has two changes that the current pin does not have: oven-sh/WebKit#774 and oven-sh/WebKit#787.

**Size.** Release builds of `71d0d43997`, linux x64: text is 89,103,803 bytes with the pin `0c06faadf6` and 89,098,939 bytes with the preview. That is the three changes together.

**Not in this PR.**
- The call sites of `.utf8()` that assert on a failed conversion. #42868 moves the ones in sqlite, console and process, and edits the same test file.
- The speed work on the conversion (no measuring pass for short UTF-16, simdutf for Latin-1, fallible allocations). It is written and measured, and it waits for wall-clock numbers and its own pull request. oven-sh/WebKit#791 says where it is.

</details>
