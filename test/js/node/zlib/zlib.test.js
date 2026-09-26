import { deflateSync, gunzipSync, gzipSync, inflateSync } from "bun";
import { describe, expect, it } from "bun:test";
import { bunEnv, bunExe, tmpdirSync } from "harness";
import * as buffer from "node:buffer";
import { randomFillSync } from "node:crypto";
import * as fs from "node:fs";
import { resolve } from "node:path";
import * as stream from "node:stream";
import * as util from "node:util";
import * as zlib from "node:zlib";

describe("prototype and name and constructor", () => {
  for (let [name, Class] of [
    ["Gzip", zlib.Gzip],
    ["Gunzip", zlib.Gunzip],
    ["Deflate", zlib.Deflate],
    ["Inflate", zlib.Inflate],
    ["DeflateRaw", zlib.DeflateRaw],
  ]) {
    describe(`${name}`, () => {
      it(`${name}.prototype should be instanceof ${name}.__proto__`, () => {
        expect(Class.prototype).toBeInstanceOf(Class.__proto__);
      });
      it(`${name}.prototype.constructor should be ${name}`, () => {
        expect(Class.prototype.constructor).toBe(Class);
      });
      it(`${name}.name should be ${name}`, () => {
        expect(Class.name).toBe(name);
      });
      it(`${name}.prototype.__proto__.constructor.name should be Zlib`, () => {
        expect(Class.prototype.__proto__.constructor.name).toBe("Zlib");
      });
    });
  }

  for (let [name, Class] of [
    ["BrotliCompress", zlib.BrotliCompress],
    ["BrotliDecompress", zlib.BrotliDecompress],
  ]) {
    describe(`${name}`, () => {
      it(`${name}.prototype should be instanceof ${name}.__proto__`, () => {
        expect(Class.prototype).toBeInstanceOf(Class.__proto__);
      });
      it(`${name}.prototype.constructor should be ${name}`, () => {
        expect(Class.prototype.constructor).toBe(Class);
      });
      it(`${name}.name should be ${name}`, () => {
        expect(Class.name).toBe(name);
      });
      it(`${name}.prototype.__proto__.constructor.name should be Brotli`, () => {
        expect(Class.prototype.__proto__.constructor.name).toBe("Brotli");
      });
    });
  }

  for (let [name, Class] of [
    ["ZstdCompress", zlib.ZstdCompress],
    ["ZstdDecompress", zlib.ZstdDecompress],
  ]) {
    describe(`${name}`, () => {
      it(`${name}.prototype should be instanceof ${name}.__proto__`, () => {
        expect(Class.prototype).toBeInstanceOf(Class.__proto__);
      });
      it(`${name}.prototype.constructor should be ${name}`, () => {
        expect(Class.prototype.constructor).toBe(Class);
      });
      it(`${name}.name should be ${name}`, () => {
        expect(Class.name).toBe(name);
      });
      it(`${name}.prototype.__proto__.constructor.name should be Zstd`, () => {
        expect(Class.prototype.__proto__.constructor.name).toBe("Zstd");
      });
    });
  }
});

describe("zlib", () => {
  for (let library of ["zlib", "libdeflate"]) {
    for (let outputLibrary of ["zlib", "libdeflate"]) {
      describe(`${library} -> ${outputLibrary}`, () => {
        it("should be able to deflate and inflate", () => {
          const data = new TextEncoder().encode("Hello World!".repeat(1));
          const compressed = deflateSync(data, { library });
          console.log(compressed);
          const decompressed = inflateSync(compressed, { library: outputLibrary });
          expect(decompressed.join("")).toBe(data.join(""));
        });

        it("should be able to gzip and gunzip", () => {
          const data = new TextEncoder().encode("Hello World!".repeat(1));
          const compressed = gzipSync(data, { library });
          const decompressed = gunzipSync(compressed, { library: outputLibrary });
          expect(decompressed.join("")).toBe(data.join(""));
        });
      });
    }
  }

  it("should throw on invalid raw deflate data", () => {
    const data = new TextEncoder().encode("Hello World!".repeat(1));
    expect(() => inflateSync(data, { library: "zlib" })).toThrow(new Error("invalid stored block lengths"));
  });

  it("should throw on invalid gzip data", () => {
    const data = new TextEncoder().encode("Hello World!".repeat(1));
    expect(() => gunzipSync(data, { library: "zlib" })).toThrow(new Error("incorrect header check"));
  });

  describe("libdeflate level validation", () => {
    const data = Buffer.alloc(64, "a");
    // libdeflate_alloc_compressor returns NULL for level outside [0, 12]; that NULL must
    // surface as an invalid-argument error, not "Out of memory".
    for (const fn of [gzipSync, deflateSync]) {
      it(`${fn.name}: out-of-range level throws an argument error, not OOM`, () => {
        for (const level of [-2, -1, 13, 100]) {
          let err;
          try {
            fn(data, { library: "libdeflate", level });
          } catch (e) {
            err = e;
          }
          expect(err).toBeDefined();
          expect(err.message).not.toContain("memory");
          expect(err.message).toContain("Compression level must be between 0 and 12");
        }
      });

      it(`${fn.name}: in-range levels 0..12 succeed and round-trip`, () => {
        const decompress = fn === gzipSync ? gunzipSync : inflateSync;
        for (const level of [0, 1, 6, 9, 12]) {
          const out = fn(data, { library: "libdeflate", level });
          expect(out.length).toBeGreaterThan(0);
          expect(Buffer.from(decompress(out, { library: "libdeflate" }))).toEqual(data);
        }
      });
    }
  });
});

function* window(buffer, size, advance = size) {
  let i = 0;
  while (i <= buffer.length) {
    yield buffer.slice(i, i + size);
    i += advance;
  }
}

describe("zlib.gunzip", () => {
  it("should be able to unzip a Buffer and return an unzipped Buffer", async () => {
    const content = fs.readFileSync(import.meta.dir + "/fixture.html.gz");
    return new Promise((resolve, reject) => {
      zlib.gunzip(content, (error, data) => {
        if (error) {
          reject(error);
          return;
        }
        expect(data !== null).toBe(true);
        expect(buffer.Buffer.isBuffer(data)).toBe(true);
        resolve(true);
      });
    });
  });
});

