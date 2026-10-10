#!/usr/bin/env python3
# table.py: markdown tables for the PR notes from out/<variant>.<kernel>.tsv
import sys
def load(name, k):
    d = {}
    for l in open(f'/tmp/m/out/{name}.{k}.tsv'):
        form, label, result, mallocs, frees, nbytes, instr = l.rstrip('\n').split('\t')
        d[(form, label)] = (int(instr), int(mallocs))
    return d
kernels = ['icelake', 'haswell', 'westmere', 'arm64']
data = {k: (load('base', k), load('c3', k)) for k in kernels}
rows = [
    ('cs8', 'latin1 ascii n=1', 'Latin-1, 1 ASCII character'),
    ('cs8', 'latin1 e-acute n=8', 'Latin-1, 8 x U+00E9'),
    ('cs8', 'latin1 ascii n=16', 'Latin-1, 16 ASCII characters'),
    ('cs8', 'latin1 mixed (1 in 8 non-ASCII) n=100', 'Latin-1, 100 characters, 1 in 8 not ASCII'),
    ('cs8', 'latin1 e-acute n=400', 'Latin-1, 400 x U+00E9'),
    ('cs8', 'latin1 ascii n=4096', 'Latin-1, 4,096 ASCII characters'),
    ('cs16', 'utf16 cjk n=1', 'UTF-16, 1 CJK unit'),
    ('cs16', 'utf16 cjk n=8', 'UTF-16, 8 CJK units'),
    ('cs16', 'utf16 cjk n=32', 'UTF-16, 32 CJK units'),
    ('cs16', 'utf16 emoji n=32', 'UTF-16, 16 surrogate pairs'),
    ('cs16', 'utf16 ascii n=341', 'UTF-16, 341 ASCII units'),
    ('cs16', 'utf16 ascii n=342', 'UTF-16, 342 ASCII units'),
    ('cs16', 'utf16 cjk n=342', 'UTF-16, 342 CJK units'),
    ('cs16', 'utf16 cjk n=4096', 'UTF-16, 4,096 CJK units'),
    ('cs16', 'utf16 cjk + unpaired at end, lenient n=32', 'UTF-16, 31 CJK units + unpaired surrogate, lenient'),
    ('cs16', 'utf16 cjk + unpaired at end, lenient n=1000', 'UTF-16, 999 CJK units + unpaired surrogate, lenient'),
    ('cs16', 'utf16 cjk + unpaired at end, strict n=1000', 'UTF-16, 999 CJK units + unpaired surrogate, strict'),
    ('cb16', 'utf16 cjk n=8', 'callback form: UTF-16, 8 CJK units'),
    ('cb16', 'utf16 cjk n=4096', 'callback form: UTF-16, 4,096 CJK units'),
    ('cb8', 'latin1 e-acute n=400', 'callback form: Latin-1, 400 x U+00E9'),
]
print('| Input (CString form unless noted) | ' + ' | '.join(kernels) + ' | allocations |')
print('| --- | ' + ' | '.join('---' for _ in kernels) + ' | --- |')
for form, label, text in rows:
    cells = []
    for k in kernels:
        b, p = data[k]
        cells.append(f"{b[(form,label)][0]:,} -> {p[(form,label)][0]:,}")
    b, p = data['icelake']
    cells.append(f"{b[(form,label)][1]} -> {p[(form,label)][1]}")
    print(f"| {text} | " + ' | '.join(cells) + ' |')
print()
for k in kernels:
    b, p = data[k]
    n = len(b); pos = sum(1 for r in b if p[r][0] > b[r][0]); more = sum(1 for r in b if p[r][1] > b[r][1]); fewer = sum(1 for r in b if p[r][1] < b[r][1])
    best = min((p[r][0] - b[r][0], r) for r in b)
    print(f"{k}: {n} rows, {pos} above +0, {more} with more allocations, {fewer} with fewer, largest saving {best[0]:,} ({best[1][0]} {best[1][1]})")
