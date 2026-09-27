import { S3Client, type S3Options } from "bun";
import { afterAll, describe, expect, it } from "bun:test";
import { serve, type RequestRecord } from "s3-server";

// The server verifies the signature of each request, so a request that does
// not sign its `x-amz-meta-*` headers the way Amazon S3 reads them gets a 403.
const server = serve({ buckets: ["metadata"] });
afterAll(() => server.stop());
const options: S3Options = server.clientOptions("metadata");
const client = new S3Client(options);

/** The requests for `operation` on the object `key`, oldest first. */
function requests(operation: string, key: string): RequestRecord[] {
  return server.requests.filter(request => request.operation === operation && request.key === key);
}

function last(operation: string, key: string): RequestRecord {
  const request = requests(operation, key).at(-1);
  if (!request) throw new Error(`no ${operation} request for ${key}`);
  return request;
}

function metadataOf(request: RequestRecord): Record<string, string> {
  return Object.fromEntries([...request.headers].filter(([name]) => name.startsWith("x-amz-meta-")));
}

/** The `x-amz-meta-*` headers of the last request for `operation` on `key`. */
function sent(operation: string, key: string): Record<string, string> {
  return metadataOf(last(operation, key));
}

/** The names of the headers that the last request for `operation` on `key` signed. */
function signed(operation: string, key: string): string[] {
  const authorization = last(operation, key).headers.get("authorization") ?? "";
  return /SignedHeaders=([^,]*)/.exec(authorization)![1].split(";");
}

function signedHeadersOf(url: string): string | null {
  return new URL(url).searchParams.get("X-Amz-SignedHeaders");
}

function stream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

