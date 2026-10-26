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
