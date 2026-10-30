// `FileReader` and the `ProgressEvent` it fires.
// https://w3c.github.io/FileAPI/#APIASynch
// https://xhr.spec.whatwg.org/#interface-progressevent

// This module loads when a program first reads one of the two globals, and that can be while a
// test library has its own `Event`, `EventTarget` or timers on the global object (happy-dom's
// registrator, a fake clock). Classes made from those do not work with the native ones once the
// library has put the globals back, and a read that was queued into a fake clock never ends.
// So native code hands over the ones of the realm.
const {
  0: Event,
  1: EventTarget,
  2: DOMException,
  3: queueTask,
} = $cpp("FileReaderBinding.cpp", "createFileReaderBinding") as [
  typeof globalThis.Event,
  typeof globalThis.EventTarget,
  typeof globalThis.DOMException,
  (task: () => void) => unknown,
];
// Runs the promise callbacks and the ticks that wait, as the event loop does between two tasks.
const runMicrotasks: () => void = $bindgen("hw_exports.bind.ts", "drainMicrotasks");

const EMPTY = 0;
const LOADING = 1;
const DONE = 2;

// What a read gives: https://w3c.github.io/FileAPI/#blob-package-data
const AS_ARRAY_BUFFER = 0;
const AS_BINARY_STRING = 1;
const AS_TEXT = 2;
const AS_DATA_URL = 3;
type ReadAs = typeof AS_ARRAY_BUFFER | typeof AS_BINARY_STRING | typeof AS_TEXT | typeof AS_DATA_URL;

// A `progress` event is fired for the first chunk, then at most this often, and once more when
// the last chunk has arrived and the event before it did not say so.
const PROGRESS_INTERVAL_MS = 50;

// `TextDecoder` refuses the labels of the replacement encoding. A read decodes them to U+FFFD:
// https://encoding.spec.whatwg.org/#replacement
const REPLACEMENT_LABELS = [
  "replacement",
  "csiso2022kr",
  "hz-gb-2312",
  "iso-2022-cn",
  "iso-2022-cn-ext",
  "iso-2022-kr",
];

const kInspect = Symbol.for("nodejs.util.inspect.custom");

type EventHandler = ((this: FileReader, event: ProgressEvent) => any) | null;
type EventType = "loadstart" | "progress" | "load" | "abort" | "error" | "loadend";

/** The value of an event handler attribute, and the listener that calls it. */
interface Handler {
  value: object;
  listener: (event: Event) => void;
}

/** One call of a `readAs` method. `abort()` and the end of the read forget it, and what it queued then does nothing. */
interface Read {
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  /** Bytes read so far. */
  loaded: number;
  /** `blob.size`, or 0 when the blob does not know its size. */
  total: number;
}

// WebIDL `double`.
function toDouble(value: unknown, member: string): number {
  if (value === undefined) return 0;
  const number = +(value as any);
  if (number !== number || number === Infinity || number === -Infinity) {
    throw new TypeError(`ProgressEventInit.${member} must be a finite number`);
  }
  return number;
}

class ProgressEvent extends Event {
  #lengthComputable: boolean;
  #loaded: number;
  #total: number;

  constructor(type: string, eventInitDict: Bun.ProgressEventInit | undefined = undefined) {
    if (arguments.length === 0) throw new TypeError("Not enough arguments");
    // `Event` throws for an init that is not an object.
    super(type, eventInitDict);
    let lengthComputable = false;
    let loaded = 0;
    let total = 0;
    if (eventInitDict !== undefined && eventInitDict !== null) {
      lengthComputable = !!eventInitDict.lengthComputable;
      loaded = toDouble(eventInitDict.loaded, "loaded");
      total = toDouble(eventInitDict.total, "total");
    }
    this.#lengthComputable = lengthComputable;
    this.#loaded = loaded;
    this.#total = total;
  }

  get lengthComputable(): boolean {
    return this.#lengthComputable;
  }

  get loaded(): number {
    return this.#loaded;
  }

  get total(): number {
    return this.#total;
  }

  // The members are getters of the prototype over private fields, which `console.log` does not print.
  [kInspect](): object {
    return {
      __proto__: { constructor: ProgressEvent },
      type: this.type,
      lengthComputable: this.#lengthComputable,
      loaded: this.#loaded,
      total: this.#total,
    };
  }
}

