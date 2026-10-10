# Notes for the WTF UTF-8 conversion work

- `abort-fix/`: the bodies of oven-sh/WebKit#791 and oven-sh/bun#44949 (the abort fix alone).
- `pr_webkit_v2.md`, `pr_webkit_notes.md`, `table.md`: the drafts for the larger change (speed and fallible allocations), which is held. Its code is the branch `robobun/99d68896/utf8-conversion-fallible` in oven-sh/WebKit. Its tests for Bun are the branch `robobun/99d68896/utf8-conversion-full-tests` here.
- `latin1-direct.diff`: one more step on top of that branch. The Latin-1 `UTF8CString` form measures a string of over 512 characters and converts it straight into the result. Rows and the differential fuzz are clean on four kernels (`out/c4.*.tsv`). Time is not measured on a quiet machine yet.
- `rows.cpp`, `difffuzz.cpp`, `big.cpp`, `icount.c`, `stub_bump.c`, `table.py`: the measurement programs. `out/*.tsv`: instruction and allocation counts for each row (base, c1 to c4, a1 = the abort fix).
- What the larger change still needs before it is a pull request: wall-clock numbers for both encodings, short and long, on x64 and arm64.
