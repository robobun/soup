<details><summary>Notes</summary>

**Repro.** Each of these exits 134 in a release build of Bun main (`e655c58032`, linux x64):

```js
const text = "\u65e5".repeat(477_218_588) + "\ud800a";
Date.parse(text);
new (require("bun:sqlite").Database)(":memory:").prepare("select '" + text + "'");
new (require("node:sqlite").DatabaseSync)(":memory:").prepare("select '" + text + "'");
```

The same string through `StringImpl::utf8ForCharacters()` and `tryGetUTF8ForCharacters()` in a program linked with the pin's `libWTF.a`: exit 134 in both forms and in the three modes. With this change: 1,431,655,768 bytes that end in `e6 97 a5 ef bf bd 61`, peak RSS 3,644 MB (`UTF8CString` form) and 2,278 MB (callback form). `StrictConversion` gives `Invalid`. The Bun pull request has the results for the three calls above.

**Why there is a second buffer.** simdutf does not define `utf8_length_from_utf16le` for ill-formed input. Its kernels count an unpaired surrogate as 2 bytes in most positions, and U+FFFD takes 3. The arm64 kernel can count 4 for one at the very end. So the first buffer can be too small for the replaced form, and upstream grows it to 3 bytes for each code unit.

**The strings that abort.** The first buffer is 1,431,655,766 bytes or more, so that `capacity + capacity / 2` is over 2^31 - 1. The string has at most 715,827,882 code units, so that 3 bytes for each pass the check in front of the `resize()`. A string under that size converted before, in a buffer of up to 2^31 - 1 bytes. Now its buffer is 3 bytes for each code unit.

**What the helper keeps from upstream.** The order of the checks: `OutOfMemory` when 3 bytes for each code unit are not a valid capacity, then `Invalid` for `StrictConversion`. The bytes: `simdutf::convert_utf16le_to_utf8_with_replacement` writes what `Unicode::convertReplacingInvalidSequences()` writes. It does not repeat `convert_utf16le_to_utf8_with_errors`, which fails again for the same string. A first buffer that is already large enough is used again.

**Instructions and allocations for one call.** `StringImpl.cpp`, `CString.cpp` and `URL.cpp` compiled from `main` and from this branch with the command lines that the pin's prebuilt recorded, and linked in front of the pin's `libWTF.a`. A tracer single-steps the call and counts. The allocator behind `fastMalloc` is a stub with a fixed cost that counts calls, and `memcpy` costs one instruction for each byte. 200 inputs (Latin-1 and UTF-16, well-formed and with an unpaired surrogate, 0 to 65,536 units) in the callback form and in the `UTF8CString` form, with the simdutf kernel set to icelake, haswell and westmere, and on arm64 under qemu-user.

| Input (`UTF8CString` form unless noted) | icelake | haswell | westmere | arm64 | allocations |
| --- | --- | --- | --- | --- | --- |
| UTF-16, 7 CJK units + unpaired surrogate, lenient | 1,444 -> 897 | 1,549 -> 920 | 1,499 -> 875 | 1,437 -> 902 | 1 -> 1 |
| UTF-16, 31 CJK units + unpaired surrogate, lenient | 3,728 -> 2,219 | 4,013 -> 2,092 | 4,500 -> 2,353 | 4,291 -> 2,407 | 1 -> 1 |
| UTF-16, 340 CJK units + unpaired surrogate, lenient | 28,022 -> 13,545 | 30,736 -> 15,008 | 32,428 -> 16,064 | 31,805 -> 17,432 | 1 -> 1 |
| UTF-16, 999 CJK units + unpaired surrogate, lenient | 84,209 -> 39,047 | 90,297 -> 42,345 | 95,322 -> 45,422 | 102,817 -> 49,620 | 3 -> 3 |
| UTF-16, 999 CJK units + unpaired surrogate, strict | 90,801 -> 2,845 | 100,187 -> 6,143 | 108,289 -> 9,220 | 103,883 -> 8,368 | 2 -> 1 |
| UTF-16, unpaired surrogate + 999 ASCII units, lenient | 41,177 -> 7,048 | 41,555 -> 7,491 | 42,698 -> 8,627 | 43,616 -> 10,770 | 2 -> 2 |
| UTF-16, unpaired surrogate + 999 ASCII units, strict | 2,793 -> 793 | 3,614 -> 1,236 | 5,893 -> 2,372 | 6,619 -> 1,218 | 1 -> 0 |
| callback form: 999 CJK units + unpaired surrogate, lenient | 81,147 -> 35,952 | 87,235 -> 39,250 | 92,260 -> 42,327 | 90,694 -> 37,496 | 2 -> 2 |
| UTF-16, 8 CJK units, well-formed | 495 -> 495 | 601 -> 601 | 556 -> 556 | 616 -> 614 | 1 -> 1 |
| UTF-16, 4,096 CJK units, well-formed | 22,713 -> 22,713 | 34,288 -> 34,288 | 47,503 -> 47,503 | 80,859 -> 80,857 | 2 -> 2 |
| callback form: UTF-16, 8 CJK units, well-formed | 379 -> 378 | 485 -> 484 | 440 -> 439 | 396 -> 394 | 0 -> 0 |
| Latin-1, 400 x U+00E9 | 17,750 -> 17,750 | 17,750 -> 17,750 | 17,750 -> 17,750 | 21,446 -> 21,446 | 1 -> 1 |

