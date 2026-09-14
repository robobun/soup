// Bun.JWT: JSON Web Tokens (RFC 7519) in the JWS compact serialization (RFC 7515),
// signed with the algorithms of RFC 7518 and RFC 8037.
//
// Everything cryptographic is native: HMAC goes through Bun.CryptoHasher, asymmetric
// signatures and key parsing through the node:crypto bindings. This file owns the
// token format, the rules for which algorithm a key may be used with, and the
// validation of the registered claims.

const { CryptoHasher } = Bun;
const { timingSafeEqual } = $rust("node_crypto_binding.rs", "createNodeCryptoBindingZig");
const { isKeyObject, isCryptoKey, isArrayBufferView, isAnyArrayBuffer, isDate } = require("node:util/types");

const { RSA_PKCS1_PSS_PADDING, RSA_PSS_SALTLEN_DIGEST } = $processBindingConstants.crypto;

// Only asymmetric keys need these. A service that signs with a shared secret never builds the binding.
let signOneShot, verifyOneShot, keyObjectFromCryptoKey, createPublicKey, createPrivateKey;

function loadKeyFunctions() {
  ({
    sign: signOneShot,
    verify: verifyOneShot,
    keyObjectFromCryptoKey,
    createPublicKey,
    createPrivateKey,
  } = $cpp("node_crypto_binding.cpp", "createNodeCryptoBinding"));
}

const ObjectPrototypeHasOwnProperty = Object.prototype.hasOwnProperty;
const ObjectGetPrototypeOf = Object.getPrototypeOf;

type KeyKind = "secret" | "rsa" | "ec" | "ed25519";

interface AlgorithmInfo {
  kind: KeyKind;
  /** Digest name for HMAC and for crypto.sign(); null for Ed25519, which hashes internally. */
  hash: string | null;
  pss?: boolean;
  /** Length of the IEEE P1363 (r || s) signature an ES* algorithm produces. */
  signatureLength?: number;
}

// No prototype: `alg` comes from an unverified token and is used as a key here.
const algorithms: Record<string, AlgorithmInfo> = {
  __proto__: null,
  HS256: { kind: "secret", hash: "sha256" },
  HS384: { kind: "secret", hash: "sha384" },
  HS512: { kind: "secret", hash: "sha512" },
  RS256: { kind: "rsa", hash: "sha256" },
  RS384: { kind: "rsa", hash: "sha384" },
  RS512: { kind: "rsa", hash: "sha512" },
  PS256: { kind: "rsa", hash: "sha256", pss: true },
  PS384: { kind: "rsa", hash: "sha384", pss: true },
  PS512: { kind: "rsa", hash: "sha512", pss: true },
  ES256: { kind: "ec", hash: "sha256", signatureLength: 64 },
  ES384: { kind: "ec", hash: "sha384", signatureLength: 96 },
  ES512: { kind: "ec", hash: "sha512", signatureLength: 132 },
  EdDSA: { kind: "ed25519", hash: null },
  // RFC 9864 name for what RFC 8037 calls EdDSA with an Ed25519 key.
  Ed25519: { kind: "ed25519", hash: null },
} as any;

// Keyed by the OpenSSL names that `asymmetricKeyDetails.namedCurve` reports.
const algorithmForCurve = {
  __proto__: null,
  prime256v1: "ES256",
  secp384r1: "ES384",
  secp521r1: "ES512",
} as any as Record<string, string>;

const webCryptoCurves = {
  __proto__: null,
  "P-256": "ES256",
  "P-384": "ES384",
  "P-521": "ES512",
} as any as Record<string, string>;

const webCryptoHashBits = {
  __proto__: null,
  "SHA-256": "256",
  "SHA-384": "384",
  "SHA-512": "512",
} as any as Record<string, string>;

// RFC 7518 section 3.3: "A key of size 2048 bits or larger MUST be used".
const MIN_RSA_MODULUS_LENGTH = 2048;

interface PreparedKey {
  kind: KeyKind;
  /** HMAC key material, as given (string) or as bytes. */
  secret?: string | Uint8Array;
  /** A public or private node:crypto KeyObject. */
  keyObject?: any;
  /** The only ES* algorithm the curve of an EC key works with. */
  curveAlgorithm?: string;
  /** Set when the key itself names its algorithm: a CryptoKey, or a JWK with "alg". */
  pinnedAlgorithm?: string;
  ecOptions?: object;
  pssOptions?: object;
}

const keyTypes = ["string", "ArrayBuffer", "TypedArray", "DataView", "KeyObject", "CryptoKey", "JsonWebKey"];

function invalidKey(message: string) {
  return $ERR_JWT_INVALID_KEY(message);
}

// A key with a PEM header anywhere in it is parsed as PEM or refused, and never used as an HMAC
// secret: PEM readers skip whatever comes before the header. To sign with a secret that looks
// like this anyway, pass a secret KeyObject.
const PEM_HEADER = "-----BEGIN ";

