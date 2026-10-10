<details><summary>Notes</summary>

**Repro.** Bun release build, linux x64, main `e655c58032`. Each call exits 134 on main.

| Call | With this change |
| --- | --- |
| `Date.parse("\u65e5".repeat(477_218_588) + "\ud800a")` | `NaN` |
| `bun:sqlite` `db.prepare("select '" + thatString + "'")`, also `db.run()` | `SQLiteError: statement too long` |
| `node:sqlite` `db.prepare()` with the same SQL | `ERR_SQLITE_ERROR: string or blob too big` |
| `crypto.hkdfSync("sha256", "key", thatString, "info", 8)`, `require.resolve.paths(thatString)` | return |

The string needs a first buffer of 1,431,655,766 bytes or more, so that 1.5x of it is over 2^31 - 1, and at most 715,827,882 code units, so that 3 bytes for each fit. At 1,431,655,765 bytes the pin converts (and grows to a buffer of 2^31 - 1 bytes to do it). The arm64 simdutf kernel counts 4 bytes for an unpaired surrogate at the very end of a string, so there the string must not end with the surrogate.

**Origin.** 312057@main changed `grow` to `resize` on this line for a string that ends with an unpaired surrogate. The two template functions and the helpers in `StringImpl.cpp` are the same text in upstream main today. The first commit alone is the fix for upstream.

**The commits.**
1. The abort. `utf8ForIllFormedCharacters()` replaces `utf8ForCharactersIntoBuffer()`. It keeps the order of the checks (3 bytes for each code unit must be a valid size, then `Invalid` for `StrictConversion`), frees the first buffer, allocates exactly 3 bytes for each code unit, and makes one `simdutf::convert_utf16le_to_utf8_with_replacement` pass. A first buffer that is already large enough is used again (the arm64 count). The buffer has the largest possible size and not the measured size of the replaced form: that needs no second measuring pass, and it does not depend on two passes that agree (310857@main is about that).
2. The two template overloads. `UTF8ConversionBuffer` replaces `Vector<char8_t, 1024>`. A 16-bit string of 341 code units or fewer goes straight into the inline buffer. Latin-1 goes through `simdutf::convert_latin1_to_utf8`, or through an inline loop under 16 characters, where the call into simdutf costs more. ARM64 keeps `find8NonASCII()` and gives an all-ASCII string to the callback as it is.
3. `utf8ForCharacters()`, which is behind `utf8()` and `tryGetUTF8()`. The `UTF8CString` comes from the new `tryNewUninitialized()`. A 16-bit result of over 1,024 bytes is converted straight into it.
4. Tests.

**Instructions and allocations for one call.** `StringImpl.cpp`, `CString.cpp` and `URL.cpp` compiled from `main` and from each commit with the command lines that the pin's prebuilt recorded, and linked in front of the pin's `libWTF.a`. A tracer single-steps the call and counts. The allocator behind `fastMalloc` is a stub with a fixed cost that counts calls, and `memcpy` costs one instruction for each byte, so a row does not depend on the state of the heap or on an alignment. 200 inputs (Latin-1 and UTF-16, ASCII, 2-byte, 3-byte, surrogate pairs, unpaired surrogates in the three modes, 0 to 65,536 units) in the callback form and in the `UTF8CString` form, with the simdutf kernel set to icelake, haswell and westmere, and on arm64 under qemu-user.