- icelake, haswell, westmere: 400 rows each, 0 above +0, 235 equal, 165 below, 0 with more allocations, 12 with fewer.
- arm64: 400 rows, 0 above +0, 140 equal, 260 below, 0 with more allocations, 10 with fewer.

The rows below are the strings with an unpaired surrogate, and well-formed UTF-16 by 1 to 3 instructions.

**Same bytes.** A generator gives both builds the same inputs: every string of up to 6 units over 6 kinds of code unit, one or two surrogates at every position of strings around 341 and 1,024 units, and random mixtures up to 69,000 units. Each input goes through both forms in the three modes. 15,032,260 comparisons of the base build with this one on the icelake, haswell, westmere and arm64 kernels: 0 differences. Each build also compares every result with `Unicode::convertReplacingInvalidSequences()` and `Unicode::convert()`.

**Tests and CI.** Fork CI runs neither test: it passes `--memory-limited` (the stress file needs 6 GB) and does not build TestWebKitAPI. The stress file exits 134 on the pin's `jsc`. The TestWebKitAPI test passes with and without this change: it holds the bytes and the errors of the second conversion, which is a different converter now. `TestWTF` built locally: the new test passes, and 281 other String, URL and UTF tests pass. Two things are local to that build: the `ExternalStringImpl` tests in `Tests/WTF/StringImpl.cpp` do not compile in the fork today and were disabled, and `WTF.StringViewIterators` was left out because ICU could not open a break iterator in that build directory. The Bun pull request has the tests that CI runs.

**Upstream merges.** `git merge-file` of this patch with the reverse of upstream changes to these lines: the merge of 2026-10-06 conflicts in 0 hunks of the two source files and in 1 hunk of the test file. The `grow` to `resize` change and the simdutf span change conflict in 0. The change that added these lines (bug 304916) conflicts in 2.

**Self-review.** The first version of this branch also rewrote both conversion functions for speed and made every allocation of the conversion fallible (270 more lines). The review asked for five things:
1. Ship the abort fix alone. Done: this is the first commit of that branch.
2. Ship it with the stress file. Done.
3. Cut the TestWebKitAPI test to the second conversion. Done.
4. Link the upstream bug in the code comment. The comment links bug 304916, which added the line. A bug for the abort itself is not filed on bugs.webkit.org yet.
5. Name a CI lane that runs a test which fails without the change. The Bun pull request has it.

The speed work stays on the branch `robobun/99d68896/utf8-conversion-fallible`. It needs wall-clock numbers for both encodings before it is a pull request.

**Not in this PR.**
- The first buffer and the `UTF8CString` still come from allocations that crash when they fail.
- `String::utf8()`, `StringView::utf8()` and `StringImpl::utf8()` still `RELEASE_ASSERT` that the conversion worked.
- `Vector::expandCapacity` still asks for 1.5x for every other `Vector` that grows near its limit. #691 is about the limit itself.

</details>