function fromKeyObject(keyObject, forSigning: boolean, pinnedAlgorithm?: string): PreparedKey {
  const type = keyObject.type;
  if (type === "secret") {
    if (keyObject.symmetricKeySize === 0) throw invalidKey("The secret must not be empty");
    return { kind: "secret", secret: keyObject.export(), pinnedAlgorithm };
  }

  if (forSigning && type !== "private") {
    throw invalidKey("A private key is required to sign, received a public key");
  }

  const keyType = keyObject.asymmetricKeyType;
  switch (keyType) {
    case "rsa":
    case "rsa-pss": {
      const modulusLength = keyObject.asymmetricKeyDetails?.modulusLength;
      // Written so that a size that is not known is refused as well.
      if (!(modulusLength >= MIN_RSA_MODULUS_LENGTH)) {
        const received = typeof modulusLength === "number" ? `a ${modulusLength} bit key` : "a key of unknown size";
        throw invalidKey(`RSA keys must be at least ${MIN_RSA_MODULUS_LENGTH} bits, received ${received}`);
      }
      return { kind: "rsa", keyObject, pinnedAlgorithm };
    }
    case "ec": {
      const curve = keyObject.asymmetricKeyDetails?.namedCurve;
      const curveAlgorithm = typeof curve === "string" ? algorithmForCurve[curve] : undefined;
      if (curveAlgorithm === undefined) {
        throw invalidKey(`EC keys must use the P-256, P-384 or P-521 curve, received ${curve}`);
      }
      return { kind: "ec", keyObject, curveAlgorithm, pinnedAlgorithm };
    }
    case "ed25519":
      return { kind: "ed25519", keyObject, pinnedAlgorithm };
    default:
      throw invalidKey(`Unsupported key type: ${keyType}`);
  }
}

function fromPEM(pem: string | Uint8Array, forSigning: boolean): PreparedKey {
  if (createPublicKey === undefined) loadKeyFunctions();
  let keyObject;
  try {
    keyObject = forSigning ? createPrivateKey(pem) : createPublicKey(pem);
  } catch (error: any) {
    throw invalidKey(
      `Could not read the PEM ${forSigning ? "private" : "public"} key: ${error?.message ?? "unknown error"}`,
    );
  }
  return fromKeyObject(keyObject, forSigning);
}

function fromCryptoKey(cryptoKey: CryptoKey, forSigning: boolean): PreparedKey {
  const usage = forSigning ? "sign" : "verify";
  if (!cryptoKey.usages.includes(usage)) {
    throw invalidKey(`The CryptoKey does not have the "${usage}" usage`);
  }

  const algorithm = cryptoKey.algorithm as any;
  let pinned: string | undefined;
  switch (algorithm.name) {
    case "HMAC": {
      const bits = webCryptoHashBits[algorithm.hash?.name];
      if (bits) pinned = "HS" + bits;
      break;
    }
    case "RSASSA-PKCS1-v1_5": {
      const bits = webCryptoHashBits[algorithm.hash?.name];
      if (bits) pinned = "RS" + bits;
      break;
    }
    case "RSA-PSS": {
      const bits = webCryptoHashBits[algorithm.hash?.name];
      if (bits) pinned = "PS" + bits;
      break;
    }
    case "ECDSA":
      pinned = webCryptoCurves[algorithm.namedCurve];
      break;
    case "Ed25519":
      pinned = "EdDSA";
      break;
  }
  if (pinned === undefined) {
    throw invalidKey(`The CryptoKey algorithm ${algorithm.name} cannot sign or verify a JWT`);
  }
  // The KeyObject is used here and never returned, which is not the hand-over DEP0204 warns about.
  return fromKeyObject(keyObjectFromCryptoKey(cryptoKey), forSigning, pinned);
}

function fromJWK(jwk: any, forSigning: boolean): PreparedKey {
  const { kty, use, alg, k, key_ops: operations } = jwk;
  if (typeof kty !== "string") {
    throw $ERR_INVALID_ARG_TYPE("key", keyTypes, jwk);
  }
  if (use !== undefined && use !== "sig") {
    throw invalidKey(`The JSON Web Key is not a signing key ("use": ${JSON.stringify(use)})`);
  }
  if (operations !== undefined) {
    const operation = forSigning ? "sign" : "verify";
    if (!$isArray(operations) || !operations.includes(operation)) {
      throw invalidKey(`The JSON Web Key cannot be used to ${operation} ("key_ops": ${JSON.stringify(operations)})`);
    }
  }

  let pinned: string | undefined;
  if (alg !== undefined) {
    if (typeof alg !== "string" || algorithms[alg] === undefined) {
      throw invalidKey(`The JSON Web Key names an unsupported algorithm ("alg": ${JSON.stringify(alg)})`);
    }
    pinned = alg;
  }

  if (kty === "oct") {
    if (typeof k !== "string" || !isBase64URL(k)) {
      throw invalidKey('The "k" member of a symmetric JSON Web Key must be a base64url string');
    }
    if (k.length === 0) throw invalidKey("The secret must not be empty");
    return { kind: "secret", secret: Buffer.from(k, "base64url"), pinnedAlgorithm: pinned };
  }

  let keyObject;
  try {
    keyObject = forSigning
      ? createPrivateKey({ key: jwk, format: "jwk" })
      : createPublicKey({ key: jwk, format: "jwk" });
  } catch (error: any) {
    throw invalidKey(
      `Could not read the JSON Web Key as a ${forSigning ? "private" : "public"} key: ${error?.message ?? "unknown error"}`,
    );
  }
  return fromKeyObject(keyObject, forSigning, pinned);
}

