// Portions of this file are derived from works under the MIT License:
//
// Copyright (c) Denis Malinochkin
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

import { Glob, GlobScanOptions } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import fg from "fast-glob";
import { bunEnv, bunExe, isLinux, isRoot, isWindows, tempDir, tempDirWithFiles, tmpdirSync } from "harness";
import * as fs from "node:fs";
import * as path from "path";
import { createTempDirectoryWithBrokenSymlinks, prepareEntries, tempFixturesDir } from "./util";

let origAggressiveGC = Bun.unsafe.gcAggressionLevel();
let tempBrokenSymlinksDir: string;
beforeAll(() => {
  process.chdir(path.join(import.meta.dir, "../../../"));
  tempFixturesDir();
  tempBrokenSymlinksDir = createTempDirectoryWithBrokenSymlinks();
  Bun.unsafe.gcAggressionLevel(0);
});

afterAll(() => {
  Bun.unsafe.gcAggressionLevel(origAggressiveGC);
});

const followSymlinks = true;

const bunGlobOpts = {
  followSymlinks: followSymlinks,
  onlyFiles: false,
  // absolute: true,
} satisfies GlobScanOptions;

type FgOpts = NonNullable<Parameters<typeof fg.glob>[1]>;
const fgOpts = {
  followSymbolicLinks: followSymlinks,
  onlyFiles: false,
  // absolute: true,
} satisfies FgOpts;

describe("glob.match", async () => {
  const timeout = 30 * 1000;
  function testWithOpts(namePrefix: string, bunGlobOpts: GlobScanOptions, fgOpts: FgOpts) {
    test(
      `${namePrefix} recursively search node_modules`,
      async () => {
        const pattern = "**/node_modules/**/*.js";
        const glob = new Glob(pattern);
        const [filepaths, fgFilepths] = await Promise.all([
          Array.fromAsync(glob.scan(bunGlobOpts)).then(prepareEntries),
          fg.glob(pattern, fgOpts),
        ]);

        // console.error(filepaths);
        expect(filepaths.length).toEqual(fgFilepths.length);

        const bunfilepaths = new Set(filepaths);
        for (const filepath of fgFilepths) {
          if (!bunfilepaths.has(filepath)) console.error("Missing:", filepath);
          expect(bunfilepaths.has(filepath)).toBeTrue();
        }
      },
      timeout,
    );

    test(
      `${namePrefix} recursive search js files`,
      async () => {
        const pattern = "**/*.js";
        const glob = new Glob(pattern);
        const [filepaths, fgFilepths] = await Promise.all([
          Array.fromAsync(glob.scan(bunGlobOpts)).then(prepareEntries),
          fg.glob(pattern, fgOpts),
        ]);

        expect(filepaths.length).toEqual(fgFilepths.length);

        const bunfilepaths = new Set(filepaths);
        for (const filepath of fgFilepths) {
          if (!bunfilepaths.has(filepath)) console.error("Missing:", filepath);
          expect(bunfilepaths.has(filepath)).toBeTrue();
        }
      },
      timeout,
    );

    test(
      `${namePrefix} recursive search ts files`,
      async () => {
        const pattern = "**/*.ts";
        const glob = new Glob(pattern);
        const [filepaths, fgFilepths] = await Promise.all([
          Array.fromAsync(glob.scan(bunGlobOpts)).then(prepareEntries),
          fg.glob(pattern, fgOpts),
        ]);

        expect(filepaths.length).toEqual(fgFilepths.length);

        const bunfilepaths = new Set(filepaths);
        for (const filepath of fgFilepths) {
          if (!bunfilepaths.has(filepath)) console.error("Missing:", filepath);
          expect(bunfilepaths.has(filepath)).toBeTrue();
        }
      },
      timeout,
    );

    test(
      `${namePrefix} glob not freed before matching done`,
      async () => {
        const promise = (async () => {
          const glob = new Glob("**/node_modules/**/*.js");
          const result = Array.fromAsync(glob.scan(bunGlobOpts));
          Bun.gc(true);
          const result2 = await result;
          return result2;
        })();
        Bun.gc(true);
        const values = await promise;
        Bun.gc(true);
      },
      timeout,
    );
  }

  testWithOpts("non-absolute", bunGlobOpts, fgOpts);
  testWithOpts("absolute", { ...bunGlobOpts, absolute: true }, { ...fgOpts, absolute: true });

  test("invalid surrogate pairs", async () => {
    const pattern = `**/*.{md,\uD83D\uD800}`;
    const cwd = import.meta.dir;

    const glob = new Glob(pattern);
    const entries = prepareEntries(await Array.fromAsync(glob.scan({ cwd })));

    expect(entries.sort()).toEqual(
      [
        "fixtures/file.md",
        "fixtures/second/file.md",
        "fixtures/second/nested/file.md",
        "fixtures/second/nested/directory/file.md",
        "fixtures/third/library/b/book.md",
        "fixtures/third/library/a/book.md",
        "fixtures/first/file.md",
        "fixtures/first/nested/file.md",
        "fixtures/first/nested/directory/file.md",
      ].sort(),
    );
  });

  test("bad options", async () => {
    const glob = new Glob("lmaowtf");
    expect(returnError(() => glob.scan())).toBeUndefined();
    // @ts-expect-error
    expect(returnError(() => glob.scan(123456))).toBeDefined();
    expect(returnError(() => glob.scan({}))).toBeUndefined();
    expect(returnError(() => glob.scan({ cwd: "" }))).toBeUndefined();
    // @ts-expect-error
    expect(returnError(() => glob.scan({ cwd: true }))).toBeDefined();
    // @ts-expect-error
    expect(returnError(() => glob.scan({ cwd: 123123 }))).toBeDefined();

    function returnError(cb: () => any): Error | undefined {
      try {
        cb();
      } catch (err) {
        // @ts-expect-error
        return err;
      }
      return undefined;
    }
  });

  test("oversized cwd throws instead of crashing", async () => {
    const glob = new Glob("*.ts");
    const tooLong = Buffer.alloc(100_000, "x").toString();
    // relative cwd
    expect(returnError(() => [...glob.scanSync({ cwd: tooLong })])).toBeDefined();
    expect(returnError(() => glob.scan({ cwd: tooLong }))).toBeDefined();
    // relative cwd that would be resolved against process.cwd()
    expect(returnError(() => [...glob.scanSync({ cwd: tooLong, absolute: true })])).toBeDefined();
    // absolute cwd
    expect(returnError(() => [...glob.scanSync({ cwd: "/" + tooLong })])).toBeDefined();
    expect(returnError(() => glob.scan({ cwd: "/" + tooLong }))).toBeDefined();

    function returnError(cb: () => any): Error | undefined {
      try {
        cb();
      } catch (err) {
        // @ts-expect-error
        return err;
      }
      return undefined;
    }
  });
});

// From fast-glob regular.e2e.tes
const regular = {
  regular: [
    "fixtures/*",
    "fixtures/**",
    "fixtures/**/*",

    "fixtures/*/nested",
    "fixtures/*/nested/*",
    "fixtures/*/nested/**",
    "fixtures/*/nested/**/*",
    "fixtures/**/nested/*",
    "fixtures/**/nested/**",
    "fixtures/**/nested/**/*",

    "fixtures/{first,second}",
    "fixtures/{first,second}/*",
    "fixtures/{first,second}/**",
    "fixtures/{first,second}/**/*",

    // The @(pattern) syntax not supported so we don't include that here
    // "@(fixtures)/{first,second}",
    // "@(fixtures)/{first,second}/*",

    "fixtures/*/{first,second}/*",
    "fixtures/*/{first,second}/*/{nested,file.md}",
    "fixtures/**/{first,second}/**",
    "fixtures/**/{first,second}/{nested,file.md}",
    "fixtures/**/{first,second}/**/{nested,file.md}",

    "fixtures/{first,second}/{nested,file.md}",
    "fixtures/{first,second}/*/nested/*",
    "fixtures/{first,second}/**/nested/**",

    "fixtures/*/{nested,file.md}/*",
    "fixtures/**/{nested,file.md}/*",

    "./fixtures/*",
    "../.",
  ],
  cwd: [
    { pattern: "*", cwd: "fixtures" },
    { pattern: "**", cwd: "fixtures" },
    { pattern: "**/*", cwd: "fixtures" },
    { pattern: "*/nested", cwd: "fixtures" },
    { pattern: "*/nested/*", cwd: "fixtures" },
    { pattern: "*/nested/**", cwd: "fixtures" },
    { pattern: "*/nested/**/*", cwd: "fixtures" },
    { pattern: "**/nested/*", cwd: "fixtures" },
    { pattern: "**/nested/**", cwd: "fixtures" },
    { pattern: "**/nested/**/*", cwd: "fixtures" },
    { pattern: "{first,second}", cwd: "fixtures" },
    { pattern: "{first,second}/*", cwd: "fixtures" },
    { pattern: "{first,second}/**", cwd: "fixtures" },
    { pattern: "{first,second}/**/*", cwd: "fixtures" },
    { pattern: "*/{first,second}/*", cwd: "fixtures" },
    { pattern: "*/{first,second}/*/{nested,file.md}", cwd: "fixtures" },
    { pattern: "**/{first,second}/**", cwd: "fixtures" },
    { pattern: "**/{first,second}/{nested,file.md}", cwd: "fixtures" },
    { pattern: "**/{first,second}/**/{nested,file.md}", cwd: "fixtures" },
    { pattern: "{first,second}/{nested,file.md}", cwd: "fixtures" },
    { pattern: "{first,second}/*/nested/*", cwd: "fixtures" },
    { pattern: "{first,second}/**/nested/**", cwd: "fixtures" },
    { pattern: "*/{nested,file.md}/*", cwd: "fixtures" },
    { pattern: "**/{nested,file.md}/*", cwd: "fixtures" },
  ],
  relativeCwd: [
    { pattern: "./*" },
    { pattern: "./*", cwd: "fixtures" },
    { pattern: "./**", cwd: "fixtures" },
    { pattern: "./**/*", cwd: "fixtures" },
    { pattern: "../*", cwd: "fixtures/first" },
    { pattern: "../**", cwd: "fixtures/first", issue: 47 },
    { pattern: "../../*", cwd: "fixtures/first/nested" },
    { pattern: "../{first,second}", cwd: "fixtures/first" },
    { pattern: "./../*", cwd: "fixtures/first" },
  ],
};

// From fast-glob absolute.e2e.ts
const absolutePatterns = {
  regular: ["fixtures/*", "fixtures/**", "fixtures/**/*", "fixtures/../*"],
  cwd: [
    {
      pattern: "*",
      cwd: "fixtures",
    },
    {
      pattern: "**",
      cwd: "fixtures",
    },
    {
      pattern: "**/*",
      cwd: "fixtures",
    },
  ],
};

// From fast-glob only-files.e2e.ts
const onlyFilesPatterns = {
  regular: ["fixtures/*", "fixtures/**", "fixtures/**/*"],
  cwd: [
    {
      pattern: "*",
      cwd: "fixtures",
    },
    {
      pattern: "**",
      cwd: "fixtures",
    },
    {
      pattern: "**/*",
      cwd: "fixtures",
    },
  ],
};

/**
 * These are the e2e tests from fast-glob, with some omitted because we don't support features like ignored patterns
 * The snapshots are generated by running fast-glob on them first
 * There are slight discrepancies in the returned matches when there is a `./` in front of the pattern.
 * Bun.Glob is consistent with the Unix bash shell style, which always adds the `./`
 * fast-glob will randomly add it or omit it.
 * In practice this discrepancy makes no difference, so the snapshots were changed accordingly to match Bun.Glob / Unix bash shell style.
 */