// The encoding that `label` names, or undefined: https://encoding.spec.whatwg.org/#concept-encoding-get
function encodingOf(label: string): string | undefined {
  try {
    return new TextDecoder(label).encoding;
  } catch {
    const name = label.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "").toLowerCase();
    return REPLACEMENT_LABELS.includes(name) ? "replacement" : undefined;
  }
}

// The `charset` parameter of a MIME type, without its quotes.
function charsetOf(mimeType: string): string | undefined {
  const match = /;\s*charset\s*=\s*(?:"((?:[^"\\]|\\.)*)"?|([^;]*))/i.exec(mimeType);
  if (match === null) return undefined;
  const quoted = match[1];
  if (quoted !== undefined) return quoted.replace(/\\(.)/g, "$1");
  return match[2].trim();
}

// https://w3c.github.io/FileAPI/#blob-package-data, "Text"
function decodeText(bytes: Uint8Array, label: string | undefined, mimeType: string): string {
  let encoding = label === undefined ? undefined : encodingOf(label);
  if (encoding === undefined && mimeType !== "") {
    const charset = charsetOf(mimeType);
    if (charset !== undefined) encoding = encodingOf(charset);
  }
  encoding ??= "utf-8";
  // A byte order mark wins over the encoding: https://encoding.spec.whatwg.org/#decode
  const length = bytes.byteLength;
  if (length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    encoding = "utf-8";
  } else if (length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = "utf-16be";
  } else if (length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = "utf-16le";
  } else if (encoding === "replacement") {
    return length === 0 ? "" : "\ufffd";
  }
  // The decoder removes the mark of its own encoding.
  return new TextDecoder(encoding).decode(bytes);
}

