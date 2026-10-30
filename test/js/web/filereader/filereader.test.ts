import { describe, expect, jest, test } from "bun:test";
import { bunEnv, bunExe, isLinux, isWindows, tempDir } from "harness";
import { once } from "node:events";
import { join } from "node:path";
import { FileReader as UndiciFileReader } from "undici";

const eventTypes = ["loadstart", "progress", "load", "abort", "error", "loadend"] as const;
type EventType = (typeof eventTypes)[number];

type Step = {
  type: string;
  readyState: number;
  result: string | ArrayBuffer | null;
  lengthComputable: boolean;
  loaded: number;
  total: number;
};

// Every event of `reader`, with what the reader showed when the event was fired.
function record(reader: FileReader): Step[] {
  const steps: Step[] = [];
  for (const type of eventTypes) {
    reader.addEventListener(type, event => {
      steps.push({
        type: event.type,
        readyState: reader.readyState,
        result: reader.result,
        lengthComputable: event.lengthComputable,
        loaded: event.loaded,
        total: event.total,
      });
    });
  }
  return steps;
}

function nextEvent(reader: FileReader, type: EventType): Promise<ProgressEvent<FileReader>> {
  return new Promise(resolve => reader.addEventListener(type, resolve, { once: true }));
}

type ReadMethod = "readAsText" | "readAsArrayBuffer" | "readAsDataURL" | "readAsBinaryString";

// The reader after the `loadend` of one read.
async function read(blob: Blob, method: ReadMethod = "readAsText", encoding?: string): Promise<FileReader> {
  const reader = new FileReader();
  const ended = nextEvent(reader, "loadend");
  if (method === "readAsText") reader.readAsText(blob, encoding);
  else reader[method](blob);
  await ended;
  return reader;
}

function thrownBy(fn: () => void): any {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

// A read asks the blob for its stream(), so this blob decides what the chunks are.
class ChunkedBlob extends Blob {
  chunks: string[];
  cancelled = false;

  constructor(chunks: string[]) {
    super(chunks);
    this.chunks = chunks;
  }

  override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    const chunks = this.chunks.map(chunk => new TextEncoder().encode(chunk));
    return new ReadableStream({
      pull: controller => {
        const chunk = chunks.shift();
        if (chunk === undefined) controller.close();
        else controller.enqueue(chunk);
      },
      cancel: () => {
        this.cancelled = true;
      },
    });
  }
}

