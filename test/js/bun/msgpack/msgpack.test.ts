// msgpack-test-suite.json is dist/msgpack-test-suite.json of https://github.com/kawanet/msgpack-test-suite
// at e04f6edeaae589c768d6b70fcce80aa786b7800e. MIT License, Copyright (c) 2017-2018 Yusuke Kawasaki.
import { describe, expect, test } from "bun:test";
import { isDebug } from "harness";
import suite from "./msgpack-test-suite.json";

const { encode, decode, decodeChunk, Extension } = Bun.msgpack;

const bytes = (hex: string) => new Uint8Array(Buffer.from(hex.replaceAll(/[-\s]/g, ""), "hex"));
const toHex = (data: Uint8Array) => Buffer.from(data).toString("hex");
const hex = (value: unknown) => toHex(encode(value));
const ascii = (length: number, fill = "a") => Buffer.alloc(length, fill).toString();

describe("Bun.msgpack", () => {
  test("has Symbol.toStringTag", () => {
    expect(Object.prototype.toString.call(Bun.msgpack)).toBe("[object msgpack]");
  });

  test("has encode, decode, decodeChunk and Extension", () => {
    expect(Object.keys(Bun.msgpack).sort()).toEqual(["Extension", "decode", "decodeChunk", "encode"]);
    expect([encode.length, decode.length, decodeChunk.length, Extension.length]).toEqual([1, 1, 1, 2]);
    expect([encode.name, decode.name, decodeChunk.name, Extension.name]).toEqual([
      "encode",
      "decode",
      "decodeChunk",
      "Extension",
    ]);
  });

  describe("msgpack-test-suite", () => {
    type Case = {
      msgpack: string[];
      nil?: null;
      bool?: boolean;
      binary?: string;
      number?: number;
      bignum?: string;
      string?: string;
      array?: unknown[];
      map?: Record<string, unknown>;
      timestamp?: [number, number];
      ext?: [number, string];
    };

    // The value a case stands for, and whether encode() is expected to write one of its encodings.
    function valueOf(c: Case): { value: unknown; encodes: unknown[] } {
      if ("nil" in c) return { value: null, encodes: [null] };
      if ("bool" in c) return { value: c.bool, encodes: [c.bool] };
      if ("binary" in c) return { value: bytes(c.binary!), encodes: [bytes(c.binary!)] };
      if ("number" in c)
        return { value: c.number, encodes: "bignum" in c ? [c.number, BigInt(c.bignum!)] : [c.number] };
      if ("bignum" in c) return { value: BigInt(c.bignum!), encodes: [BigInt(c.bignum!)] };
      if ("string" in c) return { value: c.string, encodes: [c.string] };
      if ("array" in c) return { value: c.array, encodes: [c.array] };
      if ("map" in c) return { value: c.map, encodes: [c.map] };
      if ("timestamp" in c) {
        const [seconds, nanoseconds] = c.timestamp!;
        const date = new Date(seconds * 1000 + Math.floor(nanoseconds / 1e6));
        // A Date has milliseconds. The other cases cannot be written from one.
        return { value: date, encodes: nanoseconds % 1e6 === 0 ? [date] : [] };
      }
      if ("ext" in c) {
        const extension = new Extension(c.ext![0], bytes(c.ext![1]));
        return { value: extension, encodes: [extension] };
      }
      throw new Error("unknown case " + JSON.stringify(c));
    }

    for (const [name, cases] of Object.entries(suite as unknown as Record<string, Case[]>)) {
      test(name, () => {
        for (const c of cases) {
          const encodings = c.msgpack.map(encoding => encoding.replaceAll("-", ""));
          const { value, encodes } = valueOf(c);
          for (const encoding of encodings) {
            expect(decode(bytes(encoding))).toStrictEqual(value);
          }
          for (const input of encodes) {
            expect(encodings).toContain(hex(input));
          }
        }
      });
    }
  });

  describe("encode", () => {
    test("returns a Uint8Array of its own", () => {
      const a = encode({ a: 1 });
      const b = encode({ a: 1 });
      expect(a.constructor).toBe(Uint8Array);
      expect(a.byteOffset).toBe(0);
      expect(a.buffer.byteLength).toBe(a.length);
      expect(a.buffer).not.toBe(b.buffer);
      a[0] = 0;
      expect(toHex(b)).toBe("81a16101");
    });

    test("nil, booleans and undefined", () => {
      expect(hex(null)).toBe("c0");
      expect(hex(undefined)).toBe("c0");
      // @ts-expect-error
      expect(toHex(encode())).toBe("c0");
      expect(hex(false)).toBe("c2");
      expect(hex(true)).toBe("c3");
    });

    test.each([
      [0, "00"],
      [-0, "00"],
      [1, "01"],
      [127, "7f"],
      [128, "cc80"],
      [255, "ccff"],
      [256, "cd0100"],
      [65535, "cdffff"],
      [65536, "ce00010000"],
      [4294967295, "ceffffffff"],
      [4294967296, "cf0000000100000000"],
      [Number.MAX_SAFE_INTEGER, "cf001fffffffffffff"],
      [-1, "ff"],
      [-32, "e0"],
      [-33, "d0df"],
      [-128, "d080"],
      [-129, "d1ff7f"],
      [-32768, "d18000"],
      [-32769, "d2ffff7fff"],
      [-2147483648, "d280000000"],
      [-2147483649, "d3ffffffff7fffffff"],
      [Number.MIN_SAFE_INTEGER, "d3ffe0000000000001"],
    ])("integer %p", (value, expected) => {
      expect(hex(value)).toBe(expected);
    });

    test.each([
      [0.5, "cb3fe0000000000000"],
      [-0.5, "cbbfe0000000000000"],
      [1.1, "cb3ff199999999999a"],
      [NaN, "cb7ff8000000000000"],
      [Infinity, "cb7ff0000000000000"],
      [-Infinity, "cbfff0000000000000"],
      [Number.MIN_VALUE, "cb0000000000000001"],
      [Number.MAX_VALUE, "cb7fefffffffffffff"],
      // Integers that a double does not hold exactly stay doubles.
      [2 ** 53, "cb4340000000000000"],
      [-(2 ** 53), "cbc340000000000000"],
      [2 ** 64, "cb43f0000000000000"],
    ])("float %p", (value, expected) => {
      expect(hex(value)).toBe(expected);
    });

    test("BigInt is always 64-bit", () => {
      expect(hex(0n)).toBe("cf0000000000000000");
      expect(hex(5n)).toBe("cf0000000000000005");
      expect(hex(2n ** 63n)).toBe("cf8000000000000000");
      expect(hex(2n ** 64n - 1n)).toBe("cfffffffffffffffff");
      expect(hex(-1n)).toBe("d3ffffffffffffffff");
      expect(hex(-5n)).toBe("d3fffffffffffffffb");
      expect(hex(-(2n ** 63n))).toBe("d38000000000000000");
    });

    test("BigInt outside 64 bits throws", () => {
      expect(() => encode(2n ** 64n)).toThrow(RangeError);
      expect(() => encode(-(2n ** 63n) - 1n)).toThrow(RangeError);
      expect(() => encode({ a: [10n ** 40n] })).toThrow(RangeError);
    });

    test("string headers", () => {
      expect(hex("")).toBe("a0");
      expect(hex("a")).toBe("a161");
      expect(hex(ascii(31))).toBe("bf" + "61".repeat(31));
      expect(hex(ascii(32))).toBe("d920" + "61".repeat(32));
      expect(hex(ascii(255))).toBe("d9ff" + "61".repeat(255));
      expect(hex(ascii(256))).toBe("da0100" + "61".repeat(256));
      expect(hex(ascii(65535)).slice(0, 8)).toBe("daffff61");
      expect(encode(ascii(65535)).length).toBe(3 + 65535);
      expect(hex(ascii(65536)).slice(0, 12)).toBe("db0001000061");
      expect(encode(ascii(65536)).length).toBe(5 + 65536);
    });

    test("strings are UTF-8", () => {
      expect(hex("é")).toBe("a2c3a9");
      expect(hex("€")).toBe("a3e282ac");
      expect(hex("🍺")).toBe("a4f09f8dba");
      expect(hex("aé€🍺")).toBe("aa61c3a9e282acf09f8dba");
      expect(hex("\0")).toBe("a100");
      // The header has the length in bytes, not in characters.
      expect(hex("é".repeat(15)).slice(0, 2)).toBe("be");
      expect(hex("é".repeat(16)).slice(0, 4)).toBe("d920");
      expect(hex("é".repeat(128)).slice(0, 6)).toBe("da0100");
      expect(hex("€".repeat(21846)).slice(0, 10)).toBe("db00010002");
    });

    test("a lone surrogate becomes U+FFFD", () => {
      expect(hex("\ud800")).toBe("a3efbfbd");
      expect(hex("a\udc00b")).toBe("a561efbfbd62");
      expect(hex("\ud83c")).toBe("a3efbfbd");
      expect(hex("\ud83c\udf7a")).toBe("a4f09f8dba");
    });

    test("rope strings", () => {
      const left = ascii(40, "x");
      const right = "é" + ascii(40, "y");
      const rope = left + right;
      expect(hex(rope)).toBe("d952" + "78".repeat(40) + "c3a9" + "79".repeat(40));
      expect(hex({ [rope]: rope })).toBe("81" + hex(rope) + hex(rope));
    });

    test("binary", () => {
      expect(hex(new Uint8Array([1, 2, 3]))).toBe("c403010203");
      expect(hex(new Uint8Array(0))).toBe("c400");
      expect(hex(Buffer.from([1, 2, 3]))).toBe("c403010203");
      expect(hex(new Uint8Array([9, 1, 2, 3, 9]).subarray(1, 4))).toBe("c403010203");
      expect(hex(new Uint8Array([1, 2, 3]).buffer)).toBe("c403010203");
      const shared = new SharedArrayBuffer(3);
      new Uint8Array(shared).set([1, 2, 3]);
      expect(hex(shared)).toBe("c403010203");
      expect(hex(new Uint8Array(shared, 1))).toBe("c4020203");
      expect(hex(new DataView(new Uint8Array([9, 1, 2, 3, 9]).buffer, 1, 3))).toBe("c403010203");
      expect(hex(new Uint16Array([1, 2]))).toBe(
        toHex(new Uint8Array([0xc4, 4, ...new Uint8Array(new Uint16Array([1, 2]).buffer)])),
      );
      expect(hex(new Float64Array([1]))).toBe("c408" + toHex(new Uint8Array(new Float64Array([1]).buffer)));
      expect(hex(new Uint8Array(255)).slice(0, 4)).toBe("c4ff");
      expect(hex(new Uint8Array(256)).slice(0, 6)).toBe("c50100");
      expect(hex(new Uint8Array(65535)).slice(0, 6)).toBe("c5ffff");
      expect(hex(new Uint8Array(65536)).slice(0, 10)).toBe("c600010000");
      expect(encode(new Uint8Array(65536)).length).toBe(5 + 65536);
    });

    test("arrays", () => {
      expect(hex([])).toBe("90");
      expect(hex([1, 2, 3])).toBe("93010203");
      expect(hex(new Array(15).fill(0))).toBe("9f" + "00".repeat(15));
      expect(hex(new Array(16).fill(0))).toBe("dc0010" + "00".repeat(16));
      expect(hex(new Array(65535).fill(0)).slice(0, 6)).toBe("dcffff");
      expect(hex(new Array(65536).fill(0)).slice(0, 10)).toBe("dd00010000");
      expect(hex([[], [[]], [1, [2, [3]]]])).toBe("93909190920192029103");
    });

    test("arrays of numbers", () => {
      expect(hex([0, 127, 128, -1, -33, 65536, -70000])).toBe(
        "9700" + "7f" + "cc80" + "ff" + "d0df" + "ce00010000" + "d2fffeee90",
      );
      expect(hex([0.5, 1.5, -2.25])).toBe("93cb3fe0000000000000cb3ff8000000000000cbc002000000000000");
      // Integers in an array that also has fractions are still written as integers.
      expect(hex([1, 2.5, 3, 2 ** 40, -0])).toBe("9501cb4004000000000000" + "03" + "cf0000010000000000" + "00");
      expect(hex([1.5, NaN, Infinity, -Infinity])).toBe(
        "94cb3ff8000000000000cb7ff8000000000000cb7ff0000000000000cbfff0000000000000",
      );
      const integers = Array.from({ length: 3000 }, (_, i) => i * 7 - 5000);
      expect(decode(encode(integers))).toStrictEqual(integers);
      const fractions = Array.from({ length: 3000 }, (_, i) => i / 8 - 100);
      expect(decode(encode(fractions))).toStrictEqual(fractions);
      expect(hex({ numbers: [1, 2, 3], more: [0.5] })).toBe("82a76e756d6265727393010203a46d6f726591cb3fe0000000000000");
    });

    test("arrays of numbers with holes", () => {
      const integers = [1, 2, 3, 4];
      delete integers[1];
      expect(hex(integers)).toBe("9401c00304");
      const fractions = [0.5, 1.5, 2.5];
      delete fractions[0];
      delete fractions[2];
      expect(hex(fractions)).toBe("93c0cb3ff8000000000000c0");
      const sparse = [1.5];
      sparse[3] = 2;
      expect(hex(sparse)).toBe("94cb3ff8000000000000c0c002");
      const grown = [1, 2];
      grown.length = 4;
      expect(hex(grown)).toBe("940102c0c0");
    });

    test("what an array cannot hold becomes nil", () => {
      // prettier-ignore
      expect(hex([, 1])).toBe("92c001");
      expect(hex([undefined, () => {}, Symbol("s"), null])).toBe("94c0c0c0c0");
      expect(hex(new Array(3))).toBe("93c0c0c0");
    });

    test("objects", () => {
      expect(hex({})).toBe("80");
      expect(hex({ a: 1 })).toBe("81a16101");
      expect(hex({ a: { b: { c: [] } } })).toBe("81a16181a16281a16390");
      expect(hex(Object.create(null))).toBe("80");
      expect(hex(Object.assign(Object.create(null), { a: 1 }))).toBe("81a16101");
      expect(hex({ é: 1 })).toBe("81a2c3a901");
      expect(hex({ "": 1 })).toBe("81a001");
      expect(hex(JSON.parse('{"__proto__":1}'))).toBe("81a95f5f70726f746f5f5f01");
    });

    const objectOf = (count: number, without = -1) =>
      Object.fromEntries(Array.from({ length: count }, (_, i) => ["k" + i, i === without ? undefined : 0]));

    test("object headers", () => {
      expect(hex(objectOf(15)).slice(0, 2)).toBe("8f");
      expect(hex(objectOf(16)).slice(0, 6)).toBe("de0010");
      expect(hex(objectOf(300)).slice(0, 6)).toBe("de012c");
    });

    test("keys are in the order of Object.keys", () => {
      expect(hex({ b: 1, a: 2, 1: 3, 0: 4 })).toBe("84a13004a13103a16201a16102");
      expect(hex({ 1: "a" })).toBe("81a131a161");
    });

    test("undefined, function and symbol properties are left out", () => {
      expect(hex({ a: undefined, b: 1, c() {}, d: Symbol("s"), e: null })).toBe("82a16201a165c0");
      expect(hex({ a: undefined })).toBe("80");
      expect(hex({ [Symbol("key")]: 1, a: 1 })).toBe("81a16101");
    });

    test("the header is right when properties are left out across a size boundary", () => {
      const without = (object: Record<string, unknown>) =>
        Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
      // 16 properties need a map 16 header. 15 fit in a fixmap.
      const sixteen = objectOf(16, 3);
      expect(hex(sixteen)).toBe(hex(without(sixteen)));
      expect(hex(sixteen).slice(0, 2)).toBe("8f");
      expect(hex({ a: [sixteen, 1], b: 2 })).toBe(hex({ a: [without(sixteen), 1], b: 2 }));
      // Inside the same size of header.
      const many = objectOf(40, 39);
      expect(hex(many)).toBe(hex(without(many)));
      expect(hex(many).slice(0, 6)).toBe("de0027");
      expect(hex(objectOf(1, 0))).toBe("80");
    });

    // A debug build takes seconds to make an object of 65536 properties, and seconds more to read them.
    test.skipIf(isDebug)("objects and maps of 65535 and 65536 entries", () => {
      const most = objectOf(65535);
      expect(hex(most).slice(0, 6)).toBe("deffff");
      expect(decode(encode(most))).toStrictEqual(most);

      const more = objectOf(65536);
      const encoded = encode(more);
      expect(toHex(encoded.subarray(0, 5))).toBe("df00010000");
      expect(decode(encoded)).toStrictEqual(more);

      // 65536 properties need a map 32 header. The 65535 that are written fit in a map 16.
      const oneLeftOut = objectOf(65536, 3);
      const { k3, ...rest } = more;
      expect(k3).toBe(0);
      expect(hex(oneLeftOut)).toBe(hex(rest));
      expect(hex(oneLeftOut).slice(0, 6)).toBe("deffff");

      const map = new Map(Array.from({ length: 65536 }, (_, i) => ["k" + i, 0]));
      expect(hex(map)).toBe(toHex(encoded));
    });

    test("only own enumerable properties", () => {
      const object = Object.create({ inherited: 1 });
      object.own = 2;
      Object.defineProperty(object, "hidden", { value: 3, enumerable: false });
      expect(hex(object)).toBe("81a36f776e02");

      class Point {
        x = 1;
        #secret = 2;
        get sum() {
          return this.x + this.#secret;
        }
        method() {}
      }
      expect(hex(new Point())).toBe("81a17801");
    });

    test("getters are called", () => {
      const calls: string[] = [];
      const object = {
        get a() {
          calls.push("a");
          return 1;
        },
        b: 2,
        get c() {
          calls.push("c");
          return [3];
        },
      };
      expect(hex(object)).toBe("83a16101a16202a1639103");
      expect(calls).toEqual(["a", "c"]);
    });

    test("a getter can change the object it is on", () => {
      const object: Record<string, unknown> = {
        get a() {
          delete object.b;
          object.d = 4;
          return 1;
        },
        b: 2,
        c: 3,
      };
      // The keys are those the object had at the start, as for JSON.stringify.
      expect(decode(encode(object))).toEqual(JSON.parse(JSON.stringify({ a: 1, c: 3 })));
    });

    test("Map and Set", () => {
      expect(hex(new Map())).toBe("80");
      expect(
        hex(
          new Map<unknown, unknown>([
            [1, "a"],
            ["k", [true]],
          ]),
        ),
      ).toBe("8201a161a16b91c3");
      expect(
        hex(
          new Map<unknown, unknown>([
            [null, 1],
            [1.5, 2],
            [true, 3],
          ]),
        ),
      ).toBe("83c001cb3ff800000000000002c303");
      expect(hex(new Map([[{ a: 1 }, [1]]]))).toBe("8181a161019101");
      expect(hex(new Map([["a", undefined]]))).toBe("81a161c0");
      expect(hex(new Set())).toBe("90");
      expect(hex(new Set([1, "a", null]))).toBe("9301a161c0");
      expect(hex({ m: new Map([["a", new Set([1])]]) })).toBe("81a16d81a1619101");
      const many = new Map(Array.from({ length: 16 }, (_, i) => [i, i]));
      expect(hex(many).slice(0, 6)).toBe("de0010");
    });

    test("Date", () => {
      expect(hex(new Date(0))).toBe("d6ff00000000");
      expect(hex(new Date(1514862245000))).toBe("d6ff5a4af6a5");
      expect(hex(new Date(1514862245678))).toBe("d7ffa1a5d6005a4af6a5");
      expect(hex(new Date(4294967295000))).toBe("d6ffffffffff");
      expect(hex(new Date(4294967296000))).toBe("d7ff0000000100000000");
      expect(hex(new Date(17179869183999))).toBe("d7ffee2e1f03ffffffff");
      expect(hex(new Date(17179869184000))).toBe("c70cff000000000000000400000000");
      expect(hex(new Date(-1))).toBe("c70cff3b8b87c0ffffffffffffffff");
      expect(hex(new Date(-1000))).toBe("c70cff00000000ffffffffffffffff");
      expect(hex(new Date(8.64e15))).toBe("c70cff00000000000007dba8218000");
      expect(hex(new Date(-8.64e15))).toBe("c70cff00000000fffff82457de8000");
      expect(hex({ at: new Date(0) })).toBe("81a26174d6ff00000000");
    });

    test("an invalid Date is nil, as for JSON.stringify", () => {
      expect(hex(new Date(NaN))).toBe("c0");
      expect(hex({ at: new Date(NaN) })).toBe("81a26174c0");
    });

    test("toJSON", () => {
      expect(hex({ toJSON: () => ({ a: 1 }) })).toBe("81a16101");
      expect(hex(new URL("https://bun.sh/"))).toBe(hex("https://bun.sh/"));
      expect(hex({ url: new URL("https://bun.sh/") })).toBe("81a3" + "75726c" + hex("https://bun.sh/"));
      expect(hex({ toJSON: 1, a: 2 })).toBe("82a6746f4a534f4e01a16102");

      class Money {
        constructor(
          public amount: number,
          public currency: string,
        ) {}
        toJSON() {
          return `${this.amount} ${this.currency}`;
        }
      }
      expect(hex([new Money(5, "EUR")])).toBe("91" + hex("5 EUR"));
    });

    test("toJSON gets the key", () => {
      const keys: unknown[] = [];
      const spy = {
        toJSON(key: unknown) {
          keys.push(key);
          return 0;
        },
      };
      encode(spy);
      encode({ k: spy, 7: spy });
      encode([spy, spy]);
      encode(new Map([["m", spy]]));
      encode(new Set([spy]));
      expect(keys).toEqual(["", "7", "k", "0", "1", "", ""]);
    });

    test("what toJSON returns is not asked for toJSON again", () => {
      let calls = 0;
      const inner = {
        toJSON() {
          calls++;
          return "inner";
        },
      };
      // The function that is its only property is left out.
      expect(hex({ toJSON: () => inner })).toBe("80");
      expect(calls).toBe(0);
    });

    test("toJSON that returns nothing", () => {
      const nothing = { toJSON() {} };
      expect(hex(nothing)).toBe("c0");
      expect(hex({ a: nothing, b: 1 })).toBe("81a16201");
      expect(hex([nothing])).toBe("91c0");
    });

    test("toJSON can return what MessagePack has a type for", () => {
      expect(hex({ toJSON: () => new Date(0) })).toBe("d6ff00000000");
      expect(hex({ toJSON: () => new Uint8Array([1]) })).toBe("c40101");
      expect(hex({ toJSON: () => 5n })).toBe("cf0000000000000005");
      expect(hex({ toJSON: () => new Map([[1, 2]]) })).toBe("810102");
    });

    test("boxed primitives", () => {
      expect(hex([new Number(1), new String("s"), new Boolean(true), Object(5n)])).toBe("9401a173c3cf0000000000000005");
      expect(hex(new Number(1.5))).toBe("cb3ff8000000000000");
    });

    test("Proxy", () => {
      expect(hex(new Proxy([1, 2], {}))).toBe("920102");
      expect(hex(new Proxy({ a: 1 }, {}))).toBe("81a16101");
      const traps: string[] = [];
      const proxy = new Proxy(
        { a: 1, b: 2 },
        {
          ownKeys(target) {
            traps.push("ownKeys");
            return Reflect.ownKeys(target);
          },
          get(target, key, receiver) {
            if (typeof key === "string") traps.push("get " + key);
            return Reflect.get(target, key, receiver);
          },
        },
      );
      expect(hex(proxy)).toBe("82a16101a16202");
      expect(traps).toEqual(["get toJSON", "ownKeys", "get a", "get b"]);
    });

    test("other objects are their own enumerable properties", () => {
      expect(hex(/a/g)).toBe("80");
      expect(hex(new Error("e"))).toBe("80");
      expect(hex(Object.assign(new Error("e"), { code: 1 }))).toBe("81a4636f646501");
      expect(hex(Promise.resolve(1))).toBe("80");
      expect(hex(new WeakMap())).toBe("80");
    });

    test("a function or a symbol alone throws", () => {
      expect(() => encode(() => {})).toThrow(TypeError);
      expect(() => encode(class {})).toThrow(TypeError);
      expect(() => encode(Symbol("s"))).toThrow(TypeError);
    });

    test("cycles throw", () => {
      const object: any = { a: { b: {} } };
      object.a.b.c = object;
      expect(() => encode(object)).toThrow(TypeError);
      const array: any[] = [];
      array.push([array]);
      expect(() => encode(array)).toThrow(TypeError);
      const map = new Map();
      map.set("self", map);
      expect(() => encode(map)).toThrow(TypeError);
      const set = new Set();
      set.add({ set });
      expect(() => encode(set)).toThrow(TypeError);
      // Every toJSON() returns a new object, so no object is inside itself. The stack ends it.
      const viaToJSON: any = { toJSON: () => ({ again: viaToJSON }) };
      expect(() => encode(viaToJSON)).toThrow(RangeError);
    });

    test("the same object twice is not a cycle", () => {
      const shared = { a: 1 };
      expect(hex([shared, shared, { shared }])).toBe("9381a1610181a1610181a673686172656481a16101");
    });

    test("errors from getters and toJSON propagate", () => {
      const error = new Error("from the getter");
      expect(() =>
        encode({
          a: 1,
          get b(): number {
            throw error;
          },
        }),
      ).toThrow(error);
      expect(() =>
        encode([
          {
            toJSON() {
              throw error;
            },
          },
        ]),
      ).toThrow(error);
      expect(() =>
        encode(
          new Proxy(
            {},
            {
              ownKeys() {
                throw error;
              },
            },
          ),
        ),
      ).toThrow(error);
    });

    test("very deep nesting throws a RangeError", () => {
      let deep: unknown = 0;
      for (let i = 0; i < 100_000; i++) deep = [deep];
      expect(() => encode(deep)).toThrow(RangeError);
      let deepObject: unknown = 0;
      for (let i = 0; i < 100_000; i++) deepObject = { a: deepObject };
      expect(() => encode(deepObject)).toThrow(RangeError);
    });

    test("nesting that fits is fine", () => {
      let deep: unknown = 7;
      for (let i = 0; i < 500; i++) deep = [deep];
      expect(hex(deep)).toBe("91".repeat(500) + "07");
      expect(decode(encode(deep))).toEqual(deep);
    });

    test("a value of many kilobytes", () => {
      const rows = Array.from({ length: 1500 }, (_, i) => ({
        id: i,
        name: "row " + i,
        tags: ["a", "b"],
        ok: i % 2 === 0,
      }));
      const encoded = encode(rows);
      expect(encoded.length).toBeGreaterThan(40_000);
      expect(encoded.buffer.byteLength).toBe(encoded.length);
      expect(decode(encoded)).toEqual(rows);
    });

    test("lengths around a kilobyte", () => {
      for (const length of [1000, 1018, 1019, 1020, 1021, 1022, 1023, 1024, 1025, 2045, 2046, 4093, 5000]) {
        const text = ascii(length);
        const encoded = encode(text);
        expect(encoded.length).toBe(length + 3);
        expect(encoded.buffer.byteLength).toBe(encoded.length);
        expect(encoded.byteOffset).toBe(0);
        expect(decode(encoded)).toBe(text);
        const inArray = encode([text, 1]);
        expect(inArray.length).toBe(length + 5);
        expect(decode(inArray)).toStrictEqual([text, 1]);
      }
    });
  });

  describe("decode", () => {
    test.each([
      ["c0", null],
      ["c2", false],
      ["c3", true],
      ["00", 0],
      ["7f", 127],
      ["e0", -32],
      ["ff", -1],
      ["ccff", 255],
      ["cdffff", 65535],
      ["ceffffffff", 4294967295],
      ["d080", -128],
      ["d18000", -32768],
      ["d280000000", -2147483648],
      ["ca3fc00000", 1.5],
      ["cac0000000", -2],
      ["ca7fc00000", NaN],
      ["ca7f800000", Infinity],
      ["caff800000", -Infinity],
      ["cb3ff8000000000000", 1.5],
      ["cb7ff8000000000000", NaN],
      ["cbfff0000000000000", -Infinity],
      ["cb8000000000000000", -0],
      ["ca80000000", -0],
      ["a0", ""],
      ["a161", "a"],
      ["d90161", "a"],
      ["da000161", "a"],
      ["db0000000161", "a"],
      ["90", []],
      ["dc0000", []],
      ["dd00000000", []],
      ["80", {}],
      ["de0000", {}],
      ["df00000000", {}],
      ["9301a16193c0c2c3", [1, "a", [null, false, true]]],
      ["82a16101a16281a16302", { a: 1, b: { c: 2 } }],
    ])("%s", (input, expected) => {
      expect(decode(bytes(input))).toStrictEqual(expected);
    });

    test("64-bit integers are numbers while they are safe, BigInt beyond", () => {
      expect(decode(bytes("cf0000000000000005"))).toBe(5);
      expect(decode(bytes("cf001fffffffffffff"))).toBe(Number.MAX_SAFE_INTEGER);
      expect(decode(bytes("cf0020000000000000"))).toBe(2n ** 53n);
      expect(decode(bytes("cfffffffffffffffff"))).toBe(2n ** 64n - 1n);
      expect(decode(bytes("d3fffffffffffffffb"))).toBe(-5);
      expect(decode(bytes("d3ffe0000000000001"))).toBe(Number.MIN_SAFE_INTEGER);
      expect(decode(bytes("d3ffe0000000000000"))).toBe(-(2n ** 53n));
      expect(decode(bytes("d38000000000000000"))).toBe(-(2n ** 63n));
      expect(decode(bytes("d37fffffffffffffff"))).toBe(2n ** 63n - 1n);
      expect(decode(encode([5n, 2n ** 60n, -(2n ** 60n)]))).toEqual([5, 2n ** 60n, -(2n ** 60n)]);
    });

    test("strings", () => {
      expect(decode(bytes("a2c3a9"))).toBe("é");
      expect(decode(bytes("a3e282ac"))).toBe("€");
      expect(decode(bytes("a4f09f8dba"))).toBe("🍺");
      expect(decode(bytes("aa61c3a9e282acf09f8dba"))).toBe("aé€🍺");
      expect(decode(bytes("a3610062"))).toBe("a\0b");
      for (const length of [1, 16, 17, 27, 28, 31, 32, 255, 256, 257, 65535, 65536, 70000]) {
        const text = ascii(length, "s");
        expect(decode(encode(text))).toBe(text);
        const wide = "é" + text;
        expect(decode(encode(wide))).toBe(wide);
      }
    });

    test("bytes that are not UTF-8 become U+FFFD, as for TextDecoder", () => {
      const decoder = new TextDecoder();
      for (const invalid of ["c328", "c3", "eda080", "f0808080", "ff", "e282", "c080", "61ff62", "f09f8d", "80"]) {
        const body = bytes(invalid);
        const input = new Uint8Array([0xa0 + body.length, ...body]);
        expect(decode(input)).toBe(decoder.decode(body));
      }
      expect(decode(bytes("a2c328"))).toBe("\ufffd(");
      expect(decode(bytes("81a2c32801"))).toEqual({ "\ufffd(": 1 });
    });

    test("binary is a Uint8Array that shares nothing with the input", () => {
      const input = Buffer.from("c403010203", "hex");
      const output = decode(input) as Uint8Array;
      expect(output.constructor).toBe(Uint8Array);
      expect(output).toEqual(new Uint8Array([1, 2, 3]));
      expect(output.buffer).not.toBe(input.buffer);
      input.fill(0);
      expect(output).toEqual(new Uint8Array([1, 2, 3]));
      expect(decode(bytes("c400"))).toEqual(new Uint8Array(0));
      expect(decode(bytes("c5000101"))).toEqual(new Uint8Array([1]));
      expect(decode(bytes("c60000000101"))).toEqual(new Uint8Array([1]));
      const large = new Uint8Array(100_000).map((_, i) => i);
      expect(decode(encode(large))).toEqual(large);
    });

    test("arrays of numbers", () => {
      expect(decode(bytes("9401ff7fd0df"))).toStrictEqual([1, -1, 127, -33]);
      expect(decode(bytes("93cb3fe0000000000000ca3fc0000003"))).toStrictEqual([0.5, 1.5, 3]);
      expect(decode(bytes("9301cb3fe000000000000003"))).toStrictEqual([1, 0.5, 3]);
      // NaN among doubles, which a double array cannot store as it is.
      expect(decode(bytes("93cb3ff8000000000000cb7ff800000000000002"))).toStrictEqual([1.5, NaN, 2]);
      expect(decode(bytes("91cb7ff8000000000000"))).toStrictEqual([NaN]);
      expect(decode(bytes("93ca7fc00000cb7ff0000000000000cb8000000000000000"))).toStrictEqual([NaN, Infinity, -0]);
      expect(decode(bytes("9401cb3ff8000000000000a161c0"))).toStrictEqual([1, 1.5, "a", null]);
      expect(decode(bytes("92cf0020000000000000" + "01"))).toStrictEqual([2n ** 53n, 1]);
      const array = decode(bytes("9201cb3ff8000000000000")) as number[];
      array.push(NaN, 3);
      expect(array).toStrictEqual([1, 1.5, NaN, 3]);
      expect(decode(bytes("93cb8000000000000000" + "01" + "ca80000000"))).toStrictEqual([-0, 1, -0]);
      expect(decode(bytes("94ce7fffffff" + "ce80000000" + "d280000000" + "d3ffffffff7fffffff"))).toStrictEqual([
        2147483647, 2147483648, -2147483648, -2147483649,
      ]);
      // 64-bit integers: numbers while they are safe, and the array has a BigInt when one is not.
      expect(decode(bytes("93cf0000000000000005" + "d3fffffffffffffffb" + "cf001fffffffffffff"))).toStrictEqual([
        5,
        -5,
        Number.MAX_SAFE_INTEGER,
      ]);
      expect(decode(bytes("9301cfffffffffffffffff" + "02"))).toStrictEqual([1, 2n ** 64n - 1n, 2]);
      expect(decode(bytes("9301d38000000000000000" + "02"))).toStrictEqual([1, -(2n ** 63n), 2]);
      expect(decode(bytes("93c3c2c0"))).toStrictEqual([true, false, null]);
      expect(decode(bytes("9501c3cb3ff8000000000000c0ff"))).toStrictEqual([1, true, 1.5, null, -1]);
      expect(decode(bytes("9401c3a161c2"))).toStrictEqual([1, true, "a", false]);
      const flags = Array.from({ length: 1000 }, (_, i) => [true, false, null, i][i % 4]);
      expect(decode(encode(flags))).toStrictEqual(flags);
      expect(() => decode(bytes("930102"))).toThrow(SyntaxError);
      expect(() => decode(bytes("9201cb3ff8"))).toThrow(SyntaxError);
      // An array inside an array that is still being read.
      expect(decode(bytes("9501920203" + "04" + "93050607" + "08"))).toStrictEqual([1, [2, 3], 4, [5, 6, 7], 8]);
      const nested = Array.from({ length: 40 }, (_, i) => Array.from({ length: i }, (_, j) => (j % 2 ? j + 0.5 : j)));
      expect(decode(encode(nested))).toStrictEqual(nested);
    });

    test("arrays", () => {
      for (const length of [0, 1, 15, 16, 17, 65535, 65536]) {
        const array = Array.from({ length }, (_, i) => i % 200);
        expect(decode(encode(array))).toEqual(array);
      }
      expect(decode(bytes("93c0c0c0"))).toStrictEqual([null, null, null]);
      expect(decode(bytes("92cb3ff8000000000000a161"))).toStrictEqual([1.5, "a"]);
    });

    test("maps become objects", () => {
      const object = Object.fromEntries(Array.from({ length: 300 }, (_, i) => ["key" + i, i]));
      expect(decode(encode(object))).toStrictEqual(object);
      expect(decode(bytes("de0001a16101"))).toStrictEqual({ a: 1 });
      expect(decode(bytes("df00000001a16101"))).toStrictEqual({ a: 1 });
      expect(Object.keys(decode(bytes("83a16201a16102a13103")) as object)).toEqual(["1", "b", "a"]);
      expect(decode(bytes("81a001"))).toStrictEqual({ "": 1 });
      expect(decode(bytes("81a2c3a901"))).toStrictEqual({ é: 1 });
      const long = ascii(300, "k");
      expect(decode(encode({ [long]: 1 }))).toStrictEqual({ [long]: 1 });
    });

    test("number keys become strings", () => {
      expect(decode(bytes("810102"))).toStrictEqual({ "1": 2 });
      expect(decode(bytes("81ff02"))).toStrictEqual({ "-1": 2 });
      expect(decode(bytes("81cd010002"))).toStrictEqual({ "256": 2 });
      expect(decode(bytes("81cb3ff800000000000002"))).toStrictEqual({ "1.5": 2 });
      expect(decode(bytes("81cb7ff800000000000002"))).toStrictEqual({ NaN: 2 });
      expect(decode(bytes("81cfffffffffffffffff02"))).toStrictEqual({ "18446744073709551615": 2 });
      expect(decode(bytes("81d3800000000000000002"))).toStrictEqual({ "-9223372036854775808": 2 });
      expect(decode(bytes("81ceffffffff02"))).toStrictEqual({ "4294967295": 2 });
      expect(
        decode(
          encode(
            new Map([
              [1, "a"],
              [2, "b"],
            ]),
          ),
        ),
      ).toStrictEqual({ "1": "a", "2": "b" });
    });

    test.each([
      ["nil", "81c002", "not nil"],
      ["false", "81c202", "not a boolean"],
      ["true", "81c302", "not a boolean"],
      ["binary", "81c4016102", "not binary"],
      ["array", "819002", "not an array"],
      ["array 16", "81dc000002", "not an array"],
      ["map", "818002", "not a map"],
      ["map 32", "81df0000000002", "not a map"],
      ["extension", "81d4051002", "not an extension"],
      ["timestamp", "81d6ff0000000002", "not an extension"],
    ])("a %s key is an error", (_, input, reason) => {
      expect(() => decode(bytes(input))).toThrow(SyntaxError);
      expect(() => decode(bytes(input))).toThrow("A MessagePack map key must be a string or a number, " + reason);
    });

    test("index keys", () => {
      expect(decode(bytes("82a13001a13102"))).toStrictEqual({ "0": 1, "1": 2 });
      expect(decode(bytes("82a13101a13002"))).toStrictEqual({ "0": 2, "1": 1 });
      expect(decode(encode({ "4294967294": 1, "4294967295": 2, "01": 3, "-1": 4 }))).toStrictEqual({
        "4294967294": 1,
        "4294967295": 2,
        "01": 3,
        "-1": 4,
      });
    });

    test("a repeated key keeps its place and takes the last value", () => {
      const object = decode(bytes("83a16101a16202a16103"));
      expect(object).toStrictEqual({ a: 3, b: 2 });
      expect(Object.keys(object as object)).toEqual(["a", "b"]);
      expect(decode(bytes("82a13001a13002"))).toStrictEqual({ "0": 2 });
    });

    test("__proto__ is a property, not the prototype", () => {
      // {"__proto__": {"polluted": true}}
      const object = decode(bytes("81a95f5f70726f746f5f5f81a8706f6c6c75746564c3")) as any;
      expect(Object.getPrototypeOf(object)).toBe(Object.prototype);
      expect(Object.keys(object)).toEqual(["__proto__"]);
      expect(Object.getOwnPropertyDescriptor(object, "__proto__")!.value).toStrictEqual({ polluted: true });
      expect(({} as any).polluted).toBeUndefined();
      expect(object.polluted).toBeUndefined();
      expect(hex(object)).toBe("81a95f5f70726f746f5f5f81a8706f6c6c75746564c3");

      const others = decode(encode(JSON.parse('{"constructor":1,"toString":2,"hasOwnProperty":3,"__proto__":4}')));
      expect(Object.entries(others as object)).toEqual([
        ["constructor", 1],
        ["toString", 2],
        ["hasOwnProperty", 3],
        ["__proto__", 4],
      ]);
    });

    test("objects of a shape that was decoded before", () => {
      // Up to 6 properties fit in an empty object, up to 62 in the object itself, and a shape stops at 64.
      for (const count of [1, 5, 6, 7, 20, 61, 62, 63, 64, 65, 70, 200]) {
        const object = Object.fromEntries(Array.from({ length: count }, (_, i) => ["p" + count + "_" + i, i]));
        const encoded = encode(object);
        for (let i = 0; i < 3; i++) {
          const decoded = decode(encoded) as Record<string, number>;
          expect(decoded).toStrictEqual(object);
          expect(Object.keys(decoded)).toEqual(Object.keys(object));
          decoded.added = 1;
          expect(decoded.added).toBe(1);
        }
      }
      // The same keys, then a different one where the shape has had one key so far.
      expect(decode(bytes("82a16101a16202"))).toStrictEqual({ a: 1, b: 2 });
      expect(decode(bytes("82a16101a16302"))).toStrictEqual({ a: 1, c: 2 });
      expect(decode(bytes("83a16101a16202a16303"))).toStrictEqual({ a: 1, b: 2, c: 3 });
      expect(decode(bytes("83a16101a16202a16403"))).toStrictEqual({ a: 1, b: 2, d: 3 });
      // A key that is there already, where the shape has a property to add.
      expect(decode(bytes("83a16101a16202a16103"))).toStrictEqual({ a: 3, b: 2 });
      expect(decode(bytes("82a16101a16102"))).toStrictEqual({ a: 2 });
      // What JavaScript made has the same shape.
      const made = decode(bytes("82a16101a16202")) as { a: number; b: number };
      const literal = { a: 1, b: 2 };
      expect(made).toStrictEqual(literal);
      expect(JSON.stringify(made)).toBe(JSON.stringify(literal));
    });

    test("strings that repeat, and strings that only look alike", () => {
      const long = [
        "aaaaaaaaXbbbbbbbb",
        "aaaaaaaaYbbbbbbbb",
        "aaaaaaaaXbbbbbbbb",
        "aaaaaaaabbbbbbbb",
        "aaaaaaaaXbbbbbbbbb",
      ];
      expect(decode(encode(long))).toStrictEqual(long);
      // Often enough for the input to be one that strings are remembered for.
      const often = Array.from({ length: 12 }, () => long).flat();
      expect(decode(encode(often))).toStrictEqual(often);
      const strings: string[] = [];
      for (let length = 0; length <= 40; length++) {
        for (const fill of ["a", "b", "é"]) {
          strings.push(Buffer.alloc(length, fill).toString("latin1"));
          strings.push(Buffer.alloc(length, "x").toString() + fill);
          strings.push(fill + Buffer.alloc(length, "x").toString());
        }
      }
      const twice = [...strings, ...strings.toReversed()];
      expect(decode(encode(twice))).toStrictEqual(twice);
      expect(
        decode(encode({ status: "active", other: "active", list: ["active", "inactive", "active"] })),
      ).toStrictEqual({
        status: "active",
        other: "active",
        list: ["active", "inactive", "active"],
      });
    });

    test("objects of one shape", () => {
      const rows = Array.from({ length: 2000 }, (_, i) => ({
        id: i,
        name: "n" + (i % 7),
        active: i % 3 === 0,
        score: i / 4,
      }));
      const decoded = decode(encode(rows)) as typeof rows;
      expect(decoded).toStrictEqual(rows);
      expect(Object.keys(decoded[1999])).toEqual(["id", "name", "active", "score"]);
    });

    test("many different keys", () => {
      const object = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [i.toString(36) + "_" + i, i]));
      for (let i = 0; i < 2; i++) expect(decode(encode(object))).toStrictEqual(object);
    });

    test("timestamps become Dates", () => {
      expect(decode(bytes("d6ff00000000"))).toStrictEqual(new Date(0));
      expect(decode(bytes("d6ff5a4af6a5"))).toStrictEqual(new Date(1514862245000));
      expect(decode(bytes("d7ffa1a5d6005a4af6a5"))).toStrictEqual(new Date(1514862245678));
      // 678901234 nanoseconds: a Date keeps the milliseconds.
      expect(decode(bytes("d7ffa1dcd7c85a4af6a5"))).toStrictEqual(new Date(1514862245678));
      expect(decode(bytes("c70cff3b8b87c0ffffffffffffffff"))).toStrictEqual(new Date(-1));
      expect(decode(bytes("c70cff00000000000007dba8218000"))).toStrictEqual(new Date(8.64e15));
      expect(decode(bytes("c70cff00000000fffff82457de8000"))).toStrictEqual(new Date(-8.64e15));
      expect(decode(bytes("81a26174d6ff00000000"))).toStrictEqual({ at: new Date(0) });
      for (const ms of [
        0,
        1,
        -1,
        999,
        1000,
        1700000000123,
        -62135596800000,
        253402300799999,
        2 ** 32 * 1000,
        2 ** 34 * 1000 - 1,
        2 ** 34 * 1000,
      ]) {
        expect((decode(encode(new Date(ms))) as Date).getTime()).toBe(ms);
      }
    });

    test.each([
      ["1 byte", "d4ff00"],
      ["2 bytes", "d5ff0000"],
      ["16 bytes", "d8ff" + "00".repeat(16)],
      ["0 bytes", "c700ff"],
      ["11 bytes", "c70bff" + "00".repeat(11)],
      ["timestamp 64 with 1e9 nanoseconds", "d7ffee6b280000000000"],
      ["timestamp 96 with 1e9 nanoseconds", "c70cff3b9aca000000000000000000"],
      ["timestamp 96 past the last Date", "c70cff00000000000007dba8218001"],
      ["timestamp 96 before the first Date", "c70cff00000000fffff82457de7fff"],
      ["timestamp 96 with the largest seconds", "c70cff000000007fffffffffffffff"],
      ["timestamp 96 with the smallest seconds", "c70cff000000008000000000000000"],
    ])("a timestamp of %s is an error", (_, input) => {
      expect(() => decode(bytes(input))).toThrow(SyntaxError);
    });

    test("other extensions become Extension", () => {
      const extension = decode(bytes("d40510")) as InstanceType<typeof Extension>;
      expect(extension).toBeInstanceOf(Extension);
      expect(Object.getPrototypeOf(extension)).toBe(Extension.prototype);
      expect(extension.type).toBe(5);
      expect(extension.data.constructor).toBe(Uint8Array);
      expect(extension.data).toEqual(new Uint8Array([0x10]));
      expect(Object.keys(extension)).toEqual(["type", "data"]);
      expect(extension).toStrictEqual(new Extension(5, new Uint8Array([0x10])));

      expect(decode(bytes("d4fe10"))).toStrictEqual(new Extension(-2, new Uint8Array([0x10])));
      expect(decode(bytes("d48010"))).toStrictEqual(new Extension(-128, new Uint8Array([0x10])));
      expect(decode(bytes("d47f10"))).toStrictEqual(new Extension(127, new Uint8Array([0x10])));
      expect(decode(bytes("c70001"))).toStrictEqual(new Extension(1, new Uint8Array(0)));
      expect(decode(bytes("c8000301aabbcc"))).toStrictEqual(new Extension(1, new Uint8Array([0xaa, 0xbb, 0xcc])));
      expect(decode(bytes("c90000000301aabbcc"))).toStrictEqual(new Extension(1, new Uint8Array([0xaa, 0xbb, 0xcc])));
      expect(decode(bytes("92d40510d40611"))).toStrictEqual([
        new Extension(5, new Uint8Array([0x10])),
        new Extension(6, new Uint8Array([0x11])),
      ]);
    });

    test("the data of an Extension shares nothing with the input", () => {
      const input = bytes("d6050a0b0c0d");
      const extension = decode(input) as InstanceType<typeof Extension>;
      input.fill(0);
      expect(extension.data).toEqual(new Uint8Array([0x0a, 0x0b, 0x0c, 0x0d]));
    });

    test.each([
      ["nothing", ""],
      ["the byte that is never used", "c1"],
      ["the byte that is never used, in an array", "9201c1"],
      ["bytes after the value", "0102"],
      ["bytes after the value", "90c0"],
      ["a nil after a map", "80c0"],
    ])("%s is an error", (_, input) => {
      expect(() => decode(bytes(input))).toThrow(SyntaxError);
    });

    test("every shorter input is an error", () => {
      const value = {
        int: -70000,
        big: 2n ** 60n,
        float: 1.5,
        text: "héllo " + ascii(40),
        bin: new Uint8Array([1, 2, 3]),
        list: [1, [2, [3, null, true]]],
        when: new Date(1700000000123),
        far: new Date(-1),
        ext: new Extension(9, new Uint8Array(20)),
        map: { a: { b: { c: "d" } } },
      };
      const whole = encode(value);
      expect(decode(whole)).toStrictEqual(value);
      for (let length = 0; length < whole.length; length++) {
        expect(() => decode(whole.subarray(0, length))).toThrow(SyntaxError);
      }
    });

    test.each([
      ["array 32", "ddffffffff"],
      ["array 32", "dd7fffffff" + "00".repeat(10)],
      ["array 16", "dcffff"],
      ["map 32", "dfffffffff"],
      ["map 32", "df7fffffff" + "a16101".repeat(4)],
      ["map 16", "deffff"],
      ["str 32", "dbffffffff"],
      ["str 32", "dbffffffff" + "61".repeat(10)],
      ["bin 32", "c6ffffffff"],
      ["ext 32", "c9ffffffff05"],
      ["ext 32", "c9ffffffff"],
      ["nested array 32", "91".repeat(20) + "ddffffffff"],
    ])("a %s that promises more than there is is an error, not an allocation", (_, input) => {
      expect(() => decode(bytes(input))).toThrow(SyntaxError);
    });

    test("very deep nesting throws a RangeError", () => {
      const arrays = new Uint8Array(100_000).fill(0x91);
      arrays[arrays.length - 1] = 0;
      expect(() => decode(arrays)).toThrow(RangeError);
      expect(() => decodeChunk(arrays)).toThrow(RangeError);
      // {"a": {"a": {"a": ...
      const maps = Buffer.alloc(300_001, Buffer.from([0x81, 0xa1, 0x61]));
      maps[maps.length - 1] = 0;
      expect(() => decode(maps)).toThrow(RangeError);
    });

    test("nesting that fits is fine", () => {
      const arrays = new Uint8Array(501).fill(0x91);
      arrays[500] = 7;
      let value = decode(arrays);
      for (let i = 0; i < 500; i++) value = (value as unknown[])[0];
      expect(value).toBe(7);
    });

    test("accepts every kind of buffer", () => {
      const data = [0x92, 0x01, 0xa1, 0x61];
      const padded = new Uint8Array([0xc1, 0xc1, ...data, 0xc1]);
      const shared = new SharedArrayBuffer(4);
      new Uint8Array(shared).set(data);
      const inputs = [
        new Uint8Array(data),
        Buffer.from(data),
        padded.subarray(2, 6),
        Buffer.from(padded.buffer, 2, 4),
        new DataView(padded.buffer, 2, 4),
        new Uint8Array(data).buffer,
        shared,
        new Uint8Array(shared),
        new Int8Array(new Uint8Array(data).buffer),
        new Uint8ClampedArray(data),
        new Uint16Array(new Uint8Array(data).buffer),
        new Uint32Array(new Uint8Array(data).buffer),
      ];
      for (const input of inputs) {
        expect(decode(input)).toStrictEqual([1, "a"]);
      }
    });

    test("what is not a buffer throws a TypeError", () => {
      for (const input of [undefined, null, "c0", 0xc0, {}, [0xc0], true, Symbol("s"), 5n, () => {}]) {
        // @ts-expect-error
        expect(() => decode(input)).toThrow(TypeError);
        // @ts-expect-error
        expect(() => decodeChunk(input)).toThrow(TypeError);
      }
      // @ts-expect-error
      expect(() => decode()).toThrow(TypeError);
    });

    test("a detached buffer throws a TypeError", () => {
      const input = new Uint8Array([0xc0]);
      structuredClone(input.buffer, { transfer: [input.buffer] });
      expect(() => decode(input)).toThrow(TypeError);
      expect(() => decodeChunk(input)).toThrow(TypeError);
    });

    test("input from the other implementations", () => {
      const value = {
        id: 1234567,
        name: "bun",
        tags: ["fast", "runtime", "日本語"],
        nested: { ok: true, none: null, ratio: 0.25, neg: -42, list: [1, [2, [3]]] },
        when: new Date(1700000000123),
        bytes: new Uint8Array([0, 1, 2, 254, 255]),
        big: 2 ** 40,
      };
      // @msgpack/msgpack 3.1.3, encode(value)
      const fromMsgpackJavascript =
        "87a26964ce0012d687a46e616d65a362756ea47461677393a466617374a772756e74696d65a9e697a5e69cace8aa9ea66e657374656485a26f6bc3a46e6f6e65c0a5726174696fcb3fd0000000000000a36e6567d0d6a46c697374920192029103a47768656ed7ff1d5353006553f100a56279746573c405000102feffa3626967cf0000010000000000";
      // msgpackr 2.1.0, pack(value): map 16 headers, and 2 ** 40 as a float 64
      const fromMsgpackr =
        "de0007a26964ce0012d687a46e616d65a362756ea47461677393a466617374a772756e74696d65a9e697a5e69cace8aa9ea66e6573746564de0005a26f6bc3a46e6f6e65c0a5726174696fcb3fd0000000000000a36e6567d0d6a46c697374920192029103a47768656ed7ff1d5353006553f100a56279746573c405000102feffa3626967cb4270000000000000";
      expect(decode(bytes(fromMsgpackJavascript))).toStrictEqual(value);
      expect(decode(bytes(fromMsgpackr))).toStrictEqual(value);
      expect(hex(value)).toBe(fromMsgpackJavascript);
      // msgpackr 2.1.0, pack([5n, -5n, 2n ** 63n])
      expect(decode(bytes("93d30000000000000005d3fffffffffffffffbcf8000000000000000"))).toStrictEqual([
        5,
        -5,
        2n ** 63n,
      ]);
    });
  });

  describe("error messages", () => {
    test.each([
      ["", "Unexpected end of MessagePack data"],
      ["9201", "Unexpected end of MessagePack data"],
      ["a3c3", "Unexpected end of MessagePack data"],
      ["c1", "0xc1 is not a MessagePack type"],
      ["81c101", "0xc1 is not a MessagePack type"],
      ["0102", "Unexpected data after the MessagePack value"],
      ["d4ff00", "A MessagePack timestamp has 4, 8 or 12 bytes"],
      ["d7ffee6b280000000000", "A MessagePack timestamp has less than a second of nanoseconds"],
      ["c70cff000000007fffffffffffffff", "MessagePack timestamp is outside of what a Date can hold"],
    ])("decode %p", (input, message) => {
      expect(() => decode(bytes(input))).toThrow(new SyntaxError(message));
    });

    test("decodeChunk has the same error", () => {
      expect(decodeChunk(bytes("01c1")).error).toEqual(new SyntaxError("0xc1 is not a MessagePack type"));
      expect(decodeChunk(bytes("81c002")).error).toEqual(
        new SyntaxError("A MessagePack map key must be a string or a number, not nil"),
      );
    });

    test("arguments", () => {
      // @ts-expect-error
      expect(() => decode("c0")).toThrow(
        new TypeError("Bun.msgpack.decode expects an ArrayBufferView or an ArrayBuffer"),
      );
      // @ts-expect-error
      expect(() => decodeChunk("c0")).toThrow(
        new TypeError("Bun.msgpack.decodeChunk expects an ArrayBufferView or an ArrayBuffer"),
      );
      const detached = new Uint8Array([0xc0]);
      structuredClone(detached.buffer, { transfer: [detached.buffer] });
      expect(() => decode(detached)).toThrow(new TypeError("ArrayBuffer is detached"));
    });

    test("encode", () => {
      expect(() => encode(() => {})).toThrow(new TypeError("Bun.msgpack.encode cannot encode a function"));
      expect(() => encode(Symbol("s"))).toThrow(new TypeError("Bun.msgpack.encode cannot encode a symbol"));
      const cycle: unknown[] = [];
      cycle.push(cycle);
      expect(() => encode(cycle)).toThrow(new TypeError("Bun.msgpack.encode cannot serialize cyclic structures"));
      expect(() => encode(2n ** 64n)).toThrow(
        new RangeError("Bun.msgpack.encode cannot encode a BigInt above 2n ** 64n - 1n"),
      );
      expect(() => encode(-(2n ** 63n) - 1n)).toThrow(
        new RangeError("Bun.msgpack.encode cannot encode a BigInt below -(2n ** 63n)"),
      );
    });

    test("Extension", () => {
      // @ts-expect-error
      expect(() => Extension(1, new Uint8Array(1))).toThrow(
        new TypeError("Class constructor Extension cannot be invoked without 'new'"),
      );
      // @ts-expect-error
      expect(() => new Extension("1", new Uint8Array(1))).toThrow(new TypeError("Extension type must be a number"));
      expect(() => new Extension(300, new Uint8Array(1))).toThrow(
        new RangeError("Extension type must be an integer from -128 to 127, not 300"),
      );
      expect(() => new Extension(1.5, new Uint8Array(1))).toThrow(
        new RangeError("Extension type must be an integer from -128 to 127, not 1.5"),
      );
      // @ts-expect-error
      expect(() => new Extension(1, "data")).toThrow(
        new TypeError("Extension data must be an ArrayBufferView or an ArrayBuffer"),
      );
    });
  });

  describe("decodeChunk", () => {
    test("reads every value", () => {
      expect(decodeChunk(bytes("0102a16193c0c2c3"))).toStrictEqual({
        values: [1, 2, "a", [null, false, true]],
        read: 8,
        done: true,
        error: null,
      });
    });

    test("the result has values, read, done and error, in that order", () => {
      expect(Object.keys(decodeChunk(bytes("01")))).toEqual(["values", "read", "done", "error"]);
    });

    test("nothing to read", () => {
      expect(decodeChunk(new Uint8Array(0))).toStrictEqual({ values: [], read: 0, done: true, error: null });
    });

    test("a value that has not arrived yet is not an error", () => {
      expect(decodeChunk(bytes("019201"))).toStrictEqual({ values: [1], read: 1, done: false, error: null });
      expect(decodeChunk(bytes("9201"))).toStrictEqual({ values: [], read: 0, done: false, error: null });
      expect(decodeChunk(bytes("01a2c3"))).toStrictEqual({ values: [1], read: 1, done: false, error: null });
      expect(decodeChunk(bytes("ddffffffff"))).toStrictEqual({ values: [], read: 0, done: false, error: null });
      expect(decodeChunk(bytes("c6ffffffff0102"))).toStrictEqual({ values: [], read: 0, done: false, error: null });
      expect(decodeChunk(bytes("cf00"))).toStrictEqual({ values: [], read: 0, done: false, error: null });
    });

    test("bytes that are not MessagePack are an error, after the values before them", () => {
      const result = decodeChunk(bytes("01a161c102"));
      expect(result.values).toStrictEqual([1, "a"]);
      expect(result.read).toBe(3);
      expect(result.done).toBe(false);
      expect(result.error).toBeInstanceOf(SyntaxError);

      const first = decodeChunk(bytes("c1"));
      expect(first).toMatchObject({ values: [], read: 0, done: false });
      expect(first.error).toBeInstanceOf(SyntaxError);
    });

    test("an error inside a value leaves read at the start of that value", () => {
      // 1, then {nil: 2}
      const badKey = decodeChunk(bytes("0181c002"));
      expect(badKey).toMatchObject({ values: [1], read: 1, done: false });
      expect(badKey.error).toBeInstanceOf(SyntaxError);
      // 1, then [1, <never used>], then 2
      const nested = decodeChunk(bytes("019201c102"));
      expect(nested).toMatchObject({ values: [1], read: 1, done: false });
      expect(nested.error).toBeInstanceOf(SyntaxError);
      // 1, then a timestamp of one byte
      const timestamp = decodeChunk(bytes("01d4ff00"));
      expect(timestamp).toMatchObject({ values: [1], read: 1, done: false });
      expect(timestamp.error).toBeInstanceOf(SyntaxError);
    });

    test("an error in a value is reported once the value could be complete", () => {
      // An array of two whose first element is the never used byte. The second has not arrived.
      expect(decodeChunk(bytes("92c1"))).toStrictEqual({ values: [], read: 0, done: false, error: null });
      const result = decodeChunk(bytes("92c101"));
      expect(result).toMatchObject({ values: [], read: 0, done: false });
      expect(result.error).toBeInstanceOf(SyntaxError);
    });

    test("start and end", () => {
      const input = bytes("c1010203c1");
      expect(decodeChunk(input, 1, 4)).toStrictEqual({ values: [1, 2, 3], read: 4, done: true, error: null });
      expect(decodeChunk(input, 2, 4)).toStrictEqual({ values: [2, 3], read: 4, done: true, error: null });
      expect(decodeChunk(input, 1, 2)).toStrictEqual({ values: [1], read: 2, done: true, error: null });
      expect(decodeChunk(input, 4).error).toBeInstanceOf(SyntaxError);
      expect(decodeChunk(input, 4).read).toBe(4);
      expect(decodeChunk(input, 3, 3)).toStrictEqual({ values: [], read: 3, done: true, error: null });
      expect(decodeChunk(input, 5)).toStrictEqual({ values: [], read: 5, done: true, error: null });
      // Out of range, or the wrong way round: clamped, as for Bun.JSONL.parseChunk.
      expect(decodeChunk(input, 100)).toStrictEqual({ values: [], read: 5, done: true, error: null });
      expect(decodeChunk(input, 3, 2)).toStrictEqual({ values: [], read: 2, done: true, error: null });
      expect(decodeChunk(input, -5, 4).error).toBeInstanceOf(SyntaxError);
      expect(decodeChunk(input, 1, 100).values).toStrictEqual([1, 2, 3]);
      expect(decodeChunk(input, 1, 100).read).toBe(4);
      // @ts-expect-error
      expect(decodeChunk(input, "1", "4").error).toBeInstanceOf(SyntaxError);
    });

    test("read counts from the start of the view", () => {
      const padded = bytes("c1c1010292");
      const view = padded.subarray(2);
      expect(decodeChunk(view)).toStrictEqual({ values: [1, 2], read: 2, done: false, error: null });
      expect(decodeChunk(view, 1)).toStrictEqual({ values: [2], read: 2, done: false, error: null });
      expect(decodeChunk(new DataView(padded.buffer, 2))).toStrictEqual({
        values: [1, 2],
        read: 2,
        done: false,
        error: null,
      });
    });

    test("a stream cut anywhere gives the same values", () => {
      const messages = [
        { id: 1, method: "ping", params: [] },
        [0, 1, "notify", [new Uint8Array([1, 2, 3]), new Date(1700000000123)]],
        "a string of more than thirty one bytes, to have a str 8",
        null,
        2n ** 62n,
        { nested: { deep: [1, 2, { deeper: [true, false, null, 1.5] }] } },
        new Extension(3, new Uint8Array(300)),
        -1,
      ];
      const stream = Buffer.concat(messages.map(message => encode(message)));
      expect(decodeChunk(stream)).toStrictEqual({ values: messages, read: stream.length, done: true, error: null });

      for (const size of [1, 2, 3, 7, 64, 333]) {
        const received: unknown[] = [];
        let pending: Uint8Array = new Uint8Array(0);
        for (let offset = 0; offset < stream.length; offset += size) {
          pending = Buffer.concat([pending, stream.subarray(offset, offset + size)]);
          const { values, read, error } = decodeChunk(pending);
          expect(error).toBeNull();
          received.push(...values);
          pending = pending.subarray(read);
        }
        expect(pending.length).toBe(0);
        expect(received).toStrictEqual(messages);
      }
    });
  });

  describe("Extension", () => {
    test("has a type and data", () => {
      const data = new Uint8Array([1, 2]);
      const extension = new Extension(5, data);
      expect(extension.type).toBe(5);
      expect(extension.data).toBe(data);
      expect(Object.keys(extension)).toEqual(["type", "data"]);
      expect(extension).toBeInstanceOf(Extension);
      expect(Extension.prototype.constructor).toBe(Extension);
      expect(Object.prototype.toString.call(extension)).toBe("[object Extension]");
    });

    test("needs new", () => {
      // @ts-expect-error
      expect(() => Extension(5, new Uint8Array(1))).toThrow(TypeError);
    });

    test("the type is an integer from -128 to 127", () => {
      for (const type of [-129, 128, 1.5, NaN, Infinity, 1e10]) {
        expect(() => new Extension(type, new Uint8Array(1))).toThrow(RangeError);
      }
      for (const type of ["5", undefined, null, 5n, {}]) {
        // @ts-expect-error
        expect(() => new Extension(type, new Uint8Array(1))).toThrow(TypeError);
      }
      expect(new Extension(-128, new Uint8Array(1)).type).toBe(-128);
      expect(new Extension(127, new Uint8Array(1)).type).toBe(127);
      expect(new Extension(-0, new Uint8Array(1)).type).toBe(0);
    });

    test("the data is a buffer", () => {
      for (const data of [undefined, null, "ab", 5, {}, [1, 2]]) {
        // @ts-expect-error
        expect(() => new Extension(1, data)).toThrow(TypeError);
      }
      // @ts-expect-error
      expect(() => new Extension(1)).toThrow(TypeError);
    });

    test("data that is not a Uint8Array becomes one over the same memory", () => {
      const buffer = new Uint8Array([9, 1, 2, 3, 9]).buffer;
      const fromBuffer = new Extension(1, buffer);
      expect(fromBuffer.data.constructor).toBe(Uint8Array);
      expect(fromBuffer.data.buffer).toBe(buffer);
      expect(fromBuffer.data).toEqual(new Uint8Array([9, 1, 2, 3, 9]));

      const fromView = new Extension(1, new DataView(buffer, 1, 3));
      expect(fromView.data.constructor).toBe(Uint8Array);
      expect(fromView.data.buffer).toBe(buffer);
      expect(fromView.data).toEqual(new Uint8Array([1, 2, 3]));

      const fromWords = new Extension(1, new Uint16Array([1, 2]));
      expect(fromWords.data.constructor).toBe(Uint8Array);
      expect(fromWords.data.length).toBe(4);

      const node = Buffer.from([1, 2]);
      expect(new Extension(1, node).data).toBe(node);
    });

    test("encodes to the smallest format", () => {
      const of = (length: number) => hex(new Extension(7, new Uint8Array(length).fill(0xee)));
      expect(of(1)).toBe("d407ee");
      expect(of(2)).toBe("d507eeee");
      expect(of(4)).toBe("d607eeeeeeee");
      expect(of(8)).toBe("d707" + "ee".repeat(8));
      expect(of(16)).toBe("d807" + "ee".repeat(16));
      expect(of(0)).toBe("c70007");
      expect(of(3)).toBe("c70307eeeeee");
      expect(of(5)).toBe("c70507" + "ee".repeat(5));
      expect(of(17)).toBe("c71107" + "ee".repeat(17));
      expect(of(255)).toBe("c7ff07" + "ee".repeat(255));
      expect(of(256)).toBe("c8010007" + "ee".repeat(256));
      expect(of(65535).slice(0, 8)).toBe("c8ffff07");
      expect(of(65536).slice(0, 12)).toBe("c90001000007");
      expect(hex(new Extension(-128, new Uint8Array([1])))).toBe("d48001");
      expect(hex(new Extension(-2, new Uint8Array([1])))).toBe("d4fe01");
      expect(hex(new Extension(127, new Uint8Array([1])))).toBe("d47f01");
      expect(hex({ e: [new Extension(1, new Uint8Array([2]))] })).toBe("81a16591d40102");
    });

    test("survives a round trip", () => {
      for (const length of [0, 1, 2, 3, 4, 8, 16, 17, 255, 256, 65535, 65536]) {
        const extension = new Extension(
          length % 100,
          new Uint8Array(length).map((_, i) => i),
        );
        expect(decode(encode(extension))).toStrictEqual(extension);
      }
    });

    test("type -1 can be written by hand and is read as a timestamp", () => {
      // Timestamp 64 for 2018-01-02T03:04:05.678901234Z. A Date could not carry the nanoseconds.
      const timestamp = new Extension(-1, bytes("a1dcd7c85a4af6a5"));
      expect(hex(timestamp)).toBe("d7ffa1dcd7c85a4af6a5");
      expect(decode(encode(timestamp))).toStrictEqual(new Date(1514862245678));
    });

    test("is read again when it is encoded", () => {
      const extension = new Extension(1, new Uint8Array([1]));
      extension.type = 2;
      extension.data = new Uint8Array([3, 4]);
      expect(hex(extension)).toBe("d5020304");
      // @ts-expect-error
      extension.type = "2";
      expect(() => encode(extension)).toThrow(TypeError);
      extension.type = 300;
      expect(() => encode(extension)).toThrow(RangeError);
      extension.type = 2;
      // @ts-expect-error
      extension.data = "34";
      expect(() => encode(extension)).toThrow(TypeError);
    });

    test("an object that only looks like one is a map", () => {
      expect(hex({ type: 1, data: new Uint8Array([2]) })).toBe("82a47479706501a464617461c40102");
    });

    test("a subclass is an extension too", () => {
      class Handle extends Extension {
        constructor(id: number) {
          super(42, new Uint8Array([id]));
        }
        get id() {
          return this.data[0];
        }
      }
      const handle = new Handle(7);
      expect(handle).toBeInstanceOf(Extension);
      expect(handle.id).toBe(7);
      expect(hex(handle)).toBe("d42a07");
      expect(hex([handle])).toBe("91d42a07");
    });
  });

  describe("round trips", () => {
    // mulberry32
    function random(seed: number) {
      return () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    const alphabets = ["abcdefghij", "0123456789", "éüñ€", "日本語🍺😀", '_$ \n\0"\\'];

    function generate(next: () => number, depth: number, json: boolean): unknown {
      const pick = (n: number) => Math.floor(next() * n);
      const text = () => {
        const alphabet = Array.from(alphabets[pick(alphabets.length)]);
        const length = [0, 1, 5, 20, 40, 300][pick(6)];
        let out = "";
        for (let i = 0; i < length; i++) out += alphabet[pick(alphabet.length)];
        return out;
      };
      const kinds = depth <= 0 ? 8 : 10;
      switch (pick(json ? kinds : kinds + 4)) {
        case 0:
          return null;
        case 1:
          return next() < 0.5;
        case 2:
          return pick(256) - 128;
        case 3:
          return Math.floor((next() - 0.5) * 2 ** [8, 16, 32, 40, 53][pick(5)]);
        case 4:
          return (next() - 0.5) * 10 ** (pick(40) - 20);
        case 5:
        case 6:
        case 7:
          return text();
        case 8:
          return Array.from({ length: [0, 1, 3, 20][pick(4)] }, () => generate(next, depth - 1, json));
        case 9: {
          const object: Record<string, unknown> = {};
          const count = [0, 1, 3, 20][pick(4)];
          for (let i = 0; i < count; i++)
            object[next() < 0.2 ? String(pick(50)) : text()] = generate(next, depth - 1, json);
          return object;
        }
        case 10:
          return new Uint8Array([0, 1, 31, 300][pick(4)]).map(() => pick(256));
        case 11:
          return new Date(Math.floor((next() - 0.5) * 2 ** [32, 42, 52][pick(3)]));
        case 12:
          return (next() < 0.5 ? -1n : 1n) * (2n ** 53n + BigInt(pick(2 ** 30)));
        default:
          return new Extension(
            pick(128),
            new Uint8Array([0, 1, 2, 4, 5, 16, 40][pick(7)]).map(() => pick(256)),
          );
      }
    }

    test("what JSON can hold comes back as from JSON", () => {
      const next = random(1);
      for (let i = 0; i < 100; i++) {
        const value = generate(next, 4, true);
        expect(decode(encode(value))).toStrictEqual(JSON.parse(JSON.stringify(value)));
      }
    });

    test("binary, dates, large integers and extensions come back as they were", () => {
      const next = random(2);
      for (let i = 0; i < 100; i++) {
        const value = generate(next, 3, false);
        const encoded = encode(value);
        const decoded = decode(encoded);
        expect(decoded).toStrictEqual(value);
        expect(toHex(encode(decoded))).toBe(toHex(encoded));
      }
    });

    test("with the garbage collector running", () => {
      const next = random(3);
      const values = Array.from({ length: 20 }, () => generate(next, 4, false));
      const encoded = encode(values);
      for (let i = 0; i < 4; i++) {
        const decoded = decode(encoded);
        Bun.gc(true);
        expect(decoded).toStrictEqual(values);
        expect(toHex(encode(decoded))).toBe(toHex(encoded));
      }
    });

    test("no bytes of random input crash the decoder", () => {
      const next = random(4);
      let decodedSome = 0;
      for (let i = 0; i < 1000; i++) {
        const input = new Uint8Array(1 + Math.floor(next() * 48)).map(() => Math.floor(next() * 256));
        const chunk = decodeChunk(input);
        expect(chunk.read).toBeLessThanOrEqual(input.length);
        expect(chunk.done).toBe(chunk.read === input.length);
        if (chunk.error !== null) expect(chunk.error).toBeInstanceOf(SyntaxError);
        decodedSome += chunk.values.length;
        try {
          decode(input);
        } catch (error) {
          expect(error).toBeInstanceOf(SyntaxError);
        }
      }
      expect(decodedSome).toBeGreaterThan(1000);
    });
  });
});
