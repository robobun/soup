import * as b from "../../codegen/bindgen-lib.ts";

export default b.module({ rustPath: "crate::crypto::password_object" });

/** The key of an argon2 hash. The body copies it, a string as its UTF-8, into memory that it zeroes. */
const secret = {
  type: b.union({
    absent: b.null,
    text: b.string.allowStringObject,
    bytes: b.bufferSource.allowShared,
  }),
  expected: "Expected options.secret to be a string, ArrayBuffer or ArrayBufferView",
} as const;
export const PasswordSecret = secret.type;

/** Which of the costs counts depends on `algorithm`, and the others can be anything. */
export const PasswordHashOptions = b.dictionary(
  {
    algorithm: b.string.utf8.nullable,
    cost: b.any,
    timeCost: b.any,
    memoryCost: b.any,
    secret,
  },
  { allowArray: true },
);

export const PasswordHashAlgorithm = b.union({
  unspecified: b.null,
  label: b.string,
  options: PasswordHashOptions,
});

export const PasswordVerifyOptions = b.dictionary(
  {
    algorithm: b.string.utf8.nullable,
    secret,
  },
  { reportedAs: "options" },
);

/** The body refuses what is not the options: an array, a secret in their place, the callback of `bcrypt.compare()`. */
export const PasswordVerifyAlgorithm = b.union({
  unspecified: b.null,
  label: b.string.utf8,
  array: b.jsArray,
  bytes: b.bufferSource.allowShared,
  callback: b.callable,
  options: PasswordVerifyOptions,
});

const stringOrBuffer = b.bytes({ from: ["string", "buffer"] });
/** The fields of a hash are parsed more than once. */
const parsed = b.bytes({ from: ["string", "buffer"], shared: "copied" });
/** For a job to own, and to zero when it is done. */
const copied = b.bytes({ from: ["string", "buffer"], held: "copied" });

const verifyExpects = { algorithm: "Expected algorithm to be a string or an object for 'verify'." } as const;

export const password = b.namespace({
  hash: {
    args: { password: copied, algorithm: PasswordHashAlgorithm },
    returns: b.any,
    capability: "js",
    throws: true,
  },
  hashSync: {
    args: { password: stringOrBuffer, algorithm: PasswordHashAlgorithm },
    returns: b.string.utf8,
    capability: "heap",
    throws: true,
  },
  verify: {
    args: { password: copied, hash: copied, algorithm: PasswordVerifyAlgorithm },
    expected: verifyExpects,
    returns: b.any,
    capability: "js",
    throws: true,
    length: 2,
  },
  verifySync: {
    args: { password: stringOrBuffer, hash: parsed, algorithm: PasswordVerifyAlgorithm },
    expected: verifyExpects,
    returns: b.bool,
    capability: "heap",
    throws: true,
    length: 2,
  },
  needsRehash: {
    args: { hash: stringOrBuffer, algorithm: PasswordHashAlgorithm },
    returns: b.bool,
    capability: "heap",
    throws: true,
    length: 1,
  },
});