| Input (CString form unless noted) | icelake | haswell | westmere | arm64 | allocations |
| --- | --- | --- | --- | --- | --- |
| Latin-1, 1 ASCII character | 177 -> 131 | 177 -> 131 | 177 -> 131 | 187 -> 173 | 1 -> 1 |
| Latin-1, 8 x U+00E9 | 502 -> 243 | 502 -> 243 | 502 -> 243 | 670 -> 366 | 1 -> 1 |
| Latin-1, 16 ASCII characters | 582 -> 196 | 582 -> 224 | 582 -> 174 | 322 -> 308 | 1 -> 1 |
| Latin-1, 100 characters, 1 in 8 not ASCII | 3,071 -> 346 | 3,071 -> 796 | 3,071 -> 781 | 3,761 -> 1,296 | 1 -> 1 |
| Latin-1, 400 x U+00E9 | 17,750 -> 1,191 | 17,750 -> 2,166 | 17,750 -> 2,477 | 21,446 -> 5,178 | 1 -> 1 |
| Latin-1, 4,096 ASCII characters | 110,776 -> 5,072 | 110,776 -> 6,633 | 110,776 -> 6,585 | 18,953 -> 18,939 | 2 -> 2 |
| UTF-16, 1 CJK unit | 341 -> 272 | 325 -> 232 | 317 -> 227 | 302 -> 233 | 1 -> 1 |
| UTF-16, 8 CJK units | 495 -> 293 | 601 -> 468 | 556 -> 463 | 616 -> 511 | 1 -> 1 |
| UTF-16, 32 CJK units | 1,084 -> 426 | 981 -> 872 | 1,242 -> 1,098 | 1,429 -> 1,332 | 1 -> 1 |
| UTF-16, 16 surrogate pairs | 796 -> 426 | 1,034 -> 925 | 1,075 -> 931 | 1,236 -> 1,139 | 1 -> 1 |
| UTF-16, 341 ASCII units | 973 -> 731 | 1,362 -> 908 | 1,818 -> 944 | 2,514 -> 2,048 | 1 -> 1 |
| UTF-16, 342 ASCII units | 992 -> 967 | 1,392 -> 1,367 | 1,837 -> 1,812 | 2,542 -> 2,525 | 1 -> 1 |
| UTF-16, 342 CJK units | 2,241 -> 1,146 | 3,784 -> 2,689 | 4,829 -> 3,734 | 7,595 -> 3,396 | 2 -> 1 |
| UTF-16, 4,096 CJK units | 22,713 -> 10,356 | 34,288 -> 21,931 | 47,503 -> 35,146 | 80,859 -> 31,612 | 2 -> 1 |
| UTF-16, 31 CJK units + unpaired surrogate, lenient | 3,728 -> 1,604 | 4,013 -> 2,016 | 4,500 -> 2,242 | 4,291 -> 2,347 | 1 -> 1 |
| UTF-16, 999 CJK units + unpaired surrogate, lenient | 84,209 -> 39,013 | 90,297 -> 42,311 | 95,322 -> 45,388 | 102,817 -> 49,605 | 3 -> 3 |
| UTF-16, 999 CJK units + unpaired surrogate, strict | 90,801 -> 2,859 | 100,187 -> 6,157 | 108,289 -> 9,234 | 103,883 -> 8,385 | 2 -> 1 |
| callback form: UTF-16, 8 CJK units | 379 -> 198 | 485 -> 373 | 440 -> 368 | 396 -> 309 | 0 -> 0 |
| callback form: UTF-16, 4,096 CJK units | 10,332 -> 10,324 | 21,907 -> 21,899 | 35,122 -> 35,114 | 31,583 -> 31,579 | 1 -> 1 |
| callback form: Latin-1, 400 x U+00E9 | 16,853 -> 316 | 16,853 -> 1,291 | 16,853 -> 1,602 | 18,117 -> 1,840 | 0 -> 0 |

- icelake: 400 rows, 0 above +0, 0 with more allocations, 39 with fewer, largest saving -2,717,694 (cs8 latin1 e-acute n=65536)
- haswell: 400 rows, 0 above +0, 0 with more allocations, 39 with fewer, largest saving -2,600,677 (cs8 latin1 e-acute n=65536)
- westmere: 400 rows, 0 above +0, 0 with more allocations, 39 with fewer, largest saving -2,527,088 (cs8 latin1 e-acute n=65536)
- arm64: 400 rows, 0 above +0, 0 with more allocations, 37 with fewer, largest saving -2,703,143 (cb8 latin1 e-acute n=65536)

Each of the three code commits alone also has 0 rows above +0 and 0 rows with more allocations on the four kernels (384 rows, up to 4,096 units).

**Same bytes.** A generator gives both builds the same inputs: every string of up to 6 units over 6 kinds of code unit, one or two surrogates at every position of strings around each length limit, and random mixtures up to 69,000 units. Each input goes through both forms in the three modes. 15,032,260 comparisons of the base build with this one on the icelake, haswell, westmere and arm64 kernels: 0 differences. Each build also compares every result with `Unicode::convertReplacingInvalidSequences()` and `Unicode::convert()`, which this change does not touch.

**Time.** Bun's release mimalloc, all functions aligned to 64 bytes in both builds, 60 processes for each build in turn, the fastest of 1,800 batches for each row. 384 rows on 3 kernels: 0 rows slower in both of two sessions by more than the difference between two sessions of one build. That difference is large on this shared machine (95th percentile 13% to 26%), and one row moves by -17% to +24% with the address of its input. What is clear of that noise: Latin-1 of 16 characters and up is 21% to 99% faster (median 86% to 94%), ill-formed UTF-16 11% to 96% faster, UTF-16 of 341 units or fewer 4% to 80% faster. The `UTF8CString` form of well-formed UTF-16 of 1,000 units and up has a median of -15% (icelake), -7% (haswell), -5% (westmere). The counts above say more for those rows than the time does, because a copy counts one instruction for each byte.