// https://w3c.github.io/FileAPI/#blob-package-data
function packageData(
  chunks: Uint8Array[],
  length: number,
  readAs: ReadAs,
  mimeType: string,
  encoding: string | undefined,
): string | ArrayBuffer {
  let bytes: Uint8Array;
  if (chunks.length === 1) {
    bytes = chunks[0];
  } else {
    bytes = new Uint8Array(length);
    for (let i = 0, offset = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  }
  switch (readAs) {
    case AS_ARRAY_BUFFER: {
      const buffer = bytes.buffer as ArrayBuffer;
      // A chunk can be a part of a larger buffer.
      if (bytes.byteOffset === 0 && bytes.byteLength === buffer.byteLength) return buffer;
      return buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
    case AS_TEXT:
      return decodeText(bytes, encoding, mimeType);
    case AS_BINARY_STRING:
      return new $Buffer(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
    case AS_DATA_URL: {
      const base64 = new $Buffer(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength).toString("base64");
      return `data:${mimeType === "" ? "application/octet-stream" : mimeType};base64,${base64}`;
    }
  }
}

// `FileReader.error` is a DOMException. What the stream or the decoder threw is its `cause`.
function toDOMException(error: unknown): DOMException {
  if (error instanceof DOMException) return error;
  const code = (error as { code?: unknown } | null)?.code;
  // `ENOENT` from the file system, `NoSuchKey` from S3.
  const name = code === "ENOENT" || code === "NoSuchKey" ? "NotFoundError" : "NotReadableError";
  const message = (error as { message?: unknown } | null)?.message;
  const exception = new DOMException(typeof message === "string" ? message : "The blob could not be read", name);
  Object.defineProperty(exception, "cause", { value: error, writable: true, enumerable: false, configurable: true });
  return exception;
}

class FileReader extends EventTarget {
  #readyState: number = EMPTY;
  #result: string | ArrayBuffer | null = null;
  #error: DOMException | null = null;
  #read: Read | null = null;
  #handlers: Record<string, Handler | undefined> = { __proto__: null } as any;

  constructor() {
    super();
  }

  get readyState(): number {
    return this.#readyState;
  }

  get result(): string | ArrayBuffer | null {
    return this.#result;
  }

  get error(): DOMException | null {
    return this.#error;
  }

  readAsArrayBuffer(blob: Blob): void {
    if (arguments.length === 0) throw new TypeError("Not enough arguments");
    this.#start("readAsArrayBuffer", blob, AS_ARRAY_BUFFER, undefined);
  }

  readAsBinaryString(blob: Blob): void {
    if (arguments.length === 0) throw new TypeError("Not enough arguments");
    this.#start("readAsBinaryString", blob, AS_BINARY_STRING, undefined);
  }

  readAsText(blob: Blob, encoding: string | undefined = undefined): void {
    if (arguments.length === 0) throw new TypeError("Not enough arguments");
    this.#start("readAsText", blob, AS_TEXT, encoding);
  }

  readAsDataURL(blob: Blob): void {
    if (arguments.length === 0) throw new TypeError("Not enough arguments");
    this.#start("readAsDataURL", blob, AS_DATA_URL, undefined);
  }

  abort(): void {
    const read = this.#read;
    this.#result = null;
    if (this.#readyState !== LOADING || read === null) return;
    this.#readyState = DONE;
    // What the read has queued finds that it is no longer the current read.
    this.#read = null;
    // The standard leaves `error` alone here. Chrome, Firefox and Safari set it.
    this.#error = new DOMException("The operation was aborted.", "AbortError");
    read.reader?.cancel().catch(() => {});
    this.#fire("abort", read.loaded, read.total);
    // A listener of `abort` may have started the next read, which gets a `loadend` of its own.
    if (this.#readyState !== LOADING) this.#fire("loadend", read.loaded, read.total);
  }

  get onloadstart(): EventHandler {
    return this.#handler("loadstart");
  }
  set onloadstart(value: unknown) {
    this.#setHandler("loadstart", value);
  }

  get onprogress(): EventHandler {
    return this.#handler("progress");
  }
  set onprogress(value: unknown) {
    this.#setHandler("progress", value);
  }

  get onload(): EventHandler {
    return this.#handler("load");
  }
  set onload(value: unknown) {
    this.#setHandler("load", value);
  }

  get onabort(): EventHandler {
    return this.#handler("abort");
  }
  set onabort(value: unknown) {
    this.#setHandler("abort", value);
  }

  get onerror(): EventHandler {
    return this.#handler("error");
  }
  set onerror(value: unknown) {
    this.#setHandler("error", value);
  }

  get onloadend(): EventHandler {
    return this.#handler("loadend");
  }
  set onloadend(value: unknown) {
    this.#setHandler("loadend", value);
  }

  // The private fields are invisible to `console.log`; print the public state instead. The
  // prototype only carries the name: `FileReader.prototype` itself would run this again.
  [kInspect](): object {
    return {
      __proto__: { constructor: FileReader },
      readyState: this.#readyState,
      result: this.#result,
      error: this.#error,
    };
  }

  #handler(type: EventType): EventHandler {
    return (this.#handlers[type]?.value ?? null) as EventHandler;
  }

  // https://html.spec.whatwg.org/multipage/webappapis.html#event-handler-attributes
  #setHandler(type: EventType, value: unknown): void {
    const handlers = this.#handlers;
    const handler = handlers[type];
    // A value that is not an object is null, and null takes the listener away: the next value
    // is called after the listeners that were added in between.
    if (!$isObject(value)) {
      if (handler !== undefined) {
        handlers[type] = undefined;
        super.removeEventListener(type, handler.listener);
      }
      return;
    }
    // Another value takes the place that the first one has among the listeners.
    if (handler !== undefined) {
      handler.value = value;
      return;
    }
    const added: Handler = {
      value,
      // An object that is not a function is kept, and nothing calls it.
      listener: event => {
        const current = added.value;
        if ($isCallable(current)) (current as NonNullable<EventHandler>).$call(this, event as ProgressEvent);
      },
    };
    handlers[type] = added;
    super.addEventListener(type, added.listener);
  }

  // `super`: a subclass or a property of the reader named `dispatchEvent` is not asked.
  #fire(type: EventType, loaded: number, total: number): void {
    // A file can grow after the blob was made for it.
    const length = total > 0 && loaded > total ? loaded : total;
    const init = { __proto__: null, lengthComputable: length > 0, loaded, total: length };
    super.dispatchEvent(new ProgressEvent(type, init as Bun.ProgressEventInit));
  }

  // "Queue a task to fire a progress event", and wait for it: the read goes on when the listeners
  // of this event have run, so `progress` says how far the read is, and an `abort()` in a
  // listener stops it there.
  #fireLater(read: Read, type: EventType, loaded: number): Promise<void> {
    return new $Promise<void>(resolve => {
      queueTask(() => {
        if (this.#read === read) this.#fire(type, loaded, read.total);
        resolve();
      });
    });
  }

  // https://w3c.github.io/FileAPI/#readOperation
  #start(method: string, blob: Blob, readAs: ReadAs, encoding: unknown): void {
    if (!$inheritsBlob(blob)) {
      throw new TypeError(`Argument 1 ('blob') to FileReader.${method} must be an instance of Blob`);
    }
    const label = encoding === undefined ? undefined : `${encoding}`;
    if (this.#readyState === LOADING) {
      throw new DOMException(
        `FileReader.${method} cannot start a read while another read is in progress`,
        "InvalidStateError",
      );
    }
    this.#readyState = LOADING;
    this.#result = null;
    this.#error = null;

    const read: Read = { reader: null, loaded: 0, total: 0 };
    this.#read = read;
    this.#run(read, blob, readAs, label);
  }

  async #run(read: Read, blob: Blob, readAs: ReadAs, encoding: string | undefined): Promise<void> {
    const chunks: Uint8Array[] = [];
    try {
      // The stream first: a `Bun.file()` that was asked for its size reads no further than that,
      // and a file that does not know its size (a pipe, a file of /proc) says 0.
      const stream: ReadableStream<Uint8Array> = blob.stream();
      const size = blob.size;
      if (size > 0 && size !== Infinity) read.total = size;
      const reader = stream.getReader();
      read.reader = reader;

      let isFirstChunk = true;
      let lastProgress = -Infinity;
      // The `loaded` of the last `progress` event.
      let reported = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (this.#read !== read) return;
        if (isFirstChunk) {
          isFirstChunk = false;
          await this.#fireLater(read, "loadstart", 0);
          if (this.#read !== read) return;
        }
        if (done) break;
        chunks.push(value);
        read.loaded += value.byteLength;
        const now = Bun.nanoseconds() / 1e6;
        if (now - lastProgress >= PROGRESS_INTERVAL_MS) {
          lastProgress = now;
          reported = read.loaded;
          await this.#fireLater(read, "progress", reported);
          if (this.#read !== read) return;
        }
      }
      if (reported !== read.loaded) {
        await this.#fireLater(read, "progress", read.loaded);
        if (this.#read !== read) return;
      }
    } catch (error) {
      if (this.#read !== read) return;
      queueTask(() => {
        if (this.#read === read) this.#finish(read, null, toDOMException(error));
      });
      return;
    }
    queueTask(() => {
      if (this.#read !== read) return;
      let result: string | ArrayBuffer | null = null;
      let error: DOMException | null = null;
      try {
        result = packageData(chunks, read.loaded, readAs, blob.type, encoding);
      } catch (thrown) {
        error = toDOMException(thrown);
      }
      this.#finish(read, result, error);
    });
  }

  #finish(read: Read, result: string | ArrayBuffer | null, error: DOMException | null): void {
    this.#readyState = DONE;
    this.#read = null;
    const { loaded, total } = read;
    if (error !== null) {
      this.#error = error;
      this.#fire("error", loaded, total);
    } else {
      this.#result = result;
      this.#fire("load", loaded, total);
    }
    // `loadend` is fired from the same task. A browser runs the promise callbacks of the
    // listeners first, so code that awaits `load` can listen for `loadend`, or start the next
    // read, which then gets a `loadend` of its own and this one gets none.
    runMicrotasks();
    if (this.#readyState !== LOADING) this.#fire("loadend", loaded, total);
  }
}

// WebIDL attributes and operations are enumerable. Class members are not.
function makeEnumerable(prototype: object, names: string[]): void {
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name)!;
    descriptor.enumerable = true;
    Object.defineProperty(prototype, name, descriptor);
  }
}
makeEnumerable(ProgressEvent.prototype, ["lengthComputable", "loaded", "total"]);
makeEnumerable(FileReader.prototype, [
  "readAsArrayBuffer",
  "readAsBinaryString",
  "readAsText",
  "readAsDataURL",
  "abort",
  "readyState",
  "result",
  "error",
  "onloadstart",
  "onprogress",
  "onload",
  "onabort",
  "onerror",
  "onloadend",
]);

function setToStringTag(prototype: object, name: string): void {
  Object.defineProperty(prototype, Symbol.toStringTag, {
    value: name,
    writable: false,
    enumerable: false,
    configurable: true,
  });
}
setToStringTag(FileReader.prototype, "FileReader");
setToStringTag(ProgressEvent.prototype, "ProgressEvent");

function defineStates(target: object): void {
  Object.defineProperties(target, {
    EMPTY: { value: EMPTY, writable: false, enumerable: true, configurable: false },
    LOADING: { value: LOADING, writable: false, enumerable: true, configurable: false },
    DONE: { value: DONE, writable: false, enumerable: true, configurable: false },
  });
}
defineStates(FileReader);
defineStates(FileReader.prototype);

export default { FileReader, ProgressEvent };