describe("fast-glob e2e tests", async () => {
  let absolute_pattern_dir: string = "";
  // beforeAll(() => {
  tempFixturesDir();
  absolute_pattern_dir = tmpdirSync();
  // add some more directories so patterns like ../**/* don't break
  absolute_pattern_dir = path.join(absolute_pattern_dir, "ooga/booga");
  fs.mkdirSync(absolute_pattern_dir, { recursive: true })!;
  tempFixturesDir(absolute_pattern_dir);
  // });

  let buildsnapshot = false;
  const absoluteCwd = process.cwd();
  const cwd = import.meta.dir;
  console.log("CWD IS", cwd);
  const stripAbsoluteDir = (path: string): string => path.slice(absolute_pattern_dir.length);
  // const stripAbsoluteDir = (path: string): string => path;

  regular.regular.forEach(pattern => {
    // console.log("ABSOLUTE PATTERN DIR", absolute_pattern_dir);
    const absolutePattern = path.join(absolute_pattern_dir, pattern);
    test(`(absolute) patterns regular ${pattern}`, () => {
      let entries = buildsnapshot
        ? prepareEntries(fg.globSync(absolutePattern, { cwd }))
        : prepareEntries(Array.from(new Glob(absolutePattern).scanSync({ cwd, followSymlinks: true })));

      // console.log("PATTERN", absolutePattern, entries);
      expect(entries.map(stripAbsoluteDir)).toMatchSnapshot(`absolute: ${pattern}`);
    });

    test(`patterns regular ${pattern}`, () => {
      let entries = buildsnapshot
        ? prepareEntries(fg.globSync(pattern, { cwd }))
        : prepareEntries(Array.from(new Glob(pattern).scanSync({ cwd, followSymlinks: true })));

      expect(entries).toMatchSnapshot(pattern);
    });
  });

  regular.cwd.forEach(({ pattern, cwd: secondHalf }) => {
    const absolutePattern = path.join(absolute_pattern_dir, pattern);
    test(`(absolute) patterns regular cwd ${pattern}`, () => {
      const testCwd = path.join(cwd, secondHalf);
      let entries = buildsnapshot
        ? prepareEntries(fg.globSync(absolutePattern, { cwd: testCwd }))
        : prepareEntries(Array.from(new Glob(absolutePattern).scanSync({ cwd: testCwd, followSymlinks: true })));

      // let entries = ;
      expect(entries.map(stripAbsoluteDir)).toMatchSnapshot(`absolute: ${pattern}`);
    });

    test(`patterns regular cwd ${pattern}`, () => {
      const testCwd = path.join(cwd, secondHalf);
      let entries = buildsnapshot
        ? prepareEntries(fg.globSync(pattern, { cwd: testCwd }))
        : prepareEntries(Array.from(new Glob(pattern).scanSync({ cwd: testCwd, followSymlinks: true })));
      expect(entries).toMatchSnapshot(pattern);
    });
  });

  regular.relativeCwd.forEach(({ pattern, cwd: secondHalf }) => {
    const absolutePattern = path.join(absolute_pattern_dir, pattern);
    test(`(absolute) patterns regular relative cwd ${pattern}`, () => {
      const testCwd = secondHalf ? path.join(cwd, secondHalf) : cwd;
      let entries = buildsnapshot
        ? prepareEntries(fg.globSync(absolutePattern, { cwd: testCwd }))
        : prepareEntries(Array.from(new Glob(absolutePattern).scanSync({ cwd: testCwd, followSymlinks: true })));

      // let entries =
      expect(entries.map(stripAbsoluteDir)).toMatchSnapshot(`absolute: ${pattern}`);
    });

    test(`patterns regular relative cwd ${pattern}`, () => {
      const testCwd = secondHalf ? path.join(cwd, secondHalf) : cwd;
      let entries = buildsnapshot
        ? prepareEntries(fg.globSync(pattern, { cwd: testCwd }))
        : prepareEntries(Array.from(new Glob(pattern).scanSync({ cwd: testCwd, followSymlinks: true })));

      // let entries =
      expect(entries).toMatchSnapshot(pattern);
    });
  });

  absolutePatterns.cwd.forEach(({ pattern, cwd: secondHalf }) => {
    const absolutePattern = path.join(absolute_pattern_dir, pattern);
    test(`(absolute) patterns absolute cwd ${pattern}`, () => {
      const testCwd = secondHalf ? path.join(cwd, secondHalf) : cwd;
      let entries = buildsnapshot
        ? fg.globSync(absolutePattern, { cwd: testCwd, absolute: true })
        : Array.from(new Glob(absolutePattern).scanSync({ cwd: testCwd, followSymlinks: true, absolute: true }));
      // entries = entries.sort().map(entry => entry.slice(absoluteCwd.length + 1));
      entries = prepareEntries(entries);
      expect(entries.map(stripAbsoluteDir)).toMatchSnapshot(`absolute: ${pattern}`);
    });

    test(`patterns absolute cwd ${pattern}`, () => {
      const testCwd = secondHalf ? path.join(cwd, secondHalf) : cwd;
      let entries = buildsnapshot
        ? fg.globSync(pattern, { cwd: testCwd, absolute: true })
        : Array.from(new Glob(pattern).scanSync({ cwd: testCwd, followSymlinks: true, absolute: true }));

      entries = entries.sort().map(entry => entry.slice(testCwd.length + 1));
      entries = prepareEntries(entries);
      expect(entries).toMatchSnapshot(`absolute: ${pattern}`);
    });
  });

  onlyFilesPatterns.regular.forEach(pattern => {
    const absolutePattern = path.join(absolute_pattern_dir, pattern);

    test(`(absolute) only files ${pattern}`, () => {
      let entries = buildsnapshot
        ? prepareEntries(fg.globSync(absolutePattern, { cwd, absolute: false, onlyFiles: true }))
        : prepareEntries(
            Array.from(new Glob(absolutePattern).scanSync({ cwd, followSymlinks: true, onlyFiles: true })),
          );

      expect(entries.map(stripAbsoluteDir)).toMatchSnapshot(`absolute: ${pattern}`);
    });

    test(`only files ${pattern}`, () => {
      let entries = prepareEntries(fg.globSync(pattern, { cwd, absolute: false, onlyFiles: true }));

      // let entries = prepareEntries(
      //   Array.from(new Glob(pattern).scanSync({ cwd, followSymlinks: true, onlyFiles: true })),
      // );
      expect(entries).toMatchSnapshot(pattern);
    });
  });

  onlyFilesPatterns.cwd.forEach(({ pattern, cwd: secondHalf }) => {
    const absolutePattern = path.join(absolute_pattern_dir, pattern);
    test(`(absolute) only files (cwd) ${pattern}`, () => {
      const testCwd = secondHalf ? path.join(cwd, secondHalf) : cwd;
      let entries = buildsnapshot
        ? prepareEntries(fg.globSync(absolutePattern, { cwd: testCwd, absolute: false, onlyFiles: true }))
        : prepareEntries(
            Array.from(new Glob(absolutePattern).scanSync({ cwd: testCwd, followSymlinks: true, onlyFiles: true })),
          );

      expect(entries.map(stripAbsoluteDir)).toMatchSnapshot(`absolute: ${pattern}`);
    });

    test(`only files (cwd) ${pattern}`, () => {
      const testCwd = secondHalf ? path.join(cwd, secondHalf) : cwd;
      let entries = buildsnapshot
        ? prepareEntries(fg.globSync(pattern, { cwd: testCwd, absolute: false, onlyFiles: true }))
        : prepareEntries(
            Array.from(new Glob(pattern).scanSync({ cwd: testCwd, followSymlinks: true, onlyFiles: true })),
          );

      expect(entries).toMatchSnapshot(pattern);
    });
  });
});

test("broken symlinks", async () => {
  const glob = new Glob("**/*");
  const results = await Array.fromAsync(
    glob.scan({
      cwd: tempBrokenSymlinksDir,
      followSymlinks: true,
      absolute: true,
      onlyFiles: false,
    }),
  );
  expect(new Set(results)).toEqual(
    new Set([
      path.join(tempBrokenSymlinksDir, "broken_link_to_non_existent_dir"),
      path.join(tempBrokenSymlinksDir, "broken_link_to_non_existent_file.txt"),
    ]),
  );
});

// This is consistent with fast-glob's behavior
test.skipIf(process.platform == "win32")("error broken symlinks", async () => {
  const glob = new Glob("**/*");
  let err: Error | undefined = undefined;
  try {
    const results = await Array.fromAsync(
      glob.scan({
        cwd: tempBrokenSymlinksDir,
        followSymlinks: true,
        absolute: true,
        onlyFiles: false,
        throwErrorOnBrokenSymlink: true,
      }),
    );
  } catch (e) {
    err = e as any;
  }
  expect(err).toBeDefined();
});

test("error non-existent cwd", async () => {
  const glob = new Glob("**/*");
  let err: Error | undefined = undefined;
  try {
    const results = await Array.fromAsync(
      glob.scan({
        cwd: "alkfjalskdjfoogaboogaalskjflskdjfl",
        followSymlinks: true,
        absolute: true,
        onlyFiles: false,
        throwErrorOnBrokenSymlink: true,
      }),
    );
  } catch (e) {
    err = e as any;
  }
  expect(err).toBeDefined();
});

test("glob.scan(string)", async () => {
  const glob = new Glob("*.md");
  const entries = await Array.fromAsync(glob.scan(path.join(import.meta.dir, "fixtures")));
  expect(entries.length).toBeGreaterThan(0);
});

test("glob.scan('.')", async () => {
  const glob = new Glob("*.md");
  const entries = await Array.fromAsync(glob.scan("."));
  // bun root dir
  expect(entries).toContain("README.md");
});

describe("literal fast path", async () => {
  let tempdir = "";
  beforeAll(() => {
    tempdir = tempDirWithFiles("glob-scan-literal-fast-path", {
      "packages": {
        "a": {
          "package.json": "hi",
          "foo": "bar",
        },
        "b": {
          "package.json": "hi",
          "foo": "bar",
        },
        "c": {
          "package.json": "hi",
          "foo": "bar",
        },
        "foo": "bar",
      },
      "foo": "bar",
    });
  });

  test("works", async () => {
    const glob = new Glob("packages/*/package.json");
    const entries = await Array.fromAsync(glob.scan({ cwd: tempdir }));
    expect(entries.sort()).toEqual(
      [
        `packages${path.sep}a${path.sep}package.json`,
        `packages${path.sep}b${path.sep}package.json`,
        `packages${path.sep}c${path.sep}package.json`,
      ].sort(),
    );
  });

  test("works 2", async () => {
    const glob = new Glob("packages/*/foo");
    const entries = await Array.fromAsync(glob.scan({ cwd: tempdir }));
    expect(entries.sort()).toEqual(
      [
        `packages${path.sep}a${path.sep}foo`,
        `packages${path.sep}b${path.sep}foo`,
        `packages${path.sep}c${path.sep}foo`,
      ].sort(),
    );
  });

  test("works3", async () => {
    const glob = new Glob("packages/foo");
    const entries = await Array.fromAsync(glob.scan({ cwd: tempdir }));
    expect(entries.sort()).toEqual([`packages${path.sep}foo`].sort());
  });

  // The fast path stats the literal in each matched directory. Mode 444 fails that stat.
  // Root ignores the mode bits, and chmod on Windows cannot make a directory unsearchable.
  test.skipIf(isWindows || isRoot)("a failed stat reports the path from cwd", () => {
    using dir = tempDir("glob-scan-literal-fast-path-eacces", { "packages/a/package.json": "hi" });
    const unsearchable = path.join(String(dir), "packages", "a");
    fs.chmodSync(unsearchable, 0o444);
    try {
      expect(() => [...new Glob("packages/*/package.json").scanSync({ cwd: String(dir) })]).toThrow(
        expect.objectContaining({ code: "EACCES", syscall: "fstatat", path: "packages/a/package.json" }),
      );
      expect(() => [...new Glob("packages/*/package.json").scanSync({ cwd: String(dir), absolute: true })]).toThrow(
        expect.objectContaining({
          code: "EACCES",
          syscall: "fstatat",
          path: path.join(unsearchable, "package.json"),
        }),
      );
    } finally {
      fs.chmodSync(unsearchable, 0o755);
    }
  });
});