// Parsing a PEM or a JWK costs about as much as verifying a signature with it, and servers
// use the same few keys for every request. Objects are cached for as long as they live.
// PEM strings are cached in a small map, oldest out first.
interface CacheEntry {
  sign?: PreparedKey;
  verify?: PreparedKey;
  /** Of a JSON Web Key: what `jwkMembers` were when the entry was made. */
  members?: unknown[];
}
const objectKeyCache = new WeakMap<object, CacheEntry>();
const pemStringCache = new Map<string, CacheEntry>();
const MAX_CACHED_PEM_STRINGS = 16;

// KeyObjects and CryptoKeys cannot change, a JSON Web Key is a plain object that can: a key that
// is rotated or restricted in place must not go on verifying as what it used to be.
const jwkMembers = ["kty", "use", "alg", "k", "crv", "x", "y", "d", "n", "e", "p", "q", "dp", "dq", "qi"];

function readJWKMembers(jwk: any): unknown[] {
  const members: unknown[] = [];
  for (let i = 0; i < jwkMembers.length; i++) members.push(jwk[jwkMembers[i]]);
  const operations = jwk.key_ops;
  members.push($isArray(operations) ? operations.join(" ") : operations);
  return members;
}

function sameJWKMembers(a: unknown[], b: unknown[]): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function prepareKey(key: unknown, forSigning: boolean): PreparedKey {
  if (typeof key === "string") {
    if (!key.includes(PEM_HEADER)) {
      if (key.length === 0) throw invalidKey("The secret must not be empty");
      return { kind: "secret", secret: key };
    }
    let entry = pemStringCache.get(key);
    const cached = forSigning ? entry?.sign : entry?.verify;
    if (cached !== undefined) return cached;

    const prepared = fromPEM(key, forSigning);
    if (entry === undefined) {
      if (pemStringCache.size >= MAX_CACHED_PEM_STRINGS) {
        pemStringCache.delete(pemStringCache.keys().next().value!);
      }
      pemStringCache.set(key, (entry = {}));
    }
    if (forSigning) entry.sign = prepared;
    else entry.verify = prepared;
    return prepared;
  }

  if (key === null || typeof key !== "object") {
    throw $ERR_INVALID_ARG_TYPE("key", keyTypes, key);
  }

  // Bytes are mutable, so they are looked at again on every call.
  if (isArrayBufferView(key) || isAnyArrayBuffer(key)) {
    const bytes = isArrayBufferView(key)
      ? Buffer.from(
          (key as ArrayBufferView).buffer,
          (key as ArrayBufferView).byteOffset,
          (key as ArrayBufferView).byteLength,
        )
      : Buffer.from(key as ArrayBuffer);
    if (bytes.includes(PEM_HEADER)) return fromPEM(bytes, forSigning);
    if (bytes.length === 0) throw invalidKey("The secret must not be empty");
    return { kind: "secret", secret: bytes };
  }

  if (createPublicKey === undefined) loadKeyFunctions();
  const keyObject = isKeyObject(key);
  const cryptoKey = !keyObject && isCryptoKey(key);
  const members = keyObject || cryptoKey ? undefined : readJWKMembers(key);

  let entry = objectKeyCache.get(key);
  if (entry !== undefined && members !== undefined && !sameJWKMembers(entry.members!, members)) {
    entry = undefined;
  }
  const cached = forSigning ? entry?.sign : entry?.verify;
  if (cached !== undefined) return cached;

  const prepared = keyObject
    ? fromKeyObject(key, forSigning)
    : cryptoKey
      ? fromCryptoKey(key as CryptoKey, forSigning)
      : fromJWK(key, forSigning);
  if (entry === undefined) objectKeyCache.set(key, (entry = { members }));
  if (forSigning) entry.sign = prepared;
  else entry.verify = prepared;
  return prepared;
}

function sameAlgorithm(a: string, b: string): boolean {
  return a === b || (algorithms[a]?.kind === "ed25519" && algorithms[b]?.kind === "ed25519");
}

/** Why `alg` cannot be used with this key, or undefined when it can. */
function algorithmMismatch(alg: string, info: AlgorithmInfo, key: PreparedKey): string | undefined {
  const { kind, curveAlgorithm, pinnedAlgorithm } = key;
  if (info.kind !== kind) {
    const expected =
      kind === "secret"
        ? "a shared secret works with HS256, HS384 and HS512"
        : kind === "rsa"
          ? "an RSA key works with RS256, RS384, RS512, PS256, PS384 and PS512"
          : kind === "ec"
            ? `this EC key works with ${curveAlgorithm}`
            : "an Ed25519 key works with EdDSA";
    return `${alg} cannot be used with this key (${expected})`;
  }
  if (kind === "ec" && curveAlgorithm !== alg) {
    return `${alg} cannot be used with this key (this EC key works with ${curveAlgorithm})`;
  }
  if (pinnedAlgorithm !== undefined && !sameAlgorithm(pinnedAlgorithm, alg)) {
    return `${alg} cannot be used with this key (the key is for ${pinnedAlgorithm})`;
  }
  return undefined;
}

