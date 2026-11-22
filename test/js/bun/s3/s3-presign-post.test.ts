import { S3Client, type S3File, type S3Options } from "bun";
import { afterAll, describe, expect, it } from "bun:test";
import { bunEnv, bunExe } from "harness";
import { createHmac } from "node:crypto";
import { DEFAULT_CREDENTIALS, DEFAULT_OWNER, serve, type ObjectVersion } from "s3-server";

// The server reads a form as Amazon S3 does: it verifies the signature of the
// policy, and it refuses a field that the policy has no condition for, a
// field that fails its condition, a file outside of `content-length-range`
// and a policy that has expired.
const START = new Date(Math.floor(Date.now() / 1000) * 1000);
let now = START;
// A second key pair, which the server accepts with its session token only.
const SESSION = {
  accessKeyId: "AKIAI44QH8DHBEXAMPLE",
  secretAccessKey: "je7MtGbClwBF/2Zp9Utk/h3yCo8nvbEXAMPLEKEY",
  sessionToken: "AQoDYXdzEPT//////////wEXAMPLEtc764bNrC9SAPBSM22wDOk4x4HIZ8j4FZTwdQW",
};
// The key pair of another account.
const REQUESTER_OWNER = { ...DEFAULT_OWNER, id: Buffer.alloc(32, 7).toString("hex"), accountId: "210987654321" };
const REQUESTER = {
  accessKeyId: "AKIAREQUESTEREXAMPLE",
  secretAccessKey: "bPxRfiCYEXAMPLEKEYwJalrXUtnFEMI/K7MDENG/",
};
const server = serve({
  region: "us-east-1",
  buckets: ["uploads", "other", "pays"],
  credentials: [DEFAULT_CREDENTIALS, SESSION, { ...REQUESTER, owner: REQUESTER_OWNER }],
  clock: () => now,
});
afterAll(() => server.stop());
const options: S3Options = server.clientOptions("uploads");
const client = new S3Client(options);

type Post = ReturnType<S3Client["presignPost"]>;

/** Sends the form the way a browser does: the fields, then the file. */
function upload(
  post: Post,
  file: string | Blob,
  extra: Record<string, string> = {},
  filename?: string,
  headers: Record<string, string> = {},
) {
  const form = new FormData();
  for (const [name, value] of Object.entries({ ...post.fields, ...extra })) form.append(name, value);
  form.append("file", typeof file === "string" ? new Blob([file]) : file, filename);
  return fetch(post.url, { method: "POST", body: form, headers });
}

/** The status of the response and, for an error, what its document says. */
async function result(response: Response) {
  const body = await response.text();
  const entities: Record<string, string> = { quot: '"', apos: "'", lt: "<", gt: ">", amp: "&" };
  const element = (name: string) =>
    new RegExp(`<${name}>([^<]*)</${name}>`).exec(body)?.[1].replace(/&(\w+);/g, (_, entity) => entities[entity]);
  return { status: response.status, code: element("Code"), message: element("Message") };
}

const STORED = { status: 204, code: undefined, message: undefined };

/** The object as the server stores it. */
function stored(key: string, bucket = "uploads"): ObjectVersion {
  const version = server.buckets.get(bucket)!.current(key);
  if (!version) throw new Error(`${bucket}/${key} does not exist`);
  return version;
}

function text(version: ObjectVersion): string {
  return Buffer.concat(version.data.chunks as Uint8Array[]).toString();
}

function policyOf(post: Post): { expiration: string; conditions: unknown[] } {
  return JSON.parse(Buffer.from(post.fields.Policy, "base64").toString("utf8"));
}

/** Signature Version 4 of `policy`, with `node:crypto`. */
function sign(secretAccessKey: string, day: string, region: string, policy: string): string {
  let key: string | Buffer = "AWS4" + secretAccessKey;
  for (const part of [day, region, "s3", "aws4_request"]) key = createHmac("sha256", key).update(part).digest();
  return createHmac("sha256", key).update(policy).digest("hex");
}

/** The signature that the form of `post` has to have. */
function signatureOf(post: Post, secretAccessKey = DEFAULT_CREDENTIALS.secretAccessKey, region = "us-east-1") {
  return sign(secretAccessKey, post.fields["X-Amz-Date"].slice(0, 8), region, post.fields.Policy);
}

/** `20261122T125939Z` as a time in milliseconds. */
function amzDate(value: string): number {
  const [, y, mo, d, h, mi, s] = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value)!;
  return Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
}

