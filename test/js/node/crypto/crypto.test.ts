import { CryptoHasher, MD4, MD5, SHA1, SHA224, SHA256, SHA384, SHA512, SHA512_256, gc } from "bun";
import { describe, expect, it } from "bun:test";
import crypto from "crypto";
import { readFileSync } from "fs";
import { bunEnv, bunExe, isWindows, tmpdirSync } from "harness";
import path from "path";
import { promisify } from "util";
import { hashesFixture } from "./fixtures/sign.fixture.ts";
const HashClasses = [MD5, MD4, SHA1, SHA224, SHA256, SHA384, SHA512, SHA512_256];

describe("CryptoHasher", () => {
  it("CryptoHasher.algorithms", () => {
    expect(CryptoHasher.algorithms).toEqual([
      "blake2b256",
      "blake2b512",
      "blake2s256",
      "md4",
      "md5",
      "ripemd160",
      "sha1",
      "sha224",
      "sha256",
      "sha384",
      "sha512",
      "sha512-224",
      "sha512-256",
      "sha3-224",
      "sha3-256",
      "sha3-384",
      "sha3-512",
      "shake128",
      "shake256",
    ]);
  });

  // prettier-ignore
  const expected = {
    blake2b256: "256c83b297114d201b30179f3f0ef0cace9783622da5974326b436178aeef610",
    blake2b512: "021ced8799296ceca557832ab941a50b4a11f83478cf141f51f933f653ab9fbcc05a037cddbed06e309bf334942c4e58cdf1a46e237911ccd7fcf9787cbc7fd0",
    blake2s256: "9aec6806794561107e594b1f6a8a6b0c92a0cba9acf5e5e93cca06f781813b0b",
    md4: "aa010fbc1d14c795d86ef98c95479d17",
    md5: "5eb63bbbe01eeed093cb22bb8f5acdc3",
    ripemd160: "98c615784ccb5fe5936fbc0cbe9dfdb408d92f0f",
    sha1: "2aae6c35c94fcfb415dbe95f408b9ce91ee846ed",
    sha224: "2f05477fc24bb4faefd86517156dafdecec45b8ad3cf2522a563582b",
    sha256: "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    sha384: "fdbd8e75a67f29f701a4e040385e2e23986303ea10239211af907fcbb83578b3e417cb71ce646efd0819dd8c088de1bd",
    sha512: "309ecc489c12d6eb4cc40f50c902f2b4d0ed77ee511a7c7a9bcd3ca86d4cd86f989dd35bc5ff499670da34255b45b0cfd830e81f605dcf7dc5542e93ae9cd76f",
    "sha512-224": "22e0d52336f64a998085078b05a6e37b26f8120f43bf4db4c43a64ee",
    "sha512-256": "0ac561fac838104e3f2e4ad107b4bee3e938bf15f2b15f009ccccd61a913f017",
    "sha3-224": "dfb7f18c77e928bb56faeb2da27291bd790bc1045cde45f3210bb6c5",
    "sha3-256": "644bcc7e564373040999aac89e7622f3ca71fba1d972fd94a31c3bfbf24e3938",
    "sha3-384": "83bff28dde1b1bf5810071c6643c08e5b05bdb836effd70b403ea8ea0a634dc4997eb1053aa3593f590f9c63630dd90b",
    "sha3-512": "840006653e9ac9e95117a15c915caab81662918e925de9e004f774ff82d7079a40d4d27b1b372657c61d46d470304c88c788b3a4527ad074d1dccbee5dbaa99a",
    shake128: "3a9159f071e4dd1c8c4f968607c30942",
    shake256: "369771bb2cb9d2b04c1d54cca487e372d9f187f73f7ba3f65b95c8ee7798c527",
  } as const;

  const expectedBitLength = {
    blake2b256: 256,
    blake2b512: 512,
    blake2s256: 256,
    md4: 128,
    md5: 128,
    ripemd160: 160,
    sha1: 160,
    sha224: 224,
    sha256: 256,
    sha384: 384,
    sha512: 512,
    "sha512-224": 224,
    "sha512-256": 256,
    "sha3-224": 224,
    "sha3-256": 256,
    "sha3-384": 384,
    "sha3-512": 512,
    shake128: 128,
    shake256: 256,
  } as const;

  for (const algorithm of CryptoHasher.algorithms) {
    it(`new CryptoHasher ${algorithm}`, () => {
      var hasher = new CryptoHasher(algorithm);
      expect(hasher.algorithm).toEqual(algorithm);
      expect(hasher.byteLength).toEqual(expectedBitLength[algorithm] / 8);
      hasher.update("hello world");
      expect(hasher.digest("hex")).toEqual(expected[algorithm]);
    });

    it(`CryptoHasher.hash ${algorithm}`, () => {
      expect(CryptoHasher.hash(algorithm, "hello world").toString("hex")).toEqual(expected[algorithm]);
    });

    it(`new CryptoHasher ${algorithm} multi-part`, () => {
      var hasher = new CryptoHasher(algorithm);
      hasher.update("hello ");
      hasher.update("world");
      expect(hasher.digest("hex")).toBe(expected[algorithm]);
      expect(hasher.algorithm).toBe(algorithm);
    });

    it(`new CryptoHasher ${algorithm} to Buffer`, () => {
      var hasher = new CryptoHasher(algorithm);
      expect(hasher.algorithm).toEqual(algorithm);
      hasher.update("hello world");
      expect(hasher.digest()).toEqual(Buffer.from(expected[algorithm], "hex"));
    });
  }

  it("CryptoHasher resets when digest is called", () => {
    var hasher = new CryptoHasher("sha256");
    hasher.update("hello");
    expect(hasher.digest("hex")).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    hasher.update("world");
    expect(hasher.digest("hex")).toBe("486ea46224d1bb4fb680f34f7c9ad96a8f24ec88be73ea8e5a6c65260e9cb8a7");
  });

  for (let alg of CryptoHasher.algorithms) {
    it(`CryptoHasher ${alg} copy is the same`, () => {
      const orig = new CryptoHasher(alg);
      orig.update("hello");
      const copy = orig.copy();

      expect(copy.digest("hex")).toBe(orig.digest("hex"));
      expect(copy.algorithm).toBe(orig.algorithm);
    });

    it(`CryptoHasher ${alg} copy is not linked`, () => {
      const orig = new CryptoHasher(alg);
      orig.update("hello");
      const copy = orig.copy();

      orig.update("world");
      expect(copy.digest("hex")).not.toBe(orig.digest("hex"));
    });

    it(`CryptoHasher ${alg} copy can be used after digest()`, () => {
      const orig = new CryptoHasher(alg);
      orig.update("hello");
      orig.digest("hex");
      const copy = orig.copy();

      expect(() => copy.digest("hex")).not.toThrow();
    });

    it(`CryptoHasher ${alg} copy updates the same`, () => {
      const orig = new CryptoHasher(alg);
      orig.update("hello");
      const copy = orig.copy();

      orig.update("world");
      copy.update("world");
      expect(copy.digest("hex")).toBe(orig.digest("hex"));
    });
  }
});

