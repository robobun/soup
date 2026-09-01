// Server-sent events client.
// https://html.spec.whatwg.org/multipage/server-sent-events.html

const nativeFetch = Bun.fetch;

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

// The spec leaves the default reconnection time to the user agent. Browsers and Node use 3 seconds.
const DEFAULT_RECONNECTION_TIME = 3000;
// `setTimeout` wraps around above this.
const MAX_RECONNECTION_TIME = 2 ** 31 - 1;

const kInspect = Symbol.for("nodejs.util.inspect.custom");

type EventHandler = ((this: EventSource, event: Event) => any) | null;

function isEventStreamMimeType(contentType: string | null): boolean {
  if (contentType === null) return false;
  const semicolon = contentType.indexOf(";");
  const essence = semicolon === -1 ? contentType : contentType.slice(0, semicolon);
  return essence.trim().toLowerCase() === "text/event-stream";
}

function isASCIIDigits(value: string): boolean {
  if (value.length === 0) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x30 || code > 0x39) return false;
  }
  return true;
}

class EventSource extends EventTarget {
  #url: string;
  #withCredentials: boolean;
  #headers: Headers | null;
  #readyState: number = CONNECTING;

  // Kept across reconnections: the "last event ID string" and the "reconnection time" of the spec.
  #lastEventId = "";
  #reconnectionTime = DEFAULT_RECONNECTION_TIME;

  // Owned by the current connection attempt. A callback whose controller is no longer the
  // current one belongs to a connection that `close()` or a reconnection has ended.
  #controller: AbortController | null = null;
  #reconnectTimer: Timer | null = null;

  // Parser state of the current event stream.
  #origin = "";
  #dataBuffer = "";
  #eventTypeBuffer = "";
  #lastEventIdBuffer = "";
  #pendingLine = "";
  #skipNextLineFeed = false;

  #onopen: EventHandler = null;
  #onmessage: EventHandler = null;
  #onerror: EventHandler = null;

  constructor(url: string | URL, eventSourceInitDict: EventSourceInit | undefined = undefined) {
    super();
    if (arguments.length === 0) {
      throw new TypeError("Not enough arguments");
    }

    let parsed: URL;
    try {
      parsed = new URL(String(url));
    } catch {
      throw new DOMException(`Cannot open an EventSource to "${url}": invalid URL`, "SyntaxError");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new DOMException(`Cannot open an EventSource to "${url}": the URL must use http: or https:`, "SyntaxError");
    }

    let withCredentials = false;
    let headers: Headers | null = null;
    if (eventSourceInitDict !== undefined && eventSourceInitDict !== null) {
      if (typeof eventSourceInitDict !== "object" && typeof eventSourceInitDict !== "function") {
        throw new TypeError("EventSource options must be an object");
      }
      withCredentials = !!eventSourceInitDict.withCredentials;
      if (eventSourceInitDict.headers !== undefined) {
        headers = new Headers(eventSourceInitDict.headers);
      }
    }

    this.#url = parsed.href;
    this.#withCredentials = withCredentials;
    this.#headers = headers;
    this.#connect();
  }

  get url(): string {
    return this.#url;
  }

  get withCredentials(): boolean {
    return this.#withCredentials;
  }

  get readyState(): number {
    return this.#readyState;
  }

  get onopen(): EventHandler {
    return this.#onopen;
  }
  set onopen(value: unknown) {
    this.#onopen = this.#replaceEventHandler("open", this.#onopen, value);
  }

  get onmessage(): EventHandler {
    return this.#onmessage;
  }
  set onmessage(value: unknown) {
    this.#onmessage = this.#replaceEventHandler("message", this.#onmessage, value);
  }

  get onerror(): EventHandler {
    return this.#onerror;
  }
  set onerror(value: unknown) {
    this.#onerror = this.#replaceEventHandler("error", this.#onerror, value);
  }

  close(): void {
    if (this.#readyState === CLOSED) return;
    this.#readyState = CLOSED;
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    const controller = this.#controller;
    this.#controller = null;
    controller?.abort();
  }

  // The private fields are invisible to `console.log`; print the public state instead. The
  // prototype only carries the name: `EventSource.prototype` itself would run this again.
  [kInspect](): object {
    return {
      __proto__: { constructor: EventSource },
      url: this.#url,
      readyState: this.#readyState,
      withCredentials: this.#withCredentials,
    };
  }

  #replaceEventHandler(type: string, current: EventHandler, value: unknown): EventHandler {
    if (current !== null) {
      this.removeEventListener(type, current);
    }
    if (!$isCallable(value)) {
      return null;
    }
    this.addEventListener(type, value as EventListener);
    return value as EventHandler;
  }

  #connect(): void {
    const controller = new AbortController();
    this.#controller = controller;

