### Problem
- A 16-bit string with an unpaired surrogate aborts the process when its UTF-8 form is about 1.43 GB or more. Bun prints `panic(main thread): abort() called` and exits 134, also inside `try`/`catch`.
- After a failed strict conversion, `StringImpl::tryGetUTF8ForCharacters` regrows its buffer with `Vector::resize()` (`StringImpl.h:1537`), which asks for 1.5x the capacity. From a first buffer of 1,431,655,766 bytes that is over the `Vector` limit, and `CRASH()` follows (`Vector.h:228`).
- The line came with [bug 304916](https://bugs.webkit.org/show_bug.cgi?id=304916) and is in upstream main.

### Fix
- `utf8ForIllFormedCharacters()` replaces the `resize()` and `utf8ForCharactersIntoBuffer()`, under `USE(BUN_JSC_ADDITIONS)`. It allocates exactly 3 bytes for each code unit, and a failed allocation is `OutOfMemory`. It makes one replacing pass with simdutf and no second strict pass.
- Bytes and errors do not change: 15,032,260 old-versus-new comparisons on four simdutf kernels give 0 differences.
- Verified: TestWebKitAPI `WTF.StringUTF8ConversionUnpairedSurrogateAroundBufferSizes` and a `JSTests/stress` file for the abort.
- Self-reviewed: 5 concerns raised, 4 addressed (Notes).

### Background
- `String::utf8()`, `tryGetUTF8()` and `StringView::tryGetUTF8()` all end in this function. Only an unpaired surrogate makes its strict conversion fail, and then a second conversion writes U+FFFD.
- Weighed: a cap in `Vector::expandCapacity` also stops the abort, but this site would still allocate too much and copy. A converter in Bun does not reach `Date.parse`.

### Downsides
- Fork-only code: 36 lines in 2 WTF files. A replay of the last upstream merge conflicts in no source hunk.
- Not fixed: a failed allocation of the first buffer or of the `UTF8CString` still crashes.
- Cost per call: none found in 400 rows on four kernels (instructions, allocations).