describe("s3 - metadata", () => {
  it("write() stores the metadata and stat() returns it", async () => {
    await client.write("write.txt", "hello", {
      metadata: { Customer: "1042", "reviewed-by": "ana  maria", empty: "", 7: "seven" },
    });
    expect(sent("PutObject", "write.txt")).toEqual({
      "x-amz-meta-7": "seven",
      "x-amz-meta-customer": "1042",
      "x-amz-meta-empty": "",
      "x-amz-meta-reviewed-by": "ana  maria",
    });

    const stat = await client.stat("write.txt");
    expect(stat.metadata).toEqual({ 7: "seven", customer: "1042", empty: "", "reviewed-by": "ana  maria" });
    expect(stat.metadata).toBe(stat.metadata);
    expect(await client.file("write.txt").text()).toBe("hello");
  });

  it("stat() of an object that has none returns an empty object", async () => {
    await client.write("none.txt", "hello");
    expect(sent("PutObject", "none.txt")).toEqual({});
    expect((await client.stat("none.txt")).metadata).toEqual({});
  });

  it("stat() reads the headers of the response in any case", async () => {
    const response = [
      "HTTP/1.1 200 OK",
      "Content-Length: 5",
      "Content-Type: text/plain",
      'ETag: "5d41402abc4b2a76b9719d911017c592"',
      "Last-Modified: Sun, 27 Sep 2026 10:00:00 GMT",
      "X-Amz-Meta-Customer: 1042",
      "x-amz-meta-Reviewed-By: Ana Maria",
      "X-AMZ-META-EMPTY:",
      "X-Amz-Meta-: a name that has no key",
      "X-Amz-Metadata-Directive: not metadata",
      "Connection: close",
      "",
      "",
    ].join("\r\n");
    using raw = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket) {
          socket.end(response);
        },
      },
    });

    const stat = await S3Client.stat("object.txt", { ...options, endpoint: `http://127.0.0.1:${raw.port}` });
    expect(stat.metadata).toEqual({ customer: "1042", "reviewed-by": "Ana Maria", empty: "" });
    expect(stat.size).toBe(5);
  });

  it("signs a value the way the server reads it: trimmed, with single spaces", async () => {
    await client.write("spaces.txt", "hello", { metadata: { note: "  a   b  c ", blank: "   " } });
    expect((await client.stat("spaces.txt")).metadata).toEqual({ note: "a   b  c", blank: "" });
  });

  it("signs the headers in the order of their names, between the other headers", async () => {
    await client.write("order.txt", "hello", {
      metadata: { b: "1", "a.b": "2", a0: "3", A: "4", "a-b": "5" },
      acl: "private",
      storageClass: "STANDARD_IA",
      requestPayer: true,
    });
    expect(signed("PutObject", "order.txt")).toEqual([
      "host",
      "x-amz-acl",
      "x-amz-content-sha256",
      "x-amz-date",
      "x-amz-meta-a",
      "x-amz-meta-a-b",
      "x-amz-meta-a.b",
      "x-amz-meta-a0",
      "x-amz-meta-b",
      "x-amz-request-payer",
      "x-amz-storage-class",
    ]);
    expect((await client.stat("order.txt")).metadata).toEqual({ a: "4", "a-b": "5", "a.b": "2", a0: "3", b: "1" });
  });

  it("takes each character of a header name in a key", async () => {
    const metadata = { "!#$%&'*+-.^_`|~": "symbols", "0aZ": "letters and digits" };
    await client.write("symbols.txt", "hello", { metadata });
    expect((await client.stat("symbols.txt")).metadata).toEqual({
      "!#$%&'*+-.^_`|~": "symbols",
      "0az": "letters and digits",
    });
  });

  it("S3File.write(), Bun.write() to a file that has it, and the static S3Client.write()", async () => {
    await client.file("file.txt").write("hello", { metadata: { from: "file.write" } });
    expect((await client.stat("file.txt")).metadata).toEqual({ from: "file.write" });

    await Bun.write(client.file("bun-write.txt", { metadata: { from: "Bun.write" } }), "hello");
    expect((await client.stat("bun-write.txt")).metadata).toEqual({ from: "Bun.write" });

    await S3Client.write("static.txt", "hello", { ...options, metadata: { from: "static" } });
    expect((await S3Client.stat("static.txt", options)).metadata).toEqual({ from: "static" });

    // Nothing to upload, a Blob, and a file copied from the bucket.
    await client.write("empty.txt", "", { metadata: { from: "empty" } });
    expect((await client.stat("empty.txt")).metadata).toEqual({ from: "empty" });
    await client.write("blob.txt", new Blob(["hello"]), { metadata: { from: "blob" } });
    expect((await client.stat("blob.txt")).metadata).toEqual({ from: "blob" });
    await client.write("copy.txt", client.file("blob.txt"), { metadata: { from: "copy" } });
    expect((await client.stat("copy.txt")).metadata).toEqual({ from: "copy" });
    expect(await client.file("copy.txt").text()).toBe("hello");
  });

  it("the metadata of a file is the default of its uploads", async () => {
    const file = client.file("sticky.txt", { metadata: { owner: "file" } });
    await file.write("one");
    expect((await file.stat()).metadata).toEqual({ owner: "file" });

    // The metadata of a call replaces it and does not merge with it.
    await file.write("two", { metadata: { reviewer: "call" } });
    expect((await file.stat()).metadata).toEqual({ reviewer: "call" });

    await file.write("three", { metadata: {} });
    expect((await file.stat()).metadata).toEqual({});

    await file.write("four", { metadata: undefined });
    expect((await file.stat()).metadata).toEqual({ owner: "file" });

    await file.write("five", { metadata: null });
    expect((await file.stat()).metadata).toEqual({});

    await Bun.write(file, "six");
    expect((await file.stat()).metadata).toEqual({ owner: "file" });

    await file.write("seven", { metadata: {} });
    const writer = file.writer();
    writer.write("eight");
    await writer.end();
    expect((await file.stat()).metadata).toEqual({ owner: "file" });
  });

  it("the metadata of a client is the default of its files", async () => {
    const tagged = new S3Client({ ...options, metadata: { app: "billing" } });
    await tagged.write("client.txt", "one");
    expect((await tagged.stat("client.txt")).metadata).toEqual({ app: "billing" });

    await tagged.write("client.txt", "two", { metadata: {} });
    expect((await tagged.stat("client.txt")).metadata).toEqual({});

    await tagged.file("client.txt").write("three");
    expect((await tagged.stat("client.txt")).metadata).toEqual({ app: "billing" });

    await tagged.file("client.txt", { metadata: { app: "reports" } }).write("four");
    expect((await tagged.stat("client.txt")).metadata).toEqual({ app: "reports" });

    await tagged.file("client.txt", { metadata: null }).write("five");
    expect((await tagged.stat("client.txt")).metadata).toEqual({});
  });

  it("writer() sends it with a single upload", async () => {
    const writer = client.file("writer.txt").writer({ metadata: { via: "writer" } });
    writer.write("hello ");
    writer.write("world");
    await writer.end();
    expect(sent("PutObject", "writer.txt")).toEqual({ "x-amz-meta-via": "writer" });
    expect((await client.stat("writer.txt")).metadata).toEqual({ via: "writer" });
    expect(await client.file("writer.txt").text()).toBe("hello world");
  });

  it("a multipart upload sends it when the upload is created, not with the parts", async () => {
    const part = Buffer.alloc(5 * 1024 * 1024, "a");
    const writer = client.file("multipart.bin").writer({
      partSize: part.length,
      metadata: { via: "multipart", parts: "2" },
    });
    writer.write(part);
    writer.write(part);
    await writer.end();

    expect(requests("CreateMultipartUpload", "multipart.bin").map(metadataOf)).toEqual([
      { "x-amz-meta-parts": "2", "x-amz-meta-via": "multipart" },
    ]);
    expect(requests("UploadPart", "multipart.bin").map(metadataOf)).toEqual([{}, {}]);
    expect(requests("CompleteMultipartUpload", "multipart.bin").map(metadataOf)).toEqual([{}]);
    const stat = await client.stat("multipart.bin");
    expect(stat.size).toBe(2 * part.length);
    expect(stat.metadata).toEqual({ via: "multipart", parts: "2" });
  });

  it("a stream sends it: a ReadableStream and the body of a Response", async () => {
    await client.file("readable.txt").write(stream("from a stream"), { metadata: { via: "stream" } });
    expect((await client.stat("readable.txt")).metadata).toEqual({ via: "stream" });
    expect(await client.file("readable.txt").text()).toBe("from a stream");

    await client.write("response.txt", new Response(stream("from a response")), { metadata: { via: "response" } });
    expect((await client.stat("response.txt")).metadata).toEqual({ via: "response" });
    expect(await client.file("response.txt").text()).toBe("from a response");
  });

  it("fetch() to an s3:// URL sends it with a PUT, for a stream and for a string", async () => {
    const s3 = { ...server.clientOptions(), metadata: { via: "fetch" } };

    const streamed = await fetch("s3://metadata/fetch-stream.txt", { method: "PUT", body: stream("streamed"), s3 });
    expect(streamed.status).toBe(200);
    expect((await client.stat("fetch-stream.txt")).metadata).toEqual({ via: "fetch" });

    const buffered = await fetch("s3://metadata/fetch-string.txt", { method: "PUT", body: "buffered", s3 });
    expect(await buffered.text()).toBe("");
    expect(buffered.status).toBe(200);
    expect(sent("PutObject", "fetch-string.txt")).toEqual({ "x-amz-meta-via": "fetch" });
    expect((await client.stat("fetch-string.txt")).metadata).toEqual({ via: "fetch" });

    // A request that does not upload has no use for it.
    const read = await fetch("s3://metadata/fetch-string.txt", { s3 });
    expect(await read.text()).toBe("buffered");
    expect(signed("GetObject", "fetch-string.txt")).toEqual(["host", "x-amz-content-sha256", "x-amz-date"]);
  });

  describe("presign()", () => {
    it("signs the metadata of a PUT as headers of the request", async () => {
      const url = client.presign("presigned.txt", {
        method: "PUT",
        metadata: { User: "1042", note: "two  words" },
      });
      expect(signedHeadersOf(url)).toBe("host;x-amz-meta-note;x-amz-meta-user");

      const missing = await fetch(url, { method: "PUT", body: "hello" });
      expect(missing.status).toBe(403);
      expect(await missing.text()).toContain("<Code>SignatureDoesNotMatch</Code>");

      const other = await fetch(url, {
        method: "PUT",
        body: "hello",
        headers: { "x-amz-meta-user": "1043", "x-amz-meta-note": "two  words" },
      });
      expect(other.status).toBe(403);
      expect(await other.text()).toContain("<Code>SignatureDoesNotMatch</Code>");

      const uploaded = await fetch(url, {
        method: "PUT",
        body: "hello",
        headers: { "x-amz-meta-user": "1042", "x-amz-meta-note": "two  words" },
      });
      expect(await uploaded.text()).toBe("");
      expect(uploaded.status).toBe(200);
      expect((await client.stat("presigned.txt")).metadata).toEqual({ user: "1042", note: "two  words" });
    });

    it("percent-encodes a key in the list of signed headers", async () => {
      const url = client.presign("encoded.txt", { method: "PUT", metadata: { "a+b": "1", "a.b": "2" } });
      expect(url).toContain("&X-Amz-SignedHeaders=host%3Bx-amz-meta-a%2Bb%3Bx-amz-meta-a.b");

      const uploaded = await fetch(url, {
        method: "PUT",
        body: "hello",
        headers: { "x-amz-meta-a+b": "1", "x-amz-meta-a.b": "2" },
      });
      expect(await uploaded.text()).toBe("");
      expect(uploaded.status).toBe(200);
      expect((await client.stat("encoded.txt")).metadata).toEqual({ "a+b": "1", "a.b": "2" });
    });

    it("signs the metadata of the file and of the client, and what replaces it", () => {
      const file = client.file("default.txt", { metadata: { user: "1042" } });
      expect(signedHeadersOf(file.presign({ method: "PUT" }))).toBe("host;x-amz-meta-user");
      expect(signedHeadersOf(file.presign({ method: "POST" }))).toBe("host;x-amz-meta-user");
      expect(signedHeadersOf(file.presign({ method: "PUT", metadata: { team: "a" } }))).toBe("host;x-amz-meta-team");
      expect(signedHeadersOf(file.presign({ method: "PUT", metadata: {} }))).toBe("host");

      const tagged = new S3Client({ ...options, metadata: { app: "billing" } });
      expect(signedHeadersOf(tagged.presign("default.txt", { method: "PUT" }))).toBe("host;x-amz-meta-app");
      expect(signedHeadersOf(tagged.presign("default.txt", { method: "PUT", metadata: null }))).toBe("host");

      const url = S3Client.presign("default.txt", { ...options, method: "PUT", metadata: { from: "static" } });
      expect(signedHeadersOf(url)).toBe("host;x-amz-meta-from");
    });

    it("leaves it out of a URL that does not upload", async () => {
      const file = client.file("download.txt", { metadata: { user: "1042" } });
      await file.write("hello");

      for (const method of ["GET", "HEAD", "DELETE"] as const) {
        expect(signedHeadersOf(file.presign({ method, metadata: { user: "1042" } }))).toBe("host");
      }
      expect(signedHeadersOf(file.presign())).toBe("host");

      const response = await fetch(file.presign({ method: "GET", expiresIn: 60 }));
      expect(await response.text()).toBe("hello");
      expect(response.status).toBe(200);
    });
  });

  it("signs a request that is larger than one without metadata can be", async () => {
    // 1.8 KB of metadata next to a session token of 1.5 KB.
    const temporary = server.addCredential({
      accessKeyId: "ASIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      sessionToken: Buffer.alloc(1500, "t").toString(),
    });
    const metadata: Record<string, string> = {};
    for (let i = 100; i < 220; i++) metadata[`key-${i}`] = Buffer.alloc(8, "v").toString();

    const { accessKeyId, secretAccessKey, sessionToken } = temporary;
    await client.write("many.txt", "hello", { accessKeyId, secretAccessKey, sessionToken, metadata });
    expect(Object.keys(sent("PutObject", "many.txt")).length).toBe(120);
    expect((await client.stat("many.txt")).metadata).toEqual(metadata);
  });

  it("reports the error of the server for more than it stores", async () => {
    const metadata = { large: Buffer.alloc(2048, "v").toString() };
    await expect(client.write("large.txt", "hello", { metadata })).rejects.toMatchObject({
      name: "S3Error",
      code: "MetadataTooLarge",
    });
  });

  describe("validation", () => {
    const file = client.file("invalid.txt");
    const tooMany: Record<string, string> = {};
    for (let i = 0; i < 239; i++) tooMany[`k${i}`] = "";

    // prettier-ignore
    const cases: [string, unknown, string][] = [
      ["a string", "a=1", `The "metadata" argument must be of type object. Received type string ('a=1')`],
      ["an array", ["a"], `The "metadata" argument must be of type object. Received an instance of Array`],
      ["a Map", new Map([["a", "1"]]), `The "metadata" argument must be of type object. Received an instance of Map`],
      ["a Headers", new Headers({ a: "1" }), `The "metadata" argument must be of type object. Received an instance of Headers`],
      ["a Date", new Date(0), `The "metadata" argument must be of type object. Received an instance of Date`],
      ["a number as a value", { count: 1 }, `The "metadata.count" argument must be of type string. Received type number (1)`],
      ["a space in a key", { "two words": "1" }, `metadata key "two words" must be a valid HTTP header name`],
      ["a colon in a key", { "a:b": "1" }, `metadata key "a:b" must be a valid HTTP header name`],
      ["an empty key", { "": "1" }, `metadata key "" must be a valid HTTP header name`],
      ["a key that is not ASCII", { café: "1" }, `metadata key "café" must be a valid HTTP header name`],
      ["a line break in a value", { a: "1\r\nx-amz-acl: public-read" }, `metadata value of "a" must be printable ASCII characters`],
      ["a tab in a value", { a: "1\t2" }, `metadata value of "a" must be printable ASCII characters`],
      ["a NUL in a value", { a: "1\x002" }, `metadata value of "a" must be printable ASCII characters`],
      ["the character before the space in a value", { a: "\x1f" }, `metadata value of "a" must be printable ASCII characters`],
      ["the character after the tilde in a value", { a: "\x7f" }, `metadata value of "a" must be printable ASCII characters`],
      ["a value that is not ASCII", { a: "café" }, `metadata value of "a" must be printable ASCII characters`],
      ["the same key twice", { Color: "red", color: "blue" }, `metadata has more than one "color" key (keys are case-insensitive)`],
      ["more keys than a request has headers for", tooMany, `metadata must not have more than 238 keys`],
    ];

    it.each(cases)("refuses %s", async (_, metadata, message) => {
      const invalid = { metadata } as S3Options;
      const before = server.requests.length;
      await expect(file.write("hello", invalid)).rejects.toThrow(message);
      await expect(fetch("s3://metadata/invalid.txt", { method: "PUT", body: "hello", s3: invalid })).rejects.toThrow(
        message,
      );
      expect(() => file.writer(invalid)).toThrow(message);
      expect(() => file.presign({ ...invalid, method: "PUT" })).toThrow(message);
      expect(() => client.file("invalid.txt", invalid)).toThrow(message);
      expect(() => new S3Client({ ...options, ...invalid })).toThrow(message);
      expect(server.requests.length).toBe(before);
    });

    it("takes as many keys as a request has headers for", () => {
      const most = Object.fromEntries(Object.entries(tooMany).slice(0, 238));
      const url = client.presign("most.txt", { method: "PUT", metadata: most });
      expect(signedHeadersOf(url)!.split(";").length).toBe(239);
    });
  });
});
