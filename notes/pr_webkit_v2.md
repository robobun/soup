### Problem
- A 16-bit string with an unpaired surrogate aborts the process when its UTF-8 form is over 1,431,655,764 bytes. Bun prints `panic(main thread): abort() called` and exits 134, also inside `try`/`catch`.
- After a failed strict conversion, `StringImpl::tryGetUTF8ForCharacters` regrows its buffer with `Vector::resize()` (`StringImpl.h:1537`). That asks for 1.5x the capacity, over the `Vector` limit, and calls `CRASH()` (`Vector.h:228`).
- The conversion returns `UTF8ConversionError`, but its four allocations crash on failure.

### Fix
- Bun versions of `tryGetUTF8ForCharacters` and `utf8ForCharacters` stand beside upstream's text, which stays under `#else`. Each buffer has the exact size, and a failed allocation is `OutOfMemory`.
- Short UTF-16 skips the measuring pass and Latin-1 uses simdutf. Ill-formed UTF-16 takes one replacing pass, and a long result converts straight into its `UTF8CString`.
- Limits and output bytes do not change: 15,032,260 old-versus-new comparisons on four simdutf kernels give 0 differences.
- Verified: TestWebKitAPI `WTF.StringUTF8ConversionAroundBufferSizes` and a new `JSTests/stress` file. SELF_REVIEW_LINE

### Background
- `String::utf8()`, `tryGetUTF8()` and `StringView::tryGetUTF8()` all end in these two functions.
- Weighed: the exact regrow alone (commit 1) leaves three crashing allocations. A clamp in `Vector::expandCapacity` costs every growing `Vector`. A converter in Bun does not reach `Date.parse`.

### Downsides
- Upstream merges: 306 added lines in 4 WTF files. A replay of four 2026 upstream changes conflicts in 7 hunks.
- Not fixed: `utf8()` still asserts on a failed conversion. The empty string keeps upstream's crashing 17-byte allocation.
- Cost per call: none found in 400 rows on four kernels (instructions, allocations). Bun's release text is 1,536 bytes smaller.
