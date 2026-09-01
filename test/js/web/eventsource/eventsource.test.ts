import { describe, expect, test } from "bun:test";

const eventStreamHeaders = { "content-type": "text/event-stream" };

function nextEvent<T extends Event = Event>(target: EventTarget, type: string): Promise<T> {
  return new Promise(resolve => target.addEventListener(type, event => resolve(event as T), { once: true }));
}

// Resolves when the server's response stream is cancelled, that is when the client went away.
function eventStream(chunks: (string | Uint8Array)[]): { response: Response; cancelled: Promise<void> } {
  const { promise: cancelled, resolve } = Promise.withResolvers<void>();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
      }
    },
    cancel() {
      resolve();
    },
  });
  return { response: new Response(stream, { headers: eventStreamHeaders }), cancelled };
}

// The headers of a request, captured while the request is still alive.
function requestHeaders(req: Request): Record<string, string | null> {
  return {
    method: req.method,
    accept: req.headers.get("accept"),
    authorization: req.headers.get("authorization"),
    lastEventId: req.headers.get("last-event-id"),
  };
}

function collect(source: EventSource, count: number, type = "message"): Promise<MessageEvent[]> {
  return new Promise(resolve => {
    const events: MessageEvent[] = [];
    source.addEventListener(type, event => {
      events.push(event as MessageEvent);
      if (events.length === count) resolve(events);
    });
  });
}

