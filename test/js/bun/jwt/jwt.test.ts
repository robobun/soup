import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { bunEnv, bunExe, tls } from "harness";
import jsonwebtoken from "jsonwebtoken";
import crypto from "node:crypto";
import vm from "node:vm";

const { JWT } = Bun;

function code(code: string, extra: Record<string, unknown> = {}) {
  return expect.objectContaining({ code, ...extra });
}

function b64u(value: unknown): string {
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
}

/** A token with an arbitrary header and payload, HMAC-signed so that the signature is right for what it says. */
function forge(header: unknown, payload: unknown, secret: string | Buffer = "secret", hash = "sha256"): string {
  const input = `${b64u(header)}.${b64u(payload)}`;
  return `${input}.${crypto.createHmac(hash, secret).update(input).digest("base64url")}`;
}

const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const rsa2 = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const ec256 = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const ec384 = crypto.generateKeyPairSync("ec", { namedCurve: "P-384" });
const ec521 = crypto.generateKeyPairSync("ec", { namedCurve: "P-521" });
const ed25519 = crypto.generateKeyPairSync("ed25519");

const pem = (key: crypto.KeyObject) =>
  key.export({ format: "pem", type: key.type === "private" ? "pkcs8" : "spki" }) as string;

afterEach(() => {
  setSystemTime();
});

describe("RFC test vectors", () => {
  // The claims in RFC 7515 Appendix A expire in 2011.
  const in2011 = { currentDate: new Date("2011-03-22T18:00:00Z") };
  const claims = { iss: "joe", exp: 1300819380, "http://example.com/is_root": true };
  const payload = "eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFtcGxlLmNvbS9pc19yb290Ijp0cnVlfQ";

  test("RFC 7515 A.1: HS256", () => {
    const key = {
      kty: "oct",
      k: "AyM1SysPpbyDfgZld3umj1qzKObwVMkoqQ-EstJQLr_T-1qS0gZH75aKtMN3Yj0iPS4hcgUuTwjAzZr1Z9CAow",
    };
    const token = `eyJ0eXAiOiJKV1QiLA0KICJhbGciOiJIUzI1NiJ9.${payload}.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk`;
    expect(JWT.verify(token, key, in2011)).toEqual(claims);
    expect(JWT.verify(token, Buffer.from(key.k, "base64url"), in2011)).toEqual(claims);
    expect(() => JWT.verify(token, key)).toThrow(code("ERR_JWT_EXPIRED"));
  });

  test("RFC 7515 A.2: RS256", () => {
    const jwk = {
      kty: "RSA",
      n: "ofgWCuLjybRlzo0tZWJjNiuSfb4p4fAkd_wWJcyQoTbji9k0l8W26mPddxHmfHQp-Vaw-4qPCJrcS2mJPMEzP1Pt0Bm4d4QlL-yRT-SFd2lZS-pCgNMsD1W_YpRPEwOWvG6b32690r2jZ47soMZo9wGzjb_7OMg0LOL-bSf63kpaSHSXndS5z5rexMdbBYUsLA9e-KXBdQOS-UTo7WTBEMa2R2CapHg665xsmtdVMTBQY4uDZlxvb3qCo5ZwKh9kG4LT6_I5IhlJH7aGhyxXFvUK-DWNmoudF8NAco9_h9iaGNj8q2ethFkMLs91kzk2PAcDTW9gb54h4FRWyuXpoQ",
      e: "AQAB",
      d: "Eq5xpGnNCivDflJsRQBXHx1hdR1k6Ulwe2JZD50LpXyWPEAeP88vLNO97IjlA7_GQ5sLKMgvfTeXZx9SE-7YwVol2NXOoAJe46sui395IW_GO-pWJ1O0BkTGoVEn2bKVRUCgu-GjBVaYLU6f3l9kJfFNS3E0QbVdxzubSu3Mkqzjkn439X0M_V51gfpRLI9JYanrC4D4qAdGcopV_0ZHHzQlBjudU2QvXt4ehNYTCBr6XCLQUShb1juUO1ZdiYoFaFQT5Tw8bGUl_x_jTj3ccPDVZFD9pIuhLhBOneufuBiB4cS98l2SR_RQyGWSeWjnczT0QU91p1DhOVRuOopznQ",
      p: "4BzEEOtIpmVdVEZNCqS7baC4crd0pqnRH_5IB3jw3bcxGn6QLvnEtfdUdiYrqBdss1l58BQ3KhooKeQTa9AB0Hw_Py5PJdTJNPY8cQn7ouZ2KKDcmnPGBY5t7yLc1QlQ5xHdwW1VhvKn-nXqhJTBgIPgtldC-KDV5z-y2XDwGUc",
      q: "uQPEfgmVtjL0Uyyx88GZFF1fOunH3-7cepKmtH4pxhtCoHqpWmT8YAmZxaewHgHAjLYsp1ZSe7zFYHj7C6ul7TjeLQeZD_YwD66t62wDmpe_HlB-TnBA-njbglfIsRLtXlnDzQkv5dTltRJ11BKBBypeeF6689rjcJIDEz9RWdc",
      dp: "BwKfV3Akq5_MFZDFZCnW-wzl-CCo83WoZvnLQwCTeDv8uzluRSnm71I3QCLdhrqE2e9YkxvuxdBfpT_PI7Yz-FOKnu1R6HsJeDCjn12Sk3vmAktV2zb34MCdy7cpdTh_YVr7tss2u6vneTwrA86rZtu5Mbr1C1XsmvkxHQAdYo0",
      dq: "h_96-mK1R_7glhsum81dZxjTnYynPbZpHziZjeeHcXYsXaaMwkOlODsWa7I9xXDoRwbKgB719rrmI2oKr6N3Do9U0ajaHF-NKJnwgjMd2w9cjz3_-kyNlxAr2v4IKhGNpmM5iIgOS1VZnOZ68m6_pbLBSp3nssTdlqvd0tIiTHU",
      qi: "IYd7DHOhrWvxkwPQsRM2tOgrjbcrfvtQJipd-DlcxyVuuM9sQLdgjVk2oy26F0EmpScGLq2MowX7fhd_QJQ3ydy5cY7YIBi87w93IKLEdfnbJtoOPLUW0ITrJReOgo1cq9SbsxYawBgfp_gh6A5603k2-ZQwVK0JKSHuLFkuQ3U",
    };
    const signature =
      "cC4hiUPoj9Eetdgtv3hF80EGrhuB__dzERat0XF9g2VtQgr9PJbu3XOiZj5RZmh7AAuHIm4Bh-0Qc_lF5YKt_O8W2Fp5jujGbds9uJdbF9CUAr7t1dnZcAcQjbKBYNX4BAynRFdiuB--f_nZLgrnbyTyWzO75vRK5h6xBArLIARNPvkSjtQBMHlb1L07Qe7K0GarZRmB_eSN9383LcOLn6_dO--xi12jzDwusC-eOkHWEsqtFZESc6BfI7noOPqvhJ1phCnvWh6IeYI2w9QOYEUipUTI8np6LbgGY9Fs98rqVt5AXLIhWkWywlVmtVrBp0igcN_IoypGlUPQGe77Rw";
    const token = `eyJhbGciOiJSUzI1NiJ9.${payload}.${signature}`;
    expect(JWT.verify(token, { kty: "RSA", n: jwk.n, e: jwk.e }, in2011)).toEqual(claims);
    // A private key verifies too: it contains the public one.
    expect(JWT.verify(token, jwk, in2011)).toEqual(claims);

    // RSASSA-PKCS1-v1_5 is deterministic, so signing the same bytes gives the RFC's signature.
    const signed = JWT.sign({ a: 1 }, jwk, { noTimestamp: true, header: { typ: undefined } });
    const [header, body, sig] = signed.split(".");
    expect(header).toBe(b64u({ alg: "RS256" }));
    expect(sig).toBe(
      crypto
        .sign("sha256", Buffer.from(`${header}.${body}`), crypto.createPrivateKey({ key: jwk, format: "jwk" }))
        .toString("base64url"),
    );
  });

  test("RFC 7515 A.3: ES256", () => {
    const jwk = {
      kty: "EC",
      crv: "P-256",
      x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
      y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0",
    };
    const signature = "DtEhU3ljbEg8L38VWAfUAqOyKAM6-Xx-F4GawxaepmXFCgfTjDxw5djxLa8ISlSApmWQxfKTUJqPP3-Kg6NU1Q";
    expect(JWT.verify(`eyJhbGciOiJFUzI1NiJ9.${payload}.${signature}`, jwk, in2011)).toEqual(claims);
  });

  // The last two sign a payload that is not JSON, so they are JWS but not JWT. The signature is
  // checked before the payload is parsed: a good signature fails on the payload, a bad one on the signature.
  test("RFC 7515 A.4: ES512", () => {
    const jwk = {
      kty: "EC",
      crv: "P-521",
      x: "AekpBQ8ST8a8VcfVOTNl353vSrDCLLJXmPk06wTjxrrjcBpXp5EOnYG_NjFZ6OvLFV1jSfS9tsz4qUxcWceqwQGk",
      y: "ADSmRA43Z1DSNx_RvcLI87cdL07l6jQyyBXMoxVg_l2Th-x3S1WDhjDly79ajL4Kkd0AZMaZmh9ubmf63e3kyMj2",
    };
    const signature =
      "AdwMgeerwtHoh-l192l60hp9wAHZFVJbLfD_UxMi70cwnZOYaRI1bKPWROc-mZZqwqT2SI-KGDKB34XO0aw_7XdtAG8GaSwFKdCAPZgoXD2YBJZCPEX3xKpRwcdOO8KpEHwJjyqOgzDO7iKvU8vcnwNrmxYbSW9ERBXukOXolLzeO_Jn";
    expect(() => JWT.verify(`eyJhbGciOiJFUzUxMiJ9.UGF5bG9hZA.${signature}`, jwk)).toThrow(
      code("ERR_JWT_INVALID", { message: "The JWT payload is not valid JSON" }),
    );
    expect(() => JWT.verify(`eyJhbGciOiJFUzUxMiJ9.UGF5bG9hZQ.${signature}`, jwk)).toThrow(
      code("ERR_JWT_SIGNATURE_VERIFICATION_FAILED"),
    );
  });

  test("RFC 8037 A.4: EdDSA", () => {
    const jwk = {
      kty: "OKP",
      crv: "Ed25519",
      d: "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A",
      x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
    };
    const input = "eyJhbGciOiJFZERTQSJ9.RXhhbXBsZSBvZiBFZDI1NTE5IHNpZ25pbmc";
    const signature = "hgyY0il_MGCjP0JzlnLWG1PPOt7-09PGcvMg3AIbQR6dWbhijcNR4ki4iylGjg5BhVsPt9g7sVvpAr_MuM0KAg";
    expect(() => JWT.verify(`${input}.${signature}`, { kty: "OKP", crv: "Ed25519", x: jwk.x })).toThrow(
      code("ERR_JWT_INVALID", { message: "The JWT payload is not valid JSON" }),
    );
    expect(() => JWT.verify(`${input}.${signature.replace("h", "i")}`, jwk)).toThrow(
      code("ERR_JWT_SIGNATURE_VERIFICATION_FAILED"),
    );

    // Ed25519 is deterministic.
    const [header, body, sig] = JWT.sign({ a: 1 }, jwk, { noTimestamp: true }).split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "EdDSA", typ: "JWT" });
    expect(sig).toBe(
      crypto
        .sign(null, Buffer.from(`${header}.${body}`), crypto.createPrivateKey({ key: jwk, format: "jwk" }))
        .toString("base64url"),
    );
  });
});