describe("createHash outputLength", () => {
  it("shake128 digest matches Node.js for small and zero outputLength", () => {
    expect(crypto.createHash("shake128", { outputLength: 8 }).update("abc").digest("hex")).toBe("5881092dd818bf5c");
    expect(crypto.createHash("shake128", { outputLength: 32 }).update("abc").digest("hex")).toBe(
      "5881092dd818bf5cf8a3ddb793fbcba74097d5c526a6d35f97b83351940f2cc8",
    );
    expect(crypto.createHash("shake128", { outputLength: 0 }).update("abc").digest("hex")).toBe("");
    expect(crypto.createHash("shake128", { outputLength: 0 }).update("abc").digest()).toEqual(Buffer.alloc(0));
    expect(
      crypto.createHash("shake128", { outputLength: 8 }).update("abc").copy({ outputLength: 4 }).digest("hex"),
    ).toBe("5881092d");
  });

  it.skipIf(isWindows)("shake128 outputLength >= 2**31 does not abort the process", async () => {
    // options.outputLength is validated against the full uint32 range, so 2**31
    // must either produce a digest or throw a catchable error, never terminate
    // the process.
    const messages: string[] = [];
    const entering = Promise.withResolvers<void>();
    const done = Promise.withResolvers<void>();
    await using proc = Bun.spawn({
      cmd: [
        bunExe(),
        "-e",
        `const crypto = require("node:crypto");
         const known = "5881092dd818bf5cf8a3ddb793fbcba7";
         const h = crypto.createHash("shake128", { outputLength: 2 ** 31 }).update("abc");
         process.send("entering");
         try {
           const d = h.digest();
           if (d.length !== 2 ** 31) throw new Error("wrong length " + d.length);
           if (d.subarray(0, 16).toString("hex") !== known) throw new Error("wrong prefix");
           process.send("ok");
         } catch (e) {
           process.send("caught:" + (e.code || e.name));
         }`,
      ],
      env: bunEnv,
      stdout: "ignore",
      stderr: "ignore",
      ipc(message) {
        messages.push(String(message));
        if (message === "entering") entering.resolve();
        else done.resolve();
      },
      serialization: "json",
    });

    // The abort is a synchronous capacity check that fires instantly; past it
    // the child squeezes 2 GiB of output, which is too slow in debug to await.
    // Give it a short window after reaching the call site, then stop it.
    await Promise.race([entering.promise, proc.exited]);
    await Promise.race([done.promise, proc.exited, Bun.sleep(2000)]);
    proc.kill("SIGKILL");

    const exitCode = await proc.exited;

    expect(messages[0]).toBe("entering");
    expect(proc.signalCode).not.toBe("SIGABRT");
    if (proc.signalCode === null) {
      expect(messages[1]).toMatch(/^(ok|caught:\S+)$/);
      expect(exitCode).toBe(0);
    } else {
      expect(proc.signalCode).toBe("SIGKILL");
    }
  });
});

