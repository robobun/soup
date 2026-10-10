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

icelake: 400 rows, 0 above +0, 0 with more allocations, 39 with fewer, largest saving -2,717,694 (cs8 latin1 e-acute n=65536)
haswell: 400 rows, 0 above +0, 0 with more allocations, 39 with fewer, largest saving -2,600,677 (cs8 latin1 e-acute n=65536)
westmere: 400 rows, 0 above +0, 0 with more allocations, 39 with fewer, largest saving -2,527,088 (cs8 latin1 e-acute n=65536)
arm64: 400 rows, 0 above +0, 0 with more allocations, 37 with fewer, largest saving -2,703,143 (cb8 latin1 e-acute n=65536)