describe("one-shot results", () => {
  const input = Buffer.alloc(1024, "a");
  const pairs = [
    ["gzip", "gunzip"],
    ["deflate", "inflate"],
    ["deflateRaw", "inflateRaw"],
    ["gzip", "unzip"],
    ["brotliCompress", "brotliDecompress"],
    ["zstdCompress", "zstdDecompress"],
  ];
  const backingStores = (compressed, decompressed) => ({
    compressed: compressed.buffer.byteLength,
    decompressed: decompressed.buffer.byteLength,
  });

  it.each(pairs)("%sSync and %sSync do not keep the 16 KB output chunk alive", (compress, decompress) => {
    const compressed = zlib[`${compress}Sync`](input);
    const decompressed = zlib[`${decompress}Sync`](compressed);
    expect(decompressed).toEqual(input);
    expect(backingStores(compressed, decompressed)).toEqual({
      compressed: compressed.byteLength,
      decompressed: decompressed.byteLength,
    });
  });

  it.each(pairs)("%s and %s do not keep the 16 KB output chunk alive", async (compress, decompress) => {
    const compressed = await util.promisify(zlib[compress])(input);
    const decompressed = await util.promisify(zlib[decompress])(compressed);
    expect(decompressed).toEqual(input);
    expect(backingStores(compressed, decompressed)).toEqual({
      compressed: compressed.byteLength,
      decompressed: decompressed.byteLength,
    });
  });

  // Random bytes do not compress, so both directions produce the same number of chunks.
  // A fractional chunkSize is valid. It makes the offsets into the chunk fractional.
  describe.each([
    ["exactly one chunk", 16 * 1024, undefined],
    ["full chunks and a small rest", 3 * 16 * 1024 + 5, undefined],
    ["a large part of one large chunk", 40_000, 64 * 1024],
    ["many small chunks", 10_000, 64],
    ["a fractional chunkSize", 1000, 100.5],
    ["a fractional chunkSize above the input size", 1000, 16 * 1024 + 0.5],
  ])("%s", (_, size, chunkSize) => {
    const data = randomFillSync(Buffer.alloc(size));
    const options = { chunkSize };

    it("round-trips with the sync functions", () => {
      expect(zlib.inflateRawSync(zlib.deflateRawSync(data, options), options)).toEqual(data);
      expect(zlib.zstdDecompressSync(zlib.zstdCompressSync(data, options), options)).toEqual(data);
    });

    it("round-trips with the callback functions", async () => {
      const deflated = await util.promisify(zlib.deflateRaw)(data, options);
      expect(await util.promisify(zlib.inflateRaw)(deflated, options)).toEqual(data);
      const compressed = await util.promisify(zlib.zstdCompress)(data, options);
      expect(await util.promisify(zlib.zstdDecompress)(compressed, options)).toEqual(data);
    });

    it("round-trips with _processChunk on one engine", () => {
      const deflated = zlib.deflateRawSync(data);
      const engine = new zlib.InflateRaw(options);
      const half = deflated.length >> 1;
      // The sync _processChunk closes the handle when it is done. minizlib keeps it open like this.
      const handle = engine._handle;
      const close = handle.close;
      handle.close = () => {};
      const parts = [];
      try {
        parts.push(Buffer.from(engine._processChunk(deflated.subarray(0, half), zlib.constants.Z_SYNC_FLUSH)));
        engine._handle = handle;
        parts.push(Buffer.from(engine._processChunk(deflated.subarray(half), zlib.constants.Z_SYNC_FLUSH)));
      } finally {
        handle.close = close;
        engine._handle = handle;
        engine.close();
      }
      expect(Buffer.concat(parts)).toEqual(data);
    });
  });
});