describe("trailing directory separator", async () => {
  test("matches directories absolute", async () => {
    const tmpdir = tmpdirSync();
    const files = [`${tmpdir}${path.sep}bunx-foo`, `${tmpdir}${path.sep}bunx-bar`, `${tmpdir}${path.sep}bunx-baz`];
    await Bun.$`touch ${files[0]}; touch ${files[1]}; mkdir ${files[2]}`;
    const glob = new Glob(`${path.join(tmpdir, "bunx-*")}${path.sep}`);
    const entries = await Array.fromAsync(glob.scan({ onlyFiles: false }));
    expect(entries.sort()).toEqual(files.slice(2, 3).sort());
  });

  test("matches directories relative", async () => {
    const tmpdir = tmpdirSync();
    const files = [`bunx-foo`, `bunx-bar`, `bunx-baz`];
    await Bun.$`touch ${files[0]}; touch ${files[1]}; mkdir ${files[2]}`.cwd(tmpdir);
    const glob = new Glob(`bunx-*/`);
    const entries = await Array.fromAsync(glob.scan({ onlyFiles: false, cwd: tmpdir }));
    expect(entries.sort()).toEqual(files.slice(2, 3).sort());
  });
});

test("a pattern that ends in /./ keeps the dot", () => {
  using dir = tempDir("glob-trailing-dot", { "a/x": "", "ab/x": "" });
  expect([...new Glob("*/./").scanSync({ cwd: String(dir), onlyFiles: false })].sort()).toEqual([
    `a${path.sep}.`,
    `ab${path.sep}.`,
  ]);
});

describe("absolute path pattern", async () => {
  test("works *", async () => {
    const tmpdir = tmpdirSync();
    const files = [`${tmpdir}${path.sep}bunx-foo`, `${tmpdir}${path.sep}bunx-bar`, `${tmpdir}${path.sep}bunx-baz`];
    await Bun.$`touch ${files[0]}; touch ${files[1]}; mkdir ${files[2]}`;
    const glob = new Glob(`${path.join(tmpdir, "bunx-*")}`);
    const entries = await Array.fromAsync(glob.scan({ onlyFiles: false }));
    expect(entries.sort()).toEqual(files.sort());
  });

  test("works **/", async () => {
    const tmpdir = tmpdirSync();
    const files = [
      `${tmpdir}${path.sep}bunx-foo`,
      `${tmpdir}${path.sep}bunx-bar`,
      `${tmpdir}${path.sep}bunx-baz`,
      `${tmpdir}${path.sep}foo`,
      `${tmpdir}${path.sep}bar`,
      `${tmpdir}${path.sep}bar`,
    ];
    await Bun.$`mkdir -p ${files.slice(0, 3)}; touch ${files.slice(3)}`;
    const glob = new Glob(`${path.join(tmpdir, "**")}${path.sep}`);
    const entries = await Array.fromAsync(glob.scan({ onlyFiles: false }));
    expect(entries.sort()).toEqual(files.slice(0, 3).sort());
  });

  test("works **", async () => {
    const tmpdir = tmpdirSync();
    const files = [
      `${tmpdir}${path.sep}bunx-foo`,
      `${tmpdir}${path.sep}bunx-bar`,
      `${tmpdir}${path.sep}bunx-baz`,
      `${tmpdir}${path.sep}foo`,
      `${tmpdir}${path.sep}bar`,
      `${tmpdir}${path.sep}bar`,
    ];
    await Bun.$`mkdir -p ${files.slice(0, 3)}; touch ${files.slice(3)}`;
    const glob = new Glob(`${path.join(tmpdir, "**")}`);
    const entries = await Array.fromAsync(glob.scan({ onlyFiles: false }));
    expect(entries.sort()).toEqual(files.slice(0, files.length - 1).sort());
  });

  test("non-special path as first component", async () => {
    const glob = new Glob("/**lol");
    const entries = await Array.fromAsync(glob.scan({ onlyFiles: false }));
    expect(entries).toEqual([]);
  });

  test("doesn't exist, file pattern", async () => {
    const tmpdir = tmpdirSync();
    await Bun.$`mkdir -p hello/friends; touch hello/friends/lol.json; echo ${tmpdir}`.cwd(tmpdir);
    const glob = new Glob(`${tmpdir}/hello/friends/nice.json`);
    console.log(Array.from(glob.scanSync({ cwd: tmpdir })));
  });
});

// https://github.com/oven-sh/bun/issues/24936
describe("glob scan should not escape cwd boundary", () => {
  test("pattern .*/* should not match parent directory via ..", async () => {
    // Create a directory structure where we can verify paths don't escape cwd
    await using tempdir = tempDir("glob-cwd-escape", {
      ".hidden": {
        "file.txt": "hidden file content",
      },
      ".dotfile": "dot file",
      "regular": {
        "file.txt": "regular file",
      },
    });

    const glob = new Glob(".*/*");
    const entries = await Array.fromAsync(
      glob.scan({
        cwd: tempdir,
        onlyFiles: false,
        dot: true, // Need dot:true to match dotfiles/directories
      }),
    );

    // All entries should be within the cwd - none should start with ../
    for (const entry of entries) {
      expect(entry.startsWith("../")).toBe(false);
      expect(entry.startsWith("..\\")).toBe(false);
      expect(entry.includes("/../")).toBe(false);
      expect(entry.includes("\\..\\")).toBe(false);
    }

    // Should match .hidden/file.txt but not escape to parent
    expect(entries.sort()).toEqual([`.hidden${path.sep}file.txt`].sort());
  });

  test("pattern .*/**/*.ts should not escape cwd", async () => {
    await using tempdir = tempDir("glob-cwd-escape-ts", {
      ".config": {
        "settings.ts": "export default {}",
        "nested": {
          "deep.ts": "export const x = 1",
        },
      },
      "src": {
        "index.ts": "console.log('hi')",
      },
    });

    const glob = new Glob(".*/**/*.ts");
    const entries = await Array.fromAsync(
      glob.scan({
        cwd: tempdir,
        onlyFiles: true,
        dot: true, // Need dot:true to match dotfiles/directories
      }),
    );

    // All entries should be within the cwd
    for (const entry of entries) {
      expect(entry.startsWith("../")).toBe(false);
      expect(entry.startsWith("..\\")).toBe(false);
      expect(entry.includes("/../")).toBe(false);
      expect(entry.includes("\\..\\")).toBe(false);
    }

    // Should match files in .config but not escape to parent
    expect(entries.sort()).toEqual(
      [`.config${path.sep}settings.ts`, `.config${path.sep}nested${path.sep}deep.ts`].sort(),
    );
  });
});

describe("glob.scan wildcard fast path", async () => {
  test("works", async () => {
    await using tempdir = tempDir("glob-scan-wildcard-fast-path", {
      "lol.md": "",
      "lol2.md": "",
      "shouldnt-show.md23243": "",
      "shouldnt-show.ts": "",
    });
    const glob = new Glob("*.md");
    const entries = await Array.fromAsync(glob.scan(String(tempdir)));
    // bun root dir
    expect(entries.sort()).toEqual(["lol.md", "lol2.md"].sort());
  });

  // https://github.com/oven-sh/bun/issues/8817
  describe("fast-path detection edgecase", async () => {
    function runTest(pattern: string, files: Record<string, string>, expected: string[]) {
      test(`pattern: ${pattern}`, async () => {
        await using tempdir = tempDir("glob-scan-wildcard-fast-path", files);
        const glob = new Glob(pattern);
        const entries = await Array.fromAsync(glob.scan(String(tempdir)));
        expect(entries.sort()).toEqual(expected.sort());
      });
    }

    runTest(
      "*.test.*",
      {
        "example.test.ts": "",
        "example.test.js": "",
        "shouldnt-show.ts": "",
      },
      ["example.test.ts", "example.test.js"],
    );

    runTest(
      "*.test.ts",
      {
        "example.test.ts": "",
        "example.test.ts.test.ts": "",
        "shouldnt-show.ts": "",
      },
      ["example.test.ts", "example.test.ts.test.ts"],
    );

    runTest(
      "*.test.{js,ts}",
      {
        "example.test.ts": "",
        "example.test.js": "",
        "shouldnt-show.ts": "",
      },
      ["example.test.ts", "example.test.js"],
    );

    runTest(
      "*.test.ts?",
      {
        "example.test.tsx": "",
        "example.test.tsz": "",
        "shouldnt-show.ts": "",
      },
      ["example.test.tsx", "example.test.tsz"],
    );

    // `!` only applies negation if at the start of the pattern
    runTest(
      "*.test!.*",
      {
        "hi.test!.js": "",
        "hello.test!.ts": "",
        "no.test.ts": "",
      },
      ["hi.test!.js", "hello.test!.ts"],
    );
  });
});

// ComponentSet (AutoBitSet) stores up to 127 indices inline, then spills to
// heap. Verify patterns past that threshold still match correctly.
// Skipped on Windows: 130 levels × 2 chars + tmpdir prefix exceeds MAX_PATH (260).
test.skipIf(process.platform === "win32")("patterns with many components", () => {
  const depth = 130;
  const files: Record<string, string> = {};
  const parts: string[] = [];
  for (let i = 0; i < depth; i++) parts.push("a");
  files[parts.join("/") + "/hit.txt"] = "";
  files[parts.slice(0, depth - 1).join("/") + "/miss.txt"] = "";

  using dir = tempDir("glob-deep", files);

  // Exact-depth pattern: depth `*` components + literal tail
  const star = Array(depth).fill("*").join("/") + "/hit.txt";
  expect([...new Bun.Glob(star).scanSync({ cwd: dir })].length).toBe(1);

  // `**` at the start with a deep literal prefix after it
  const deepDouble = "**/" + Array(depth).fill("a").join("/") + "/*.txt";
  expect([...new Bun.Glob(deepDouble).scanSync({ cwd: dir })].length).toBe(1);

  // `**` sandwiched deep in the pattern (triggers merge at high index)
  const half = Math.floor(depth / 2);
  const sandwich =
    Array(half).fill("*").join("/") +
    "/**/" +
    Array(depth - half)
      .fill("a")
      .join("/") +
    "/*.txt";
  expect([...new Bun.Glob(sandwich).scanSync({ cwd: dir })].length).toBe(1);
});