describe("crypto.getCurves", () => {
  it("should return an array of strings", () => {
    expect(Array.isArray(crypto.getCurves())).toBe(true);
    expect(typeof crypto.getCurves()[0]).toBe("string");
  });
});

describe("crypto", () => {
  for (let Hash of HashClasses) {
    for (let [input, label] of [
      ["hello world", '"hello world"'],
      ["hello world".repeat(20).slice(), '"hello world" x 20'],
      ["", "empty string"],
      ["a", '"a"'],
    ]) {
      describe(label, () => {
        gc(true);

        it(`${Hash.name} base64`, () => {
          gc(true);
          const result = new Hash();
          result.update(input);
          expect(typeof result.digest("base64")).toBe("string");
          gc(true);
        });

        it(`${Hash.name} hash base64`, () => {
          Hash.hash(input, "base64");
          gc(true);
        });

        it(`${Hash.name} hex`, () => {
          const result = new Hash();
          result.update(input);
          expect(typeof result.digest("hex")).toBe("string");
          gc(true);
        });

        it(`${Hash.name} hash hex`, () => {
          expect(typeof Hash.hash(input, "hex")).toBe("string");
          gc(true);
        });

        it(`${Hash.name} buffer`, () => {
          var buf = new Uint8Array(256);
          const result = new Hash();

          result.update(input);
          expect(result.digest(buf)).toBe(buf);
          expect(buf[0] != 0).toBe(true);
          gc(true);
        });

        it(`${Hash.name} buffer`, () => {
          var buf = new Uint8Array(256);

          expect(Hash.hash(input, buf) instanceof Uint8Array).toBe(true);
          gc(true);
        });

        it(`${Hash.name} hash matches the streaming digest and node:crypto`, () => {
          const nodeName = Hash.name.toLowerCase().replace("_", "-");
          const expected = crypto.createHash(nodeName).update(input).digest();

          expect(Hash.hash(input, "hex")).toBe(expected.toString("hex"));
          expect(Hash.hash(input, "base64")).toBe(new Hash().update(input).digest("base64"));

          const buf = new Uint8Array(256).fill(0xa5);
          expect(Hash.hash(input, buf)).toBe(buf);
          expect(Buffer.from(buf.subarray(0, expected.byteLength))).toEqual(expected);
          expect(buf.subarray(expected.byteLength).every(byte => byte === 0xa5)).toBe(true);
        });
      });
    }
  }
});

describe("crypto.createSign()/.verifySign()", () => {
  it.each(hashesFixture)(
    "should create and verify digital signature for %s",
    async (alg, privKey, pubKey, expectedSign) => {
      const p = await Bun.file(`${__dirname}/${privKey}`).text();
      const sign = crypto.createSign(alg).update("text").sign(p, "base64");

      expect(sign).toEqual(expectedSign);

      const verify = crypto
        .createVerify(alg)
        .update("text")
        .verify(await Bun.file(`${__dirname}/${pubKey}`).text(), sign, "base64");
      expect(verify).toBeTrue();
    },
  );
});