describe("zlib.brotli", () => {
  const inputString =
    "ΩΩLorem ipsum dolor sit amet, consectetur adipiscing eli" +
    "t. Morbi faucibus, purus at gravida dictum, libero arcu " +
    "convallis lacus, in commodo libero metus eu nisi. Nullam" +
    " commodo, neque nec porta placerat, nisi est fermentum a" +
    "ugue, vitae gravida tellus sapien sit amet tellus. Aenea" +
    "n non diam orci. Proin quis elit turpis. Suspendisse non" +
    " diam ipsum. Suspendisse nec ullamcorper odio. Vestibulu" +
    "m arcu mi, sodales non suscipit id, ultrices ut massa. S" +
    "ed ac sem sit amet arcu malesuada fermentum. Nunc sed. ";
  const compressedString =
    "G/gBQBwHdky2aHV5KK9Snf05//1pPdmNw/7232fnIm1IB" +
    "K1AA8RsN8OB8Nb7Lpgk3UWWUlzQXZyHQeBBbXMTQXC1j7" +
    "wg3LJs9LqOGHRH2bj/a2iCTLLx8hBOyTqgoVuD1e+Qqdn" +
    "f1rkUNyrWq6LtOhWgxP3QUwdhKGdZm3rJWaDDBV7+pDk1" +
    "MIkrmjp4ma2xVi5MsgJScA3tP1I7mXeby6MELozrwoBQD" +
    "mVTnEAicZNj4lkGqntJe2qSnGyeMmcFgraK94vCg/4iLu" +
    "Tw5RhKhnVY++dZ6niUBmRqIutsjf5TzwF5iAg8a9UkjF5" +
    "2eZ0tB2vo6v8SqVfNMkBmmhxr0NT9LkYF69aEjlYzj7IE" +
    "KmEUQf1HBogRYhFIt4ymRNEgHAIzOyNEsQM=";
  const compressedBuffer = Buffer.from(compressedString, "base64");

  it("brotliCompress", async () => {
    const compressed = await util.promisify(zlib.brotliCompress)(inputString);
    expect(compressed.toString()).toEqual(compressedBuffer.toString());
  });

  it("brotliDecompress", async () => {
    const roundtrip = await util.promisify(zlib.brotliDecompress)(compressedBuffer);
    expect(roundtrip.toString()).toEqual(inputString);
  });

  it("brotliCompressSync", () => {
    const compressed = zlib.brotliCompressSync(inputString);
    expect(compressed.toString()).toEqual(compressedBuffer.toString());
  });

  it("brotliDecompressSync", () => {
    const roundtrip = zlib.brotliDecompressSync(compressedBuffer);
    expect(roundtrip.toString()).toEqual(inputString);
  });

  it("can compress streaming", async () => {
    const encoder = zlib.createBrotliCompress();
    for (const chunk of window(inputString, 55)) {
      encoder.push(chunk);
    }
    encoder.push(null);
    const buf = await new Response(encoder).text();
    expect(buf).toEqual(inputString);
  });

  it("can decompress streaming", async () => {
    const decoder = zlib.createBrotliDecompress();
    for (const chunk of window(compressedBuffer, 10)) {
      decoder.push(chunk);
    }
    decoder.push(null);
    const buf = await new Response(decoder).bytes();
    expect(buf).toEqual(compressedBuffer);
  });

  it("can roundtrip an empty string", async () => {
    const input = "";
    const compressed = await util.promisify(zlib.brotliCompress)(input);
    const roundtrip = await util.promisify(zlib.brotliDecompress)(compressed);
    expect(roundtrip.toString()).toEqual(input);
  });

  it("can compress streaming big", async () => {
    const encoder = zlib.createBrotliCompress();
    const input = inputString + inputString + inputString + inputString;
    for (const chunk of window(input, 65)) {
      encoder.push(chunk);
    }
    encoder.push(null);
    const buf = await new Response(encoder).text();
    expect(buf).toEqual(input);
  });

  it("fully works as a stream.Transform", async () => {
    const x_dir = tmpdirSync();
    const out_path_c = resolve(x_dir, "this.js.br");
    const out_path_d = resolve(x_dir, "this.js");

    {
      const { resolve, reject, promise } = Promise.withResolvers();
      const readStream = fs.createReadStream(import.meta.filename);
      const writeStream = fs.createWriteStream(out_path_c);
      const brStream = zlib.createBrotliCompress();
      const the_stream = readStream.pipe(brStream).pipe(writeStream);
      the_stream.on("finish", resolve);
      the_stream.on("error", reject);
      await promise;
    }
    {
      const { resolve, reject, promise } = Promise.withResolvers();
      const readStream = fs.createReadStream(out_path_c);
      const writeStream = fs.createWriteStream(out_path_d);
      const brStream = zlib.createBrotliDecompress();
      const the_stream = readStream.pipe(brStream).pipe(writeStream);
      the_stream.on("finish", resolve);
      the_stream.on("error", reject);
      await promise;
    }
    {
      const expected = await Bun.file(import.meta.filename).text();
      const actual = await Bun.file(out_path_d).text();
      expect(actual).toEqual(expected);
    }
  });

  it("streaming encode doesn't wait for entire input", async () => {
    const readStream = new stream.Readable();
    // Quality 4: the test asserts the transform emits multiple output chunks
    // rather than buffering, which is quality-independent; the default (11)
    // pushes 8 MB of random input past the 15s budget on a contended runner.
    const brotliStream = zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } });
    let all = [];

    const { promise, resolve, reject } = Promise.withResolvers();
    brotliStream.on("data", chunk => all.push(chunk.length));
    brotliStream.on("end", resolve);
    brotliStream.on("error", reject);

    // Distinct incompressible (random) chunks so the compressor emits many output chunks.
    for (let i = 0; i < 8; i++) {
      readStream.push(randomFillSync(Buffer.alloc(1024 * 1024)));
    }
    readStream.push(null);
    readStream.pipe(brotliStream);
    await promise;
    expect(all.length).toBeGreaterThanOrEqual(7);
  }, 15_000);

  it("should accept params", async () => {
    const ZLIB = zlib.constants;
    const inputString2 =
      "ΩΩLorem ipsum dolor sit amet, consectetur adipiscing eli" +
      "t. Morbi faucibus, purus at gravida dictum, libero arcu " +
      "convallis lacus, in commodo libero metus eu nisi. Nullam" +
      " commodo, neque nec porta placerat, nisi est fermentum a" +
      "ugue, vitae gravida tellus sapien sit amet tellus. Aenea" +
      "n non diam orci. Proin quis elit turpis. Suspendisse non" +
      " diam ipsum. Suspendisse nec ullamcorper odio. Vestibulu" +
      "m arcu mi, sodales non suscipit id, ultrices ut massa. S" +
      "ed ac sem sit amet arcu malesuada fermentum. Nunc sed. ";
    const compressedString2 =
      "G/gBQBwHdky2aHV5KK9Snf05//1pPdmNw/7232fnIm1IB" +
      "K1AA8RsN8OB8Nb7Lpgk3UWWUlzQXZyHQeBBbXMTQXC1j7" +
      "wg3LJs9LqOGHRH2bj/a2iCTLLx8hBOyTqgoVuD1e+Qqdn" +
      "f1rkUNyrWq6LtOhWgxP3QUwdhKGdZm3rJWaDDBV7+pDk1" +
      "MIkrmjp4ma2xVi5MsgJScA3tP1I7mXeby6MELozrwoBQD" +
      "mVTnEAicZNj4lkGqntJe2qSnGyeMmcFgraK94vCg/4iLu" +
      "Tw5RhKhnVY++dZ6niUBmRqIutsjf5TzwF5iAg8a9UkjF5" +
      "2eZ0tB2vo6v8SqVfNMkBmmhxr0NT9LkYF69aEjlYzj7IE" +
      "KmEUQf1HBogRYhFIt4ymRNEgHAIzOyNEsQM=";
    const compressedString3 =
      "G/gBAICqqqrq/3RluBvo4R73BQIgAOIuJirhIAAqKhqy+" +
      "PHut0sMwMFYEIlJYoA7bQ5D/H/9v949xKAn2zB9eSC1QC" +
      "Z1gX2ncEl1gKYeTdb9gCytgQ+PW/FLzXp3XjgdnaDCI+i" +
      "pkzCVq+3C0lvCQcEN9v2ktTSxiDsv6Aa7mU/H0lvCYVKd" +
      "kMbW1IHPXosM7GY+/cKWvxZsYRyPIpxFLEF1YWsqJAu/E" +
      "ia72kD9aLnw1CLBI+ipk1CyVieSjspGqh0LVZUYBt5kC2" +
      "1s35hKBg/Wga9w3fhrTUdQQVAdR3Pgu/PInpopugl2ooZ" +
      "SH9vC6LXI2ONIwKf6wI9k6d2rDY4ocKYX0ictSSMmx+xk" +
      "PVrQeaFXhbIkumCUSQPfMkGMFHNzQg2mPy3JpklwIIEc+" +
      "OzNSJkD";

    {
      const compressed = await util.promisify(zlib.brotliCompress)(inputString2, {
        params: {
          [ZLIB.BROTLI_PARAM_MODE]: ZLIB.BROTLI_MODE_TEXT,
          [ZLIB.BROTLI_PARAM_QUALITY]: 11,
        },
      });
      expect(compressed.toString()).toEqual(Buffer.from(compressedString2, "base64").toString());
    }
    {
      const compressed = await util.promisify(zlib.brotliCompress)(inputString2, {
        params: {
          [ZLIB.BROTLI_PARAM_MODE]: ZLIB.BROTLI_MODE_TEXT,
          [ZLIB.BROTLI_PARAM_QUALITY]: 2,
        },
      });
      expect(compressed.toString()).toEqual(Buffer.from(compressedString3, "base64").toString());
    }
  });
});

it.each([
  "BrotliCompress",
  "BrotliDecompress",
  "Deflate",
  "Inflate",
  "DeflateRaw",
  "InflateRaw",
  "Gzip",
  "Gunzip",
  "Unzip",
])("%s should work with and without `new` keyword", constructor_name => {
  const C = zlib[constructor_name];
  expect(C()).toBeInstanceOf(C);
  expect(new C()).toBeInstanceOf(C);
});

