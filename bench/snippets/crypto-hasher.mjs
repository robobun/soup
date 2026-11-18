// so it can run in environments without node module resolution
import { bench, run } from "../runner.mjs";

import crypto from "node:crypto";

var foo = Buffer.allocUnsafe(512);
foo.fill(123);

// if ("Bun" in globalThis) {
//   const { CryptoHasher } = Bun;
//   bench("Bun.CryptoHasher(sha512)", () => {
//     var hasher = new CryptoHasher("sha512");
//     hasher.update(foo);
//     hasher.digest();
//   });
// }

bench('crypto.createHash("sha512")', () => {
  var hasher = crypto.createHash("sha512");
  hasher.update(foo);
  hasher.digest();
});

bench('crypto.createHash("sha256")', () => {
  var hasher = crypto.createHash("sha256");
  hasher.update(foo);
  hasher.digest();
});

bench('crypto.createHash("sha1")', () => {
  var hasher = crypto.createHash("sha1");
  hasher.update(foo);
  hasher.digest();
});

if ("Bun" in globalThis) {
  // blake3 beside the two algorithms it is chosen over, from one block to megabytes. It hashes a block at a time up to
  // one kilobyte, and several kilobytes at a time from two.
  const into = new Uint8Array(64);
  const sizes = {
    "32 B": 32,
    "1 KiB": 1 << 10,
    "2 KiB": 2 << 10,
    "4 KiB": 4 << 10,
    "16 KiB": 16 << 10,
    "64 KiB": 64 << 10,
    "16 MiB": 16 << 20,
  };
  for (const [label, size] of Object.entries(sizes)) {
    const input = Buffer.alloc(size, 123);
    for (const algorithm of ["blake3", "sha256", "blake2b512"]) {
      bench(`Bun.CryptoHasher.hash("${algorithm}", ${label})`, () => {
        Bun.CryptoHasher.hash(algorithm, input, into);
      });
    }
  }
}

await run();
