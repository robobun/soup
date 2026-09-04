import { describe, expect, test } from "bun:test";
import { bunEnv, bunExe, tempDir } from "harness";
import { join } from "node:path";
import zlib from "node:zlib";

const line = "<p>Hello from Bun, in a body that compresses well.</p>\n";
const text = "<!doctype html>\n" + Buffer.alloc(line.length * 100, line).toString();

function decode(encoding: string | null, body: Uint8Array): string {
  switch (encoding) {
    case "zstd":
      return new TextDecoder().decode(Bun.zstdDecompressSync(body));
    case "br":
      return zlib.brotliDecompressSync(body).toString();
    case "gzip":
      return new TextDecoder().decode(Bun.gunzipSync(body));
    case "deflate":
      return zlib.inflateSync(body).toString();
    default:
      return new TextDecoder().decode(body);
  }
}

/** Sends `Accept-Encoding` and returns the body as it came off the wire. */
async function get(url: string | URL, acceptEncoding: string, init: RequestInit = {}) {
  const res = await fetch(url, {
    ...init,
    decompress: false,
    headers: { ...(init.headers as Record<string, string>), "Accept-Encoding": acceptEncoding },
  });
  return { res, body: await res.bytes() };
}

/** A request with no `Accept-Encoding` header, which fetch() always sends. */
async function getWithoutAcceptEncoding(port: number, path: string) {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
  const chunks: Buffer[] = [];
  await Bun.connect({
    hostname: "localhost",
    port,
    socket: {
      open(socket) {
        socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
      },
      data(_socket, data) {
        chunks.push(Buffer.from(data));
      },
      close() {
        resolve(Buffer.concat(chunks));
      },
      error(_socket, error) {
        reject(error);
      },
    },
  });
  const raw = await promise;
  const end = raw.indexOf("\r\n\r\n");
  return { head: raw.subarray(0, end).toString("latin1").toLowerCase(), body: raw.subarray(end + 4).toString() };
}