function defaultAlgorithm(key: PreparedKey): string {
  const { kind, curveAlgorithm, pinnedAlgorithm } = key;
  if (pinnedAlgorithm !== undefined) return pinnedAlgorithm;
  switch (kind) {
    case "secret":
      return "HS256";
    case "rsa":
      return "RS256";
    case "ec":
      return curveAlgorithm!;
    case "ed25519":
      return "EdDSA";
  }
}

function computeSignature(info: AlgorithmInfo, key: PreparedKey, signingInput: string): Buffer {
  if (info.kind === "secret") {
    return new CryptoHasher(info.hash as any, key.secret).update(signingInput).digest();
  }
  const data = Buffer.from(signingInput, "latin1");
  if (info.kind === "ec") {
    return signOneShot(info.hash, data, (key.ecOptions ??= { key: key.keyObject, dsaEncoding: "ieee-p1363" }));
  }
  if (info.pss) {
    return signOneShot(
      info.hash,
      data,
      (key.pssOptions ??= {
        key: key.keyObject,
        padding: RSA_PKCS1_PSS_PADDING,
        saltLength: RSA_PSS_SALTLEN_DIGEST,
      }),
    );
  }
  return signOneShot(info.hash, data, key.keyObject);
}

function checkSignature(info: AlgorithmInfo, key: PreparedKey, signingInput: string, signature: Buffer): boolean {
  if (info.kind === "secret") {
    const expected = computeSignature(info, key, signingInput);
    return expected.length === signature.length && timingSafeEqual(expected, signature);
  }
  const data = Buffer.from(signingInput, "latin1");
  try {
    if (info.kind === "ec") {
      if (signature.length !== info.signatureLength) return false;
      return verifyOneShot(
        info.hash,
        data,
        (key.ecOptions ??= { key: key.keyObject, dsaEncoding: "ieee-p1363" }),
        signature,
      );
    }
    if (info.pss) {
      return verifyOneShot(
        info.hash,
        data,
        (key.pssOptions ??= {
          key: key.keyObject,
          padding: RSA_PKCS1_PSS_PADDING,
          saltLength: RSA_PSS_SALTLEN_DIGEST,
        }),
        signature,
      );
    }
    return verifyOneShot(info.hash, data, key.keyObject, signature);
  } catch {
    // A signature that the native verifier cannot even parse is a signature that does not match.
    return false;
  }
}

/** The six bits a base64url character stands for, or -1. */
function base64URLValue(c: number): number {
  if (c >= 0x41 && c <= 0x5a) return c - 0x41; // A-Z
  if (c >= 0x61 && c <= 0x7a) return c - 0x61 + 26; // a-z
  if (c >= 0x30 && c <= 0x39) return c - 0x30 + 52; // 0-9
  if (c === 0x2d) return 62; // -
  if (c === 0x5f) return 63; // _
  return -1;
}

function isBase64URL(value: string): boolean {
  const length = value.length;
  for (let i = 0; i < length; i++) {
    if (base64URLValue(value.charCodeAt(i)) < 0) return false;
  }
  const rest = length % 4;
  if (rest === 0) return true;
  // 4n + 1 characters cannot encode a whole number of bytes.
  if (rest === 1) return false;
  // The bits of the last character that are not part of a byte have to be zero. Otherwise up to 16
  // signature strings decode to the same bytes, and one signed token has that many valid spellings.
  return (base64URLValue(value.charCodeAt(length - 1)) & (rest === 2 ? 0b1111 : 0b11)) === 0;
}

