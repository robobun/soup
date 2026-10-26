import { S3Client, type S3CopyOptions, type S3File, type S3Options } from "bun";
import { afterAll, describe, expect, it } from "bun:test";
import { bunEnv, bunExe } from "harness";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { DEFAULT_CREDENTIALS, DEFAULT_OWNER, serve, type ObjectVersion, type RequestRecord } from "s3-server";

// The server verifies the signature of each request and refuses an `x-amz-*`
// header that the signature does not cover.
//
// It also refuses a signature whose time is far from its clock, so the clock
// of the tests stays within minutes of the real one.
const START = new Date(Math.floor(Date.now() / 1000) * 1000);
const at = (seconds: number) => new Date(START.getTime() + seconds * 1000);
let now = START;
// A second key pair, which the server accepts with its session token only.
const SESSION = {
  accessKeyId: "AKIAI44QH8DHBEXAMPLE",
  secretAccessKey: "je7MtGbClwBF/2Zp9Utk/h3yCo8nvbEXAMPLEKEY",
  sessionToken: "AQoDYXdzEPT//////////wEXAMPLEtc764bNrC9SAPBSM22wDOk4x4HIZ8j4FZTwdQW",
};
// The key pair of another account. It owns the bucket "mine".
const REQUESTER_OWNER = { ...DEFAULT_OWNER, id: Buffer.alloc(32, 7).toString("hex"), accountId: "210987654321" };
const REQUESTER = {
  accessKeyId: "AKIAREQUESTEREXAMPLE",
  secretAccessKey: "bPxRfiCYEXAMPLEKEYwJalrXUtnFEMI/K7MDENG/",
};
const server = serve({
  buckets: ["copy", "other", "pays", { name: "mine", owner: REQUESTER_OWNER }],
  credentials: [DEFAULT_CREDENTIALS, SESSION, { ...REQUESTER, owner: REQUESTER_OWNER }],
  clock: () => now,
});
afterAll(() => server.stop());
const options: S3Options = server.clientOptions("copy");
const client = new S3Client(options);
const other = new S3Client({ ...options, bucket: "other" });

/** The environment of a child process: without the S3 settings and the proxies of this process. */
const childEnv: Record<string, string | undefined> = { ...bunEnv };
for (const name of ["ACCESS_KEY_ID", "SECRET_ACCESS_KEY", "SESSION_TOKEN", "REGION", "ENDPOINT", "BUCKET"]) {
  childEnv["S3_" + name] = childEnv["AWS_" + name] = undefined;
}
for (const name of ["http_proxy", "https_proxy", "all_proxy", "no_proxy"]) {
  childEnv[name] = childEnv[name.toUpperCase()] = undefined;
}