describe.each(["Deflate", "DeflateRaw", "Gzip"])("%s", constructor_name => {
  describe.each(["chunkSize", "level", "windowBits", "memLevel", "strategy", "maxOutputLength"])(
    "should throw if options.%s is",
    option_name => {
      // [], // error: Test "-3.4416124249222144e-103" timed out after 5000ms
      it.each(["test", Symbol("bun"), 2n, {}, true])("%p", value => {
        expect(() => new zlib[constructor_name]({ [option_name]: value })).toThrow(TypeError);
      });
      it.each([Number.MIN_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER + 1, Infinity, -Infinity, -2])("%p", value => {
        expect(() => new zlib[constructor_name]({ [option_name]: value })).toThrow(RangeError);
      });
      it.each([undefined])("%p", value => {
        expect(() => new zlib[constructor_name]({ [option_name]: value })).not.toThrow();
      });
    },
  );
});

for (const [compress, decompressor] of [
  [zlib.deflateRawSync, zlib.createInflateRaw],
  [zlib.deflateSync, zlib.createInflate],
  [zlib.brotliCompressSync, zlib.createBrotliDecompress],
  [zlib.zstdCompressSync, zlib.createZstdDecompress],
  // [zlib.gzipSync, zlib.createGunzip],
  // [zlib.gzipSync, zlib.createUnzip],
]) {
  const input = "0123456789".repeat(4);
  const compressed = compress(input);
  const trailingData = Buffer.from("not valid compressed data");

  const variants = [
    stream => {
      stream.end(compressed);
    },
    stream => {
      stream.write(compressed);
      stream.write(trailingData);
    },
    stream => {
      stream.write(compressed);
      stream.end(trailingData);
    },
    stream => {
      stream.write(Buffer.concat([compressed, trailingData]));
    },
    stream => {
      stream.end(Buffer.concat([compressed, trailingData]));
    },
  ];
  for (const i in variants) {
    // prettier-ignore
    it(`premature end handles bytesWritten properly: ${compress.name} + ${decompressor.name}: variant ${i}`, async () => {
      const variant = variants[i];
      const { promise, resolve, reject } = Promise.withResolvers();
      let output = "";
      const stream = decompressor();
      stream.setEncoding("utf8");
      stream.on("data", chunk => (output += chunk));
      stream.on("end", () => {
        try {
          expect(output).toBe(input);
          expect(stream.bytesWritten).toBe(compressed.length);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
      variant(stream);
      await promise;
    });
  }
}

const inputString =
  "ΩΩLorem ipsum dolor sit amet, consectetur adipiscing eli" +
  "t. Morbi faucibus, purus at gravida dictum, libero arcu " +
  "convallis lacus, in commodo libero metus eu nisi. Nullam" +
  " commodo, neque nec porta placerat, nisi est fermentum a" +
  "ugue, vitae gravida tellus sapien sit amet tellus. Aenea" +
  "n non diam orci. Proin quis elit turpis. Suspendisse non" +
  " diam ipsum. Suspendisse nec ullamcorper odio. Vestibulu" +
  "m arcu mi, sodales non suscipit id, ultrices ut massa. S" +
  "ed ac sem sit amet arcu malesuada fermentum. Nunc sed. ";

const errMessage = /unexpected end of file/;

it.each([
  ["gzip", "gunzip", "gunzipSync"],
  ["gzip", "unzip", "unzipSync"],
  ["deflate", "inflate", "inflateSync"],
  ["deflateRaw", "inflateRaw", "inflateRawSync"],
])("%s %s should handle truncated input correctly", async (comp, decomp, decompSync) => {
  const comp_p = util.promisify(zlib[comp]);
  const decomp_p = util.promisify(zlib[decomp]);

  const compressed = await comp_p(inputString);

  const truncated = compressed.slice(0, compressed.length / 2);
  const toUTF8 = buffer => buffer.toString("utf-8");

  // sync sanity
  const decompressed = zlib[decompSync](compressed);
  expect(toUTF8(decompressed)).toEqual(inputString);

  // async sanity
  expect(toUTF8(await decomp_p(compressed))).toEqual(inputString);

  // Sync truncated input test
  expect(() => zlib[decompSync](truncated)).toThrow();

  // Async truncated input test
  expect(async () => await decomp_p(truncated)).toThrow();

  const syncFlushOpt = { finishFlush: zlib.constants.Z_SYNC_FLUSH };

  // Sync truncated input test, finishFlush = Z_SYNC_FLUSH
  {
    const result = toUTF8(zlib[decompSync](truncated, syncFlushOpt));
    const expected = inputString.slice(0, result.length);
    expect(result).toBe(expected);
  }

  // Async truncated input test, finishFlush = Z_SYNC_FLUSH
  {
    const result = toUTF8(await decomp_p(truncated, syncFlushOpt));
    const expected = inputString.slice(0, result.length);
    expect(result).toBe(expected);
  }
});

for (const C of [zlib.Deflate, zlib.Inflate, zlib.DeflateRaw, zlib.InflateRaw, zlib.Gzip, zlib.Gunzip, zlib.Unzip]) {
  for (const op of [
    "flush",
    "finishFlush",
    "chunkSize",
    "windowBits",
    "level",
    "memLevel",
    "strategy",
    "dictionary",
    "info",
    "maxOutputLength",
  ]) {
    it(`new ${C.name}({ ${op}: undefined }) doesn't throw`, () => {
      expect(() => new C({ [op]: undefined })).not.toThrow();
    });
  }
}

for (const C of [zlib.BrotliCompress, zlib.BrotliDecompress]) {
  for (const op of ["flush", "finishFlush", "chunkSize", "params", "maxOutputLength"]) {
    it(`new ${C.name}({ ${op}: undefined }) doesn't throw`, () => {
      expect(() => new C({ [op]: undefined })).not.toThrow();
    });
  }
}

describe("zlib.zstd", () => {
  const inputString =
    "ΩΩLorem ipsum dolor sit amet, consectetur adipiscing eli" +
    "t. Morbi faucibus, purus at gravida dictum, libero arcu " +
    "convallis lacus, in commodo libero metus eu nisi. Nullam" +
    " commodo, neque nec porta placerat, nisi est fermentum a" +
    "ugue, vitae gravida tellus sapien sit amet tellus. Aenea" +
    "n non diam orci. Proin quis elit turpis. Suspendisse non" +
    " diam ipsum. Suspendisse nec ullamcorper odio. Vestibulu" +
    "m arcu mi, sodales non suscipit id, ultrices ut massa. S" +
    "ed ac sem sit amet arcu malesuada fermentum. Nunc sed. ";
  const compressedString =
    "KLUv/WD5AF0JAGbXPCCgJUkH/8+rqgA3KaVsW+6LfK3JLcnP+I/" +
    "Gy1/3Qv9XDTQAMwA0AK+Ch9LCub6tnT62C7QuwrHQHDhhNPcCQl" +
    "tMWOrafGy3KO2D79QZ95omy09vwp/TFEAkEIlHOO99cOlZmfRiz" +
    "XQ79GvDoY9TxrTgBBfR+77Nd7LkOWlHaGW+aEwd2rSeegWaj9Ns" +
    "WAJJ0253u1jQpe3ByWLS5i+24QhTAZygaf4UlqNER3XoAk7QYar" +
    "9tjHHV4yHj+tC108zuqMBJ+X2hlpwUqX6vE3r3N7q5QYntVvn3N" +
    "8zVDb9UfCMCW1790yV3A88pgvkvQAniSWvFxMAELvECFu0tC1R9" +
    "Ijsri5bt2kE/2mLoi2wCpkElnidDMS//DemxlNdHClyl6KeNTCugmAG";
  const compressedBuffer = Buffer.from(compressedString, "base64");

  it("zstdDecompress", async () => {
    const roundtrip = await util.promisify(zlib.zstdDecompress)(compressedBuffer);
    expect(roundtrip.toString()).toEqual(inputString);
  });

  it.each([undefined, null])("zstdCompress accepts explicit %p options", async opts => {
    const { promise, resolve, reject } = Promise.withResolvers();
    zlib.zstdCompress(inputString, opts, (err, out) => (err ? reject(err) : resolve(out)));
    const compressed = await promise;
    expect(compressed.toString("base64")).toEqual(compressedString);
  });

  it("zstdCompressSync", () => {
    const compressed = zlib.zstdCompressSync(inputString);
    expect(compressed.toString("base64")).toEqual(compressedString);
  });

  it("zstdDecompressSync", () => {
    const roundtrip = zlib.zstdDecompressSync(compressedBuffer);
    expect(roundtrip.toString()).toEqual(inputString);
  });

  it("zstdDecompressSync decodes concatenated frames", () => {
    const f1 = zlib.zstdCompressSync(Buffer.from("first\n"));
    const f2 = zlib.zstdCompressSync(Buffer.from("second\n"));
    expect(zlib.zstdDecompressSync(Buffer.concat([f1, f2])).toString()).toBe("first\nsecond\n");
  });

  // node:zlib/iter needs a flag, so it runs in a child. `chunks` is the source
  // text of an array of buffers. Both transforms decode it, and each gives its
  // output or its error.
  async function decodeWithIter(chunks) {
    const script = `
      const { bytes, bytesSync, from, fromSync, pull, pullSync } = require("node:stream/iter");
      const { decompressZstd, decompressZstdSync } = require("node:zlib/iter");
      const { zstdCompressSync } = require("node:zlib");
      const chunks = ${chunks};
      const result = decode => decode().then(
        output => ({ output: Buffer.from(output).toString() }),
        err => ({ message: err.message, code: err.code, errno: err.errno }),
      );
      (async () => {
        console.log(JSON.stringify({
          decompressZstd: await result(async () => bytes(pull(from(chunks), decompressZstd()))),
          decompressZstdSync: await result(async () => bytesSync(pullSync(fromSync(chunks), decompressZstdSync()))),
        }));
      })();
    `;
    await using proc = Bun.spawn({
      cmd: [bunExe(), "--experimental-stream-iter", "-e", script],
      env: bunEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, , exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    return { ...JSON.parse(stdout), exitCode };
  }

  describe("input after a complete frame", () => {
    const first = zlib.zstdCompressSync(Buffer.from("first\n"));
    const second = zlib.zstdCompressSync(Buffer.from("second\n"));
    const junk = Buffer.from("not valid compressed data");
    // A magic number from 0x184D2A50 to 0x184D2A5F, a length of 4, then 4
    // bytes that a decoder skips.
    const skippable = Buffer.from([0x5a, 0x2a, 0x4d, 0x18, 4, 0, 0, 0, 1, 2, 3, 4]);
    // Two default chunks of output from a frame of 30 bytes.
    const big = Buffer.alloc(zlib.constants.Z_DEFAULT_CHUNK * 2, "hello world ");
    const bigFrame = zlib.zstdCompressSync(big);

    // One write() for each chunk, then end(). Rejects on 'error'.
    async function decodeWrites(chunks, options) {
      const decoder = zlib.createZstdDecompress(options);
      const { promise, resolve, reject } = Promise.withResolvers();
      const output = [];
      decoder.on("data", chunk => output.push(chunk));
      decoder.on("end", resolve);
      decoder.on("error", reject);
      for (const chunk of chunks) decoder.write(chunk);
      decoder.end();
      await promise;
      return { output: Buffer.concat(output), bytesWritten: decoder.bytesWritten };
    }

    it("bytes that cannot start a frame end the stream when they come in a later write", async () => {
      const { output, bytesWritten } = await decodeWrites([first, junk, second]);
      expect({ output: output.toString(), bytesWritten }).toEqual({
        output: "first\n",
        bytesWritten: first.length,
      });
    });

    it("bytes that cannot start a frame end the stream when the frame fills the output chunk", () => {
      // The sync driver calls the handle again when the chunk is full, and
      // that second call has only the trailing bytes as its input.
      const exact = Buffer.alloc(zlib.constants.Z_DEFAULT_CHUNK, "a");
      const input = Buffer.concat([zlib.zstdCompressSync(exact), Buffer.from("junkjunk")]);
      expect(zlib.zstdDecompressSync(input).equals(exact)).toBe(true);
    });

    it.concurrent("zlib/iter stops at a chunk that cannot start a frame", async () => {
      expect(await decodeWithIter(`[zstdCompressSync("a"), Buffer.from("junk"), zstdCompressSync("b")]`)).toEqual({
        decompressZstd: { output: "a" },
        decompressZstdSync: { output: "a" },
        exitCode: 0,
      });
    });

    // The cases below are the same before and after the decoder began to
    // track frames across writes. They hold the multi-frame behavior in place.
    it.each([
      [
        "two frames, one byte for each write",
        () => Array.from(Buffer.concat([first, second]), byte => Buffer.of(byte)),
      ],
      [
        "a frame and 2 bytes of the next, then the rest",
        () => [Buffer.concat([first, second.subarray(0, 2)]), second.subarray(2)],
      ],
      ["a skippable frame between two frames", () => [first, skippable, second]],
    ])("decodes %s", async (_, chunks) => {
      const input = chunks();
      const { output, bytesWritten } = await decodeWrites(input);
      expect({ output: output.toString(), bytesWritten }).toEqual({
        output: "first\nsecond\n",
        bytesWritten: Buffer.concat(input).length,
      });
    });

    it("decodes a second frame whose first 20 bytes come alone", async () => {
      const { output } = await decodeWrites([first, bigFrame.subarray(0, 20), bigFrame.subarray(20)]);
      expect(output.equals(Buffer.concat([Buffer.from("first\n"), big]))).toBe(true);
    });

    it("decodes a skippable frame to nothing", () => {
      expect(zlib.zstdDecompressSync(skippable)).toEqual(Buffer.alloc(0));
      expect(zlib.zstdDecompressSync(Buffer.concat([first, skippable, second])).toString()).toBe("first\nsecond\n");
    });

    it("decodes a frame that needs many output chunks", async () => {
      const options = { chunkSize: zlib.constants.Z_MIN_CHUNK };
      expect(zlib.zstdDecompressSync(bigFrame, options).equals(big)).toBe(true);
      const { output } = await decodeWrites([bigFrame], options);
      expect(output.equals(big)).toBe(true);
    });

    it("input that is not a frame at the start of the stream is an error", async () => {
      expect(() => zlib.zstdDecompressSync(junk)).toThrow(
        expect.objectContaining({ code: "ZSTD_error_prefix_unknown" }),
      );
      await expect(decodeWrites([junk])).rejects.toMatchObject({ code: "ZSTD_error_prefix_unknown" });
    });
  });

  describe("input that ends inside a frame", () => {
    const { ZSTD_e_continue, ZSTD_e_flush, ZSTD_e_end } = zlib.constants;
    const payload = Buffer.alloc(6000, "hello world ");
    const frame = zlib.zstdCompressSync(payload);
    const truncated = frame.subarray(0, frame.length - 10);
    const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
    const skippableMagic = Buffer.from([0x50, 0x2a, 0x4d, 0x18]);
    // A length of 4, then 4 bytes that a decoder skips.
    const skippable = Buffer.concat([skippableMagic, Buffer.from([4, 0, 0, 0, 1, 2, 3, 4])]);
    const bytewise = buffer => Array.from(buffer, byte => Buffer.of(byte));
    const repeat = (count, operation) => Array.from({ length: count }, () => operation);

    const unexpectedEnd = {
      constructor: "Error",
      message: "unexpected end of file",
      code: "Z_BUF_ERROR",
      errno: -5,
      ownKeys: ["code", "errno"],
    };
    const describeError = err => ({
      constructor: err.constructor.name,
      message: err.message,
      code: err.code,
      errno: err.errno,
      ownKeys: Object.keys(err).sort(),
    });
    function thrownBy(fn) {
      try {
        fn();
      } catch (err) {
        return describeError(err);
      }
    }

    // An operation is a chunk to write, or a function that gets the stream.
    // Resolves at 'close' with the output size and how the stream stopped.
    async function run(operations, options) {
      const decoder = zlib.createZstdDecompress(options);
      const { promise, resolve } = Promise.withResolvers();
      const result = { output: 0, stopped: "close" };
      decoder.on("data", chunk => (result.output += chunk.length));
      decoder.on("end", () => (result.stopped = "end"));
      decoder.on("error", err => (result.stopped = describeError(err)));
      decoder.on("close", () => resolve(result));
      for (const operation of operations) {
        if (typeof operation === "function") await operation(decoder);
        else decoder.write(operation);
      }
      return await promise;
    }
    const end = decoder => decoder.end();
    const flushEnd = decoder => decoder.flush(ZSTD_e_end);
    const written = chunk => decoder => new Promise(resolve => decoder.write(chunk, resolve));

    describe.each([
      ["no input", Buffer.alloc(0), 0],
      ["a truncated frame", truncated, 0],
      ["a frame and a truncated frame", Buffer.concat([frame, truncated]), payload.length],
      ["a frame and the 4 bytes of a magic number", Buffer.concat([frame, magic]), payload.length],
      ["2 bytes of a magic number", magic.subarray(0, 2), 0],
      ["a truncated skippable frame", skippable.subarray(0, skippable.length - 2), 0],
    ])("%s", (_, input, outputBeforeError) => {
      it("zstdDecompressSync throws", () => {
        expect(thrownBy(() => zlib.zstdDecompressSync(input))).toEqual(unexpectedEnd);
      });

      it("zstdDecompress rejects", async () => {
        const err = await util
          .promisify(zlib.zstdDecompress)(input)
          .catch(err => err);
        expect(describeError(err)).toEqual(unexpectedEnd);
      });

      it("a stream emits 'error' after the output of the complete frames", async () => {
        expect(await run([decoder => decoder.end(input)])).toEqual({
          output: outputBeforeError,
          stopped: unexpectedEnd,
        });
      });
    });

    it.each([
      ["write(truncated) with a callback, then end()", [written(truncated), end], 0],
      ["write(frame), write(truncated) and end() in one tick", [frame, truncated, end], payload.length],
      ["end() with no write", [end], 0],
      ["flush(ZSTD_e_end) before the first write", [flushEnd, end], 0],
      ["flush(ZSTD_e_end) in the middle of a frame", [truncated, flushEnd, end], 0],
      [
        "a magic number split between two writes",
        [frame, magic.subarray(0, 2), magic.subarray(2), end],
        payload.length,
      ],
      ["one byte for each write", [...bytewise(Buffer.concat([frame, truncated])), end], payload.length],
      ["reset() after a complete frame, then end()", [written(frame), d => d.reset(), end], payload.length],
    ])("a stream emits 'error' on %s", async (_, operations, output) => {
      expect(await run(operations)).toEqual({ output, stopped: unexpectedEnd });
    });

    it("a stream with options.flush = ZSTD_e_end judges each write", async () => {
      expect(await run([frame.subarray(0, 10), end], { flush: ZSTD_e_end })).toEqual({
        output: 0,
        stopped: unexpectedEnd,
      });
    });

    it("a stream emits the output it decoded before the error", async () => {
      const big = zlib.zstdCompressSync(Buffer.alloc(1 << 20, "hello world "));
      const { output, stopped } = await run([big.subarray(0, big.length - 10), end]);
      expect(stopped).toEqual(unexpectedEnd);
      // The frame has 8 blocks of 128 KiB. The last one is not complete.
      expect(output).toBe(7 * 128 * 1024);
    });

    // minizlib, and tar through it, call _processChunk on a handle that stays open.
    function processChunks(steps) {
      const decoder = new zlib.ZstdDecompress();
      const handle = decoder._handle;
      const close = handle.close;
      handle.close = () => {};
      let output = 0;
      try {
        for (const [chunk, flush] of steps) {
          output += decoder._processChunk(chunk, flush).length;
          decoder._handle = handle;
        }
        return { output };
      } catch (err) {
        return describeError(err);
      } finally {
        close.call(handle);
      }
    }

    it.each([
      ["the truncated frame and ZSTD_e_end", [[truncated, ZSTD_e_end]], unexpectedEnd],
      [
        "the truncated frame, then no input and ZSTD_e_end",
        [
          [truncated, ZSTD_e_continue],
          [Buffer.alloc(0), ZSTD_e_end],
        ],
        unexpectedEnd,
      ],
      [
        "the frame, then no input and ZSTD_e_end",
        [
          [frame, ZSTD_e_continue],
          [Buffer.alloc(0), ZSTD_e_end],
        ],
        { output: payload.length },
      ],
    ])("_processChunk with %s", (_, steps, expected) => {
      expect(processChunks(steps)).toEqual(expected);
    });

    it.concurrent("zlib/iter throws", async () => {
      const error = { message: unexpectedEnd.message, code: unexpectedEnd.code, errno: unexpectedEnd.errno };
      expect(await decodeWithIter(`[zstdCompressSync(Buffer.alloc(6000, "hello world ")).subarray(0, -10)]`)).toEqual({
        decompressZstd: error,
        decompressZstdSync: error,
        exitCode: 0,
      });
    });

    describe.each([
      ["ZSTD_e_flush", ZSTD_e_flush],
      ["ZSTD_e_continue", ZSTD_e_continue],
    ])("finishFlush: %s does not judge the end of the input", (_, finishFlush) => {
      it.each([
        ["a truncated frame", truncated],
        ["no input", Buffer.alloc(0)],
      ])("%s", async (_, input) => {
        expect(zlib.zstdDecompressSync(input, { finishFlush })).toEqual(Buffer.alloc(0));
        expect(await util.promisify(zlib.zstdDecompress)(input, { finishFlush })).toEqual(Buffer.alloc(0));
        expect(await run([decoder => decoder.end(input)], { finishFlush })).toEqual({ output: 0, stopped: "end" });
      });
    });

    it("_finishFlushFlag is read at the end of the stream", async () => {
      const setFlag = decoder => (decoder._finishFlushFlag = ZSTD_e_flush);
      expect(await run([setFlag, decoder => decoder.end(truncated)])).toEqual({ output: 0, stopped: "end" });
    });

    it.each([
      ["destroy()", decoder => decoder.destroy()],
      ["close()", decoder => decoder.close()],
    ])("%s in the middle of a frame emits no error", async (_, stop) => {
      expect(await run([truncated, stop])).toEqual({ output: 0, stopped: "close" });
    });

    // The cases below decode input that is complete, or that ends with bytes
    // the decoder ignores. The check must not report them.
    it.each([
      ["a frame", frame, 1],
      ["two frames", Buffer.concat([frame, frame]), 2],
      ["a frame and bytes that cannot start a frame", Buffer.concat([frame, Buffer.from("not zstd at all")]), 1],
      ["a frame and 1 byte of a magic number", Buffer.concat([frame, magic.subarray(0, 1)]), 1],
      ["a frame and 2 bytes of a magic number", Buffer.concat([frame, magic.subarray(0, 2)]), 1],
      ["a frame and 3 bytes of a magic number", Buffer.concat([frame, magic.subarray(0, 3)]), 1],
      ["a frame and 1 byte of a skippable magic number", Buffer.concat([frame, skippableMagic.subarray(0, 1)]), 1],
      ["a frame and 3 bytes of a skippable magic number", Buffer.concat([frame, skippableMagic.subarray(0, 3)]), 1],
      ["a skippable frame", skippable, 0],
    ])("zstdDecompressSync decodes %s", (_, input, frames) => {
      expect(zlib.zstdDecompressSync(input).length).toBe(frames * payload.length);
      expect(zlib.zstdDecompressSync(input, { chunkSize: zlib.constants.Z_MIN_CHUNK }).length).toBe(
        frames * payload.length,
      );
    });

    it.each([
      ["3 bytes of a magic number, one for each write", [frame, ...bytewise(magic.subarray(0, 3)), end], 1],
      ["flush(ZSTD_e_end) between two frames", [frame, flushEnd, frame, end], 2],
      ["20 calls of flush(ZSTD_e_end) after a frame", [frame, ...repeat(20, flushEnd), end], 1],
      ["20 writes of no input after a frame", [frame, ...repeat(20, Buffer.alloc(0)), end], 1],
      ["reset() in the middle of a frame, then a frame", [written(truncated), d => d.reset(), frame, end], 1],
    ])("a stream ends after %s", async (_, operations, frames) => {
      expect(await run(operations)).toEqual({ output: frames * payload.length, stopped: "end" });
      expect(await run(operations, { chunkSize: zlib.constants.Z_MIN_CHUNK })).toEqual({
        output: frames * payload.length,
        stopped: "end",
      });
    });
  });

  it("can compress streaming", async () => {
    const encoder = zlib.createZstdCompress();
    for (const chunk of window(inputString, 55)) {
      encoder.push(chunk);
    }
    encoder.push(null);
    const buf = await new Response(encoder).text();
    expect(buf).toEqual(inputString);
  });

  it("can decompress streaming", async () => {
    const decoder = zlib.createZstdDecompress();
    for (const chunk of window(compressedBuffer, 10)) {
      decoder.push(chunk);
    }
    decoder.push(null);
    const buf = await new Response(decoder).bytes();
    expect(buf).toEqual(compressedBuffer);
  });

  it("can roundtrip an empty string", async () => {
    const input = "";
    const compressed = await util.promisify(zlib.zstdCompress)(input);
    const roundtrip = await util.promisify(zlib.zstdDecompress)(compressed);
    expect(roundtrip.toString()).toEqual(input);
  });

  it("can compress streaming big", async () => {
    const encoder = zlib.createZstdCompress();
    const input = inputString + inputString + inputString + inputString;
    for (const chunk of window(input, 65)) {
      encoder.push(chunk);
    }
    encoder.push(null);
    const buf = await new Response(encoder).text();
    expect(buf).toEqual(input);
  });

  it("fully works as a stream.Transform", async () => {
    const x_dir = tmpdirSync();
    const out_path_c = resolve(x_dir, "this.js.br");
    const out_path_d = resolve(x_dir, "this.js");

    {
      const { resolve, reject, promise } = Promise.withResolvers();
      const readStream = fs.createReadStream(import.meta.filename);
      const writeStream = fs.createWriteStream(out_path_c);
      const brStream = zlib.createZstdCompress();
      const the_stream = readStream.pipe(brStream).pipe(writeStream);
      the_stream.on("finish", resolve);
      the_stream.on("error", reject);
      await promise;
    }
    {
      const { resolve, reject, promise } = Promise.withResolvers();
      const readStream = fs.createReadStream(out_path_c);
      const writeStream = fs.createWriteStream(out_path_d);
      const brStream = zlib.createZstdDecompress();
      const the_stream = readStream.pipe(brStream).pipe(writeStream);
      the_stream.on("finish", resolve);
      the_stream.on("error", reject);
      await promise;
    }
    {
      const expected = await Bun.file(import.meta.filename).text();
      const actual = await Bun.file(out_path_d).text();
      expect(actual).toEqual(expected);
    }
  });

  it("streaming encode doesn't wait for entire input", async () => {
    const readStream = new stream.Readable();
    const zstdStream = zlib.createZstdCompress();
    let all = [];

    const { promise, resolve, reject } = Promise.withResolvers();
    zstdStream.on("data", chunk => all.push(chunk.length));
    zstdStream.on("end", resolve);
    zstdStream.on("error", reject);

    // Distinct incompressible (random) chunks so the compressor emits many output chunks.
    for (let i = 0; i < 8; i++) {
      readStream.push(randomFillSync(Buffer.alloc(1024 * 1024)));
    }
    readStream.push(null);
    readStream.pipe(zstdStream);
    await promise;
    expect(all.length).toBeGreaterThanOrEqual(7);
  }, 15_000);
});

describe("async write buffer lifetime", () => {
  it("keeps the input and output buffers attached while a native write is in flight", async () => {
    const { promise, resolve } = Promise.withResolvers();
    const deflate = zlib.createDeflate();
    try {
      const handle = deflate._handle;

      const input = new Uint8Array(new ArrayBuffer(64));
      input.fill(97);
      const out = new Uint8Array(new ArrayBuffer(1024));

      // Mirror the bookkeeping processChunk() performs before calling
      // handle.write(), so the native write callback can complete normally.
      handle.buffer = input;
      handle.cb = resolve;
      handle.availOutBefore = out.byteLength;
      handle.availInBefore = input.byteLength;
      handle.inOff = 0;
      handle.flushFlag = zlib.constants.Z_FINISH;

      handle.write(
        zlib.constants.Z_FINISH, // flush
        input, // in
        0, // in_off
        input.byteLength, // in_len
        out, // out
        0, // out_off
        out.byteLength, // out_len
      );

      // The native worker thread reads `input` and writes compressed bytes into
      // `out` through raw pointers until the write completes. Transferring
      // either ArrayBuffer must not detach the backing store out from under
      // the worker -- both buffers must stay attached and full-length.
      out.buffer.transfer();
      input.buffer.transfer();
      expect(out.buffer.detached).toBe(false);
      expect(out.byteLength).toBe(1024);
      expect(input.buffer.detached).toBe(false);
      expect(input.byteLength).toBe(64);

      await promise;

      // Once the write completes the buffers are released and can be
      // transferred again.
      out.buffer.transfer();
      input.buffer.transfer();
      expect(out.buffer.detached).toBe(true);
      expect(input.buffer.detached).toBe(true);
    } finally {
      deflate.close();
    }
  });
});

describe("async write pins are released", () => {
  it("transfer() detaches once several async writes through the same buffers have completed", async () => {
    const deflate = zlib.createDeflate();
    try {
      const handle = deflate._handle;
      const input = new Uint8Array(new ArrayBuffer(64)).fill(97);
      const out = new Uint8Array(new ArrayBuffer(4096));
      for (let i = 0; i < 5; i++) {
        const { promise, resolve } = Promise.withResolvers();
        handle.buffer = input;
        handle.cb = resolve;
        handle.availOutBefore = out.byteLength;
        handle.availInBefore = input.byteLength;
        handle.inOff = 0;
        handle.flushFlag = zlib.constants.Z_NO_FLUSH;
        handle.write(zlib.constants.Z_NO_FLUSH, input, 0, input.byteLength, out, 0, out.byteLength);
        await promise;
      }
      // Every write pinned both buffers; every completion must have unpinned them, or they stay undetachable.
      out.buffer.transfer();
      input.buffer.transfer();
      expect(out.buffer.detached).toBe(true);
      expect(input.buffer.detached).toBe(true);
    } finally {
      deflate.close();
    }
  });
});

describe("dictionary buffer lifetime", () => {
  it("decompresses correctly when the dictionary's ArrayBuffer is detached after stream creation", async () => {
    const dictText = "hello hello hello world world world ";
    const input = Buffer.from(dictText.repeat(16));

    // Each call returns a dictionary backed by its own non-pooled ArrayBuffer
    // so it can be transferred independently.
    const makeDict = () => {
      const dict = new Uint8Array(new ArrayBuffer(dictText.length));
      dict.set(Buffer.from(dictText));
      return dict;
    };

    // Produce a zlib stream whose header demands this dictionary (FDICT set),
    // so inflate must re-read the dictionary bytes mid-stream (Z_NEED_DICT).
    const compressed = zlib.deflateSync(input, { dictionary: makeDict() });

    // Sanity: an intact dictionary round-trips.
    expect(zlib.inflateSync(compressed, { dictionary: makeDict() }).equals(input)).toBe(true);

    // Create the inflater, then detach the dictionary's backing store. The
    // native handle only consumes the dictionary later, when inflate reports
    // Z_NEED_DICT on the worker thread, so it must keep its own copy of the
    // bytes rather than a pointer into the (now freed) JS allocation.
    const dict = makeDict();
    const inflater = zlib.createInflate({ dictionary: dict });
    dict.buffer.transfer(0);
    expect(dict.buffer.detached).toBe(true);

    // Churn the heap so a stale pointer would observe different bytes.
    let garbage = [];
    for (let i = 0; i < 256; i++) garbage.push(new Uint8Array(dictText.length).fill(0xaa));
    Bun.gc(true);
    garbage = [];

    const chunks = [];
    const { promise, resolve, reject } = Promise.withResolvers();
    inflater.on("data", c => chunks.push(c));
    inflater.on("end", resolve);
    inflater.on("error", reject);
    inflater.end(compressed);
    await promise;

    expect(Buffer.concat(chunks).toString()).toBe(input.toString());
  });
});

describe("crc32", () => {
  it("rejects String objects", () => {
    expect(() => zlib.crc32(new String("abc"))).toThrow(TypeError);
    expect(() => zlib.crc32(String.prototype)).toThrow(TypeError);
    expect(zlib.crc32("abc")).toBe(891568578);
  });

  it("handles missing and undefined arguments", () => {
    // No data argument: ERR_INVALID_ARG_TYPE (not a crash, not a different error).
    expect(() => zlib.crc32()).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }));
    // Explicit undefined behaves the same as no argument.
    expect(() => zlib.crc32(undefined)).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }));
    // Omitted second arg defaults to value=0.
    expect(zlib.crc32("hello")).toBe(zlib.crc32("hello", 0));
  });
});