function encodeJSON(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

let utf8Decoder: TextDecoder | undefined;

function decodeJSONObject(segment: string, what: string): Record<string, unknown> {
  let parsed;
  try {
    utf8Decoder ??= new TextDecoder("utf-8", { fatal: true });
    parsed = JSON.parse(utf8Decoder.decode(Buffer.from(segment, "base64url")));
  } catch {
    throw $ERR_JWT_INVALID(`The JWT ${what} is not valid JSON`);
  }
  if (parsed === null || typeof parsed !== "object" || $isArray(parsed)) {
    throw $ERR_JWT_INVALID(`The JWT ${what} must be a JSON object`);
  }
  return parsed;
}

interface TokenParts {
  header: Record<string, unknown>;
  encodedPayload: string;
  encodedSignature: string;
  signingInput: string;
}

function splitToken(token: unknown): TokenParts {
  if (typeof token !== "string") {
    throw $ERR_INVALID_ARG_TYPE("token", "string", token);
  }
  const firstDot = token.indexOf(".");
  const secondDot = firstDot === -1 ? -1 : token.indexOf(".", firstDot + 1);
  if (secondDot === -1) {
    throw $ERR_JWT_INVALID("A JWT has three parts separated by dots");
  }
  if (token.indexOf(".", secondDot + 1) !== -1) {
    if (token.split(".").length === 5) {
      throw $ERR_JWT_INVALID("Encrypted JWTs (JWE) are not supported");
    }
    throw $ERR_JWT_INVALID("A JWT has three parts separated by dots");
  }

  const encodedHeader = token.slice(0, firstDot);
  const encodedPayload = token.slice(firstDot + 1, secondDot);
  const encodedSignature = token.slice(secondDot + 1);
  if (encodedHeader.length === 0 || encodedPayload.length === 0) {
    throw $ERR_JWT_INVALID("A JWT has three parts separated by dots");
  }
  if (!isBase64URL(encodedHeader) || !isBase64URL(encodedPayload) || !isBase64URL(encodedSignature)) {
    throw $ERR_JWT_INVALID("The parts of a JWT must be canonical base64url without padding");
  }

  return {
    header: decodeJSONObject(encodedHeader, "header"),
    encodedPayload,
    encodedSignature,
    signingInput: token.slice(0, secondDot),
  };
}

const durationUnits = {
  __proto__: null,
  s: 1,
  sec: 1,
  secs: 1,
  second: 1,
  seconds: 1,
  m: 60,
  min: 60,
  mins: 60,
  minute: 60,
  minutes: 60,
  h: 3600,
  hr: 3600,
  hrs: 3600,
  hour: 3600,
  hours: 3600,
  d: 86400,
  day: 86400,
  days: 86400,
  w: 604800,
  week: 604800,
  weeks: 604800,
  y: 31557600,
  yr: 31557600,
  yrs: 31557600,
  year: 31557600,
  years: 31557600,
} as any as Record<string, number>;

const durationPattern = /^([+-]?\d+(?:\.\d+)?)\s*([a-zA-Z]+)$/;

/** Seconds. A number is taken as is, a string needs a unit: "30s", "15m", "12 hours", "7d". */
function parseDuration(value: unknown, name: string): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw $ERR_INVALID_ARG_VALUE(name, value, "must be a finite number of seconds");
    return value;
  }
  if (typeof value !== "string") {
    throw $ERR_INVALID_ARG_TYPE(name, ["number", "string"], value);
  }
  const match = durationPattern.exec(value.trim());
  const unit = match ? durationUnits[match[2].toLowerCase()] : undefined;
  if (unit === undefined) {
    throw $ERR_INVALID_ARG_VALUE(
      name,
      value,
      'must be a number of seconds or a string with a unit, such as "30s", "15m", "2h" or "7d"',
    );
  }
  const seconds = Math.round(Number(match![1]) * unit);
  // Enough digits overflow to Infinity, which a number is refused for above, and which JSON writes as null.
  if (!Number.isFinite(seconds)) throw $ERR_INVALID_ARG_VALUE(name, value, "must be a finite number of seconds");
  return seconds;
}

/** A NumericDate claim that is `duration` after `issuedAt`. */
function timeAfter(issuedAt: number, duration: unknown, name: string): number {
  const time = issuedAt + parseDuration(duration, name);
  if (!Number.isFinite(time)) {
    throw $ERR_INVALID_ARG_VALUE(name, duration, "is too far from the time the token is issued at");
  }
  return time;
}

function validateOptionalString(value: unknown, name: string): asserts value is string | undefined {
  if (value !== undefined && typeof value !== "string") {
    throw $ERR_INVALID_ARG_TYPE(name, "string", value);
  }
}

function validateStringOrStringArray(value: any, name: string) {
  if (typeof value === "string") return;
  if ($isArray(value) && value.length > 0 && value.every(item => typeof item === "string")) return;
  throw $ERR_INVALID_ARG_TYPE(name, ["string", "string[]"], value);
}

const signOptionNames = [
  "algorithm",
  "expiresIn",
  "notBefore",
  "issuer",
  "subject",
  "audience",
  "jwtId",
  "keyId",
  "noTimestamp",
  "header",
];

const verifyOptionNames = [
  "algorithms",
  "requiredClaims",
  "issuer",
  "subject",
  "jwtId",
  "audience",
  "clockTolerance",
  "maxAge",
  "currentDate",
  "ignoreExpiration",
  "ignoreNotBefore",
  "complete",
];

// The options that jsonwebtoken spells differently, and the two that are easy to take for each other.
const renamedOptions = {
  __proto__: null,
  jwtid: "jwtId",
  keyid: "keyId",
  clockTimestamp: "currentDate",
  algorithm: "algorithms",
  algorithms: "algorithm",
} as any as Record<string, string>;

