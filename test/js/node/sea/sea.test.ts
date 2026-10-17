import { describe, expect, test } from "bun:test";
import { bunEnv, bunExe, isWindows, tempDir } from "harness";
import { builtinModules, isBuiltin } from "node:module";
import { join } from "node:path";
import * as namespace from "node:sea";
import sea from "node:sea";

const notInSea = expect.objectContaining({
  name: "Error",
  code: "ERR_NOT_IN_SINGLE_EXECUTABLE_APPLICATION",
  message: "Operation cannot be invoked when not in a single-executable application",
});

describe("node:sea", () => {
  test("is a builtin module under the node: prefix only", () => {
    expect(builtinModules).toContain("node:sea");
    expect(isBuiltin("node:sea")).toBe(true);
    expect(isBuiltin("sea")).toBe(false);
    expect(process.getBuiltinModule("node:sea")).toBe(sea);
    expect(process.getBuiltinModule("sea")).toBeUndefined();
    expect(require("node:sea")).toBe(sea);
    expect(Object.keys(namespace).sort()).toEqual([
      "default",
      "getAsset",
      "getAssetAsBlob",
      "getAssetKeys",
      "getRawAsset",
      "isSea",
    ]);
  });

  test("under `bun run`, isSea() is false and the assets throw", () => {
    expect(sea.isSea()).toBe(false);
    expect(() => sea.getAsset("hello.txt")).toThrow(notInSea);
    expect(() => sea.getAsset("hello.txt", "utf8")).toThrow(notInSea);
    expect(() => sea.getRawAsset("hello.txt")).toThrow(notInSea);
    expect(() => sea.getAssetAsBlob("hello.txt")).toThrow(notInSea);
    expect(() => sea.getAssetKeys()).toThrow(notInSea);
  });

  test("the key and the encoding are checked first", () => {
    const invalid = (name: string) =>
      expect.objectContaining({
        code: "ERR_INVALID_ARG_TYPE",
        message: expect.stringContaining(`The "${name}" argument must be of type string`),
      });
    // @ts-expect-error
    expect(() => sea.getAsset()).toThrow(invalid("key"));
    // @ts-expect-error
    expect(() => sea.getAsset(1)).toThrow(invalid("key"));
    // @ts-expect-error
    expect(() => sea.getRawAsset(null)).toThrow(invalid("key"));
    // @ts-expect-error
    expect(() => sea.getAssetAsBlob({})).toThrow(invalid("key"));
    // @ts-expect-error
    expect(() => sea.getAsset("hello.txt", 1)).toThrow(invalid("encoding"));
  });

  // `bun build --compile` copies the whole bun binary, about 1 GB under debug + ASAN.
  test("in an executable of `bun build --compile`, the assets are its embedded files", async () => {
    using dir = tempDir("node-sea", {
      "index.ts": /* ts */ `
        import { existsSync } from "node:fs";
        import { basename } from "node:path";
        import sea from "node:sea";
        import logo from "./logo.svg" with { type: "file" };

        function thrown(fn: () => unknown) {
          try {
            fn();
          } catch (e: any) {
            return [e.name, e.code, e.message];
          }
        }

        // Each of these is written to, and the next one is read.
        new Uint8Array(sea.getAsset("assets/data.bin")).fill(42);
        new Uint8Array(sea.getRawAsset("assets/data.bin")).fill(42);
        const blob = sea.getAssetAsBlob("hello.txt");
        const typed = sea.getAssetAsBlob("hello.txt", { type: "Application/X-Greeting" });
        const empty = sea.getAssetAsBlob("assets/empty.txt", { type: "text/x-empty" });

        console.log(
          JSON.stringify({
            isSea: sea.isSea(),
            keys: sea.getAssetKeys(),
            embeddedFiles: Bun.embeddedFiles.map(file => file.name),
            logo: sea.getAsset(basename(logo), "utf8"),
            text: sea.getAsset("hello.txt", "utf8"),
            latin1: sea.getAsset("assets/data.bin", "latin1"),
            isArrayBuffer: [
              sea.getAsset("hello.txt") instanceof ArrayBuffer,
              sea.getRawAsset("hello.txt") instanceof ArrayBuffer,
            ],
            bytes: [...new Uint8Array(sea.getAsset("assets/data.bin"))],
            rawBytes: [...new Uint8Array(sea.getRawAsset("assets/data.bin"))],
            blob: [blob instanceof Blob, blob.type, blob.size, await blob.text()],
            typed: [typed.type, typed.size, await typed.text()],
            empty: [sea.getAsset("assets/empty.txt").byteLength, sea.getAsset("assets/empty.txt", "utf8"), empty.type, empty.size],
            missing: thrown(() => sea.getAsset("missing.txt")),
            missingRaw: thrown(() => sea.getRawAsset("missing.txt")),
            missingBlob: thrown(() => sea.getAssetAsBlob("missing.txt")),
            // The code of the application is embedded too, and is not an asset.
            source: [existsSync(Bun.main), thrown(() => sea.getAsset(basename(Bun.main)))?.[1]],
            encoding: thrown(() => sea.getAsset("hello.txt", "no-such-encoding"))?.slice(0, 2),
            key: thrown(() => sea.getAsset(1 as any))?.slice(0, 2),
          }),
        );
      `,
      "hello.txt": "Hello, 世界\n",
      "logo.svg": "<svg></svg>\n",
      "assets": { "data.bin": Buffer.from([0, 255, 1, 254]), "empty.txt": "" },
    });

    {
      await using proc = Bun.spawn({
        cmd: [
          bunExe(),
          "build",
          "--compile",
          "./index.ts",
          "--asset",
          "./hello.txt",
          "--asset",
          "./assets",
          "--outfile",
          "app",
        ],
        cwd: String(dir),
        env: bunEnv,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      expect({ stdout, stderr, exitCode }).toEqual({
        stdout: expect.any(String),
        stderr: expect.any(String),
        exitCode: 0,
      });
    }

    await using proc = Bun.spawn({
      cmd: [join(String(dir), isWindows ? "app.exe" : "app")],
      cwd: String(dir),
      env: bunEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect(stderr).toBe("");

    const notFound = (key: string) => [
      "Error",
      "ERR_SINGLE_EXECUTABLE_APPLICATION_ASSET_NOT_FOUND",
      `Cannot find asset ${key} for the single executable application`,
    ];
    const keys = ["assets/data.bin", "assets/empty.txt", "hello.txt", expect.stringMatching(/^logo-[a-z0-9]+\.svg$/)];
    expect(JSON.parse(stdout)).toEqual({
      isSea: true,
      keys,
      embeddedFiles: keys,
      logo: "<svg></svg>\n",
      text: "Hello, 世界\n",
      latin1: "\0ÿ\x01þ",
      isArrayBuffer: [true, true],
      bytes: [0, 255, 1, 254],
      rawBytes: [0, 255, 1, 254],
      blob: [true, "text/plain;charset=utf-8", 14, "Hello, 世界\n"],
      typed: ["application/x-greeting", 14, "Hello, 世界\n"],
      empty: [0, "", "text/x-empty", 0],
      missing: notFound("missing.txt"),
      missingRaw: notFound("missing.txt"),
      missingBlob: notFound("missing.txt"),
      source: [true, "ERR_SINGLE_EXECUTABLE_APPLICATION_ASSET_NOT_FOUND"],
      encoding: ["RangeError", "ERR_ENCODING_NOT_SUPPORTED"],
      key: ["TypeError", "ERR_INVALID_ARG_TYPE"],
    });
    expect(exitCode).toBe(0);
  }, 60_000);
});
