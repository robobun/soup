import { msgpack } from "bun";
import { expectType } from "./utilities";

expectType(Bun.msgpack.encode({ a: 1 })).is<Uint8Array<ArrayBuffer>>();
expectType(msgpack.encode([1n, new Date(), new Map(), new Uint8Array(), null, undefined])).is<
  Uint8Array<ArrayBuffer>
>();

expectType(Bun.msgpack.decode(new Uint8Array())).is<unknown>();
expectType(msgpack.decode(new ArrayBuffer(1))).is<unknown>();
expectType(msgpack.decode(new SharedArrayBuffer(1))).is<unknown>();
expectType(msgpack.decode(new DataView(new ArrayBuffer(1)))).is<unknown>();
expectType(msgpack.decode(Buffer.from([0xc0]))).is<unknown>();

{
  const result = msgpack.decodeChunk(new Uint8Array(), 0, 10);
  expectType(result).is<msgpack.DecodeChunkResult>();
  expectType(result.values).is<unknown[]>();
  expectType(result.read).is<number>();
  expectType(result.done).is<boolean>();
  expectType(result.error).is<SyntaxError | null>();
  msgpack.decodeChunk(new Uint8Array());
  msgpack.decodeChunk(new Uint8Array(), 1);
}

{
  const extension = new msgpack.Extension(5, new Uint8Array([1]));
  expectType(extension).is<msgpack.Extension>();
  expectType(extension.type).is<number>();
  expectType(extension.data).is<Uint8Array>();
  new msgpack.Extension(5, new ArrayBuffer(1));
  new msgpack.Extension(5, new DataView(new ArrayBuffer(1)));
  msgpack.encode(extension);

  class Handle extends msgpack.Extension {
    constructor(id: number) {
      super(1, new Uint8Array([id]));
    }
  }
  expectType(new Handle(1).data).is<Uint8Array>();

  const decoded = msgpack.decode(msgpack.encode(extension));
  if (decoded instanceof msgpack.Extension) expectType(decoded).is<msgpack.Extension>();
}

// @ts-expect-error
msgpack.decode();
// @ts-expect-error
msgpack.decode("c0");
// @ts-expect-error
msgpack.decodeChunk(new Uint8Array(), "0");
// @ts-expect-error
new msgpack.Extension(5);
// @ts-expect-error
new msgpack.Extension("5", new Uint8Array());
// @ts-expect-error
new msgpack.Extension(5, "data");