// scan() keeps the cwd string it is given verbatim, but child paths pushed for
// symlink work items are joined and normalized. The entry-name offset stored on
// those work items must be derived from the normalized joined path, not from the
// raw cwd, otherwise a cwd with redundant trailing separators plus a short-named
// symlink makes the offset exceed the path length.
test("scan handles a cwd with redundant trailing separators when following symlinks", async () => {
  using dir = tempDir("glob-scan-symlink-raw-cwd", {
    "haystack/regular.txt": "regular",
    "haystack/target/inner.txt": "inner",
  });

  // Short-named symlink to a directory: after normalization the joined child
  // path is shorter than the raw cwd string passed to scan() below.
  try {
    fs.symlinkSync("target", path.join(String(dir), "haystack", "L"), "dir");
  } catch (err: any) {
    if (err.code === "EPERM" || err.code === "EACCES") return;
    throw err;
  }

  // cwd with redundant trailing separators, passed through to scan() as-is.
  const rawCwd = path.join(String(dir), "haystack") + path.sep.repeat(4);

  const script = `
    const opts = {
      cwd: process.env.GLOB_RAW_CWD,
      absolute: true,
      followSymlinks: true,
      onlyFiles: false,
    };
    const shallow = await Array.fromAsync(new Bun.Glob("*").scan(opts));
    const deep = await Array.fromAsync(new Bun.Glob("**/*").scan(opts));
    console.log(JSON.stringify({ shallow, deep }));
  `;

  await using proc = Bun.spawn({
    cmd: [bunExe(), "-e", script],
    env: { ...bunEnv, GLOB_RAW_CWD: rawCwd },
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);

  const norm = (s: string) => s.replaceAll("\\", "/");
  const root = norm(path.join(String(dir), "haystack"));

  expect(stdout.trim()).not.toBe("");
  const result = JSON.parse(stdout.trim());
  const shallow = result.shallow.map(norm).sort();
  const deep = result.deep.map(norm).sort();

  // Only real entries under the scanned directory are reported, and the
  // symlinked directory is still traversed.
  expect(shallow).toEqual([`${root}/L`, `${root}/regular.txt`, `${root}/target`].sort());
  expect(deep).toEqual(
    [`${root}/L`, `${root}/L/inner.txt`, `${root}/regular.txt`, `${root}/target`, `${root}/target/inner.txt`].sort(),
  );
  expect(exitCode).toBe(0);
});

// globalThis has its own private names, such as the module resolver's.
test("scan and scanSync throw a TypeError when `this` is globalThis", () => {
  expect(() => Bun.Glob.prototype.scanSync.call(globalThis, "fs")).toThrow(TypeError);
  expect(() => Bun.Glob.prototype.scan.call(globalThis, "fs")).toThrow(TypeError);
});

// A pattern segment that spells out a leading `.` is an explicit request for
// that dotfile/dot-directory, so the `dot: false` default must not hide it.
// This matches bash, picomatch, minimatch and fast-glob.
describe("explicit dotfile segments match without dot:true", () => {
  const norm = (a: string[]) => a.map(p => p.replaceAll("\\", "/")).sort();
  const files = {
    ".dotdir/inner.txt": "x",
    ".dotdir/.hidden.txt": "x",
    ".dotdir/foo/.dotdir/inner.txt": "x",
    ".env": "x",
    "sub/.dotdir/inner.txt": "x",
    "sub/visible.txt": "x",
    "visible.txt": "x",
  };

  test.each([
    [".dotdir/inner.txt", [".dotdir/inner.txt"]],
    [".dotdir/*.txt", [".dotdir/inner.txt"]],
    [".*/inner.txt", [".dotdir/inner.txt"]],
    [".env", [".env"]],
    [".*", [".env"]],
    // `**` may advance to an explicit `.dotdir` segment but must not itself
    // recurse through a hidden dir: `.dotdir/foo/.dotdir/inner.txt` must not
    // match since the only decomposition needs `**` to consume `.dotdir/foo`.
    ["**/.dotdir/inner.txt", [".dotdir/inner.txt", "sub/.dotdir/inner.txt"]],
    ["sub/.dotdir/*.txt", ["sub/.dotdir/inner.txt"]],
  ])("pattern %j finds explicitly-named dotfiles", (pattern, expected) => {
    using dir = tempDir("glob-scan-explicit-dot", files);
    const result = Array.from(new Glob(pattern).scanSync({ cwd: String(dir) }));
    expect(norm(result)).toEqual(expected.sort());
  });

  test.each([
    ["*", ["visible.txt"]],
    ["*.txt", ["visible.txt"]],
    ["*/inner.txt", []],
    ["**/inner.txt", []],
    ["**/*.txt", ["visible.txt", "sub/visible.txt"]],
  ])("wildcard pattern %j still hides dotfiles by default", (pattern, expected) => {
    using dir = tempDir("glob-scan-wildcard-dot", files);
    const result = Array.from(new Glob(pattern).scanSync({ cwd: String(dir) }));
    expect(norm(result)).toEqual(expected.sort());
  });

  test("async scan finds explicitly-named dotfiles", async () => {
    using dir = tempDir("glob-scan-explicit-dot-async", files);
    const result = await Array.fromAsync(new Glob(".dotdir/inner.txt").scan({ cwd: String(dir) }));
    expect(norm(result)).toEqual([".dotdir/inner.txt"]);
  });
});

// Directory entries on Linux are bytes that need not be valid UTF-8. The
// matcher must step over them in the same units the returned names use (one
// U+FFFD per maximal ill-formed subpart), not by the lead byte's nominal
// length, or `?` and `*` step into the next character or past the end.
describe.skipIf(!isLinux)("scan over entry names that are not valid UTF-8", () => {
  let dir: string;
  beforeAll(() => {
    dir = String(tempDir("glob-scan-invalid-utf8", {}));
    // Bytes after "t": `\xc3 x`, `\xe4\xb8 .js`, `é \xc3`, `😀 js`, `x \x80`, `\xed\xa0\x80` (a WTF-8 surrogate).
    for (const hex of ["c378", "e4b82e6a73", "c3a9c3", "f09f98806a73", "7880", "eda080"]) {
      fs.writeFileSync(Buffer.concat([Buffer.from(dir + "/t"), Buffer.from(hex, "hex")]), "");
    }
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const scan = (pattern: string) => [...new Glob(pattern).scanSync({ cwd: dir })].sort();
  const all = ["t\uFFFDx", "t\uFFFD.js", "té\uFFFD", "t😀js", "tx\uFFFD", "t\uFFFD\uFFFD\uFFFD"];

  test.each([
    ["*", all],
    ["t*", all],
    ["t?", []],
    ["t??", ["t\uFFFDx", "té\uFFFD", "tx\uFFFD"]],
    ["t???", ["t😀js", "t\uFFFD\uFFFD\uFFFD"]],
    ["t????", ["t\uFFFD.js"]],
    ["t*.js", ["t\uFFFD.js"]],
    ["t?.js", ["t\uFFFD.js"]],
    ["t*s", ["t\uFFFD.js", "t😀js"]],
    ["t[!a-z]x", ["t\uFFFDx"]],
    ["t[\uFFFD]*", ["t\uFFFDx", "t\uFFFD.js", "t\uFFFD\uFFFD\uFFFD"]],
  ] as [string, string[]][])("%j", (pattern, expected) => {
    expect(scan(pattern)).toEqual([...expected].sort());
    // Wildcards and classes see the raw bytes the way match() sees the decoded
    // name. (A literal U+FFFD in a pattern still compares bytes, since the
    // decode is lossy.)
    expect(scan(pattern)).toEqual(scan("*").filter(name => new Glob(pattern).match(name)));
  });
});

// `followSymlinks` controls whether wildcard traversal descends through
// symlinked directories. A segment that names the symlink literally is an
// explicit path the user wrote; it should resolve regardless, matching
// fast-glob and bash.
const canCreateDirSymlink = (() => {
  using probe = tempDir("glob-scan-symlink-probe", { "target/x": "" });
  try {
    fs.symlinkSync("target", path.join(String(probe), "link"), "dir");
    return true;
  } catch (err: any) {
    if (err.code === "EPERM" || err.code === "EACCES") return false;
    throw err;
  }
})();

describe.skipIf(!canCreateDirSymlink)("literal path segment through a symlinked directory", () => {
  const norm = (a: string[]) => a.map(p => p.replaceAll("\\", "/")).sort();

  function makeTree(prefix: string) {
    const dir = tempDir(prefix, {
      "realdir/file.txt": "x",
      "realdir/nested/deep.txt": "x",
      "plain/file.txt": "x",
    });
    fs.symlinkSync("realdir", path.join(String(dir), "linkdir"), "dir");
    return dir;
  }

  test("literal segment resolves through a symlink with followSymlinks:false", () => {
    using dir = makeTree("glob-scan-symlink-literal");
    const cwd = String(dir);
    const scan = (p: string) => norm(Array.from(new Glob(p).scanSync({ cwd, followSymlinks: false })));

    expect(scan("linkdir/file.txt")).toEqual(["linkdir/file.txt"]);
    expect(scan("linkdir/*.txt")).toEqual(["linkdir/file.txt"]);
    expect(scan("linkdir/nested/deep.txt")).toEqual(["linkdir/nested/deep.txt"]);
    expect(scan("linkdir/**/*.txt")).toEqual(["linkdir/file.txt", "linkdir/nested/deep.txt"]);
  });

  test("wildcard segment still respects followSymlinks:false", () => {
    using dir = makeTree("glob-scan-symlink-wildcard");
    const cwd = String(dir);
    const scan = (p: string) => norm(Array.from(new Glob(p).scanSync({ cwd, followSymlinks: false })));

    expect(scan("*/file.txt")).toEqual(["plain/file.txt", "realdir/file.txt"]);
    expect(scan("**/file.txt")).toEqual(["plain/file.txt", "realdir/file.txt"]);
    expect(scan("link*/file.txt")).toEqual([]);
  });

  test("followSymlinks:true still traverses via wildcards", () => {
    using dir = makeTree("glob-scan-symlink-follow");
    const cwd = String(dir);
    const scan = (p: string) => norm(Array.from(new Glob(p).scanSync({ cwd, followSymlinks: true })));

    expect(scan("*/file.txt")).toEqual(["linkdir/file.txt", "plain/file.txt", "realdir/file.txt"]);
    expect(scan("linkdir/file.txt")).toEqual(["linkdir/file.txt"]);
  });

  // The SymLink (and DT_UNKNOWN) readdir arms pre-filter entries through
  // eval_impl before eval_dir runs. eval_impl must therefore admit the same
  // `**/.X` peek that eval_dir does, or a symlinked `.dotdir` (and a real
  // `.dotdir` reported as DT_UNKNOWN on NFS/overlayfs/FUSE) would be dropped
  // before the explicit-dot logic ever sees it.
  test("**/.dotdir peek works when .dotdir is a symlink", () => {
    using dir = tempDir("glob-scan-symlink-dotdir", {
      "realdir/inner.txt": "x",
    });
    fs.symlinkSync("realdir", path.join(String(dir), ".dotdir"), "dir");
    const cwd = String(dir);
    const scan = (p: string, opts: GlobScanOptions) => norm(Array.from(new Glob(p).scanSync({ cwd, ...opts })));

    expect(scan("**/.dotdir/inner.txt", { followSymlinks: true })).toEqual([".dotdir/inner.txt"]);
    expect(scan(".dotdir/inner.txt", { followSymlinks: true })).toEqual([".dotdir/inner.txt"]);
    expect(scan(".dotdir/inner.txt", { followSymlinks: false })).toEqual([".dotdir/inner.txt"]);
  });

  test("symlink cycles do not loop when reached via a literal segment", () => {
    using dir = tempDir("glob-scan-symlink-cycle", {
      "top/file.txt": "x",
    });
    fs.symlinkSync(".", path.join(String(dir), "top", "loop"), "dir");
    // `top` is reached literally; the `loop -> .` symlink inside is only ever
    // reached via `**`, which must not follow it with followSymlinks:false.
    const result = norm(Array.from(new Glob("top/**/*.txt").scanSync({ cwd: String(dir), followSymlinks: false })));
    expect(result).toEqual(["top/file.txt"]);
  });

  test("** with followSymlinks does not descend into a symlink that resolves to one of its own ancestors", () => {
    using dir = tempDir("glob-scan-symlink-self-cycle", {
      "top/file.txt": "x",
    });
    fs.symlinkSync(".", path.join(String(dir), "top", "loop"), "dir");
    const cwd = path.join(String(dir), "top");
    const result = norm(Array.from(new Glob("**/*.txt").scanSync({ cwd, followSymlinks: true })));
    expect(result).toEqual(["file.txt", "loop/file.txt"]);

    using shared = tempDir("glob-scan-symlink-shared-target", {
      "realdir/file.txt": "x",
    });
    fs.symlinkSync("realdir", path.join(String(shared), "linkA"), "dir");
    fs.symlinkSync("realdir", path.join(String(shared), "linkB"), "dir");
    const dag = norm(Array.from(new Glob("**/*.txt").scanSync({ cwd: String(shared), followSymlinks: true })));
    expect(dag).toEqual(["linkA/file.txt", "linkB/file.txt", "realdir/file.txt"]);
  });

  // Symlinks to the same target in *different* subtrees are not a cycle: a
  // followed link recorded in one subtree must not suppress its cousin.
  test("** with followSymlinks descends cousin symlinks that share a target", () => {
    using dir = tempDir("glob-scan-symlink-cousins", {
      "shared/file.txt": "x",
      "a/keep.txt": "x",
      "b/keep.txt": "x",
    });
    fs.symlinkSync(path.join("..", "shared"), path.join(String(dir), "a", "link"), "dir");
    fs.symlinkSync(path.join("..", "shared"), path.join(String(dir), "b", "link"), "dir");
    const result = norm(Array.from(new Glob("**/*.txt").scanSync({ cwd: String(dir), followSymlinks: true })));
    expect(result).toEqual(["a/keep.txt", "a/link/file.txt", "b/keep.txt", "b/link/file.txt", "shared/file.txt"]);
  });

  test("async ** with followSymlinks does not descend into a symlink that resolves to one of its own ancestors", async () => {
    using dir = tempDir("glob-scan-symlink-self-cycle-async", {
      "top/file.txt": "x",
    });
    fs.symlinkSync(".", path.join(String(dir), "top", "loop"), "dir");
    const cwd = path.join(String(dir), "top");
    const result = await Array.fromAsync(new Glob("**/*.txt").scan({ cwd, followSymlinks: true }));
    expect(norm(result)).toEqual(["file.txt", "loop/file.txt"]);
  });

  test("async scan resolves a literal path through a symlink", async () => {
    using dir = makeTree("glob-scan-symlink-literal-async");
    const result = await Array.fromAsync(
      new Glob("linkdir/file.txt").scan({ cwd: String(dir), followSymlinks: false }),
    );
    expect(norm(result)).toEqual(["linkdir/file.txt"]);
  });
});

// A directory the user can read but not write (RX-only grant) must still be
// descended by the scanner: directory opens used to request FILE_ADD_FILE and
// fail ACCESS_DENIED there. Elevated tokens bypass the ACL; the precondition
// is probed and the test skips visibly then.
let roDirRoot = "";
let roDirA = "";
let roDirEnforced = false;
if (isWindows) {
  try {
    roDirRoot = tempDirWithFiles("glob-scan-readonly-dir", {
      "a/b/file.txt": "under a read-only directory",
    });
    roDirA = path.join(roDirRoot, "a");
    execSync(`icacls "${roDirA}" /inheritance:r /grant:r "${process.env.USERNAME}:(OI)(CI)(RX)" /Q`);
    try {
      fs.mkdirSync(path.join(roDirA, "probe"));
      // Creation succeeded: ACL not enforced under this token — restore and skip.
      execSync(`icacls "${roDirA}" /reset /T /Q`);
    } catch {
      roDirEnforced = true;
    }
  } catch {}
}

afterAll(() => {
  if (!roDirA) return;
  try {
    execSync(`icacls "${roDirA}" /reset /T /Q`);
  } catch {}
  try {
    fs.rmSync(roDirRoot, { recursive: true, force: true });
  } catch {}
});

describe("extglob and brace sequences", () => {
  const scan = (pattern: string, cwd: string) =>
    Array.from(new Glob(pattern).scanSync({ cwd }))
      .map(p => p.replaceAll("\\", "/"))
      .sort();

  test("scan finds the same files that match accepts", () => {
    using dir = tempDir("glob-extglob", {
      "a.js": "",
      "b.js": "",
      "c.js": "",
      "a.test.js": "",
      "1.txt": "",
      "2.txt": "",
      "3.txt": "",
      "a/x.js": "",
      "b/x.js": "",
      "ab/x.js": "",
      "c/x.js": "",
      "app/(marketing)/page.js": "",
      "app/marketing/page.js": "",
    });
    const cwd = String(dir);
    expect(scan("@(a|b).js", cwd)).toEqual(["a.js", "b.js"]);
    expect(scan("+(a|b).js", cwd)).toEqual(["a.js", "b.js"]);
    expect(scan("!(a|b).js", cwd)).toEqual(["a.test.js", "c.js"]);
    expect(scan("*.@(txt|md)", cwd)).toEqual(["1.txt", "2.txt", "3.txt"]);
    expect(scan("{1..2}.txt", cwd)).toEqual(["1.txt", "2.txt"]);
    expect(scan("@(a|b)/*.js", cwd)).toEqual(["a/x.js", "b/x.js"]);
    expect(scan("+(a|b)/*.js", cwd)).toEqual(["a/x.js", "ab/x.js", "b/x.js"]);
    expect(scan("**/!(x|page).js", cwd)).toEqual(["a.js", "a.test.js", "b.js", "c.js"]);
    expect(scan("app/(marketing)/*.js", cwd)).toEqual(["app/(marketing)/page.js"]);
    expect(scan("app/(marketing)/**", cwd)).toEqual(["app/(marketing)/page.js"]);
  });
});

describe.skipIf(!isWindows)("glob scan descends read-only directories", () => {
  test.skipIf(!roDirEnforced)(
    `RX-only directory is descended, creates still fail${roDirEnforced ? "" : " (skipped: ACL not enforced under this token)"}`,
    () => {
      const entries = Array.from(new Glob("**/*.txt").scanSync({ cwd: roDirRoot }))
        .map(p => p.replaceAll("\\", "/"))
        .sort();
      expect(entries).toEqual(["a/b/file.txt"]);

      let err: any;
      try {
        fs.mkdirSync(path.join(roDirA, "x"));
      } catch (e) {
        err = e;
      }
      expect(err?.code).toBe("EPERM");
    },
  );
});

test("scan and scanSync reject a cwd or a pattern with a null byte", () => {
  using dir = tempDir("glob-scan-null-byte", { "safe/inside.ts": "x" });
  const nullByteError = expect.objectContaining({ code: "ERR_INVALID_ARG_VALUE" });
  const cwd = `${dir}/safe\0/../secret`;
  expect(() => Array.from(new Glob("*.ts").scanSync({ cwd }))).toThrow(nullByteError);
  expect(() => Array.from(new Glob("*.ts").scanSync(cwd))).toThrow(nullByteError);
  expect(() => new Glob("*.ts").scan({ cwd })).toThrow(nullByteError);
  const pattern = `${dir}/safe\0trailer/*.ts`;
  expect(() => Array.from(new Glob(pattern).scanSync())).toThrow(nullByteError);
  expect(() => new Glob(pattern).scan()).toThrow(nullByteError);
  expect(new Glob("a\0b").match("a\0b")).toBe(true);
});

test.skipIf(isWindows)("closes a directory that got the number of a closed standard stream", async () => {
  using dir = tempDir("glob-scan-closed-stdin", { "nested/file.txt": "" });
  await using proc = Bun.spawn({
    cmd: [
      bunExe(),
      "-e",
      `const fs = require("fs");
       fs.closeSync(0);
       console.log([...new Bun.Glob("*/*.txt").scanSync()].join(), fs.openSync(".", "r"));`,
    ],
    env: bunEnv,
    cwd: String(dir),
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  expect({ stdout, stderr, exitCode }).toEqual({ stdout: "nested/file.txt 0\n", stderr: "", exitCode: 0 });
});

test.skipIf(!isWindows)("./* from the root gives absolute paths below the root", () => {
  const entries = [...new Glob("./*").scanSync({ cwd: "/", absolute: true, onlyFiles: false })];
  expect(new Set(entries.map(entry => path.dirname(entry)))).toEqual(new Set([path.sep]));
});

describe("ignore option", () => {
  const norm = (a: string[]) => a.map(p => p.replaceAll("\\", "/")).sort();
  const tree = {
    "package.json": "{}",
    "src/index.ts": "",
    "src/index.test.ts": "",
    "src/util/helpers.ts": "",
    "src/util/helpers.test.ts": "",
    "dist/index.js": "",
    "dist/chunks/a.js": "",
    "node_modules/dep/index.ts": "",
    "node_modules/dep/dist/index.js": "",
    "packages/app/package.json": "{}",
    "packages/app/src/main.ts": "",
    "packages/app/dist/main.js": "",
    "packages/app/node_modules/dep/index.ts": "",
  };
  const scanSync = (pattern: string, opts: GlobScanOptions) => norm(Array.from(new Glob(pattern).scanSync(opts)));
  const scan = async (pattern: string, opts: GlobScanOptions) =>
    norm(await Array.fromAsync(new Glob(pattern).scan(opts)));

  test("leaves out matching files and does not enter matching directories", async () => {
    using dir = tempDir("glob-ignore", tree);
    const cwd = String(dir);
    const ignore = ["**/node_modules/**", "dist/**"];
    const expected = [
      "package.json",
      "packages/app/dist/main.js",
      "packages/app/package.json",
      "packages/app/src/main.ts",
      "src/index.test.ts",
      "src/index.ts",
      "src/util/helpers.test.ts",
      "src/util/helpers.ts",
    ];
    expect(scanSync("**/*", { cwd, ignore })).toEqual(expected);
    expect(await scan("**/*", { cwd, ignore })).toEqual(expected);
  });

  test("accepts a single pattern", () => {
    using dir = tempDir("glob-ignore", tree);
    const cwd = String(dir);
    expect(scanSync("src/**/*.ts", { cwd, ignore: "**/*.test.ts" })).toEqual(["src/index.ts", "src/util/helpers.ts"]);
  });

  test("a directory name without a trailing slash still skips its subtree", () => {
    using dir = tempDir("glob-ignore", tree);
    const cwd = String(dir);
    // `dist` only covers the root `dist`; `**/node_modules` covers every one.
    expect(scanSync("**/*", { cwd, ignore: ["dist", "**/node_modules"] })).toEqual([
      "package.json",
      "packages/app/dist/main.js",
      "packages/app/package.json",
      "packages/app/src/main.ts",
      "src/index.test.ts",
      "src/index.ts",
      "src/util/helpers.test.ts",
      "src/util/helpers.ts",
    ]);
  });

  test("ignored directories are not listed with onlyFiles: false", () => {
    using dir = tempDir("glob-ignore", tree);
    const cwd = String(dir);
    expect(scanSync("**", { cwd, onlyFiles: false, ignore: ["**/node_modules/**", "**/dist", "src/util/**"] })).toEqual(
      [
        "package.json",
        "packages",
        "packages/app",
        "packages/app/package.json",
        "packages/app/src",
        "packages/app/src/main.ts",
        "src",
        "src/index.test.ts",
        "src/index.ts",
      ],
    );
  });

  test("patterns are relative to cwd when absolute: true", async () => {
    using dir = tempDir("glob-ignore", tree);
    const cwd = String(dir);
    const expected = norm([path.join(cwd, "src/index.ts"), path.join(cwd, "src/util/helpers.ts")]);
    const ignore = ["node_modules/**", "packages/**", "**/*.test.ts"];
    expect(scanSync("**/*.ts", { cwd, absolute: true, ignore })).toEqual(expected);
    expect(await scan("**/*.ts", { cwd, absolute: true, ignore })).toEqual(expected);
    // A cwd that `scan` normalizes before it joins paths onto it.
    expect(scanSync("**/*.ts", { cwd: cwd + path.sep, absolute: true, ignore })).toEqual(expected);
    expect(scanSync("**/*.ts", { cwd: cwd + path.sep + ".", absolute: true, ignore })).toEqual(expected);
  });

  test("an absolute pattern is matched against the full path", () => {
    using dir = tempDir("glob-ignore", tree);
    const cwd = String(dir);
    // Ignore patterns use `/` as the separator, like `Glob.match()`; it also matches `\` on Windows.
    const ignore = [`${cwd.replaceAll("\\", "/")}/**/node_modules/**`, "**/*.test.ts", "**/packages/**"];
    expect(scanSync(path.join(cwd, "**", "*.ts"), { cwd, ignore })).toEqual(
      norm([path.join(cwd, "src/index.ts"), path.join(cwd, "src/util/helpers.ts")]),
    );
  });

  // A broken symlink inside the ignored tree makes the walk throw if it is entered.
  test.skipIf(isWindows)("an ignored directory is not entered", async () => {
    using dir = tempDir("glob-ignore", tree);
    const cwd = String(dir);
    fs.symlinkSync("missing", path.join(cwd, "node_modules", "broken"));
    const opts = { cwd, followSymlinks: true, throwErrorOnBrokenSymlink: true } satisfies GlobScanOptions;

    let err: any;
    try {
      scanSync("**/*", opts);
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe("ENOENT");

    const expected = ["package.json", "packages/app/package.json", "packages/app/src/main.ts", "src/index.ts"];
    const ignore = ["**/node_modules/**", "**/dist", "**/*.test.ts", "src/util/**"];
    expect(scanSync("**/*", { ...opts, ignore })).toEqual(expected);
    expect(await scan("**/*", { ...opts, ignore })).toEqual(expected);
  });

  test.skipIf(!canCreateDirSymlink)("a symlinked directory that matches is not entered", () => {
    using dir = tempDir("glob-ignore", tree);
    const cwd = String(dir);
    fs.symlinkSync("src", path.join(cwd, "linked"), "dir");
    const opts = { cwd, followSymlinks: true, ignore: ["**/node_modules/**", "**/*.test.ts"] };
    expect(scanSync("**/*.ts", opts)).toEqual([
      "linked/index.ts",
      "linked/util/helpers.ts",
      "packages/app/src/main.ts",
      "src/index.ts",
      "src/util/helpers.ts",
    ]);
    expect(scanSync("**/*.ts", { ...opts, ignore: [...opts.ignore, "linked/**"] })).toEqual([
      "packages/app/src/main.ts",
      "src/index.ts",
      "src/util/helpers.ts",
    ]);
  });

  test.each([
    ["**/*", ["**/node_modules/**"]],
    ["**/*", ["dist/**", "**/*.test.ts"]],
    ["**/*.ts", ["**/*.test.ts", "node_modules"]],
    ["**/*", ["packages/*/dist/**", "{dist,node_modules}/**"]],
    ["**/*.js", ["dist/**"]],
    ["src/**", ["src/util/**"]],
  ])("agrees with fast-glob: %s ignoring %j", (pattern, ignore) => {
    using dir = tempDir("glob-ignore", tree);
    const cwd = String(dir);
    const expected = fg.globSync(pattern, { cwd, ignore }).sort();
    expect(expected.length).toBeGreaterThan(0);
    expect(scanSync(pattern, { cwd, ignore })).toEqual(expected);
  });

  test("a ./ in front of the pattern or of an ignore pattern does not count", async () => {
    using dir = tempDir("glob-ignore", tree);
    const cwd = String(dir);
    const expected = ["src/index.test.ts", "src/index.ts", "src/util/helpers.test.ts", "src/util/helpers.ts"];
    const ignore = ["**/node_modules/**", "packages/**"];
    expect(scanSync("**/*.ts", { cwd, ignore })).toEqual(expected);
    // The scan reports `./src/index.ts`, and the patterns are asked about `src/index.ts`.
    expect(scanSync("./**/*.ts", { cwd, ignore })).toEqual(expected.map(it => "./" + it));
    expect(await scan("./**/*.ts", { cwd, ignore })).toEqual(expected.map(it => "./" + it));
    expect(scanSync("././**/*.ts", { cwd, ignore: ["node_modules", "packages"] })).toEqual(
      expected.map(it => "././" + it),
    );
    // A pattern with `./` in front is the pattern without it.
    const dotted = ignore.map(it => "./" + it);
    expect(scanSync("**/*.ts", { cwd, ignore: dotted })).toEqual(expected);
    expect(scanSync("./**/*.ts", { cwd, ignore: dotted })).toEqual(expected.map(it => "./" + it));
    expect(scanSync("**/*.ts", { cwd, ignore: ["././node_modules", "./packages/"] })).toEqual(expected);
    expect(scanSync("./**/*.ts", { cwd, absolute: true, ignore: dotted })).toEqual(
      norm(expected.map(it => path.join(cwd, it))),
    );
    // What follows the `./` starts in the same directory: `.//src` is not `/src`.
    expect(scanSync("**/*.ts", { cwd, ignore: [".//src/util/**", ".///node_modules", "packages"] })).toEqual([
      "src/index.test.ts",
      "src/index.ts",
    ]);
  });

  test("a ! behind a ./ is a character of a name", () => {
    using dir = tempDir("glob-ignore-bang", { "!keep.ts": "", "other.ts": "" });
    const cwd = String(dir);
    expect(scanSync("*.ts", { cwd, ignore: "./!keep.ts" })).toEqual(["other.ts"]);
    expect(scanSync("*.ts", { cwd, ignore: "\\!keep.ts" })).toEqual(["other.ts"]);
    // Without the `./` it negates: what is not `other.ts` is left out.
    expect(scanSync("*.ts", { cwd, ignore: "!other.ts" })).toEqual(["other.ts"]);
  });

  test("a pattern that ends with /* leaves out what is in a directory, and not the directory", () => {
    using dir = tempDir("glob-ignore", tree);
    const cwd = String(dir);
    const top = (ignore: string) => scanSync("*", { cwd, onlyFiles: false, ignore });
    expect(top("dist/*")).toEqual(["dist", "node_modules", "package.json", "packages", "src"]);
    expect(scanSync("**/*.js", { cwd, ignore: "dist/*" })).toEqual([
      "node_modules/dep/dist/index.js",
      "packages/app/dist/main.js",
    ]);
    // These name the directory: a `**`, and a `/` at the end of the pattern or of an alternative.
    for (const ignore of ["dist/**", "dist/", "{dist/,build/}", "@(dist/|build/)"]) {
      expect([ignore, top(ignore)]).toEqual([ignore, ["node_modules", "package.json", "packages", "src"]]);
    }
    // An escaped `/` is not the end of a name.
    expect(top("dist\\/")).toEqual(["dist", "node_modules", "package.json", "packages", "src"]);
  });

  test("a pattern is asked about the normalized path, with absolute and without it", () => {
    using dir = tempDir("glob-ignore-normalized", {
      "project/src/index.ts": "",
      "project/src/index.test.ts": "",
      "project/src/util/helpers.ts": "",
      "other/src/index.ts": "",
      "other/src/index.test.ts": "",
    });
    const cwd = path.join(String(dir), "project");
    const root = cwd.replaceAll("\\", "/");
    // Each path is as `path.resolve()` gives it: without `absolute` a scan spells a path as its pattern does.
    const resolved = (found: string[]) => norm(found.map(it => path.resolve(cwd, it)));
    for (const [pattern, ignore, expected] of [
      ["src/./*.ts", "src/*.test.ts", ["src/index.ts"]],
      ["src/util/../*.ts", "src/*.test.ts", ["src/index.ts"]],
      // It leads back into `cwd`, so the path from `cwd` is `src/index.ts`.
      ["../project/src/*.ts", "src/*.test.ts", ["src/index.ts"]],
      ["../project/src/*.ts", "../project/src/*.test.ts", ["src/index.test.ts", "src/index.ts"]],
      // Another place is not `cwd`.
      ["../other/src/*.ts", "src/**", ["../other/src/index.test.ts", "../other/src/index.ts"]],
      ["../other/src/*.ts", "../other/src/*.test.ts", ["../other/src/index.ts"]],
      // An absolute pattern: the full path.
      [`${root}/src/*.ts`, "src/*.test.ts", ["src/index.test.ts", "src/index.ts"]],
      [`${root}/src/*.ts`, `${root}/src/*.test.ts`, ["src/index.ts"]],
      [`${root}/src/util/../*.ts`, `${root}/src/*.test.ts`, ["src/index.ts"]],
    ] as const) {
      for (const absolute of [false, true]) {
        expect([pattern, ignore, absolute, resolved(scanSync(pattern, { cwd, ignore, absolute }))]).toEqual([
          pattern,
          ignore,
          absolute,
          resolved([...expected]),
        ]);
      }
    }
  });

  test("rejects values that are not patterns", () => {
    using dir = tempDir("glob-ignore", { "a.ts": "" });
    const cwd = String(dir);
    for (const ignore of [123, true, {}, [1], ["a", null]]) {
      // @ts-expect-error
      expect(() => new Glob("*").scanSync({ cwd, ignore })).toThrow("GlobScanOptions.ignore");
      // @ts-expect-error
      expect(() => new Glob("*").scan({ cwd, ignore })).toThrow("GlobScanOptions.ignore");
    }
    expect(scanSync("*", { cwd, ignore: [] })).toEqual(["a.ts"]);
    expect(scanSync("*", { cwd, ignore: undefined })).toEqual(["a.ts"]);
  });
});

describe("a list of patterns", () => {
  const norm = (a: string[]) => a.map(p => p.replaceAll("\\", "/")).sort();
  const tree = {
    "package.json": "{}",
    "README.md": "",
    "src/index.ts": "",
    "src/index.test.ts": "",
    "src/util/helpers.ts": "",
    "src/util/data.json": "{}",
    "test/setup.ts": "",
    "node_modules/dep/index.ts": "",
    "node_modules/dep/package.json": "{}",
  };
  const scanSync = (patterns: string | string[], opts: GlobScanOptions) =>
    norm(Array.from(new Glob(patterns).scanSync(opts)));
  const scan = async (patterns: string | string[], opts: GlobScanOptions) =>
    norm(await Array.fromAsync(new Glob(patterns).scan(opts)));

  test("finds what any of its patterns finds, each path once", async () => {
    using dir = tempDir("glob-list", tree);
    const cwd = String(dir);
    // The list of https://github.com/oven-sh/bun/issues/9470.
    const expected = [
      "node_modules/dep/index.ts",
      "package.json",
      "src/index.test.ts",
      "src/index.ts",
      "src/util/helpers.ts",
      "test/setup.ts",
    ];
    expect(scanSync(["**/*.ts", "package.json"], { cwd })).toEqual(expected);
    expect(await scan(["**/*.ts", "package.json"], { cwd })).toEqual(expected);
    expect(scanSync(["package.json", "**/*.ts"], { cwd })).toEqual(expected);

    // Four patterns find src/index.ts.
    const overlapping = ["src/**", "**/*.ts", "src/index.ts", "src/*.ts", "**/index.ts"];
    const found = Array.from(new Glob(overlapping).scanSync({ cwd }));
    expect(new Set(found).size).toBe(found.length);
    expect(norm(found)).toEqual([
      "node_modules/dep/index.ts",
      "src/index.test.ts",
      "src/index.ts",
      "src/util/data.json",
      "src/util/helpers.ts",
      "test/setup.ts",
    ]);
    expect(await scan(overlapping, { cwd })).toEqual(norm(found));

    // A list of one pattern is that pattern.
    expect(scanSync(["src/*.ts"], { cwd })).toEqual(scanSync("src/*.ts", { cwd }));
    expect(scanSync(["src/*.ts", "src/*.ts"], { cwd })).toEqual(scanSync("src/*.ts", { cwd }));
  });

  test("takes the options of a scan", async () => {
    using dir = tempDir("glob-list-options", { ...tree, ".env": "", "src/.cache/tmp.ts": "" });
    const cwd = String(dir);
    const list = ["src/**/*.ts", "*", "node_modules/*"];

    expect(scanSync(list, { cwd })).toEqual([
      "README.md",
      "package.json",
      "src/index.test.ts",
      "src/index.ts",
      "src/util/helpers.ts",
    ]);
    // The folder as a string.
    expect(norm(Array.from(new Glob(list).scanSync(cwd)))).toEqual(scanSync(list, { cwd }));
    expect(norm(await Array.fromAsync(new Glob(list).scan(cwd)))).toEqual(scanSync(list, { cwd }));

    expect(scanSync(list, { cwd, dot: true })).toEqual([
      ".env",
      "README.md",
      "package.json",
      "src/.cache/tmp.ts",
      "src/index.test.ts",
      "src/index.ts",
      "src/util/helpers.ts",
    ]);
    expect(scanSync(list, { cwd, onlyFiles: false })).toEqual([
      "README.md",
      "node_modules",
      "node_modules/dep",
      "package.json",
      "src",
      "src/index.test.ts",
      "src/index.ts",
      "src/util/helpers.ts",
      "test",
    ]);
    const absolute = ["README.md", "package.json", "src/index.test.ts", "src/index.ts", "src/util/helpers.ts"];
    expect(scanSync(list, { cwd, absolute: true })).toEqual(norm(absolute.map(it => path.join(cwd, it))));
    expect(await scan(list, { cwd, absolute: true })).toEqual(norm(absolute.map(it => path.join(cwd, it))));
    expect(scanSync(list, { cwd, ignore: ["**/*.test.ts", "README.md"] })).toEqual([
      "package.json",
      "src/index.ts",
      "src/util/helpers.ts",
    ]);
  });

  test.skipIf(!canCreateDirSymlink)("follows links as a scan for one pattern does", () => {
    using dir = tempDir("glob-list-links", tree);
    const cwd = String(dir);
    fs.symlinkSync("src", path.join(cwd, "linked"), "dir");
    const list = ["**/*.json", "linked/*.ts", "*"];
    // `linked` is named by one pattern, which goes through it. `*` finds the link, which is no file.
    expect(scanSync(list, { cwd })).toEqual([
      "README.md",
      "linked/index.test.ts",
      "linked/index.ts",
      "node_modules/dep/package.json",
      "package.json",
      "src/util/data.json",
    ]);
    expect(scanSync(list, { cwd, onlyFiles: false })).toEqual([
      "README.md",
      "linked",
      "linked/index.test.ts",
      "linked/index.ts",
      "node_modules",
      "node_modules/dep/package.json",
      "package.json",
      "src",
      "src/util/data.json",
      "test",
    ]);
    expect(scanSync(list, { cwd, followSymlinks: true })).toEqual([
      "README.md",
      "linked/index.test.ts",
      "linked/index.ts",
      "linked/util/data.json",
      "node_modules/dep/package.json",
      "package.json",
      "src/util/data.json",
    ]);
  });

  test("an entry that starts with ! leaves out what it matches", async () => {
    using dir = tempDir("glob-list-negated", tree);
    const cwd = String(dir);
    const expected = ["src/index.ts", "src/util/helpers.ts", "test/setup.ts"];
    const list = ["**/*.ts", "!**/node_modules/**", "!**/*.test.ts"];
    expect(scanSync(list, { cwd })).toEqual(expected);
    expect(await scan(list, { cwd })).toEqual(expected);
    // It is the `ignore` option, written in the list.
    expect(scanSync("**/*.ts", { cwd, ignore: ["**/node_modules/**", "**/*.test.ts"] })).toEqual(expected);
    // Where it stands in the list does not matter: it also leaves out what a later entry names.
    expect(scanSync(["!**/*.test.ts", "!**/node_modules/**", "**/*.ts"], { cwd })).toEqual(expected);
    expect(scanSync(["**/*.ts", "!src/**", "src/index.ts"], { cwd })).toEqual([
      "node_modules/dep/index.ts",
      "test/setup.ts",
    ]);
    // With several patterns that match, and with the option as well.
    expect(scanSync(["**/*.ts", "**/*.json", "!**/node_modules/**"], { cwd, ignore: "src/util" })).toEqual([
      "package.json",
      "src/index.test.ts",
      "src/index.ts",
      "test/setup.ts",
    ]);
    // An odd number of `!` leaves out, an even number does not.
    expect(scanSync(["src/*.ts", "!!!src/*.test.ts"], { cwd })).toEqual(["src/index.ts"]);
    expect(scanSync(["test/*", "!!src/*.test.ts"], { cwd })).toEqual(["src/index.test.ts", "test/setup.ts"]);
    // An even number is no part of the pattern: the `**` finds what it finds without it.
    expect(scanSync(["!!**/*.test.ts", "test/*"], { cwd })).toEqual(scanSync(["**/*.test.ts", "test/*"], { cwd }));
    expect(scanSync(["!!**/*.json", "!node_modules"], { cwd })).toEqual(["package.json", "src/util/data.json"]);
    expect(scanSync([`!!../${path.basename(cwd)}/src/*.ts`], { cwd }).length).toBe(2);
    // `!(` starts a group.
    expect(scanSync(["src/!(index).ts", "test/*"], { cwd })).toEqual(["src/index.test.ts", "test/setup.ts"]);
  });

  // A broken link in a directory that is entered makes this walk throw.
  test.skipIf(isWindows)("a directory that an entry with ! matches is not entered", async () => {
    using dir = tempDir("glob-list-negated", tree);
    const cwd = String(dir);
    fs.symlinkSync("missing", path.join(cwd, "node_modules", "broken"));
    const opts = { cwd, followSymlinks: true, throwErrorOnBrokenSymlink: true } satisfies GlobScanOptions;
    expect(() => scanSync(["**/*.ts", "**/*.json"], opts)).toThrow(expect.objectContaining({ code: "ENOENT" }));

    const expected = ["package.json", "src/index.test.ts", "src/index.ts", "src/util/data.json", "test/setup.ts"];
    expect(scanSync(["**/*.ts", "**/*.json", "!node_modules"], opts)).toEqual(
      expected.concat("src/util/helpers.ts").sort(),
    );
    expect(await scan(["**/*.ts", "**/*.json", "!**/node_modules/**", "!**/helpers.*"], opts)).toEqual(expected);
  });

  test("a list without a pattern that matches finds nothing and reads nothing", async () => {
    using dir = tempDir("glob-list-empty", tree);
    const cwd = String(dir);
    const missing = path.join(cwd, "does-not-exist");
    for (const list of [[], ["!**/*.ts"], ["!a", "!b"]]) {
      expect(scanSync(list, { cwd })).toEqual([]);
      expect(await scan(list, { cwd })).toEqual([]);
      // A scan that opened `cwd` would throw.
      expect(scanSync(list, { cwd: missing })).toEqual([]);
      expect(await scan(list, { cwd: missing })).toEqual([]);
    }
    // As a string, `!` in front is not an entry of a list.
    expect(scanSync(["!src/**"], { cwd })).not.toEqual(scanSync("!src/**", { cwd }));
    expect(scanSync([""], { cwd })).toEqual([]);
    expect(scanSync(["", "package.json", ""], { cwd })).toEqual(["package.json"]);
  });

  test("a ./ in front of an entry does not count", async () => {
    using dir = tempDir("glob-list-dot-slash", tree);
    const cwd = String(dir);
    const sources = ["src/index.test.ts", "src/index.ts"];

    // One file is one path, however its entries spell it.
    expect(scanSync(["./src/*.ts", "src/*.ts", "././src/*.ts"], { cwd })).toEqual(sources);
    expect(await scan(["./src/*.ts", "src/*.ts"], { cwd })).toEqual(sources);
    expect(scanSync(["./src/*.ts", "./*.json", "./**/*.md"], { cwd })).toEqual([
      "README.md",
      "package.json",
      ...sources,
    ]);
    // Also in a list of one entry. As a string, the pattern is spelled in the paths.
    expect(scanSync(["./src/*.ts"], { cwd })).toEqual(sources);
    expect(scanSync("./src/*.ts", { cwd })).toEqual(sources.map(it => "./" + it));

    // An entry with `!` leaves out the same paths with `./` and without it, on either side.
    for (const list of [
      ["**/*.ts", "!src/**", "!node_modules"],
      ["./**/*.ts", "!src/**", "!node_modules"],
      ["**/*.ts", "!./src/**", "!./node_modules"],
      ["./**/*.ts", "!./src/**", "!././node_modules/"],
    ]) {
      expect(scanSync(list, { cwd })).toEqual(["test/setup.ts"]);
      expect(scanSync(list, { cwd, absolute: true })).toEqual([path.join(cwd, "test/setup.ts").replaceAll("\\", "/")]);
    }
    // The same with the `ignore` option beside the list, also an empty one.
    expect(scanSync(["./**/*.ts", "!node_modules"], { cwd, ignore: ["./src/util", "**/*.test.ts"] })).toEqual([
      "src/index.ts",
      "test/setup.ts",
    ]);
    expect(scanSync(["./**/*.ts", "!node_modules", "!src"], { cwd, ignore: [] })).toEqual(["test/setup.ts"]);

    // What follows the `./` starts in the same directory: `.//src` is not `/src`.
    expect(scanSync([".//src/*.ts"], { cwd })).toEqual(sources);
    expect(scanSync([".//src/*.ts", "src/*.ts", "!.//src/*.test.ts"], { cwd })).toEqual(["src/index.ts"]);
    // `./` alone is the directory, as the string is.
    expect(scanSync(["./"], { cwd, onlyFiles: false })).toEqual(scanSync("./", { cwd, onlyFiles: false }));
  });

  test("a ! behind a ./ is a character of a name", () => {
    using dir = tempDir("glob-list-bang", { "!keep.ts": "", "other.ts": "" });
    const cwd = String(dir);
    expect(scanSync(["./!*.ts"], { cwd })).toEqual(["!keep.ts"]);
    expect(scanSync(["*.ts", "!./!*.ts"], { cwd })).toEqual(["other.ts"]);
  });

  test("a pattern starts where it says", async () => {
    using dir = tempDir("glob-list-starts", tree);
    const cwd = String(dir);
    const name = path.basename(cwd);
    const root = cwd.replaceAll("\\", "/");

    // `..` is another directory, and stays in the path.
    expect(scanSync([`../${name}/test/*`, `../${name}/*.json`, "test/*"], { cwd })).toEqual([
      `../${name}/package.json`,
      `../${name}/test/setup.ts`,
      "test/setup.ts",
    ]);
    expect(scanSync(["src/util/../*.ts", "src/util/*.json"], { cwd })).toEqual([
      "src/util/../index.test.ts",
      "src/util/../index.ts",
      "src/util/data.json",
    ]);
    // An absolute pattern does not look at `cwd`.
    expect(scanSync([`${root}/src/*.ts`, `${root}/*.json`, "test/*"], { cwd })).toEqual(
      norm([`${root}/src/index.test.ts`, `${root}/src/index.ts`, `${root}/package.json`, "test/setup.ts"]),
    );
    expect(await scan([`${root}/src/*.ts`, "src/*.ts"], { cwd })).toEqual(
      norm([`${root}/src/index.test.ts`, `${root}/src/index.ts`, "src/index.test.ts", "src/index.ts"]),
    );
    // With `absolute` the two spell a path the same way, and it is there once.
    expect(scanSync([`${root}/src/*.ts`, "src/*.ts"], { cwd, absolute: true })).toEqual(
      scanSync("src/*.ts", { cwd, absolute: true }),
    );
    // An entry with `!` is asked about the full path for an absolute pattern, and about the normalized path from
    // `cwd` for another one.
    expect(scanSync([`${root}/src/*.ts`, "src/*.ts", "!src/**"], { cwd })).toEqual(
      norm([`${root}/src/index.test.ts`, `${root}/src/index.ts`]),
    );
    expect(scanSync([`../${name}/src/*.ts`, "src/*.ts", "!src/*.test.ts"], { cwd })).toEqual([
      `../${name}/src/index.ts`,
      "src/index.ts",
    ]);
  });

  test("absolute does not change what a list leaves out", () => {
    using dir = tempDir("glob-list-absolute", tree);
    const cwd = String(dir);
    const name = path.basename(cwd);
    const root = cwd.replaceAll("\\", "/");
    const resolved = (found: string[]) => norm(found.map(it => path.resolve(cwd, it)));
    for (const list of [
      ["**/*.ts", "!src/**", "!node_modules"],
      [`../${name}/src/*.ts`, "test/*", "!src/*.test.ts"],
      ["src/./*.ts", "src/util/../*.ts", "!src/*.test.ts"],
      [`${root}/src/*.ts`, "test/*", `!${root}/src/*.test.ts`],
      [`${root}/src/*.ts`, "src/*.ts", "!src/*.test.ts"],
    ]) {
      const found = scanSync(list, { cwd });
      expect(found.length).toBeGreaterThan(0);
      expect([list, [...new Set(resolved(scanSync(list, { cwd, absolute: true })))]]).toEqual([
        list,
        [...new Set(resolved(found))],
      ]);
    }
  });

  test.each([
    [["**/*.ts", "package.json"]],
    [["**/*.ts", "**/*.json", "**/*.md"]],
    [["src/**", "test/**", "*.md"]],
    [["**/*.ts", "!**/*.test.ts"]],
    [["**/*", "!**/node_modules/**", "!src/util/**"]],
    [["src/**/*.ts", "!**/util/**", "**/*.json", "!node_modules"]],
    [["{src,test}/**/*.ts", "node_modules/*/package.json", "!**/index.*"]],
    [["./**/*.ts", "!src/**"]],
    [["**/*.ts", "!./src/**"]],
    [["./**/*.ts", "./**/*.json", "!./node_modules/**", "!**/*.test.ts"]],
  ])("agrees with fast-glob: %j", list => {
    using dir = tempDir("glob-list-fg", tree);
    const cwd = String(dir);
    // fast-glob keeps the `./` of a pattern in the paths.
    const expected = fg
      .globSync(list, { cwd })
      .map(it => it.replace(/^\.\//, ""))
      .sort();
    expect(expected.length).toBeGreaterThan(0);
    expect(scanSync(list, { cwd })).toEqual(expected);
  });

  test("a scan that cannot start throws", async () => {
    using dir = tempDir("glob-list-throws", tree);
    const cwd = String(dir);
    const nullByteError = expect.objectContaining({
      code: "ERR_INVALID_ARG_VALUE",
      message: expect.stringContaining("'pattern' must be a string without null bytes"),
    });
    for (const list of [["*.ts", "a\0b"], ["a\0b", "*.ts"], ["*.ts", "!a\0b"], ["!a\0b"]]) {
      expect(() => new Glob(list).scanSync({ cwd })).toThrow(nullByteError);
      // Also for `scan`, at the call and not as a rejection.
      expect(() => new Glob(list).scan({ cwd })).toThrow(nullByteError);
    }

    const missing = path.join(cwd, "does-not-exist");
    const list = ["*.ts", "**/*.json"];
    expect(() => Array.from(new Glob(list).scanSync({ cwd: missing }))).toThrow(
      expect.objectContaining({ code: "ENOENT" }),
    );
    expect(Array.fromAsync(new Glob(list).scan({ cwd: missing }))).rejects.toMatchObject({ code: "ENOENT" });
    // @ts-expect-error
    expect(() => new Glob(list).scanSync(5)).toThrow("GlobScanOptions must be an object");

    // One pattern that cannot start fails the scan, also where the others find something.
    const gone = `${missing.replaceAll("\\", "/")}/*.ts`;
    expect(() => Array.from(new Glob(gone).scanSync({ cwd }))).toThrow(expect.objectContaining({ code: "ENOENT" }));
    expect(() => Array.from(new Glob(["*.json", gone]).scanSync({ cwd }))).toThrow(
      expect.objectContaining({ code: "ENOENT" }),
    );
    expect(Array.fromAsync(new Glob([gone, "*.json"]).scan({ cwd }))).rejects.toMatchObject({ code: "ENOENT" });
  });

  // https://github.com/oven-sh/bun/issues/32596: the walker cuts a pattern at every separator, also inside a group.
  // `match()` knows the group, so an entry with `!` that has one works.
  test.failing("a group with a separator in it scans what it matches", () => {
    using dir = tempDir("glob-list-group", tree);
    const cwd = String(dir);
    const glob = new Glob(["{src/*.ts,package.json}", "README.md"]);
    expect(glob.match("src/index.ts")).toBe(true);
    expect(norm(Array.from(glob.scanSync({ cwd })))).toEqual([
      "README.md",
      "package.json",
      "src/index.test.ts",
      "src/index.ts",
    ]);
  });

  test("a group with a separator in it leaves out what it matches", () => {
    using dir = tempDir("glob-list-group", tree);
    const cwd = String(dir);
    expect(
      scanSync(["**/*.ts", "**/*.json", "!{src/util/**,node_modules}", "!@(src|test)/*.test.ts"], { cwd }),
    ).toEqual(["package.json", "src/index.ts", "test/setup.ts"]);
  });

  test("scans at the same time, with a collection in between", async () => {
    using dir = tempDir("glob-list-concurrent", tree);
    const cwd = String(dir);
    const lists = [
      ["**/*.ts", "package.json"],
      ["**/*.json", "**/*.md", "!**/node_modules/**"],
      ["src/**", "./test/*"],
    ];
    const expected = lists.map(list => scanSync(list, { cwd }));
    const running = Array.from({ length: 12 }, (_, i) => scan(lists[i % lists.length], { cwd }));
    Bun.gc(true);
    const found = await Promise.all(running);
    Bun.gc(true);
    for (let i = 0; i < found.length; i++) expect(found[i]).toEqual(expected[i % lists.length]);
  });

  // A scan of a list has to find what the scans for its patterns find one by one, whatever a pattern does on its
  // own: answer without a listing, follow a link that another one only names, or change the directory.
  describe("finds what the scans for each of its patterns find", () => {
    let dir: ReturnType<typeof tempDir>;
    let cwd: string;
    let socket: { stop(): void } | undefined;
    let patterns: string[];
    beforeAll(() => {
      dir = tempDir("glob-list-union", {
        ...tree,
        "a.ts": "",
        ".hidden.ts": "",
        ".dot/f.ts": "",
        ".dot/inner/g.ts": "",
        "src/util/.secret.ts": "",
        "src/util/deep/x.ts": "",
        "links/keep.ts": "",
      });
      cwd = String(dir);
      if (canCreateDirSymlink) {
        fs.symlinkSync(path.join("..", "a.ts"), path.join(cwd, "links", "file"), "file");
        fs.symlinkSync(path.join("..", "src"), path.join(cwd, "links", "dir"), "dir");
        fs.symlinkSync("missing", path.join(cwd, "links", "broken"), "file");
        fs.symlinkSync("..", path.join(cwd, "links", "loop"), "dir");
        // Nothing follows it unless `dot` is set.
        fs.symlinkSync("missing", path.join(cwd, "src", "util", ".gone"), "file");
      }
      // A socket is neither a file nor a directory: a pattern that names it finds it, a listing does not.
      if (!isWindows) socket = Bun.listen({ unix: path.join(cwd, "sock"), socket: { data() {} } });

      const name = path.basename(cwd);
      const root = cwd.replaceAll("\\", "/");
      patterns = [
        "**/*.ts",
        "**/*.json",
        "*",
        "src/**",
        "src/*.ts",
        "**/util/**",
        "**/util",
        "package.json",
        "src/index.ts",
        "sock",
        "nope",
        "links/file",
        "links/dir",
        "links/broken",
        "links/*",
        "links/**",
        "links/dir/*.ts",
        "links/loop/src/*.ts",
        "*/dir/*.ts",
        "src/util/../*.ts",
        "src/./index.ts",
        "./**/*.ts",
        "./src/*.ts",
        "./package.json",
        "././src/*.ts",
        `../${name}/src/*.ts`,
        `./../${name}/*.json`,
        ".dot/**",
        ".*",
        "{src,test}/**/*.ts",
        "**/",
        "!(a).ts",
        `${root}/src/*.ts`,
        `${root}/**/*.json`,
        `${root}/package.json`,
        `${root}/src/../a.ts`,
        "",
        ".",
        "src/..",
        "./",
        ".//src/*.ts",
      ];
    });
    afterAll(() => {
      socket?.stop();
      dir?.[Symbol.dispose]();
    });

    type Found = string[] | { code: string };
    const run = (pattern: string | string[], options: GlobScanOptions): Found => {
      try {
        return Array.from(new Glob(pattern).scanSync({ cwd, ...options })).sort();
      } catch (error: any) {
        return { code: error.code };
      }
    };
    // The lists whose scan differs from what their patterns find one by one. In a list, `negated` are entries with
    // `!`. For a pattern alone they are the `ignore` option. A pattern alone is scanned as it is written, and the
    // `./` in front of what it finds is dropped.
    const differing = (lists: number[][], options: GlobScanOptions, negated: string[] = []) => {
      const ignore = [options.ignore ?? [], negated].flat();
      const alone = new Map<number, Found>();
      return lists.flatMap(list => {
        const union = new Set<string>();
        let expected: Found | undefined;
        for (const index of list) {
          if (!alone.has(index)) {
            const found = run(patterns[index], { ...options, ignore });
            alone.set(index, Array.isArray(found) ? found.map(it => it.replace(/^(\.[\\/]+)+(?=.)/, "")) : found);
          }
          const found = alone.get(index)!;
          // What one pattern throws, the list throws.
          if (!Array.isArray(found)) expected ??= found;
          else for (const it of found) union.add(it);
        }
        expected ??= [...union].sort();
        const entries = [...list.map(index => patterns[index]), ...negated.map(it => "!" + it)];
        const found = run(entries, options);
        return Bun.deepEquals(found, expected) ? [] : [{ list: entries, found, expected }];
      });
    };

    test.each<[GlobScanOptions, string[]]>([
      [{}, []],
      [{ onlyFiles: false }, []],
      [{ followSymlinks: true }, []],
      [{ onlyFiles: false, followSymlinks: true, dot: true, absolute: true }, []],
      [{ followSymlinks: true, throwErrorOnBrokenSymlink: true }, []],
      [{}, ["**/util/**", "./links/loop", "**/*.test.ts"]],
      [{ onlyFiles: false, absolute: true, ignore: ["links/loop"] }, ["src/**", "package.json", "links/dir/"]],
    ])("two patterns, with %j and without %j", (options, negated) => {
      // In both orders: a later pattern does not repeat what an earlier one found.
      const pairs: number[][] = [];
      for (let i = 0; i < patterns.length; i++) {
        for (let j = 0; j < patterns.length; j++) if (i !== j) pairs.push([i, j]);
      }
      expect(pairs.length).toBe(41 * 40);
      expect(differing(pairs, options, negated).slice(0, 5)).toEqual([]);
      // The patterns alone find something in this tree.
      expect(run("src/*.ts", options)).toContainEqual(expect.stringContaining("index.ts"));
    });

    test("longer lists", () => {
      let seed = 9470;
      const random = (below: number) => {
        seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
        return seed % below;
      };
      for (const [options, negated] of [
        [{}, []],
        [{ onlyFiles: false }, ["**/deep", "links/**"]],
        [{ followSymlinks: true, dot: true }, []],
        [{ absolute: true }, ["**/*.json", "./src/util/"]],
      ] as [GlobScanOptions, string[]][]) {
        const lists = Array.from({ length: 100 }, (_, round) =>
          Array.from({ length: round % 10 === 0 ? 60 + random(60) : 3 + random(6) }, () => random(patterns.length)),
        );
        expect(differing(lists, options, negated).slice(0, 5)).toEqual([]);
      }
    });
  });
});
