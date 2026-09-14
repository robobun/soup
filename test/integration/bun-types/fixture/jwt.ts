import { JWT } from "bun";
import { createPublicKey, createSecretKey, generateKeyPairSync } from "node:crypto";
import { expectType } from "./utilities";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");

expectType(Bun.JWT.sign({ sub: "1" }, "secret")).is<string>();
expectType(JWT.sign({ sub: "1" }, new Uint8Array(32), { algorithm: "HS512", expiresIn: "2h" })).is<string>();
expectType(
  JWT.sign({ sub: "1", custom: { nested: true } }, privateKey, {
    algorithm: "EdDSA",
    expiresIn: 60,
    notBefore: "5s",
    issuer: "https://example.com",
    subject: "1",
    audience: ["web", "api"],
    jwtId: "id",
    keyId: "2026-01",
    noTimestamp: true,
    header: { typ: "at+jwt", cty: "x", custom: 1 },
  }),
).is<string>();
JWT.sign({}, createSecretKey(Buffer.from("secret")));
JWT.sign({}, new ArrayBuffer(32));
JWT.sign({}, { kty: "oct", k: "c2VjcmV0" });
JWT.sign({}, privateKey.export({ format: "jwk" }));
JWT.verify("a.b.c", { kty: "OKP", crv: "Ed25519", x: "...", kid: "2026-01", alg: "EdDSA", use: "sig" });

expectType(JWT.verify("a.b.c", "secret")).is<JWT.Payload>();
expectType(JWT.verify("a.b.c", publicKey).sub).is<string | undefined>();
expectType(JWT.verify("a.b.c", publicKey).aud).is<string | string[] | undefined>();
expectType(JWT.verify("a.b.c", publicKey).exp).is<number | undefined>();
expectType(JWT.verify("a.b.c", publicKey).anythingElse).is<unknown>();
expectType(JWT.verify<{ role: "admin" | "user" }>("a.b.c", createPublicKey("...")).role).is<"admin" | "user">();
expectType(
  JWT.verify(
    "a.b.c",
    { kty: "EC", crv: "P-256", x: "...", y: "..." },
    {
      algorithms: ["ES256"],
      issuer: ["https://example.com"],
      subject: "1",
      audience: "api",
      jwtId: "id",
      requiredClaims: ["exp"],
      clockTolerance: "30s",
      maxAge: 3600,
      currentDate: new Date(),
      ignoreExpiration: false,
      ignoreNotBefore: false,
    },
  ),
).is<JWT.Payload>();

expectType(JWT.verify("a.b.c", "secret", { complete: true })).is<JWT.Decoded<JWT.Payload>>();
expectType(JWT.verify("a.b.c", "secret", { complete: true }).header.alg).is<JWT.Algorithm>();
expectType(JWT.verify<{ role: string }>("a.b.c", "secret", { complete: true }).payload.role).is<string>();
expectType(JWT.verify("a.b.c", "secret", { complete: false })).is<JWT.Payload>();

expectType(JWT.decode("a.b.c")).is<JWT.Decoded<JWT.Payload, JWT.Algorithm | (string & {})>>();
// What decode() returns is not verified, so its "alg" can be anything. What verify() returns is one of ours.
if (JWT.decode("a.b.c").header.alg === "none") throw new Error("unsigned");
expectType(JWT.decode("a.b.c").header.alg).is<JWT.Algorithm | (string & {})>();
expectType(JWT.decode("a.b.c").header.kid).is<string | undefined>();
expectType(JWT.decode("a.b.c").signature).is<string>();
expectType(JWT.decode<{ role: string }>("a.b.c").payload.role).is<string>();

async function webCryptoKeys() {
  const key = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  expectType(JWT.verify(JWT.sign({}, key), key)).is<JWT.Payload>();
}
webCryptoKeys;

// @ts-expect-error
JWT.sign();
// @ts-expect-error
JWT.sign({});
// @ts-expect-error
JWT.sign("payload", "secret");
// @ts-expect-error
JWT.sign({}, "secret", { algorithm: "none" });
// @ts-expect-error
JWT.sign({}, "secret", { expiresIn: new Date() });
// @ts-expect-error
JWT.sign({}, 123);
// @ts-expect-error
JWT.sign({}, { secret: "secret" });
// @ts-expect-error
JWT.verify("a.b.c");
// @ts-expect-error
JWT.verify("a.b.c", "secret", { algorithms: "HS256" });
// @ts-expect-error
JWT.verify("a.b.c", "secret", { algorithms: ["HS-256"] });
// @ts-expect-error
JWT.verify("a.b.c", "secret", { currentDate: 0 });
// @ts-expect-error
JWT.decode();