/** The fields that say who signed, and the conditions for them. */
function signer(post: Post, accessKeyId = DEFAULT_CREDENTIALS.accessKeyId, region = "us-east-1") {
  const date = post.fields["X-Amz-Date"];
  const fields = {
    bucket: post.fields.bucket,
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${accessKeyId}/${date.slice(0, 8)}/${region}/s3/aws4_request`,
    "X-Amz-Date": date,
  };
  return { fields, conditions: Object.entries(fields).map(([name, value]) => ({ [name]: value })) };
}

/** The fields in front of the policy and the signature, in the order of the form. */
function described(post: Post): [string, string][] {
  const fields = Object.entries(post.fields);
  expect(fields.slice(-2).map(([name]) => name)).toEqual(["Policy", "X-Amz-Signature"]);
  return fields.slice(0, -2);
}

function thrown(run: () => unknown): { name: string; code: unknown; message: string } {
  try {
    run();
  } catch (error: any) {
    return { name: error.name, code: error.code, message: error.message };
  }
  throw new Error("it did not throw");
}

/** The environment of a child process: without the S3 settings of this process. */
const childEnv: Record<string, string | undefined> = { ...bunEnv };
for (const name of ["ACCESS_KEY_ID", "SECRET_ACCESS_KEY", "SESSION_TOKEN", "REGION", "ENDPOINT", "BUCKET"]) {
  childEnv["S3_" + name] = childEnv["AWS_" + name] = undefined;
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

describe("s3 - presignPost", () => {
  it("the test signs as the AWS documentation does", () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-post-example.html
    const policy =
      "eyAiZXhwaXJhdGlvbiI6ICIyMDE1LTEyLTMwVDEyOjAwOjAwLjAwMFoiLA0KICAiY29uZGl0aW9ucyI6IFsNCiAgICB7ImJ1Y2tldCI6ICJzaWd2NGV4YW1wbGVidWNrZXQifSwNCiAgICBbInN0YXJ0cy13aXRoIiwgIiRrZXkiLCAidXNlci91c2VyMS8iXSwNCiAgICB7ImFjbCI6ICJwdWJsaWMtcmVhZCJ9LA0KICAgIHsic3VjY2Vzc19hY3Rpb25fcmVkaXJlY3QiOiAiaHR0cDovL3NpZ3Y0ZXhhbXBsZWJ1Y2tldC5zMy5hbWF6b25hd3MuY29tL3N1Y2Nlc3NmdWxfdXBsb2FkLmh0bWwifSwNCiAgICBbInN0YXJ0cy13aXRoIiwgIiRDb250ZW50LVR5cGUiLCAiaW1hZ2UvIl0sDQogICAgeyJ4LWFtei1tZXRhLXV1aWQiOiAiMTQzNjUxMjM2NTEyNzQifSwNCiAgICB7IngtYW16LXNlcnZlci1zaWRlLWVuY3J5cHRpb24iOiAiQUVTMjU2In0sDQogICAgWyJzdGFydHMtd2l0aCIsICIkeC1hbXotbWV0YS10YWciLCAiIl0sDQoNCiAgICB7IngtYW16LWNyZWRlbnRpYWwiOiAiQUtJQUlPU0ZPRE5ON0VYQU1QTEUvMjAxNTEyMjkvdXMtZWFzdC0xL3MzL2F3czRfcmVxdWVzdCJ9LA0KICAgIHsieC1hbXotYWxnb3JpdGhtIjogIkFXUzQtSE1BQy1TSEEyNTYifSwNCiAgICB7IngtYW16LWRhdGUiOiAiMjAxNTEyMjlUMDAwMDAwWiIgfQ0KICBdDQp9";
    expect(sign("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "20151229", "us-east-1", policy)).toBe(
      "8afdbf4008c03f22c2cd3cdb72e4afbb1f6a588f3255ac628749a66d7f09699e",
    );
  });

  it("returns the URL of the bucket and the fields of the form", () => {
    const before = Math.floor(Date.now() / 1000) * 1000;
    const post = client.presignPost("reports/2026.pdf");
    const after = Date.now();

    expect(post.url).toBe(`${server.url}/uploads`);
    // The form sends them in this order, and the file after them.
    expect(Object.entries(post.fields)).toEqual([
      ["key", "reports/2026.pdf"],
      ["bucket", "uploads"],
      ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
      ["X-Amz-Credential", signer(post).fields["X-Amz-Credential"]],
      ["X-Amz-Date", post.fields["X-Amz-Date"]],
      ["Policy", expect.any(String)],
      ["X-Amz-Signature", signatureOf(post)],
    ]);
    const date = amzDate(post.fields["X-Amz-Date"]);
    expect(date).toBeWithin(before, after + 1);

    // The policy has a condition for each field, and it expires a day later.
    expect(policyOf(post)).toEqual({
      expiration: new Date(date + 86400_000).toISOString().replace(".000Z", "Z"),
      conditions: [{ key: "reports/2026.pdf" }, ...signer(post).conditions],
    });
  });

  it("the server accepts the form and stores the file", async () => {
    const post = client.presignPost("plain.txt");
    expect(await result(await upload(post, "hello"))).toEqual(STORED);
    expect(text(stored("plain.txt"))).toBe("hello");
    expect(await client.file("plain.txt").text()).toBe("hello");
  });

  it("each way to call it gives the same form", async () => {
    const forms = [
      client.presignPost("same.txt", { expiresIn: 60 }),
      client.file("same.txt").presignPost({ expiresIn: 60 }),
      S3Client.presignPost("same.txt", { ...options, expiresIn: 60 }),
      S3Client.presignPost(client.file("same.txt") as any, { expiresIn: 60 }),
      Bun.s3.presignPost("same.txt", { ...options, expiresIn: 60 }),
      // A null `conditions` or `fields` is none.
      client.file("same.txt", { bucket: "uploads" }).presignPost({ expiresIn: 60, conditions: null, fields: null }),
    ];
    for (const post of forms) {
      // The time of a form is the second that it was made in.
      const date = amzDate(post.fields["X-Amz-Date"]);
      expect({ url: post.url, fields: { ...post.fields, Policy: policyOf(post) } }).toEqual({
        url: `${server.url}/uploads`,
        fields: {
          key: "same.txt",
          ...signer(post).fields,
          bucket: "uploads",
          Policy: {
            expiration: new Date(date + 60_000).toISOString().replace(".000Z", "Z"),
            conditions: [{ key: "same.txt" }, ...signer(post).conditions],
          },
          "X-Amz-Signature": signatureOf(post),
        },
      });
    }
    expect(await result(await upload(forms[1], "from the file"))).toEqual(STORED);
    expect(await result(await upload(forms[3], "from the static method"))).toEqual(STORED);
    expect(text(stored("same.txt"))).toBe("from the static method");

    // `options` that is not an object is no options, as for presign().
    for (const none of [undefined, null, 5, "options"] as any[]) {
      expect(Object.keys(client.presignPost("same.txt", none).fields)).toEqual(Object.keys(forms[0].fields));
      expect(Object.keys(client.file("same.txt").presignPost(none).fields)).toEqual(Object.keys(forms[0].fields));
    }
  });

  describe("conditions", () => {
    it("content-length-range limits the size of the file", async () => {
      const post = client.presignPost("sized.bin", { conditions: [["content-length-range", 4, 8]] });
      expect(policyOf(post).conditions[0]).toEqual(["content-length-range", 4, 8]);

      expect(await result(await upload(post, "123"))).toEqual({
        status: 400,
        code: "EntityTooSmall",
        message: "Your proposed upload is smaller than the minimum allowed size",
      });
      expect(await result(await upload(post, "123456789"))).toEqual({
        status: 400,
        code: "EntityTooLarge",
        message: "Your proposed upload exceeds the maximum allowed size",
      });
      expect(server.buckets.get("uploads")!.current("sized.bin")).toBeUndefined();

      // Both limits are sizes that the policy accepts.
      expect((await upload(post, "1234")).status).toBe(204);
      expect((await upload(post, "12345678")).status).toBe(204);
      expect(text(stored("sized.bin"))).toBe("12345678");
    });

    it("starts-with and eq let the sender choose a field that is not in the result", async () => {
      const post = client.presignPost("typed.png", {
        conditions: [
          ["starts-with", "$Content-Type", "image/"],
          ["eq", "$Cache-Control", "no-store"],
          { "x-amz-meta-origin": "form" },
        ],
      });
      expect(described(post)).toEqual(Object.entries({ key: "typed.png", ...signer(post).fields }));
      expect(policyOf(post).conditions).toEqual([
        ["starts-with", "$Content-Type", "image/"],
        ["eq", "$Cache-Control", "no-store"],
        { "x-amz-meta-origin": "form" },
        { key: "typed.png" },
        ...signer(post).conditions,
      ]);

      const chosen = { "Content-Type": "image/png", "Cache-Control": "no-store", "x-amz-meta-origin": "form" };
      expect(await result(await upload(post, "png", { ...chosen, "Content-Type": "text/html" }))).toEqual({
        status: 403,
        code: "AccessDenied",
        message: 'Invalid according to Policy: Policy Condition failed: ["starts-with", "$Content-Type", "image/"]',
      });
      expect(await result(await upload(post, "png", { ...chosen, "Cache-Control": "public" }))).toEqual({
        status: 403,
        code: "AccessDenied",
        message: 'Invalid according to Policy: Policy Condition failed: ["eq", "$Cache-Control", "no-store"]',
      });
      expect((await upload(post, "png", chosen)).status).toBe(204);
      expect(stored("typed.png")).toMatchObject({
        contentType: "image/png",
        cacheControl: "no-store",
        userMetadata: { origin: "form" },
      });
    });

    it("the server refuses a field that the policy has no condition for", async () => {
      const post = client.presignPost("strict.txt");
      expect(await result(await upload(post, "x", { "Content-Type": "text/html" }))).toEqual({
        status: 403,
        code: "AccessDenied",
        message: "Invalid according to Policy: Extra input fields: content-type",
      });
    });

    it("takes a frozen list, and an object that is not a literal", () => {
      class Exact {
        "x-amz-meta-origin" = "form";
      }
      const conditions = Object.freeze([
        Object.freeze(["content-length-range", 1, 10] as const),
        new Proxy({ "Cache-Control": "no-store" }, {}),
        Object.assign(Object.create(null), { acl: "private" }),
        new Exact(),
      ]);
      expect(policyOf(client.presignPost("forms.txt", { conditions })).conditions.slice(0, 4)).toEqual([
        ["content-length-range", 1, 10],
        { "Cache-Control": "no-store" },
        { acl: "private" },
        { "x-amz-meta-origin": "form" },
      ]);
    });

    it.each([
      ["not an array", "nope", "The \"conditions\" argument must be of type array. Received type string ('nope')"],
      ["a string in the list", ["eq"], "conditions[0] must be"],
      ["a number in the list", [{ acl: "private" }, 7], "conditions[1] must be"],
      ["two items", [["eq", "$acl"]], "conditions[0] must be"],
      ["four items", [["eq", "$acl", "private", "x"]], "conditions[0] must be"],
      ["an operator that S3 does not have", [["ends-with", "$key", ".png"]], "conditions[0] must be"],
      ["an operator in another case", [["EQ", "$acl", "private"]], "conditions[0] must be"],
      ["an operator that is not a string", [[1, "$acl", "private"]], "conditions[0] must be"],
      ["a value that is not a string", [["eq", "$acl", 1]], "conditions[0] must be"],
      ["a field that is not a string", [["starts-with", 1, "a"]], "conditions[0] must be"],
      ["a hole in the list", [, { acl: "private" }], "conditions[0] must be"],
      ["an object with two fields", [{ acl: "private", tagging: "" }], "conditions[0] must be"],
      ["an object without a field", [{}], "conditions[0] must be"],
      ["an object with a value that is not a string", [{ success_action_status: 201 }], "conditions[0] must be"],
      ["an object with an empty name", [{ "": "x" }], "conditions[0] must be"],
      ["a Map", [new Map([["acl", "private"]])], "conditions[0] must be"],
    ])("throws for %s", (_, conditions, message) => {
      const error = thrown(() => client.presignPost("invalid.txt", { conditions: conditions as any }));
      expect(error).toEqual({ name: "TypeError", code: "ERR_INVALID_ARG_TYPE", message: expect.any(String) });
      if (message.endsWith("must be")) {
        expect(error.message).toBe(
          message +
            ' ["eq", "$field", value], ["starts-with", "$field", prefix], ["content-length-range", min, max] or { field: value }',
        );
      } else {
        expect(error.message).toBe(message);
      }
    });

    it.each([
      ["without the $", ["eq", "acl", "private"]],
      ["with the $ alone", ["starts-with", "$", ""]],
      ["empty", ["eq", "", "private"]],
    ])("throws for a field %s", (_, condition) => {
      const conditions = [{ acl: "private" }, condition] as any;
      expect(thrown(() => client.presignPost("invalid.txt", { conditions }))).toEqual({
        name: "TypeError",
        code: "ERR_INVALID_ARG_TYPE",
        message: 'conditions[1] must name its field with a "$" in front, as in "$key"',
      });
    });

    it.each([
      ["a negative size", [-1, 10]],
      ["a fraction", [0, 1.5]],
      ["a string", ["0", 10]],
      ["NaN", [0, NaN]],
      ["Infinity", [0, Infinity]],
      ["a size past Number.MAX_SAFE_INTEGER", [0, 2 ** 53]],
      ["a bigint", [0, 10n]],
      ["a minimum above the maximum", [11, 10]],
    ])("throws for a content-length-range with %s", (_, [min, max]) => {
      const conditions = [["content-length-range", min, max]] as any;
      expect(thrown(() => client.presignPost("invalid.txt", { conditions }))).toEqual({
        name: "TypeError",
        code: "ERR_INVALID_ARG_TYPE",
        message:
          'conditions[0]: the sizes of "content-length-range" must be integers from 0 to Number.MAX_SAFE_INTEGER, the smaller one first',
      });
    });

    it("accepts the limits of a content-length-range", () => {
      const conditions = [
        ["content-length-range", 0, 0],
        ["content-length-range", 5, 5],
        ["content-length-range", 0, Number.MAX_SAFE_INTEGER],
      ] as any;
      expect(policyOf(client.presignPost("limits.bin", { conditions })).conditions.slice(0, 3)).toEqual(conditions);
    });
  });

  describe("fields", () => {
    it("each one is in the result, with a condition that it has this value", async () => {
      const fields = { success_action_status: "201", "Content-Type": "text/x-note", "x-amz-meta-Reviewer": "ana" };
      const post = client.presignPost("with-fields.txt", { fields });
      expect(described(post)).toEqual(Object.entries({ key: "with-fields.txt", ...fields, ...signer(post).fields }));
      expect(policyOf(post).conditions).toEqual([
        { key: "with-fields.txt" },
        { success_action_status: "201" },
        { "Content-Type": "text/x-note" },
        { "x-amz-meta-Reviewer": "ana" },
        ...signer(post).conditions,
      ]);

      // The sender cannot change one.
      expect(await result(await upload(post, "note", { "Content-Type": "text/html" }))).toEqual({
        status: 403,
        code: "AccessDenied",
        message: 'Invalid according to Policy: Policy Condition failed: ["eq", "$Content-Type", "text/x-note"]',
      });

      const response = await upload(post, "note");
      expect(response.status).toBe(201);
      expect(await response.text()).toContain("<Key>with-fields.txt</Key>");
      expect(stored("with-fields.txt")).toMatchObject({
        contentType: "text/x-note",
        userMetadata: { reviewer: "ana" },
      });
    });

    it("a name can be a number, and the object can be a Proxy", () => {
      const post = client.presignPost("numbers.txt", { fields: new Proxy({ 7: "seven", "x-ignore-note": "" }, {}) });
      expect(post.fields[7]).toBe("seven");
      expect(post.fields["x-ignore-note"]).toBe("");
      expect(policyOf(post).conditions).toContainEqual({ "7": "seven" });
      expect(policyOf(post).conditions).toContainEqual({ "x-ignore-note": "" });
    });

    it("a line break in a value is the CR LF that a form sends", async () => {
      const tagging = "<Tagging><TagSet>\n<Tag><Key>team</Key><Value>web</Value></Tag>\r</TagSet>\r\n</Tagging>";
      const asSent = "<Tagging><TagSet>\r\n<Tag><Key>team</Key><Value>web</Value></Tag>\r\n</TagSet>\r\n</Tagging>";
      const post = client.presignPost("tagged.txt", {
        fields: { tagging, "x-ignore-a": "\n", "x-ignore-b": "\r\r\n\n\r" },
        conditions: [["starts-with", "$x-ignore-free", "one\ntwo"], { "x-ignore-exact": "a\rb" }],
      });
      expect(post.fields).toMatchObject({ tagging: asSent, "x-ignore-a": "\r\n", "x-ignore-b": "\r\n\r\n\r\n\r\n" });
      expect(policyOf(post).conditions.slice(0, 6)).toEqual([
        ["starts-with", "$x-ignore-free", "one\r\ntwo"],
        { "x-ignore-exact": "a\r\nb" },
        { key: "tagged.txt" },
        { tagging: asSent },
        { "x-ignore-a": "\r\n" },
        { "x-ignore-b": "\r\n\r\n\r\n\r\n" },
      ]);

      const sent = { "x-ignore-free": "one\ntwo\nthree", "x-ignore-exact": "a\rb" };
      expect(await result(await upload(post, "tags", sent))).toEqual(STORED);
      expect(stored("tagged.txt").tags).toEqual([{ key: "team", value: "web" }]);
    });

    it.each([
      ["not an object", "nope", "The \"fields\" argument must be of type object. Received type string ('nope')"],
      ["an array", ["a"], 'The "fields" argument must be of type object. Received an instance of Array'],
      [
        "a Map",
        new Map([["acl", "private"]]),
        'The "fields" argument must be of type object. Received an instance of Map',
      ],
      [
        "a value that is not a string",
        { success_action_status: 201 },
        'The "fields.success_action_status" argument must be of type string. Received type number (201)',
      ],
      ["an empty name", { "": "x" }, "fields must not have an empty name"],
      [
        "a second field of one name",
        { "Content-Type": "a/b", "x-ignore": "", "content-type": "c/d" },
        'fields has more than one "content-type" field (the names of fields are case-insensitive)',
      ],
      [
        "the file",
        { File: "x" },
        'fields must not have "File": the file is the last field of the form, after the fields that presignPost() returns',
      ],
      ...[
        "key",
        "Key",
        "bucket",
        "policy",
        "Policy",
        "X-Amz-Algorithm",
        "x-amz-credential",
        "X-AMZ-DATE",
        "x-amz-security-token",
        "X-Amz-Signature",
      ].map(
        name =>
          [
            `the field ${name}`,
            { [name]: "x" },
            `fields must not have "${name}": presignPost() writes that field`,
          ] as const,
      ),
    ])("throws for %s", (_, fields, message) => {
      const error = thrown(() => client.presignPost("invalid.txt", { fields: fields as any }));
      expect(error).toEqual({ name: "TypeError", code: "ERR_INVALID_ARG_TYPE", message });
    });

    it("takes many fields", () => {
      const many = Object.fromEntries(Array.from({ length: 3000 }, (_, index) => [`x-ignore-field-${index}`, ""]));
      const post = client.presignPost("many.txt", { fields: many });
      expect(Object.keys(post.fields).length).toBe(3000 + 7);
      expect(policyOf(post).conditions.length).toBe(3000 + 5);
      expect(post.fields["X-Amz-Signature"]).toBe(signatureOf(post));
    });
  });

  describe("script of the caller that runs while the options are read", () => {
    const boom = new Error("boom");
    const throws = () => {
      throw boom;
    };
    // A String object is a string to the check, and its text is what its `toString` returns.
    const stringObject = () => Object.assign(new String("x"), { toString: throws });
    const getter = (name: string) => Object.defineProperty({}, name, { get: throws, enumerable: true });

    it.each([
      ["a getter of expiresIn", () => getter("expiresIn")],
      ["a getter of conditions", () => getter("conditions")],
      ["a getter of fields", () => getter("fields")],
      ["a getter of a field", () => ({ fields: getter("acl") })],
      ["a getter of a condition", () => ({ conditions: [getter("acl")] })],
      ["a getter of an item of the list", () => ({ conditions: Object.defineProperty([1], 0, { get: throws }) })],
      ["the ownKeys trap of fields", () => ({ fields: new Proxy({}, { ownKeys: throws }) })],
      ["the get trap of fields", () => ({ fields: new Proxy({ acl: "private" }, { get: throws }) })],
      ["the text of an operator", () => ({ conditions: [[stringObject(), "$acl", "private"]] })],
      ["the text of the field of a condition", () => ({ conditions: [["eq", stringObject(), "private"]] })],
      ["the text of the value of a condition", () => ({ conditions: [["eq", "$acl", stringObject()]] })],
      ["the text of the value of an object condition", () => ({ conditions: [{ acl: stringObject() }] })],
      ["the text of the value of a field", () => ({ fields: { acl: stringObject() } })],
    ] as [string, () => any][])("the error of %s is the error of the call", (_, optionsOf) => {
      // The credentials of the static call are properties beside the ones that throw.
      const withCredentials = () =>
        Object.defineProperties(optionsOf(), Object.getOwnPropertyDescriptors(options)) as S3Options;
      expect(() => client.presignPost("reentrant.txt", optionsOf())).toThrow(boom);
      expect(() => client.file("reentrant.txt").presignPost(optionsOf())).toThrow(boom);
      expect(() => S3Client.presignPost("reentrant.txt", withCredentials())).toThrow(boom);
    });

    it("a condition that shortens the list leaves an item that is no condition", () => {
      const conditions: any[] = [
        {
          get acl() {
            conditions.length = 1;
            return "private";
          },
        },
        ["content-length-range", 0, 1],
      ];
      expect(thrown(() => client.presignPost("shortened.txt", { conditions }))).toEqual({
        name: "TypeError",
        code: "ERR_INVALID_ARG_TYPE",
        message:
          'conditions[1] must be ["eq", "$field", value], ["starts-with", "$field", prefix], ["content-length-range", min, max] or { field: value }',
      });
    });
  });

  describe("options of an upload", () => {
    const publicRead = {
      grantee: { type: "Group", uri: "http://acs.amazonaws.com/groups/global/AllUsers" },
      permission: "READ",
    };

    it("acl, storageClass, type, contentDisposition, contentEncoding and metadata are fields", async () => {
      const post = client.presignPost("described.json", {
        acl: "public-read",
        storageClass: "STANDARD_IA",
        type: "application/json",
        contentDisposition: 'attachment; filename="described.json"',
        contentEncoding: "identity",
        metadata: { Customer: "1042", stage: "draft" },
      });
      const fields = {
        acl: "public-read",
        "Content-Type": "application/json",
        "Content-Disposition": 'attachment; filename="described.json"',
        "Content-Encoding": "identity",
        "x-amz-storage-class": "STANDARD_IA",
        "x-amz-meta-customer": "1042",
        "x-amz-meta-stage": "draft",
      };
      expect(described(post)).toEqual(Object.entries({ key: "described.json", ...fields, ...signer(post).fields }));
      expect(policyOf(post).conditions).toEqual([
        { key: "described.json" },
        ...Object.entries(fields).map(([name, value]) => ({ [name]: value })),
        ...signer(post).conditions,
      ]);

      expect((await upload(post, "{}")).status).toBe(204);
      const object = stored("described.json");
      expect(object).toMatchObject({
        contentType: "application/json",
        contentDisposition: 'attachment; filename="described.json"',
        contentEncoding: "identity",
        storageClass: "STANDARD_IA",
        userMetadata: { customer: "1042", stage: "draft" },
      });
      expect(object.acl).toContainEqual(publicRead);

      // Without the option the object is private.
      expect((await upload(client.presignPost("described-private.json"), "{}")).status).toBe(204);
      expect(stored("described-private.json").acl).not.toContainEqual(publicRead);
    });

    it("the acl, the storage class and the metadata of the client and of the file apply", () => {
      const defaults = {
        acl: "bucket-owner-full-control",
        storageClass: "GLACIER_IR",
        metadata: { app: "billing" },
      } as const;
      const fields = {
        acl: "bucket-owner-full-control",
        "x-amz-storage-class": "GLACIER_IR",
        "x-amz-meta-app": "billing",
      };
      const archive = new S3Client({ ...options, ...defaults, requestPayer: true });
      for (const post of [
        archive.presignPost("a.bin"),
        archive.file("a.bin").presignPost(),
        client.file("a.bin", defaults).presignPost(),
        client.file("a.bin", defaults).presignPost({ expiresIn: 60 }),
      ]) {
        // A form has no field for who pays.
        expect(described(post)).toEqual(Object.entries({ key: "a.bin", ...fields, ...signer(post).fields }));
        expect(policyOf(post).conditions).toEqual([
          { key: "a.bin" },
          ...Object.entries(fields).map(([name, value]) => ({ [name]: value })),
          ...signer(post).conditions,
        ]);
      }

      // The options of the call replace them.
      const replaced = archive.presignPost("a.bin", { acl: "private", metadata: null });
      expect(described(replaced)).toEqual(
        Object.entries({
          key: "a.bin",
          acl: "private",
          "x-amz-storage-class": "GLACIER_IR",
          ...signer(replaced).fields,
        }),
      );
    });

    it("the type of a file, and of the extension of its key, is not a field", () => {
      const typed = client.file("typed.json", { type: "application/x-typed" });
      expect(typed.type).toBe("application/x-typed");
      for (const post of [typed.presignPost(), client.presignPost("typed.json")]) {
        expect(described(post)).toEqual(Object.entries({ key: "typed.json", ...signer(post).fields }));
      }
    });

    it("a field of `fields` replaces the field of an option, in any case", () => {
      const post = client.presignPost("replaced.txt", {
        type: "text/plain",
        acl: "private",
        metadata: { stage: "draft" },
        fields: { "content-type": "text/markdown", ACL: "public-read", "X-Amz-Meta-Stage": "final" },
      });
      expect(described(post)).toEqual(
        Object.entries({
          key: "replaced.txt",
          "content-type": "text/markdown",
          ACL: "public-read",
          "X-Amz-Meta-Stage": "final",
          ...signer(post).fields,
        }),
      );
    });

    it("refuses the metadata that an upload refuses", () => {
      const invalid = { metadata: { "a b": "1" } } as S3Options;
      const message = 'metadata key "a b" must be a valid HTTP header name';
      expect(() => client.presignPost("invalid.txt", invalid)).toThrow(message);
      expect(() => client.file("invalid.txt").presignPost(invalid)).toThrow(message);
      expect(() => S3Client.presignPost("invalid.txt", { ...options, ...invalid })).toThrow(message);
    });

    it("a bucket with Requester Pays takes the form with the header of the request", async () => {
      const bucket = server.buckets.get("pays")!;
      bucket.requestPayer = "Requester";
      bucket.acl = [
        ...bucket.acl,
        {
          grantee: { type: "Group", uri: "http://acs.amazonaws.com/groups/global/AuthenticatedUsers" },
          permission: "WRITE",
        },
      ];
      const requester = new S3Client({ ...options, ...REQUESTER, bucket: "pays", requestPayer: true });
      const post = requester.presignPost("paid.txt");
      expect(described(post)).toEqual(
        Object.entries({ key: "paid.txt", ...signer(post, REQUESTER.accessKeyId).fields }),
      );

      expect(await result(await upload(post, "unpaid"))).toMatchObject({ status: 403, code: "AccessDenied" });
      const paid = await upload(post, "paid", {}, undefined, { "x-amz-request-payer": "requester" });
      expect(paid.headers.get("x-amz-request-charged")).toBe("requester");
      expect(await result(paid)).toEqual(STORED);
      expect(text(stored("paid.txt", "pays"))).toBe("paid");
    });
  });

  describe("key", () => {
    it("${filename} is the name of the file, and the policy accepts what is in front of it", async () => {
      const post = client.presignPost("avatars/${filename}");
      expect(post.fields.key).toBe("avatars/${filename}");
      expect(policyOf(post).conditions).toEqual([["starts-with", "$key", "avatars/"], ...signer(post).conditions]);

      expect((await upload(post, "face", {}, "ana.png")).status).toBe(204);
      expect(text(stored("avatars/ana.png"))).toBe("face");

      // The sender can name another key below the prefix, and none outside of it.
      expect((await upload(post, "other", { key: "avatars/2026/bo.png" })).status).toBe(204);
      expect(text(stored("avatars/2026/bo.png"))).toBe("other");
      expect(await result(await upload(post, "out", { key: "secrets/bo.png" }))).toEqual({
        status: 403,
        code: "AccessDenied",
        message: 'Invalid according to Policy: Policy Condition failed: ["starts-with", "$key", "avatars/"]',
      });
    });

    it("${filename} in the field of an option or of `fields` makes the same kind of condition", async () => {
      const post = client.presignPost("named/${filename}.bak", {
        contentDisposition: 'attachment; filename="${filename}"',
        metadata: { original: "${filename}" },
        fields: { "x-amz-meta-copy": "copy of ${filename}" },
      });
      expect(post.fields).toMatchObject({
        key: "named/${filename}.bak",
        "Content-Disposition": 'attachment; filename="${filename}"',
        "x-amz-meta-original": "${filename}",
        "x-amz-meta-copy": "copy of ${filename}",
      });
      expect(policyOf(post).conditions).toEqual([
        ["starts-with", "$key", "named/"],
        ["starts-with", "$x-amz-meta-copy", "copy of "],
        ["starts-with", "$Content-Disposition", 'attachment; filename="'],
        ["starts-with", "$x-amz-meta-original", ""],
        ...signer(post).conditions,
      ]);

      expect((await upload(post, "data", {}, "march.csv")).status).toBe(204);
      expect(stored("named/march.csv.bak")).toMatchObject({
        contentDisposition: 'attachment; filename="march.csv"',
        userMetadata: { original: "march.csv", copy: "copy of march.csv" },
      });
    });

    it("the fields that say who signed have exact conditions, whatever their text", () => {
      const { bucket, ...withoutBucket } = options;
      const odd = new S3Client({ ...withoutBucket, ...SESSION, sessionToken: "token-${filename}" });
      const post = odd.presignPost("${filename}/${filename}.txt");
      expect(post.fields.bucket).toBe("${filename}");
      expect(policyOf(post).conditions).toEqual([
        ["starts-with", "$key", ""],
        { bucket: "${filename}" },
        { "X-Amz-Algorithm": "AWS4-HMAC-SHA256" },
        { "X-Amz-Credential": post.fields["X-Amz-Credential"] },
        { "X-Amz-Date": post.fields["X-Amz-Date"] },
        { "X-Amz-Security-Token": "token-${filename}" },
      ]);
    });

    it("a key without ${filename} is the only key that the policy accepts", async () => {
      const post = client.presignPost("exact/name.txt");
      expect(await result(await upload(post, "x", { key: "exact/other.txt" }))).toEqual({
        status: 403,
        code: "AccessDenied",
        message: 'Invalid according to Policy: Policy Condition failed: ["eq", "$key", "exact/name.txt"]',
      });
    });

    it("text that JSON escapes makes the round trip", async () => {
      const key = 'quotes "and" ünïcödé 日本語 🥟.txt';
      const note = 'quoted "two"\\back\ttab \u0001 \u2028 </script>';
      const name = 'x-ignore-"quoted"\\name';
      const post = client.presignPost(key, {
        fields: { "x-ignore-note": note, [name]: "" },
        conditions: [["starts-with", "$x-ignore-other", 'a"b\\c'], { [name + "2"]: "\\" }],
      });
      expect(post.fields).toMatchObject({ key, "x-ignore-note": note, [name]: "" });
      expect(policyOf(post).conditions).toEqual([
        ["starts-with", "$x-ignore-other", 'a"b\\c'],
        { [name + "2"]: "\\" },
        { key },
        { "x-ignore-note": note },
        { [name]: "" },
        ...signer(post).conditions,
      ]);
      expect(post.fields["X-Amz-Signature"]).toBe(signatureOf(post));

      // A form writes a quote in the name of a field in its own way, so this one is not sent.
      const plain = client.presignPost(key, {
        fields: { "x-ignore-note": note },
        conditions: [["starts-with", "$x-ignore-other", 'a"b\\c']],
      });
      expect((await upload(plain, "escaped", { "x-ignore-other": 'a"b\\c and more' })).status).toBe(204);
      expect(await client.file(key).text()).toBe("escaped");
    });

    it("text of one byte for each character makes the round trip", async () => {
      // JavaScriptCore keeps this text as Latin-1, and the policy is UTF-8.
      const key = "café/naïve-Ærø.txt";
      const post = client.presignPost(key, { fields: { "x-ignore-é": "ñ" } });
      expect(policyOf(post).conditions.slice(0, 2)).toEqual([{ key }, { "x-ignore-é": "ñ" }]);
      expect(post.fields["X-Amz-Signature"]).toBe(signatureOf(post));
      expect((await upload(post, "latin")).status).toBe(204);
      expect(await client.file(key).text()).toBe("latin");
    });

    it("a backslash is the slash that a request for the same path has", async () => {
      const file = client.file("win\\dir\\report.txt");
      const post = file.presignPost();
      expect(post.fields.key).toBe("win/dir/report.txt");
      expect(policyOf(post).conditions[0]).toEqual({ key: "win/dir/report.txt" });
      expect(new URL(file.presign()).pathname).toBe("/uploads/win/dir/report.txt");

      expect((await upload(post, "from the form")).status).toBe(204);
      expect(await file.text()).toBe("from the form");
      await file.write("from write()");
      expect(text(stored("win/dir/report.txt"))).toBe("from write()");

      const named = client.presignPost("\\inbox\\${filename}");
      expect(named.fields.key).toBe("inbox/${filename}");
      expect(policyOf(named).conditions[0]).toEqual(["starts-with", "$key", "inbox/"]);
    });

    it("a bucket in front of the key, when the client has none", async () => {
      const { bucket, ...withoutBucket } = options;
      for (const path of ["uploads/in/path.txt", "uploads\\in\\path.txt"]) {
        const post = new S3Client(withoutBucket).presignPost(path);
        expect(post.url).toBe(`${server.url}/uploads`);
        expect(post.fields).toMatchObject({ key: "in/path.txt", bucket: "uploads" });
        expect((await upload(post, path)).status).toBe(204);
        expect(text(stored("in/path.txt"))).toBe(path);
      }
    });

    it.each([
      ["no path", [], "ERR_MISSING_ARGS", "Expected a path to presign a POST to"],
      ["a number", [1], "ERR_INVALID_ARG_TYPE", "Expected a path to presign a POST to"],
      ["an empty key", [""], "ERR_S3_INVALID_PATH", "Invalid S3 bucket, key combination"],
      ["only slashes", ["//"], "ERR_S3_INVALID_PATH", "Invalid S3 bucket, key combination"],
      [
        "a key of 1025 bytes",
        [Buffer.alloc(1025, "k").toString()],
        "ERR_S3_INVALID_PATH",
        "Invalid S3 bucket, key combination",
      ],
      [
        "a key of 513 characters of two bytes",
        [Buffer.alloc(1026, "é").toString()],
        "ERR_S3_INVALID_PATH",
        "Invalid S3 bucket, key combination",
      ],
      [
        "a key that is not text",
        [new Uint8Array([0x61, 0xe6, 0x97])],
        "ERR_S3_INVALID_PATH",
        "Invalid S3 bucket, key combination",
      ],
      [
        "a bucket with a prefix",
        ["a.txt", { bucket: "uploads/prefix" }],
        "ERR_S3_INVALID_PATH",
        "Invalid S3 bucket, key combination",
      ],
      [
        "a bucket of 64 characters",
        ["a.txt", { bucket: Buffer.alloc(64, "b").toString() }],
        "ERR_S3_INVALID_PATH",
        "Invalid S3 bucket, key combination",
      ],
      ...["\n", "\r", "a\nb", "a\rb", "a\r\n\nb"].map(
        key =>
          [
            `the key ${JSON.stringify(key)}`,
            ["dir/" + key + ".txt"],
            "ERR_S3_INVALID_PATH",
            "presignPost cannot sign a key with a line break that is not CR LF: a form sends CR LF for each line break",
          ] as const,
      ),
    ])("throws for %s", (_, args, code, message) => {
      expect(thrown(() => (client.presignPost as any)(...args))).toMatchObject({ code, message });
    });

    it("throws without a bucket", () => {
      const { bucket, ...withoutBucket } = options;
      const anywhere = new S3Client(withoutBucket);
      for (const path of ["key.txt", "//key.txt"]) {
        expect(thrown(() => anywhere.presignPost(path))).toMatchObject({
          code: "ERR_S3_INVALID_PATH",
          message: "Invalid S3 bucket, key combination",
        });
      }
    });

    it("accepts a key of 1024 bytes, and a key with CR LF", async () => {
      for (const key of [Buffer.alloc(1024, "k").toString(), Buffer.alloc(1024, "é").toString()]) {
        expect(client.presignPost(key).fields.key).toBe(key);
      }
      const post = client.presignPost("two\r\nlines.txt");
      expect((await upload(post, "two lines")).status).toBe(204);
      expect(text(stored("two\r\nlines.txt"))).toBe("two lines");
    });

    it("accepts a bucket of 63 characters", () => {
      const bucket = Buffer.alloc(63, "b").toString();
      expect(client.presignPost("a.txt", { bucket }).fields.bucket).toBe(bucket);
    });
  });

  describe("expiresIn", () => {
    it("is the seconds from the time of the form to the expiration of the policy", () => {
      for (const expiresIn of [1, 900, 7 * 86400, 2 ** 31 - 1]) {
        const post = client.presignPost("timed.txt", { expiresIn });
        const expiration = Date.parse(policyOf(post).expiration);
        expect(expiration - amzDate(post.fields["X-Amz-Date"])).toBe(expiresIn * 1000);
      }
    });

    it.each([0, -1, -86400, NaN, "soon"])("throws for %p", expiresIn => {
      expect(thrown(() => client.presignPost("timed.txt", { expiresIn: expiresIn as number }))).toEqual({
        name: "TypeError",
        code: "ERR_INVALID_ARG_TYPE",
        message: "expiresIn must be greater than 0",
      });
    });

    it("the server refuses the form once the policy has expired", async () => {
      const post = client.presignPost("expires.txt", { expiresIn: 60 });
      const expiration = Date.parse(policyOf(post).expiration);
      try {
        now = new Date(expiration - 1000);
        expect((await upload(post, "in time")).status).toBe(204);
        now = new Date(expiration);
        expect(await result(await upload(post, "late"))).toEqual({
          status: 403,
          code: "AccessDenied",
          message: "Invalid according to Policy: Policy expired.",
        });
      } finally {
        now = START;
      }
      expect(text(stored("expires.txt"))).toBe("in time");
    });
  });

  describe("credentials", () => {
    it("a session token is a field of the form", async () => {
      const post = client.presignPost("session.txt", SESSION);
      expect(described(post)).toEqual(
        Object.entries({
          key: "session.txt",
          ...signer(post, SESSION.accessKeyId).fields,
          "X-Amz-Security-Token": SESSION.sessionToken,
        }),
      );
      expect(policyOf(post).conditions).toEqual([
        { key: "session.txt" },
        ...signer(post, SESSION.accessKeyId).conditions,
        { "X-Amz-Security-Token": SESSION.sessionToken },
      ]);
      expect(post.fields["X-Amz-Signature"]).toBe(signatureOf(post, SESSION.secretAccessKey));

      expect((await upload(post, "temporary")).status).toBe(204);
      expect(text(stored("session.txt"))).toBe("temporary");
    });

    it("the server refuses a form that was changed after the signature", async () => {
      const post = client.presignPost("tampered.txt", { conditions: [["content-length-range", 0, 4]] });
      const policy = policyOf(post);
      policy.conditions[0] = ["content-length-range", 0, 4000];
      const changed = { Policy: Buffer.from(JSON.stringify(policy)).toString("base64") };
      expect(await result(await upload(post, "too long", changed))).toEqual({
        status: 403,
        code: "SignatureDoesNotMatch",
        message:
          "The request signature we calculated does not match the signature you provided. Check your key and signing method.",
      });
    });

    it("the server refuses the signature of another secret", async () => {
      const post = client.presignPost("forged.txt", { secretAccessKey: "not-the-secret" });
      expect((await result(await upload(post, "x"))).code).toBe("SignatureDoesNotMatch");
    });

    it("the options of a call name another bucket and another region", async () => {
      const post = client.presignPost("elsewhere.txt", { bucket: "other" });
      expect(post.url).toBe(`${server.url}/other`);
      expect(post.fields.bucket).toBe("other");
      expect(policyOf(post).conditions).toContainEqual({ bucket: "other" });
      expect((await upload(post, "elsewhere")).status).toBe(204);
      expect(text(stored("elsewhere.txt", "other"))).toBe("elsewhere");

      const regional = client.presignPost("elsewhere.txt", { region: "eu-west-3" });
      expect(regional.fields["X-Amz-Credential"]).toBe(
        signer(regional, undefined, "eu-west-3").fields["X-Amz-Credential"],
      );
      expect(regional.fields["X-Amz-Signature"]).toBe(signatureOf(regional, undefined, "eu-west-3"));
    });

    it.each([
      ["without an access key and a secret", {}],
      ["without a secret", { S3_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE" }],
      ["without an access key", { S3_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" }],
    ])("throws %s", async (_, env) => {
      const script = `
        const failures = [];
        for (const call of [
          () => new Bun.S3Client({ bucket: "uploads" }).presignPost("a.txt"),
          () => new Bun.S3Client({ bucket: "uploads" }).file("a.txt").presignPost(),
          () => Bun.S3Client.presignPost("a.txt", { bucket: "uploads" }),
        ]) {
          try {
            call();
            failures.push(null);
          } catch (error) {
            failures.push({ name: error.name, code: error.code, message: error.message });
          }
        }
        console.log(JSON.stringify(failures));`;
      const missing = {
        name: "Error",
        code: "ERR_S3_MISSING_CREDENTIALS",
        message: "Missing S3 credentials. 'accessKeyId', 'secretAccessKey', 'bucket', and 'endpoint' are required",
      };
      expect(await child(script, env)).toEqual([missing, missing, missing]);
    });
  });

  describe("url and region", () => {
    const keys = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
    const r2 = "0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com";

    it.each([
      [
        "Amazon S3 in a region",
        { bucket: "photos", region: "eu-west-1" },
        "https://s3.eu-west-1.amazonaws.com/photos",
        "eu-west-1",
      ],
      [
        "Amazon S3, virtual hosted-style",
        { bucket: "photos", region: "eu-west-1", virtualHostedStyle: true },
        "https://photos.s3.eu-west-1.amazonaws.com/",
        "eu-west-1",
      ],
      [
        "an endpoint of a region of Amazon S3",
        { bucket: "photos", endpoint: "https://s3.us-west-2.amazonaws.com" },
        "https://s3.us-west-2.amazonaws.com/photos",
        "us-west-2",
      ],
      ["an endpoint", { bucket: "photos", endpoint: "http://localhost:9000" }, "http://localhost:9000/photos", "auto"],
      [
        "an endpoint with a path",
        { bucket: "photos", endpoint: "https://example.com/storage/v1" },
        "https://example.com/storage/v1/photos",
        "auto",
      ],
      [
        "a bucket name that a URL encodes",
        { bucket: "my photos", endpoint: "https://example.com" },
        "https://example.com/my%20photos",
        "auto",
      ],
      [
        "a virtual hosted-style endpoint",
        { bucket: "photos", endpoint: "https://photos.example.com", virtualHostedStyle: true },
        "https://photos.example.com/",
        "auto",
      ],
    ])("%s", (_, where, url, region) => {
      const post = new S3Client({ ...keys, ...where }).presignPost("a.jpg");
      expect(post.url).toBe(url);
      // The policy and the field have the name as it is.
      expect(post.fields.bucket).toBe(where.bucket);
      expect(policyOf(post).conditions).toContainEqual({ bucket: where.bucket });
      expect(post.fields["X-Amz-Credential"]).toBe(signer(post, keys.accessKeyId, region).fields["X-Amz-Credential"]);
      expect(post.fields["X-Amz-Signature"]).toBe(signatureOf(post, keys.secretAccessKey, region));
    });

    it("Amazon S3 in us-east-1, when nothing names an endpoint or a region", async () => {
      const script = `
        const { url, fields } = new Bun.S3Client({ bucket: "photos" }).presignPost("a.jpg");
        console.log(JSON.stringify({ url, credential: fields["X-Amz-Credential"].split("/").slice(2).join("/") }));`;
      expect(
        await child(script, { S3_ACCESS_KEY_ID: keys.accessKeyId, S3_SECRET_ACCESS_KEY: keys.secretAccessKey }),
      ).toEqual({ url: "https://s3.us-east-1.amazonaws.com/photos", credential: "us-east-1/s3/aws4_request" });
    });

    it.each([
      ["of Amazon S3", "https://photos.s3.eu-west-1.amazonaws.com", "eu-west-1"],
      ["of R2", `https://photos.${r2}`, "auto"],
    ])("the host of a virtual hosted-style endpoint %s names the bucket", (_, endpoint, region) => {
      // A request goes to the bucket of the host, whatever the option says.
      for (const bucket of [undefined, "photos", "videos"]) {
        const post = new S3Client({ ...keys, endpoint, bucket, virtualHostedStyle: true }).presignPost("a.jpg");
        expect(post.url).toBe(endpoint + "/");
        expect(post.fields.bucket).toBe("photos");
        expect(policyOf(post).conditions).toContainEqual({ bucket: "photos" });
        expect(post.fields["X-Amz-Signature"]).toBe(signatureOf(post, keys.secretAccessKey, region));
      }
    });

    it("the server takes the form of a virtual hosted-style endpoint", async () => {
      const hosted = new S3Client({
        ...server.clientOptions("uploads"),
        endpoint: server.virtualHostedUrl("uploads"),
        virtualHostedStyle: true,
      });
      const post = hosted.presignPost("hosted.txt");
      expect(post.url).toBe(server.virtualHostedUrl("uploads") + "/");
      expect(post.fields.bucket).toBe("uploads");
      expect(await result(await upload(post, "hosted"))).toEqual(STORED);
      expect(text(stored("hosted.txt"))).toBe("hosted");
    });

    it.each([
      ["an endpoint of another service", { endpoint: "https://photos.example.com" }],
      ["no endpoint", { region: "eu-west-1" }],
    ])("throws for virtual hosted-style with %s and without the name of the bucket", (_, where) => {
      const hosted = new S3Client({ ...keys, ...where, virtualHostedStyle: true });
      const message =
        'presignPost needs the name of the bucket, and this virtual hosted-style endpoint does not tell it: set the "bucket" option';
      for (const call of [() => hosted.presignPost("a.jpg"), () => hosted.file("a.jpg").presignPost()]) {
        expect(thrown(call)).toEqual({ name: "Error", code: "ERR_S3_INVALID_PATH", message });
      }
    });

    it("throws for a bucket or a region that would change the host", () => {
      for (const bucket of ["pho/tos", "pho\\tos"]) {
        const hosted = new S3Client({ ...keys, bucket, region: "eu-west-1", virtualHostedStyle: true });
        expect(thrown(() => hosted.presignPost("a.jpg"))).toMatchObject({ code: "ERR_S3_INVALID_PATH" });
      }
      const nowhere = new S3Client({ ...keys, bucket: "photos", region: "us east" });
      expect(thrown(() => nowhere.presignPost("a.jpg"))).toMatchObject({
        code: "ERR_S3_INVALID_ENDPOINT",
        message: "Invalid S3 endpoint",
      });
    });
  });

  it("is a method of an S3File only", () => {
    const presignPost = (client.file("a.txt") as S3File).presignPost;
    expect(presignPost.name).toBe("presignPost");
    expect(thrown(() => presignPost.call({} as any))).toEqual({
      name: "TypeError",
      code: "ERR_INVALID_THIS",
      message: "Expected a S3File instance",
    });
    expect((Bun.file("a.txt") as any).presignPost).toBeUndefined();
    expect(typeof S3Client.presignPost).toBe("function");
    expect(typeof Bun.s3.presignPost).toBe("function");
  });
});
