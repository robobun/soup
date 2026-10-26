import { describe, expect, test } from "bun:test";
import { bunEnv, bunExe } from "harness";

// `new Response([file])` moves the native store out of an S3 file. GC then frees the store along with the Response.
const prelude = `
const key = "own-key-" + Buffer.alloc(200, "k");
const otherKey = "other-key-" + Buffer.alloc(200, "o");
const client = new Bun.S3Client({ accessKeyId: "a", secretAccessKey: "b", bucket: "bucket", endpoint: process.env.S3_ENDPOINT });
const file = client.file(key);
const move = (moved = file) => void new Response([moved]);
const others = [];
const moveAndFree = (...moved) => {
  for (const each of moved.length ? moved : [file]) move(each);
  for (let i = 0; i < 4; i++) Bun.gc(true);
  for (let i = 0; i < 8; i++) others.push(client.file("other-" + i + "-" + Buffer.alloc(200, "z")));
};
// The fixture answers a copy with the keys and the metadata of the request, in the place of the entity tag.
const copied = async copy => console.log((await copy).etag === "bucket/" + key + " to /bucket/" + otherKey + " with dest");
`;

describe.concurrent("S3 file whose store moves into a Response", () => {
  test.each([
    ["stat() rejects after the move", `move(); console.log(await file.stat().catch(e => e.code));`, "ERR_INVALID_THIS"],
    [
      "unlink() deletes the file when an option getter moves the store",
      `await file.unlink({ get accessKeyId() { move(); return "a"; } }); console.log("deleted");`,
      "deleted",
    ],
    [
      "presign() signs the original key when an option getter moves and frees the store",
      `console.log(new URL(file.presign({ get method() { moveAndFree(); return "GET"; } })).pathname === "/bucket/" + key);`,
      "true",
    ],
    [
      "copyTo() throws after the move",
      `move(); try { file.copyTo("b"); } catch (e) { console.log(e.code); }`,
      "ERR_INVALID_THIS",
    ],
    [
      "copyTo() copies the original key when the first option getter moves and frees the store",
      `const dest = client.file(otherKey, { metadata: { owner: "dest" } });
       await copied(file.copyTo(dest, { metadataDirective: "REPLACE", get accessKeyId() { moveAndFree(); return "a"; } }));`,
      "true",
    ],
    [
      "copyTo() copies the original key when the last option getter moves and frees the store",
      `const dest = client.file(otherKey, { metadata: { owner: "dest" } });
       await copied(file.copyTo(dest, { metadataDirective: "REPLACE", get copySourceIfUnmodifiedSince() { moveAndFree(); } }));`,
      "true",
    ],
    [
      "S3Client.copy() copies between the original keys when an option getter moves and frees both stores",
      `const dest = client.file(otherKey, { metadata: { owner: "dest" } });
       await copied(Bun.S3Client.copy(file, dest, { get metadataDirective() { moveAndFree(file, dest); return "REPLACE"; } }));`,
      "true",
    ],
    [
      "a copy that fails names the original keys when an option getter moves and frees both stores",
      `const dest = client.file(otherKey);
       const error = await file.copyTo(dest, { get acl() { moveAndFree(file, dest); }, copySourceIfMatch: "fail" }).catch(e => e);
       console.log(error.code, error.path === key, error.dest === otherKey);`,
      "PreconditionFailed true true",
    ],
  ])("%s", async (_, script, expected) => {
    using server = Bun.serve({
      port: 0,
      fetch: req => {
        const source = req.headers.get("x-amz-copy-source");
        if (source === null) return new Response(null, { status: req.method === "DELETE" ? 204 : 200 });
        if (req.headers.has("x-amz-copy-source-if-match")) {
          return new Response("<Error><Code>PreconditionFailed</Code><Message>no</Message></Error>", { status: 412 });
        }
        const owner = req.headers.get("x-amz-meta-owner");
        return new Response(
          `<CopyObjectResult><ETag>${source} to ${new URL(req.url).pathname} with ${owner}</ETag></CopyObjectResult>`,
        );
      },
    });
    await using proc = Bun.spawn({
      cmd: [bunExe(), "-e", prelude + script],
      env: { ...bunEnv, S3_ENDPOINT: server.url.href },
      stdout: "pipe",
      stderr: "inherit",
    });
    const [stdout, exitCode] = await Promise.all([proc.stdout.text(), proc.exited]);
    expect(stdout.trim()).toBe(expected);
    expect(exitCode).toBe(0);
  });
});
