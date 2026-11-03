// Generates src/jsc/bindings/caseChangeTables.h: the class of every code point above U+00FF for
// caseChange.cpp, which is the code behind Bun.camelCase() and the other case functions.
//
// Those functions give the output of the `change-case` package. The package finds its words with
// regular expressions on \p{L}, \p{Lu} and \p{Ll}, so the classes here are taken from the regular
// expression engine itself, and not from ICU or from a copy of the Unicode Character Database:
// the two can be of different Unicode versions in one binary, and the table has to agree with what
// the package reads when it runs in that binary.
//
// Each code point has one of four classes, in two bits:
//   0  separator: everything that is not below
//   1  \p{Lu}, an uppercase letter
//   2  \p{Ll}, a lowercase letter
//   3  another letter (\p{Lt}, \p{Lm}, \p{Lo}), and U+0345 (see isWordCharacter below)
// Code points below U+0100 have class 0 here. caseChange.cpp has its own tables for Latin-1, with a
// fifth class for the ASCII digits.
//
// Usage: bun bd scripts/generate-casechange-tables.mjs
//        Rewrites src/jsc/bindings/caseChangeTables.h in place. Run it with a build of this tree,
//        because the classes are those of the engine that runs the script. Run it again when
//        test/js/bun/util/caseChange.test.ts says that the table and the engine differ, which is
//        what a WebKit upgrade with new Unicode data does.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const headerPath = join(dirname(fileURLToPath(import.meta.url)), "../src/jsc/bindings/caseChangeTables.h");

// ---------------------------------------------------------------------------
// Classes, from the regular expressions of change-case 5.4.4
// ---------------------------------------------------------------------------

const SEPARATOR = 0;
const UPPER = 1;
const LOWER = 2;
const LETTER = 3;

const upper = /^\p{Lu}$/u;
const lower = /^\p{Ll}$/u;
// The package removes /[^\p{L}\d]+/giu from its input. What that expression leaves in place is a
// word character. The `i` flag makes the class larger than \p{L} by one code point, U+0345
// COMBINING GREEK YPOGEGRAMMENI: it is a mark, and case folding maps it to the letter U+03B9.
const notWordCharacter = /[^\p{L}\d]/iu;
const isWordCharacter = text => !notWordCharacter.test(text);

function classOf(codePoint) {
  if (codePoint < 0x100) return SEPARATOR;
  // A surrogate alone is not a letter. String.fromCodePoint() gives the lone surrogate.
  const text = String.fromCodePoint(codePoint);
  if (upper.test(text)) return UPPER;
  if (lower.test(text)) return LOWER;
  return isWordCharacter(text) ? LETTER : SEPARATOR;
}

const classes = new Uint8Array(0x110000);
const counts = [0, 0, 0, 0];
let lastWordCharacter = 0;
for (let codePoint = 0x100; codePoint <= 0x10ffff; codePoint++) {
  const value = classOf(codePoint);
  classes[codePoint] = value;
  counts[value]++;
  if (value !== SEPARATOR) lastWordCharacter = codePoint;
}

// Letters that a version of Unicode added, newest first. The newest one that the engine takes for a
// letter names the version of its data in the header. The name is for the reader only.
const versionProbes = [
  ["18.0", 0xa7dd],
  ["17.0", 0x16ea0],
  ["16.0", 0x10d50],
  ["15.1", 0x2ebf0],
  ["15.0", 0x11f04],
];
const newest = versionProbes.findIndex(([, codePoint]) => classes[codePoint] !== SEPARATOR);
if (newest === -1) throw new Error("the engine's Unicode data is older than 15.0, or the probes are wrong");
const unicodeVersion = newest === 0 ? `${versionProbes[0][0]} or later` : versionProbes[newest][0];

// ---------------------------------------------------------------------------
// Two stages: a block index for every 128 code points, and the blocks, 2 bits per code point
// ---------------------------------------------------------------------------

const BLOCK_SHIFT = 7;
const BLOCK_SIZE = 1 << BLOCK_SHIFT;
const BLOCK_BYTES = BLOCK_SIZE / 4;

