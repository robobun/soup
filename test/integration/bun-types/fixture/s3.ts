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
