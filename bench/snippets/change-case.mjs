// Compares Bun.camelCase() and the other case functions with the npm package change-case, and with
// the same functions written in plain JavaScript.
//
//   bun bench/snippets/change-case.mjs                the functions of Bun
//   FORCE_NPM=1 bun bench/snippets/change-case.mjs    the package, on Bun
//   FORCE_JS=1 bun bench/snippets/change-case.mjs     plain JavaScript, on Bun
//   node bench/snippets/change-case.mjs               the package, on Node.js
//
// The package runs with { locale: false }, which is the setting that gives what Bun gives. With no
// options it calls toLocaleLowerCase() and toLocaleUpperCase(), and is slower.
//
// The inputs cover both string encodings, short and long text, and in each a result that is its
// input ("same").
import * as npm from "change-case";
import { bench, run } from "../runner.mjs";

// The functions in plain JavaScript, with the regular expressions of the package.
const words = input =>
  `${input}`
    .replace(/([\p{Ll}\d])(\p{Lu})/gu, "$1\0$2")
    .replace(/(\p{Lu})([\p{Lu}][\p{Ll}])/gu, "$1\0$2")
    .split(/[^\p{L}\d]+/iu)
    .filter(Boolean);
const lower = word => word.toLowerCase();
const upper = word => word.toUpperCase();
const capital = word => upper(word[0]) + lower(word.slice(1));
const pascal = (word, index) =>
  (index > 0 && word[0] >= "0" && word[0] <= "9" ? "_" + word[0] : upper(word[0])) + lower(word.slice(1));
const joined = (write, delimiter) => input => words(input).map(write).join(delimiter);
const plain = {
  camelCase: joined((word, index) => (index > 0 ? pascal(word, index) : lower(word)), ""),
  capitalCase: joined(capital, " "),
  constantCase: joined(upper, "_"),
  dotCase: joined(lower, "."),
  kebabCase: joined(lower, "-"),
  pascalCase: joined(pascal, ""),
  snakeCase: joined(lower, "_"),
  trainCase: joined(capital, "-"),
};

const options = { locale: false };
const mode = process.env.FORCE_JS
  ? "js"
  : process.env.FORCE_NPM || typeof globalThis.Bun?.camelCase !== "function"
    ? "npm"
    : "bun";
const implementations = {
  bun: name => Bun[name],
  npm: name => input => npm[name](input, options),
  js: name => plain[name],
};
const label = { bun: "Bun.", npm: "npm ", js: "js " }[mode];

// The text of `input` in a 16-bit string. A string that JavaScript makes from Latin-1 text is 8-bit.
const wide = input => Buffer.from(input, "utf16le").toString("utf16le");
const snake = Array(38).fill("lorem_ipsum_dolor_sit_amet").join("_");

const inputs = [
  ["camelCase", "two words", "9 chars"],
  ["snakeCase", "created_at", "same"],
  ["snakeCase", wide("created_at"), "same utf16"],
  ["snakeCase", "XMLHttpRequestEvent", "19 chars"],
  ["constantCase", "straßeUndGröße", "latin1"],
  ["snakeCase", "ΟδόςΑθηνών σοφόςΣοφός", "greek"],
  ["kebabCase", wide("backgroundColorHover"), "utf16"],
  ["camelCase", "lorem ipsum dolor sit amet ".repeat(38), "1 KB"],
  ["snakeCase", snake, "1 KB same"],
  ["snakeCase", wide(snake), "1KB same u16"],
  ["pascalCase", "λόγος ἔργον πρᾶξις ".repeat(54), "1 KB greek"],
  ["snakeCase", "loremIpsumDolorSitAmet ".repeat(712), "16 KB"],
];

for (const [name, input, about] of inputs) {
  const convert = implementations[mode](name);
  const expected = npm[name](input, options);
  if (convert(input) !== expected) {
    throw new Error(`${name} differs from change-case for ${JSON.stringify(input.slice(0, 40))}`);
  }
  if (about.includes("same") !== (expected === input)) {
    throw new Error(`${name} ${about}: the label and the result do not agree`);
  }
  bench(`${label}${name} ${about}`, () => {
    convert(input);
  });
}

await run();