// Signatures that Node.js v26.3.0 (OpenSSL 3.5.6) made over `signedMessage` with the rsa_private_2048.pem and
// ec_p256_private.pem fixtures. RSA PKCS#1 v1.5 is deterministic, so `rsa` pins the DigestInfo bytes of each digest.
const signedMessage = Buffer.from("sign and verify with every digest");
const nodeSignatures = {
  "sha512-224": {
    rsa: "g4T4Mxk7ru9bo/bgl/P41ylpzho7OzBzLO2jlRKYJRCSs2d+v7QdvIXlT0YJVfCLtFCNV/VfSr4QB0symT7b6sWxbq0PrzAQBada2uTvQ+GUeptZOyyqxtnFBi6S9QHx33qlmedsocRVaL4wjR7zJQiKMiKhXQrlg4jLpgoz94PtACrg1iM3Il7UuCeiO4dRzgWtYAU7DQ+HRN0hEgf3xaP1BNKsNe11QZMxmTSgR61Ep3XTPquTqr5BL+1OLsskaqgzzNSYBm2YrEETYD9CoOaPA/7IpfxtQ0ZsYjfC6LQ1rcrr45UxTI4qnfgEuACxg3P+Hcxkjw3qazFlvUA4Cg==",
    ecDer: "MEUCIAS5YzSAmC6ppYp5lHuBKoba+MQTuInSh98103Q/8RVoAiEArU3Li6OMkIp1AYNPFxOkDARnO/Yda9u3wOwW6z8ruOI=",
    ecP1363: "phLdcbXBHypfGj+s/bLkGNaMWJKO3+2pRH4oCOFXapU3sEiteptmL5zPbxroi73GNjRpQk8lQBNtmbqc6BU10w==",
  },
  "sha512-256": {
    rsa: "D2simp/KorcmlVk1YJ6+ppSdNnD+G9AWg6tbKLkSPCSv2FGL1nXUU7FdiC44Ts8MyRgKETOB7tP96K1DrXCS38OFPA9HL14XaNTEWePFLDB/rocRbF6RDIImdK19hWrxN2AXAwA2FrIivhuQT+VNUmmE+T/XSmU53hkyI/Gk6iUzGqGiYqLarwMNre4L0Y1z/EUpFyBrdr7/xLK2DFD9n1JksEs9VI6VGySGXks9i/V9l0+URCZxTrP8obYqEUIPBqLruS8HKHSMlG+OCRJiuHXsyuUaOeZCfKOF3Wckdy+UL857uzPK++q9Ewm2KPUbnibjwsF3xUndp46527NZZQ==",
    ecDer: "MEQCIFI6tWl2PZC6IZ8IRanw3IgustEfviD9zqYwbRojlzptAiADtZciiL9EccYAfjmaoj5pKPTJYbombFkzSmRIs2NqoQ==",
    ecP1363: "aMQDPgm7TNTPrPQPWvpRf1V69U0zP1kvK00+Lc1hm1oma3R6ReQjdVVklXs/wqw6bNWdBbzR5drsKH0Dv/YaCw==",
  },
  "sha3-224": {
    rsa: "JkoZFs5wd5IU6bj4PajVdXPB7S8/juHnfdMwtm5pdvGhlJ1sUlvgqcy9KOQLmZshoHaalWJ80CJCrWWXz4/Ic7o4++SxfeT6NWYTAXufgrfLu7uxc0DE8Jq7yy48DwIZmbMzK5aThUFOc/iobrC0yTwyGBIKClXIzB1tWYmx9nlGAEJRSqVZuFLp4NvltwW3oRqT+1TO7lk30xDRows1Vk110qd5xcwFPEPWF/jibOwe6Ua8DAvG4H3BiHFIDRkC1EGt6oM5YVaFNfSL6ZsXP04/O8ED6X0zpxp4aC3FmpQDahDXDK/kK9GYt+PRSSbhNYb6+SUDTsBZy52Z2ffP6Q==",
    ecDer: "MEUCIQCU04mHxgWWljAD9KHo/IaiM6VEyKXAVYNKCzZXLs3gDAIgHAkKIHClGsFN/XrmHcPFtJlCjX6+VGAT2drYs1mBaCk=",
    ecP1363: "kRz1O8iqAtB68fw9ltFGGQmIQKWiB59/8JFEAS6zXxIIMylGUYBySoxmLlDcn754RcN5ayVaxpQTQdUdmH28tw==",
  },
  "sha3-256": {
    rsa: "Y2awi0Oj/3MD2dWw787topJc8F4FcooXiMWot/PSTbq+g9zB6sVxh7Rq8HaMFHezz3F90MpR/McaVaTWV2HwzukExf/Okz+pWWHETreFV/SvEeK48efh2CGtFwxzeWt6j1u8qTg63VYm//YLtqNt09sKA8Lhmt2mZX4Kw8tMlsCznDjkQq+P+jT09mrvFCjURoTLdjPGiETVSkp1EIR2rAyQhLOvuOAUWQ9o01wD7C9iTUDdLNpCKKS32Mvj77ksvz+f/qAX01RGh7Ht4W+3wOJdFLSK9KpCe6sNN7QM2wI1XGEwcuYJe09UvmX41wNKQ/Rsckhdotov6AeM4IkyaA==",
    ecDer: "MEQCIFec1M22SyY6cjECK6QkvGBpxC119NWaY4004uL23JgmAiBUWrutEQ5KdZqibWi8CPTlKF/ypdT78WglcAHofBYE1Q==",
    ecP1363: "/XH95Ij8eRDZSQSUzC32ECjLK+JcDioD9mFI/kxhsssFClGjczeqRVojdDaFzSgOy8aqmfbX4pAfCg4x+NaNWg==",
  },
  "sha3-384": {
    rsa: "ZS5mdHKrLT6s3gAURS1wWo0v45zR0S8AAMFbVNAKXrgzcdroJEk83YzkhxnetnJMRjAk/c6dkiWcmSxc2r2nMSt8chmrBcITWuotjqQc2LgR0HW4PzHICXm2OE42guRo5CSO9ARdmw4xekbQI78LhNZ3owMCYgVO7DoY1bVuyx7b/AwpCIFrCDV6FFj1Uz0X2vHsU5nYJF/GzcN7TRPW+xn5dJb/SLUeGNxuZzwBp0c0ZjvK3A5/kJL50ewOq2+sU4W4RORXL5b3ILGeRiobw0bUReTPA7OOPiX4TrWn9Tf7Vt4NBjyVix3/FZ81/eENYGed8KdH31w+hyUCVk2bcg==",
    ecDer: "MEQCICFJRbJugE243pwgh7/mUdA4h6q7WRL711RNTz6JpnYgAiB3CMkNZKuNiJx2fcs/3aUY0lMFyb1plDWRpUGOhKt1Og==",
    ecP1363: "lnsB9+gqbOdox6bZMY2jLhNoMKL13Qf3I5qtuxefwtBhkYB7p2qfe+1uhu94/jaa4vsaOCpWRIWcJX7JIf2C1A==",
  },
  "sha3-512": {
    rsa: "SsjYznTh9Xq6hSpgF2dZ0i8PHGGr3I+LaXhgJ0S8K98PziUK6y2CvlrbO+qVSPH3iMtFhuOG5+OKS9VxfX8y0T50dn7ArHPMbmif+i4NvXQqsNjPBWsxDQUR3uxfU1bJGDxsXbFMq2HzQEg7gr9CKbRLBUojKamtDiVoGM9o7pDBvwMSrF/ea/3+9e9UjyFxxfSgWFjYpZ8Bk6SZwcMc2yFxGX3Xs6/79TU1jp06YMaLASs/R9X7A/1TOW2o31Muby3ywDVDVZy54D+9Ly1PnxAGzg/LAnp1v340WK8V9Z0pSaY90e6fTGR06IGgVwvfS5aCNjb43o2mGfc1bXVevA==",
    ecDer: "MEYCIQCt4mwDLPTN1Rm3vlHLdoAYH6XUGkDGQvKrMjdW5belYgIhANJqhKc30U7QonWi8AEd5zAI/70Jpfw0FlvRhl4k4kPM",
    ecP1363: "aQBQgwA1fj2JxDRUoIChM4nYh9nHCfYNeANxOGVqfUjb/dRTzS0G8JI1jH9RuVyTHgpkRh/F4eNuT+DCgz3rNA==",
  },
  "ripemd160": {
    rsa: "bTtNC0XQzK8+yzrlEmx/rUjrSq8+55yp/mdJ7t6Plgz9CR6ier6D7cNfZZQDP3j6331DCUuU73XZ8BSWcYIoy7n3EelLCuK44eCelA3g6Q+Y8v6mePDveFxH4d3YL1McUQuVyWFOSmBHc4lrqiNASok9lNdOLi7jnT88HZ9LiANfDHZxlQqQ6SpdhZ2JWYV5BktNLExARe1+R4jNLH4Jng5ORr7W3gMbwF+tYRu0+7+VsKnp5hRBYHBxEMx2xHI3nWe8trZAH/dB3zvXfYIVtjvlf8iqDriVHwlaoZ1JQIqUzBRiROxD5hKko7j7Q37R9AhLf4+EZ2wHDwLm5dZajQ==",
    ecDer: "MEUCIAkMdgm6wQpTcSPjVzp6DccjqR69h8a7S6GqQGQSip/gAiEA+Ir2pyihNE9mQ9BAz6yWB5Xnt/byYhCKir7ogikfqns=",
    ecP1363: "OciCOqWZky2B8jaGgJ8yQzKHnuqYQ4I8JxM7hLGqA7zTZkKBz3+Y1rIHVyzeuhGsXp8fxTA+cTY29xSeI8uUZg==",
  },
  "md5": {
    rsa: "i0j2wsanudVUqZh96i3kQmP2uPH9lAlYxVY/1ZNrJuFlSVSh/O/wqFIjCRXQtlm2Ppio/DUYBayAHZjoR6ploMDEk77DmmwkC+jQTbTi2VW0V53aaId3KYfoE1hJFcvlgLJzRZA7aonr3vpk8wI5op/XbF+V0PlUNwT5E1gUOJX/j4P/0DvaAKcI5rgOJgOmZ6QXCCr/bno1kSfqoYhW6QJuezuKQxal/xGLnf5JlH3towJzcuhxBSpWeggeCARwl7jyUAScJFRvPFJNyeGxeDOVM3k8G4rgFoHjbEFjkYudFvsZJY0Cc6B/5cGKpRLEyBXuv5OGCHd7mzKPE8gv/A==",
    ecDer: "MEUCIQDAklOV3g4kQhqnUcRWyO2/z9no1HiygVuKK2Sjiq5GCgIgZRzIb889QazXHUECx1r8EFOMNOeJGKXG7IFRRC9ZK0A=",
    ecP1363: "rfiTtOTIOmSKHdAnajl3COc2hlJgHneuYm1HOzT4RaoAzpxNpu80u4tbcKQms0m5lV9O9vZVi00FfI/Z9wGi0Q==",
  },
  "md5-sha1": {
    rsa: "QayodJthWhDei7V6u5MkLlXsFdytIr4sBz22xozxqZKUdn4+Psgtyrv7xtxSmBiT+9EO9/SS3sKqwmldVXczzWwMbl57ZEluQHU4DA5ewNfBYYNJ1BVvVGe5dVkc7f/GG9ZcxK20WMQi0sxaTyxnNg0REuuv5tOdXx7AEWoHEADzrLC49G6wQZ6Wideiews7q1X9yRlOfd0vrBr9iyiYturtQ7zoUTDmFo1l7mXq59hCpmgLJLweEB/XcQDw3HHeJ9a+AQqk+kyd6kuOn6Rh2k5pbO7b/Zk8Ii1Lk3AV/cXw+SrVjvhemBDsMoqP85y1f2qNSFFtdfMq4h8l0YI0CQ==",
    ecDer: "MEUCIQCAzY2skBJl58AvhO1top5VgV7m01ZCcw1/OJIf18mgkwIgQ+ekt4X91dUb+XeuBiW6rQCLV2F7vkCnPVUJqvl3Et4=",
    ecP1363: "i0uWGUECyKaq+J1OqJ/JiZ7plhVkCFzEAyaeI2SIaBoLl8f51Nt0aVWrRR+8o+pxvUXlDjYaCfMZ/nfKZ/u06A==",
  },
};