/** Runs the script in a child process. The script prints one JSON value. */
async function child(script: string, env: Record<string, string | undefined> = {}): Promise<any> {
  await using proc = Bun.spawn({
    cmd: [bunExe(), "-e", script],
    env: { ...childEnv, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  expect({ stderr, exitCode }).toEqual({ stderr: "", exitCode: 0 });
  return JSON.parse(stdout);
}

/** The requests that `run` makes the server answer. */
async function requestsOf(run: () => unknown): Promise<RequestRecord[]> {
  const start = server.requests.length;
  await run();
  return server.requests.slice(start);
}

/** The one request that `run` makes the server answer. */
async function requestOf(run: () => unknown): Promise<RequestRecord> {
  const requests = await requestsOf(run);
  expect(requests.map(request => request.operation)).toEqual(["CopyObject"]);
  return requests[0];
}

function signedHeaders(request: RequestRecord): string {
  return /SignedHeaders=([^,]*)/.exec(request.headers.get("authorization") ?? "")![1];
}

/** The headers of a request that say what the new object is, and who pays for the request. */
function objectHeaders(request: RequestRecord): Record<string, string> {
  const isObjectHeader = /^(content-(type|disposition|encoding)|x-amz-(acl|storage-class|request-payer|meta-.*))$/;
  return Object.fromEntries([...request.headers].filter(([name]) => isObjectHeader.test(name)).sort());
}

/** The object as the server stores it. */
function stored(key: string, bucket = "copy"): ObjectVersion {
  const version = server.buckets.get(bucket)!.current(key);
  if (!version) throw new Error(`${bucket}/${key} does not exist`);
  return version;
}

function bytes(version: ObjectVersion): Buffer {
  return Buffer.concat(version.data.chunks as Uint8Array[]);
}

function text(version: ObjectVersion): string {
  return bytes(version).toString();
}

/** The error of `run`, which has to throw before it returns a promise. */
function thrown(run: () => unknown): any {
  let result: unknown;
  try {
    result = run();
  } catch (error) {
    return error;
  }
  throw new Error(`expected a throw, got ${Bun.inspect(result)}`);
}

/**
 * Checks that the calls of a test since `start` sent nothing. A request that one of them sent is at the server
 * before this request is, and the server answers in that order.
 */
async function sentNothingSince(start: number) {
  await client.exists("sent-nothing.txt");
  expect(server.requests.slice(start).map(request => request.operation)).toEqual(["HeadObject"]);
}

/** A server that reads the head of each request and answers with what `answer` writes to the socket. */
async function listen(answer: (socket: Socket, head: string) => void) {
  const listening = Promise.withResolvers<void>();
  const raw = createServer(socket => {
    let received = "";
    socket.on("error", () => {});
    socket.on("data", chunk => {
      received += chunk.toString("latin1");
      // A copy has no body, so the head is the whole request.
      for (let end; (end = received.indexOf("\r\n\r\n")) !== -1; received = received.slice(end + 4)) {
        answer(socket, received.slice(0, end));
      }
    });
  }).listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  return {
    endpoint: `http://127.0.0.1:${(raw.address() as AddressInfo).port}`,
    [Symbol.dispose]: () => void raw.close(),
  };
}

const COPIED =
  '<CopyObjectResult><LastModified>2026-10-25T12:00:00.000Z</LastModified><ETag>"etag"</ETag></CopyObjectResult>';
const ok = (body: string, connection = "keep-alive") =>
  `HTTP/1.1 200 OK\r\nContent-Type: application/xml\r\nContent-Length: ${body.length}\r\nConnection: ${connection}\r\n\r\n${body}`;

describe("s3 - copy", () => {
  it("is one CopyObject request that has no body", async () => {
    await client.write("one.txt", "hello", { type: "text/x-source" });
    const source = await client.stat("one.txt");

    now = at(5);
    let result!: { etag: string; lastModified: Date };
    const request = await requestOf(async () => (result = await client.copy("one.txt", "one-copy.txt")));

    expect(request.method).toBe("PUT");
    expect(request.key).toBe("one-copy.txt");
    expect(request.headers.get("content-length")).toBe("0");
    expect(request.headers.get("x-amz-copy-source")).toBe("copy/one.txt");
    expect(request.headers.get("x-amz-metadata-directive")).toBeNull();
    expect(request.headers.get("content-type")).toBeNull();
    expect(signedHeaders(request)).toBe("host;x-amz-content-sha256;x-amz-copy-source;x-amz-date");

    const copied = await client.stat("one-copy.txt");
    expect(result).toEqual({ etag: source.etag, lastModified: now });
    expect(result.lastModified).toBeInstanceOf(Date);
    expect({ etag: copied.etag, lastModified: copied.lastModified, size: copied.size }).toEqual({
      etag: result.etag,
      lastModified: result.lastModified,
      size: 5,
    });
    expect(await client.file("one-copy.txt").text()).toBe("hello");
  });

  it("client.copy(), Bun.s3.copy(), S3Client.copy() and file.copyTo()", async () => {
    await client.write("entry.txt", "entry");
    const etag = (await client.stat("entry.txt")).etag;

    expect((await client.copy("entry.txt", "entry-1.txt")).etag).toBe(etag);
    expect((await Bun.s3.copy("entry.txt", "entry-2.txt", options)).etag).toBe(etag);
    expect((await S3Client.copy("entry.txt", "entry-3.txt", options)).etag).toBe(etag);
    expect((await S3Client.copy(client.file("entry.txt"), client.file("entry-4.txt"))).etag).toBe(etag);
    expect((await S3Client.copy(client.file("entry.txt"), "entry-5.txt", options)).etag).toBe(etag);
    expect((await S3Client.copy("entry.txt", client.file("entry-6.txt"))).etag).toBe(etag);
    expect((await client.file("entry.txt").copyTo("entry-7.txt")).etag).toBe(etag);
    expect((await client.file("entry.txt").copyTo(client.file("entry-8.txt"))).etag).toBe(etag);
    // An `s3://` path makes an S3 file, which the types of `Bun.file()` do not say.
    const fromUrl = Bun.file("s3://copy/entry.txt", server.clientOptions() as BlobPropertyBag) as unknown as S3File;
    expect((await fromUrl.copyTo("copy/entry-9.txt")).etag).toBe(etag);
    // `null` is no options, as for the other methods.
    expect((await client.file("entry.txt").copyTo("entry-10.txt", null as unknown as undefined)).etag).toBe(etag);

    for (let i = 1; i <= 10; i++) expect(text(stored(`entry-${i}.txt`))).toBe("entry");
    expect(client.copy.length).toBe(2);
    expect(S3Client.copy.length).toBe(2);
    expect(client.file("entry.txt").copyTo.length).toBe(1);
  });

  it("many copies at once each settle with their own result", async () => {
    const count = 24;
    for (let i = 0; i < count; i += 2) await client.write(`many/source-${i}`, `content ${i}`);
    const copies = Array.from({ length: count }, (_, i) => client.copy(`many/source-${i}`, `many/copy-${i}`));
    Bun.gc(true);
    const results = await Promise.allSettled(copies);
    Bun.gc(true);

    // Each second source does not exist.
    expect(results.map(result => result.status)).toEqual(
      Array.from({ length: count }, (_, i) => (i % 2 === 0 ? "fulfilled" : "rejected")),
    );
    for (const [i, result] of results.entries()) {
      if (result.status === "fulfilled") {
        expect(result.value.etag).toBe(`"${stored(`many/source-${i}`).etag}"`);
        expect(text(stored(`many/copy-${i}`))).toBe(`content ${i}`);
      } else {
        expect(result.reason).toMatchObject({ code: "NoSuchKey", path: `many/source-${i}`, dest: `many/copy-${i}` });
      }
    }
  });

  describe("what the new object has", () => {
    it("the type, the content headers and the metadata of the source", async () => {
      await client.write("report.bin", "report", {
        type: "application/x-report",
        contentDisposition: 'attachment; filename="report.pdf"',
        contentEncoding: "identity",
        metadata: { owner: "1234", project: "alpha" },
      });

      // Of what the client and the file give an upload, a copy sends the acl, the storage class and who pays.
      const tagged = new S3Client({ ...options, metadata: { app: "billing" } });
      const destination = tagged.file("report.txt", {
        type: "text/plain",
        metadata: { from: "file" },
        acl: "public-read",
        storageClass: "STANDARD_IA",
        requestPayer: true,
      });
      const request = await requestOf(() => tagged.file("report.bin").copyTo(destination));
      expect(objectHeaders(request)).toEqual({
        "x-amz-acl": "public-read",
        "x-amz-request-payer": "requester",
        "x-amz-storage-class": "STANDARD_IA",
      });

      expect(stored("report.txt")).toMatchObject({
        contentType: "application/x-report",
        contentDisposition: 'attachment; filename="report.pdf"',
        contentEncoding: "identity",
        userMetadata: { owner: "1234", project: "alpha" },
        storageClass: "STANDARD_IA",
      });
      expect((await client.stat("report.txt")).metadata).toEqual({ owner: "1234", project: "alpha" });
    });

    it("the stored bytes of an object that has a content encoding", async () => {
      const page = Buffer.alloc(4096, "bun ").toString();
      const compressed = Bun.gzipSync(page);
      await client.write("page.html", compressed, { contentEncoding: "gzip" });

      await client.copy("page.html", "page-copy.html");
      const copy = stored("page-copy.html");
      expect(copy.contentEncoding).toBe("gzip");
      expect(bytes(copy)).toEqual(Buffer.from(compressed));
      expect(await client.file("page-copy.html").text()).toBe(page);
    });

    it('metadataDirective: "COPY" says in the request what a copy does without it', async () => {
      await client.write("said.txt", "said", { type: "text/x-said", metadata: { owner: "1234" } });

      const request = await requestOf(() => client.copy("said.txt", "said-copy.txt", { metadataDirective: "COPY" }));
      expect(request.headers.get("x-amz-metadata-directive")).toBe("COPY");
      expect(request.headers.get("content-type")).toBeNull();
      expect(signedHeaders(request)).toBe(
        "host;x-amz-content-sha256;x-amz-copy-source;x-amz-date;x-amz-metadata-directive",
      );
      expect(stored("said-copy.txt")).toMatchObject({ contentType: "text/x-said", userMetadata: { owner: "1234" } });

      for (const metadataDirective of [undefined, null]) {
        // @ts-expect-error null is not in the types
        const silent = await requestOf(() => client.copy("said.txt", "said-copy.txt", { metadataDirective }));
        expect(silent.headers.get("x-amz-metadata-directive")).toBeNull();
      }
    });

    it('metadataDirective: "REPLACE" stores what an upload to the destination stores', async () => {
      await client.write("source.bin", "body", {
        type: "application/x-source",
        contentDisposition: "inline",
        contentEncoding: "identity",
        metadata: { owner: "1234" },
      });

      const request = await requestOf(() =>
        client.copy("source.bin", "replaced.bin", {
          metadataDirective: "REPLACE",
          type: "application/x-replaced",
          contentDisposition: 'attachment; filename="a.bin"',
          contentEncoding: "gzip",
          metadata: { Stage: "clean", checked: "yes" },
        }),
      );
      expect(request.headers.get("x-amz-metadata-directive")).toBe("REPLACE");
      expect(signedHeaders(request)).toBe(
        "content-disposition;content-encoding;host;x-amz-content-sha256;x-amz-copy-source;x-amz-date;x-amz-meta-checked;x-amz-meta-stage;x-amz-metadata-directive",
      );
      expect(stored("replaced.bin")).toMatchObject({
        contentType: "application/x-replaced",
        contentDisposition: 'attachment; filename="a.bin"',
        contentEncoding: "gzip",
        userMetadata: { checked: "yes", stage: "clean" },
      });
      expect(text(stored("replaced.bin"))).toBe("body");

      // Nothing of the source stays. The type is the one of the key of the destination.
      await client.copy("source.bin", "bare.json", { metadataDirective: "REPLACE" });
      const bare = stored("bare.json");
      expect(bare.contentType).toStartWith("application/json");
      expect(bare.contentDisposition).toBeUndefined();
      expect(bare.contentEncoding).toBeUndefined();
      expect(bare.userMetadata).toEqual({});

      // The defaults of an upload: the metadata of the client, and the type and the metadata of the file.
      const tagged = new S3Client({ ...options, metadata: { app: "billing" } });
      await tagged.copy("source.bin", "client-default.bin", { metadataDirective: "REPLACE" });
      expect(stored("client-default.bin").userMetadata).toEqual({ app: "billing" });

      const file = tagged.file("file-default.bin", { type: "text/x-file", metadata: { from: "file" } });
      await tagged.file("source.bin").copyTo(file, { metadataDirective: "REPLACE" });
      expect(stored("file-default.bin")).toMatchObject({ contentType: "text/x-file", userMetadata: { from: "file" } });

      await tagged
        .file("source.bin")
        .copyTo(file, { metadataDirective: "REPLACE", metadata: null, type: "Text/X-Call" });
      // A type is stored in lowercase, as an upload stores it.
      expect(stored("file-default.bin")).toMatchObject({ contentType: "text/x-call", userMetadata: {} });
      // The type of a call is for that call.
      expect(file.type).toStartWith("text/x-file");

      // An object can replace its own metadata.
      await client.copy("source.bin", "source.bin", {
        metadataDirective: "REPLACE",
        type: "text/plain",
        metadata: { edited: "yes" },
      });
      // A type that has a usual form is sent in that form, as an upload sends it.
      expect(stored("source.bin")).toMatchObject({
        contentType: "text/plain;charset=utf-8",
        userMetadata: { edited: "yes" },
      });
      expect(text(stored("source.bin"))).toBe("body");
    });

    it('metadataDirective: "REPLACE" drops the headers of the source that Bun has no option for', async () => {
      const kept = {
        "cache-control": "max-age=3600",
        "content-language": "de",
        "expires": "Thu, 01 Dec 2033 16:00:00 GMT",
      };
      const upload = await fetch(client.presign("cached.txt", { method: "PUT" }), {
        method: "PUT",
        headers: kept,
        body: "cached",
      });
      expect(upload.status).toBe(200);
      const headers = { cacheControl: kept["cache-control"], contentLanguage: "de", expires: kept.expires };
      expect(stored("cached.txt")).toMatchObject(headers);

      await client.copy("cached.txt", "cached-copy.txt");
      expect(stored("cached-copy.txt")).toMatchObject(headers);

      await client.copy("cached.txt", "cached-replaced.txt", { metadataDirective: "REPLACE", type: "text/plain" });
      const replaced = stored("cached-replaced.txt");
      expect([replaced.cacheControl, replaced.contentLanguage, replaced.expires]).toEqual([
        undefined,
        undefined,
        undefined,
      ]);
    });

    it('metadataDirective: "REPLACE" sends the object headers of an upload to the same destination', async () => {
      await client.write("mirror.bin", "mirror", { type: "application/x-source", metadata: { owner: "source" } });
      const source = client.file("mirror.bin");
      const replace = { metadataDirective: "REPLACE" } as const;
      const settings = {
        acl: "public-read",
        storageClass: "ONEZONE_IA",
        requestPayer: true,
        metadata: { from: "settings" },
      } as const;
      const content = { type: "text/x-set", contentDisposition: "attachment", contentEncoding: "identity" } as const;
      const configured = new S3Client({ ...options, ...settings });
      const file = () => client.file("mirror-file.bin", { ...settings, type: "text/x-file" });
      const all = { ...settings, ...content };

      // The settings come from the client, from the file of the destination, and from the call.
      const cases: [upload: () => Promise<unknown>, ...copies: (() => Promise<unknown>)[]][] = [
        [
          () => configured.write("mirror.json", "x"),
          () => configured.copy("mirror.bin", "mirror.json", replace),
          () => source.copyTo(configured.file("mirror.json"), replace),
          () => S3Client.copy(source, configured.file("mirror.json"), replace),
        ],
        [
          () => file().write("x"),
          () => source.copyTo(file(), replace),
          () => S3Client.copy("mirror.bin", file(), replace),
          () => S3Client.copy(source, file(), replace),
        ],
        [
          () => client.write("mirror-call.bin", "x", all),
          () => client.copy("mirror.bin", "mirror-call.bin", { ...replace, ...all }),
          () => source.copyTo("mirror-call.bin", { ...replace, ...all }),
          () => source.copyTo(file(), { ...replace, ...all }),
          () => S3Client.copy("mirror.bin", "mirror-call.bin", { ...options, ...replace, ...all }),
        ],
      ];
      for (const [upload, ...copies] of cases) {
        const [uploaded] = await requestsOf(upload);
        expect(uploaded.operation).toBe("PutObject");
        const expected = objectHeaders(uploaded);
        expect(Object.keys(expected)).toContain("x-amz-meta-from");
        for (const copy of copies) expect(objectHeaders(await requestOf(copy))).toEqual(expected);
      }
    });

    it("the acl and the storage class of the destination, not those of the source", async () => {
      await client.write("cold.txt", "cold", { storageClass: "STANDARD_IA" });
      expect(stored("cold.txt").storageClass).toBe("STANDARD_IA");

      await client.copy("cold.txt", "warm.txt");
      expect(stored("warm.txt").storageClass).toBe("STANDARD");

      const archive = new S3Client({ ...options, storageClass: "ONEZONE_IA", acl: "public-read", requestPayer: true });
      const request = await requestOf(() => archive.copy("cold.txt", "archive.txt"));
      expect(objectHeaders(request)).toEqual({
        "x-amz-acl": "public-read",
        "x-amz-request-payer": "requester",
        "x-amz-storage-class": "ONEZONE_IA",
      });
      expect(signedHeaders(request)).toBe(
        "host;x-amz-acl;x-amz-content-sha256;x-amz-copy-source;x-amz-date;x-amz-request-payer;x-amz-storage-class",
      );
      expect(stored("archive.txt").storageClass).toBe("ONEZONE_IA");

      // A copy onto itself has to change something, and the storage class is something.
      await expect(client.copy("cold.txt", "cold.txt")).rejects.toMatchObject({ code: "InvalidRequest" });
      await client.copy("cold.txt", "cold.txt", { storageClass: "GLACIER_IR" });
      expect(stored("cold.txt").storageClass).toBe("GLACIER_IR");
    });

    it("nothing of the file of the source, for a destination that is a key", async () => {
      await client.write("handle.txt", "handle");
      const handle = client.file("handle.txt", {
        type: "text/x-handle",
        acl: "public-read",
        storageClass: "STANDARD_IA",
        metadata: { from: "handle" },
      });

      // The key is at the endpoint and in the bucket of the file. What the file gives an upload stays with the file.
      expect(objectHeaders(await requestOf(() => handle.copyTo("handle-1.txt")))).toEqual({});
      const replaced = await requestOf(() => handle.copyTo("handle-2.json", { metadataDirective: "REPLACE" }));
      expect(objectHeaders(replaced)).toEqual({ "content-type": "application/json;charset=utf-8" });
      expect(replaced.bucket).toBe("copy");
    });

    it("the requestPayer of the file of the source goes with the request", async () => {
      await client.write("paid.txt", "paid", { bucket: "pays", acl: "public-read" });
      server.buckets.get("pays")!.requestPayer = "Requester";
      // Another account reads the bucket only when it accepts the charge.
      const requester = { ...options, ...REQUESTER };
      const mine = new S3Client({ ...requester, bucket: "mine" });
      const paid = new S3Client({ ...requester, bucket: "pays", requestPayer: true }).file("paid.txt");
      const unpaid = new S3Client({ ...requester, bucket: "pays" }).file("paid.txt");
      expect(await paid.text()).toBe("paid");
      await expect(unpaid.text()).rejects.toMatchObject({ code: "AccessDenied" });

      const copies = [
        () => paid.copyTo(mine.file("paid-1.txt")),
        () => S3Client.copy(paid, mine.file("paid-2.txt")),
        () => paid.copyTo("paid-3.txt", { bucket: "mine" }),
        () => S3Client.copy(paid, "paid-4.txt", { ...requester, bucket: "mine" }),
      ];
      for (const [index, copy] of copies.entries()) {
        const request = await requestOf(copy);
        expect([request.status, request.headers.get("x-amz-request-payer")]).toEqual([200, "requester"]);
        expect(text(stored(`paid-${index + 1}.txt`, "mine"))).toBe("paid");
      }

      const denied = { name: "S3Error", code: "AccessDenied", path: "paid.txt" };
      await expect(unpaid.copyTo(mine.file("unpaid.txt"))).rejects.toMatchObject(denied);
      // The options of the call decide.
      await expect(paid.copyTo(mine.file("unpaid.txt"), { requestPayer: false })).rejects.toMatchObject(denied);
      expect((await requestOf(() => unpaid.copyTo(mine.file("paid-5.txt"), { requestPayer: true }))).status).toBe(200);
    });
  });

  it("signs the copy headers in the order of their names, between the other headers", async () => {
    const session = new S3Client({ ...options, ...SESSION });
    await session.write("signed.txt", "signed");
    const etag = (await session.stat("signed.txt")).etag;

    const request = await requestOf(() =>
      session.copy("signed.txt", "signed-copy.txt", {
        metadataDirective: "REPLACE",
        metadata: { z: "last", a: "first", data: "between" },
        contentDisposition: "inline",
        contentEncoding: "identity",
        acl: "public-read",
        storageClass: "STANDARD_IA",
        requestPayer: true,
        copySourceIfMatch: etag,
        copySourceIfNoneMatch: '"0"',
        copySourceIfModifiedSince: new Date("2026-01-02T03:04:05.000Z"),
        copySourceIfUnmodifiedSince: new Date("2036-10-25T13:00:00.000Z"),
      }),
    );
    expect(request.status).toBe(200);
    expect(signedHeaders(request).split(";")).toEqual([
      "content-disposition",
      "content-encoding",
      "host",
      "x-amz-acl",
      "x-amz-content-sha256",
      "x-amz-copy-source",
      "x-amz-copy-source-if-match",
      "x-amz-copy-source-if-modified-since",
      "x-amz-copy-source-if-none-match",
      "x-amz-copy-source-if-unmodified-since",
      "x-amz-date",
      "x-amz-meta-a",
      "x-amz-meta-data",
      "x-amz-meta-z",
      "x-amz-metadata-directive",
      "x-amz-request-payer",
      "x-amz-security-token",
      "x-amz-storage-class",
    ]);
    expect(Object.fromEntries([...request.headers].filter(([name]) => name.startsWith("x-amz-copy-source")))).toEqual({
      "x-amz-copy-source": "copy/signed.txt",
      "x-amz-copy-source-if-match": etag,
      "x-amz-copy-source-if-modified-since": "Fri, 02 Jan 2026 03:04:05 GMT",
      "x-amz-copy-source-if-none-match": '"0"',
      "x-amz-copy-source-if-unmodified-since": "Sat, 25 Oct 2036 13:00:00 GMT",
    });
    expect(stored("signed-copy.txt")).toMatchObject({
      storageClass: "STANDARD_IA",
      userMetadata: { a: "first", data: "between", z: "last" },
    });
  });

  describe("conditions", () => {
    it("copySourceIfMatch copies the object that has the entity tag", async () => {
      await client.write("staged.txt", "scanned");
      const scanned = (await client.stat("staged.txt")).etag;
      await client.write("final.txt", "previous");

      // The staged object changes after the scan.
      await client.write("staged.txt", "swapped");
      const error = await client.copy("staged.txt", "final.txt", { copySourceIfMatch: scanned }).catch(e => e);
      expect(error).toMatchObject({
        name: "S3Error",
        code: "PreconditionFailed",
        path: "staged.txt",
        dest: "final.txt",
      });
      expect(text(stored("final.txt"))).toBe("previous");

      await client.write("staged.txt", "scanned");
      expect((await client.copy("staged.txt", "final.txt", { copySourceIfMatch: scanned })).etag).toBe(scanned);
      expect(text(stored("final.txt"))).toBe("scanned");
    });

    it("copySourceIfNoneMatch, copySourceIfModifiedSince and copySourceIfUnmodifiedSince", async () => {
      now = at(-120);
      await client.write("when.txt", "when");
      const etag = (await client.stat("when.txt")).etag;
      now = at(0);
      const before = at(-150);
      const after = at(-60);
      const failed = { name: "S3Error", code: "PreconditionFailed" };
      const copy = (conditions: S3CopyOptions) => client.copy("when.txt", "when-copy.txt", conditions);

      await expect(copy({ copySourceIfNoneMatch: etag })).rejects.toMatchObject(failed);
      await expect(copy({ copySourceIfNoneMatch: '"0"' })).resolves.toMatchObject({ etag });

      await expect(copy({ copySourceIfModifiedSince: after })).rejects.toMatchObject(failed);
      await expect(copy({ copySourceIfModifiedSince: before })).resolves.toMatchObject({ etag });

      await expect(copy({ copySourceIfUnmodifiedSince: before })).rejects.toMatchObject(failed);
      await expect(copy({ copySourceIfUnmodifiedSince: after })).resolves.toMatchObject({ etag });

      // An entity tag that matches decides before the time does, as in a GET.
      await expect(copy({ copySourceIfMatch: etag, copySourceIfUnmodifiedSince: before })).resolves.toMatchObject({
        etag,
      });
      await expect(copy({ copySourceIfNoneMatch: '"0"', copySourceIfModifiedSince: after })).resolves.toMatchObject({
        etag,
      });
      await expect(copy({ copySourceIfMatch: '"0"', copySourceIfUnmodifiedSince: after })).rejects.toMatchObject(
        failed,
      );
    });

    it("a Date goes out as an HTTP date, and an entity tag without the spaces around it", async () => {
      await client.write("dates.txt", "dates");
      const sent = async (conditions: S3CopyOptions) => {
        const request = await requestOf(() => client.copy("dates.txt", "dates-copy.txt", conditions).catch(() => {}));
        return Object.fromEntries([...request.headers].filter(([name]) => name.startsWith("x-amz-copy-source-if-")));
      };
      expect(
        await sent({
          copySourceIfModifiedSince: new Date("2026-01-02T03:04:05.678Z"),
          copySourceIfUnmodifiedSince: new Date("3000-12-31T23:59:59.999Z"),
          copySourceIfNoneMatch: '  "0" ',
        }),
      ).toEqual({
        "x-amz-copy-source-if-modified-since": "Fri, 02 Jan 2026 03:04:05 GMT",
        "x-amz-copy-source-if-unmodified-since": "Wed, 31 Dec 3000 23:59:59 GMT",
        "x-amz-copy-source-if-none-match": '"0"',
      });
      // The first instant of the time of JavaScript is a date as each other one.
      for (const epoch of [new Date(0), new Date(0.5), new Date(999)]) {
        expect(await sent({ copySourceIfModifiedSince: epoch })).toEqual({
          "x-amz-copy-source-if-modified-since": "Thu, 01 Jan 1970 00:00:00 GMT",
        });
      }
    });
  });

  describe("what a key names", () => {
    it("reads the object that the same key names in every other method", async () => {
      const keys = [
        "sp ace+plus?.txt",
        "100%.txt",
        "per%20cent.txt",
        "ünï/cødé 🥟.txt",
        "dir/sub/",
        "/lead.txt",
        "a\\b.txt",
        "//double//slash//",
        "semi;colon&amp=equals,comma.txt",
      ];
      for (const [index, key] of keys.entries()) {
        await client.write(key, `content of ${index}`);
        const written = server.requests.at(-1)!.key!;

        const request = await requestOf(() => client.copy(key, `names/${index}`));
        expect(decodeURIComponent(request.headers.get("x-amz-copy-source")!)).toBe("copy/" + written);
        expect(text(stored(`names/${index}`))).toBe(`content of ${index}`);

        // And it writes the object that the same key names.
        await client.copy(`names/${index}`, key + ".copy");
        expect(await client.file(key + ".copy").text()).toBe(`content of ${index}`);
      }
      expect(server.requests.at(-2)!.headers.get("x-amz-copy-source")).toBe("copy/names/8");
    });

    it("percent-encodes the source", async () => {
      await client.write("sp ace+plus?.txt", "x");
      const request = await requestOf(() => client.copy("sp ace+plus?.txt", "encoded.txt"));
      expect(request.headers.get("x-amz-copy-source")).toBe("copy/sp%20ace%2Bplus%3F.txt");
    });

    it("reads a key that is a Buffer before it reads the options", async () => {
      await client.write("buffer.txt", "buffer");
      const sources = [Buffer.from("buffer.txt"), Buffer.from("buffer.txt")];
      const destinations = [Buffer.from("buffer-1.txt"), Buffer.from("buffer-2.txt")];
      const changing = (index: number) => ({
        ...options,
        get acl() {
          sources[index].fill("x");
          destinations[index].fill("y");
          return undefined;
        },
      });
      // @ts-expect-error the types have a key as a string
      let request = await requestOf(() => client.copy(sources[0], destinations[0], changing(0)));
      expect([request.headers.get("x-amz-copy-source"), request.key]).toEqual(["copy/buffer.txt", "buffer-1.txt"]);
      // @ts-expect-error the types have a key as a string
      request = await requestOf(() => S3Client.copy(sources[1], destinations[1], changing(1)));
      expect([request.headers.get("x-amz-copy-source"), request.key]).toEqual(["copy/buffer.txt", "buffer-2.txt"]);
    });

    it("a source key is in the bucket of the destination", async () => {
      await client.write("same.txt", "in copy");
      await other.write("same.txt", "in other");

      await client.copy("same.txt", "from-key.txt", { bucket: "other" });
      expect(text(stored("from-key.txt", "other"))).toBe("in other");

      await S3Client.copy("same.txt", other.file("from-key-2.txt"));
      expect(text(stored("from-key-2.txt", "other"))).toBe("in other");
    });

    it("copies between two buckets with a file for the source", async () => {
      await client.write("across.txt", "from copy");

      let request = await requestOf(() => client.file("across.txt").copyTo(other.file("across-1.txt")));
      expect(request.bucket).toBe("other");
      expect(request.headers.get("x-amz-copy-source")).toBe("copy/across.txt");
      expect(text(stored("across-1.txt", "other"))).toBe("from copy");

      // A destination key is next to the file, unless the options say where.
      await client.file("across.txt").copyTo("across-2.txt", { bucket: "other" });
      expect(text(stored("across-2.txt", "other"))).toBe("from copy");
      await client.file("across.txt").copyTo("across-3.txt");
      expect(text(stored("across-3.txt"))).toBe("from copy");

      await S3Client.copy(client.file("across.txt"), other.file("across-4.txt"));
      expect(text(stored("across-4.txt", "other"))).toBe("from copy");

      // Without a bucket in the credentials, the bucket is the first part of a path.
      const anywhere = new S3Client(server.clientOptions());
      request = await requestOf(() => anywhere.copy("copy/across.txt", "other/across-5.txt"));
      expect(request.headers.get("x-amz-copy-source")).toBe("copy/across.txt");
      await S3Client.copy("s3://copy/across.txt", "s3://other/across-6.txt", server.clientOptions());
      expect(text(stored("across-5.txt", "other"))).toBe("from copy");
      expect(text(stored("across-6.txt", "other"))).toBe("from copy");
    });

    it("the scheme of the endpoint of the source is not a part of where the source is", async () => {
      await client.write("scheme.txt", "scheme");
      const secure = new S3Client({ ...options, endpoint: `https://127.0.0.1:${server.port}` });
      const request = await requestOf(() => secure.file("scheme.txt").copyTo(client.file("scheme-copy.txt")));
      expect(request.headers.get("x-amz-copy-source")).toBe("copy/scheme.txt");
      expect(text(stored("scheme-copy.txt"))).toBe("scheme");
    });

    describe("with a virtual hosted-style endpoint", () => {
      const hosted = (bucket: string, named?: string) =>
        new S3Client({
          ...server.clientOptions(named),
          endpoint: server.virtualHostedUrl(bucket),
          virtualHostedStyle: true,
        });

      it("the bucket option names the bucket that is in the host name", async () => {
        await client.write("hosted.txt", "hosted");

        const request = await requestOf(() => hosted("copy", "copy").copy("hosted.txt", "hosted-1.txt"));
        expect(request.headers.get("host")).toBe(`copy.localhost:${server.port}`);
        expect(request.headers.get("x-amz-copy-source")).toBe("copy/hosted.txt");
        expect(text(stored("hosted-1.txt"))).toBe("hosted");

        // These endpoints are one service: they differ in the bucket only.
        await hosted("copy", "copy").file("hosted.txt").copyTo(hosted("other", "other").file("hosted-2.txt"));
        expect(text(stored("hosted-2.txt", "other"))).toBe("hosted");
        // A path-style endpoint on the same host is that service too.
        const pathStyle = new S3Client({ ...options, endpoint: `http://localhost:${server.port}` });
        await pathStyle.file("hosted.txt").copyTo(hosted("other", "other").file("hosted-3.txt"));
        expect(text(stored("hosted-3.txt", "other"))).toBe("hosted");
        // The destination can be without the option. Its requests go to its host.
        await hosted("copy", "copy").file("hosted.txt").copyTo(hosted("copy").file("hosted-4.txt"));
        expect(text(stored("hosted-4.txt"))).toBe("hosted");
      });

      it("a bucket option that is not the bucket of the host name throws", async () => {
        await client.write("hosted.txt", "in copy");
        await other.write("hosted.txt", "in other");
        const mismatch = (role: string, bucket: string, host: string) => ({
          name: "TypeError",
          message: `The ${role} of a copy has the bucket "${bucket}", but its virtual hosted-style endpoint "${host}.localhost:${server.port}" does not name that bucket`,
        });

        // Each other method of these clients reads the bucket of the host.
        expect(await hosted("copy", "other").file("hosted.txt").text()).toBe("in copy");
        expect(thrown(() => hosted("copy", "other").copy("hosted.txt", "b"))).toMatchObject(
          mismatch("destination", "other", "copy"),
        );
        expect(thrown(() => hosted("copy", "copy").copy("hosted.txt", "b", { bucket: "other" }))).toMatchObject(
          mismatch("destination", "other", "copy"),
        );
        expect(thrown(() => hosted("copy", "other").file("hosted.txt").copyTo(client.file("b")))).toMatchObject(
          mismatch("source", "other", "copy"),
        );
        expect(thrown(() => client.file("hosted.txt").copyTo(hosted("other", "copy").file("b")))).toMatchObject(
          mismatch("destination", "copy", "other"),
        );

        // A host of Amazon S3 or of R2 says which bucket it is the host of. These are all of `my.bucket`, and the
        // last one is of `my.bucket.s3`.
        const start = server.requests.length;
        const account = Buffer.alloc(16, 0xab).toString("hex");
        for (const endpoint of [
          "https://my.bucket.s3.us-east-1.amazonaws.com",
          "https://my.bucket.s3.dualstack.eu-west-1.amazonaws.com",
          "https://my.bucket.s3.cn-north-1.amazonaws.com.cn",
          "https://my.bucket.s3.amazonaws.com",
          "https://my.bucket.s3-fips.us-gov-west-1.amazonaws.com",
          "https://my.bucket.s3-fips.dualstack.us-east-1.amazonaws.com",
          "https://my.bucket.s3-accelerate.amazonaws.com",
          "https://my.bucket.s3-us-west-2.amazonaws.com",
          `https://my.bucket.${account}.r2.cloudflarestorage.com`,
          `https://my.bucket.${account}.eu.r2.cloudflarestorage.com`,
          "https://my.bucket.s3.s3.amazonaws.com",
        ]) {
          for (const bucket of ["my", "bucket", "my.bucket.s3.s3.amazonaws"]) {
            const named = new S3Client({ ...DEFAULT_CREDENTIALS, endpoint, virtualHostedStyle: true, bucket });
            expect(thrown(() => named.copy("a", "b"))).toMatchObject({
              name: "TypeError",
              message: `The destination of a copy has the bucket "${bucket}", but its virtual hosted-style endpoint "${endpoint.slice(8)}" does not name that bucket`,
            });
          }
        }
        await sentNothingSince(start);
      });

      it("a host that does not say which bucket it is the host of needs the bucket option for a source", async () => {
        const before = server.requests.length;
        await expect(hosted("copy").copy("hosted.txt", "hosted-5.txt")).rejects.toMatchObject({
          name: "S3Error",
          code: "ERR_S3_INVALID_PATH",
          message:
            'The bucket of the source of a copy is not known: a virtual hosted-style endpoint has it in the host name only. Set the "bucket" option',
          path: "hosted.txt",
          dest: "hosted-5.txt",
        });
        // An access point of Amazon S3 and an endpoint of PrivateLink are such hosts too.
        for (const host of [
          "my-access-point-123456789012.s3-accesspoint.us-east-1.amazonaws.com",
          "bucket.vpce-1a2b3c4d-5e6f.s3.us-east-1.vpce.amazonaws.com",
          "my-bucket.s3-website-us-east-1.amazonaws.com",
        ]) {
          const unknown = new S3Client({
            ...DEFAULT_CREDENTIALS,
            endpoint: `https://${host}`,
            virtualHostedStyle: true,
          });
          await expect(unknown.copy("a.txt", "b.txt")).rejects.toMatchObject({
            code: "ERR_S3_INVALID_PATH",
            message: expect.stringContaining('Set the "bucket" option'),
          });
        }

        // Bun cannot tell that two such hosts are one service.
        expect(thrown(() => hosted("copy", "copy").file("hosted.txt").copyTo(hosted("other").file("b")))).toMatchObject(
          {
            name: "TypeError",
            message: `The source of a copy is at "copy.localhost:${server.port}" and the destination is at "other.localhost:${server.port}": a server-side copy runs inside one service. If the two are one service, set the "bucket" option of each virtual hosted-style endpoint`,
          },
        );
        await sentNothingSince(before);
      });

      it("a host of Amazon S3 or of R2 says which bucket it is the host of, and where its objects are", async () => {
        await client.write("known.txt", "known");
        await client.write("prefix/known.txt", "known in prefix");
        // The requests of the child go to this proxy. It gives the ones for Amazon S3 to the server, with their host.
        const asked: string[] = [];
        await using proxy = Bun.serve({
          port: 0,
          async fetch(request) {
            const host = request.headers.get("host")!;
            asked.push(`${host} ${new URL(request.url).pathname} ${request.headers.get("x-amz-copy-source")}`);
            if (host.endsWith(".amazonaws.com")) return server.fetch(request);
            return new Response(COPIED, { headers: { "content-type": "application/xml" } });
          },
        });
        const account = Buffer.alloc(16, 0xab).toString("hex");
        const r2 = `${account}.r2.cloudflarestorage.com`;
        const results = await child(
          `
          const { S3Client } = require("bun");
          const options = ${JSON.stringify({ ...server.clientOptions(), region: "us-east-1" })};
          const at = (host, more) => new S3Client({ ...options, endpoint: "http://" + host, ...more });
          const hosted = host => at(host, { virtualHostedStyle: true });
          const aws = bucket => hosted(bucket + ".s3.us-east-1.amazonaws.com");
          const copies = [
            () => aws("copy").copy("known.txt", "known-1.txt"),
            () => aws("copy").file("known.txt").copyTo("known-2.txt"),
            () => aws("copy").file("known.txt").copyTo(aws("other").file("known-3.txt")),
            () => aws("copy").file("known.txt").copyTo(at("s3.us-west-2.amazonaws.com", { bucket: "other" }).file("known-4.txt")),
            () => hosted("copy.s3.dualstack.us-east-1.amazonaws.com").copy("known.txt", "known-5.txt"),
            () => hosted("copy.s3-fips.us-east-1.amazonaws.com").copy("known.txt", "known-6.txt"),
            () => hosted("copy.s3-us-east-1.amazonaws.com").copy("known.txt", "known-7.txt"),
            () => hosted("copy.s3-accelerate.amazonaws.com").copy("known.txt", "known-8.txt"),
            () => hosted("copy.s3.amazonaws.com").copy("known.txt", "known-9.txt"),
            // These hosts have the S3 API at their root, so the path of an endpoint is a part of where an object is.
            () => hosted("copy.s3.us-east-1.amazonaws.com/prefix").copy("known.txt", "known-10.txt"),
            () => at("s3.us-east-1.amazonaws.com/copy").copy("prefix/known.txt", "prefix/known-11.txt"),
            () => hosted("my-bucket.${r2}").copy("known.txt", "known-12.txt"),
            () => hosted("my-bucket.${r2}").file("known.txt").copyTo(hosted("their-bucket.${r2}").file("known-13.txt")),
            () => at("${r2}/my-bucket").copy("dir/known.txt", "dir/known-14.txt"),
            // In another host, the path of an endpoint is where the S3 API is.
            () => at("project.supabase.co/storage/v1/s3", { bucket: "copy" }).copy("known.txt", "known-15.txt"),
          ];
          const results = [];
          for (const copy of copies) results.push(await copy().then(result => typeof result.etag, error => error.code + ": " + error.message));
          console.log(JSON.stringify(results));
          `,
          { http_proxy: proxy.url.href },
        );
        expect(results).toEqual(Array.from({ length: 15 }, () => "string"));
        expect(asked).toEqual([
          "copy.s3.us-east-1.amazonaws.com /known-1.txt copy/known.txt",
          "copy.s3.us-east-1.amazonaws.com /known-2.txt copy/known.txt",
          "other.s3.us-east-1.amazonaws.com /known-3.txt copy/known.txt",
          "s3.us-west-2.amazonaws.com /other/known-4.txt copy/known.txt",
          "copy.s3.dualstack.us-east-1.amazonaws.com /known-5.txt copy/known.txt",
          "copy.s3-fips.us-east-1.amazonaws.com /known-6.txt copy/known.txt",
          "copy.s3-us-east-1.amazonaws.com /known-7.txt copy/known.txt",
          "copy.s3-accelerate.amazonaws.com /known-8.txt copy/known.txt",
          "copy.s3.amazonaws.com /known-9.txt copy/known.txt",
          "copy.s3.us-east-1.amazonaws.com /prefix/known-10.txt copy/prefix/known.txt",
          "s3.us-east-1.amazonaws.com /copy/prefix/known-11.txt copy/prefix/known.txt",
          `my-bucket.${r2} /known-12.txt my-bucket/known.txt`,
          `their-bucket.${r2} /known-13.txt my-bucket/known.txt`,
          `${r2} /my-bucket/dir/known-14.txt my-bucket/dir/known.txt`,
          "project.supabase.co /storage/v1/s3/copy/known-15.txt copy/known.txt",
        ]);
        for (let i = 1; i <= 9; i++) {
          expect(text(stored(`known-${i}.txt`, i === 3 || i === 4 ? "other" : "copy"))).toBe("known");
        }
        expect(text(stored("prefix/known-10.txt"))).toBe("known in prefix");
        expect(text(stored("prefix/known-11.txt"))).toBe("known in prefix");
      });
    });
  });

  describe("credentials", () => {
    it.each(["S3", "AWS"])("the %s_* variables of the environment", async prefix => {
      await client.write(`${prefix}-env.txt`, "env");
      const results = await child(
        `
        const { S3Client } = require("bun");
        const results = [
          await S3Client.copy("${prefix}-env.txt", "${prefix}-env-1.txt"),
          await Bun.s3.copy("${prefix}-env.txt", "${prefix}-env-2.txt"),
          await Bun.s3.file("${prefix}-env.txt").copyTo("${prefix}-env-3.txt"),
          await S3Client.copy(Bun.s3.file("${prefix}-env.txt"), "${prefix}-env-4.txt"),
        ];
        console.log(JSON.stringify(results.map(result => typeof result.etag)));
        `,
        {
          [`${prefix}_ACCESS_KEY_ID`]: SESSION.accessKeyId,
          [`${prefix}_SECRET_ACCESS_KEY`]: SESSION.secretAccessKey,
          [`${prefix}_SESSION_TOKEN`]: SESSION.sessionToken,
          [`${prefix}_BUCKET`]: "copy",
          [`${prefix}_ENDPOINT`]: options.endpoint,
        },
      );
      expect(results).toEqual(["string", "string", "string", "string"]);
      const copies = server.requests.filter(request => request.key?.startsWith(`${prefix}-env-`));
      expect(
        copies.map(request => [
          request.operation,
          /Credential=([^/]+)/.exec(request.headers.get("authorization")!)![1],
          request.headers.get("x-amz-security-token"),
        ]),
      ).toEqual(Array.from({ length: 4 }, () => ["CopyObject", SESSION.accessKeyId, SESSION.sessionToken]));
    });

    it("the request is signed with the credentials of the destination only", async () => {
      await client.write("mixed.txt", "mixed");
      const session = new S3Client({ ...options, ...SESSION });
      const signer = async (run: () => unknown) => {
        const request = await requestOf(run);
        const accessKeyId = /Credential=([^/]+)/.exec(request.headers.get("authorization")!)![1];
        return [accessKeyId, request.headers.get("x-amz-security-token")];
      };
      const byDefault = [DEFAULT_CREDENTIALS.accessKeyId, null];
      const bySession = [SESSION.accessKeyId, SESSION.sessionToken];

      // The keys and the session token of the source do not go out.
      expect(await signer(() => session.file("mixed.txt").copyTo(client.file("mixed-1.txt")))).toEqual(byDefault);
      expect(await signer(() => S3Client.copy(session.file("mixed.txt"), client.file("mixed-2.txt")))).toEqual(
        byDefault,
      );
      expect(await signer(() => S3Client.copy(session.file("mixed.txt"), "mixed-3.txt", options))).toEqual(byDefault);
      // The ones of the destination do.
      expect(await signer(() => client.file("mixed.txt").copyTo(session.file("mixed-4.txt")))).toEqual(bySession);
      expect(await signer(() => S3Client.copy("mixed.txt", session.file("mixed-5.txt")))).toEqual(bySession);
      // A destination key of `copyTo` has the credentials of the file.
      expect(await signer(() => session.file("mixed.txt").copyTo("mixed-6.txt"))).toEqual(bySession);
    });
  });

  describe("errors", () => {
    it("names the source in path and the destination in dest", async () => {
      const error = await client.copy("missing.txt", "never.txt").catch(e => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({ name: "S3Error", code: "NoSuchKey", path: "missing.txt", dest: "never.txt" });
      // `dest` is a property as each one that a program adds to an error. `path` is the one of each S3Error.
      expect(Object.getOwnPropertyDescriptor(error, "dest")).toEqual({
        value: "never.txt",
        writable: true,
        enumerable: true,
        configurable: true,
      });
      expect(await client.exists("never.txt")).toBe(false);

      await client.write("exists.txt", "x");
      await expect(client.file("exists.txt").copyTo("s3://x.txt", { bucket: "no-such-bucket" })).rejects.toMatchObject({
        code: "NoSuchBucket",
        path: "exists.txt",
        dest: "x.txt",
      });
      await expect(S3Client.copy("nowhere/exists.txt", "copy/x.txt", server.clientOptions())).rejects.toMatchObject({
        code: "NoSuchBucket",
        path: "nowhere/exists.txt",
        dest: "copy/x.txt",
      });

      // Amazon S3 copies up to 5 GB in one request, and says so for more.
      await client.write("huge.bin", "x");
      stored("huge.bin").size = 5 * 1024 ** 3 + 1;
      await expect(client.copy("huge.bin", "huge-copy.bin")).rejects.toMatchObject({
        name: "S3Error",
        code: "InvalidRequest",
        message: "The specified copy source is larger than the maximum allowable size for a copy source: 5368709120",
        path: "huge.bin",
        dest: "huge-copy.bin",
      });
      stored("huge.bin").size = 1;

      // The other errors of the client have no dest.
      const stat = await client.stat("missing.txt").catch(e => e);
      expect(stat).toMatchObject({ code: "NoSuchKey", path: "missing.txt" });
      expect("dest" in stat).toBe(false);
    });

    it("a 200 answer that carries an error is an error", async () => {
      let body = "";
      await using proxy = Bun.serve({
        port: 0,
        async fetch(request) {
          if (!request.headers.has("x-amz-copy-source")) return server.fetch(request);
          await request.arrayBuffer();
          return new Response(body, { headers: { "content-type": "application/xml" } });
        },
      });
      const faulty = new S3Client({ ...options, endpoint: proxy.url.href });
      await faulty.write("slow.txt", "slow");

      body =
        '<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>InternalError</Code><Message>We encountered an internal error. Please try again.</Message></Error>';
      await expect(faulty.copy("slow.txt", "slow-copy.txt")).rejects.toMatchObject({
        name: "S3Error",
        code: "InternalError",
        message: "We encountered an internal error. Please try again.",
        path: "slow.txt",
        dest: "slow-copy.txt",
      });

      // The service sends white space while a long copy runs.
      body =
        '  \n \n<?xml version="1.0" encoding="UTF-8"?>\n<CopyObjectResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LastModified>2026-10-25T12:00:00.000Z</LastModified><ETag>&quot;9b2cf535f27731c974343645a3985328&quot;</ETag></CopyObjectResult>';
      expect(await faulty.copy("slow.txt", "slow-copy.txt")).toEqual({
        etag: '"9b2cf535f27731c974343645a3985328"',
        lastModified: new Date("2026-10-25T12:00:00.000Z"),
      });

      body = "<html><body>a proxy page</body></html>";
      await expect(faulty.copy("slow.txt", "slow-copy.txt")).rejects.toMatchObject({
        name: "S3Error",
        code: "InvalidResponse",
      });
    });

    it("a request that Bun cannot sign rejects as for each other method, and nothing is sent", async () => {
      const before = server.requests.length;
      const anywhere = new S3Client(server.clientOptions());
      const unsigned = new S3Client({ ...options, accessKeyId: "", secretAccessKey: "" });
      const file = client.file("guard.txt");
      const missing = { name: "S3Error", code: "ERR_S3_MISSING_CREDENTIALS" };
      const invalid = { name: "S3Error", code: "ERR_S3_INVALID_PATH", message: "Invalid S3 bucket, key combination" };

      // Without credentials. For a destination key of `S3Client.copy()`, they are the ones of the environment and
      // of the options.
      await expect(unsigned.copy("a.txt", "b.txt")).rejects.toMatchObject({ ...missing, path: "a.txt", dest: "b.txt" });
      await expect(unsigned.stat("a.txt")).rejects.toMatchObject({ ...missing, path: "a.txt" });
      await expect(S3Client.copy(file, "b.txt")).rejects.toMatchObject({
        ...missing,
        path: "guard.txt",
        dest: "b.txt",
      });
      await expect(file.copyTo(unsigned.file("b.txt"))).rejects.toMatchObject(missing);
      // The credentials come before the keys, as they do in the signature of each request.
      await expect(unsigned.copy("/", "b.txt")).rejects.toMatchObject(missing);

      // A source that has no key, or no bucket.
      await expect(client.copy("/", "b.txt")).rejects.toMatchObject({ ...invalid, dest: "b.txt" });
      await expect(anywhere.copy("only-a-bucket", "copy/b.txt")).rejects.toMatchObject({
        ...invalid,
        path: "only-a-bucket",
        dest: "copy/b.txt",
      });
      // A destination that has none.
      await expect(client.copy("a.txt", "/")).rejects.toMatchObject({ ...invalid, path: "a.txt" });
      await expect(client.write("/", "x")).rejects.toMatchObject(invalid);

      // A bucket that Amazon S3 cannot have in a host name. Each other method of the file rejects too.
      const amazon = new S3Client({ ...DEFAULT_CREDENTIALS, bucket: "copy" });
      const slash = new S3Client({ ...DEFAULT_CREDENTIALS, bucket: "copy/sub", virtualHostedStyle: true });
      await expect(slash.file("a.txt").stat()).rejects.toMatchObject({ code: "ERR_S3_INVALID_ENDPOINT" });
      await expect(slash.file("a.txt").copyTo(amazon.file("b.txt"))).rejects.toMatchObject(invalid);
      await sentNothingSince(before);
    });

    it("a connection that closes before the answer rejects each copy with its own keys", async () => {
      using closing = await listen(socket => socket.destroy());
      const faulty = new S3Client({ ...options, endpoint: closing.endpoint });
      const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => faulty.copy("a.txt", `b-${i}.txt`)));
      Bun.gc(true);
      expect(
        results.map(
          result => result.status === "rejected" && [result.reason.name, result.reason.path, result.reason.dest],
        ),
      ).toEqual(Array.from({ length: 8 }, (_, i) => ["S3Error", "a.txt", `b-${i}.txt`]));
    });

    it("a copy on a connection that the service closed goes out again", async () => {
      // The server answers the first request of a connection, and closes the connection at the second one.
      const requests = new Map<Socket, number>();
      const asked: string[] = [];
      using once = await listen((socket, head) => {
        const count = (requests.get(socket) ?? 0) + 1;
        requests.set(socket, count);
        asked.push(/^PUT \/copy\/(\S+)/.exec(head)![1] + (count === 1 ? "" : " on a connection that closes"));
        if (count === 1) socket.write(ok(COPIED));
        else socket.destroy();
      });
      const reused = new S3Client({ ...options, endpoint: once.endpoint });
      // Until a copy goes out on the connection of the copy before it.
      for (let i = 0; asked.length === i; i++) await reused.copy("a.txt", `b-${i}.txt`);

      // The service can have made the copy at the request that it did not answer.
      const last = asked.length - 2;
      expect(asked.slice(-2)).toEqual([`b-${last}.txt on a connection that closes`, `b-${last}.txt`]);
    });

    it("a worker that stops while its copies are in flight", async () => {
      const worker = `
        const { parentPort, workerData } = require("node:worker_threads");
        const client = new Bun.S3Client({ endpoint: workerData, bucket: "bucket", accessKeyId: "key", secretAccessKey: "secret" });
        for (let i = 0; i < 8; i++) {
          client.copy("a", "b-" + i).catch(() => {});
          client.file("a").copyTo(client.file("c-" + i), { metadataDirective: "REPLACE", metadata: { a: "b" } }).catch(() => {});
          Bun.S3Client.copy(client.file("a"), client.file("d-" + i)).catch(() => {});
        }
        parentPort.postMessage("started");
      `;
      const result = await child(
        `
        const { Worker } = require("node:worker_threads");
        // No copy gets an answer.
        const server = Bun.serve({ port: 0, idleTimeout: 0, fetch: () => new Promise(() => {}) });
        const stopped = await Promise.all(
          Array.from({ length: 4 }, async () => {
            const worker = new Worker(${JSON.stringify(worker)}, { eval: true, workerData: server.url.origin });
            await new Promise((resolve, reject) => {
              worker.once("message", resolve);
              worker.once("error", reject);
            });
            return typeof (await worker.terminate());
          }),
        );
        server.stop(true);
        console.log(JSON.stringify(stopped));
        `,
      );
      expect(result).toEqual(["number", "number", "number", "number"]);
    });
  });

  describe("what throws before a request", () => {
    const file = client.file("guard.txt");
    const invalid = (message: unknown) => ({
      name: "TypeError",
      code: "ERR_INVALID_ARG_TYPE",
      message: message instanceof RegExp ? expect.stringMatching(message) : message,
    });

    it("an argument that is not a key or an S3 file", async () => {
      const start = server.requests.length;
      // @ts-expect-error
      expect(thrown(() => client.copy())).toMatchObject({
        code: "ERR_MISSING_ARGS",
        message: "Expected a path to copy",
      });
      // @ts-expect-error
      expect(thrown(() => client.copy("a"))).toMatchObject({
        code: "ERR_MISSING_ARGS",
        message: "Expected a path to copy to",
      });
      const keys = "client.copy() takes two keys of the client. For an S3File, use copyTo() of the source file";
      // @ts-expect-error
      expect(thrown(() => client.copy(file, "b"))).toMatchObject(invalid(`Expected a path to copy. ${keys}`));
      // @ts-expect-error
      expect(thrown(() => client.copy("a", file))).toMatchObject(invalid(`Expected a path to copy to. ${keys}`));
      // @ts-expect-error
      expect(thrown(() => S3Client.copy())).toMatchObject({
        code: "ERR_MISSING_ARGS",
        message: "Expected a S3 or path to copy",
      });
      // @ts-expect-error
      expect(thrown(() => S3Client.copy("a"))).toMatchObject({
        code: "ERR_MISSING_ARGS",
        message: "Expected a S3 or path to copy to",
      });
      // @ts-expect-error
      expect(thrown(() => S3Client.copy("a", new Blob(["x"])))).toMatchObject(
        invalid("Expected a S3 or path to copy to"),
      );
      // @ts-expect-error
      expect(thrown(() => file.copyTo())).toMatchObject({
        code: "ERR_MISSING_ARGS",
        message: "Expected a S3 or path to copy to",
      });
      // @ts-expect-error
      expect(thrown(() => file.copyTo(Bun.file(import.meta.path)))).toMatchObject(
        invalid("Expected a S3 or path to copy to"),
      );
      expect(thrown(() => file.copyTo.call(Bun.file(import.meta.path), "b"))).toMatchObject({
        code: "ERR_INVALID_THIS",
      });
      // @ts-expect-error
      expect(thrown(() => client.copy("a", "b", "REPLACE"))).toMatchObject(
        invalid("The \"options\" argument must be of type object. Received type string ('REPLACE')"),
      );
      // The message names the argument that is wrong.
      for (const wrong of [{}, 1, true, () => {}, Symbol("key")]) {
        // @ts-expect-error
        expect(thrown(() => S3Client.copy(wrong, "b", options))).toMatchObject(
          invalid("Expected a S3 or path to copy"),
        );
        // @ts-expect-error
        expect(thrown(() => S3Client.copy("a", wrong, options))).toMatchObject(
          invalid("Expected a S3 or path to copy to"),
        );
        // @ts-expect-error
        expect(thrown(() => file.copyTo(wrong))).toMatchObject(invalid("Expected a S3 or path to copy to"));
      }
      await sentNothingSince(start);
    });

    it("a slice of a file", async () => {
      const start = server.requests.length;
      expect(thrown(() => file.slice(0, 2).copyTo("b"))).toMatchObject(
        invalid("The source of a copy cannot be a slice of an S3 file: a server-side copy takes the whole object"),
      );
      expect(thrown(() => S3Client.copy(file.slice(1), "b", options))).toMatchObject(invalid(/^The source of a copy/));
      expect(thrown(() => file.copyTo(client.file("b").slice(0, 2)))).toMatchObject(
        invalid(/^The destination of a copy cannot be a slice/),
      );
      expect(thrown(() => file.copyTo(client.file("b").slice(5)))).toMatchObject(
        invalid(/^The destination of a copy cannot be a slice/),
      );
      await sentNothingSince(start);
    });

    it("a source at another service", async () => {
      const start = server.requests.length;
      const elsewhere = new S3Client({ ...options, endpoint: "http://127.0.0.1:1" });
      const amazon = new S3Client({ ...DEFAULT_CREDENTIALS, bucket: "copy", region: "eu-west-1" });
      const twoServices = (source: string, destination: string) =>
        invalid(
          `The source of a copy is at ${source} and the destination is at ${destination}: a server-side copy runs inside one service`,
        );
      expect(thrown(() => file.copyTo(elsewhere.file("b")))).toMatchObject(
        twoServices(`"127.0.0.1:${server.port}"`, '"127.0.0.1:1"'),
      );
      expect(thrown(() => S3Client.copy(amazon.file("a"), file))).toMatchObject(
        twoServices("Amazon S3 in eu-west-1", `"127.0.0.1:${server.port}"`),
      );
      expect(thrown(() => file.copyTo("b", { endpoint: "https://s3.example.com" }))).toMatchObject(
        twoServices(`"127.0.0.1:${server.port}"`, '"s3.example.com"'),
      );

      const at = (endpoint: string) => new S3Client({ ...DEFAULT_CREDENTIALS, bucket: "copy", endpoint }).file("a");
      const refused = (source: string, destination: string) =>
        expect(thrown(() => at(source).copyTo(at(destination)))).toMatchObject(
          twoServices(`"${source.replace(/^https?:\/\//, "")}"`, `"${destination.replace(/^https?:\/\//, "")}"`),
        );
      // An endpoint can have a path, which is where the S3 API of that host is. Two paths are two services.
      refused("https://gateway.example.com/tenant-a", "https://gateway.example.com/tenant-b");
      // A host of Amazon is not a host of Amazon S3.
      refused(
        "http://ec2-203-0-113-10.compute-1.amazonaws.com:9000",
        "http://ec2-203-0-113-20.compute-1.amazonaws.com:9000",
      );
      expect(
        thrown(() => amazon.file("a").copyTo(at("https://minio-1234567890.eu-west-1.elb.amazonaws.com"))),
      ).toMatchObject(twoServices("Amazon S3 in eu-west-1", '"minio-1234567890.eu-west-1.elb.amazonaws.com"'));
      // Amazon S3 in China and for the government of the United States are services of their own.
      const china = new S3Client({ ...DEFAULT_CREDENTIALS, bucket: "copy", region: "cn-north-1" });
      expect(thrown(() => amazon.file("a").copyTo(china.file("b")))).toMatchObject(
        twoServices("Amazon S3 in eu-west-1", "Amazon S3 in cn-north-1"),
      );
      expect(thrown(() => amazon.file("a").copyTo(at("https://s3.us-gov-west-1.amazonaws.com")))).toMatchObject(
        twoServices("Amazon S3 in eu-west-1", '"s3.us-gov-west-1.amazonaws.com"'),
      );
      refused("https://s3.us-east-1.amazonaws.com", "https://s3-fips.us-gov-east-1.amazonaws.com");
      refused("https://s3.us-east-1.amazonaws.com", "https://s3.cn-north-1.amazonaws.com.cn");
      await sentNothingSince(start);
    });

    it("what replaces the metadata of the source, without the directive", async () => {
      const start = server.requests.length;
      const replaced = { type: "text/plain", contentDisposition: "inline", contentEncoding: "gzip", metadata: {} };
      for (const [name, value] of Object.entries(replaced)) {
        expect(thrown(() => client.copy("a", "b", { [name]: value }))).toMatchObject(
          invalid(
            `${name} needs metadataDirective: "REPLACE". A copy keeps the type, the content headers and the metadata of its source, or it replaces all of them`,
          ),
        );
        expect(thrown(() => client.copy("a", "b", { [name]: value, metadataDirective: "COPY" }))).toMatchObject(
          invalid(new RegExp(`^${name} needs metadataDirective`)),
        );
      }
      expect(thrown(() => file.copyTo("b", { metadata: null }))).toMatchObject(
        invalid(/^metadata needs metadataDirective/),
      );
      await sentNothingSince(start);
    });

    it("an option that has a wrong type or value", async () => {
      const start = server.requests.length;
      const cases: [S3CopyOptions, string][] = [
        // @ts-expect-error
        [{ metadataDirective: "replace" }, 'metadataDirective must be one of "COPY", "REPLACE"'],
        // @ts-expect-error
        [{ metadataDirective: true }, "metadataDirective must be a string"],
        [{ copySourceIfMatch: "" }, "copySourceIfMatch must not be empty"],
        [{ copySourceIfNoneMatch: "  " }, "copySourceIfNoneMatch must not be empty"],
        [{ copySourceIfNoneMatch: "é" }, "copySourceIfNoneMatch must be printable ASCII characters"],
        [
          { copySourceIfMatch: '"a"\r\nx-amz-acl: public-read' },
          "copySourceIfMatch must be printable ASCII characters",
        ],
        [{ copySourceIfModifiedSince: new Date(NaN) }, "copySourceIfModifiedSince must be a valid Date"],
        [
          { copySourceIfModifiedSince: new Date(-1) },
          "copySourceIfModifiedSince must be a Date in the years 1970 to 3000",
        ],
        [
          { copySourceIfUnmodifiedSince: new Date("3001-01-01T00:00:00Z") },
          "copySourceIfUnmodifiedSince must be a Date in the years 1970 to 3000",
        ],
        [{ metadataDirective: "REPLACE", type: "téxt/plain" }, "type must be printable ASCII characters"],
        // The options of an upload are checked as for an upload.
        // @ts-expect-error
        [{ acl: "everyone" }, expect.stringContaining("acl must be one of")],
        [
          { metadataDirective: "REPLACE", metadata: { "a b": "c" } },
          'metadata key "a b" must be a valid HTTP header name',
        ],
      ];
      for (const [copyOptions, message] of cases) {
        expect(thrown(() => client.copy("a", "b", copyOptions))).toMatchObject(invalid(message));
      }

      // A condition is a string, or a Date. `Headers.get("etag")` is `null` for a response that has no entity tag,
      // and a condition that Bun left out would copy an object that nobody looked at.
      const wrong: [name: keyof S3CopyOptions, value: unknown, received: string][] = [
        ["copySourceIfMatch", null, 'The "copySourceIfMatch" argument must be of type string. Received null'],
        ["copySourceIfNoneMatch", null, 'The "copySourceIfNoneMatch" argument must be of type string. Received null'],
        ["copySourceIfMatch", 1, 'The "copySourceIfMatch" argument must be of type string. Received type number (1)'],
        [
          "copySourceIfMatch",
          new Date(0),
          /^The "copySourceIfMatch" argument must be of type string\. Received an instance of Date/,
        ],
        [
          "copySourceIfModifiedSince",
          null,
          'The "copySourceIfModifiedSince" argument must be an instance of Date. Received null',
        ],
        [
          "copySourceIfUnmodifiedSince",
          null,
          'The "copySourceIfUnmodifiedSince" argument must be an instance of Date. Received null',
        ],
        [
          "copySourceIfModifiedSince",
          1_800_000_000_000,
          /^The "copySourceIfModifiedSince" argument must be an instance of Date\. Received type number/,
        ],
        // A string goes to the service as it is in no form: the service would not apply one that it cannot read.
        [
          "copySourceIfUnmodifiedSince",
          "Sat, 25 Oct 2036 13:00:00 GMT",
          /^The "copySourceIfUnmodifiedSince" argument must be an instance of Date\. Received type string/,
        ],
        [
          "copySourceIfUnmodifiedSince",
          "",
          /^The "copySourceIfUnmodifiedSince" argument must be an instance of Date\. Received type string/,
        ],
      ] as any;
      for (const [name, value, message] of wrong) {
        expect(thrown(() => client.copy("a", "b", { [name]: value }))).toMatchObject(invalid(message));
      }
      await sentNothingSince(start);
    });

    it("more metadata than a copy has room for", async () => {
      const metadata = (count: number) =>
        Object.fromEntries(Array.from({ length: count }, (_, index) => [`key-${index}`, `${index}`]));
      const tooMany = invalid("metadata must not have more than 232 keys in a copy");
      const replace = { metadataDirective: "REPLACE" } as const;
      expect(thrown(() => client.copy("a", "b", { ...replace, metadata: metadata(233) }))).toMatchObject(tooMany);

      // An upload has room for 238 keys. The ones of a client and of a file count in a copy that sends them.
      await client.write("room.txt", "room");
      const full = new S3Client({ ...options, metadata: metadata(233) });
      expect(thrown(() => full.copy("room.txt", "room-copy.txt", replace))).toMatchObject(tooMany);
      expect(thrown(() => file.copyTo(client.file("b", { metadata: metadata(233) }), replace))).toMatchObject(tooMany);
      expect(typeof (await full.copy("room.txt", "room-copy.txt")).etag).toBe("string");
      expect(typeof (await full.copy("room.txt", "room-copy.txt", { ...replace, metadata: null })).etag).toBe("string");

      // At the limit, with every other header that a copy can have, the request has each of them.
      // `Bun.serve` takes fewer headers than that, so a socket reads the request.
      const head = Promise.withResolvers<string>();
      using raw = await listen((socket, received) => {
        head.resolve(received);
        socket.end(ok(COPIED, "close"));
      });
      const result = await S3Client.copy("full.txt", "full-copy.txt", {
        ...options,
        ...SESSION,
        endpoint: raw.endpoint,
        ...replace,
        metadata: metadata(232),
        type: "text/plain",
        contentDisposition: "inline",
        contentEncoding: "identity",
        acl: "private",
        storageClass: "STANDARD",
        requestPayer: true,
        copySourceIfMatch: '"1"',
        copySourceIfNoneMatch: '"0"',
        copySourceIfModifiedSince: new Date("2026-01-01T00:00:00Z"),
        copySourceIfUnmodifiedSince: new Date("2036-01-01T00:00:00Z"),
      });
      expect(result).toEqual({ etag: '"etag"', lastModified: new Date("2026-10-25T12:00:00.000Z") });

      const names = (await head.promise)
        .split("\r\n")
        .slice(1)
        .map(line => line.slice(0, line.indexOf(":")).toLowerCase());
      expect(names.filter(name => name.startsWith("x-amz-meta-"))).toHaveLength(232);
      expect(names.filter(name => name.startsWith("x-amz-copy-source")).sort()).toEqual([
        "x-amz-copy-source",
        "x-amz-copy-source-if-match",
        "x-amz-copy-source-if-modified-since",
        "x-amz-copy-source-if-none-match",
        "x-amz-copy-source-if-unmodified-since",
      ]);
      for (const name of [
        "authorization",
        "content-disposition",
        "content-encoding",
        "content-type",
        "x-amz-acl",
        "x-amz-metadata-directive",
        "x-amz-request-payer",
        "x-amz-security-token",
        "x-amz-storage-class",
      ]) {
        expect(names).toContain(name);
      }
    });
  });
});
