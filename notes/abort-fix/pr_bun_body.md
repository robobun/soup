Draft until oven-sh/WebKit#791 merges. `WEBKIT_VERSION` is its preview build, for CI on every platform. The merged commit replaces it before this leaves draft.

### Problem
- A 16-bit string with an unpaired surrogate aborts the process when its UTF-8 form is about 1.43 GB or more: `panic(main thread): abort() called`, exit 134, also inside `try`/`catch`. `Date.parse()` and `db.prepare()` of `bun:sqlite` and `node:sqlite` reach it.
- The cause is in WTF: after a failed strict conversion, `StringImpl::tryGetUTF8ForCharacters` regrows its buffer with `Vector::resize()`. The 1.5x that it asks for is over the `Vector` limit, and `CRASH()` follows.

### Fix
- oven-sh/WebKit#791 allocates that second buffer at its exact size, 3 bytes for each code unit. A failed allocation there is an error. No bun source changes.
- Verified: three new tests in `test/js/bun/util/utf8-conversion-limit.test.ts`. On main's pin the first (release) and the second (debug) get exit 134. With this pin the file passes in release and with `bun bd test`.
- Self-reviewed: 5 concerns raised, 4 addressed (list in oven-sh/WebKit#791).

### Background
- `UTF8View` (`BunString.h`) calls `tryGetUTF8()` for every string that is not 8-bit ASCII. `Date.parse()` converts inside JavaScriptCore, so a fix in bun's bindings does not reach it.
- Only an unpaired surrogate makes the strict conversion fail. A second conversion then writes U+FFFD.

### Downsides
- Still aborts: `new Bun.CookieMap("a=%41" + thatString)`, in `StringBuilder::didOverflow()`. A failed allocation of the first buffer or of the result also still crashes.
- Cost per call: none found. oven-sh/WebKit#791 measures 400 rows, 0 with more instructions or allocations. Release text is 4,864 bytes smaller for the whole bump.