describe("Bun.serve({ compress })", () => {
  test.each(["zstd", "br", "gzip", "deflate"] as const)("encodes a body as %s", async encoding => {
    await using server = Bun.serve({
      port: 0,
      compress: { encodings: [encoding] },
      fetch: () => new Response(text, { headers: { "Content-Type": "text/html" } }),
    });

    const { res, body } = await get(server.url, encoding);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe(encoding);
    expect(res.headers.get("vary")).toBe("Accept-Encoding");
    expect(res.headers.get("content-type")).toBe("text/html");
    expect(Number(res.headers.get("content-length"))).toBe(body.length);
    expect(body.length).toBeLessThan(text.length / 4);
    expect(decode(encoding, body)).toBe(text);
  });

  test("picks the encoding that the request prefers, then the server's order", async () => {
    await using server = Bun.serve({ port: 0, compress: true, fetch: () => new Response(text) });

    const cases: [acceptEncoding: string, expected: string | null][] = [
      ["gzip, deflate, br, zstd", "zstd"],
      ["gzip, br", "br"],
      ["gzip", "gzip"],
      ["deflate", null],
      ["identity", null],
      ["*", "zstd"],
      ["*;q=0", null],
      ["zstd;q=0, *", "br"],
      ["*;q=0, gzip", "gzip"],
      ["zstd;q=0.000, br;q=0, gzip;q=0.001", "gzip"],
      [" zstd ; Q=0 , br ; q=1.0 ", "br"],
      ["gzip;q=1.0, br;q=0.5", "gzip"],
      ["br;q=0.5, zstd;q=0.5", "zstd"],
      ["gzip;q=0.9, *", "zstd"],
      ["*;q=0.1, gzip", "gzip"],
      ["gzip;q=abc", null],
      ["GZIP", "gzip"],
      ["x-gzip", "gzip"],
    ];
    const results: [string, string | null][] = [];
    for (const [acceptEncoding] of cases) {
      const { res, body } = await get(server.url, acceptEncoding);
      const encoding = res.headers.get("content-encoding");
      results.push([acceptEncoding, encoding]);
      expect(decode(encoding, body)).toBe(text);
    }
    expect(results).toEqual(cases);
  });

  test("sends the body as it is, with Vary, to a request without Accept-Encoding", async () => {
    await using server = Bun.serve({ port: 0, compress: true, fetch: () => new Response(text) });

    const { head, body } = await getWithoutAcceptEncoding(server.port, "/");
    expect(head).toStartWith("http/1.1 200");
    expect(head).toContain("\r\nvary: accept-encoding");
    expect(head).not.toContain("content-encoding");
    expect(body).toBe(text);
  });

  test("leaves a body under the threshold alone", async () => {
    const small = Buffer.alloc(1023, "a").toString();
    await using server = Bun.serve({
      port: 0,
      compress: true,
      fetch: req => new Response(new URL(req.url).pathname === "/under" ? small : small + "a"),
    });

    const under = await get(new URL("/under", server.url), "gzip");
    expect(under.res.headers.get("content-encoding")).toBeNull();
    expect(under.res.headers.get("vary")).toBeNull();
    expect(decode(null, under.body)).toBe(small);

    const at = await get(new URL("/at", server.url), "gzip");
    expect(at.res.headers.get("content-encoding")).toBe("gzip");
    expect(decode("gzip", at.body)).toBe(small + "a");
  });

  test("threshold sets the smallest body that is encoded", async () => {
    const body = Buffer.alloc(100, "a").toString();
    await using server = Bun.serve({
      port: 0,
      compress: { threshold: 100 },
      fetch: req => new Response(new URL(req.url).pathname === "/100" ? body : body.slice(1)),
    });

    const at = await get(new URL("/100", server.url), "gzip");
    expect(at.res.headers.get("content-encoding")).toBe("gzip");
    expect(decode("gzip", at.body)).toBe(body);

    const under = await get(new URL("/99", server.url), "gzip");
    expect(under.res.headers.get("content-encoding")).toBeNull();
  });

  test("sends the body as it is when encoding does not make it smaller", async () => {
    const noise = crypto.getRandomValues(new Uint8Array(4096));
    await using server = Bun.serve({
      port: 0,
      compress: true,
      fetch: () => new Response(noise, { headers: { "Content-Type": "text/plain" } }),
    });

    for (const encoding of ["zstd", "br", "gzip"]) {
      const { res, body } = await get(server.url, encoding);
      expect(res.headers.get("content-encoding")).toBeNull();
      expect(res.headers.get("vary")).toBe("Accept-Encoding");
      expect(body).toEqual(noise);
    }
  });

  test("leaves types alone that do not compress", async () => {
    await using server = Bun.serve({
      port: 0,
      compress: true,
      fetch(req) {
        switch (new URL(req.url).pathname) {
          case "/png":
            return new Response(text, { headers: { "Content-Type": "image/png" } });
          case "/event-stream":
            return new Response(text, { headers: { "Content-Type": "text/event-stream" } });
          default:
            // No type: sent as application/octet-stream.
            return new Response(new TextEncoder().encode(text));
        }
      },
    });

    for (const path of ["/png", "/event-stream", "/bytes"]) {
      const { res, body } = await get(new URL(path, server.url), "gzip");
      expect([path, res.headers.get("content-encoding"), res.headers.get("vary")]).toEqual([path, null, null]);
      expect(decode(null, body)).toBe(text);
    }
  });

  test("encodes the types that are text underneath", async () => {
    const types = [
      "text/css",
      "text/csv; charset=utf-8",
      "application/json",
      "application/javascript",
      "application/xml",
      "application/wasm",
      "image/svg+xml",
      "application/ld+json",
      "application/manifest+json",
      "font/ttf",
    ];
    await using server = Bun.serve({
      port: 0,
      compress: true,
      fetch: req => new Response(text, { headers: { "Content-Type": new URL(req.url).searchParams.get("type")! } }),
    });

    for (const type of types) {
      const { res, body } = await get(`${server.url}?type=${encodeURIComponent(type)}`, "gzip");
      expect([type, res.headers.get("content-encoding")]).toEqual([type, "gzip"]);
      expect(decode("gzip", body)).toBe(text);
    }
  });

  test("respects Content-Encoding, Cache-Control: no-transform and Content-Range from the handler", async () => {
    const gzipped = Bun.gzipSync(text);
    await using server = Bun.serve({
      port: 0,
      compress: true,
      fetch(req) {
        switch (new URL(req.url).pathname) {
          case "/encoded":
            return new Response(gzipped, { headers: { "Content-Type": "text/html", "Content-Encoding": "gzip" } });
          case "/no-transform":
            return new Response(text, { headers: { "Cache-Control": "public, No-Transform" } });
          case "/content-range":
            return new Response(text, { headers: { "Content-Range": `bytes 0-${text.length - 1}/*` } });
          default:
            return new Response(text, { status: 206 });
        }
      },
    });

    const encoded = await get(new URL("/encoded", server.url), "zstd, gzip");
    expect(encoded.res.headers.get("content-encoding")).toBe("gzip");
    expect(encoded.res.headers.get("vary")).toBeNull();
    expect(encoded.body).toEqual(gzipped);

    const noTransform = await get(new URL("/no-transform", server.url), "zstd, gzip");
    expect(noTransform.res.headers.get("content-encoding")).toBeNull();
    expect(noTransform.res.headers.get("vary")).toBeNull();
    expect(decode(null, noTransform.body)).toBe(text);

    const contentRange = await get(new URL("/content-range", server.url), "zstd, gzip");
    expect(contentRange.res.status).toBe(200);
    expect(contentRange.res.headers.get("content-encoding")).toBeNull();
    expect(decode(null, contentRange.body)).toBe(text);

    const partial = await get(new URL("/partial", server.url), "zstd, gzip");
    expect(partial.res.status).toBe(206);
    expect(partial.res.headers.get("content-encoding")).toBeNull();
    expect(decode(null, partial.body)).toBe(text);
  });

  test("adds Accept-Encoding to the handler's Vary and weakens a strong ETag", async () => {
    const headers: Record<string, Record<string, string>> = {
      "/": { "Vary": "Origin", "ETag": '"v1"' },
      "/star": { "Vary": "*" },
      "/covered": { "Vary": "accept-encoding, Origin" },
      "/weak": { "ETag": 'W/"v1"' },
    };
    await using server = Bun.serve({
      port: 0,
      compress: true,
      fetch: req => new Response(text, { headers: headers[new URL(req.url).pathname] }),
    });

    const encoded = await get(server.url, "gzip");
    expect(encoded.res.headers.get("content-encoding")).toBe("gzip");
    expect(encoded.res.headers.get("vary")).toBe("Origin, Accept-Encoding");
    expect(encoded.res.headers.get("etag")).toBe('W/"v1"');

    const identity = await get(server.url, "identity");
    expect(identity.res.headers.get("content-encoding")).toBeNull();
    expect(identity.res.headers.get("vary")).toBe("Origin, Accept-Encoding");
    expect(identity.res.headers.get("etag")).toBe('"v1"');

    const star = await get(new URL("/star", server.url), "gzip");
    expect(star.res.headers.get("content-encoding")).toBe("gzip");
    expect(star.res.headers.get("vary")).toBe("*");

    const covered = await get(new URL("/covered", server.url), "gzip");
    expect(covered.res.headers.get("vary")).toBe("accept-encoding, Origin");

    const weak = await get(new URL("/weak", server.url), "gzip");
    expect(weak.res.headers.get("etag")).toBe('W/"v1"');
  });

  test("encodes every body that is in memory", async () => {
    const data = { items: Array.from({ length: 200 }, (_, i) => ({ id: i, name: `item ${i}` })) };
    await using server = Bun.serve({
      port: 0,
      compress: true,
      async fetch(req) {
        switch (new URL(req.url).pathname) {
          case "/json":
            return Response.json(data);
          case "/blob":
            return new Response(new Blob([text], { type: "text/css" }));
          case "/bytes":
            return new Response(new TextEncoder().encode(text), {
              headers: { "Content-Type": "application/javascript" },
            });
          case "/async":
            await Promise.resolve();
            return new Response(text);
          default:
            throw new Error("handled by error()");
        }
      },
      error: () => new Response(text, { status: 500 }),
    });

    const expected: Record<string, [status: number, body: string]> = {
      "/json": [200, JSON.stringify(data)],
      "/blob": [200, text],
      "/bytes": [200, text],
      "/async": [200, text],
      "/throws": [500, text],
    };
    for (const [path, [status, want]] of Object.entries(expected)) {
      const { res, body } = await get(new URL(path, server.url), "gzip");
      expect([path, res.status, res.headers.get("content-encoding")]).toEqual([path, status, "gzip"]);
      expect(decode("gzip", body)).toBe(want);
    }
  });

  test("sends streams and files as they are", async () => {
    using dir = tempDir("serve-compress", { "page.html": text });
    await using server = Bun.serve({
      port: 0,
      compress: true,
      fetch(req) {
        if (new URL(req.url).pathname === "/file") {
          return new Response(Bun.file(join(String(dir), "page.html")));
        }
        const stream = new ReadableStream({
          async pull(controller) {
            await Promise.resolve();
            controller.enqueue(new TextEncoder().encode(text));
            controller.close();
          },
        });
        return new Response(stream, { headers: { "Content-Type": "text/html" } });
      },
    });

    for (const path of ["/file", "/stream"]) {
      const { res, body } = await get(new URL(path, server.url), "gzip");
      expect([path, res.headers.get("content-encoding"), res.headers.get("vary")]).toEqual([path, null, null]);
      expect(decode(null, body)).toBe(text);
    }
  });

  test("HEAD gets the headers that GET gets", async () => {
    await using server = Bun.serve({
      port: 0,
      compress: true,
      fetch: req =>
        new URL(req.url).pathname === "/blob"
          ? new Response(new Blob([text], { type: "text/html" }))
          : new Response(text, { headers: { ETag: '"v1"' } }),
    });

    for (const path of ["/", "/blob"]) {
      const url = new URL(path, server.url);
      const getResponse = await get(url, "br");
      const head = await get(url, "br", { method: "HEAD" });
      expect(head.body.length).toBe(0);
      for (const name of ["content-encoding", "content-length", "vary", "etag"]) {
        expect([path, name, head.res.headers.get(name)]).toEqual([path, name, getResponse.res.headers.get(name)]);
      }
      expect(head.res.headers.get("content-encoding")).toBe("br");
      expect(Number(head.res.headers.get("content-length"))).toBe(getResponse.body.length);
    }
  });

  test("encodes a static route, with the headers of each encoding", async () => {
    await using server = Bun.serve({
      port: 0,
      compress: true,
      routes: {
        "/": new Response(text, { headers: { "Content-Type": "text/html" } }),
        "/small": new Response("tiny"),
        "/logo.png": new Response(text, { headers: { "Content-Type": "image/png" } }),
      },
    });

    const gzip = await get(server.url, "gzip");
    expect(gzip.res.headers.get("content-encoding")).toBe("gzip");
    expect(gzip.res.headers.get("content-type")).toBe("text/html");
    expect(gzip.res.headers.get("vary")).toBe("Accept-Encoding");
    expect(Number(gzip.res.headers.get("content-length"))).toBe(gzip.body.length);
    expect(decode("gzip", gzip.body)).toBe(text);

    const again = await get(server.url, "gzip");
    expect(again.body).toEqual(gzip.body);

    const zstd = await get(server.url, "zstd, gzip");
    expect(zstd.res.headers.get("content-encoding")).toBe("zstd");
    expect(decode("zstd", zstd.body)).toBe(text);

    const identity = await get(server.url, "identity");
    expect(identity.res.headers.get("content-encoding")).toBeNull();
    expect(identity.res.headers.get("vary")).toBe("Accept-Encoding");
    expect(decode(null, identity.body)).toBe(text);

    const etag = identity.res.headers.get("etag")!;
    expect(etag).toStartWith('"');
    expect(gzip.res.headers.get("etag")).toBe(`W/${etag}`);

    const head = await get(server.url, "gzip", { method: "HEAD" });
    expect(head.res.headers.get("content-encoding")).toBe("gzip");
    expect(Number(head.res.headers.get("content-length"))).toBe(gzip.body.length);

    // A 304 carries the ETag of the response that a 200 would be, and no coding.
    for (const ifNoneMatch of [etag, `W/${etag}`]) {
      const notModified = await get(server.url, "gzip", { headers: { "If-None-Match": ifNoneMatch } });
      expect(notModified.res.status).toBe(304);
      expect(notModified.res.headers.get("etag")).toBe(`W/${etag}`);
      expect(notModified.res.headers.get("vary")).toBe("Accept-Encoding");
      expect(notModified.res.headers.get("content-encoding")).toBeNull();

      const notModifiedIdentity = await get(server.url, "identity", { headers: { "If-None-Match": ifNoneMatch } });
      expect(notModifiedIdentity.res.status).toBe(304);
      expect(notModifiedIdentity.res.headers.get("etag")).toBe(etag);
      expect(notModifiedIdentity.res.headers.get("vary")).toBe("Accept-Encoding");
    }

    for (const path of ["/small", "/logo.png"]) {
      const { res } = await get(new URL(path, server.url), "gzip");
      expect([path, res.headers.get("content-encoding"), res.headers.get("vary")]).toEqual([path, null, null]);
    }
  });

  test("a static route sends Vary to a request without Accept-Encoding", async () => {
    await using server = Bun.serve({
      port: 0,
      compress: true,
      routes: { "/": new Response(text, { headers: { "Vary": "Origin" } }) },
    });

    const { head, body } = await getWithoutAcceptEncoding(server.port, "/");
    expect(head).toContain("\r\nvary: origin, accept-encoding");
    expect(head).not.toContain("content-encoding");
    expect(body).toBe(text);

    const encoded = await get(server.url, "gzip");
    expect(encoded.res.headers.get("vary")).toBe("Origin, Accept-Encoding");
  });

  test("encodes the first response of an HTML import, which waits for the bundle", async () => {
    const paragraph = "<p>A page that is long enough to compress.</p>\n";
    using dir = tempDir("serve-compress-html", {
      "index.html": `<!doctype html><html><head><title>page</title></head><body>${Buffer.alloc(paragraph.length * 60, paragraph).toString()}<script type="module" src="./app.ts"></script></body></html>`,
      "app.ts": `console.log("app");`,
      "serve.ts": /* ts */ `
        import page from "./index.html";

        await using server = Bun.serve({ port: 0, development: false, compress: true, routes: { "/": page } });
        const results = [];
        for (let i = 0; i < 2; i++) {
          const res = await fetch(server.url, { decompress: false, headers: { "Accept-Encoding": "gzip" } });
          const body = await res.bytes();
          const encoding = res.headers.get("content-encoding");
          const html = new TextDecoder().decode(encoding === "gzip" ? Bun.gunzipSync(body) : body);
          results.push([encoding, html.includes("<title>page</title>")]);
        }
        console.log(JSON.stringify(results));
      `,
    });

    await using proc = Bun.spawn({
      cmd: [bunExe(), "serve.ts"],
      env: bunEnv,
      cwd: String(dir),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect({ stdout: stdout.trim(), exitCode }, stderr).toEqual({
      stdout: JSON.stringify([
        ["gzip", true],
        ["gzip", true],
      ]),
      exitCode: 0,
    });
  });

  test("is off by default", async () => {
    await using server = Bun.serve({
      port: 0,
      routes: { "/static": new Response(text) },
      fetch: () => new Response(text),
    });

    for (const path of ["/", "/static"]) {
      const { res, body } = await get(new URL(path, server.url), "gzip, deflate, br, zstd");
      expect([path, res.headers.get("content-encoding"), res.headers.get("vary")]).toEqual([path, null, null]);
      expect(decode(null, body)).toBe(text);
    }
  });

  test("server.reload() applies a compress option, and keeps the setting without one", async () => {
    const fetch = () => new Response(text);
    await using server = Bun.serve({ port: 0, fetch });
    expect((await get(server.url, "gzip")).res.headers.get("content-encoding")).toBeNull();

    server.reload({ compress: { encodings: ["gzip"] }, fetch });
    expect((await get(server.url, "zstd, gzip")).res.headers.get("content-encoding")).toBe("gzip");

    server.reload({ fetch });
    expect((await get(server.url, "zstd, gzip")).res.headers.get("content-encoding")).toBe("gzip");

    server.reload({ compress: false, fetch });
    expect((await get(server.url, "gzip")).res.headers.get("content-encoding")).toBeNull();
  });

  test("validates the option", () => {
    const fetch = () => new Response(text);
    // @ts-expect-error
    expect(() => Bun.serve({ port: 0, compress: "gzip", fetch })).toThrow(
      'The "compress" argument must be of type boolean or object',
    );
    // @ts-expect-error
    expect(() => Bun.serve({ port: 0, compress: { encodings: "gzip" }, fetch })).toThrow(
      'The "compress.encodings" argument must be of type array',
    );
    // @ts-expect-error
    expect(() => Bun.serve({ port: 0, compress: { encodings: ["lz4"] }, fetch })).toThrow(
      'compress.encodings must only contain "zstd", "br", "gzip" or "deflate"',
    );
    expect(() => Bun.serve({ port: 0, compress: { encodings: [] }, fetch })).toThrow(
      "compress.encodings must name at least one encoding",
    );
    expect(() => Bun.serve({ port: 0, compress: { threshold: -1 }, fetch })).toThrow(RangeError);
    expect(() => Bun.serve({ port: 0, compress: { threshold: 1.5 }, fetch })).toThrow("compress.threshold");
  });
});