**Calls in Bun.** Release builds of Bun `main` with the pin and with this change, instructions for one call (`BUN_JSC_useConcurrentJIT=0`, smallest of 4):

| Call | Pin | This change |
| --- | --- | --- |
| `Date.parse("2024-01-15T10:30:00.123Z")` | 2,941 | 2,347 |
| `new Date("2024-01-15T10:30:00.123Z")` | 2,999 | 2,405 |
| `bun:sqlite` `SELECT length(?)` with 23 ASCII characters and U+00E9 | 4,035 | 3,425 |
| the same with 400 x U+00E9 | 27,767 | 11,208 |
| `node:sqlite` `SELECT length(?)` with 24 ASCII characters | 5,409 | 4,815 |
| `node:sqlite` `SELECT length(?)` with 24 CJK characters | 5,743 | 5,237 |
| `bun:sqlite` `SELECT length(?)` with 24 ASCII characters (no conversion) | 3,638 | 3,638 |

No call of the 35 measured is more than 1 instruction above the pin. Bun's release text goes from 88,976,059 to 88,974,523 bytes.

**Memory.** Peak RSS of the `bun:sqlite` call above: 4,581 MB, and `Date.parse`: 5,490 MB. A string of the same length with no unpaired surrogate has the same two peaks on main, and 3,216 MB and 4,125 MB with this change: one buffer of 1.43 GB less.

**Allocations that are refused.** `ulimit -v 2621440`, then `Date.parse()` of 160,000,000 x U+65E5 or of 320,000,000 x U+00E9 inside `try`/`catch`: main exits 139 (`Segmentation fault at address 0xBBADBEEF`), this change throws `RangeError: Out of memory`. In a debug build, `maxSingleAllocationSize=4194304` refuses larger allocations, and five strings of 2 to 4 MB each reach one of the allocations of the conversion: the pin aborts at the first (`Requested size (4499998) exceeds max single allocation size`, the 1.5x again), this change converts that one and throws `RangeError: Out of memory` for the other four. That is a test in the Bun pull request.

**Two choices.**
- The result is converted straight into the `UTF8CString` only when its measured size is over 1,024 bytes. For every 16-bit string over 341 units it would be one allocation more than today for an ill-formed string whose first buffer fits inline.
- The empty string keeps upstream's allocation of 17 bytes. A fallible one made the conversion of an empty string 1 instruction (x64) to 12 instructions (arm64) longer, and upstream's own `StringView::tryGetUTF8()` allocates `u8""` the same way for a null view.

**Tests and CI.** Fork CI does not build TestWebKitAPI, and its `Tests/WTF/StringImpl.cpp` does not compile with `USE(BUN_JSC_ADDITIONS)` today (`ExternalStringImpl::create` takes a context argument in the fork). I built `TestWTF` with those tests disabled: the new test passes, and 283 of the 284 String, CString, URL and UTF tests pass. The one that fails, `WTF.StringViewIterators`, cannot open an ICU break iterator in my build directory. Fork CI runs JSTests with `--memory-limited`, which skips the new stress file: it needs 6 GB. On the pin's `jsc` it exits 134. The Bun pull request has the tests that CI runs.

**Upstream merges.** `git merge-file` of this patch with the reverse of four upstream changes of 2026 to these lines: 6 conflict hunks with the merge of 2026-10-06, which rewrote `CString` (2 in `CString.h`, 2 in `CString.cpp`, 1 in `StringImpl.cpp`, 1 in the test file), 1 with 304916 (the simdutf conversion), 0 with 312057@main and 0 with 311549@main.

**Not in this PR.**
- `String::utf8()`, `StringView::utf8()` and `StringImpl::utf8()` still `RELEASE_ASSERT` that the conversion worked. Their callers get the larger strings and the speed, and no error. oven-sh/bun#42868 moves Bun's call sites.
- `Vector::expandCapacity` still asks for 1.5x for every other `Vector` that grows near its limit.
- `new Bun.CookieMap("a=%41" + thatString)` still aborts after the conversion, in `StringBuilder::didOverflow()` from Bun's `decodeURIComponentSIMD`.
- An 8-bit string of 2^30 characters is still refused before it is read, ASCII or not.

**Other open pull requests on these files.** #691 and #683 (`StringImpl.h`, `StringImpl.cpp`), #631. oven-sh/bun#42868 edits the same Bun test file.

</details>
