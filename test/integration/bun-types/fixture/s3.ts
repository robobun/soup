import { s3 } from "bun";
import { expectType } from "./utilities";

async function doFileOps(file: Bun.S3File) {
  console.log(file.bucket);
  console.log(file.presign());
  console.log(file.presign({ expiresIn: 1, method: "PUT" }));
  console.log(file.type);

  await file.json();
  await file.arrayBuffer();
  await file.delete();
  await file.formData();

  for await (const chunk of file.readable) {
    console.log(chunk);
  }
}

doFileOps(s3.file("stream.bin"));

doFileOps(
  new Bun.S3Client({
    accessKeyId: "123",
  }).file("stream.bin"),
);

doFileOps(
  s3.file("stream.bin", {
    type: "application/octet-stream",
  }),
);

async function doMetadata(file: Bun.S3File) {
  const metadata = { customer: "1042", "reviewed-by": "ana" };
  await file.write("data", { metadata });
  await s3.write("invoice.pdf", "data", { metadata });
  file.writer({ metadata });
  file.presign({ method: "PUT", metadata });
  new Bun.S3Client({ metadata }).file("invoice.pdf", { metadata: {} });
  await file.write("data", { metadata: null });
  await file.write("data", { metadata: undefined });

  expectType((await file.stat()).metadata).is<Record<string, string>>();
  expectType((await s3.stat("invoice.pdf")).metadata).is<Record<string, string>>();

  // @ts-expect-error
  await file.write("data", { metadata: { customer: 1042 } });
  // @ts-expect-error
  await file.write("data", { metadata: "customer=1042" });
}

doMetadata(s3.file("invoice.pdf"));

async function doCopy(file: Bun.S3File) {
  expectType(await s3.copy("a.txt", "b.txt")).is<Bun.S3CopyResult>();
  const credentials = { accessKeyId: "key", secretAccessKey: "secret", bucket: "backups" };
  expectType(await Bun.S3Client.copy(file, "b.txt", credentials)).is<Bun.S3CopyResult>();
  expectType(await Bun.S3Client.copy("s3://uploads/a.txt", file)).is<Bun.S3CopyResult>();
  expectType(await file.copyTo("b.txt")).is<Bun.S3CopyResult>();

  const { etag, lastModified } = await file.copyTo(s3.file("b.txt"), {
    metadataDirective: "REPLACE",
    type: "text/plain",
    metadata: { reviewed: "yes" },
    storageClass: "STANDARD_IA",
  });
  expectType(etag).is<string>();
  expectType(lastModified).is<Date>();

  const options: Bun.S3CopyOptions = {
    copySourceIfMatch: etag,
    copySourceIfNoneMatch: '"0"',
    copySourceIfModifiedSince: new Date(0),
    copySourceIfUnmodifiedSince: lastModified,
  };
  await s3.copy("a.txt", "b.txt", options);
  await s3.copy("a.txt", "b.txt", { metadataDirective: "COPY", copySourceIfMatch: undefined });

  // @ts-expect-error
  await s3.copy(file, "b.txt");
  // @ts-expect-error
  await s3.copy("a.txt", "b.txt", { metadataDirective: "replace" });
  // @ts-expect-error
  await s3.copy("a.txt", "b.txt", { copySourceIfMatch: new Date() });
  // @ts-expect-error
  await s3.copy("a.txt", "b.txt", { copySourceIfMatch: new Headers().get("etag") });
  // @ts-expect-error
  await s3.copy("a.txt", "b.txt", { copySourceIfUnmodifiedSince: "Sun, 25 Oct 2026 12:00:00 GMT" });
  // @ts-expect-error
  await file.copyTo();
}

doCopy(s3.file("a.txt"));

function doPresignPost(file: Bun.S3File) {
  expectType(s3.presignPost("uploads/${filename}")).is<Bun.S3PresignedPost>();
  expectType(file.presignPost()).is<Bun.S3PresignedPost>();
  const credentials = { accessKeyId: "key", secretAccessKey: "secret", bucket: "uploads" };
  expectType(Bun.S3Client.presignPost("avatar.png", credentials)).is<Bun.S3PresignedPost>();

  const conditions: Bun.S3PostPolicyCondition[] = [
    ["content-length-range", 1, 2 * 1024 * 1024],
    ["starts-with", "$Content-Type", "image/"],
    ["eq", "$Cache-Control", "no-store"],
    { "x-amz-meta-origin": "form" },
  ];
  const { url, fields } = s3.presignPost("avatar.png", {
    expiresIn: 600,
    type: "image/png",
    acl: "public-read",
    metadata: { user: "1042" },
    conditions,
    fields: { success_action_status: "201" },
  });
  expectType(url).is<string>();
  expectType(fields).is<Record<string, string>>();
  file.presignPost({ conditions: null, fields: null, expiresIn: undefined });

  const frozen = [
    ["content-length-range", 0, 10],
    ["starts-with", "$key", "uploads/"],
  ] as const;
  s3.presignPost("avatar.png", { conditions: frozen, fields: { acl: "private" } as const });
  s3.presignPost("avatar.png", { conditions: [["eq", "$acl", "private"] as const, { acl: "private" } as const] });

  // @ts-expect-error
  s3.presignPost();
  // @ts-expect-error
  s3.presignPost("avatar.png", { conditions: [["starts-with", "Content-Type", "image/"]] });
  // @ts-expect-error
  s3.presignPost("avatar.png", { conditions: [["content-length-range", "1", "10"]] });
  // @ts-expect-error
  s3.presignPost("avatar.png", { conditions: [["ends-with", "$key", ".png"]] });
  // @ts-expect-error
  s3.presignPost("avatar.png", { fields: { success_action_status: 201 } });
  // @ts-expect-error
  s3.presignPost("avatar.png", { method: "POST" });
}

doPresignPost(s3.file("avatar.png"));
