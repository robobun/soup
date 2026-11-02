Bun.hash.wyhash("asdf", 1234n);

// https://github.com/oven-sh/bun/issues/26043
// Bun.hash.crc32 accepts optional seed parameter for incremental CRC32 computation
let crc = 0;
crc = Bun.hash.crc32(new Uint8Array([1, 2, 3]), crc);
crc = Bun.hash.crc32(new Uint8Array([4, 5, 6]), crc);

{
  const argon2 = { algorithm: "argon2id", memoryCost: 65536, timeCost: 3 } as const;
  const hash: string = Bun.password.hashSync("hunter2", argon2);

  const needsRehash: boolean = Bun.password.needsRehash(hash, argon2);
  Bun.password.needsRehash(hash) satisfies boolean;
  Bun.password.needsRehash(new TextEncoder().encode(hash), "bcrypt") satisfies boolean;
  Bun.password.needsRehash(hash, { algorithm: "bcrypt", cost: 12 }) satisfies boolean;
  // @ts-expect-error the second argument is what hash() takes, so the algorithm has to be named
  Bun.password.needsRehash(hash, { cost: 12 });
  needsRehash;

  Bun.password.hash("hunter2", { ...argon2, secret: "pepper" }) satisfies Promise<string>;
  Bun.password.hashSync("hunter2", { algorithm: "argon2id", secret: process.env.PASSWORD_SECRET }) satisfies string;
  Bun.password.hashSync("hunter2", { algorithm: "argon2i", secret: new Uint8Array(32) }) satisfies string;
  // @ts-expect-error bcrypt has no secret
  Bun.password.hashSync("hunter2", { algorithm: "bcrypt", secret: "pepper" });
  // @ts-expect-error a secret is a string or a buffer
  Bun.password.hashSync("hunter2", { algorithm: "argon2id", secret: 1234 });

  Bun.password.verify("hunter2", hash, { secret: "pepper" }) satisfies Promise<boolean>;
  Bun.password.verifySync("hunter2", hash, { algorithm: "argon2id", secret: new ArrayBuffer(32) }) satisfies boolean;
  Bun.password.verifySync("hunter2", hash, "argon2id") satisfies boolean;
  const verifyOptions: Bun.Password.VerifyOptions = {};
  Bun.password.verifySync("hunter2", hash, verifyOptions) satisfies boolean;
  // @ts-expect-error the costs are read from the hash
  Bun.password.verifySync("hunter2", hash, { algorithm: "argon2id", memoryCost: 65536 });
}
