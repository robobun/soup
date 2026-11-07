import { expectType } from "./utilities";

const files = { "a.txt": "a", "b.bin": new Uint8Array(1) };
declare const bytes: Uint8Array;
declare const blob: Blob;
declare const archive: Bun.Archive;

// A tar, created or given.
new Bun.Archive(files) satisfies Bun.Archive;
new Bun.Archive(files, {});
new Bun.Archive(files, { format: "tar" });
new Bun.Archive(files, { compress: "gzip", level: 9 });
new Bun.Archive(bytes, { format: "tar", compress: "gzip" });
new Bun.Archive(blob, { compress: "gzip" });
new Bun.Archive(bytes.buffer);
// @ts-expect-error the formats are tar and zip
new Bun.Archive(files, { format: "7z" });
// @ts-expect-error a tar is compressed with gzip
new Bun.Archive(files, { compress: "deflate" });
// @ts-expect-error a tar is compressed with gzip
new Bun.Archive(files, { format: "tar", compress: "store" });
// @ts-expect-error
new Bun.Archive(files, { compress: "zstd" });

// A zip that is created from an object.
new Bun.Archive(files, { format: "zip" }) satisfies Bun.Archive;
new Bun.Archive(files, { format: "zip", level: 12 });
new Bun.Archive(files, { format: "zip", compress: "deflate", level: 1 });
new Bun.Archive(files, { format: "zip", compress: "store" });
// @ts-expect-error a zip is not gzipped
new Bun.Archive(files, { format: "zip", compress: "gzip" });
// @ts-expect-error a stored file has no level
new Bun.Archive(files, { format: "zip", compress: "store", level: 6 });

// Existing data that is a zip takes the declaration and nothing else.
new Bun.Archive(bytes, { format: "zip" }) satisfies Bun.Archive;
new Bun.Archive(blob, { format: "zip" });
new Bun.Archive(bytes.buffer, { format: "zip" });
// @ts-expect-error the files of an existing zip stay as they are
new Bun.Archive(bytes, { format: "zip", compress: "store" });
// @ts-expect-error the files of an existing zip stay as they are
new Bun.Archive(blob, { format: "zip", level: 9 });
// @ts-expect-error a zip is not gzipped
new Bun.Archive(bytes, { format: "zip", compress: "gzip" });
// @ts-expect-error "deflate" is for a zip that is created from an object
new Bun.Archive(bytes, { compress: "deflate" });

expectType(Bun.Archive.write("a.tar.gz", files, { compress: "gzip" })).is<Promise<void>>();
expectType(Bun.Archive.write("a.zip", files, { format: "zip", level: 9 })).is<Promise<void>>();
expectType(Bun.Archive.write("a.zip", bytes, { format: "zip" })).is<Promise<void>>();
// @ts-expect-error the files of an existing zip stay as they are
Bun.Archive.write("a.zip", bytes, { format: "zip", compress: "deflate" });

// An Archive keeps its format. `compress` replaces what it was created with.
expectType(Bun.Archive.write("a", archive)).is<Promise<void>>();
Bun.Archive.write("a", archive, { compress: "gzip", level: 9 });
Bun.Archive.write("a", archive, { compress: "deflate", level: 9 });
Bun.Archive.write("a", archive, { compress: "store" });
// @ts-expect-error
Bun.Archive.write("a", archive, { format: "zip" });
// @ts-expect-error a stored file has no level
Bun.Archive.write("a", archive, { compress: "store", level: 9 });

expectType<Bun.ArchiveFormat>("tar");
expectType<Bun.ArchiveCompression>("store");