    const headers = new Headers(this.#headers ?? undefined);
    headers.set("accept", "text/event-stream");
    if (this.#lastEventId !== "") {
      headers.set("last-event-id", this.#lastEventId);
    }

    nativeFetch(this.#url, { method: "GET", headers, redirect: "follow", signal: controller.signal }).then(
      response => this.#onResponse(controller, response),
      () => this.#onNetworkError(controller),
    );
  }

  async #onResponse(controller: AbortController, response: Response): Promise<void> {
    if (controller !== this.#controller) return;

    if (response.status !== 200 || !isEventStreamMimeType(response.headers.get("content-type"))) {
      this.#fail();
      return;
    }

    this.#origin = new URL(response.url || this.#url).origin;
    this.#dataBuffer = "";
    this.#eventTypeBuffer = "";
    this.#lastEventIdBuffer = this.#lastEventId;
    this.#pendingLine = "";
    this.#skipNextLineFeed = false;

    this.#readyState = OPEN;
    this.dispatchEvent(new Event("open"));
    if (controller !== this.#controller) return;

    const body = response.body;
    if (body !== null) {
      try {
        const decoder = new TextDecoder();
        for await (const chunk of body) {
          this.#feed(decoder.decode(chunk, { stream: true }));
          if (controller !== this.#controller) return;
        }
      } catch {
        // A network error in the middle of the stream, or the abort from `close()`.
      }
    }

    // Whatever ended the stream, data of an unfinished event is discarded.
    if (controller !== this.#controller) return;
    this.#reconnect();
  }

  #onNetworkError(controller: AbortController): void {
    if (controller !== this.#controller) return;
    this.#reconnect();
  }

  // "Fail the connection": no further attempts are made.
  #fail(): void {
    const controller = this.#controller;
    this.#controller = null;
    controller?.abort();
    this.#readyState = CLOSED;
    this.dispatchEvent(new Event("error"));
  }

  // "Reestablish the connection": announce the drop, then retry after the reconnection time.
  #reconnect(): void {
    const controller = this.#controller;
    this.#controller = null;
    controller?.abort();
    this.#readyState = CONNECTING;
    this.dispatchEvent(new Event("error"));
    // The error handler may have called `close()`.
    if (this.#readyState !== CONNECTING) return;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      if (this.#readyState === CONNECTING) {
        this.#connect();
      }
    }, this.#reconnectionTime);
  }

  // Splits decoded text into lines. A line ends at CRLF, LF or CR; a CR that ends a chunk may
  // be the first half of a CRLF that continues in the next chunk.
  #feed(text: string): void {
    if (text.length === 0) return;
    if (this.#skipNextLineFeed) {
      this.#skipNextLineFeed = false;
      if (text.charCodeAt(0) === 0x0a) {
        text = text.slice(1);
        if (text.length === 0) return;
      }
    }
    if (this.#pendingLine.length !== 0) {
      text = this.#pendingLine + text;
      this.#pendingLine = "";
    }

    const length = text.length;
    let start = 0;
    let lineFeed = text.indexOf("\n");
    let carriageReturn = text.indexOf("\r");
    while (lineFeed !== -1 || carriageReturn !== -1) {
      const atCarriageReturn = carriageReturn !== -1 && (lineFeed === -1 || carriageReturn < lineFeed);
      const end = atCarriageReturn ? carriageReturn : lineFeed;
      this.#processLine(text.slice(start, end));
      if (this.#readyState === CLOSED) return;
      start = end + 1;

      if (atCarriageReturn) {
        if (start === length) {
          this.#skipNextLineFeed = true;
          return;
        }
        if (lineFeed === start) {
          start++;
          lineFeed = text.indexOf("\n", start);
        }
        carriageReturn = text.indexOf("\r", start);
      } else {
        lineFeed = text.indexOf("\n", start);
      }
    }
    this.#pendingLine = text.slice(start);
  }

  #processLine(line: string): void {
    if (line.length === 0) {
      this.#dispatchPendingEvent();
      return;
    }

    const colon = line.indexOf(":");
    if (colon === 0) return;

    let field: string;
    let value: string;
    if (colon === -1) {
      field = line;
      value = "";
    } else {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.charCodeAt(0) === 0x20) {
        value = value.slice(1);
      }
    }

    switch (field) {
      case "data":
        this.#dataBuffer += value + "\n";
        break;
      case "event":
        this.#eventTypeBuffer = value;
        break;
      case "id":
        if (!value.includes("\0")) {
          this.#lastEventIdBuffer = value;
        }
        break;
      case "retry":
        if (isASCIIDigits(value)) {
          this.#reconnectionTime = Math.min(parseInt(value, 10), MAX_RECONNECTION_TIME);
        }
        break;
    }
  }

  #dispatchPendingEvent(): void {
    this.#lastEventId = this.#lastEventIdBuffer;
    const data = this.#dataBuffer;
    const type = this.#eventTypeBuffer;
    this.#dataBuffer = "";
    this.#eventTypeBuffer = "";
    if (data.length === 0) return;
    if (this.#readyState === CLOSED) return;
    this.dispatchEvent(
      new MessageEvent(type === "" ? "message" : type, {
        // Every `data` line appended a line feed; the last one is not part of the data.
        data: data.slice(0, -1),
        origin: this.#origin,
        lastEventId: this.#lastEventId,
      }),
    );
  }
}

Object.defineProperty(EventSource.prototype, Symbol.toStringTag, {
  value: "EventSource",
  writable: false,
  enumerable: false,
  configurable: true,
});

for (const target of [EventSource, EventSource.prototype]) {
  Object.defineProperties(target, {
    CONNECTING: { value: CONNECTING, writable: false, enumerable: true, configurable: false },
    OPEN: { value: OPEN, writable: false, enumerable: true, configurable: false },
    CLOSED: { value: CLOSED, writable: false, enumerable: true, configurable: false },
  });
}

export default EventSource;
