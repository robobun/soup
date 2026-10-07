import * as msgpackJavaScript from "@msgpack/msgpack";
import { Packr } from "msgpackr";
import { bench, group, run } from "../runner.mjs";

const isBun = typeof Bun !== "undefined" && Bun.msgpack;

// Plain MessagePack maps, which every implementation can read. msgpackr's record extension is off.
const msgpackr = new Packr({ useRecords: false });
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function sizeLabel(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${n}B`;
}

function user(i) {
  return {
    id: i,
    name: `User ${i}`,
    email: `user${i}@example.com`,
    active: i % 2 === 0,
    score: i * 1.5,
    tags: ["admin", "staff", "beta"],
    address: { street: "1 Main St", city: "Springfield", zip: "12345" },
    createdAt: 1700000000000 + i * 1000,
  };
}

const inputs = {
  "small object": user(1),
  "1,000 objects": Array.from({ length: 1000 }, (_, i) => user(i)),
  "10,000 numbers": Array.from({ length: 10000 }, (_, i) => (i % 3 === 0 ? i * 1.1 : i * 7919)),
  "1,000 ASCII strings": Array.from({ length: 1000 }, (_, i) => `line ${i} `.padEnd(64, "abcdefghij")),
  "1,000 Latin-1 strings": Array.from({ length: 1000 }, (_, i) => `café crème brûlée ${i}`),
  "1,000 UTF-16 strings": Array.from({ length: 1000 }, (_, i) => `héllo wörld 日本語 ${i}`),
  "64KB of binary": { name: "blob", data: new Uint8Array(65536).map((_, i) => i) },
};

for (const [name, value] of Object.entries(inputs)) {
  const encoded = msgpackJavaScript.encode(value);
  // JSON has no binary. It gets the same bytes as base64.
  const forJSON = name.includes("binary") ? { ...value, data: Buffer.from(value.data).toString("base64") } : value;
  const json = textEncoder.encode(JSON.stringify(forJSON));

  group(`encode ${name} (${sizeLabel(encoded.byteLength)})`, () => {
    if (isBun) bench("Bun.msgpack.encode", () => Bun.msgpack.encode(value));
    bench("msgpackr", () => msgpackr.pack(value));
    bench("@msgpack/msgpack", () => msgpackJavaScript.encode(value));
    bench("JSON.stringify + TextEncoder", () => textEncoder.encode(JSON.stringify(forJSON)));
  });

  group(`decode ${name} (${sizeLabel(encoded.byteLength)})`, () => {
    if (isBun) bench("Bun.msgpack.decode", () => Bun.msgpack.decode(encoded));
    bench("msgpackr", () => msgpackr.unpack(encoded));
    bench("@msgpack/msgpack", () => msgpackJavaScript.decode(encoded));
    bench("TextDecoder + JSON.parse", () => JSON.parse(textDecoder.decode(json)));
  });
}

await run();