function validateOptions(options: any, names: string[]): Record<string, any> {
  if (options === undefined) return { __proto__: null } as any;
  if (options === null || typeof options !== "object" || $isArray(options)) {
    throw $ERR_INVALID_ARG_TYPE("options", "object", options);
  }
  // The caller's own properties, each read once, on an object without a prototype: something that
  // pollutes Object.prototype (`ignoreExpiration = true`) must not be able to switch a check off.
  const own: Record<string, any> = { __proto__: null, ...(options as object) };
  // A check that is misspelt is a check that is not made, so a name that is not an option is an
  // error. `{ jwtid: id }` must not verify every token because the option is called `jwtId`.
  for (const name of Object.keys(own)) {
    if (!names.includes(name)) {
      const renamed = renamedOptions[name];
      throw $ERR_INVALID_ARG_VALUE(
        `options.${name}`,
        own[name],
        renamed !== undefined && names.includes(renamed)
          ? `is not an option, "${renamed}" is`
          : `is not an option. The options are: ${names.join(", ")}`,
      );
    }
  }
  return own;
}

function validateAlgorithmName(alg: unknown, name: string): AlgorithmInfo {
  if (typeof alg !== "string") throw $ERR_INVALID_ARG_TYPE(name, "string", alg);
  const info = algorithms[alg];
  if (info === undefined) {
    throw $ERR_INVALID_ARG_VALUE(
      name,
      alg,
      `must be one of: ${Object.keys(algorithms).join(", ")}` +
        (alg.toLowerCase() === "none" ? '. Unsigned tokens ("none") are not supported' : ""),
    );
  }
  return info;
}

function setClaim(
  claims: Record<string, unknown>,
  claim: string,
  optionName: string,
  value: unknown,
  optionValue: unknown = value,
) {
  if (claims[claim] !== undefined) {
    throw $ERR_INVALID_ARG_VALUE(
      `options.${optionName}`,
      optionValue,
      `cannot be used when the payload already has "${claim}"`,
    );
  }
  claims[claim] = value;
}

function sign(payload: object, key: unknown, options?: unknown): string {
  if (
    payload === null ||
    typeof payload !== "object" ||
    $isArray(payload) ||
    isArrayBufferView(payload) ||
    isAnyArrayBuffer(payload)
  ) {
    throw $ERR_INVALID_ARG_TYPE("payload", "object", payload);
  }
  // A Map, a Date, a Promise that was not awaited or a class instance would be signed as `{}` or
  // as whatever fields it happens to have. Two levels, so that objects of another realm pass.
  const prototype = ObjectGetPrototypeOf(payload);
  if (prototype !== null && ObjectGetPrototypeOf(prototype) !== null) {
    throw $ERR_INVALID_ARG_VALUE("payload", payload, "must be a plain object");
  }
  // Every option is read exactly once, so an accessor cannot answer differently the second time.
  const {
    algorithm,
    expiresIn,
    notBefore,
    issuer,
    subject,
    audience,
    jwtId,
    keyId,
    noTimestamp,
    header: extraHeader,
  } = validateOptions(options, signOptionNames);
  const prepared = prepareKey(key, true);

  const alg: string = algorithm !== undefined ? algorithm : defaultAlgorithm(prepared);
  const info = validateAlgorithmName(alg, "options.algorithm");
  const mismatch = algorithmMismatch(alg, info, prepared);
  if (mismatch !== undefined) throw invalidKey(mismatch);

  const claims: Record<string, unknown> = { ...payload };
  for (const claim of ["exp", "nbf", "iat"]) {
    const value = claims[claim];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
      throw $ERR_INVALID_ARG_VALUE(`payload.${claim}`, value, "must be a number of seconds since the Unix epoch");
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const omitTimestamp = optionalBoolean(noTimestamp, "options.noTimestamp");
  if (claims.iat === undefined && !omitTimestamp) claims.iat = now;
  const issuedAt = typeof claims.iat === "number" ? claims.iat : now;

  if (expiresIn !== undefined) {
    setClaim(claims, "exp", "expiresIn", timeAfter(issuedAt, expiresIn, "options.expiresIn"), expiresIn);
  }
  if (notBefore !== undefined) {
    setClaim(claims, "nbf", "notBefore", timeAfter(issuedAt, notBefore, "options.notBefore"), notBefore);
  }
  if (issuer !== undefined) {
    validateOptionalString(issuer, "options.issuer");
    setClaim(claims, "iss", "issuer", issuer);
  }
  if (subject !== undefined) {
    validateOptionalString(subject, "options.subject");
    setClaim(claims, "sub", "subject", subject);
  }
  if (audience !== undefined) {
    validateStringOrStringArray(audience, "options.audience");
    setClaim(claims, "aud", "audience", audience);
  }
  if (jwtId !== undefined) {
    validateOptionalString(jwtId, "options.jwtId");
    setClaim(claims, "jti", "jwtId", jwtId);
  }

  validateOptionalString(keyId, "options.keyId");
  let header: Record<string, unknown> = { alg, typ: "JWT" };
  if (keyId !== undefined) header.kid = keyId;
  if (extraHeader !== undefined) {
    if (extraHeader === null || typeof extraHeader !== "object" || $isArray(extraHeader)) {
      throw $ERR_INVALID_ARG_TYPE("options.header", "object", extraHeader);
    }
    // Copied first: everything below sees one consistent set of values.
    const extra: Record<string, unknown> = { ...(extraHeader as object) };
    const { alg: extraAlg, kid: extraKid, crit } = extra;
    if (keyId !== undefined && extraKid !== undefined && extraKid !== keyId) {
      throw $ERR_INVALID_ARG_VALUE("options.header.kid", extraKid, 'cannot differ from "options.keyId"');
    }
    if (extraAlg !== undefined && extraAlg !== alg) {
      throw $ERR_INVALID_ARG_VALUE(
        "options.header.alg",
        extraAlg,
        'cannot differ from the signing algorithm; use "options.algorithm"',
      );
    }
    if (crit !== undefined) {
      throw $ERR_INVALID_ARG_VALUE("options.header.crit", crit, "is not supported");
    }
    header = { ...header, ...extra, alg };
  }

  const signingInput = encodeJSON(header) + "." + encodeJSON(claims);
  return signingInput + "." + computeSignature(info, prepared, signingInput).toString("base64url");
}

function claimError(message: string, claim: string) {
  const error: any = $ERR_JWT_CLAIM_VALIDATION_FAILED(message);
  error.claim = claim;
  return error;
}

function numericDateClaim(payload: Record<string, unknown>, claim: string): number | undefined {
  const value = payload[claim];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw claimError(`The "${claim}" claim must be a number`, claim);
  }
  return value;
}