// Every code point from `limit` up is a separator, and the table ends there.
const limit = (lastWordCharacter + BLOCK_SIZE) & ~(BLOCK_SIZE - 1);

const blockIndexByKey = new Map();
const stage1 = [];
const stage2 = [];
for (let first = 0; first < limit; first += BLOCK_SIZE) {
  const block = new Array(BLOCK_BYTES).fill(0);
  for (let offset = 0; offset < BLOCK_SIZE; offset++) {
    block[offset >> 2] |= classes[first + offset] << ((offset & 3) * 2);
  }
  const key = block.join(",");
  let index = blockIndexByKey.get(key);
  if (index === undefined) {
    index = blockIndexByKey.size;
    blockIndexByKey.set(key, index);
    stage2.push(...block);
  }
  stage1.push(index);
}
if (blockIndexByKey.size > 256) throw new Error("block indices no longer fit in uint8_t");

// The table gives back every class.
for (let codePoint = 0; codePoint <= 0x10ffff; codePoint++) {
  const got =
    codePoint >= limit
      ? SEPARATOR
      : (stage2[stage1[codePoint >> BLOCK_SHIFT] * BLOCK_BYTES + ((codePoint & (BLOCK_SIZE - 1)) >> 2)] >>
          ((codePoint & 3) * 2)) &
        3;
  if (got !== classes[codePoint]) throw new Error(`roundtrip mismatch at U+${codePoint.toString(16)}`);
}

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

function formatArray(values, perLine) {
  const lines = [];
  for (let i = 0; i < values.length; i += perLine) {
    lines.push("    " + values.slice(i, i + perLine).join(", ") + ",");
  }
  return lines.join("\n");
}

const hex = value => "0x" + value.toString(16).toUpperCase();
const count = value => value.toLocaleString("en-US");

const output = `// clang-format off
// Generated by scripts/generate-casechange-tables.mjs from the Unicode property tables of the
// regular expression engine (Unicode ${unicodeVersion}). Do not edit manually; regenerate with a build
// of this tree:
//   bun bd scripts/generate-casechange-tables.mjs
//
// The class of every code point from U+0100 up, for caseChange.cpp: ${count(counts[UPPER])} uppercase letters
// (\\p{Lu}), ${count(counts[LOWER])} lowercase letters (\\p{Ll}) and ${count(counts[LETTER])} other letters (\\p{Lt}, \\p{Lm}, \\p{Lo}
// and U+0345). Every other code point is a separator, and so is every code point from
// kClassLimit up. Code points below U+0100 have class 0 here: caseChange.cpp has its own tables
// for them.
//
// 2-stage lookup: kClassStage1[cp >> ${BLOCK_SHIFT}] is the number of a block of ${BLOCK_BYTES} bytes in
// kClassStage2, and a block holds ${BLOCK_SIZE} code points at 2 bits each, the lowest code point in
// the lowest bits of the first byte:
//   0 separator, 1 uppercase letter, 2 lowercase letter, 3 other letter
#pragma once

#include <cstdint>

namespace Bun {
namespace CaseChangeTables {

static constexpr char32_t kClassLimit = ${hex(limit)};
static constexpr unsigned kClassBlockShift = ${BLOCK_SHIFT};
static constexpr unsigned kClassBlockBytes = ${BLOCK_BYTES};

static constexpr uint8_t kClassStage1[${stage1.length}] = {
${formatArray(stage1, 32)}
};

static constexpr uint8_t kClassStage2[${stage2.length}] = {
${formatArray(stage2, BLOCK_BYTES)}
};

} // namespace CaseChangeTables
} // namespace Bun
`;

writeFileSync(headerPath, output);
console.log(
  `wrote ${headerPath}: Unicode ${unicodeVersion}, ${count(counts[UPPER])} Lu, ${count(counts[LOWER])} Ll, ` +
    `${count(counts[LETTER])} other letters, limit U+${limit.toString(16).toUpperCase()}, ` +
    `${stage1.length} + ${stage2.length} = ${stage1.length + stage2.length} bytes`,
);
