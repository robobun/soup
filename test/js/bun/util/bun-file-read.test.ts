import { describe, expect, it } from "bun:test";
import { bunEnv, bunExe, tempDir } from "harness";
import { tmpdir } from "node:os";
import path from "node:path";

it("offset should work in Bun.file() #4963", async () => {
  const filename = tmpdir() + "/bun.test.offset.txt";
  await Bun.write(filename, "contents");
  const file = Bun.file(filename);
  const slice = file.slice(2, file.size);
  const contents = await slice.text();
  expect(contents).toBe("ntents");
});

// do_read_loop picks its read target per iteration: the 64 KB stack buffer
// when self.buffer's spare capacity is smaller, otherwise the Vec's spare
// capacity directly. Cover both branches plus the max_length cap so the
// branch selection and the commit_spare path stay tied to the same decision.
describe("Bun.file read-loop target selection", () => {
  function pattern(size: number, seed: number) {
    const out = Buffer.alloc(size);
    for (let i = 0; i < size; i++) out[i] = (i * seed + 7) & 0xff;
    return out;
  }

  it.each([
    ["small file (stack-buffer path)", 1024],
    ["64 KB boundary", 64 * 1024],
    ["large file (spare-capacity path)", 256 * 1024 + 17],
  ] as const)("%s", async (_label, size) => {
    const bytes = pattern(size, 131);
    using dir = tempDir("bun-file-read-target", {});
    const p = path.join(String(dir), "data.bin");
    await Bun.write(p, bytes);

    const buf = new Uint8Array(await Bun.file(p).arrayBuffer());
    expect(buf.length).toBe(size);
    expect(Bun.hash(buf)).toBe(Bun.hash(bytes));
  });

  it("slice(offset, end) honours max_length across the stack/spare split", async () => {
    const size = 256 * 1024;
    const bytes = pattern(size, 97);
    using dir = tempDir("bun-file-read-slice", {});
    const p = path.join(String(dir), "data.bin");
    await Bun.write(p, bytes);

    // 70_000 bytes: larger than one stack-buffer fill, smaller than the whole
    // file, and not a multiple of 64 KB.
    const start = 10;
    const end = 70_010;
    const buf = new Uint8Array(await Bun.file(p).slice(start, end).arrayBuffer());
    expect(buf.length).toBe(end - start);
    expect(Bun.hash(buf)).toBe(Bun.hash(bytes.subarray(start, end)));
  });
});

describe("Bun.file().lines()", () => {
  it("yields every line of a file larger than one read", async () => {
    // Line lengths vary so that lines straddle the read chunk boundaries.
    const lines: string[] = [];
    for (let i = 0; i < 5000; i++) lines.push(`${i} ${Buffer.alloc(i % 200, "x").toString()}`);
    using dir = tempDir("bun-file-lines", { "big.txt": lines.join("\n") + "\n" });
    const file = Bun.file(path.join(String(dir), "big.txt"));
    expect(file.size).toBeGreaterThan(256 * 1024);

    expect(await Array.fromAsync(file.lines())).toEqual(lines);
  });

  it("handles CRLF, blank lines and a missing trailing newline", async () => {
    using dir = tempDir("bun-file-lines", {
      "crlf.txt": "a\r\n\r\nb\r\n",
      "no-newline.txt": "a\nb",
      "empty.txt": "",
    });
    const read = (name: string) => Array.fromAsync(Bun.file(path.join(String(dir), name)).lines());

    expect(await read("crlf.txt")).toEqual(["a", "", "b"]);
    expect(await read("no-newline.txt")).toEqual(["a", "b"]);
    expect(await read("empty.txt")).toEqual([]);
  });

  it("respects slice()", async () => {
    using dir = tempDir("bun-file-lines", { "sliced.txt": "skip\nkeep\nrest\n" });
    const file = Bun.file(path.join(String(dir), "sliced.txt"));
    expect(await Array.fromAsync(file.slice(5, 14).lines())).toEqual(["keep", "rest"]);
  });

  it("can stop early", async () => {
    using dir = tempDir("bun-file-lines", { "stop.txt": "1\n2\n3\n4\n" });
    const seen: string[] = [];
    for await (const line of Bun.file(path.join(String(dir), "stop.txt")).lines()) {
      seen.push(line);
      if (line === "2") break;
    }
    expect(seen).toEqual(["1", "2"]);
  });

  it("throws ENOENT for a file that does not exist, where stream().values() would", async () => {
    using dir = tempDir("bun-file-lines", {});
    const file = Bun.file(path.join(String(dir), "missing.txt"));

    expect(() => file.stream().values()).toThrow(expect.objectContaining({ code: "ENOENT" }));
    expect(() => file.lines()).toThrow(expect.objectContaining({ code: "ENOENT" }));

    const caught = await (async () => {
      try {
        for await (const line of file.lines()) return line;
      } catch (error) {
        return error;
      }
    })();
    expect(caught).toMatchObject({ code: "ENOENT" });
  });

  const stdinScript = `
    const lines = [];
    for await (const line of Bun.stdin.lines()) lines.push(line);
    console.log(JSON.stringify(lines));
  `;

  it("Bun.stdin.lines() reads a pipe", async () => {
    await using proc = Bun.spawn({
      cmd: [bunExe(), "-e", stdinScript],
      env: bunEnv,
      stdin: new Blob(["one\r\ntwo\n\nthree"]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual(["one", "two", "", "three"]);
    expect(exitCode).toBe(0);
  });

  it("Bun.stdin.lines() reads a redirected file", async () => {
    using dir = tempDir("bun-file-lines", { "input.txt": "first\nsecond\n" });
    await using proc = Bun.spawn({
      cmd: [bunExe(), "-e", stdinScript],
      env: bunEnv,
      stdin: Bun.file(path.join(String(dir), "input.txt")),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual(["first", "second"]);
    expect(exitCode).toBe(0);
  });
});