describe("sign and verify with the digests beyond SHA-1 and SHA-2", () => {
  const fixture = (name: string) => readFileSync(path.join(import.meta.dir, "fixtures", name), "utf8");
  const rsaPrivate = fixture("rsa_private_2048.pem");
  const rsaPublic = fixture("rsa_public_2048.pem");
  const ecPrivate = fixture("ec_p256_private.pem");
  const ecPublic = fixture("ec_p256_public.pem");
  const p1363 = (key: string) => ({ key, dsaEncoding: "ieee-p1363" as const });
  const signAsync = promisify(crypto.sign);
  const verifyAsync = promisify(crypto.verify);

  describe.each(Object.entries(nodeSignatures))("%s", (digest, node) => {
    const nodeRsa = Buffer.from(node.rsa, "base64");
    const nodeEcDer = Buffer.from(node.ecDer, "base64");
    const nodeEcP1363 = Buffer.from(node.ecP1363, "base64");

    it("RSA PKCS#1 v1.5 signs the bytes Node signs", async () => {
      expect({
        sync: crypto.sign(digest, signedMessage, rsaPrivate).toString("base64"),
        callback: (await signAsync(digest, signedMessage, rsaPrivate)).toString("base64"),
        streaming: crypto.createSign(digest).update(signedMessage).sign(rsaPrivate, "base64"),
      }).toEqual({ sync: node.rsa, callback: node.rsa, streaming: node.rsa });
    });

    it("verifies Node's RSA signature", async () => {
      expect({
        sync: crypto.verify(digest, signedMessage, rsaPublic, nodeRsa),
        callback: await verifyAsync(digest, signedMessage, rsaPublic, nodeRsa),
        streaming: crypto.createVerify(digest).update(signedMessage).verify(rsaPublic, nodeRsa),
      }).toEqual({ sync: true, callback: true, streaming: true });
    });

    it("verifies Node's ECDSA signatures, DER and ieee-p1363", async () => {
      expect({
        sync: crypto.verify(digest, signedMessage, ecPublic, nodeEcDer),
        callback: await verifyAsync(digest, signedMessage, ecPublic, nodeEcDer),
        streaming: crypto.createVerify(digest).update(signedMessage).verify(ecPublic, nodeEcDer),
        syncP1363: crypto.verify(digest, signedMessage, p1363(ecPublic), nodeEcP1363),
        streamingP1363: crypto.createVerify(digest).update(signedMessage).verify(p1363(ecPublic), nodeEcP1363),
      }).toEqual({ sync: true, callback: true, streaming: true, syncP1363: true, streamingP1363: true });
    });

    it("ECDSA signatures made here verify", async () => {
      const sync = crypto.sign(digest, signedMessage, ecPrivate);
      const callback = await signAsync(digest, signedMessage, ecPrivate);
      const streaming = crypto.createSign(digest).update(signedMessage).sign(ecPrivate);
      const syncP1363 = crypto.sign(digest, signedMessage, p1363(ecPrivate));
      expect({
        sync: crypto.verify(digest, signedMessage, ecPublic, sync),
        callback: crypto.verify(digest, signedMessage, ecPublic, callback),
        streaming: crypto.verify(digest, signedMessage, ecPublic, streaming),
        syncP1363: crypto.verify(digest, signedMessage, p1363(ecPublic), syncP1363),
        p1363Length: syncP1363.length,
      }).toEqual({ sync: true, callback: true, streaming: true, syncP1363: true, p1363Length: 64 });
    });

    it("a tampered or junk signature answers false", async () => {
      const tamper = (signature: Buffer) => {
        const copy = Buffer.from(signature);
        copy[copy.length - 1] ^= 1;
        return copy;
      };
      const junk = Buffer.alloc(8, 0x5a);
      expect({
        rsaTampered: crypto.verify(digest, signedMessage, rsaPublic, tamper(nodeRsa)),
        rsaJunk: crypto.verify(digest, signedMessage, rsaPublic, junk),
        rsaOtherMessage: crypto.verify(digest, Buffer.from("other"), rsaPublic, nodeRsa),
        rsaStreamingTampered: crypto.createVerify(digest).update(signedMessage).verify(rsaPublic, tamper(nodeRsa)),
        ecTampered: crypto.verify(digest, signedMessage, ecPublic, tamper(nodeEcDer)),
        ecJunk: crypto.verify(digest, signedMessage, ecPublic, junk),
        ecCallbackJunk: await verifyAsync(digest, signedMessage, ecPublic, junk),
        ecStreamingJunk: crypto.createVerify(digest).update(signedMessage).verify(ecPublic, junk),
        ecP1363Tampered: crypto.verify(digest, signedMessage, p1363(ecPublic), tamper(nodeEcP1363)),
      }).toEqual({
        rsaTampered: false,
        rsaJunk: false,
        rsaOtherMessage: false,
        rsaStreamingTampered: false,
        ecTampered: false,
        ecJunk: false,
        ecCallbackJunk: false,
        ecStreamingJunk: false,
        ecP1363Tampered: false,
      });
    });
  });

  it("every digest getHashes() lists signs and verifies with RSA and EC keys, except md4", () => {
    const roundTrip = (digest: string, privateKey: string, publicKey: string) => {
      try {
        return crypto.verify(digest, signedMessage, publicKey, crypto.sign(digest, signedMessage, privateKey));
      } catch {
        return "refused";
      }
    };
    const listed = crypto.getHashes();
    const results = Object.fromEntries(
      listed.map(digest => [
        digest,
        { rsa: roundTrip(digest, rsaPrivate, rsaPublic), ec: roundTrip(digest, ecPrivate, ecPublic) },
      ]),
    );
    // Node refuses MD4 for signatures, and BoringSSL has no entry for it on purpose.
    const expected = Object.fromEntries(
      listed.map(digest => [digest, digest === "md4" ? { rsa: "refused", ec: "refused" } : { rsa: true, ec: true }]),
    );
    expect(results).toEqual(expected);
  });
});

