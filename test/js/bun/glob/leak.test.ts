import { describe, expect, test } from "bun:test";
import { bunEnv, bunExe, expectRssDeltaBelow, isASAN, tempDir } from "harness";

// ASAN's quarantine retains freed allocations (default 256 MB) so RSS deltas
// run far higher under bun-asan; widen the threshold there.
const thresholdMB = isASAN ? 400 : 100;
const timeout = 60_000;

async function run(dir: string, code: string) {
  await using proc = Bun.spawn({
    cmd: [bunExe(), "--smol", "-e", code],
    cwd: dir,
    env: bunEnv,
    stdio: ["inherit", "inherit", "inherit"],
  });
  expect(await proc.exited).toBe(0);
}

describe("leaks", () => {
  test.concurrent(
    "scanSync",
    async () => {
      using dir = tempDir("glob-leak-scansync", { "a.txt": "", "b.txt": "", "sub/c.txt": "" });
      await run(
        String(dir),
        /* ts */ `
        const rss = process.memoryUsage.rss;
        const glob = new Bun.Glob("**/*");
        for (let i = 0; i < 1000; i++) Array.from(glob.scanSync());
        Bun.gc(true);
        const before = rss();
        for (let i = 0; i < 100000; i++) Array.from(glob.scanSync());
        Bun.gc(true);
        const growthMB = (rss() - before) / 1024 / 1024;
        if (growthMB > ${thresholdMB}) throw new Error("leaked " + growthMB.toFixed(2) + "MB");
      `,
      );
    },
    timeout,
  );

  test.concurrent(
    "scan",
    async () => {
      using dir = tempDir("glob-leak-scan", { "a.txt": "", "b.txt": "", "sub/c.txt": "" });
      await run(
        String(dir),
        /* ts */ `
        const rss = process.memoryUsage.rss;
        const glob = new Bun.Glob("**/*");
        for (let i = 0; i < 1000; i++) await Array.fromAsync(glob.scan());
        Bun.gc(true);
        const before = rss();
        for (let i = 0; i < 100000; i++) await Array.fromAsync(glob.scan());
        Bun.gc(true);
        const growthMB = (rss() - before) / 1024 / 1024;
        if (growthMB > ${thresholdMB}) throw new Error("leaked " + growthMB.toFixed(2) + "MB");
      `,
      );
    },
    timeout,
  );

  test.concurrent(
    "scanSync does not leak GlobWalker struct",
    async () => {
      using dir = tempDir("glob-struct-leak-sync", { "a.txt": "" });
      await run(
        String(dir),
        /* ts */ `
        const rss = process.memoryUsage.rss;
        const glob = new Bun.Glob("*.txt");
        for (let i = 0; i < 1000; i++) Array.from(glob.scanSync());
        Bun.gc(true);
        const before = rss();
        for (let i = 0; i < 100000; i++) Array.from(glob.scanSync());
        Bun.gc(true);
        const growthMB = (rss() - before) / 1024 / 1024;
        if (growthMB > ${thresholdMB}) throw new Error("leaked " + growthMB.toFixed(2) + "MB");
      `,
      );
    },
    timeout,
  );

  test.concurrent(
    "scan does not leak GlobWalker struct",
    async () => {
      using dir = tempDir("glob-struct-leak-async", { "a.txt": "" });
      await run(
        String(dir),
        /* ts */ `
        const rss = process.memoryUsage.rss;
        const glob = new Bun.Glob("*.txt");
        for (let i = 0; i < 1000; i++) await Array.fromAsync(glob.scan());
        Bun.gc(true);
        const before = rss();
        for (let i = 0; i < 100000; i++) await Array.fromAsync(glob.scan());
        Bun.gc(true);
        const growthMB = (rss() - before) / 1024 / 1024;
        if (growthMB > ${thresholdMB}) throw new Error("leaked " + growthMB.toFixed(2) + "MB");
      `,
      );
    },
    timeout,
  );
  // `a.txt` is found by two of the patterns, `./sub/*` is an entry that is stored without its `./`, and `!sub/d*` is
  // what every walker asks about every path.
  const list = `new Bun.Glob(["**/*.txt", "a.*", "./sub/*", "!sub/d*"])`;
  const growth = (dir: string, scan: string, iterations: number) => /* ts */ `
    const rss = process.memoryUsage.rss;
    const glob = ${list};
    const cwd = ${JSON.stringify(dir)};
    for (let i = 0; i < 1000; i++) ${scan};
    Bun.gc(true);
    const before = rss();
    for (let i = 0; i < ${iterations}; i++) ${scan};
    Bun.gc(true);
    console.log(JSON.stringify({ deltaMiB: (rss() - before) / 1024 / 1024 }));
  `;

  test.concurrent(
    "scanSync of a list of patterns",
    async () => {
      using dir = tempDir("glob-leak-list-scansync", { "a.txt": "", "b.txt": "", "sub/c.txt": "" });
      const code = growth(String(dir), "Array.from(glob.scanSync({ cwd }))", 100_000);
      await expectRssDeltaBelow(["--smol", "-e", code], { release: 40, debug: 60 });
    },
    timeout,
  );

  test.concurrent(
    "scan of a list of patterns",
    async () => {
      using dir = tempDir("glob-leak-list-scan", { "a.txt": "", "b.txt": "", "sub/c.txt": "" });
      const code = growth(String(dir), "await Array.fromAsync(glob.scan({ cwd }))", 30_000);
      await expectRssDeltaBelow(["--smol", "-e", code], { release: 40, debug: 60 });
    },
    timeout,
  );

  // The collector is told what a list holds when it is made. Without that, it sees 80 bytes for each of these and
  // lets them pile up: 300 patterns are about 30 KB. Lists that are held for a while die old, and only a full
  // collection takes them.
  for (const [name, held, flags] of [
    ["that nothing holds", 0, ["--smol"]],
    ["that are held for a while", 50, ["--smol"]],
    ["that are held for a while, with the default heap", 50, []],
  ] as const) {
    test.concurrent(
      `lists of patterns ${name}`,
      async () => {
        const code = /* ts */ `
          const patterns = Array.from({ length: 300 }, (_, i) => (i % 5 ? "" : "!") + "packages/pkg-" + i + "/src/**/*.{ts,tsx}");
          const rss = process.memoryUsage.rss;
          const ring = [];
          Bun.gc(true);
          const before = rss();
          let peak = before;
          for (let i = 0; i < 8_000; i++) {
            const glob = new Bun.Glob(patterns);
            if (${held}) ring[i % ${held}] = glob;
            if (i % 256 === 0) peak = Math.max(peak, rss());
          }
          console.log(JSON.stringify({ deltaMiB: (peak - before) / 1024 / 1024 }));
        `;
        await expectRssDeltaBelow([...flags, "-e", code], { release: 80, debug: 100 });
      },
      timeout,
    );
  }
});
