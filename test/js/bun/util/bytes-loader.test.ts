import { describe, expect, test } from "bun:test";
import { bunEnv, bunExe, tempDir } from "harness";
import { join } from "path";

// `import bytes from "./file" with { type: "bytes" }` gives the file's contents
// as a Uint8Array (TC39 proposal-import-bytes).

// Every byte value, so nothing can be mistaken for text.
const allBytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

async function run(cwd: string, ...args: string[]) {
  await using proc = Bun.spawn({
    cmd: [bunExe(), ...args],
    cwd,
    env: bunEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

describe.concurrent("bytes loader", () => {
  test("static and dynamic import give the same Uint8Array", async () => {
    using dir = tempDir("bytes-loader", {
      "data.bin": allBytes,
      "entry.ts": /* ts */ `
        import bytes from "./data.bin" with { type: "bytes" };
        const again = (await import("./data.bin", { with: { type: "bytes" } })).default;
        console.log(JSON.stringify({
          constructor: bytes.constructor.name,
          length: bytes.length,
          byteOffset: bytes.byteOffset,
          bufferLength: bytes.buffer.byteLength,
          hex: Buffer.from(bytes.buffer).toString("hex"),
          same: bytes === again,
        }));
      `,
    });
    const { stdout, stderr, exitCode } = await run(String(dir), "entry.ts");
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({
      constructor: "Uint8Array",
      length: 256,
      byteOffset: 0,
      bufferLength: 256,
      hex: allBytes.toString("hex"),
      same: true,
    });
    expect(exitCode).toBe(0);
  });

  test("the attribute wins over the extension, and an empty file is an empty array", async () => {
    using dir = tempDir("bytes-loader", {
      "hello.txt": "hi\n",
      "package.json": `{ "name": "pkg" }`,
      "empty.bin": Buffer.alloc(0),
      "entry.ts": /* ts */ `
        import text from "./hello.txt";
        import textBytes from "./hello.txt" with { type: "bytes" };
        import json from "./package.json" with { type: "bytes" };
        import empty from "./empty.bin" with { type: "bytes" };
        console.log(JSON.stringify({
          text,
          textBytes: Array.from(textBytes),
          json: new TextDecoder().decode(json),
          empty: [empty.constructor.name, empty.length],
        }));
      `,
    });
    const { stdout, stderr, exitCode } = await run(String(dir), "entry.ts");
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({
      text: "hi\n",
      textBytes: [104, 105, 10],
      json: `{ "name": "pkg" }`,
      empty: ["Uint8Array", 0],
    });
    expect(exitCode).toBe(0);
  });

  test("--loader maps an extension to bytes for import and require", async () => {
    using dir = tempDir("bytes-loader", {
      "data.bin": allBytes,
      "entry.ts": /* ts */ `
        import bytes from "./data.bin";
        // The module is already loaded as ESM, so require() sees its namespace.
        const required = require("./data.bin");
        console.log(JSON.stringify({
          constructor: bytes.constructor.name,
          hex: Buffer.from(bytes).toString("hex"),
          same: required.default === bytes,
        }));
      `,
    });
    const { stdout, stderr, exitCode } = await run(String(dir), "--loader", ".bin:bytes", "entry.ts");
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({
      constructor: "Uint8Array",
      hex: allBytes.toString("hex"),
      same: true,
    });
    expect(exitCode).toBe(0);
  });

  test("require() of a bytes module gives the Uint8Array", async () => {
    using dir = tempDir("bytes-loader", {
      "data.bin": allBytes,
      "entry.cjs": /* js */ `
        const bytes = require("./data.bin");
        console.log(JSON.stringify({
          constructor: bytes.constructor.name,
          hex: Buffer.from(bytes).toString("hex"),
          cached: require("./data.bin") === bytes,
        }));
      `,
    });
    const { stdout, stderr, exitCode } = await run(String(dir), "--loader", ".bin:bytes", "entry.cjs");
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({
      constructor: "Uint8Array",
      hex: allBytes.toString("hex"),
      cached: true,
    });
    expect(exitCode).toBe(0);
  });

  test("a large file round-trips", async () => {
    const big = Buffer.alloc(3 * 1024 * 1024 + 7);
    for (let i = 0; i < big.length; i++) big[i] = (i * 2654435761) >>> 24;
    using dir = tempDir("bytes-loader", {
      "big.bin": big,
      "entry.ts": /* ts */ `
        import bytes from "./big.bin" with { type: "bytes" };
        console.log(bytes.length, Bun.hash(bytes).toString(16));
      `,
    });
    const { stdout, stderr, exitCode } = await run(String(dir), "entry.ts");
    expect(stderr).toBe("");
    expect(stdout.trim()).toBe(`${big.length} ${Bun.hash(big).toString(16)}`);
    expect(exitCode).toBe(0);
  });

  test("named imports are rejected", async () => {
    using dir = tempDir("bytes-loader", {
      "data.bin": allBytes,
      "entry.ts": /* ts */ `
        import { length } from "./data.bin" with { type: "bytes" };
        console.log(length);
      `,
    });
    const { stderr, exitCode } = await run(String(dir), join(String(dir), "entry.ts"));
    expect(stderr).toContain(`This loader type only supports the "default" import`);
    expect(exitCode).not.toBe(0);
  });
});