function matchesOne(actual: unknown, expected: string | string[]): boolean {
  return typeof actual === "string" && (typeof expected === "string" ? actual === expected : expected.includes(actual));
}

/** The options of verify(), checked and normalized before the token is looked at. */
interface VerifyChecks {
  algorithms?: string[];
  requiredClaims?: string[];
  issuer?: string | string[];
  subject?: string;
  jwtId?: string;
  audience?: string | string[];
  /** Seconds */
  clockTolerance: number;
  /** Seconds */
  maxAge?: number;
  /** Seconds since the Unix epoch. The system clock is read when this is undefined. */
  now?: number;
  ignoreExpiration: boolean;
  ignoreNotBefore: boolean;
  complete: boolean;
}

const defaultVerifyChecks: VerifyChecks = {
  clockTolerance: 0,
  ignoreExpiration: false,
  ignoreNotBefore: false,
  complete: false,
};

function optionalBoolean(value: unknown, name: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw $ERR_INVALID_ARG_TYPE(name, "boolean", value);
  return value;
}

function readVerifyOptions(options: unknown): VerifyChecks {
  if (options === undefined) return defaultVerifyChecks;
  // Every option is read exactly once, so an accessor cannot answer differently the second time.
  const {
    algorithms: allowed,
    requiredClaims,
    issuer,
    subject,
    jwtId,
    audience,
    clockTolerance,
    maxAge,
    currentDate,
    ignoreExpiration,
    ignoreNotBefore,
    complete,
  } = validateOptions(options, verifyOptionNames);
  const checks: VerifyChecks = {
    clockTolerance: 0,
    ignoreExpiration: optionalBoolean(ignoreExpiration, "options.ignoreExpiration"),
    ignoreNotBefore: optionalBoolean(ignoreNotBefore, "options.ignoreNotBefore"),
    complete: optionalBoolean(complete, "options.complete"),
  };

  if (allowed !== undefined) {
    if (!$isArray(allowed) || allowed.length === 0) {
      throw $ERR_INVALID_ARG_TYPE("options.algorithms", "non-empty string[]", allowed);
    }
    for (let i = 0; i < allowed.length; i++) validateAlgorithmName(allowed[i], `options.algorithms[${i}]`);
    checks.algorithms = allowed;
  }
  if (requiredClaims !== undefined) {
    if (!$isArray(requiredClaims) || !requiredClaims.every(item => typeof item === "string")) {
      throw $ERR_INVALID_ARG_TYPE("options.requiredClaims", "string[]", requiredClaims);
    }
    checks.requiredClaims = requiredClaims;
  }
  if (issuer !== undefined) {
    validateStringOrStringArray(issuer, "options.issuer");
    checks.issuer = issuer;
  }
  if (subject !== undefined) {
    validateOptionalString(subject, "options.subject");
    checks.subject = subject;
  }
  if (jwtId !== undefined) {
    validateOptionalString(jwtId, "options.jwtId");
    checks.jwtId = jwtId;
  }
  if (audience !== undefined) {
    validateStringOrStringArray(audience, "options.audience");
    checks.audience = audience;
  }
  if (clockTolerance !== undefined) {
    const tolerance = parseDuration(clockTolerance, "options.clockTolerance");
    if (tolerance < 0) throw $ERR_INVALID_ARG_VALUE("options.clockTolerance", clockTolerance, "must not be negative");
    checks.clockTolerance = tolerance;
  }
  if (maxAge !== undefined) {
    checks.maxAge = parseDuration(maxAge, "options.maxAge");
  }
  if (currentDate !== undefined) {
    const ms = isDate(currentDate) ? currentDate.getTime() : NaN;
    if (Number.isNaN(ms)) throw $ERR_INVALID_ARG_TYPE("options.currentDate", "Date", currentDate);
    checks.now = Math.floor(ms / 1000);
  }
  return checks;
}

