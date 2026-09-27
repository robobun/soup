// One row per runtime, one column per input shape. Sync API, default options.
const zlib = require("node:zlib");

const data = Buffer.alloc(6000, "hello world ");
const full = zlib.zstdCompressSync(data);
const trunc = full.subarray(0, full.length - 10);
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const inputs = [
  ["truncated", trunc],
  ["empty", Buffer.alloc(0)],
  ["frame+truncated", Buffer.concat([full, trunc])],
  ["frame+magic(4)", Buffer.concat([full, magic])],
  ["frame+magic(2)", Buffer.concat([full, magic.subarray(0, 2)])],
  ["frame+frame", Buffer.concat([full, full])],
  ["frame+junk", Buffer.concat([full, Buffer.from("not zstd at all")])],
  ["full", full],
];

function run(buf) {
  try {
    return String(zlib.zstdDecompressSync(buf).length);
  } catch (e) {
    return e.code === "Z_BUF_ERROR" ? "Z_BUF" : "throw:" + (e.code ?? e.name);
  }
}

const label = process.env.LABEL ?? (typeof Bun !== "undefined" ? "bun " + Bun.version : "node " + process.version);
if (process.argv[2] === "--header") {
  console.log("runtime".padEnd(16) + inputs.map(([n]) => n.padEnd(17)).join(""));
}
console.log(label.padEnd(16) + inputs.map(([, b]) => run(b).padEnd(17)).join(""));