describe("EventSource", () => {
  test("is a global with the interface of the spec", () => {
    expect(typeof EventSource).toBe("function");
    expect(EventSource.name).toBe("EventSource");
    expect(EventSource.length).toBe(1);
    expect(Object.getPrototypeOf(EventSource.prototype)).toBe(EventTarget.prototype);
    expect(EventSource.prototype[Symbol.toStringTag]).toBe("EventSource");

    for (const target of [EventSource, EventSource.prototype]) {
      expect(Object.getOwnPropertyDescriptor(target, "CONNECTING")).toEqual({
        value: 0,
        writable: false,
        enumerable: true,
        configurable: false,
      });
      expect(target.OPEN).toBe(1);
      expect(target.CLOSED).toBe(2);
    }
    expect(Object.getOwnPropertyDescriptor(globalThis, "EventSource")).toMatchObject({
      writable: true,
      enumerable: true,
      configurable: true,
    });
  });

  test("validates the constructor arguments", async () => {
    using server = Bun.serve({
      port: 0,
      fetch: () => eventStream([": hello\n\n"]).response,
    });

    // @ts-expect-error the URL is required
    expect(() => new EventSource()).toThrow(TypeError);
    expect(() => new EventSource("not a url")).toThrow(expect.objectContaining({ name: "SyntaxError" }));
    expect(() => new EventSource("ftp://example.com/events")).toThrow(expect.objectContaining({ name: "SyntaxError" }));
    // @ts-expect-error options must be an object
    expect(() => new EventSource(server.url, 42)).toThrow(TypeError);

    const source = new EventSource(new URL("/a/../events?x=1#frag", server.url));
    try {
      expect(source.url).toBe(`${server.url.origin}/events?x=1#frag`);
      expect(source.readyState).toBe(EventSource.CONNECTING);
      expect(source.withCredentials).toBe(false);
      expect(Object.prototype.toString.call(source)).toBe("[object EventSource]");
      expect(source).toBeInstanceOf(EventTarget);
      await nextEvent(source, "open");
      expect(source.readyState).toBe(EventSource.OPEN);
    } finally {
      source.close();
    }

    const withCredentials = new EventSource(server.url, { withCredentials: true });
    expect(withCredentials.withCredentials).toBe(true);
    withCredentials.close();
  });

  test("dispatches a MessageEvent for every event in the stream", async () => {
    let request!: ReturnType<typeof requestHeaders>;
    using server = Bun.serve({
      port: 0,
      fetch(req) {
        request = requestHeaders(req);
        return eventStream([
          "data: hello\n\n",
          "data: multi\ndata: line\n\n",
          'event: ticket\nid: 42\ndata: {"n":1}\n\n',
          ": a comment\n\n",
          "id: 7\n\n",
          "unknown: field\ndata: after\n\n",
        ]).response;
      },
    });

    const source = new EventSource(server.url);
    try {
      const messages = collect(source, 3);
      const tickets = collect(source, 1, "ticket");
      const open = await nextEvent(source, "open");
      expect(open.type).toBe("open");
      expect(source.readyState).toBe(EventSource.OPEN);

      const [hello, multi, after] = await messages;
      const [ticket] = await tickets;

      expect(hello).toBeInstanceOf(MessageEvent);
      expect([hello.data, hello.lastEventId, hello.origin, hello.source]).toEqual([
        "hello",
        "",
        server.url.origin,
        null,
      ]);
      expect([multi.data, multi.lastEventId]).toEqual(["multi\nline", ""]);
      expect([ticket.type, ticket.data, ticket.lastEventId]).toEqual(["ticket", '{"n":1}', "42"]);
      // The block with only `id` sets the last event ID without dispatching an event.
      expect([after.data, after.lastEventId]).toEqual(["after", "7"]);

      expect(request).toEqual({
        method: "GET",
        accept: "text/event-stream",
        authorization: null,
        lastEventId: null,
      });
    } finally {
      source.close();
    }
  });

  test("parses fields the way the spec says", async () => {
    using server = Bun.serve({
      port: 0,
      fetch: () =>
        eventStream([
          "data:no-space\n\n",
          "data:  two-spaces\n\n",
          "data\n\n",
          "data\ndata\n\n",
          "event:\ndata: empty-type\n\n",
          "event: typed\nevent: retyped\ndata: last-type-wins\n\n",
          "id: 1\ndata: one\n\n",
          "id: bad\0id\ndata: two\n\n",
          "id\ndata: three\n\n",
          "event: only-type\n\n",
          "data: four\n\n",
        ]).response,
    });

    const source = new EventSource(server.url);
    try {
      const retyped = collect(source, 1, "retyped");
      const messages = await collect(source, 9);
      expect(messages.map(event => [event.data, event.lastEventId])).toEqual([
        ["no-space", ""],
        [" two-spaces", ""],
        ["", ""],
        ["\n", ""],
        ["empty-type", ""],
        ["one", "1"],
        // An `id` with a NUL character is ignored.
        ["two", "1"],
        // A bare `id` line resets the last event ID.
        ["three", ""],
        // An `event` without data does not dispatch, and does not leak its type into the next event.
        ["four", ""],
      ]);
      expect((await retyped)[0].data).toBe("last-type-wins");
    } finally {
      source.close();
    }
  });

  test("handles CR, CRLF, a byte order mark and chunk boundaries", async () => {
    const { promise: released, resolve: release } = Promise.withResolvers<void>();
    const encoder = new TextEncoder();
    const split = encoder.encode("data: héllo\n\n");
    // "é" is two bytes; cut between them.
    const cut = "data: h".length + 1;

    using server = Bun.serve({
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname === "/continue") {
          release();
          return new Response("ok");
        }
        return new Response(
          async function* () {
            yield new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode("data: bom\r\n\r\ndata: cr\r\rdata: a\r")]);
            await released;
            yield encoder.encode("\ndata: b\n\ndat");
            yield encoder.encode("a: joined\n\n");
            yield split.subarray(0, cut);
            yield split.subarray(cut);
            await new Promise(() => {});
          },
          { headers: eventStreamHeaders },
        );
      },
    });

    const source = new EventSource(server.url);
    try {
      const first = collect(source, 2);
      const all = collect(source, 5);
      expect((await first).map(event => event.data)).toEqual(["bom", "cr"]);
      // The first chunk ends in a CR; the LF that completes the CRLF arrives in the next chunk.
      await fetch(new URL("/continue", server.url));
      expect((await all).map(event => event.data)).toEqual(["bom", "cr", "a\nb", "joined", "héllo"]);
    } finally {
      source.close();
    }
  });

  test("reconnects with Last-Event-ID after the server ends the stream", async () => {
    const requests: ReturnType<typeof requestHeaders>[] = [];
    using server = Bun.serve({
      port: 0,
      fetch(req) {
        requests.push(requestHeaders(req));
        if (requests.length === 1) {
          return new Response("retry: 10\nid: 1\ndata: first\n\n", { headers: eventStreamHeaders });
        }
        return eventStream(["data: second\n\n"]).response;
      },
    });

    const source = new EventSource(server.url);
    try {
      const states: number[] = [];
      source.onerror = () => states.push(source.readyState);
      const messages = collect(source, 2);
      const opens: number[] = [];
      source.onopen = () => opens.push(source.readyState);

      const [first, second] = await messages;
      expect([first.data, first.lastEventId]).toEqual(["first", "1"]);
      expect([second.data, second.lastEventId]).toEqual(["second", "1"]);
      // The drop is announced with an error event while the source is reconnecting.
      expect(states).toEqual([EventSource.CONNECTING]);
      expect(opens).toEqual([EventSource.OPEN, EventSource.OPEN]);

      expect(requests).toEqual([
        { method: "GET", accept: "text/event-stream", authorization: null, lastEventId: null },
        { method: "GET", accept: "text/event-stream", authorization: null, lastEventId: "1" },
      ]);
    } finally {
      source.close();
    }
  });

  test("reconnects after a network error", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("unused") });
    const url = server.url;
    server.stop(true);

    const source = new EventSource(url);
    try {
      await nextEvent(source, "error");
      expect(source.readyState).toBe(EventSource.CONNECTING);
    } finally {
      source.close();
    }
    expect(source.readyState).toBe(EventSource.CLOSED);
  });

  test("fails the connection on a status other than 200", async () => {
    let requests = 0;
    using server = Bun.serve({
      port: 0,
      fetch() {
        requests++;
        return new Response("data: nope\n\n", { status: 404, headers: eventStreamHeaders });
      },
    });

    const source = new EventSource(server.url);
    let messages = 0;
    source.onmessage = () => messages++;
    await nextEvent(source, "error");
    expect(source.readyState).toBe(EventSource.CLOSED);
    expect(requests).toBe(1);
    expect(messages).toBe(0);
  });

  test("fails the connection when the Content-Type is not text/event-stream", async () => {
    using server = Bun.serve({
      port: 0,
      fetch: () => new Response("data: nope\n\n", { headers: { "content-type": "text/plain" } }),
    });

    const source = new EventSource(server.url);
    const error = await nextEvent(source, "error");
    expect(error.type).toBe("error");
    expect(source.readyState).toBe(EventSource.CLOSED);
  });

  test("accepts Content-Type parameters", async () => {
    using server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(eventStream(["data: ok\n\n"]).response.body, {
          headers: { "content-type": "Text/Event-Stream; charset=utf-8" },
        }),
    });

    const source = new EventSource(server.url);
    try {
      expect((await nextEvent<MessageEvent>(source, "message")).data).toBe("ok");
    } finally {
      source.close();
    }
  });

  test("follows redirects", async () => {
    using server = Bun.serve({
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname === "/events") {
          return eventStream(["data: redirected\n\n"]).response;
        }
        return Response.redirect(new URL("/events", req.url), 302);
      },
    });

    const source = new EventSource(new URL("/start", server.url));
    try {
      const message = await nextEvent<MessageEvent>(source, "message");
      expect([message.data, message.origin]).toEqual(["redirected", server.url.origin]);
      expect(source.url).toBe(`${server.url.origin}/start`);
    } finally {
      source.close();
    }
  });

  test("close() aborts the request and stops the events", async () => {
    let cancelled!: Promise<void>;
    using server = Bun.serve({
      port: 0,
      fetch() {
        const stream = eventStream(["data: one\n\ndata: two\n\n"]);
        cancelled = stream.cancelled;
        return stream.response;
      },
    });

    const source = new EventSource(server.url);
    const received: string[] = [];
    source.onmessage = event => {
      received.push(event.data);
      source.close();
      source.close();
    };
    let errors = 0;
    source.onerror = () => errors++;

    await nextEvent(source, "message");
    expect(source.readyState).toBe(EventSource.CLOSED);
    await cancelled;
    // The second event was in the same chunk and is dropped.
    expect(received).toEqual(["one"]);
    expect(errors).toBe(0);
  });

  test("close() during the open event drops the response", async () => {
    using server = Bun.serve({
      port: 0,
      fetch: () => eventStream(["data: lost\n\n"]).response,
    });

    const source = new EventSource(server.url);
    let messages = 0;
    source.onmessage = () => messages++;
    source.onopen = () => source.close();
    await nextEvent(source, "open");
    expect(source.readyState).toBe(EventSource.CLOSED);
    // Give the body a chance to arrive; a closed source must not dispatch it.
    await fetch(server.url).then(res => res.body?.cancel());
    expect(messages).toBe(0);
  });

  test("event handler attributes", async () => {
    using server = Bun.serve({
      port: 0,
      fetch: () => eventStream(["data: hi\n\n"]).response,
    });

    const source = new EventSource(server.url);
    try {
      expect([source.onopen, source.onmessage, source.onerror]).toEqual([null, null, null]);

      const calls: string[] = [];
      const replaced = () => calls.push("replaced");
      source.onmessage = replaced;
      expect(source.onmessage).toBe(replaced);
      const handler = (event: MessageEvent) => calls.push(`handler:${event.data}`);
      source.onmessage = handler;
      expect(source.onmessage).toBe(handler);

      // @ts-expect-error a non-callable value clears the handler
      source.onopen = "not a function";
      expect(source.onopen).toBeNull();

      await nextEvent(source, "message");
      expect(calls).toEqual(["handler:hi"]);

      source.onmessage = null;
      expect(source.onmessage).toBeNull();
    } finally {
      source.close();
    }
  });

  test("sends the headers option with every request", async () => {
    const requests: ReturnType<typeof requestHeaders>[] = [];
    using server = Bun.serve({
      port: 0,
      fetch(req) {
        requests.push(requestHeaders(req));
        if (requests.length === 1) {
          return new Response("retry: 10\nid: 9\ndata: first\n\n", { headers: eventStreamHeaders });
        }
        return eventStream(["data: second\n\n"]).response;
      },
    });

    const source = new EventSource(server.url, {
      headers: { authorization: "Bearer token", accept: "text/plain", "last-event-id": "ignored" },
    });
    try {
      await collect(source, 2);
      // `Accept` is always the event stream type. A `Last-Event-ID` of the caller is sent until the
      // server has sent an event with an `id`.
      expect(requests).toEqual([
        { method: "GET", accept: "text/event-stream", authorization: "Bearer token", lastEventId: "ignored" },
        { method: "GET", accept: "text/event-stream", authorization: "Bearer token", lastEventId: "9" },
      ]);
    } finally {
      source.close();
    }
  });

  test("prints its state", () => {
    const source = new EventSource("http://localhost:1/events");
    source.close();
    expect(Bun.inspect(source)).toBe(
      'EventSource {\n  url: "http://localhost:1/events",\n  readyState: 2,\n  withCredentials: false,\n}',
    );
  });
});