describe("FileReader", () => {
  test("is a global class with the three states", () => {
    expect(typeof FileReader).toBe("function");
    expect(FileReader.name).toBe("FileReader");
    expect(Object.getOwnPropertyDescriptor(globalThis, "FileReader")).toEqual({
      value: FileReader,
      writable: true,
      enumerable: false,
      configurable: true,
    });
    for (const target of [FileReader, FileReader.prototype]) {
      expect({ EMPTY: target.EMPTY, LOADING: target.LOADING, DONE: target.DONE }).toEqual({
        EMPTY: 0,
        LOADING: 1,
        DONE: 2,
      });
      expect(Object.getOwnPropertyDescriptor(target, "DONE")).toEqual({
        value: 2,
        writable: false,
        enumerable: true,
        configurable: false,
      });
    }
    // The members are enumerable, as the attributes and operations of WebIDL are.
    expect(Object.keys(FileReader.prototype).sort()).toEqual(
      [
        "DONE",
        "EMPTY",
        "LOADING",
        "abort",
        "error",
        "onabort",
        "onerror",
        "onload",
        "onloadend",
        "onloadstart",
        "onprogress",
        "readAsArrayBuffer",
        "readAsBinaryString",
        "readAsDataURL",
        "readAsText",
        "readyState",
        "result",
      ].sort(),
    );

    const reader = new FileReader();
    expect(reader).toBeInstanceOf(EventTarget);
    expect(Object.prototype.toString.call(reader)).toBe("[object FileReader]");
    expect({
      readyState: reader.readyState,
      result: reader.result,
      error: reader.error,
      handlers: eventTypes.map(type => reader[`on${type}`]),
    }).toEqual({
      readyState: FileReader.EMPTY,
      result: null,
      error: null,
      handlers: [null, null, null, null, null, null],
    });
    expect(Bun.inspect(reader)).toBe("FileReader {\n  readyState: 0,\n  result: null,\n  error: null,\n}");
    // @ts-expect-error a class cannot be called
    expect(() => FileReader()).toThrow(TypeError);
    expect(UndiciFileReader).toBe(FileReader);
  });

  test("readAsText() decodes UTF-8 by default", async () => {
    const reader = await read(new Blob(["héllo wörld ✓"]));
    expect({ result: reader.result, error: reader.error, readyState: reader.readyState }).toEqual({
      result: "héllo wörld ✓",
      error: null,
      readyState: FileReader.DONE,
    });
  });

  test("readAsText() takes the encoding from its argument, then from the type of the blob", async () => {
    const utf16le = new Uint8Array([0x68, 0x00, 0xe9, 0x00]); // "hé"
    const utf16be = new Uint8Array([0x00, 0x68, 0x00, 0xe9]);
    const latin1 = new Uint8Array([0x68, 0xe9]);
    const results = {
      label: (await read(new Blob([utf16le]), "readAsText", "utf-16le")).result,
      labelInAnyCase: (await read(new Blob([utf16be]), "readAsText", " UTF-16BE ")).result,
      charset: (await read(new Blob([latin1], { type: "text/plain;charset=windows-1252" }))).result,
      quotedCharset: (await read(new Blob([utf16le], { type: 'text/plain; charset="utf-16le"' }))).result,
      labelBeforeCharset: (
        await read(new Blob([utf16le], { type: "text/plain;charset=utf-8" }), "readAsText", "utf-16le")
      ).result,
      // A label that names no encoding is not an error.
      unknownLabel: (await read(new Blob(["plain"]), "readAsText", "no-such-encoding")).result,
      unknownLabelThenCharset: (
        await read(new Blob([utf16le], { type: "text/plain;charset=utf-16le" }), "readAsText", "no-such-encoding")
      ).result,
      unknownCharset: (await read(new Blob(["plain"], { type: "text/plain;charset=no-such-encoding" }))).result,
      // "TEST" is 54 45 53 54, which is two UTF-16LE code units.
      bytesOfAnotherEncoding: (await read(new Blob(["TEST"]), "readAsText", "UTF-16")).result,
    };
    expect(results).toEqual({
      label: "hé",
      labelInAnyCase: "hé",
      charset: "hé",
      quotedCharset: "hé",
      labelBeforeCharset: "hé",
      unknownLabel: "plain",
      unknownLabelThenCharset: "hé",
      unknownCharset: "plain",
      bytesOfAnotherEncoding: "\u4554\u5453",
    });
  });

  test("readAsText() lets a byte order mark choose the encoding", async () => {
    const results = {
      utf8: (await read(new Blob([new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0xc3, 0xa9])]), "readAsText", "utf-16le"))
        .result,
      utf16le: (await read(new Blob([new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0xe9, 0x00])]))).result,
      utf16be: (await read(new Blob([new Uint8Array([0xfe, 0xff, 0x00, 0x68, 0x00, 0xe9])]), "readAsText", "utf-8"))
        .result,
    };
    expect(results).toEqual({ utf8: "hé", utf16le: "hé", utf16be: "hé" });
    // The mark is not a part of the text.
    expect((await read(new Blob([new Uint8Array([0xef, 0xbb, 0xbf])]))).result).toBe("");
  });

  // These labels name the replacement encoding, which TextDecoder refuses. A read does not take
  // their bytes for text: https://encoding.spec.whatwg.org/#replacement
  test("readAsText() gives U+FFFD for the labels of the replacement encoding", async () => {
    const results = {
      label: (await read(new Blob(["abc"]), "readAsText", "iso-2022-kr")).result,
      labelInAnyCase: (await read(new Blob(["abc"]), "readAsText", " HZ-GB-2312\n")).result,
      name: (await read(new Blob(["abc"]), "readAsText", "replacement")).result,
      charset: (await read(new Blob(["abc"], { type: "text/x-test;charset=iso-2022-cn" }))).result,
      empty: (await read(new Blob([]), "readAsText", "csiso2022kr")).result,
      // A byte order mark wins over it too.
      mark: (await read(new Blob([new Uint8Array([0xef, 0xbb, 0xbf, 0x68])]), "readAsText", "iso-2022-cn-ext")).result,
    };
    expect(results).toEqual({
      label: "\ufffd",
      labelInAnyCase: "\ufffd",
      name: "\ufffd",
      charset: "\ufffd",
      empty: "",
      mark: "h",
    });
  });

  test("readAsArrayBuffer() gives a copy of the bytes", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]);
    const reader = await read(blob, "readAsArrayBuffer");
    expect(reader.result).toBeInstanceOf(ArrayBuffer);
    const bytes = new Uint8Array(reader.result as ArrayBuffer);
    expect([...bytes]).toEqual([1, 2, 3, 4, 5]);

    bytes.fill(9);
    expect([...(await blob.bytes())]).toEqual([1, 2, 3, 4, 5]);
    expect((await read(new Blob([]), "readAsArrayBuffer")).result).toEqual(new ArrayBuffer(0));

    // One part, which the stream may hand over without a copy.
    const single = new Blob([new Uint8Array([1, 2, 3])]);
    new Uint8Array((await read(single, "readAsArrayBuffer")).result as ArrayBuffer).fill(9);
    expect([...(await single.bytes())]).toEqual([1, 2, 3]);
  });

  test("readAsDataURL() uses the type of the blob", async () => {
    const results = {
      typed: (await read(new Blob(["TEST"], { type: "image/gif" }), "readAsDataURL")).result,
      withParameter: (await read(new Blob(["TEST"], { type: "text/x-test;charset=utf-16le" }), "readAsDataURL")).result,
      untyped: (await read(new Blob(["TEST"]), "readAsDataURL")).result,
      empty: (await read(new Blob([]), "readAsDataURL")).result,
      binary: (await read(new Blob([new Uint8Array([0xff, 0xfe, 0x00])], { type: "image/png" }), "readAsDataURL"))
        .result,
    };
    expect(results).toEqual({
      typed: "data:image/gif;base64,VEVTVA==",
      withParameter: "data:text/x-test;charset=utf-16le;base64,VEVTVA==",
      untyped: "data:application/octet-stream;base64,VEVTVA==",
      empty: "data:application/octet-stream;base64,",
      binary: "data:image/png;base64,//4A",
    });

    // The type is what `blob.type` says. Bun's Blob gives some text types a charset.
    const text = new Blob(["TEST"], { type: "text/plain" });
    expect((await read(text, "readAsDataURL")).result).toBe(`data:${text.type};base64,VEVTVA==`);
  });

  test("readAsBinaryString() gives one character for each byte", async () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    const reader = await read(new Blob([bytes]), "readAsBinaryString");
    const result = reader.result as string;
    expect(result).toHaveLength(256);
    expect(Array.from(result, c => c.charCodeAt(0))).toEqual([...bytes]);
  });

  test("a read fires loadstart, progress, load and loadend", async () => {
    const reader = new FileReader();
    const steps = record(reader);
    const ended = nextEvent(reader, "loadend");
    reader.readAsText(new Blob(["abc"]));
    // Nothing is fired before readAsText() returns.
    expect(steps).toEqual([]);
    expect({ readyState: reader.readyState, result: reader.result }).toEqual({
      readyState: FileReader.LOADING,
      result: null,
    });

    const last = await ended;
    expect(steps).toEqual([
      { type: "loadstart", readyState: 1, result: null, lengthComputable: true, loaded: 0, total: 3 },
      { type: "progress", readyState: 1, result: null, lengthComputable: true, loaded: 3, total: 3 },
      { type: "load", readyState: 2, result: "abc", lengthComputable: true, loaded: 3, total: 3 },
      { type: "loadend", readyState: 2, result: "abc", lengthComputable: true, loaded: 3, total: 3 },
    ]);
    expect(last).toBeInstanceOf(ProgressEvent);
    expect({
      target: last.target === reader,
      currentTarget: last.currentTarget,
      bubbles: last.bubbles,
      cancelable: last.cancelable,
    }).toEqual({ target: true, currentTarget: null, bubbles: false, cancelable: false });
  });

  test("an empty blob fires no progress", async () => {
    const reader = new FileReader();
    const steps = record(reader);
    const ended = nextEvent(reader, "loadend");
    reader.readAsText(new Blob([]));
    await ended;
    expect(steps).toEqual([
      { type: "loadstart", readyState: 1, result: null, lengthComputable: false, loaded: 0, total: 0 },
      { type: "load", readyState: 2, result: "", lengthComputable: false, loaded: 0, total: 0 },
      { type: "loadend", readyState: 2, result: "", lengthComputable: false, loaded: 0, total: 0 },
    ]);
  });

  // A browser runs the promise callbacks of a listener before it fires the next event. Code
  // that awaits one event and only then listens for the next one depends on it, and so does
  // `loadend`, which comes from the same task as `load`.
  describe("the promise callbacks of a listener run before the next event", () => {
    const waits: Array<[string, (reader: FileReader, type: EventType) => Promise<Event>]> = [
      ["a promise", nextEvent],
      ["an async function", async (reader, type) => await nextEvent(reader, type)],
      ["once() of node:events", async (reader, type) => (await once(reader, type))[0]],
    ];

    test.each(waits)("awaited through %s", async (_, wait) => {
      const reader = new FileReader();
      const seen: string[] = [];
      reader.readAsText(new Blob(["abc"]));
      for (const type of ["loadstart", "progress", "load", "loadend"] as const) {
        seen.push((await wait(reader, type)).type);
      }
      expect(seen).toEqual(["loadstart", "progress", "load", "loadend"]);
    });

    test.each(waits)("after an error, awaited through %s", async (_, wait) => {
      using dir = tempDir("filereader-missing", {});
      const reader = new FileReader();
      const seen: string[] = [];
      reader.readAsText(Bun.file(join(String(dir), "missing.txt")));
      for (const type of ["error", "loadend"] as const) {
        seen.push((await wait(reader, type)).type);
      }
      expect(seen).toEqual(["error", "loadend"]);
    });

    test("a read that the code after an awaited load starts takes the loadend of the first read", async () => {
      const reader = new FileReader();
      const steps = record(reader);
      reader.readAsText(new Blob(["first"]));
      await once(reader, "load");
      reader.readAsText(new Blob(["second"]));
      await nextEvent(reader, "loadend");
      expect(steps.map(step => `${step.type} ${step.result}`)).toEqual([
        "loadstart null",
        "progress null",
        "load first",
        "loadstart null",
        "progress null",
        "load second",
        "loadend second",
      ]);
    });
  });

  test("an event handler attribute is a listener that keeps its place", async () => {
    const reader = new FileReader();
    const calls: unknown[] = [];
    const run = async () => {
      calls.length = 0;
      const ended = nextEvent(reader, "loadend");
      reader.readAsText(new Blob(["abc"]));
      await ended;
      return [...calls];
    };

    const first = function (this: FileReader, event: ProgressEvent) {
      calls.push(["first", event.type, this === reader, event instanceof ProgressEvent]);
    };
    reader.onload = first;
    expect(reader.onload).toBe(first);
    reader.addEventListener("load", () => calls.push("listener"));
    expect(await run()).toEqual([["first", "load", true, true], "listener"]);

    // Another function is called where the first one was.
    const second = function (this: FileReader) {
      calls.push(["second", this === reader]);
    };
    reader.onload = second;
    expect(reader.onload).toBe(second);
    expect(await run()).toEqual([["second", true], "listener"]);

    // null takes the listener away, and the function after it is a new listener.
    reader.onload = null;
    expect(reader.onload).toBeNull();
    expect(await run()).toEqual(["listener"]);
    reader.onload = second;
    expect(await run()).toEqual(["listener", ["second", true]]);
  });

  test("an event handler attribute keeps an object and takes anything else for null", async () => {
    const reader = new FileReader();
    const object = {
      handleEvent() {
        throw new Error("an event handler attribute is not an EventListener object");
      },
    };
    // @ts-expect-error
    reader.onload = object;
    expect(reader.onload).toBe(object as any);
    const ended = nextEvent(reader, "loadend");
    reader.readAsText(new Blob(["abc"]));
    await ended;
    expect(reader.result).toBe("abc");

    reader.onloadstart = () => {};
    for (const value of ["not a function", 1, true, undefined, Symbol("handler")]) {
      // @ts-expect-error
      reader.onloadstart = value;
      expect(reader.onloadstart).toBeNull();
    }
  });

  test("abort() before a read changes nothing", () => {
    const reader = new FileReader();
    const steps = record(reader);
    reader.abort();
    expect({ readyState: reader.readyState, result: reader.result, error: reader.error, steps }).toEqual({
      readyState: FileReader.EMPTY,
      result: null,
      error: null,
      steps: [],
    });
  });

  test("abort() during a read fires abort and loadend before it returns", async () => {
    const reader = new FileReader();
    const steps = record(reader);
    reader.readAsText(new Blob(["abc"]));
    await nextEvent(reader, "progress");
    expect(reader.readyState).toBe(FileReader.LOADING);

    reader.abort();
    expect(steps.map(step => step.type)).toEqual(["loadstart", "progress", "abort", "loadend"]);
    expect(steps[2]).toEqual({
      type: "abort",
      readyState: 2,
      result: null,
      lengthComputable: true,
      loaded: 3,
      total: 3,
    });
    // The standard does not say so, and the browsers all set an AbortError.
    const error = reader.error!;
    expect(error).toBeInstanceOf(DOMException);
    expect({ readyState: reader.readyState, result: reader.result, name: error.name, code: error.code }).toEqual({
      readyState: FileReader.DONE,
      result: null,
      name: "AbortError",
      code: 20,
    });

    // What the aborted read had left to fire would come before the events of the next read.
    const ended = nextEvent(reader, "loadend");
    reader.readAsText(new Blob(["next"]));
    expect(reader.error).toBeNull();
    await ended;
    expect(steps.map(step => step.type)).toEqual([
      "loadstart",
      "progress",
      "abort",
      "loadend",
      "loadstart",
      "progress",
      "load",
      "loadend",
    ]);
    expect({ result: reader.result, error: reader.error }).toEqual({ result: "next", error: null });
  });

  test("abort() right after the read starts fires no loadstart", async () => {
    const reader = new FileReader();
    const steps = record(reader);
    reader.readAsText(new Blob(["abc"]));
    reader.abort();
    expect(steps.map(step => step.type)).toEqual(["abort", "loadend"]);

    const ended = nextEvent(reader, "loadend");
    reader.readAsText(new Blob(["next"]));
    await ended;
    expect(steps.map(step => step.type)).toEqual(["abort", "loadend", "loadstart", "progress", "load", "loadend"]);
  });

  test("abort() after a read clears the result", async () => {
    const reader = await read(new Blob(["abc"]));
    const steps = record(reader);
    expect(reader.result).toBe("abc");
    reader.abort();
    expect({ readyState: reader.readyState, result: reader.result, error: reader.error, steps }).toEqual({
      readyState: FileReader.DONE,
      result: null,
      error: null,
      steps: [],
    });
  });

  test("a second read during a read throws InvalidStateError", async () => {
    const reader = new FileReader();
    const ended = nextEvent(reader, "loadend");
    reader.readAsText(new Blob(["first"]));
    for (const method of ["readAsText", "readAsArrayBuffer", "readAsDataURL", "readAsBinaryString"] as const) {
      const error = thrownBy(() => reader[method](new Blob(["second"])));
      expect(error).toBeInstanceOf(DOMException);
      expect({ name: error.name, code: error.code }).toEqual({ name: "InvalidStateError", code: 11 });
    }
    await ended;
    // The first read is not disturbed, and the reader can be used again afterwards.
    expect(reader.result).toBe("first");
    const again = nextEvent(reader, "loadend");
    reader.readAsText(new Blob(["second"]));
    await again;
    expect(reader.result).toBe("second");
  });

  test("a read that a load listener starts takes the loadend of the first read", async () => {
    const reader = new FileReader();
    const steps = record(reader);
    reader.addEventListener("load", () => reader.readAsText(new Blob(["second"])), { once: true });
    const ended = nextEvent(reader, "loadend");
    reader.readAsText(new Blob(["first"]));
    await ended;
    expect(steps.map(step => `${step.type} ${step.result}`)).toEqual([
      "loadstart null",
      "progress null",
      "load first",
      "loadstart null",
      "progress null",
      "load second",
      "loadend second",
    ]);
  });

  test("the argument has to be a Blob", () => {
    const reader = new FileReader();
    for (const method of ["readAsText", "readAsArrayBuffer", "readAsDataURL", "readAsBinaryString"] as const) {
      for (const value of ["text", new Uint8Array(1), new ArrayBuffer(1), {}, null, undefined]) {
        // @ts-expect-error
        expect(() => reader[method](value)).toThrow(TypeError);
      }
      // @ts-expect-error
      expect(() => reader[method]()).toThrow(TypeError);
    }
    expect(reader.readyState).toBe(FileReader.EMPTY);
    expect(() => FileReader.prototype.readAsText.call({}, new Blob([]))).toThrow(TypeError);
    expect(() => Object.getOwnPropertyDescriptor(FileReader.prototype, "result")!.get!.call({})).toThrow(TypeError);
  });

  test("reads a File of a form", async () => {
    const form = new FormData();
    form.append("upload", new File(["name,size\na,1\n"], "report.csv", { type: "text/csv" }));
    const parsed = await new Response(form).formData();
    const file = parsed.get("upload") as File;
    expect(file).toBeInstanceOf(File);

    expect((await read(file)).result).toBe("name,size\na,1\n");
    expect((await read(file, "readAsDataURL")).result).toBe(
      `data:${file.type};base64,${Buffer.from("name,size\na,1\n").toString("base64")}`,
    );
  });

  test("progress says how far the read is, and the last one says all of it", async () => {
    const blob = new ChunkedBlob(["ab", "cd", "ef"]);
    const reader = new FileReader();
    const steps = record(reader);
    const ended = nextEvent(reader, "loadend");
    reader.readAsText(blob);
    await ended;

    expect(reader.result).toBe("abcdef");
    expect(steps.map(step => step.type).filter(type => type !== "progress")).toEqual(["loadstart", "load", "loadend"]);
    // One for the first chunk, one when 50 milliseconds have passed (seldom, here), one at the end.
    const progress = steps.filter(step => step.type === "progress").map(step => step.loaded);
    expect(progress[0]).toBe(2);
    expect(progress.at(-1)).toBe(6);
    expect(progress).toEqual(progress.length === 2 ? [2, 6] : [2, 4, 6]);
    expect(steps.every(step => step.lengthComputable && step.total === 6)).toBe(true);
  });

  test("abort() in a progress listener stops the read where it is", async () => {
    const blob = new ChunkedBlob(["ab", "cd", "ef"]);
    const reader = new FileReader();
    const steps = record(reader);
    reader.addEventListener("progress", () => reader.abort(), { once: true });
    const ended = nextEvent(reader, "loadend");
    reader.readAsText(blob);
    await ended;

    expect(steps.map(step => `${step.type} ${step.loaded}/${step.total}`)).toEqual([
      "loadstart 0/6",
      "progress 2/6",
      "abort 2/6",
      "loadend 2/6",
    ]);
    expect({ result: reader.result, cancelled: blob.cancelled }).toEqual({ result: null, cancelled: true });
  });

  test("reads a Bun.file() and reports how far it is", async () => {
    using dir = tempDir("filereader", {
      "hello.txt": "hello from a file",
    });
    const size = 3 * 1024 * 1024;
    const path = join(String(dir), "big.bin");
    const contents = new Uint8Array(size);
    for (let i = 0; i < size; i += 4096) contents[i] = i / 4096;
    await Bun.write(path, contents);

    expect((await read(Bun.file(join(String(dir), "hello.txt")))).result).toBe("hello from a file");

    const reader = new FileReader();
    const steps = record(reader);
    const ended = nextEvent(reader, "loadend");
    reader.readAsArrayBuffer(Bun.file(path));
    await ended;

    expect(new Uint8Array(reader.result as ArrayBuffer)).toEqual(contents);
    expect(steps.map(step => step.type).filter(type => type !== "progress")).toEqual(["loadstart", "load", "loadend"]);
    const progress = steps.filter(step => step.type === "progress");
    expect(progress.length).toBeGreaterThan(0);
    let previous = 0;
    for (const step of progress) {
      expect(step).toEqual({
        type: "progress",
        readyState: FileReader.LOADING,
        result: null,
        lengthComputable: true,
        loaded: expect.any(Number),
        total: size,
      });
      expect(step.loaded).toBeGreaterThan(previous);
      previous = step.loaded;
    }
    expect(previous).toBe(size);
    expect(steps.at(-1)).toEqual({
      type: "loadend",
      readyState: FileReader.DONE,
      result: reader.result,
      lengthComputable: true,
      loaded: size,
      total: size,
    });
  });

  // A file of /proc says that its size is 0.
  test.skipIf(!isLinux)("reads a file that does not know its size to its end", async () => {
    const file = Bun.file("/proc/self/status");
    const reader = new FileReader();
    const steps = record(reader);
    const ended = nextEvent(reader, "loadend");
    reader.readAsText(file);
    await ended;

    expect(reader.result).toStartWith("Name:");
    const load = steps.find(step => step.type === "load")!;
    expect({ ...load, loaded: load.loaded > 0 }).toEqual({
      type: "load",
      readyState: FileReader.DONE,
      result: reader.result,
      lengthComputable: false,
      loaded: true,
      total: 0,
    });
  });

  test("a file that does not exist fires error with a NotFoundError", async () => {
    using dir = tempDir("filereader-missing", {});
    const reader = new FileReader();
    const steps = record(reader);
    const ended = nextEvent(reader, "loadend");
    reader.readAsText(Bun.file(join(String(dir), "missing.txt")));
    await ended;

    // The first chunk never came, so there is no loadstart.
    expect(steps.map(step => step.type)).toEqual(["error", "loadend"]);
    const error = reader.error!;
    expect(error).toBeInstanceOf(DOMException);
    expect({
      name: error.name,
      code: error.code,
      cause: (error.cause as NodeJS.ErrnoException).code,
      readyState: reader.readyState,
      result: reader.result,
    }).toEqual({ name: "NotFoundError", code: 8, cause: "ENOENT", readyState: FileReader.DONE, result: null });

    // The next read clears the error.
    const again = nextEvent(reader, "loadend");
    reader.readAsText(new Blob(["ok"]));
    expect(reader.error).toBeNull();
    await again;
    expect({ result: reader.result, error: reader.error }).toEqual({ result: "ok", error: null });
  });

  // Opening a directory for reading is itself an error on Windows.
  test.skipIf(isWindows)("a blob that cannot be read fires error with a NotReadableError", async () => {
    using dir = tempDir("filereader-directory", {});
    const reader = new FileReader();
    const steps = record(reader);
    const ended = nextEvent(reader, "loadend");
    reader.readAsArrayBuffer(Bun.file(String(dir)));
    await ended;

    expect(steps.map(step => step.type)).toEqual(["error", "loadend"]);
    const error = reader.error!;
    expect(error).toBeInstanceOf(DOMException);
    expect({ name: error.name, cause: (error.cause as NodeJS.ErrnoException).code, result: reader.result }).toEqual({
      name: "NotReadableError",
      cause: "EISDIR",
      result: null,
    });
  });

  test("an S3 object that does not exist fires error with a NotFoundError", async () => {
    await using server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          `<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>`,
          { status: 404, headers: { "content-type": "application/xml" } },
        ),
    });
    const s3 = new Bun.S3Client({
      endpoint: `http://localhost:${server.port}`,
      accessKeyId: "test",
      secretAccessKey: "test",
      bucket: "bucket",
    });
    const reader = await read(s3.file("missing.txt"));
    const error = reader.error!;
    expect(error).toBeInstanceOf(DOMException);
    expect({ name: error.name, cause: (error.cause as { code?: string }).code, result: reader.result }).toEqual({
      name: "NotFoundError",
      cause: "NoSuchKey",
      result: null,
    });
  });

  test("what the blob throws for its size or its stream is the error of the read", async () => {
    const noSize = new Blob(["abc"]);
    Object.defineProperty(noSize, "size", {
      get() {
        throw new RangeError("the size is not known yet");
      },
    });
    const noStream = new Blob(["abc"]);
    noStream.stream = () => {
      throw new RangeError("there is no stream");
    };
    for (const [blob, message] of [
      [noSize, "the size is not known yet"],
      [noStream, "there is no stream"],
    ] as const) {
      const reader = new FileReader();
      const steps = record(reader);
      const ended = nextEvent(reader, "loadend");
      reader.readAsText(blob);
      // The call itself does not throw, and the reader is not left loading.
      await ended;
      const error = reader.error!;
      expect(error).toBeInstanceOf(DOMException);
      expect({
        steps: steps.map(step => step.type),
        name: error.name,
        message: error.message,
        cause: error.cause,
        readyState: reader.readyState,
      }).toEqual({
        steps: ["error", "loadend"],
        name: "NotReadableError",
        message,
        cause: expect.any(RangeError),
        readyState: FileReader.DONE,
      });
      expect((await read(new Blob(["next"]))).result).toBe("next");
    }
  });

  // The events are fired from the event loop, not from timers that a test can stop. The clock
  // of a test does not move, so no progress is due but the first one and the last one.
  test("reads while the timers of a test are fake", async () => {
    jest.useFakeTimers();
    try {
      const reader = new FileReader();
      const steps = record(reader);
      const ended = nextEvent(reader, "loadend");
      reader.readAsText(new ChunkedBlob(["ab", "cd", "ef"]));
      await ended;
      expect(steps.map(step => `${step.type} ${step.loaded}`)).toEqual([
        "loadstart 0",
        "progress 2",
        "progress 6",
        "load 6",
        "loadend 6",
      ]);
      expect(reader.result).toBe("abcdef");
    } finally {
      jest.useRealTimers();
    }
  });

  test.concurrent("a pending read keeps the process alive until loadend", async () => {
    await using proc = Bun.spawn({
      cmd: [
        bunExe(),
        "-e",
        `
          const reader = new FileReader();
          reader.onloadend = event => console.log(event.type, reader.result, event instanceof ProgressEvent);
          reader.readAsText(Bun.stdin);
          console.log("reading");
        `,
      ],
      env: bunEnv,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    // Nothing but the read is pending in the child while it waits for its input.
    const stdout = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let output = "";
    while (!output.includes("reading\n")) {
      const { done, value } = await stdout.read();
      if (done) break;
      output += decoder.decode(value, { stream: true });
    }
    proc.stdin.write("kept alive");
    await proc.stdin.end();
    while (true) {
      const { done, value } = await stdout.read();
      if (done) break;
      output += decoder.decode(value, { stream: true });
    }
    const [stderr, exitCode] = await Promise.all([proc.stderr.text(), proc.exited]);
    expect({ output, stderr }).toEqual({ output: "reading\nloadend kept alive true\n", stderr: "" });
    expect(exitCode).toBe(0);
  });

  test.concurrent("the globals can be replaced", async () => {
    await using proc = Bun.spawn({
      cmd: [
        bunExe(),
        "-e",
        `
          const original = [FileReader, ProgressEvent];
          globalThis.FileReader = class Mine {};
          globalThis.ProgressEvent = 1;
          console.log(FileReader.name, ProgressEvent);
          // A reader made before still fires its own events.
          const reader = new original[0]();
          reader.onload = event => console.log(event instanceof original[1], reader.result);
          reader.readAsText(new Blob(["still works"]));
          console.log(delete globalThis.FileReader, typeof FileReader);
        `,
      ],
      env: bunEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect({ stdout, stderr }).toEqual({ stdout: "Mine 1\ntrue undefined\ntrue still works\n", stderr: "" });
    expect(exitCode).toBe(0);
  });

  // The module of the two classes loads when a program first reads one of them. happy-dom's
  // GlobalRegistrator reads every global while its own Event is in place, and a fake clock
  // replaces the timers: neither may decide what a FileReader is made of.
  test.concurrent("the classes do not depend on the globals that are there when they are first read", async () => {
    await using proc = Bun.spawn({
      cmd: [
        bunExe(),
        "-e",
        `
          const real = { Event, EventTarget, DOMException, setImmediate, setTimeout, queueMicrotask };
          const never = () => {};
          Object.assign(globalThis, {
            Event: class Event {},
            EventTarget: class EventTarget {},
            DOMException: class DOMException {},
            setImmediate: never,
            setTimeout: never,
            queueMicrotask: never,
          });
          const stream = Blob.prototype.stream;
          Blob.prototype.stream = function () { throw new Error("a read asks the blob for its stream, and this one throws"); };

          const { FileReader, ProgressEvent } = globalThis;
          console.log(Object.getPrototypeOf(ProgressEvent) === real.Event, Object.getPrototypeOf(FileReader) === real.EventTarget);

          // A read while the replacements are in place, and one after they are gone.
          const during = new FileReader();
          during.onloadend = event => {
            console.log("during:", event.type, during.error.name, during.error instanceof real.DOMException, event instanceof real.Event);
            Object.assign(globalThis, real);
            Blob.prototype.stream = stream;
            const after = new FileReader();
            after.onloadend = event => console.log("after:", event.type, after.result, after.error);
            after.readAsText(new Blob(["abc"]));
          };
          during.readAsText(new Blob(["abc"]));
        `,
      ],
      env: bunEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect({ stdout, stderr }).toEqual({
      stdout: "true true\nduring: loadend NotReadableError true true\nafter: loadend abc null\n",
      stderr: "",
    });
    expect(exitCode).toBe(0);
  });

  test.concurrent("undici loads in a program that has replaced Event and EventTarget", async () => {
    await using proc = Bun.spawn({
      cmd: [
        bunExe(),
        "-e",
        `
          globalThis.Event = 42;
          delete globalThis.EventTarget;
          const { FileReader } = require("undici");
          const reader = new FileReader();
          reader.onload = () => console.log(reader.result);
          reader.readAsText(new Blob(["from undici"]));
        `,
      ],
      env: bunEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect({ stdout, stderr }).toEqual({ stdout: "from undici\n", stderr: "" });
    expect(exitCode).toBe(0);
  });
});

describe("ProgressEvent", () => {
  test("is a global Event class", () => {
    expect(typeof ProgressEvent).toBe("function");
    expect(ProgressEvent.name).toBe("ProgressEvent");
    expect(Object.getOwnPropertyDescriptor(globalThis, "ProgressEvent")).toEqual({
      value: ProgressEvent,
      writable: true,
      enumerable: false,
      configurable: true,
    });
    expect(Object.getPrototypeOf(ProgressEvent)).toBe(Event);
    expect(Object.keys(ProgressEvent.prototype)).toEqual(["lengthComputable", "loaded", "total"]);

    const event = new ProgressEvent("test");
    expect(event).toBeInstanceOf(Event);
    expect(Object.prototype.toString.call(event)).toBe("[object ProgressEvent]");
    expect({
      type: event.type,
      target: event.target,
      bubbles: event.bubbles,
      cancelable: event.cancelable,
      defaultPrevented: event.defaultPrevented,
      isTrusted: event.isTrusted,
      lengthComputable: event.lengthComputable,
      loaded: event.loaded,
      total: event.total,
    }).toEqual({
      type: "test",
      target: null,
      bubbles: false,
      cancelable: false,
      defaultPrevented: false,
      isTrusted: false,
      lengthComputable: false,
      loaded: 0,
      total: 0,
    });
    expect(Bun.inspect(event)).toBe(
      'ProgressEvent {\n  type: "test",\n  lengthComputable: false,\n  loaded: 0,\n  total: 0,\n}',
    );
  });

  test("takes its members from the init", () => {
    const event = new ProgressEvent("progress", {
      bubbles: true,
      cancelable: true,
      lengthComputable: true,
      loaded: 12.5,
      total: 100,
    });
    expect({
      type: event.type,
      bubbles: event.bubbles,
      cancelable: event.cancelable,
      lengthComputable: event.lengthComputable,
      loaded: event.loaded,
      total: event.total,
    }).toEqual({ type: "progress", bubbles: true, cancelable: true, lengthComputable: true, loaded: 12.5, total: 100 });

    // The members are converted as WebIDL converts a boolean and a double.
    // @ts-expect-error
    const converted = new ProgressEvent("x", { lengthComputable: 1, loaded: "7", total: { valueOf: () => 9 } });
    expect({ lengthComputable: converted.lengthComputable, loaded: converted.loaded, total: converted.total }).toEqual({
      lengthComputable: true,
      loaded: 7,
      total: 9,
    });
    const fromNull = new ProgressEvent("x", null as any);
    expect({ loaded: fromNull.loaded, total: fromNull.total }).toEqual({ loaded: 0, total: 0 });
    // `total` is what the init says, whatever `lengthComputable` is.
    const withoutLength = new ProgressEvent("x", { total: 5 });
    expect({ lengthComputable: withoutLength.lengthComputable, total: withoutLength.total }).toEqual({
      lengthComputable: false,
      total: 5,
    });

    // The members are read-only.
    // @ts-expect-error
    expect(() => (event.loaded = 1)).toThrow(TypeError);
    expect(event.loaded).toBe(12.5);
  });

  test("rejects what cannot be a ProgressEvent", () => {
    // @ts-expect-error
    expect(() => new ProgressEvent()).toThrow(TypeError);
    // @ts-expect-error
    expect(() => ProgressEvent("x")).toThrow(TypeError);
    for (const value of [NaN, Infinity, -Infinity, "not a number"]) {
      // @ts-expect-error
      expect(() => new ProgressEvent("x", { loaded: value })).toThrow(TypeError);
      // @ts-expect-error
      expect(() => new ProgressEvent("x", { total: value })).toThrow(TypeError);
    }
  });

  test("is dispatched like any other event", () => {
    const target = new EventTarget();
    const seen: unknown[] = [];
    target.addEventListener("progress", event => {
      const progress = event as ProgressEvent;
      seen.push(progress.loaded / progress.total, progress.target === target);
    });
    expect(target.dispatchEvent(new ProgressEvent("progress", { lengthComputable: true, loaded: 1, total: 4 }))).toBe(
      true,
    );
    expect(seen).toEqual([0.25, true]);
  });
});