function validateClaims(payload: Record<string, unknown>, checks: VerifyChecks) {
  const { requiredClaims, issuer, subject, jwtId, audience, maxAge } = checks;
  if (requiredClaims !== undefined) {
    for (const claim of requiredClaims) {
      // Own properties only: every object has a "constructor" and a "toString".
      if (!ObjectPrototypeHasOwnProperty.$call(payload, claim)) {
        throw claimError(`The "${claim}" claim is required`, claim);
      }
    }
  }
  if (issuer !== undefined && !matchesOne(payload.iss, issuer)) {
    throw claimError('The "iss" claim does not match', "iss");
  }
  if (subject !== undefined && payload.sub !== subject) {
    throw claimError('The "sub" claim does not match', "sub");
  }
  if (jwtId !== undefined && payload.jti !== jwtId) {
    throw claimError('The "jti" claim does not match', "jti");
  }
  if (audience !== undefined) {
    const aud: any = payload.aud;
    const matches = $isArray(aud) ? aud.some(item => matchesOne(item, audience)) : matchesOne(aud, audience);
    if (!matches) throw claimError('The "aud" claim does not match', "aud");
  }

  const now = checks.now ?? Math.floor(Date.now() / 1000);
  const tolerance = checks.clockTolerance;

  const nbf = numericDateClaim(payload, "nbf");
  if (nbf !== undefined && !checks.ignoreNotBefore && nbf > now + tolerance) {
    const error: any = $ERR_JWT_NOT_ACTIVE('The JWT is not active yet ("nbf" is in the future)');
    error.claim = "nbf";
    error.date = new Date(nbf * 1000);
    throw error;
  }

  // RFC 7519 section 4.1.4: "the current date/time MUST be before the expiration date/time".
  const exp = numericDateClaim(payload, "exp");
  if (exp !== undefined && !checks.ignoreExpiration && exp <= now - tolerance) {
    const error: any = $ERR_JWT_EXPIRED('The JWT has expired ("exp" is in the past)');
    error.claim = "exp";
    error.expiredAt = new Date(exp * 1000);
    throw error;
  }

  const iat = numericDateClaim(payload, "iat");
  if (maxAge !== undefined) {
    if (iat === undefined) throw claimError('The "iat" claim is required when "maxAge" is set', "iat");
    const age = now - iat;
    if (age - tolerance > maxAge) {
      const error: any = $ERR_JWT_EXPIRED('The JWT is too old ("iat" is more than "maxAge" in the past)');
      error.claim = "iat";
      error.expiredAt = new Date((iat + maxAge) * 1000);
      throw error;
    }
    if (age < -tolerance) throw claimError('The "iat" claim is in the future', "iat");
  }
}

function verify(token: string, key: unknown, options?: unknown) {
  const checks = readVerifyOptions(options);
  const parts = splitToken(token);
  const header = parts.header;
  const prepared = prepareKey(key, false);

  const alg = header.alg;
  if (typeof alg !== "string") {
    throw $ERR_JWT_INVALID('The JWT header must have a string "alg"');
  }
  const info = algorithms[alg];
  if (info === undefined) {
    throw $ERR_JWT_ALGORITHM_NOT_ALLOWED(
      alg.toLowerCase() === "none"
        ? 'Unsigned JWTs ("alg": "none") are not accepted'
        : `The JWT is signed with an unsupported algorithm: ${JSON.stringify(alg)}`,
    );
  }
  const allowed = checks.algorithms;
  if (allowed !== undefined && !allowed.some(name => sameAlgorithm(name, alg))) {
    throw $ERR_JWT_ALGORITHM_NOT_ALLOWED(`The JWT is signed with ${alg}, which is not one of: ${allowed.join(", ")}`);
  }
  // Whatever the header says, a key is only ever used the way that kind of key is meant to
  // be used. This is what stops a token from claiming HS256 to have an RSA public key, which
  // everybody knows, used as an HMAC secret.
  const mismatch = algorithmMismatch(alg, info, prepared);
  if (mismatch !== undefined) {
    throw $ERR_JWT_ALGORITHM_NOT_ALLOWED(`The JWT is signed with ${alg}, but ${mismatch}`);
  }
  // RFC 7515 section 4.1.11: a token that uses an extension the recipient does not
  // understand must be rejected. No extensions are implemented.
  if (header.crit !== undefined) {
    throw $ERR_JWT_INVALID('The JWT uses a critical header extension ("crit"), which is not supported');
  }

  const signature = Buffer.from(parts.encodedSignature, "base64url");
  if (!checkSignature(info, prepared, parts.signingInput, signature)) {
    throw $ERR_JWT_SIGNATURE_VERIFICATION_FAILED("The JWT signature does not match");
  }

  // Only now is the payload worth parsing.
  const payload = decodeJSONObject(parts.encodedPayload, "payload");
  validateClaims(payload, checks);

  return checks.complete ? { header, payload, signature: parts.encodedSignature } : payload;
}

function decode(token: string) {
  const parts = splitToken(token);
  return {
    header: parts.header,
    payload: decodeJSONObject(parts.encodedPayload, "payload"),
    signature: parts.encodedSignature,
  };
}

export default { sign, verify, decode };