describe("sign and verify", () => {
  test("HS256 with a string secret is the default", () => {
    setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const token = JWT.sign({ sub: "user_1", admin: true }, "secret");
    const [header, payload, signature] = token.split(".");
    expect(header).toBe(b64u({ alg: "HS256", typ: "JWT" }));
    expect(payload).toBe(b64u({ sub: "user_1", admin: true, iat: 1767225600 }));
    expect(signature).toBe(crypto.createHmac("sha256", "secret").update(`${header}.${payload}`).digest("base64url"));
    expect(JWT.verify(token, "secret")).toEqual({ sub: "user_1", admin: true, iat: 1767225600 });
  });

  // Same kind of key as the one that signed, but a different one.
  const otherRsa = rsa2.publicKey;
  const otherEc = (namedCurve: string) => crypto.generateKeyPairSync("ec", { namedCurve }).publicKey;
  const otherEd25519 = crypto.generateKeyPairSync("ed25519").publicKey;

  const cases: [string, unknown, unknown, unknown][] = [
    ["HS256", "secret", "secret", "another secret"],
    ["HS384", "secret", "secret", "another secret"],
    ["HS512", "secret", "secret", "another secret"],
    ["RS256", rsa.privateKey, rsa.publicKey, otherRsa],
    ["RS384", rsa.privateKey, rsa.publicKey, otherRsa],
    ["RS512", rsa.privateKey, rsa.publicKey, otherRsa],
    ["PS256", rsa.privateKey, rsa.publicKey, otherRsa],
    ["PS384", rsa.privateKey, rsa.publicKey, otherRsa],
    ["PS512", rsa.privateKey, rsa.publicKey, otherRsa],
    ["ES256", ec256.privateKey, ec256.publicKey, otherEc("P-256")],
    ["ES384", ec384.privateKey, ec384.publicKey, otherEc("P-384")],
    ["ES512", ec521.privateKey, ec521.publicKey, otherEc("P-521")],
    ["EdDSA", ed25519.privateKey, ed25519.publicKey, otherEd25519],
    ["Ed25519", ed25519.privateKey, ed25519.publicKey, otherEd25519],
  ];
  test.each(cases)("%s round trip, tampering and wrong key", (algorithm, signingKey, verifyingKey, otherKey) => {
    const token = JWT.sign({ sub: "1", nested: { ok: [1, 2, 3] }, text: "héllo ✓" }, signingKey as any, {
      algorithm: algorithm as any,
      noTimestamp: true,
    });
    const complete = JWT.verify(token, verifyingKey as any, { complete: true });
    expect(complete).toEqual({
      header: { alg: algorithm, typ: "JWT" },
      payload: { sub: "1", nested: { ok: [1, 2, 3] }, text: "héllo ✓" },
      signature: token.split(".")[2],
    });
    expect(JWT.verify(token, verifyingKey as any, { algorithms: [algorithm as any] })).toEqual(complete.payload);

    const [header, payload, signature] = token.split(".");
    const tampered = `${header}.${b64u({ sub: "2" })}.${signature}`;
    expect(() => JWT.verify(tampered, verifyingKey as any)).toThrow(code("ERR_JWT_SIGNATURE_VERIFICATION_FAILED"));
    const flipped = `${token.slice(0, -signature.length)}${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
    expect(() => JWT.verify(flipped, verifyingKey as any)).toThrow(code("ERR_JWT_SIGNATURE_VERIFICATION_FAILED"));
    expect(() => JWT.verify(token, otherKey as any)).toThrow(code("ERR_JWT_SIGNATURE_VERIFICATION_FAILED"));
    // A prefix of the signature is not the signature, and neither is nothing at all.
    const shorter = Buffer.from(signature, "base64url").subarray(0, -1).toString("base64url");
    for (const cut of ["", shorter]) {
      expect(() => JWT.verify(`${header}.${payload}.${cut}`, verifyingKey as any)).toThrow(
        code("ERR_JWT_SIGNATURE_VERIFICATION_FAILED"),
      );
    }
  });

  test("EdDSA and Ed25519 name the same algorithm", () => {
    const asEdDSA = JWT.sign({ a: 1 }, ed25519.privateKey, { algorithm: "EdDSA", noTimestamp: true });
    const asEd25519 = JWT.sign({ a: 1 }, ed25519.privateKey, { algorithm: "Ed25519", noTimestamp: true });
    expect(JWT.verify(asEdDSA, ed25519.publicKey, { algorithms: ["Ed25519"] })).toEqual({ a: 1 });
    expect(JWT.verify(asEd25519, ed25519.publicKey, { algorithms: ["EdDSA"] })).toEqual({ a: 1 });
    expect(JWT.verify(asEd25519, { ...ed25519.publicKey.export({ format: "jwk" }), alg: "EdDSA" })).toEqual({ a: 1 });
  });

  test("the algorithm is inferred from the key", () => {
    const alg = (key: any) => JWT.decode(JWT.sign({}, key)).header.alg;
    expect(alg("secret")).toBe("HS256");
    expect(alg(rsa.privateKey)).toBe("RS256");
    expect(alg(ec256.privateKey)).toBe("ES256");
    expect(alg(ec384.privateKey)).toBe("ES384");
    expect(alg(ec521.privateKey)).toBe("ES512");
    expect(alg(ed25519.privateKey)).toBe("EdDSA");
    expect(alg({ ...rsa.privateKey.export({ format: "jwk" }), alg: "PS384" })).toBe("PS384");
    expect(alg({ kty: "oct", k: b64u("0123456789abcdef0123456789abcdef"), alg: "HS512" })).toBe("HS512");
  });

  test("every way of passing a key", async () => {
    const roundTrip = (signingKey: any, verifyingKey: any, algorithm?: any) =>
      JWT.verify(JWT.sign({ ok: true }, signingKey, { algorithm, noTimestamp: true }), verifyingKey);
    const ok = { ok: true };

    // Shared secrets
    const bytes = crypto.randomBytes(32);
    expect(roundTrip(bytes, bytes)).toEqual(ok);
    expect(roundTrip(new Uint8Array(bytes), bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + 32))).toEqual(ok);
    expect(roundTrip(new DataView(bytes.buffer, bytes.byteOffset, 32), crypto.createSecretKey(bytes))).toEqual(ok);
    expect(roundTrip({ kty: "oct", k: bytes.toString("base64url") }, bytes)).toEqual(ok);
    expect(roundTrip("pässword", Buffer.from("pässword", "utf8"))).toEqual(ok);

    // PEM, as a string and as the bytes of a file
    expect(roundTrip(pem(rsa.privateKey), pem(rsa.publicKey))).toEqual(ok);
    expect(roundTrip(Buffer.from(pem(ec256.privateKey)), Buffer.from(pem(ec256.publicKey)))).toEqual(ok);
    expect(roundTrip(`\n${pem(ed25519.privateKey)}`, `\n${pem(ed25519.publicKey)}`)).toEqual(ok);
    expect(
      roundTrip(
        rsa.privateKey.export({ format: "pem", type: "pkcs1" }),
        rsa.publicKey.export({ format: "pem", type: "pkcs1" }),
      ),
    ).toEqual(ok);
    expect(roundTrip(ec256.privateKey.export({ format: "pem", type: "sec1" }), pem(ec256.publicKey))).toEqual(ok);
    // Verifying with the private key works: it contains the public key.
    expect(roundTrip(pem(ec384.privateKey), pem(ec384.privateKey))).toEqual(ok);

    // The public key of an X.509 certificate
    expect(roundTrip(tls.key, tls.cert)).toEqual(ok);
    expect(roundTrip(tls.key, new crypto.X509Certificate(tls.cert).publicKey)).toEqual(ok);

    // JSON Web Keys
    expect(roundTrip(rsa.privateKey.export({ format: "jwk" }), rsa.publicKey.export({ format: "jwk" }))).toEqual(ok);
    expect(roundTrip(ec521.privateKey.export({ format: "jwk" }), ec521.publicKey.export({ format: "jwk" }))).toEqual(
      ok,
    );
    expect(
      roundTrip(ed25519.privateKey.export({ format: "jwk" }), ed25519.publicKey.export({ format: "jwk" })),
    ).toEqual(ok);

    // WebCrypto keys
    const hmac = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-384" }, false, ["sign", "verify"]);
    expect(roundTrip(hmac, hmac)).toEqual(ok);
    expect(JWT.decode(JWT.sign({}, hmac)).header.alg).toBe("HS384");
    const ecdsa = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-384" }, false, ["sign", "verify"]);
    expect(roundTrip(ecdsa.privateKey, ecdsa.publicKey)).toEqual(ok);
    const pss = await crypto.subtle.generateKey(
      { name: "RSA-PSS", hash: "SHA-512", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
      false,
      ["sign", "verify"],
    );
    expect(roundTrip(pss.privateKey, pss.publicKey)).toEqual(ok);
    expect(JWT.decode(JWT.sign({}, pss.privateKey)).header.alg).toBe("PS512");
    const eddsa = (await crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"])) as CryptoKeyPair;
    expect(roundTrip(eddsa.privateKey, eddsa.publicKey)).toEqual(ok);
  });

  test("a non-extractable CryptoKey works without a deprecation warning", async () => {
    // node:crypto deprecates being handed CryptoKeys (DEP0203, DEP0204). Bun.JWT takes them on purpose.
    const script = `
      const hmac = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
      const ec = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
      console.log(JSON.stringify([
        Bun.JWT.verify(Bun.JWT.sign({ a: 1 }, hmac, { noTimestamp: true }), hmac),
        Bun.JWT.verify(Bun.JWT.sign({ b: 2 }, ec.privateKey, { noTimestamp: true }), ec.publicKey),
      ]));
    `;
    await using proc = Bun.spawn({
      cmd: [bunExe(), "-e", script],
      env: bunEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect(stderr).toBe("");
    expect(stdout.trim()).toBe('[{"a":1},{"b":2}]');
    expect(exitCode).toBe(0);
  });

  test("interoperates with jsonwebtoken", () => {
    const pairs: [string, any, any][] = [
      ["HS256", "secret", "secret"],
      ["HS512", Buffer.from("secret"), Buffer.from("secret")],
      ["RS256", pem(rsa.privateKey), pem(rsa.publicKey)],
      ["PS256", pem(rsa.privateKey), pem(rsa.publicKey)],
      ["ES256", pem(ec256.privateKey), pem(ec256.publicKey)],
      ["ES384", pem(ec384.privateKey), pem(ec384.publicKey)],
      ["ES512", pem(ec521.privateKey), pem(ec521.publicKey)],
    ];
    for (const [algorithm, signingKey, verifyingKey] of pairs) {
      const theirs = jsonwebtoken.sign({ sub: "1", aud: ["a", "b"] }, signingKey, {
        algorithm: algorithm as any,
        expiresIn: "1h",
        issuer: "them",
        keyid: "k1",
      });
      const verified = JWT.verify(theirs, verifyingKey, { issuer: "them", audience: "b", complete: true });
      expect(verified.header).toEqual({ alg: algorithm, typ: "JWT", kid: "k1" });
      expect(verified.payload).toMatchObject({ sub: "1", aud: ["a", "b"], iss: "them" });

      const ours = JWT.sign({ sub: "1", aud: ["a", "b"] }, signingKey, {
        algorithm: algorithm as any,
        expiresIn: "1h",
        issuer: "us",
        keyId: "k1",
      });
      const decoded = jsonwebtoken.verify(ours, verifyingKey, {
        algorithms: [algorithm as any],
        issuer: "us",
        audience: "a",
        complete: true,
      }) as jsonwebtoken.Jwt;
      expect(decoded.header).toEqual({ alg: algorithm, typ: "JWT", kid: "k1" });
      expect(decoded.payload).toEqual(JWT.verify(ours, verifyingKey));
    }
  });
});

describe("algorithm and key rules", () => {
  test('"alg": "none" is never accepted', () => {
    for (const alg of ["none", "None", "NONE", "nOnE"]) {
      const token = `${b64u({ alg, typ: "JWT" })}.${b64u({ sub: "admin" })}.`;
      expect(() => JWT.verify(token, "secret")).toThrow(code("ERR_JWT_ALGORITHM_NOT_ALLOWED"));
      expect(() => JWT.verify(token, pem(rsa.publicKey))).toThrow(code("ERR_JWT_ALGORITHM_NOT_ALLOWED"));
    }
    expect(() => JWT.sign({}, "secret", { algorithm: "none" as any })).toThrow(code("ERR_INVALID_ARG_VALUE"));
    expect(() => JWT.verify(JWT.sign({}, "secret"), "secret", { algorithms: ["none" as any] })).toThrow(
      code("ERR_INVALID_ARG_VALUE"),
    );
  });

  test("an HMAC token signed with the text of a public key is rejected (algorithm confusion)", () => {
    const publicPem = pem(rsa.publicKey);
    // The attacker knows the public key and uses its text as the HMAC secret.
    const token = forge({ alg: "HS256", typ: "JWT" }, { sub: "admin" }, publicPem);
    for (const key of [publicPem, Buffer.from(publicPem), `\n${publicPem}`, rsa.publicKey, pem(ec256.publicKey)]) {
      expect(() => JWT.verify(token, key)).toThrow(code("ERR_JWT_ALGORITHM_NOT_ALLOWED"));
      // The key decides, whatever the allow-list says.
      expect(() => JWT.verify(token, key, { algorithms: ["HS256"] })).toThrow(code("ERR_JWT_ALGORITHM_NOT_ALLOWED"));
      expect(() => JWT.verify(token, key, { algorithms: ["HS256", "RS256", "ES256"] })).toThrow(
        code("ERR_JWT_ALGORITHM_NOT_ALLOWED"),
      );
    }
    // PEM readers skip what comes before the header, as in the output of `openssl pkcs12`.
    const withAttributes = `Bag Attributes\n    friendlyName: jwt\n${publicPem}`;
    expect(JWT.verify(JWT.sign({ ok: true }, rsa.privateKey, { noTimestamp: true }), withAttributes)).toEqual({
      ok: true,
    });
    for (const key of [withAttributes, Buffer.from(withAttributes)]) {
      const forged = forge({ alg: "HS256", typ: "JWT" }, { sub: "admin" }, key);
      expect(() => JWT.verify(forged, key)).toThrow(code("ERR_JWT_ALGORITHM_NOT_ALLOWED"));
    }
    // OpenSSL does not read an indented header. Such a key is refused, not used as a secret.
    const indented = `  ${publicPem}`;
    expect(() => JWT.verify(forge({ alg: "HS256" }, {}, indented), indented)).toThrow(code("ERR_JWT_INVALID_KEY"));
    // A string that starts like PEM is never used as a secret, even when it is not a valid key.
    const notAKey = "-----BEGIN PUBLIC KEY-----\nnot base64\n-----END PUBLIC KEY-----\n";
    expect(() => JWT.verify(forge({ alg: "HS256" }, {}, notAKey), notAKey)).toThrow(code("ERR_JWT_INVALID_KEY"));
    expect(() => JWT.sign({}, notAKey)).toThrow(code("ERR_JWT_INVALID_KEY"));
  });

  test("an asymmetric token cannot be verified with a shared secret", () => {
    const token = JWT.sign({}, rsa.privateKey);
    expect(() => JWT.verify(token, "secret")).toThrow(code("ERR_JWT_ALGORITHM_NOT_ALLOWED"));
    expect(() => JWT.verify(token, "secret", { algorithms: ["RS256"] })).toThrow(code("ERR_JWT_ALGORITHM_NOT_ALLOWED"));
    expect(() => JWT.verify(token, ec256.publicKey)).toThrow(code("ERR_JWT_ALGORITHM_NOT_ALLOWED"));
    expect(() => JWT.verify(token, ed25519.publicKey)).toThrow(code("ERR_JWT_ALGORITHM_NOT_ALLOWED"));
  });

  test("an EC key only works with the algorithm of its curve", () => {
    expect(() => JWT.sign({}, ec256.privateKey, { algorithm: "ES384" })).toThrow(code("ERR_JWT_INVALID_KEY"));
    expect(() => JWT.sign({}, ec521.privateKey, { algorithm: "ES256" })).toThrow(code("ERR_JWT_INVALID_KEY"));
    expect(() => JWT.verify(JWT.sign({}, ec384.privateKey), ec256.publicKey)).toThrow(
      code("ERR_JWT_ALGORITHM_NOT_ALLOWED"),
    );
    const p224 = crypto.generateKeyPairSync("ec", { namedCurve: "P-224" });
    expect(() => JWT.sign({}, p224.privateKey)).toThrow(code("ERR_JWT_INVALID_KEY"));
    expect(() => JWT.verify(JWT.sign({}, ec256.privateKey), p224.publicKey)).toThrow(code("ERR_JWT_INVALID_KEY"));
  });

  test("an ECDSA signature of the wrong length is rejected", () => {
    const [header, payload, signature] = JWT.sign({}, ec256.privateKey).split(".");
    const der = crypto.sign("sha256", Buffer.from(`${header}.${payload}`), ec256.privateKey).toString("base64url");
    expect(() => JWT.verify(`${header}.${payload}.${der}`, ec256.publicKey)).toThrow(
      code("ERR_JWT_SIGNATURE_VERIFICATION_FAILED"),
    );
    expect(() => JWT.verify(`${header}.${payload}.${signature}AAAA`, ec256.publicKey)).toThrow(
      code("ERR_JWT_SIGNATURE_VERIFICATION_FAILED"),
    );
  });

  test("the algorithms option restricts what is accepted", () => {
    const token = JWT.sign({}, "secret", { algorithm: "HS384" });
    expect(JWT.verify(token, "secret", { algorithms: ["HS256", "HS384"], complete: true }).header.alg).toBe("HS384");
    expect(() => JWT.verify(token, "secret", { algorithms: ["HS256"] })).toThrow(
      code("ERR_JWT_ALGORITHM_NOT_ALLOWED", { message: "The JWT is signed with HS384, which is not one of: HS256" }),
    );
    const pss = JWT.sign({}, rsa.privateKey, { algorithm: "PS256" });
    expect(() => JWT.verify(pss, rsa.publicKey, { algorithms: ["RS256"] })).toThrow(
      code("ERR_JWT_ALGORITHM_NOT_ALLOWED"),
    );
    expect(() => JWT.verify(token, "secret", { algorithms: [] })).toThrow(code("ERR_INVALID_ARG_TYPE"));
    expect(() => JWT.verify(token, "secret", { algorithms: "HS384" as any })).toThrow(code("ERR_INVALID_ARG_TYPE"));
    expect(() => JWT.verify(token, "secret", { algorithms: ["HS-384" as any] })).toThrow(code("ERR_INVALID_ARG_VALUE"));
  });

  test("unknown algorithms in a token are rejected", () => {
    for (const alg of ["HS1", "RS1", "ES256K", "__proto__", "constructor", "toString", ""]) {
      expect(() => JWT.verify(forge({ alg }, {}), "secret")).toThrow(code("ERR_JWT_ALGORITHM_NOT_ALLOWED"));
    }
    for (const alg of [undefined, null, 256, ["HS256"], { name: "HS256" }]) {
      expect(() => JWT.verify(forge({ alg }, {}), "secret")).toThrow(code("ERR_JWT_INVALID"));
    }
  });

  test("a key that names its algorithm only works with that algorithm", async () => {
    const secret = crypto.randomBytes(64);
    const hs512 = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-512" }, false, [
      "sign",
      "verify",
    ]);
    const asHS256 = JWT.sign({}, secret, { algorithm: "HS256" });
    expect(JWT.verify(asHS256, secret)).toBeDefined();
    expect(() => JWT.verify(asHS256, hs512)).toThrow(code("ERR_JWT_ALGORITHM_NOT_ALLOWED"));
    expect(() => JWT.sign({}, hs512, { algorithm: "HS256" })).toThrow(code("ERR_JWT_INVALID_KEY"));

    const rs256Jwk = { ...rsa.publicKey.export({ format: "jwk" }), alg: "RS256" };
    expect(() => JWT.verify(JWT.sign({}, rsa.privateKey, { algorithm: "PS256" }), rs256Jwk)).toThrow(
      code("ERR_JWT_ALGORITHM_NOT_ALLOWED"),
    );
    expect(JWT.verify(JWT.sign({}, rsa.privateKey, { algorithm: "RS256" }), rs256Jwk)).toBeDefined();

    const signOnly = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    expect(() => JWT.verify(JWT.sign({}, signOnly), signOnly)).toThrow(code("ERR_JWT_INVALID_KEY"));
    const aes = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt"]);
    expect(() => JWT.sign({}, aes)).toThrow(code("ERR_JWT_INVALID_KEY"));
  });

  test("keys that cannot be used", () => {
    expect(() => JWT.sign({}, rsa.publicKey)).toThrow(code("ERR_JWT_INVALID_KEY"));
    expect(() => JWT.sign({}, pem(rsa.publicKey))).toThrow(code("ERR_JWT_INVALID_KEY"));
    expect(() => JWT.sign({}, rsa.publicKey.export({ format: "jwk" }))).toThrow(code("ERR_JWT_INVALID_KEY"));
    expect(() => JWT.sign({}, "")).toThrow(code("ERR_JWT_INVALID_KEY"));
    expect(() => JWT.sign({}, new Uint8Array(0))).toThrow(code("ERR_JWT_INVALID_KEY"));
    expect(() => JWT.sign({}, crypto.createSecretKey(Buffer.alloc(0)))).toThrow(
      code("ERR_JWT_INVALID_KEY", { message: "The secret must not be empty" }),
    );
    expect(() => JWT.verify(JWT.sign({}, "x"), "")).toThrow(code("ERR_JWT_INVALID_KEY"));
    expect(() => JWT.sign({}, "secret", { algorithm: "RS256" })).toThrow(code("ERR_JWT_INVALID_KEY"));
    expect(() => JWT.sign({}, rsa.privateKey, { algorithm: "HS256" })).toThrow(code("ERR_JWT_INVALID_KEY"));
    expect(() => JWT.sign({}, { ...rsa.privateKey.export({ format: "jwk" }), use: "enc" })).toThrow(
      code("ERR_JWT_INVALID_KEY"),
    );
    expect(() => JWT.sign({}, { kty: "oct", k: "not base64url!" })).toThrow(code("ERR_JWT_INVALID_KEY"));
    expect(() => JWT.sign({}, { kty: "oct", k: b64u("secret"), alg: "A256GCM" })).toThrow(code("ERR_JWT_INVALID_KEY"));
    // An empty secret is refused in a JSON Web Key too: anybody can sign with it.
    expect(() => JWT.sign({}, { kty: "oct", k: "" })).toThrow(
      code("ERR_JWT_INVALID_KEY", { message: "The secret must not be empty" }),
    );
    expect(() => JWT.verify(forge({ alg: "HS256" }, { sub: "admin" }, ""), { kty: "oct", k: "" })).toThrow(
      code("ERR_JWT_INVALID_KEY"),
    );
    const x25519 = crypto.generateKeyPairSync("x25519");
    expect(() => JWT.sign({}, x25519.privateKey)).toThrow(code("ERR_JWT_INVALID_KEY"));

    for (const key of [undefined, null, 1, true, Symbol("k"), () => "secret"]) {
      expect(() => JWT.sign({}, key as any)).toThrow(code("ERR_INVALID_ARG_TYPE"));
      expect(() => JWT.verify(JWT.sign({}, "secret"), key as any)).toThrow(code("ERR_INVALID_ARG_TYPE"));
    }
    expect(() => JWT.sign({}, {} as any)).toThrow(code("ERR_INVALID_ARG_TYPE"));
  });

  test('a JSON Web Key with "key_ops" is only used for those operations', () => {
    const publicJwk = rsa.publicKey.export({ format: "jwk" });
    const privateJwk = rsa.privateKey.export({ format: "jwk" });
    const token = JWT.sign({ ok: true }, { ...privateJwk, key_ops: ["sign"] }, { noTimestamp: true });
    expect(JWT.verify(token, { ...publicJwk, key_ops: ["verify"] })).toEqual({ ok: true });
    expect(JWT.verify(token, { ...publicJwk, key_ops: ["encrypt", "verify"] })).toEqual({ ok: true });
    for (const key_ops of [["encrypt"], ["sign"], [], "verify"]) {
      expect(() => JWT.verify(token, { ...publicJwk, key_ops } as any)).toThrow(code("ERR_JWT_INVALID_KEY"));
    }
    for (const key_ops of [["decrypt"], ["verify"], []]) {
      expect(() => JWT.sign({}, { ...privateJwk, key_ops })).toThrow(code("ERR_JWT_INVALID_KEY"));
    }
    const secret = { kty: "oct", k: b64u("0123456789abcdef0123456789abcdef") };
    expect(() => JWT.sign({}, { ...secret, key_ops: ["verify"] })).toThrow(code("ERR_JWT_INVALID_KEY"));
    expect(
      JWT.verify(JWT.sign({ ok: true }, secret, { noTimestamp: true }), { ...secret, key_ops: ["verify"] }),
    ).toEqual({ ok: true });
  });

  test("a JSON Web Key that is changed after it was used is read again", () => {
    const other = rsa2;
    const signedByOld = JWT.sign({ by: "old" }, rsa.privateKey, { noTimestamp: true });
    const signedByNew = JWT.sign({ by: "new" }, other.privateKey, { noTimestamp: true });

    // Rotated in place: the old key must stop verifying, and the new one must start to.
    const jwk: Record<string, unknown> = { ...rsa.publicKey.export({ format: "jwk" }), kid: "current" };
    expect(JWT.verify(signedByOld, jwk)).toEqual({ by: "old" });
    expect(JWT.verify(signedByOld, jwk)).toEqual({ by: "old" });
    Object.assign(jwk, other.publicKey.export({ format: "jwk" }));
    expect(() => JWT.verify(signedByOld, jwk)).toThrow(code("ERR_JWT_SIGNATURE_VERIFICATION_FAILED"));
    expect(JWT.verify(signedByNew, jwk)).toEqual({ by: "new" });

    // Restricted in place.
    const pss = JWT.sign({}, other.privateKey, { algorithm: "PS256" });
    expect(JWT.verify(pss, jwk)).toBeDefined();
    jwk.alg = "RS256";
    expect(() => JWT.verify(pss, jwk)).toThrow(code("ERR_JWT_ALGORITHM_NOT_ALLOWED"));
    delete jwk.alg;
    expect(JWT.verify(pss, jwk)).toBeDefined();
    jwk.key_ops = ["verify"];
    expect(JWT.verify(pss, jwk)).toBeDefined();
    (jwk.key_ops as string[])[0] = "encrypt";
    expect(() => JWT.verify(pss, jwk)).toThrow(code("ERR_JWT_INVALID_KEY"));
    delete jwk.key_ops;
    jwk.use = "enc";
    expect(() => JWT.verify(pss, jwk)).toThrow(code("ERR_JWT_INVALID_KEY"));

    // A secret: what signs and what verifies is always the current "k".
    const secret = { kty: "oct", k: b64u("the first secret, 32 bytes long!") };
    const first = JWT.sign({ n: 1 }, secret, { noTimestamp: true });
    expect(JWT.verify(first, secret)).toEqual({ n: 1 });
    secret.k = b64u("the second secret, 32 bytes long");
    expect(() => JWT.verify(first, secret)).toThrow(code("ERR_JWT_SIGNATURE_VERIFICATION_FAILED"));
    const second = JWT.sign({ n: 1 }, secret, { noTimestamp: true });
    expect(second).not.toBe(first);
    expect(JWT.verify(second, secret)).toEqual({ n: 1 });
    expect(JWT.verify(second, "the second secret, 32 bytes long")).toEqual({ n: 1 });
  });

  test("RSA keys under 2048 bits are refused", () => {
    const small = crypto.generateKeyPairSync("rsa", { modulusLength: 1024 });
    expect(() => JWT.sign({}, small.privateKey)).toThrow(
      code("ERR_JWT_INVALID_KEY", { message: "RSA keys must be at least 2048 bits, received a 1024 bit key" }),
    );
    const [header, payload] = JWT.sign({}, rsa.privateKey).split(".");
    const signature = crypto.sign("sha256", Buffer.from(`${header}.${payload}`), small.privateKey);
    expect(() => JWT.verify(`${header}.${payload}.${signature.toString("base64url")}`, small.publicKey)).toThrow(
      code("ERR_JWT_INVALID_KEY"),
    );
  });

  test("error messages do not contain the key", () => {
    const secretPem = pem(ec256.privateKey);
    const broken = secretPem.slice(0, 60) + "!!!!" + secretPem.slice(64);
    // Where two P-256 PKCS#8 keys start to differ: past the header and the algorithm identifier.
    const keySpecific = secretPem.slice(76, 92);
    expect(pem(crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey)).not.toContain(keySpecific);
    for (const fn of [() => JWT.sign({}, broken), () => JWT.sign({}, "hunter2", { algorithm: "ES256" })]) {
      let error: any;
      try {
        fn();
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(TypeError);
      expect(error.code).toBe("ERR_JWT_INVALID_KEY");
      expect(Bun.inspect(error)).not.toContain(keySpecific);
      expect(Bun.inspect(error)).not.toContain("hunter2");
    }
  });
});

describe("malformed tokens", () => {
  const secret = "secret";
  // Without "iat", so that the names of the tests below are the same on every run.
  const good = JWT.sign({ sub: "1" }, secret, { noTimestamp: true });
  const [header, payload, signature] = good.split(".");

  test.each([
    ["", "three parts"],
    ["a", "three parts"],
    ["a.b", "three parts"],
    ["a.b.c.d", "three parts"],
    [`.${payload}.${signature}`, "three parts"],
    [`${header}..${signature}`, "three parts"],
    ["a.b.c.d.e", "Encrypted JWTs (JWE) are not supported"],
    [`${header}.${payload}.${signature}=`, "base64url"],
    [`${header}=.${payload}.${signature}`, "base64url"],
    [`${header}.${payload.slice(0, -1)}+.${signature}`, "base64url"],
    [` ${good}`, "base64url"],
    [`${good}\n`, "base64url"],
    [forge("not json", {}), "header is not valid JSON"],
    [forge([1], {}), "header must be a JSON object"],
    [forge(null, {}), "header must be a JSON object"],
    [
      // A byte that is not UTF-8 inside a string, where a lenient decoder would put U+FFFD and carry on.
      `${Buffer.from('{"alg":"HS256","x":"\xff"}', "latin1").toString("base64url")}.${payload}.${signature}`,
      "header is not valid JSON",
    ],
  ])("%p is rejected", (token, message) => {
    expect(() => JWT.verify(token, secret)).toThrow(code("ERR_JWT_INVALID", { name: "JWTError" }));
    expect(() => JWT.verify(token, secret)).toThrow(message);
    expect(() => JWT.decode(token)).toThrow(code("ERR_JWT_INVALID"));
  });

  test.each([
    ["text", "The JWT payload is not valid JSON"],
    [[1, 2], "The JWT payload must be a JSON object"],
    [null, "The JWT payload must be a JSON object"],
    [42, "The JWT payload must be a JSON object"],
  ])("a correctly signed token whose payload is %p is rejected", (body, message) => {
    expect(() => JWT.verify(forge({ alg: "HS256" }, body), secret)).toThrow(code("ERR_JWT_INVALID", { message }));
  });

  test("a correctly signed payload that is not UTF-8 is rejected", () => {
    const input = `${b64u({ alg: "HS256" })}.${Buffer.from('{"sub":"\xc3\x28"}', "latin1").toString("base64url")}`;
    const token = `${input}.${crypto.createHmac("sha256", secret).update(input).digest("base64url")}`;
    expect(() => JWT.verify(token, secret)).toThrow(
      code("ERR_JWT_INVALID", { message: "The JWT payload is not valid JSON" }),
    );
    expect(() => JWT.decode(token)).toThrow(code("ERR_JWT_INVALID"));
  });

  test("a signature with a dangling character is rejected", () => {
    // HS384: 48 bytes are 64 characters, and a lenient decoder ignores a 65th.
    const token = JWT.sign({ sub: "1" }, secret, { algorithm: "HS384", noTimestamp: true });
    const encoded = token.split(".")[2];
    expect(encoded).toHaveLength(64);
    expect(Buffer.from(`${encoded}A`, "base64url")).toEqual(Buffer.from(encoded, "base64url"));
    expect(() => JWT.verify(`${token}A`, secret)).toThrow(code("ERR_JWT_INVALID"));
    expect(() => JWT.decode(`${token}A`)).toThrow(code("ERR_JWT_INVALID"));
  });

  test("a signature whose base64url is not canonical is rejected", () => {
    // The last character of a segment can carry bits that are not part of any byte. When they are not
    // zero the segment still decodes to the same bytes, so one signed token would have several spellings.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const respellings = (token: string, spareBits: number) => {
      const last = alphabet.indexOf(token.at(-1)!);
      expect(last % (1 << spareBits)).toBe(0);
      const all: string[] = [];
      for (let spare = 1; spare < 1 << spareBits; spare++) all.push(token.slice(0, -1) + alphabet[last + spare]);
      return all;
    };
    const sameBytes = (a: string, b: string) =>
      expect(Buffer.from(a.split(".")[2], "base64url")).toEqual(Buffer.from(b.split(".")[2], "base64url"));

    // HS256: 32 bytes are 43 characters, the last one has 2 spare bits.
    for (const respelled of respellings(good, 2)) {
      sameBytes(respelled, good);
      expect(() => JWT.verify(respelled, secret)).toThrow(code("ERR_JWT_INVALID"));
      expect(() => JWT.decode(respelled)).toThrow(code("ERR_JWT_INVALID"));
    }
    // EdDSA: 64 bytes are 86 characters, the last one has 4 spare bits.
    const eddsa = JWT.sign({ sub: "1" }, ed25519.privateKey);
    expect(JWT.verify(eddsa, ed25519.publicKey)).toMatchObject({ sub: "1" });
    const respelled = respellings(eddsa, 4);
    expect(respelled).toHaveLength(15);
    for (const token of respelled) {
      sameBytes(token, eddsa);
      expect(() => JWT.verify(token, ed25519.publicKey)).toThrow(code("ERR_JWT_INVALID"));
    }
    // The same goes for the "k" of a JSON Web Key.
    expect(() => JWT.sign({}, { kty: "oct", k: "c2VjcmV0MR" })).toThrow(code("ERR_JWT_INVALID_KEY"));
    expect(JWT.sign({}, { kty: "oct", k: "c2VjcmV0MQ" })).toBeString();
  });

  test("a critical header extension is rejected", () => {
    const token = forge({ alg: "HS256", crit: ["b64"], b64: false }, {});
    expect(() => JWT.verify(token, secret)).toThrow(code("ERR_JWT_INVALID"));
    expect(() => JWT.sign({}, secret, { header: { crit: ["exp"] } })).toThrow(code("ERR_INVALID_ARG_VALUE"));
  });

  test("a token that is not a string", () => {
    for (const token of [undefined, null, 1, {}, Buffer.from(good)]) {
      expect(() => JWT.verify(token as any, secret)).toThrow(code("ERR_INVALID_ARG_TYPE"));
      expect(() => JWT.decode(token as any)).toThrow(code("ERR_INVALID_ARG_TYPE"));
    }
  });

  test('"__proto__" in a payload is just a key', () => {
    const token = forge({ alg: "HS256" }, '{"__proto__":{"admin":true},"sub":"1"}');
    const verified = JWT.verify(token, secret) as any;
    expect(verified.admin).toBeUndefined();
    expect(Object.getPrototypeOf(verified)).toBe(Object.prototype);
    expect(({} as any).admin).toBeUndefined();
  });
});

describe("claims", () => {
  const secret = "secret";
  const at = (iso: string) => ({ currentDate: new Date(iso) });
  // 2026-01-01T00:00:00Z
  const T = 1767225600;

  test("exp", () => {
    const token = JWT.sign({ exp: T }, secret, { noTimestamp: true });
    expect(JWT.verify(token, secret, at("2025-12-31T23:59:59Z"))).toEqual({ exp: T });
    // "The current date/time MUST be before the expiration date/time"
    for (const now of ["2026-01-01T00:00:00Z", "2026-01-01T00:00:01Z", "2030-01-01T00:00:00Z"]) {
      let error: any;
      try {
        JWT.verify(token, secret, at(now));
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({ name: "JWTError", code: "ERR_JWT_EXPIRED", claim: "exp" });
      expect(error.expiredAt).toEqual(new Date(T * 1000));
    }
    expect(JWT.verify(token, secret, { ...at("2026-01-01T00:00:30Z"), clockTolerance: 31 })).toEqual({ exp: T });
    expect(() => JWT.verify(token, secret, { ...at("2026-01-01T00:00:30Z"), clockTolerance: "30s" })).toThrow(
      code("ERR_JWT_EXPIRED"),
    );
    expect(JWT.verify(token, secret, { ...at("2030-01-01T00:00:00Z"), ignoreExpiration: true })).toEqual({ exp: T });

    // The system clock is what is used by default.
    setSystemTime(new Date("2025-06-01T00:00:00Z"));
    expect(JWT.verify(token, secret)).toEqual({ exp: T });
    setSystemTime(new Date("2026-06-01T00:00:00Z"));
    expect(() => JWT.verify(token, secret)).toThrow(code("ERR_JWT_EXPIRED"));
  });

  test("nbf", () => {
    const token = JWT.sign({ nbf: T }, secret, { noTimestamp: true });
    expect(JWT.verify(token, secret, at("2026-01-01T00:00:00Z"))).toEqual({ nbf: T });
    let error: any;
    try {
      JWT.verify(token, secret, at("2025-12-31T23:59:00Z"));
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({ name: "JWTError", code: "ERR_JWT_NOT_ACTIVE", claim: "nbf" });
    expect(error.date).toEqual(new Date(T * 1000));
    expect(JWT.verify(token, secret, { ...at("2025-12-31T23:59:00Z"), clockTolerance: "1 minute" })).toEqual({
      nbf: T,
    });
    expect(JWT.verify(token, secret, { ...at("2020-01-01T00:00:00Z"), ignoreNotBefore: true })).toEqual({ nbf: T });
  });

  test("maxAge", () => {
    const token = JWT.sign({ iat: T }, secret);
    expect(JWT.verify(token, secret, { ...at("2026-01-01T01:00:00Z"), maxAge: "1h" })).toEqual({ iat: T });
    expect(() => JWT.verify(token, secret, { ...at("2026-01-01T01:00:01Z"), maxAge: "1h" })).toThrow(
      code("ERR_JWT_EXPIRED", { claim: "iat", expiredAt: new Date((T + 3600) * 1000) }),
    );
    expect(JWT.verify(token, secret, { ...at("2026-01-01T01:00:01Z"), maxAge: 3600, clockTolerance: 1 })).toEqual({
      iat: T,
    });
    expect(() => JWT.verify(token, secret, { ...at("2025-12-31T00:00:00Z"), maxAge: "1h" })).toThrow(
      code("ERR_JWT_CLAIM_VALIDATION_FAILED", { claim: "iat" }),
    );
    expect(() => JWT.verify(JWT.sign({}, secret, { noTimestamp: true }), secret, { maxAge: "1h" })).toThrow(
      code("ERR_JWT_CLAIM_VALIDATION_FAILED", { claim: "iat" }),
    );
    // An issuer whose clock is a little ahead: the tolerance applies to that side too.
    const ahead = JWT.sign({ iat: T + 5 }, secret);
    const now = { ...at("2026-01-01T00:00:00Z"), maxAge: "1h" };
    expect(JWT.verify(ahead, secret, { ...now, clockTolerance: 5 })).toEqual({ iat: T + 5 });
    expect(() => JWT.verify(ahead, secret, { ...now, clockTolerance: 4 })).toThrow(
      code("ERR_JWT_CLAIM_VALIDATION_FAILED", { claim: "iat" }),
    );
    // Without maxAge, iat is not a condition.
    expect(JWT.verify(ahead, secret, at("2026-01-01T00:00:00Z"))).toEqual({ iat: T + 5 });
  });

  test("time claims that are not numbers", () => {
    for (const claim of ["exp", "nbf", "iat"]) {
      for (const value of ["1767225600", null, true, {}, "2026-01-01T00:00:00Z"]) {
        expect(() => JWT.verify(forge({ alg: "HS256" }, { [claim]: value }), secret)).toThrow(
          code("ERR_JWT_CLAIM_VALIDATION_FAILED", { claim }),
        );
      }
    }
    // Ignoring expiry does not make a malformed claim acceptable.
    expect(() => JWT.verify(forge({ alg: "HS256" }, { exp: "never" }), secret, { ignoreExpiration: true })).toThrow(
      code("ERR_JWT_CLAIM_VALIDATION_FAILED", { claim: "exp" }),
    );
  });

  test("iss, sub, aud and jti", () => {
    const token = JWT.sign({ iss: "https://issuer.example", sub: "user_1", aud: ["web", "api"], jti: "abc" }, secret);
    const ok = (options: any) => expect(JWT.verify(token, secret, options)).toMatchObject({ sub: "user_1" });
    const fails = (options: any, claim: string) =>
      expect(() => JWT.verify(token, secret, options)).toThrow(
        code("ERR_JWT_CLAIM_VALIDATION_FAILED", { claim, name: "JWTError" }),
      );

    ok({ issuer: "https://issuer.example" });
    ok({ issuer: ["https://other.example", "https://issuer.example"] });
    fails({ issuer: "https://issuer.example/" }, "iss");
    fails({ issuer: ["a", "b"] }, "iss");

    ok({ subject: "user_1" });
    fails({ subject: "user_2" }, "sub");

    ok({ audience: "api" });
    ok({ audience: ["mobile", "web"] });
    fails({ audience: "mobile" }, "aud");
    fails({ audience: ["mobile", "desktop"] }, "aud");

    ok({ jwtId: "abc" });
    fails({ jwtId: "abd" }, "jti");

    ok({ issuer: "https://issuer.example", subject: "user_1", audience: "web", jwtId: "abc" });

    // A single audience in the token, and claims that are missing or of the wrong type.
    const single = JWT.sign({ aud: "api" }, secret);
    expect(JWT.verify(single, secret, { audience: ["web", "api"] })).toMatchObject({ aud: "api" });
    expect(() => JWT.verify(single, secret, { audience: "web" })).toThrow(code("ERR_JWT_CLAIM_VALIDATION_FAILED"));
    const bare = JWT.sign({}, secret);
    for (const [options, claim] of [
      [{ issuer: "x" }, "iss"],
      [{ subject: "x" }, "sub"],
      [{ audience: "x" }, "aud"],
      [{ jwtId: "x" }, "jti"],
    ] as const) {
      expect(() => JWT.verify(bare, secret, options)).toThrow(code("ERR_JWT_CLAIM_VALIDATION_FAILED", { claim }));
    }
    expect(() =>
      JWT.verify(forge({ alg: "HS256" }, { iss: ["x"], aud: [1, { a: 1 }] }), secret, { issuer: "x" }),
    ).toThrow(code("ERR_JWT_CLAIM_VALIDATION_FAILED", { claim: "iss" }));
    expect(() => JWT.verify(forge({ alg: "HS256" }, { aud: [1, { a: 1 }] }), secret, { audience: "1" })).toThrow(
      code("ERR_JWT_CLAIM_VALIDATION_FAILED", { claim: "aud" }),
    );
  });

  test("requiredClaims", () => {
    const token = JWT.sign({ sub: "1" }, secret, { expiresIn: "1h" });
    expect(JWT.verify(token, secret, { requiredClaims: ["exp", "sub", "iat"] })).toMatchObject({ sub: "1" });
    expect(() => JWT.verify(token, secret, { requiredClaims: ["exp", "scope"] })).toThrow(
      code("ERR_JWT_CLAIM_VALIDATION_FAILED", { claim: "scope", message: 'The "scope" claim is required' }),
    );
    expect(() => JWT.verify(token, secret, { requiredClaims: "exp" as any })).toThrow(code("ERR_INVALID_ARG_TYPE"));
    // What every object inherits is not a claim of the token.
    for (const claim of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      expect(() => JWT.verify(token, secret, { requiredClaims: [claim] })).toThrow(
        code("ERR_JWT_CLAIM_VALIDATION_FAILED", { claim }),
      );
    }
    const own = forge({ alg: "HS256" }, '{"constructor":"x","__proto__":{},"scope":null}');
    expect(JWT.verify(own, secret, { requiredClaims: ["constructor", "__proto__", "scope"] })).toBeDefined();
  });

  test("claims are only looked at once the signature is known to be good", () => {
    const expired = JWT.sign({ exp: 1 }, secret);
    expect(() => JWT.verify(expired, "wrong secret")).toThrow(code("ERR_JWT_SIGNATURE_VERIFICATION_FAILED"));
    expect(() => JWT.verify(expired, secret)).toThrow(code("ERR_JWT_EXPIRED"));
  });

  test("options are checked before the token is", () => {
    expect(() => JWT.verify("not a token", secret, { issuer: 1 as any })).toThrow(code("ERR_INVALID_ARG_TYPE"));
    expect(() => JWT.verify("not a token", secret, { maxAge: "1 eon" })).toThrow(code("ERR_INVALID_ARG_VALUE"));
    expect(() => JWT.verify("not a token", secret, {})).toThrow(code("ERR_JWT_INVALID"));
  });

  test("each option is read once", () => {
    // An options object with accessors cannot show one value to the validation and another to the use.
    function counting(target: Record<string, unknown>) {
      const reads: Record<string, number> = {};
      const proxy = new Proxy(target, {
        get(object, property, receiver) {
          reads[String(property)] = (reads[String(property)] ?? 0) + 1;
          return Reflect.get(object, property, receiver);
        },
      });
      return [proxy, reads] as const;
    }

    const [signOptions, signReads] = counting({ algorithm: "HS256", expiresIn: "1h", issuer: "i", audience: "a" });
    const token = JWT.sign({}, secret, signOptions);
    expect(signReads).toEqual({ algorithm: 1, expiresIn: 1, issuer: 1, audience: 1 });

    const [verifyOptions, verifyReads] = counting({
      algorithms: ["HS256"],
      issuer: "i",
      audience: ["a"],
      maxAge: "1h",
    });
    expect(JWT.verify(token, secret, verifyOptions)).toMatchObject({ iss: "i", aud: "a" });
    expect(verifyReads).toEqual({ algorithms: 1, issuer: 1, audience: 1, maxAge: 1 });
  });

  test("only own properties are options", () => {
    const expired = JWT.sign({ exp: 1, nbf: 1 }, secret, { noTimestamp: true });
    const early = JWT.sign({ nbf: 2 ** 40 }, secret, { noTimestamp: true });
    const pollution: Record<string, unknown> = {
      ignoreExpiration: true,
      ignoreNotBefore: true,
      algorithm: "HS512",
      noTimestamp: true,
      header: { kid: "not mine" },
      complete: true,
    };
    try {
      // What a prototype pollution bug elsewhere in the program would do.
      Object.assign(Object.prototype, pollution);
      for (const options of [undefined, {}, { algorithms: ["HS256"] }] as const) {
        expect(() => JWT.verify(expired, secret, options as any)).toThrow(code("ERR_JWT_EXPIRED"));
        expect(() => JWT.verify(early, secret, options as any)).toThrow(code("ERR_JWT_NOT_ACTIVE"));
      }
      expect(JWT.verify(JWT.sign({ a: 1 }, secret, {}), secret, {})).toEqual({ a: 1, iat: expect.any(Number) });
      expect(JWT.decode(JWT.sign({}, secret, { expiresIn: "1h" })).header).toEqual({ alg: "HS256", typ: "JWT" });
    } finally {
      for (const name of Object.keys(pollution)) delete (Object.prototype as any)[name];
    }

    // The same rule for a prototype the caller made: inherited defaults are not read.
    const defaults = Object.create({ issuer: "someone else" });
    expect(JWT.verify(JWT.sign({ iss: "me" }, secret), secret, defaults)).toMatchObject({ iss: "me" });
  });

  test("invalid verify options", () => {
    const token = JWT.sign({}, secret);
    const bad = (options: any, errorCode = "ERR_INVALID_ARG_TYPE") =>
      expect(() => JWT.verify(token, secret, options)).toThrow(code(errorCode));
    bad(null);
    bad("HS256");
    bad([]);
    bad({ issuer: 1 });
    bad({ issuer: [] });
    bad({ audience: [1] });
    bad({ subject: ["a"] });
    bad({ jwtId: 1 });
    bad({ currentDate: 1767225600 });
    bad({ currentDate: new Date(NaN) });
    bad({ complete: "yes" });
    bad({ ignoreExpiration: 1 });
    bad({ ignoreNotBefore: "no" });
    bad({ clockTolerance: -1 }, "ERR_INVALID_ARG_VALUE");
    bad({ clockTolerance: "soon" }, "ERR_INVALID_ARG_VALUE");
    bad({ maxAge: "60" }, "ERR_INVALID_ARG_VALUE");
    bad({ maxAge: Infinity }, "ERR_INVALID_ARG_VALUE");
    // Enough digits are Infinity as well.
    const forever = `${Buffer.alloc(400, "9").toString()}s`;
    bad({ maxAge: forever }, "ERR_INVALID_ARG_VALUE");
    bad({ clockTolerance: forever }, "ERR_INVALID_ARG_VALUE");
  });

  test("a name that is not an option is an error, not a check that is silently skipped", () => {
    const token = JWT.sign({ jti: "abc", aud: "web" }, secret, { algorithm: "HS512" });
    const unknown = (options: any, message: string) =>
      expect(() => JWT.verify(token, secret, options)).toThrow(code("ERR_INVALID_ARG_VALUE", { message }));
    // jsonwebtoken's spelling of jwtId, keyId and currentDate
    unknown({ jwtid: "other" }, `The property 'options.jwtid' is not an option, "jwtId" is. Received 'other'`);
    unknown(
      { clockTimestamp: 0 },
      `The property 'options.clockTimestamp' is not an option, "currentDate" is. Received 0`,
    );
    unknown(
      { algorithm: "HS256" },
      `The property 'options.algorithm' is not an option, "algorithms" is. Received 'HS256'`,
    );
    expect(() => JWT.verify(token, secret, { audiance: "api" } as any)).toThrow(
      code("ERR_INVALID_ARG_VALUE", {
        message: expect.stringContaining("is not an option. The options are: algorithms, "),
      }),
    );
    expect(() => JWT.verify(token, secret, { expiresIn: "1h" } as any)).toThrow(code("ERR_INVALID_ARG_VALUE"));
    expect(() => JWT.verify("not a token", secret, { nonce: "n" } as any)).toThrow(code("ERR_INVALID_ARG_VALUE"));

    expect(() => JWT.sign({}, secret, { keyid: "k1" } as any)).toThrow(
      code("ERR_INVALID_ARG_VALUE", {
        message: `The property 'options.keyid' is not an option, "keyId" is. Received 'k1'`,
      }),
    );
    expect(() => JWT.sign({}, secret, { jwtid: "j1" } as any)).toThrow(code("ERR_INVALID_ARG_VALUE"));
    expect(() => JWT.sign({}, secret, { algorithms: ["HS256"] } as any)).toThrow(
      code("ERR_INVALID_ARG_VALUE", { message: expect.stringContaining(`is not an option, "algorithm" is`) }),
    );
    expect(() => JWT.sign({}, secret, { maxAge: "1h" } as any)).toThrow(code("ERR_INVALID_ARG_VALUE"));

    // An option that is there and undefined is an option that is not set, and symbols are nobody's business.
    expect(JWT.verify(token, secret, { jwtId: undefined, audience: "web", [Symbol("mine")]: 1 } as any)).toMatchObject({
      jti: "abc",
    });
  });
});

describe("sign options", () => {
  const secret = "secret";
  // 2026-01-01T00:00:00Z
  const T = 1767225600;
  const payloadOf = (token: string) => JWT.decode(token).payload;

  test("iat is added unless noTimestamp is set or the payload has one", () => {
    setSystemTime(new Date(T * 1000 + 999));
    expect(payloadOf(JWT.sign({ a: 1 }, secret))).toEqual({ a: 1, iat: T });
    expect(payloadOf(JWT.sign({ a: 1 }, secret, { noTimestamp: true }))).toEqual({ a: 1 });
    expect(payloadOf(JWT.sign({ a: 1, iat: 5 }, secret))).toEqual({ a: 1, iat: 5 });
  });

  test("expiresIn and notBefore", () => {
    setSystemTime(new Date(T * 1000));
    expect(payloadOf(JWT.sign({}, secret, { expiresIn: 60 }))).toEqual({ iat: T, exp: T + 60 });
    expect(payloadOf(JWT.sign({}, secret, { expiresIn: "15m", notBefore: "5s" }))).toEqual({
      iat: T,
      exp: T + 900,
      nbf: T + 5,
    });
    // Relative to the payload's iat when there is one.
    expect(payloadOf(JWT.sign({ iat: 1000 }, secret, { expiresIn: "1h" }))).toEqual({ iat: 1000, exp: 4600 });
    expect(payloadOf(JWT.sign({}, secret, { expiresIn: "1h", noTimestamp: true }))).toEqual({ exp: T + 3600 });
    expect(payloadOf(JWT.sign({}, secret, { expiresIn: -10 }))).toEqual({ iat: T, exp: T - 10 });

    const durations: [string, number][] = [
      ["30s", 30],
      ["30 sec", 30],
      ["1 second", 1],
      ["2 seconds", 2],
      ["5m", 300],
      ["5 mins", 300],
      ["1 minute", 60],
      ["2h", 7200],
      ["2 hrs", 7200],
      ["1 hour", 3600],
      ["7d", 604800],
      ["1 day", 86400],
      ["2w", 1209600],
      ["1 week", 604800],
      ["1y", 31557600],
      ["2 years", 63115200],
      ["1.5h", 5400],
      ["  10 Minutes ", 600],
      ["+1h", 3600],
      ["-1h", -3600],
    ];
    for (const [text, seconds] of durations) {
      expect(payloadOf(JWT.sign({}, secret, { expiresIn: text, noTimestamp: true }))).toEqual({ exp: T + seconds });
    }
    // A bare number in a string is ambiguous (jsonwebtoken reads it as milliseconds), so it is refused.
    for (const text of ["60", "", "h", "1 fortnight", "1h30m", "one hour", "1e3s"]) {
      expect(() => JWT.sign({}, secret, { expiresIn: text })).toThrow(code("ERR_INVALID_ARG_VALUE"));
    }
    for (const value of [NaN, Infinity]) {
      expect(() => JWT.sign({}, secret, { expiresIn: value })).toThrow(code("ERR_INVALID_ARG_VALUE"));
    }
    // Infinity written with digits. JSON would have made it `"exp": null`.
    const forever = `${Buffer.alloc(400, "9").toString()}s`;
    expect(() => JWT.sign({}, secret, { expiresIn: forever })).toThrow(code("ERR_INVALID_ARG_VALUE"));
    expect(() => JWT.sign({}, secret, { notBefore: forever })).toThrow(code("ERR_INVALID_ARG_VALUE"));
    expect(() => JWT.sign({ iat: 1.7e308 }, secret, { expiresIn: 1.7e308 })).toThrow(code("ERR_INVALID_ARG_VALUE"));
    for (const value of [null, true, {}, new Date()]) {
      expect(() => JWT.sign({}, secret, { expiresIn: value as any })).toThrow(code("ERR_INVALID_ARG_TYPE"));
    }
  });

  test("issuer, subject, audience and jwtId", () => {
    const token = JWT.sign({ role: "admin" }, secret, {
      issuer: "https://issuer.example",
      subject: "user_1",
      audience: ["web", "api"],
      jwtId: "id-1",
      noTimestamp: true,
    });
    expect(payloadOf(token)).toEqual({
      role: "admin",
      iss: "https://issuer.example",
      sub: "user_1",
      aud: ["web", "api"],
      jti: "id-1",
    });
    expect(payloadOf(JWT.sign({}, secret, { audience: "api", noTimestamp: true }))).toEqual({ aud: "api" });
  });

  test("an option that would overwrite a claim in the payload throws", () => {
    const conflicts: [object, object][] = [
      [{ exp: 1 }, { expiresIn: "1h" }],
      [{ nbf: 1 }, { notBefore: "1h" }],
      [{ iss: "a" }, { issuer: "b" }],
      [{ sub: "a" }, { subject: "b" }],
      [{ aud: "a" }, { audience: "b" }],
      [{ jti: "a" }, { jwtId: "b" }],
    ];
    for (const [payload, options] of conflicts) {
      expect(() => JWT.sign(payload, secret, options)).toThrow(code("ERR_INVALID_ARG_VALUE"));
    }
    // What the message shows is the option as it was given, not the time that was computed from it.
    expect(() => JWT.sign({ exp: 1 }, secret, { expiresIn: "1h" })).toThrow(
      code("ERR_INVALID_ARG_VALUE", {
        message: `The property 'options.expiresIn' cannot be used when the payload already has "exp". Received '1h'`,
      }),
    );
  });

  test("keyId and header", () => {
    const headerOf = (options: any) => JWT.decode(JWT.sign({}, secret, options)).header;
    expect(headerOf({ keyId: "2026-01" })).toEqual({ alg: "HS256", typ: "JWT", kid: "2026-01" });
    expect(headerOf({ header: { typ: "at+jwt", kid: "k", cty: "x", custom: { a: 1 } } })).toEqual({
      alg: "HS256",
      typ: "at+jwt",
      kid: "k",
      cty: "x",
      custom: { a: 1 },
    });
    expect(headerOf({ header: { alg: "HS256" } })).toEqual({ alg: "HS256", typ: "JWT" });
    expect(() => headerOf({ header: { alg: "none" } })).toThrow(code("ERR_INVALID_ARG_VALUE"));
    expect(() => headerOf({ algorithm: "HS512", header: { alg: "HS256" } })).toThrow(code("ERR_INVALID_ARG_VALUE"));
    expect(() => headerOf({ header: "kid" })).toThrow(code("ERR_INVALID_ARG_TYPE"));
    expect(() => headerOf({ keyId: 1 })).toThrow(code("ERR_INVALID_ARG_TYPE"));
    // Two ways to say the same thing have to say the same thing.
    expect(headerOf({ keyId: "k", header: { kid: "k" } })).toEqual({ alg: "HS256", typ: "JWT", kid: "k" });
    expect(() => headerOf({ keyId: "k", header: { kid: "other" } })).toThrow(code("ERR_INVALID_ARG_VALUE"));
  });

  test("the payload must be an object with numeric time claims", () => {
    for (const payload of [undefined, null, "text", 1, [1], Buffer.from("{}"), new ArrayBuffer(2)]) {
      expect(() => JWT.sign(payload as any, secret)).toThrow(code("ERR_INVALID_ARG_TYPE"));
    }
    // Objects that would be signed as {} or as whatever fields they happen to have.
    class User {
      id = 7;
      passwordHash = "$argon2id$...";
      toJSON() {
        return { id: this.id };
      }
    }
    for (const payload of [
      new Map([["sub", "1"]]),
      new Set(["sub"]),
      new Date(),
      Promise.resolve({ sub: "1" }),
      new Headers({ sub: "1" }),
      new Error("sub"),
      new String("ab"),
      new User(),
      Object.create({ sub: "inherited" }),
    ]) {
      expect(() => JWT.sign(payload as any, secret)).toThrow(
        code("ERR_INVALID_ARG_VALUE", { message: expect.stringContaining("must be a plain object") }),
      );
    }
    // Plain objects, whatever made them.
    const nullPrototype = Object.assign(Object.create(null), { sub: "1" });
    const otherRealm = vm.runInNewContext(`({ sub: "1" })`);
    expect(Object.getPrototypeOf(otherRealm)).not.toBe(Object.prototype);
    for (const payload of [nullPrototype, otherRealm, JSON.parse(`{"sub":"1"}`), Object.freeze({ sub: "1" })]) {
      expect(payloadOf(JWT.sign(payload, secret, { noTimestamp: true }))).toEqual({ sub: "1" });
    }
    expect(payloadOf(JWT.sign(JWT.verify(JWT.sign({ sub: "1" }, secret), secret), secret))).toMatchObject({ sub: "1" });
    for (const claim of ["exp", "nbf", "iat"]) {
      for (const value of [new Date(), "1767225600", NaN, null]) {
        expect(() => JWT.sign({ [claim]: value }, secret)).toThrow(code("ERR_INVALID_ARG_VALUE"));
      }
    }
    expect(() => JWT.sign({ n: 1n } as any, secret)).toThrow(TypeError);
  });

  test("the payload object is not modified", () => {
    const payload = Object.freeze({ sub: "1" });
    JWT.sign(payload, secret, { expiresIn: "1h", issuer: "x" });
    expect(payload).toEqual({ sub: "1" });
  });

  test("invalid sign options", () => {
    const bad = (options: any, errorCode = "ERR_INVALID_ARG_TYPE") =>
      expect(() => JWT.sign({}, secret, options)).toThrow(code(errorCode));
    bad(null);
    bad("HS256");
    bad({ algorithm: 256 });
    bad({ algorithm: "HS-256" }, "ERR_INVALID_ARG_VALUE");
    bad({ algorithm: "hs256" }, "ERR_INVALID_ARG_VALUE");
    bad({ issuer: ["a"] });
    bad({ subject: 1 });
    bad({ audience: [] });
    bad({ audience: [1] });
    bad({ jwtId: {} });
    bad({ noTimestamp: "yes" });
    // Checked whether or not it ends up mattering.
    expect(() => JWT.sign({ iat: 5 }, secret, { noTimestamp: "yes" as any })).toThrow(code("ERR_INVALID_ARG_TYPE"));
    bad({ algorithm: null });
  });
});

describe("decode", () => {
  test("returns the parts without verifying anything", () => {
    const token = JWT.sign({ sub: "1", exp: 1 }, "secret", { keyId: "k1", noTimestamp: true });
    expect(JWT.decode(token)).toEqual({
      header: { alg: "HS256", typ: "JWT", kid: "k1" },
      payload: { sub: "1", exp: 1 },
      signature: token.split(".")[2],
    });
    // Neither the algorithm nor the signature has to make sense.
    expect(JWT.decode(`${b64u({ alg: "none" })}.${b64u({ a: 1 })}.`)).toEqual({
      header: { alg: "none" },
      payload: { a: 1 },
      signature: "",
    });
  });

  test("picking a key by kid, then verifying", () => {
    const keys = [
      { ...ec256.publicKey.export({ format: "jwk" }), kid: "old" },
      { ...ed25519.publicKey.export({ format: "jwk" }), kid: "new" },
    ];
    const token = JWT.sign({ sub: "1" }, ed25519.privateKey, { keyId: "new" });
    const { kid } = JWT.decode(token).header;
    expect(JWT.verify(token, keys.find(key => key.kid === kid)!)).toMatchObject({ sub: "1" });
    expect(() => JWT.verify(token, keys[0])).toThrow(code("ERR_JWT_ALGORITHM_NOT_ALLOWED"));
  });
});

test("Bun.JWT has sign, verify and decode", () => {
  expect(Object.keys(Bun.JWT).sort()).toEqual(["decode", "sign", "verify"]);
  expect(Bun.JWT).toBe(JWT);
  expect(JWT.sign.name).toBe("sign");
  expect(JWT.verify.name).toBe("verify");
  expect(JWT.decode.name).toBe("decode");
});