it("should send cipher events in the right order", async () => {
  const package_dir = tmpdirSync();
  const fixture_path = path.join(package_dir, "fixture.js");

  await Bun.write(
    fixture_path,
    String.raw`
    function patchEmitter(emitter, prefix) {
      var oldEmit = emitter.emit;

      emitter.emit = function () {
        console.log([prefix, arguments[0]]);
        oldEmit.apply(emitter, arguments);
      };
    }

    const crypto = require("node:crypto");

    const plaintext = "Out of the mountain of despair, a stone of hope.";

    const key = Buffer.from("3fad401bb178066f201b55368712530229d6329a5e2c05f48ff36ca65792d21d", "hex");
    const iv = Buffer.from("22371787d3e04a6589d8a1de50c81208", "hex");

    // Since Node 26, read() with no size returns one buffered chunk at a time,
    // so drain the stream instead of assuming a single read returns everything.
    function readAll(stream) {
      const chunks = [];
      for (let chunk; (chunk = stream.read()) !== null; ) chunks.push(chunk);
      return Buffer.concat(chunks);
    }

    const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
    patchEmitter(cipher, "cipher");
    cipher.end(plaintext);
    let ciph = readAll(cipher);
    console.log([1, ciph.toString("hex")]);

    const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
    patchEmitter(decipher, "decipher");
    decipher.end(ciph);
    let dciph = readAll(decipher);
    console.log([2, dciph.toString("hex")]);
    let txt = dciph.toString("utf8");

    console.log([3, plaintext]);
    console.log([4, txt]);
    `,
  );

  const { stdout, stderr } = Bun.spawn({
    cmd: [bunExe(), "run", fixture_path],
    stdout: "pipe",
    stdin: "ignore",
    stderr: "pipe",
    env: bunEnv,
  });
  const err = await stderr.text();
  expect(err).toBeEmpty();
  const out = await stdout.text();
  // Matches Node 26 output for the same fixture (verified byte-for-byte
  // modulo quote style).
  expect(out.split("\n")).toEqual([
    `[ "cipher", "readable" ]`,
    `[ "cipher", "prefinish" ]`,
    `[ "cipher", "data" ]`,
    `[ "cipher", "data" ]`,
    `[ 1, "dfb6b7e029be3ad6b090349ed75931f28f991b52ca9a89f5bf6f82fa1c87aa2d624bd77701dcddfcceaf3add7d66ce06ced17aebca4cb35feffc4b8b9008b3c4" ]`,
    `[ "decipher", "readable" ]`,
    `[ "decipher", "prefinish" ]`,
    `[ "decipher", "data" ]`,
    `[ 2, "4f7574206f6620746865206d6f756e7461696e206f6620646573706169722c20612073746f6e65206f6620686f70652e" ]`,
    `[ 3, "Out of the mountain of despair, a stone of hope." ]`,
    `[ 4, "Out of the mountain of despair, a stone of hope." ]`,
    `[ "cipher", "finish" ]`,
    `[ "cipher", "end" ]`,
    `[ "decipher", "finish" ]`,
    `[ "decipher", "end" ]`,
    `[ "cipher", "close" ]`,
    `[ "decipher", "close" ]`,
    ``,
  ]);
});
