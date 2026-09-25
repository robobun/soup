import { file, spawn, write } from "bun";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readlinkSync } from "fs";
import { access, copyFile, cp, exists, open, realpath, rm, writeFile } from "fs/promises";
import {
  bunExe,
  bunEnv as env,
  isWindows,
  normalizeBunSnapshot,
  readdirSorted,
  runBunInstall,
  tempDir,
  toBeValidBin,
  VerdaccioRegistry,
} from "harness";
import { join } from "path";

expect.extend({
  toBeValidBin,
});

var registry = new VerdaccioRegistry();

beforeAll(async () => {
  await registry.start();
});

afterAll(() => {
  registry.stop();
});

it("should write plaintext lockfiles", async () => {
  const { packageDir, packageJson } = await registry.createTestDir();
  // copy bar-0.0.2.tgz to package_dir
  await copyFile(join(__dirname, "bar-0.0.2.tgz"), join(packageDir, "bar-0.0.2.tgz"));

  // Create a simple package.json
  await writeFile(
    packageJson,
    JSON.stringify({
      name: "test-package",
      version: "1.0.0",
      dependencies: {
        "dummy-package": "file:./bar-0.0.2.tgz",
      },
    }),
  );

  // Run 'bun install' to generate the lockfile
  const installResult = spawn({
    cmd: [bunExe(), "install", "--save-text-lockfile"],
    cwd: packageDir,
    env,
  });
  await installResult.exited;

  // Ensure the lockfile was created
  await access(join(packageDir, "bun.lock"));

  // Assert that the lockfile has the correct permissions
  await using file = await open(join(packageDir, "bun.lock"), "r");
  const stat = await file.stat();

  // in unix, 0o644 == 33188
  let mode = 33188;
  // ..but windows is different
  if (isWindows) {
    mode = 33206;
  }
  expect(stat.mode).toBe(mode);

  expect(await file.readFile({ encoding: "utf8" })).toMatchSnapshot();
});

// won't work on windows, " is not a valid character in a filename
it.skipIf(isWindows)("should escape names", async () => {
  const { packageDir, packageJson } = await registry.createTestDir();
  await Promise.all([
    write(
      packageJson,
      JSON.stringify({
        name: "quote-in-dependency-name",
        workspaces: ["packages/*"],
      }),
    ),
    write(join(packageDir, "packages", '"', "package.json"), JSON.stringify({ name: '"' })),
    write(
      join(packageDir, "packages", "pkg1", "package.json"),
      JSON.stringify({
        name: "pkg1",
        dependencies: {
          '"': "*",
        },
      }),
    ),
  ]);

  const { exited } = spawn({
    cmd: [bunExe(), "install", "--save-text-lockfile"],
    cwd: packageDir,
    stdout: "ignore",
    stderr: "ignore",
    env,
  });

  expect(await exited).toBe(0);

  expect(await file(join(packageDir, "bun.lock")).text()).toMatchSnapshot();
});

it("should be the default save format", async () => {
  const { packageDir, packageJson } = await registry.createTestDir();

  await write(
    packageJson,
    JSON.stringify({
      name: "jquery-4",
      version: "4.0.0",
      dependencies: {
        "no-deps": "1.0.0",
      },
    }),
  );

  await runBunInstall(env, packageDir);
  expect(await exists(join(packageDir, "bun.lockb"))).toBe(false);
  expect(
    (await file(join(packageDir, "bun.lock")).text()).replaceAll(/localhost:\d+/g, "localhost:1234"),
  ).toMatchSnapshot();

  // adding a package will add to the text lockfile
  await runBunInstall(env, packageDir, { packages: ["a-dep"] });
  expect(await exists(join(packageDir, "bun.lockb"))).toBe(false);
  expect(
    (await file(join(packageDir, "bun.lock")).text()).replaceAll(/localhost:\d+/g, "localhost:1234"),
  ).toMatchSnapshot();
});

it("should save the lockfile if --save-text-lockfile and --frozen-lockfile are used", async () => {
  const { packageDir, packageJson } = await registry.createTestDir({ bunfigOpts: { saveTextLockfile: false } });
  await Promise.all([
    write(packageJson, JSON.stringify({ name: "test-pkg", version: "1.0.0", dependencies: { "no-deps": "1.0.0" } })),
  ]);

  async function checkLockfiles() {
    return await Promise.all([exists(join(packageDir, "bun.lock")), exists(join(packageDir, "bun.lockb"))]);
  }

  // save a binary lockfile
  await runBunInstall(env, packageDir, {});
  expect(await checkLockfiles()).toEqual([false, true]);

  // --save-text-lockfile with --frozen-lockfile
  await runBunInstall(env, packageDir, { saveTextLockfile: true, frozenLockfile: true });
  expect(await checkLockfiles()).toEqual([true, false]);
  const firstLockfile = (await file(join(packageDir, "bun.lock")).text()).replaceAll(
    /localhost:\d+/g,
    "localhost:1234",
  );
  expect(firstLockfile).toMatchSnapshot();

  // adding a package without --save-text-lockfile will continue to use the text lockfile
  await runBunInstall(env, packageDir, { packages: ["a-dep"] });

  expect(await checkLockfiles()).toEqual([true, false]);
  const secondLockfile = (await file(join(packageDir, "bun.lock")).text()).replaceAll(
    /localhost:\d+/g,
    "localhost:1234",
  );
  expect(firstLockfile).not.toBe(secondLockfile);
  expect(secondLockfile).toMatchSnapshot();
});

it("should convert a binary lockfile with invalid optional peers", async () => {
  const { packageDir, packageJson } = await registry.createTestDir({ bunfigOpts: { npm: true } });
  await Promise.all([
    write(
      packageJson,
      JSON.stringify({
        name: "pkg1",
        dependencies: {
          "langchain": "^0.0.194",
        },
      }),
    ),
    cp(join(import.meta.dir, "fixtures", "invalid-optional-peer.lockb"), join(packageDir, "bun.lockb")),
  ]);

  let { exited, stdout, stderr } = spawn({
    cmd: [bunExe(), "install", "--save-text-lockfile", "--lockfile-only"],
    cwd: packageDir,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  let [out, err] = await Promise.all([stdout.text(), stderr.text()]);
  expect(err).toContain("Saved lockfile");
  expect(out).toContain("Saved bun.lock (69 packages)");

  expect(await exited).toBe(0);

  const [firstLockfile, lockbExists] = await Promise.all([
    await file(join(packageDir, "bun.lock")).text(),
    exists(join(packageDir, "bun.lockb")),
  ]);

  expect(firstLockfile).toMatchSnapshot();
  expect(lockbExists).toBeFalse();

  // running again should not change the lockfile
  ({ exited, stdout, stderr } = spawn({
    cmd: [bunExe(), "install", "--lockfile-only"],
    cwd: packageDir,
    env,
    stdout: "pipe",
    stderr: "pipe",
  }));

  [out, err] = await Promise.all([stdout.text(), stderr.text()]);
  expect(err).not.toContain("Saved lockfile");
  expect(out).toContain("Done! Checked 69 packages (no changes)");

  expect(await exited).toBe(0);
  expect(await file(join(packageDir, "bun.lock")).text()).toBe(firstLockfile);
});

it("should not deduplicate bundled packages with un-bundled packages", async () => {
  const { packageDir, packageJson } = await registry.createTestDir();

  await Promise.all([
    write(
      packageJson,
      JSON.stringify({
        name: "bundled-deps",
        dependencies: {
          "debug-1": "4.4.0",
          "npm-1": "10.9.2",
        },
      }),
    ),
  ]);

  let { exited, stdout } = spawn({
    cmd: [bunExe(), "install"],
    cwd: packageDir,
    env,
    stdout: "pipe",
    stderr: "inherit",
  });

  expect(await exited).toBe(0);

  async function checkModules() {
    expect(await readdirSorted(join(packageDir, "node_modules"))).toEqual(["debug-1", "ms-1", "npm-1"]);
  }

  await checkModules();

  const out1 = (await stdout.text())
    .replaceAll(/\s*\[[0-9\.]+m?s\]\s*$/g, "")
    .split(/\r?\n/)
    .slice(1);
  expect(out1).toMatchSnapshot();

  await rm(join(packageDir, "node_modules"), { recursive: true, force: true });

  // running install again will install all packages to node_modules
  ({ exited, stdout } = spawn({
    cmd: [bunExe(), "install"],
    cwd: packageDir,
    env,
    stdout: "pipe",
    stderr: "inherit",
  }));

  expect(await exited).toBe(0);

  await checkModules();
  const out2 = (await stdout.text())
    .replaceAll(/\s*\[[0-9\.]+m?s\]\s*$/g, "")
    .split(/\r?\n/)
    .slice(1);
  expect(out2).toEqual(out1);

  // force saving a lockfile does not increase the number of packages
  ({ exited, stdout } = spawn({
    cmd: [bunExe(), "install", "--lockfile-only"],
    cwd: packageDir,
    env,
    stdout: "pipe",
    stderr: "inherit",
  }));

  expect(await exited).toBe(0);

  await checkModules();
  const out3 = (await stdout.text())
    .replaceAll(/\s*\[[0-9\.]+m?s\]\s*$/g, "")
    .split(/\r?\n/)
    .slice(1);

  ({ exited, stdout } = spawn({
    cmd: [bunExe(), "install", "--lockfile-only"],
    cwd: packageDir,
    env,
    stdout: "pipe",
    stderr: "inherit",
  }));

  expect(await exited).toBe(0);
  await checkModules();

  const out4 = (await stdout.text())
    .replaceAll(/\s*\[[0-9\.]+m?s\]\s*$/g, "")
    .split(/\r?\n/)
    .slice(1);
  expect(out4).toEqual(out3);

  expect(out4).toMatchSnapshot();

  await rm(join(packageDir, "node_modules"), { recursive: true, force: true });

  // --frozen-lockfile is successful
  ({ exited, stdout } = spawn({
    cmd: [bunExe(), "install", "--frozen-lockfile"],
    cwd: packageDir,
    env,
    stdout: "pipe",
    stderr: "inherit",
  }));

  expect(await exited).toBe(0);
  await checkModules();
});

it("should not change formatting unexpectedly", async () => {
  const { packageDir, packageJson } = await registry.createTestDir();

  const patch = `diff --git a/package.json b/package.json
index d156130662798530e852e1afaec5b1c03d429cdc..b4ddf35975a952fdaed99f2b14236519694f850d 100644
--- a/package.json
+++ b/package.json
@@ -1,6 +1,7 @@
 {
     "name": "optional-peer-deps",
     "version": "1.0.0",
+    "hi": true,
     "peerDependencies": {
         "no-deps": "*"
     },
`;

  // attempt to snapshot most things that can be printed
  await Promise.all([
    write(
      packageJson,
      JSON.stringify({
        name: "pkg-root",
        version: "1.0.0",
        workspaces: ["packages/*"],
        scripts: {
          preinstall: "echo 'preinstall'",
        },
        overrides: {
          "hoist-lockfile-shared": "1.0.1",
        },
        bin: "index.js",
        optionalDependencies: {
          "optional-native": "1.0.0",
        },
        devDependencies: {
          "optional-peer-deps": "1.0.0",
        },
        dependencies: {
          "uses-what-bin": "1.0.0",
        },
        trustedDependencies: ["uses-what-bin"],
        patchedDependencies: {
          "optional-peer-deps@1.0.0": "patches/optional-peer-deps@1.0.0.patch",
        },
      }),
    ),
    write(join(packageDir, "patches", "optional-peer-deps@1.0.0.patch"), patch),
    write(join(packageDir, "index.js"), "console.log('hello world')"),
    write(
      join(packageDir, "packages", "pkg1", "package.json"),
      JSON.stringify({
        name: "pkg1",
        version: "2.2.2",
        peerDependenciesMeta: {
          "a-dep": {
            optional: true,
          },
        },
        peerDependencies: {
          "a-dep": "1.0.1",
        },
        dependencies: {
          "bundled-1": "1.0.0",
        },
        bin: {
          "pkg1-1": "bin-1.js",
          "pkg1-2": "bin-2.js",
          "pkg1-3": "bin-3.js",
        },
        scripts: {
          install: "echo 'install'",
          postinstall: "echo 'postinstall'",
        },
      }),
    ),
    write(join(packageDir, "packages", "pkg1", "bin-1.js"), "console.log('bin-1')"),
    write(join(packageDir, "packages", "pkg1", "bin-2.js"), "console.log('bin-2')"),
    write(join(packageDir, "packages", "pkg1", "bin-3.js"), "console.log('bin-3')"),
    write(
      join(packageDir, "packages", "pkg2", "package.json"),
      JSON.stringify({
        name: "pkg2",
        bin: {
          "pkg2-1": "bin-1.js",
        },
        dependencies: {
          "map-bin": "1.0.2",
        },
      }),
    ),
    write(join(packageDir, "packages", "pkg2", "bin-1.js"), "console.log('bin-1')"),
    write(
      join(packageDir, "packages", "pkg3", "package.json"),
      JSON.stringify({
        name: "pkg3",
        directories: {
          bin: "bin",
        },
        devDependencies: {
          "hoist-lockfile-1": "1.0.0",
        },
      }),
    ),
    write(join(packageDir, "packages", "pkg3", "bin", "bin-1.js"), "console.log('bin-1')"),
  ]);

  async function checkInstall() {
    expect(
      await Promise.all([
        exists(join(packageDir, "node_modules", "pkg1", "package.json")),
        exists(join(packageDir, "node_modules", "pkg2", "package.json")),
        exists(join(packageDir, "node_modules", "pkg3", "package.json")),
        file(join(packageDir, "node_modules", "hoist-lockfile-shared", "package.json")).json(),
        exists(join(packageDir, "node_modules", "uses-what-bin", "what-bin.txt")),
        file(join(packageDir, "node_modules", "optional-peer-deps", "package.json")).json(),
      ]),
    ).toMatchObject([true, true, true, { name: "hoist-lockfile-shared", version: "1.0.1" }, true, { hi: true }]);
    expect(join(packageDir, "node_modules", ".bin", "bin-1.js")).toBeValidBin(join("..", "pkg3", "bin", "bin-1.js"));
    expect(join(packageDir, "node_modules", ".bin", "map-bin")).toBeValidBin(join("..", "map-bin", "bin", "map-bin"));
    expect(join(packageDir, "node_modules", ".bin", "map_bin")).toBeValidBin(join("..", "map-bin", "bin", "map-bin"));
    expect(join(packageDir, "node_modules", ".bin", "pkg1-1")).toBeValidBin(join("..", "pkg1", "bin-1.js"));
    expect(join(packageDir, "node_modules", ".bin", "pkg1-2")).toBeValidBin(join("..", "pkg1", "bin-2.js"));
    expect(join(packageDir, "node_modules", ".bin", "pkg1-3")).toBeValidBin(join("..", "pkg1", "bin-3.js"));
    expect(join(packageDir, "node_modules", ".bin", "pkg2-1")).toBeValidBin(join("..", "pkg2", "bin-1.js"));
    expect(join(packageDir, "node_modules", ".bin", "what-bin")).toBeValidBin(join("..", "what-bin", "what-bin.js"));
  }

  let { exited, stdout } = spawn({
    cmd: [bunExe(), "install"],
    cwd: packageDir,
    env,
    stdout: "pipe",
    stderr: "inherit",
  });

  expect(await exited).toBe(0);
  const out1 = (await stdout.text())
    .replaceAll(/\s*\[[0-9\.]+m?s\]\s*$/g, "")
    .split(/\r?\n/)
    .slice(1);
  expect(out1).toMatchInlineSnapshot(`
    [
      "preinstall",
      "",
      "+ optional-peer-deps@1.0.0 (v1.0.1 available)",
      "+ optional-native@1.0.0",
      "+ uses-what-bin@1.0.0 (v1.5.0 available)",
      "",
      "13 packages installed",
    ]
  `);

  await checkInstall();

  const lockfile = (await file(join(packageDir, "bun.lock")).text()).replaceAll(/localhost:\d+/g, "localhost:1234");
  expect(lockfile).toMatchSnapshot();

  await rm(join(packageDir, "node_modules"), { recursive: true, force: true });

  ({ exited, stdout } = spawn({
    cmd: [bunExe(), "install"],
    cwd: join(packageDir, "packages", "pkg1"),
    env,
    stdout: "pipe",
    stderr: "inherit",
  }));

  expect(await exited).toBe(0);
  const out2 = (await stdout.text())
    .replaceAll(/\s*\[[0-9\.]+m?s\]\s*$/g, "")
    .split(/\r?\n/)
    .slice(1);
  expect(out2).toMatchInlineSnapshot(`
    [
      "preinstall",
      "",
      "+ bundled-1@1.0.0",
      "",
      "13 packages installed",
    ]
  `);

  await checkInstall();

  expect((await file(join(packageDir, "bun.lock")).text()).replaceAll(/localhost:\d+/g, "localhost:1234")).toBe(
    lockfile,
  );
});

describe("writes trustedDependencies and patchedDependencies in the order earlier versions wrote them", () => {
  // Neither section is sorted: each is written in the iteration order of the
  // map that collects it, so that order is part of the format. The expected
  // blocks below are what bun 1.3.14 writes for these package.json files.
  // Writing a different order would reorder both sections in every existing
  // bun.lock on the next `bun add`/`bun remove`, and the older version would
  // flip them back. The second shape uses a larger trusted map (13 entries
  // instead of 7) and fills the patched map up to its growth threshold (6 of
  // 8 slots), so a change to how the maps size themselves shows up here too.
  const shapes = [
    {
      trusted: ["esbuild", "sharp", "@prisma/client", "prisma", "bcrypt", "core-js", "@prisma/engines"],
      patched: ["esbuild", "sharp", "prisma", "bcrypt", "core-js"],
      expected: `  "trustedDependencies": [
    "bcrypt",
    "esbuild",
    "sharp",
    "@prisma/engines",
    "@prisma/client",
    "core-js",
    "prisma",
  ],
  "patchedDependencies": {
    "prisma@1.0.0": "patches/prisma.patch",
    "bcrypt@1.0.0": "patches/bcrypt.patch",
    "core-js@1.0.0": "patches/core-js.patch",
    "esbuild@1.0.0": "patches/esbuild.patch",
    "sharp@1.0.0": "patches/sharp.patch",
  },
`,
    },
    {
      trusted: [
        "esbuild",
        "sharp",
        "@prisma/client",
        "prisma",
        "bcrypt",
        "core-js",
        "@prisma/engines",
        "puppeteer",
        "playwright",
        "electron",
        "better-sqlite3",
        "fsevents",
        "@swc/core",
      ],
      patched: ["esbuild", "sharp", "prisma", "bcrypt", "core-js", "puppeteer"],
      expected: `  "trustedDependencies": [
    "bcrypt",
    "@swc/core",
    "core-js",
    "playwright",
    "esbuild",
    "sharp",
    "@prisma/engines",
    "fsevents",
    "@prisma/client",
    "electron",
    "better-sqlite3",
    "prisma",
    "puppeteer",
  ],
  "patchedDependencies": {
    "prisma@1.0.0": "patches/prisma.patch",
    "bcrypt@1.0.0": "patches/bcrypt.patch",
    "core-js@1.0.0": "patches/core-js.patch",
    "esbuild@1.0.0": "patches/esbuild.patch",
    "puppeteer@1.0.0": "patches/puppeteer.patch",
    "sharp@1.0.0": "patches/sharp.patch",
  },
`,
    },
  ];

  const trustedAndPatchedSections = (lockfile: string) =>
    lockfile.slice(lockfile.indexOf('  "trustedDependencies"'), lockfile.indexOf('  "packages"'));

  it.each(shapes)("$trusted.length trusted, $patched.length patched", async ({ trusted, patched, expected }) => {
    const scopes = new Set(trusted.filter(name => name.startsWith("@")).map(name => name.split("/")[0]));
    const files: Record<string, string> = {
      "package.json": JSON.stringify({
        name: "trusted-and-patched-order",
        version: "1.0.0",
        workspaces: ["packages/*", ...Array.from(scopes, scope => `packages/${scope}/*`)],
        trustedDependencies: trusted,
        patchedDependencies: Object.fromEntries(patched.map(name => [`${name}@1.0.0`, `patches/${name}.patch`])),
      }),
    };
    for (const name of trusted) {
      files[`packages/${name}/package.json`] = JSON.stringify({ name, version: "1.0.0" });
    }
    for (const name of patched) {
      files[`patches/${name}.patch`] = `diff --git a/index.js b/index.js
new file mode 100644
index 0000000..e69de29
`;
    }

    const { packageDir } = await registry.createTestDir({ bunfigOpts: { linker: "hoisted" }, files });

    await runBunInstall(env, packageDir);
    expect(trustedAndPatchedSections(await file(join(packageDir, "bun.lock")).text())).toBe(expected);

    // Re-saving the lockfile because something else changed must leave both
    // sections untouched.
    await write(
      join(packageDir, "packages", "left-pad", "package.json"),
      JSON.stringify({ name: "left-pad", version: "1.0.0" }),
    );
    await runBunInstall(env, packageDir);
    const resaved = await file(join(packageDir, "bun.lock")).text();
    expect(resaved).toContain('"left-pad": ["left-pad@workspace:packages/left-pad"]');
    expect(trustedAndPatchedSections(resaved)).toBe(expected);
  });
});

it("should sort overrides before comparing", async () => {
  const { packageDir, packageJson } = await registry.createTestDir();

  const pkg = {
    name: "pkg-with-overrides",
    dependencies: {
      "one-dep": "1.0.0",
      "uses-what-bin": "1.5.0",
    },
    peerDependencies: {
      "what-bin": "1.0.0",
      "no-deps": "2.0.0",
    },
    peerDependenciesMeta: {
      "what-bin": {
        optional: true,
      },
      "no-deps": {
        optional: true,
      },
    },
    resolutions: {
      "what-bin": "1.0.0",
      "no-deps": "2.0.0",
    },
  };

  await write(packageJson, JSON.stringify(pkg));

  await runBunInstall(env, packageDir);

  const lockfile = (await file(join(packageDir, "bun.lock")).text()).replaceAll(/localhost:\d+/g, "localhost:1234");
  expect(lockfile).toMatchSnapshot();
  await runBunInstall(env, packageDir, { frozenLockfile: true });

  // now swap "what-bin" and "no-deps" in resolutions
  pkg.resolutions = {
    "no-deps": "2.0.0",
    "what-bin": "1.0.0",
  };
  await write(packageJson, JSON.stringify(pkg));

  await runBunInstall(env, packageDir, { frozenLockfile: true });

  // --frozen-lockfile was a success. lockfile will be the same as the first
  const secondLockfile = (await file(join(packageDir, "bun.lock")).text()).replaceAll(
    /localhost:\d+/g,
    "localhost:1234",
  );
  expect(secondLockfile).toBe(lockfile);
});

it("should pass frozen lockfile check when a bundled dependency has an optional peer satisfiable from the root", async () => {
  // A bundled dependency's optional peer must not resolve across the bundle
  // hoist root when the lockfile is loaded, otherwise a fresh install and a
  // loaded lockfile disagree about the tree and --frozen-lockfile rejects a
  // lockfile bun itself just wrote (issue #37346).
  const { packageDir, packageJson } = await registry.createTestDir();

  await write(
    packageJson,
    JSON.stringify({
      name: "frozen-bundled-optional-peer",
      dependencies: {
        // bundles `optional-peer-deps`, which has an optional peer on `no-deps`
        "bundled-optional-peer": "1.0.0",
        "no-deps": "1.0.0",
      },
    }),
  );

  await runBunInstall(env, packageDir);
  const lockfile = await file(join(packageDir, "bun.lock")).text();
  expect(lockfile).toContain('"bundled": true');

  await runBunInstall(env, packageDir, { frozenLockfile: true });

  // and from a cold start with no node_modules
  await rm(join(packageDir, "node_modules"), { recursive: true, force: true });
  await runBunInstall(env, packageDir, { frozenLockfile: true });

  expect(await file(join(packageDir, "bun.lock")).text()).toBe(lockfile);
});

it("should include unused resolutions in the lockfile", async () => {
  const { packageDir, packageJson } = await registry.createTestDir();

  // we need to include unused resolutions in order to detect changes from package.json

  const pkg = {
    name: "pkg-with-unused-override",
    dependencies: {
      "one-dep": "1.0.0",
      "uses-what-bin": "1.5.0",
    },
    peerDependencies: {
      "what-bin": "1.0.0",
      "no-deps": "2.0.0",
    },
    peerDependenciesMeta: {
      "what-bin": {
        optional: true,
      },
      "no-deps": {
        optional: true,
      },
    },
    resolutions: {
      "what-bin": "1.0.0",
      "no-deps": "2.0.0",

      // unused resolution
      "jquery": "4.0.0",
    },
  };

  await write(packageJson, JSON.stringify(pkg));

  await runBunInstall(env, packageDir);

  const lockfile = (await file(join(packageDir, "bun.lock")).text()).replaceAll(/localhost:\d+/g, "localhost:1234");
  expect(lockfile).toMatchSnapshot();

  // --frozen-lockfile works
  await runBunInstall(env, packageDir, { frozenLockfile: true });
});

it("requires an integrity hash for an off-registry npm tarball URL at lockfileVersion 2", async () => {
  const { packageDir, packageJson } = await registry.createTestDir();

  // Stand-in for a host that is not the configured registry. Parsing fails
  // before any fetch, so this is never actually contacted.
  let offRegistryRequests = 0;
  await using offRegistry = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      offRegistryRequests++;
      return new Response("not found", { status: 404 });
    },
  });

  await write(
    packageJson,
    JSON.stringify({
      name: "redirected-tarball-url",
      dependencies: {
        "no-deps": "1.0.0",
      },
    }),
  );

  const lockfileWithUrl = (tarballUrl: string) =>
    JSON.stringify({
      lockfileVersion: 2,
      configVersion: 1,
      workspaces: {
        "": {
          name: "redirected-tarball-url",
          dependencies: {
            "no-deps": "1.0.0",
          },
        },
      },
      packages: {
        "no-deps": ["no-deps@1.0.0", tarballUrl, {}, ""],
      },
    });

  // The entry keeps the well-known name and version but points the tarball at a
  // different host and provides no integrity hash. At lockfileVersion 2 this
  // fails closed: parsing rejects it before any fetch. (The v1 backward-compat
  // case — parsing accepts such an entry — is covered in lockfile-version-2.test.ts.)
  await write(
    join(packageDir, "bun.lock"),
    lockfileWithUrl(`http://127.0.0.1:${offRegistry.port}/no-deps/-/no-deps-1.0.0.tgz`),
  );

  let { exited, stdout, stderr } = spawn({
    cmd: [bunExe(), "install", "--frozen-lockfile"],
    cwd: packageDir,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  let [out, err] = await Promise.all([stdout.text(), stderr.text()]);
  expect(err).toContain(
    "Missing integrity hash for npm package resolved to a tarball URL outside the configured registry",
  );
  expect(offRegistryRequests).toBe(0);
  expect(await exists(join(packageDir, "node_modules", "no-deps"))).toBe(false);
  expect(await exited).not.toBe(0);

  // The same entry with the tarball URL *under* the configured registry and no
  // integrity hash is accepted even at v2 (the off-registry gate does not apply,
  // so `npm_url_needs_integrity` is false — registry-hosted tarballs may still
  // omit the hash).
  await write(join(packageDir, "bun.lock"), lockfileWithUrl(`${registry.registryUrl()}no-deps/-/no-deps-1.0.0.tgz`));

  ({ exited, stdout, stderr } = spawn({
    cmd: [bunExe(), "install"],
    cwd: packageDir,
    env,
    stdout: "pipe",
    stderr: "pipe",
  }));

  [out, err] = await Promise.all([stdout.text(), stderr.text()]);
  expect(err).not.toContain("Missing integrity hash");
  expect(offRegistryRequests).toBe(0);
  expect(await exited).toBe(0);
  expect(await file(join(packageDir, "node_modules", "no-deps", "package.json")).json()).toMatchObject({
    name: "no-deps",
    version: "1.0.0",
  });
});

it("escapes double quotes in npm registry tarball URLs when saving bun.lock", async () => {
  const { packageDir, packageJson } = await registry.createTestDir();

  await write(
    packageJson,
    JSON.stringify({
      name: "registry-url-escaping",
      dependencies: {
        "no-deps": "1.0.0",
      },
    }),
  );

  // A registry-controlled tarball URL containing a double quote and JSON syntax.
  // When the lockfile is saved again, the URL must stay confined to its own
  // string value instead of contributing top-level lockfile structure.
  const tarballUrl = `${registry.registryUrl()}no-deps/-/no-deps-1.0.0.tgz?x=", "trustedDependencies": ["no-deps"], "y": "`;

  await write(
    join(packageDir, "bun.lock"),
    JSON.stringify({
      lockfileVersion: 1,
      configVersion: 1,
      workspaces: {
        "": {
          name: "registry-url-escaping",
          dependencies: {
            "no-deps": "1.0.0",
          },
        },
      },
      packages: {
        "no-deps": ["no-deps@1.0.0", tarballUrl, {}, ""],
      },
    }),
  );

  let { exited, stdout, stderr } = spawn({
    cmd: [bunExe(), "install", "--lockfile-only"],
    cwd: packageDir,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  let [out, err] = await Promise.all([stdout.text(), stderr.text()]);
  expect(out).toContain("Saved bun.lock");
  expect(await exited).toBe(0);

  const lockfile = await file(join(packageDir, "bun.lock")).text();

  // The embedded quote is escaped, keeping the URL a single JSON string value.
  expect(lockfile).toContain('?x=\\"');
  expect(lockfile).toContain('\\"trustedDependencies\\"');
  // No top-level key can be forged from the URL contents.
  expect(lockfile).not.toContain('"trustedDependencies":');

  // The saved lockfile still parses and is stable on a subsequent install.
  ({ exited, stdout, stderr } = spawn({
    cmd: [bunExe(), "install", "--lockfile-only"],
    cwd: packageDir,
    env,
    stdout: "pipe",
    stderr: "pipe",
  }));

  [out, err] = await Promise.all([stdout.text(), stderr.text()]);
  expect(err).not.toContain("Saved lockfile");
  expect(out).toContain("Done! Checked");
  expect(await file(join(packageDir, "bun.lock")).text()).toBe(lockfile);
  expect(await exited).toBe(0);
});

// --frozen-lockfile compares the tree built from bun.lock with the tree a clean install
// builds, so an entry nothing depends on (the clean drops it) must not change the
// outcome, wherever it sits in the file. The comparison used to skip the loaded side's
// highest package ids once the clean had dropped an entry, so the entries listed after
// the unused one went missing from the comparison.
it("--frozen-lockfile accepts a bun.lock with an entry nothing depends on, wherever it is listed", async () => {
  const noDeps = { "no-deps": ["no-deps@1.0.0", "", {}, ""] };
  const unused = { "a-dep": ["a-dep@1.0.1", "", {}, ""] };
  for (const packages of [
    { ...unused, ...noDeps },
    { ...noDeps, ...unused },
  ]) {
    const { packageDir, packageJson } = await registry.createTestDir();
    await write(packageJson, JSON.stringify({ name: "foo", dependencies: { "no-deps": "1.0.0" } }));
    const lockfile = JSON.stringify({
      lockfileVersion: 1,
      configVersion: 1,
      workspaces: { "": { name: "foo", dependencies: { "no-deps": "1.0.0" } } },
      packages,
    });
    await write(join(packageDir, "bun.lock"), lockfile);

    await using proc = spawn({
      cmd: [bunExe(), "install", "--frozen-lockfile"],
      cwd: packageDir,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect({ order: Object.keys(packages), err, exitCode }).toEqual({
      order: Object.keys(packages),
      err: expect.not.stringContaining("lockfile had changes"),
      exitCode: 0,
    });
    expect(out).toContain("no-deps@1.0.0");
    expect(await exists(join(packageDir, "node_modules", "no-deps", "package.json"))).toBeTrue();
    expect(await exists(join(packageDir, "node_modules", "a-dep"))).toBeFalse();
    expect(await file(join(packageDir, "bun.lock")).text()).toBe(lockfile);
  }
});

it("escapes quotes and newlines in requested version literals when writing yarn.lock", async () => {
  const { packageDir, packageJson } = await registry.createTestDir();

  // A version range carrying a quote and a newline. The extra characters are
  // skipped by the lenient range parser (it still resolves to 1.0.0), but the
  // stored literal keeps them, so the yarn.lock printer must keep the whole
  // literal inside a single quoted scalar.
  const craftedRange = '1.0.0 "\n  resolved "http://injected.example/forged-by-yarn-printer';

  await write(
    packageJson,
    JSON.stringify({
      name: "yarn-lock-escaping",
      dependencies: {
        "no-deps": craftedRange,
      },
    }),
  );

  const { exited, stderr } = spawn({
    cmd: [bunExe(), "install", "--yarn"],
    cwd: packageDir,
    env,
    stdout: "ignore",
    stderr: "pipe",
  });

  const err = await stderr.text();
  const exitCode = await exited;

  expect(err).toContain("Saved yarn.lock");
  expect(exitCode).toBe(0);

  const yarnLock = await file(join(packageDir, "yarn.lock")).text();
  const lines = yarnLock.split("\n");

  // The package resolves normally and its real resolved URL points at the test registry.
  expect(lines.some(line => /^ {2}resolved "http:\/\/localhost:\d+\//.test(line))).toBe(true);

  // The literal's embedded quote is escaped, so the requested range stays inside one quoted key.
  expect(yarnLock).toContain('\\"http://injected.example');

  // No yarn.lock line is forged from the version literal's contents.
  expect(lines.filter(line => line.trimStart().startsWith('resolved "http://injected.example'))).toEqual([]);
});

it("prints an actionable error for a lockfile version newer than this build supports", async () => {
  const { packageDir, packageJson } = await registry.createTestDir();

  await write(
    packageJson,
    JSON.stringify({
      name: "future-lockfile",
      dependencies: {},
    }),
  );

  await write(
    join(packageDir, "bun.lock"),
    JSON.stringify({
      lockfileVersion: 99,
      workspaces: {
        "": {
          name: "future-lockfile",
        },
      },
      packages: {},
    }),
  );

  const { exited, stdout, stderr } = spawn({
    cmd: [bunExe(), "install"],
    cwd: packageDir,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [out, err] = await Promise.all([stdout.text(), stderr.text()]);

  expect(err).toContain("Unsupported lockfile version 99");
  expect(err).toContain("newer version of Bun");
  expect(err).toMatch(/This is Bun v\d+\.\d+\.\d+/);
  expect(err).toMatch(/supports lockfile versions up to \d+/);
  expect(err).toContain("Run 'bun upgrade'");
  // the old message gave no hint at all
  expect(err).not.toContain("Unknown lockfile version");
  expect(await exited).toBe(0);
});

async function installWithHandEditedOverrides(overrides: Record<string, unknown>) {
  const { packageDir, packageJson } = await registry.createTestDir();
  const lockfile = JSON.stringify(
    {
      lockfileVersion: 1,
      configVersion: 1,
      workspaces: { "": { name: "invalid-overrides" } },
      overrides,
      packages: {},
    },
    null,
    2,
  );
  await Promise.all([
    write(packageJson, JSON.stringify({ name: "invalid-overrides" })),
    write(join(packageDir, "bun.lock"), lockfile),
  ]);

  await using proc = spawn({
    cmd: [bunExe(), "install", "--frozen-lockfile"],
    cwd: packageDir,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  expect(await file(join(packageDir, "bun.lock")).text()).toBe(lockfile);
  return { out: normalizeBunSnapshot(out, packageDir), err: normalizeBunSnapshot(err, packageDir), exitCode };
}

describe.concurrent("hand-edited bun.lock overrides", () => {
  it("rejects a top-level row whose value is a number", async () => {
    const { out, err, exitCode } = await installWithHandEditedOverrides({ "no-deps": 1 });
    expect(err).toMatchInlineSnapshot(`
      "10 |     "no-deps": 1
                          ^
      error: Expected a string or an object
          at bun.lock:10:16
      InvalidLockfile: failed to parse lockfile: 'bun.lock'

      warn: Ignoring lockfile
      error: lockfile had changes, but lockfile is frozen"
    `);
    expect(out).toMatchInlineSnapshot(`"bun install <version> (<revision>)"`);
    expect(exitCode).toBe(1);
  });

  it("rejects a group whose key is a bare scope", async () => {
    const { out, err, exitCode } = await installWithHandEditedOverrides({ "@scope": { ".": "1.0.0" } });
    expect(err).toMatchInlineSnapshot(`
      "10 |     "@scope": {
               ^
      error: Invalid override key
          at bun.lock:10:5
      InvalidLockfile: failed to parse lockfile: 'bun.lock'

      warn: Ignoring lockfile
      error: lockfile had changes, but lockfile is frozen"
    `);
    expect(out).toMatchInlineSnapshot(`"bun install <version> (<revision>)"`);
    expect(exitCode).toBe(1);
  });

  it("rejects a group child whose key is a bare scope", async () => {
    const { out, err, exitCode } = await installWithHandEditedOverrides({ "no-deps": { "@scope": "1.0.0" } });
    expect(err).toMatchInlineSnapshot(`
      "11 |       "@scope": "1.0.0"
                 ^
      error: Invalid override key
          at bun.lock:11:7
      InvalidLockfile: failed to parse lockfile: 'bun.lock'

      warn: Ignoring lockfile
      error: lockfile had changes, but lockfile is frozen"
    `);
    expect(out).toMatchInlineSnapshot(`"bun install <version> (<revision>)"`);
    expect(exitCode).toBe(1);
  });

  it("rejects a group child whose value is a number", async () => {
    const { out, err, exitCode } = await installWithHandEditedOverrides({ "no-deps": { "a-dep": 1 } });
    expect(err).toMatchInlineSnapshot(`
      "11 |       "a-dep": 1
                          ^
      error: Expected a string
          at bun.lock:11:16
      InvalidLockfile: failed to parse lockfile: 'bun.lock'

      warn: Ignoring lockfile
      error: lockfile had changes, but lockfile is frozen"
    `);
    expect(out).toMatchInlineSnapshot(`"bun install <version> (<revision>)"`);
    expect(exitCode).toBe(1);
  });

  it("rejects a group whose key carries a non-npm range", async () => {
    const { out, err, exitCode } = await installWithHandEditedOverrides({
      "no-deps@file:./vendored": { ".": "1.0.0" },
    });
    expect(err).toMatchInlineSnapshot(`
      "11 |       ".": "1.0.0"
                      ^
      error: Invalid override version
          at bun.lock:11:12
      InvalidLockfile: failed to parse lockfile: 'bun.lock'

      warn: Ignoring lockfile
      error: lockfile had changes, but lockfile is frozen"
    `);
    expect(out).toMatchInlineSnapshot(`"bun install <version> (<revision>)"`);
    expect(exitCode).toBe(1);
  });

  it("rejects a group child whose value does not parse as a dependency", async () => {
    const { out, err, exitCode } = await installWithHandEditedOverrides({ "no-deps": { "a-dep": "./a:dep" } });
    expect(err).toMatchInlineSnapshot(`
      "error: Unsupported protocol ./a:dep

      11 |       "a-dep": "./a:dep"
                          ^
      error: Invalid override version
          at bun.lock:11:16
      InvalidLockfile: failed to parse lockfile: 'bun.lock'

      warn: Ignoring lockfile
      error: lockfile had changes, but lockfile is frozen"
    `);
    expect(out).toMatchInlineSnapshot(`"bun install <version> (<revision>)"`);
    expect(exitCode).toBe(1);
  });
});

describe.concurrent("hand-edited bun.lock that lists workspaces but has no packages object", () => {
  const lockfileWithoutPackages = (lockfileVersion: number) =>
    JSON.stringify(
      {
        lockfileVersion,
        workspaces: {
          "": { name: "no-packages-object" },
          "packages/member": { name: "member", version: "1.0.0" },
        },
      },
      null,
      2,
    );

  const projectFiles = (lockfileVersion: number) => ({
    "package.json": JSON.stringify({ name: "no-packages-object", workspaces: ["packages/*"] }),
    "packages/member/package.json": JSON.stringify({ name: "member", version: "1.0.0" }),
    "bun.lock": lockfileWithoutPackages(lockfileVersion),
  });

  async function install(cwd: string, ...args: string[]) {
    await using proc = spawn({
      cmd: [bunExe(), "install", ...args],
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    return { out: normalizeBunSnapshot(out, cwd), err: normalizeBunSnapshot(err, cwd), exitCode };
  }

  it("bun install links the workspace and writes the packages object back", async () => {
    using dir = tempDir("bun-lock-no-packages-object", projectFiles(1));
    const { out, err, exitCode } = await install(String(dir));
    expect(err).toMatchInlineSnapshot(`"Saved lockfile"`);
    expect(out).toMatchInlineSnapshot(`
      "bun install <version> (<revision>)

      1 package installed"
    `);
    expect(exitCode).toBe(0);

    expect(await file(join(String(dir), "node_modules", "member", "package.json")).json()).toEqual({
      name: "member",
      version: "1.0.0",
    });
    expect(await file(join(String(dir), "bun.lock")).text()).toContain(
      `"packages": {\n    "member": ["member@workspace:packages/member"],\n  }`,
    );
  });

  it("bun install --frozen-lockfile treats it like an empty packages object", async () => {
    using dir = tempDir("bun-lock-no-packages-object-frozen", projectFiles(2));
    const { out, err, exitCode } = await install(String(dir), "--frozen-lockfile");
    expect(err).toMatchInlineSnapshot(`""`);
    expect(out).toMatchInlineSnapshot(`
      "bun install <version> (<revision>)

      1 package installed"
    `);
    expect(exitCode).toBe(0);

    expect(await file(join(String(dir), "node_modules", "member", "package.json")).json()).toEqual({
      name: "member",
      version: "1.0.0",
    });
    expect(await file(join(String(dir), "bun.lock")).text()).toBe(lockfileWithoutPackages(2));
  });
});

const makeInstallRunner = (cwd: string) => async (args: string[]) => {
  await using proc = spawn({
    cmd: [bunExe(), ...args],
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  expect({ args, err, code }).toMatchObject({ args, err: expect.not.stringContaining("error:"), code: 0 });
  return { out, err };
};

// https://github.com/oven-sh/bun/issues/8662#issuecomment-3379529330
it("bun remove drops a package that was only otherwise an optional peer", async () => {
  const { packageDir, packageJson } = await registry.createTestDir({ bunfigOpts: { saveTextLockfile: true } });
  const run = makeInstallRunner(packageDir);

  // A `packages` entry for `no-deps` serializes as `"no-deps": ["no-deps@...`.
  // (The literal "no-deps" also appears inside optional-peer-deps's
  // peerDependencies/optionalPeers metadata, so match the entry prefix.)
  const noDepsEntry = '"no-deps": ["no-deps@';

  await write(packageJson, JSON.stringify({ name: "foo", version: "1.0.0" }));

  // step 1: optional-peer-deps has an optional peer on no-deps; no-deps is NOT in the lockfile yet.
  await run(["add", "-D", "optional-peer-deps@1.0.0"]);
  const afterStep1 = await file(join(packageDir, "bun.lock")).text();
  expect(afterStep1).not.toContain(noDepsEntry);

  // step 2: add no-deps as a direct dependency; the optional peer slot is now satisfied.
  await run(["add", "no-deps@1.0.0"]);
  const afterStep2 = await file(join(packageDir, "bun.lock")).text();
  expect(afterStep2).toContain(noDepsEntry);

  // step 3: remove no-deps. The lockfile must return to the step-1 state.
  await run(["remove", "no-deps"]);
  const afterStep3 = await file(join(packageDir, "bun.lock")).text();
  expect(afterStep3).not.toContain(noDepsEntry);
  expect(afterStep3).toBe(afterStep1);

  // --frozen-lockfile must accept the result (round-trip).
  await rm(join(packageDir, "node_modules"), { recursive: true, force: true });
  await run(["install", "--frozen-lockfile"]);
});

it("bun remove keeps an optional peer that is still reachable via a non-peer edge", async () => {
  const { packageDir, packageJson } = await registry.createTestDir({ bunfigOpts: { saveTextLockfile: true } });
  const run = makeInstallRunner(packageDir);

  // optional-peer-deps: optional peer on no-deps
  // one-dep:            hard dependency on no-deps@1.0.1
  await write(
    packageJson,
    JSON.stringify({
      name: "foo",
      version: "1.0.0",
      devDependencies: { "optional-peer-deps": "1.0.0", "one-dep": "1.0.0" },
    }),
  );
  const noDepsEntry = '"no-deps": ["no-deps@';
  await run(["install"]);
  const baseline = await file(join(packageDir, "bun.lock")).text();
  expect(baseline).toContain(noDepsEntry);

  await run(["add", "no-deps@1.0.1"]);
  await run(["remove", "no-deps"]);

  // no-deps must remain (one-dep still depends on it), and the lockfile must be
  // byte-identical to before the add/remove pair.
  const after = await file(join(packageDir, "bun.lock")).text();
  expect(after).toContain(noDepsEntry);
  expect(after).toBe(baseline);

  await rm(join(packageDir, "node_modules"), { recursive: true, force: true });
  await run(["install", "--frozen-lockfile"]);
});

it("bun install drops a once-resolved optional peer after the providing dependency leaves package.json", async () => {
  const { packageDir, packageJson } = await registry.createTestDir({ bunfigOpts: { saveTextLockfile: true } });
  const run = makeInstallRunner(packageDir);

  // Same as the first test but via editing package.json + `bun install` instead
  // of `bun remove`, which is the other path into clean_with_logger.
  const noDepsEntry = '"no-deps": ["no-deps@';
  await write(
    packageJson,
    JSON.stringify({
      name: "foo",
      version: "1.0.0",
      devDependencies: { "optional-peer-deps": "1.0.0" },
      dependencies: { "no-deps": "1.0.0" },
    }),
  );
  await run(["install"]);
  expect(await file(join(packageDir, "bun.lock")).text()).toContain(noDepsEntry);

  await write(
    packageJson,
    JSON.stringify({
      name: "foo",
      version: "1.0.0",
      devDependencies: { "optional-peer-deps": "1.0.0" },
    }),
  );
  await run(["install"]);
  expect(await file(join(packageDir, "bun.lock")).text()).not.toContain(noDepsEntry);
});

it("optional peer with a non-wildcard range is idempotent with two versions of the target in the tree", async () => {
  const { packageDir, packageJson } = await registry.createTestDir({ bunfigOpts: { saveTextLockfile: true } });
  const run = makeInstallRunner(packageDir);

  // one-optional-peer-dep@1.0.2: optional peer no-deps@^1.0.0
  // one-dep:                      hard dep no-deps@1.0.1 (satisfies ^1.0.0)
  // one-fixed-dep@2.0.0:          hard dep no-deps@2.0.0 (does not satisfy ^1.0.0)
  await write(
    packageJson,
    JSON.stringify({
      name: "foo",
      version: "1.0.0",
      dependencies: {
        "one-optional-peer-dep": "1.0.2",
        "one-dep": "1.0.0",
        "one-fixed-dep": "2.0.0",
      },
    }),
  );

  await run(["install"]);
  const first = await file(join(packageDir, "bun.lock")).text();
  expect(first).toContain('"no-deps": ["no-deps@');

  // A second install over the same lockfile must be a byte-for-byte no-op: the
  // optional peer stays bound to the no-deps the fresh install bound it to.
  await run(["install"]);
  expect(await file(join(packageDir, "bun.lock")).text()).toBe(first);

  await rm(join(packageDir, "node_modules"), { recursive: true, force: true });
  await run(["install", "--frozen-lockfile"]);
});

// Lockfiles saved by versions that did not drop such packages (see the `bun remove`
// tests above) still list packages that only an optional peer slot reaches. The
// committed file is all a frozen install may use, so it has to keep installing them.
// The workspace's lifecycle script is what separates this from a no-op install:
// bun.lock does not record workspace scripts, so this project's package.json diff is
// never empty.
it("--frozen-lockfile keeps a package that an older lockfile lists only as an optional peer", async () => {
  const { packageDir, packageJson } = await registry.createTestDir({
    bunfigOpts: { saveTextLockfile: true, linker: "hoisted" },
  });
  const run = makeInstallRunner(packageDir);
  const noDepsEntry = '"no-deps": ["no-deps@';
  const rootPackageJson = (dependencies: Record<string, string>) =>
    JSON.stringify({ name: "foo", version: "1.0.0", workspaces: ["packages/*"], dependencies });

  await Promise.all([
    write(packageJson, rootPackageJson({ "optional-peer-deps": "1.0.0", "no-deps": "1.0.0" })),
    write(
      join(packageDir, "packages", "pkg", "package.json"),
      JSON.stringify({ name: "pkg", version: "1.0.0", scripts: { postinstall: "exit 0" } }),
    ),
  ]);
  await run(["install", "--ignore-scripts"]);

  // What an older `bun remove no-deps` left behind: the root no longer depends on
  // no-deps, but its entry stayed because optional-peer-deps's peer slot pointed at it.
  const written = await file(join(packageDir, "bun.lock")).text();
  const stale = written.replace(/^ +"no-deps": "1\.0\.0",\n/m, "");
  expect(stale).not.toBe(written);
  expect(stale).toContain(noDepsEntry);
  await Promise.all([
    write(join(packageDir, "bun.lock"), stale),
    write(packageJson, rootPackageJson({ "optional-peer-deps": "1.0.0" })),
    rm(join(packageDir, "node_modules"), { recursive: true, force: true }),
  ]);

  await run(["install", "--frozen-lockfile", "--ignore-scripts"]);
  expect(await file(join(packageDir, "bun.lock")).text()).toBe(stale);
  expect(await exists(join(packageDir, "node_modules", "no-deps", "package.json"))).toBeTrue();
});

// The optional-peer-hoist-* fixtures are described in
// registry/packages/create-optional-peer-hoist-packages.ts. In short: consumer
// has an optional peer on target, and deep -> deep-child reaches target@1.0.0
// (which depends on leaf@2.0.0) as well as leaf@1.0.0. Hoisting is
// breadth-first, so leaf@2.0.0 only wins the root slot if consumer's peer is
// already bound to target when the tree is built. A loaded bun.lock always has
// the peer bound, so that is the tree every install has to build, otherwise
// --frozen-lockfile compares two different trees.
const optionalPeerHoistDeps = {
  "optional-peer-hoist-consumer": "1.0.0",
  "optional-peer-hoist-deep": "1.0.0",
};

it("a fresh install hoists around an optional peer the same way a reinstall does", async () => {
  const { packageDir, packageJson } = await registry.createTestDir({ bunfigOpts: { saveTextLockfile: true } });
  const run = makeInstallRunner(packageDir);

  await write(packageJson, JSON.stringify({ name: "foo", dependencies: optionalPeerHoistDeps }));
  await run(["install"]);
  const fresh = await file(join(packageDir, "bun.lock")).text();
  expect(fresh).toContain('"optional-peer-hoist-leaf": ["optional-peer-hoist-leaf@2.0.0"');
  expect(fresh).toContain(
    '"optional-peer-hoist-deep-child/optional-peer-hoist-leaf": ["optional-peer-hoist-leaf@1.0.0"',
  );

  await run(["install", "--frozen-lockfile"]);

  // --lockfile-only always writes, so this checks the tree a reload builds
  // prints back to the same text.
  await run(["install", "--lockfile-only"]);
  expect(await file(join(packageDir, "bun.lock")).text()).toBe(fresh);
});

it("a fresh install settles hoisting around a peer that only becomes bindable once another peer is bound", async () => {
  const { packageDir, packageJson } = await registry.createTestDir({ bunfigOpts: { saveTextLockfile: true } });
  const run = makeInstallRunner(packageDir);

  // Shape 2 in the fixture generator: binding consumer's peer hoists leaf@3.0.0
  // out from under target, which is what lets target2@1.0.0 reach consumer2's
  // peer, and only with that one bound too does target2's tail@2.0.0 beat
  // deep-child's tail@1.0.0 to the root, the way it does on every reload.
  await write(
    packageJson,
    JSON.stringify({
      name: "foo",
      dependencies: {
        "optional-peer-hoist-consumer": "1.0.0",
        "optional-peer-hoist-consumer2": "1.0.0",
        "optional-peer-hoist-deep": "2.0.0",
      },
    }),
  );
  await run(["install"]);
  const fresh = await file(join(packageDir, "bun.lock")).text();
  expect(fresh).toContain('"optional-peer-hoist-tail": ["optional-peer-hoist-tail@2.0.0"');
  expect(fresh).toContain(
    '"optional-peer-hoist-deep-child/optional-peer-hoist-tail": ["optional-peer-hoist-tail@1.0.0"',
  );

  await run(["install", "--frozen-lockfile"]);
  await run(["install", "--lockfile-only"]);
  expect(await file(join(packageDir, "bun.lock")).text()).toBe(fresh);
});

it.each([
  [
    "leaf@2.0.0 hoisted (target placed from consumer)",
    {
      "optional-peer-hoist-leaf": "2.0.0",
      "optional-peer-hoist-deep-child/optional-peer-hoist-leaf": "1.0.0",
    },
  ],
  [
    // What a fresh install wrote before the peer binding was carried over.
    "leaf@1.0.0 hoisted (target placed from deep-child)",
    {
      "optional-peer-hoist-leaf": "1.0.0",
      "optional-peer-hoist-target/optional-peer-hoist-leaf": "2.0.0",
    },
  ],
])("--frozen-lockfile accepts an existing bun.lock with %s", async (_, leafPlacement) => {
  const { packageDir, packageJson } = await registry.createTestDir({ bunfigOpts: { saveTextLockfile: true } });
  const run = makeInstallRunner(packageDir);

  const pkg = (name: string, version: string, info: object = {}) => [
    `${name}@${version}`,
    `${registry.registryUrl()}${name}/-/${name}-${version}.tgz`,
    info,
    "",
  ];
  const packages: Record<string, unknown[]> = {
    "optional-peer-hoist-consumer": pkg("optional-peer-hoist-consumer", "1.0.0", {
      peerDependencies: { "optional-peer-hoist-target": "*" },
      optionalPeers: ["optional-peer-hoist-target"],
    }),
    "optional-peer-hoist-deep": pkg("optional-peer-hoist-deep", "1.0.0", {
      dependencies: { "optional-peer-hoist-deep-child": "1.0.0" },
    }),
    "optional-peer-hoist-deep-child": pkg("optional-peer-hoist-deep-child", "1.0.0", {
      dependencies: { "optional-peer-hoist-leaf": "1.0.0", "optional-peer-hoist-target": "1.0.0" },
    }),
    "optional-peer-hoist-target": pkg("optional-peer-hoist-target", "1.0.0", {
      dependencies: { "optional-peer-hoist-leaf": "2.0.0" },
    }),
  };
  for (const [path, version] of Object.entries(leafPlacement)) {
    packages[path] = pkg("optional-peer-hoist-leaf", version);
  }

  await write(packageJson, JSON.stringify({ name: "foo", dependencies: optionalPeerHoistDeps }));
  await write(
    join(packageDir, "bun.lock"),
    JSON.stringify({
      lockfileVersion: 2,
      configVersion: 1,
      workspaces: { "": { name: "foo", dependencies: optionalPeerHoistDeps } },
      packages,
    }),
  );

  await run(["install", "--frozen-lockfile"]);
});

it("adding a dependency keeps an optional peer on the package bun.lock bound it to while that package stays next to it", async () => {
  const { packageDir, packageJson } = await registry.createTestDir({ bunfigOpts: { saveTextLockfile: true } });
  const run = makeInstallRunner(packageDir);

  await write(packageJson, JSON.stringify({ name: "foo", dependencies: optionalPeerHoistDeps }));
  await run(["install"]);
  expect(await file(join(packageDir, "bun.lock")).text()).toContain(
    '"optional-peer-hoist-target": ["optional-peer-hoist-target@1.0.0"',
  );

  // provider brings in target@2.0.0, which consumer's peer range would accept
  // too. bun.lock binds consumer to target@1.0.0, and consumer sorts before
  // provider, so target@1.0.0 is placed from consumer first, keeps the root
  // slot and the binding, and target@2.0.0 nests under provider.
  await write(
    packageJson,
    JSON.stringify({
      name: "foo",
      dependencies: { ...optionalPeerHoistDeps, "optional-peer-hoist-provider": "1.0.0" },
    }),
  );
  await run(["install"]);
  const lockfile = await file(join(packageDir, "bun.lock")).text();
  expect(lockfile).toContain('"optional-peer-hoist-target": ["optional-peer-hoist-target@1.0.0"');
  expect(lockfile).toContain(
    '"optional-peer-hoist-provider/optional-peer-hoist-target": ["optional-peer-hoist-target@2.0.0"',
  );
  expect(lockfile).toContain('"optional-peer-hoist-leaf": ["optional-peer-hoist-leaf@2.0.0"');

  await run(["install", "--frozen-lockfile"]);
  await run(["install", "--lockfile-only"]);
  expect(await file(join(packageDir, "bun.lock")).text()).toBe(lockfile);
});

it("an optional peer is rebound when another version of its package takes the slot next to it", async () => {
  // The isolated linker is the one consumer of the binding itself: consumer's
  // store entry is keyed by the target it was linked against.
  const { packageDir, packageJson } = await registry.createTestDir({
    bunfigOpts: { saveTextLockfile: true, linker: "isolated" },
  });
  const run = makeInstallRunner(packageDir);
  const consumerLink = () => readlinkSync(join(packageDir, "node_modules", "optional-peer-hoist-consumer"));

  await write(packageJson, JSON.stringify({ name: "foo", dependencies: optionalPeerHoistDeps }));
  await run(["install"]);
  const boundToTarget1 = consumerLink();

  // Same as the previous test, but aliased so the provider sorts before
  // consumer: target@2.0.0 takes the root slot before consumer's bound
  // target@1.0.0 can be placed, and since the peer range accepts it, consumer
  // dedupes onto it. That is what a reload of this bun.lock binds consumer to,
  // so it is also what this install has to link consumer against.
  await write(
    packageJson,
    JSON.stringify({
      name: "foo",
      dependencies: { "a-provider": "npm:optional-peer-hoist-provider@1.0.0", ...optionalPeerHoistDeps },
    }),
  );
  await run(["install"]);
  const lockfile = await file(join(packageDir, "bun.lock")).text();
  expect(lockfile).toContain('"optional-peer-hoist-target": ["optional-peer-hoist-target@2.0.0"');
  expect(lockfile).toContain(
    '"optional-peer-hoist-deep-child/optional-peer-hoist-target": ["optional-peer-hoist-target@1.0.0"',
  );
  const linkedByThisInstall = consumerLink();
  expect(linkedByThisInstall).not.toBe(boundToTarget1);

  await rm(join(packageDir, "node_modules"), { recursive: true, force: true });
  await run(["install", "--frozen-lockfile"]);
  expect(consumerLink()).toBe(linkedByThisInstall);

  await run(["install", "--lockfile-only"]);
  expect(await file(join(packageDir, "bun.lock")).text()).toBe(lockfile);
});

// https://github.com/oven-sh/bun/issues/26046
// A required peer that nothing in the tree provides and that no published
// version satisfies stays unresolved. The bun.lock written afterwards has to
// load back, and resolving it again with every manifest already in the cache
// has to finish (it used to retry the cached manifest forever).
describe.each(["hoisted", "isolated"] as const)("peer no published version satisfies (%s linker)", linker => {
  const manifests: Record<string, Record<string, Record<string, unknown>>> = {
    "has-unmet-peer": { "1.0.0": { peerDependencies: { "peer-target": "^1.0.1" } } },
    "peer-target": { "2.0.1": {} },
  };

  const unmetPeerWarning =
    'warn: No version matching "^1.0.1" found for peer dependency "peer-target" (but package exists)';

  async function serveRegistry() {
    const tarballs = new Map<string, Uint8Array>();
    for (const [name, versions] of Object.entries(manifests)) {
      for (const [version, extra] of Object.entries(versions)) {
        const archive = new Bun.Archive(
          { "package/package.json": JSON.stringify({ name, version, ...extra }) },
          { compress: "gzip" },
        );
        tarballs.set(`/${name}-${version}.tgz`, await archive.bytes());
      }
    }
    const requests: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const { origin, pathname } = new URL(request.url);
        requests.push(pathname);
        const tarball = tarballs.get(pathname);
        if (tarball) return new Response(tarball);
        const name = pathname.slice(1);
        const entry = manifests[name];
        if (!entry) return new Response("not found", { status: 404 });
        const versions: Record<string, unknown> = {};
        for (const [version, extra] of Object.entries(entry)) {
          versions[version] = { name, version, dist: { tarball: `${origin}/${name}-${version}.tgz` }, ...extra };
        }
        return Response.json(
          { name, versions, "dist-tags": { latest: Object.keys(entry).at(-1) } },
          // Like registry.npmjs.org. Within this window bun resolves from the
          // manifest cache without going back to the registry.
          { headers: { "cache-control": "public, max-age=300" } },
        );
      },
    });
    return {
      url: server.url.href,
      origin: server.url.origin,
      requests,
      [Symbol.dispose]() {
        server.stop(true);
      },
    };
  }

  function createProject(registryUrl: string, files: Record<string, string>) {
    return tempDir("unmet-peer-", {
      ...files,
      "bunfig.toml": Bun.TOML.stringify({ install: { registry: registryUrl, linker } }),
    });
  }

  async function install(cwd: string, ...args: string[]) {
    await using proc = spawn({
      cmd: [bunExe(), "install", ...args],
      cwd,
      // The request assertions below need a cache of their own per project: the
      // environment's cache dir takes precedence over bunfig, and a package
      // extracted there by one of the concurrent tests is not downloaded again.
      env: { ...env, BUN_INSTALL_CACHE_DIR: join(cwd, ".bun-cache") },
      stdout: "pipe",
      stderr: "pipe",
      // Only matters if an install never returns.
      timeout: 30_000,
    });
    const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect({ args, err, code }).toMatchObject({ args, err: expect.not.stringContaining("error:"), code: 0 });
    return { out, err };
  }

  it.concurrent("declared by a registry package", async () => {
    using registry = await serveRegistry();
    using dir = createProject(registry.url, {
      "package.json": JSON.stringify({ name: "app", dependencies: { "has-unmet-peer": "1.0.0" } }),
    });
    const lockfilePath = join(String(dir), "bun.lock");

    let { err } = await install(String(dir));
    expect(err).toContain(unmetPeerWarning);
    expect(err).toContain("Saved lockfile");
    expect(registry.requests.toSorted()).toEqual(["/has-unmet-peer", "/has-unmet-peer-1.0.0.tgz", "/peer-target"]);
    const lockfile = await file(lockfilePath).text();
    expect(lockfile.replaceAll(registry.origin, "<registry>")).toMatchInlineSnapshot(`
      "{
        "lockfileVersion": 1,
        "configVersion": 1,
        "workspaces": {
          "": {
            "name": "app",
            "dependencies": {
              "has-unmet-peer": "1.0.0",
            },
          },
        },
        "packages": {
          "has-unmet-peer": ["has-unmet-peer@1.0.0", "<registry>/has-unmet-peer-1.0.0.tgz", { "peerDependencies": { "peer-target": "^1.0.1" } }, ""],
        }
      }
      "
    `);
    expect(await exists(join(String(dir), "node_modules", "peer-target"))).toBeFalse();

    ({ err } = await install(String(dir), "--frozen-lockfile"));
    expect(err).not.toContain("Ignoring lockfile");
    expect(await file(lockfilePath).text()).toBe(lockfile);

    // Resolve from scratch again. Both manifests are cached now, so the peer
    // is looked up synchronously instead of through a network task.
    await rm(lockfilePath);
    await rm(join(String(dir), "node_modules"), { recursive: true });
    registry.requests.length = 0;
    ({ err } = await install(String(dir)));
    expect(err).toContain(unmetPeerWarning);
    expect(registry.requests).toEqual([]);
    expect(await file(lockfilePath).text()).toBe(lockfile);
  });

  it.concurrent("declared by the root package and a workspace", async () => {
    using registry = await serveRegistry();
    using dir = createProject(registry.url, {
      "package.json": JSON.stringify({
        name: "app",
        workspaces: ["packages/*"],
        peerDependencies: { "peer-target": "^1.0.1" },
      }),
      "packages/ws/package.json": JSON.stringify({ name: "ws", peerDependencies: { "peer-target": "^1.0.1" } }),
    });
    const lockfilePath = join(String(dir), "bun.lock");

    let { err } = await install(String(dir));
    expect(err).toContain(unmetPeerWarning);
    expect(err).toContain("Saved lockfile");
    expect(registry.requests).toEqual(["/peer-target"]);
    const lockfile = await file(lockfilePath).text();
    expect(lockfile).toMatchInlineSnapshot(`
      "{
        "lockfileVersion": 2,
        "configVersion": 1,
        "workspaces": {
          "": {
            "name": "app",
            "peerDependencies": {
              "peer-target": "^1.0.1",
            },
          },
          "packages/ws": {
            "name": "ws",
            "peerDependencies": {
              "peer-target": "^1.0.1",
            },
          },
        },
        "packages": {
          "ws": ["ws@workspace:packages/ws"],
        }
      }
      "
    `);

    ({ err } = await install(String(dir), "--frozen-lockfile"));
    expect(err).not.toContain("Ignoring lockfile");
    expect(await file(lockfilePath).text()).toBe(lockfile);
  });
});

describe.concurrent("bun.lock with git conflict markers", () => {
  // name -> version -> what the package.json of that version adds
  const published: Record<string, Record<string, Record<string, unknown>>> = {
    "kept": { "1.0.0": {}, "1.1.0": {} },
    "left": { "1.0.0": {} },
    "right": { "1.0.0": {} },
    "extra": { "1.0.0": {} },
    "shared": { "1.0.0": {}, "1.0.1": {}, "1.0.2": {}, "2.0.0": {} },
    "uses-old": { "1.0.0": { dependencies: { shared: "1.0.0" } } },
    "uses-old-too": { "1.0.0": { dependencies: { shared: "1.0.0" } } },
    "uses-new": { "1.0.0": { dependencies: { shared: "2.0.0" } } },
    "has-leaf": { "1.0.0": { dependencies: { leaf: "^1.0.0" } } },
    "leaf": { "1.0.0": {}, "1.0.5": {} },
    "real": { "1.0.0": {}, "2.0.0": {} },
    "uses-alias-name": { "1.0.0": { dependencies: { aliased: "^2.0.0" } } },
    "has-optional": { "1.0.0": { optionalDependencies: { shared: "^1.0.0" } } },
    "has-peer": { "1.0.0": { peerDependencies: { shared: "^5.0.0" } } },
    "outer": { "1.0.0": { dependencies: { leaf: "^1.0.0" } }, "1.1.0": { dependencies: { leaf: "^1.0.0" } } },
    "packs": {
      "1.0.0": { dependencies: { leaf: "1.0.0" }, bundleDependencies: ["leaf"] },
      "2.0.0": { dependencies: { leaf: "^1.0.5" } },
    },
    "tool": { "1.0.0": { dependencies: { helper: "^1.0.0" } }, "1.1.0": { dependencies: { helper: "^2.0.0" } } },
    "helper": { "1.0.0": {}, "2.0.0": {} },
    "needs-old-tool": { "1.0.0": { dependencies: { tool: "1.0.0" } } },
    "@scope/shared": { "1.0.0": {}, "2.0.0": {} },
    "uses-scoped-old": { "1.0.0": { dependencies: { "@scope/shared": "1.0.0" } } },
    "uses-scoped-new": { "1.0.0": { dependencies: { "@scope/shared": "2.0.0" } } },
  };

  const tarballs = new Map<string, Uint8Array>();
  const integrity = new Map<string, string>();
  beforeAll(async () => {
    for (const [name, versions] of Object.entries(published)) {
      for (const [version, extra] of Object.entries(versions)) {
        const archive = new Bun.Archive(
          { "package/package.json": JSON.stringify({ name, version, ...extra }) },
          { compress: "gzip" },
        );
        const bytes = await archive.bytes();
        tarballs.set(`/${name}-${version}.tgz`, bytes);
        integrity.set(`${name}@${version}`, "sha512-" + new Bun.CryptoHasher("sha512").update(bytes).digest("base64"));
      }
    }
  });

  function serveRegistry() {
    const requests: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const { origin, pathname } = new URL(request.url);
        requests.push(pathname);
        const tarball = tarballs.get(pathname);
        if (tarball) return new Response(tarball);
        const name = decodeURIComponent(pathname.slice(1));
        const entry = published[name];
        if (!entry) return new Response("not found", { status: 404 });
        const versions: Record<string, unknown> = {};
        for (const [version, extra] of Object.entries(entry)) {
          versions[version] = {
            name,
            version,
            dist: { tarball: `${origin}/${name}-${version}.tgz`, integrity: integrity.get(`${name}@${version}`) },
            ...extra,
          };
        }
        return Response.json({ name, versions, "dist-tags": { latest: Object.keys(versions).at(-1) } });
      },
    });
    const origin = server.url.origin;
    return {
      url: server.url.href,
      origin,
      requests,
      manifestRequests: () => requests.filter(path => !path.endsWith(".tgz")).toSorted(),
      // The row of "packages" for a package at a path of node_modules.
      row(path: string, id: string, info?: Record<string, unknown>) {
        const [name, version] = [id.slice(0, id.lastIndexOf("@")), id.slice(id.lastIndexOf("@") + 1)];
        info ??= published[name][version];
        return `    "${path}": ["${id}", "${origin}/${name}-${version}.tgz", ${JSON.stringify(info)}, "${integrity.get(id)}"],`;
      },
      [Symbol.dispose]() {
        server.stop(true);
      },
    };
  }
  type Registry = ReturnType<typeof serveRegistry>;
  type Files = Record<string, string>;

  const project = (dependencies: Record<string, string>, rest: Record<string, unknown> = {}): Files => ({
    "package.json": JSON.stringify({ name: "app", version: "1.0.0", dependencies, ...rest }),
  });

  function createProject(registry: Registry, files: Files) {
    return tempDir("bun-lock-conflict-", {
      ...files,
      "bunfig.toml": Bun.TOML.stringify({ install: { registry: registry.url, linker: "hoisted" } }),
    });
  }

  async function run(cwd: string, ...args: string[]) {
    await using proc = spawn({
      cmd: [bunExe(), ...args],
      cwd,
      // A cache per project: what an install asks the registry for is part of what is tested.
      env: { ...env, BUN_INSTALL_CACHE_DIR: join(cwd, ".bun-cache") },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    return { out, err, code };
  }

  async function succeed(cwd: string, ...args: string[]) {
    const { out, err, code } = await run(cwd, ...args);
    expect({ args, err, code }).toMatchObject({ args, err: expect.not.stringContaining("error:"), code: 0 });
    return { out, err };
  }

  const normalize = (registry: Registry, lockfile: string) =>
    lockfile.replaceAll(registry.origin, "<registry>").replace(/"sha512-[A-Za-z0-9+\/=]+"/g, '"<integrity>"');

  const savedLockfile = async (registry: Registry, dir: { toString(): string }) =>
    normalize(registry, await file(join(String(dir), "bun.lock")).text());

  const mergedNote = "note: bun.lock contains git merge conflict markers, using the merge of both sides\n";
  const otherHash = "sha512-" + Buffer.alloc(64, 1).toString("base64");

  // One hunk, as `git merge` writes it with each `merge.conflictStyle` and `conflict-marker-size`.
  const hunks = {
    merge: (ours: string, theirs: string) => `<<<<<<< HEAD\n${ours}=======\n${theirs}>>>>>>> feature\n`,
    diff3: (ours: string, theirs: string, base = "") =>
      `<<<<<<< HEAD\n${ours}||||||| base\n${base}=======\n${theirs}>>>>>>> feature\n`,
    long: (ours: string, theirs: string) => `<<<<<<<<<< HEAD\n${ours}==========\n${theirs}>>>>>>>>>> feature\n`,
    // Not what git writes: it sends a lockfile through the merge as it is.
    same: (text: string) => `<<<<<<< HEAD\n${text}=======\n${text}>>>>>>> feature\n`,
    // The base is itself a merge that had a conflict. git writes the markers of that one two longer.
    recursive: (ours: string, theirs: string) =>
      `<<<<<<< HEAD\n${ours}||||||| merged common ancestors\n<<<<<<<<< Temporary merge branch 1\n||||||||| merged common ancestors\n=========\n>>>>>>>>> Temporary merge branch 2\n=======\n${theirs}>>>>>>> feature\n`,
  };
  type Hunk = (ours: string, theirs: string, base?: string) => string;

  // bun.lock after the merge of two branches that add one dependency each. Both have `kept` at 1.0.0,
  // and `kept@1.1.0` is out by now: an install that does not read this lockfile takes 1.1.0.
  const twoBranchesAddADependency = ({ row }: Registry, hunk: Hunk = hunks.merge): Files => ({
    ...project({ kept: "^1.0.0", left: "1.0.0", right: "1.0.0" }),
    "bun.lock": `{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "app",
      "dependencies": {
        "kept": "^1.0.0",
${hunk(`        "left": "1.0.0",\n`, `        "right": "1.0.0",\n`)}      },
    },
  },
  "packages": {
${row("kept", "kept@1.0.0")}
${hunk(`\n${row("left", "left@1.0.0")}\n`, `\n${row("right", "right@1.0.0")}\n`)}  }
}
`,
  });

  // Adds the dependency `has-leaf` and its row, and no row for the `leaf` that it depends on.
  function withoutThePackageOfLeaf({ row }: Registry, lockfile: string) {
    const dependency = `        "kept": "^1.0.0",\n`;
    const kept = row("kept", "kept@1.0.0");
    expect(lockfile).toContain(dependency);
    expect(lockfile).toContain(kept);
    return lockfile
      .replace(dependency, `        "has-leaf": "1.0.0",\n${dependency}`)
      .replace(kept, `${row("has-leaf", "has-leaf@1.0.0")}\n\n${kept}`);
  }

  // What git itself writes for two branches, from lockfiles as bun writes them.
  it("bun install merges what git merge-file leaves of the lockfiles of two branches", async () => {
    using registry = serveRegistry();
    const lockfileOf = (dependencies: Record<string, string>) => `{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "app",
      "dependencies": {
${Object.entries(dependencies)
  .map(([name, range]) => `        "${name}": "${range}",\n`)
  .join("")}      },
    },
  },
  "packages": {
${Object.keys(dependencies)
  .map(name => registry.row(name, `${name}@1.0.0`) + "\n")
  .join("\n")}  }
}
`;
    using branches = tempDir("bun-lock-merge-file-", {
      base: lockfileOf({ kept: "^1.0.0" }),
      ours: lockfileOf({ kept: "^1.0.0", left: "1.0.0" }),
      theirs: lockfileOf({ kept: "^1.0.0", right: "1.0.0" }),
    });
    await using git = spawn({
      cmd: ["git", "merge-file", "-p", "-L", "HEAD", "-L", "base", "-L", "feature", "ours", "base", "theirs"],
      cwd: String(branches),
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [conflicted, gitErr, hunkCount] = await Promise.all([git.stdout.text(), git.stderr.text(), git.exited]);
    expect({ gitErr, hunkCount }).toEqual({ gitErr: "", hunkCount: 2 });
    expect(conflicted).toContain(`"kept": ["kept@1.0.0", `);

    using dir = createProject(registry, {
      ...project({ kept: "^1.0.0", left: "1.0.0", right: "1.0.0" }),
      "bun.lock": conflicted,
    });
    const { err } = await succeed(String(dir), "install", "--lockfile-only");
    expect(err).toContain(mergedNote);
    expect(err).toContain("Saved lockfile");
    expect(registry.manifestRequests()).toEqual([]);
    expect(await savedLockfile(registry, dir)).toMatchInlineSnapshot(`
      "{
        "lockfileVersion": 2,
        "configVersion": 1,
        "workspaces": {
          "": {
            "name": "app",
            "dependencies": {
              "kept": "^1.0.0",
              "left": "1.0.0",
              "right": "1.0.0",
            },
          },
        },
        "packages": {
          "kept": ["kept@1.0.0", "<registry>/kept-1.0.0.tgz", {}, "<integrity>"],

          "left": ["left@1.0.0", "<registry>/left-1.0.0.tgz", {}, "<integrity>"],

          "right": ["right@1.0.0", "<registry>/right-1.0.0.tgz", {}, "<integrity>"],
        }
      }
      "
    `);
  });

  it("bun install keeps every version that the sides lock", async () => {
    using registry = serveRegistry();
    using dir = createProject(registry, twoBranchesAddADependency(registry));
    const lockfilePath = join(String(dir), "bun.lock");

    const { out, err } = await succeed(String(dir), "install");
    expect(err).toContain(mergedNote);
    expect(err).toContain("Saved lockfile");
    expect(err).not.toContain("Ignoring lockfile");
    // Both sides lock everything package.json asks for, so the registry is asked for tarballs only.
    expect(registry.manifestRequests()).toEqual([]);
    expect(normalizeBunSnapshot(out, dir)).toMatchInlineSnapshot(`
      "bun install <version> (<revision>)

      + kept@1.0.0
      + left@1.0.0
      + right@1.0.0

      3 packages installed"
    `);

    const lockfile = await file(lockfilePath).text();
    expect(normalize(registry, lockfile)).toMatchInlineSnapshot(`
      "{
        "lockfileVersion": 2,
        "configVersion": 1,
        "workspaces": {
          "": {
            "name": "app",
            "dependencies": {
              "kept": "^1.0.0",
              "left": "1.0.0",
              "right": "1.0.0",
            },
          },
        },
        "packages": {
          "kept": ["kept@1.0.0", "<registry>/kept-1.0.0.tgz", {}, "<integrity>"],

          "left": ["left@1.0.0", "<registry>/left-1.0.0.tgz", {}, "<integrity>"],

          "right": ["right@1.0.0", "<registry>/right-1.0.0.tgz", {}, "<integrity>"],
        }
      }
      "
    `);

    // What was saved is what a load of it gives.
    await succeed(String(dir), "install", "--frozen-lockfile");
    expect(await file(lockfilePath).text()).toBe(lockfile);
  });

  it.each([
    ["diff3 and zdiff3", hunks.diff3, "\n||||||| base\n"],
    ["a longer conflict-marker-size", hunks.long, "\n<<<<<<<<<< HEAD\n"],
    ["a merge with two ancestors", hunks.recursive, "\n<<<<<<<<< Temporary merge branch 1\n"],
    ["\\r\\n line ends", hunks.merge, "\r\n=======\r\n"],
  ] as const)("reads the markers of %s", async (_, hunk, marker) => {
    using registry = serveRegistry();
    const files = twoBranchesAddADependency(registry, hunk);
    if (marker.startsWith("\r")) files["bun.lock"] = files["bun.lock"].replaceAll("\n", "\r\n");
    expect(files["bun.lock"]).toContain(marker);
    using dir = createProject(registry, files);

    const { err } = await succeed(String(dir), "install", "--lockfile-only");
    expect(err).toContain(mergedNote);
    expect(registry.manifestRequests()).toEqual([]);
    const lockfile = await file(join(String(dir), "bun.lock")).text();
    expect(lockfile).toContain(`"kept": ["kept@1.0.0", `);
    expect(lockfile).toContain(`"left": ["left@1.0.0", `);
    expect(lockfile).toContain(`"right": ["right@1.0.0", `);
    expect(lockfile).not.toMatch(/^(<<<<<<<|=======|>>>>>>>|\|\|\|\|\|\|\|)/m);
  });

  it("keeps both versions when the sides put two versions of a package at one path", async () => {
    using registry = serveRegistry();
    const { row } = registry;
    // Each side has `shared` at the root: 2.0.0 for `uses-new`, 1.0.0 for `uses-old`.
    using dir = createProject(registry, {
      ...project({ "uses-new": "1.0.0", "uses-old": "1.0.0" }),
      "bun.lock": `{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "app",
      "dependencies": {
${hunks.merge(`        "uses-new": "1.0.0",\n`, `        "uses-old": "1.0.0",\n`)}      },
    },
  },
  "packages": {
${hunks.merge(
  `${row("shared", "shared@2.0.0")}\n\n${row("uses-new", "uses-new@1.0.0")}\n`,
  `${row("shared", "shared@1.0.0")}\n\n${row("uses-old", "uses-old@1.0.0")}\n`,
)}  }
}
`,
    });

    await succeed(String(dir), "install");
    expect(registry.manifestRequests()).toEqual([]);
    expect(await savedLockfile(registry, dir)).toMatchInlineSnapshot(`
      "{
        "lockfileVersion": 2,
        "configVersion": 1,
        "workspaces": {
          "": {
            "name": "app",
            "dependencies": {
              "uses-new": "1.0.0",
              "uses-old": "1.0.0",
            },
          },
        },
        "packages": {
          "shared": ["shared@2.0.0", "<registry>/shared-2.0.0.tgz", {}, "<integrity>"],

          "uses-new": ["uses-new@1.0.0", "<registry>/uses-new-1.0.0.tgz", { "dependencies": { "shared": "2.0.0" } }, "<integrity>"],

          "uses-old": ["uses-old@1.0.0", "<registry>/uses-old-1.0.0.tgz", { "dependencies": { "shared": "1.0.0" } }, "<integrity>"],

          "uses-old/shared": ["shared@1.0.0", "<registry>/shared-1.0.0.tgz", {}, "<integrity>"],
        }
      }
      "
    `);
    // The version of `shared` that `require("shared")` in the package gives.
    const sharedOf = async (name: string) => {
      const nested = file(join(String(dir), "node_modules", name, "node_modules", "shared", "package.json"));
      const hoisted = file(join(String(dir), "node_modules", "shared", "package.json"));
      return (await ((await nested.exists()) ? nested : hoisted).json()).version;
    };
    expect({ "uses-old": await sharedOf("uses-old"), "uses-new": await sharedOf("uses-new") }).toEqual({
      "uses-old": "1.0.0",
      "uses-new": "2.0.0",
    });
  });

  it("takes the higher version when both sides moved a package and every range takes it", async () => {
    using registry = serveRegistry();
    const { row } = registry;
    using dir = createProject(registry, {
      ...project({ shared: "^1.0.0" }),
      "bun.lock": `{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "app",
      "dependencies": {
        "shared": "^1.0.0",
      },
    },
  },
  "packages": {
${hunks.diff3(
  `${row("shared", "shared@1.0.2")}\n`,
  `${row("shared", "shared@1.0.1")}\n`,
  `${row("shared", "shared@1.0.0")}\n`,
)}  }
}
`,
    });

    const { err } = await succeed(String(dir), "install", "--lockfile-only");
    expect(err).toContain(mergedNote);
    expect(registry.manifestRequests()).toEqual([]);
    expect(await savedLockfile(registry, dir)).toMatchInlineSnapshot(`
      "{
        "lockfileVersion": 2,
        "configVersion": 1,
        "workspaces": {
          "": {
            "name": "app",
            "dependencies": {
              "shared": "^1.0.0",
            },
          },
        },
        "packages": {
          "shared": ["shared@1.0.2", "<registry>/shared-1.0.2.tgz", {}, "<integrity>"],
        }
      }
      "
    `);
  });

  it("reads the row that git took from one side, next to a hunk with the row of the other side", async () => {
    using registry = serveRegistry();
    const { row } = registry;
    // git does this when the rows around the one that both sides changed are new too: 54 times in 134 merges of bun's own lockfiles.
    using dir = createProject(registry, {
      ...project({ left: "1.0.0", right: "1.0.0", shared: "^1.0.0" }),
      "bun.lock": `{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "app",
      "dependencies": {
${hunks.merge(`        "left": "1.0.0",\n`, `        "right": "1.0.0",\n`)}        "shared": "^1.0.0",
      },
    },
  },
  "packages": {
${hunks.merge(
  `${row("left", "left@1.0.0")}\n\n`,
  `${row("right", "right@1.0.0")}\n\n${row("shared", "shared@1.0.2")}\n\n`,
)}${row("shared", "shared@1.0.1")}
  }
}
`,
    });

    await succeed(String(dir), "install", "--lockfile-only");
    expect(registry.manifestRequests()).toEqual([]);
    const lockfile = await file(join(String(dir), "bun.lock")).text();
    expect(lockfile).toContain(`"left": ["left@1.0.0", `);
    expect(lockfile).toContain(`"right": ["right@1.0.0", `);
    expect(lockfile).toContain(`"shared": ["shared@1.0.2", `);
  });

  it("does not read the base of a diff3 hunk as a side", async () => {
    using registry = serveRegistry();
    const { row } = registry;
    // Both branches went back from the 1.0.2 of the base.
    using dir = createProject(registry, {
      ...project({ shared: "^1.0.0" }),
      "bun.lock": `{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "app",
      "dependencies": {
        "shared": "^1.0.0",
      },
    },
  },
  "packages": {
${hunks.diff3(
  `${row("shared", "shared@1.0.0")}\n`,
  `${row("shared", "shared@1.0.1")}\n`,
  `${row("shared", "shared@1.0.2")}\n`,
)}  }
}
`,
    });

    await succeed(String(dir), "install", "--lockfile-only");
    expect(registry.manifestRequests()).toEqual([]);
    expect(await file(join(String(dir), "bun.lock")).text()).toContain(`"shared": ["shared@1.0.1", `);
  });

  it("follows the side that moved a dependency to a range the other side does not know", async () => {
    using registry = serveRegistry();
    const { row } = registry;
    // Ours adds `left`. Theirs moves `shared` to the next major, on the line after it.
    using dir = createProject(registry, {
      ...project({ left: "1.0.0", shared: "^2.0.0" }),
      "bun.lock": `{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "app",
      "dependencies": {
${hunks.merge(`        "left": "1.0.0",\n        "shared": "^1.0.0",\n`, `        "shared": "^2.0.0",\n`)}      },
    },
  },
  "packages": {
${hunks.merge(
  `${row("left", "left@1.0.0")}\n\n${row("shared", "shared@1.0.2")}\n`,
  `${row("shared", "shared@2.0.0")}\n`,
)}  }
}
`,
    });

    await succeed(String(dir), "install", "--lockfile-only");
    expect(registry.manifestRequests()).toEqual([]);
    expect(await savedLockfile(registry, dir)).toMatchInlineSnapshot(`
      "{
        "lockfileVersion": 2,
        "configVersion": 1,
        "workspaces": {
          "": {
            "name": "app",
            "dependencies": {
              "left": "1.0.0",
              "shared": "^2.0.0",
            },
          },
        },
        "packages": {
          "left": ["left@1.0.0", "<registry>/left-1.0.0.tgz", {}, "<integrity>"],

          "shared": ["shared@2.0.0", "<registry>/shared-2.0.0.tgz", {}, "<integrity>"],
        }
      }
      "
    `);
  });

  it("merges two added packages that share a dependency", async () => {
    using registry = serveRegistry();
    const { row } = registry;
    using dir = createProject(registry, {
      ...project({ "uses-old": "1.0.0", "uses-old-too": "1.0.0" }),
      "bun.lock": `{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "app",
      "dependencies": {
${hunks.merge(`        "uses-old": "1.0.0",\n`, `        "uses-old-too": "1.0.0",\n`)}      },
    },
  },
  "packages": {
${row("shared", "shared@1.0.0")}

${hunks.merge(`${row("uses-old", "uses-old@1.0.0")}\n`, `${row("uses-old-too", "uses-old-too@1.0.0")}\n`)}  }
}
`,
    });

    await succeed(String(dir), "install", "--lockfile-only");
    expect(registry.manifestRequests()).toEqual([]);
    expect(await savedLockfile(registry, dir)).toMatchInlineSnapshot(`
      "{
        "lockfileVersion": 2,
        "configVersion": 1,
        "workspaces": {
          "": {
            "name": "app",
            "dependencies": {
              "uses-old": "1.0.0",
              "uses-old-too": "1.0.0",
            },
          },
        },
        "packages": {
          "shared": ["shared@1.0.0", "<registry>/shared-1.0.0.tgz", {}, "<integrity>"],

          "uses-old": ["uses-old@1.0.0", "<registry>/uses-old-1.0.0.tgz", { "dependencies": { "shared": "1.0.0" } }, "<integrity>"],

          "uses-old-too": ["uses-old-too@1.0.0", "<registry>/uses-old-too-1.0.0.tgz", { "dependencies": { "shared": "1.0.0" } }, "<integrity>"],
        }
      }
      "
    `);
  });

  it("merges the catalog and the overrides of both sides", async () => {
    using registry = serveRegistry();
    const { row } = registry;
    // Ours has `uses-old` and its `shared@1.0.0`. The override of theirs moves `shared` to 1.0.1 for every package.
    using dir = createProject(registry, {
      "package.json": JSON.stringify({
        name: "app",
        workspaces: {
          packages: ["packages/*"],
          catalog: { "kept": "1.0.0", "uses-new": "1.0.0", "uses-old": "1.0.0" },
        },
        overrides: { leaf: "1.0.0", shared: "1.0.1" },
      }),
      "packages/a/package.json": JSON.stringify({
        name: "a",
        dependencies: { "kept": "catalog:", "uses-new": "catalog:", "uses-old": "catalog:" },
      }),
      "bun.lock": `{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "app",
    },
    "packages/a": {
      "name": "a",
      "dependencies": {
        "kept": "catalog:",
${hunks.merge(`        "uses-old": "catalog:",\n`, `        "uses-new": "catalog:",\n`)}      },
    },
  },
  "overrides": {
${hunks.merge(`    "leaf": "1.0.0",\n`, `    "shared": "1.0.1",\n`)}  },
  "catalog": {
    "kept": "1.0.0",
${hunks.merge(`    "uses-old": "1.0.0",\n`, `    "uses-new": "1.0.0",\n`)}  },
  "packages": {
    "a": ["a@workspace:packages/a"],

${row("kept", "kept@1.0.0")}

${hunks.merge(
  `${row("shared", "shared@1.0.0")}\n\n${row("uses-old", "uses-old@1.0.0")}\n`,
  `${row("shared", "shared@1.0.1")}\n\n${row("uses-new", "uses-new@1.0.0")}\n`,
)}  }
}
`,
    });

    await succeed(String(dir), "install", "--lockfile-only");
    expect(registry.manifestRequests()).toEqual([]);
    expect(await savedLockfile(registry, dir)).toMatchInlineSnapshot(`
      "{
        "lockfileVersion": 2,
        "configVersion": 1,
        "workspaces": {
          "": {
            "name": "app",
          },
          "packages/a": {
            "name": "a",
            "dependencies": {
              "kept": "catalog:",
              "uses-new": "catalog:",
              "uses-old": "catalog:",
            },
          },
        },
        "overrides": {
          "leaf": "1.0.0",
          "shared": "1.0.1",
        },
        "catalog": {
          "kept": "1.0.0",
          "uses-new": "1.0.0",
          "uses-old": "1.0.0",
        },
        "packages": {
          "a": ["a@workspace:packages/a"],

          "kept": ["kept@1.0.0", "<registry>/kept-1.0.0.tgz", {}, "<integrity>"],

          "shared": ["shared@1.0.1", "<registry>/shared-1.0.1.tgz", {}, "<integrity>"],

          "uses-new": ["uses-new@1.0.0", "<registry>/uses-new-1.0.0.tgz", { "dependencies": { "shared": "2.0.0" } }, "<integrity>"],

          "uses-old": ["uses-old@1.0.0", "<registry>/uses-old-1.0.0.tgz", { "dependencies": { "shared": "1.0.0" } }, "<integrity>"],
        }
      }
      "
    `);
  });

  it("merges two workspaces that were added on two branches", async () => {
    using registry = serveRegistry();
    const { row } = registry;
    using dir = createProject(registry, {
      "package.json": JSON.stringify({ name: "app", workspaces: ["packages/*"] }),
      "packages/a/package.json": JSON.stringify({ name: "a", dependencies: { left: "1.0.0" } }),
      "packages/b/package.json": JSON.stringify({ name: "b", dependencies: { right: "1.0.0" } }),
      "bun.lock": `{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "app",
    },
${hunks.merge(
  `    "packages/a": {\n      "name": "a",\n      "dependencies": {\n        "left": "1.0.0",\n      },\n    },\n`,
  `    "packages/b": {\n      "name": "b",\n      "dependencies": {\n        "right": "1.0.0",\n      },\n    },\n`,
)}  },
  "packages": {
${hunks.merge(
  `    "a": ["a@workspace:packages/a"],\n\n${row("left", "left@1.0.0")}\n`,
  `    "b": ["b@workspace:packages/b"],\n\n${row("right", "right@1.0.0")}\n`,
)}  }
}
`,
    });

    await succeed(String(dir), "install", "--lockfile-only");
    expect(registry.manifestRequests()).toEqual([]);
    expect(await savedLockfile(registry, dir)).toMatchInlineSnapshot(`
      "{
        "lockfileVersion": 2,
        "configVersion": 1,
        "workspaces": {
          "": {
            "name": "app",
          },
          "packages/a": {
            "name": "a",
            "dependencies": {
              "left": "1.0.0",
            },
          },
          "packages/b": {
            "name": "b",
            "dependencies": {
              "right": "1.0.0",
            },
          },
        },
        "packages": {
          "a": ["a@workspace:packages/a"],

          "b": ["b@workspace:packages/b"],

          "left": ["left@1.0.0", "<registry>/left-1.0.0.tgz", {}, "<integrity>"],

          "right": ["right@1.0.0", "<registry>/right-1.0.0.tgz", {}, "<integrity>"],
        }
      }
      "
    `);
  });

  it("asks the registry only for what neither side locks", async () => {
    using registry = serveRegistry();
    const files = twoBranchesAddADependency(registry);
    // git merged the lines outside the hunks too. Here that lost `leaf`, which `has-leaf` depends on.
    files["bun.lock"] = withoutThePackageOfLeaf(registry, files["bun.lock"]);
    using dir = createProject(registry, {
      ...files,
      // package.json also has a dependency that no branch installed.
      ...project({ "extra": "1.0.0", "has-leaf": "1.0.0", "kept": "^1.0.0", "left": "1.0.0", "right": "1.0.0" }),
    });

    const { out, err } = await succeed(String(dir), "install", "--lockfile-only");
    expect(err).toContain(mergedNote);
    expect(registry.manifestRequests()).toEqual(["/extra", "/leaf"]);
    expect(normalizeBunSnapshot(out, dir)).toMatchInlineSnapshot(`
      "bun install <version> (<revision>)

      Saved bun.lock (7 packages)"
    `);
    expect(await savedLockfile(registry, dir)).toMatchInlineSnapshot(`
      "{
        "lockfileVersion": 2,
        "configVersion": 1,
        "workspaces": {
          "": {
            "name": "app",
            "dependencies": {
              "extra": "1.0.0",
              "has-leaf": "1.0.0",
              "kept": "^1.0.0",
              "left": "1.0.0",
              "right": "1.0.0",
            },
          },
        },
        "packages": {
          "extra": ["extra@1.0.0", "<registry>/extra-1.0.0.tgz", {}, "<integrity>"],

          "has-leaf": ["has-leaf@1.0.0", "<registry>/has-leaf-1.0.0.tgz", { "dependencies": { "leaf": "^1.0.0" } }, "<integrity>"],

          "kept": ["kept@1.0.0", "<registry>/kept-1.0.0.tgz", {}, "<integrity>"],

          "leaf": ["leaf@1.0.5", "<registry>/leaf-1.0.5.tgz", {}, "<integrity>"],

          "left": ["left@1.0.0", "<registry>/left-1.0.0.tgz", {}, "<integrity>"],

          "right": ["right@1.0.0", "<registry>/right-1.0.0.tgz", {}, "<integrity>"],
        }
      }
      "
    `);
  });

  // bun binds these to a package that is not in the range of the dependency. A merge must not take that for damage.
  it.each([
    [
      "an alias of its own name",
      { dependencies: { "kept": "1.0.0", "shared": "npm:shared@>=1.0.0", "uses-old": "1.0.0" } },
      `    "shared": ["shared@2.0.0", `,
    ],
    [
      "an alias that an override declares",
      { dependencies: { "has-leaf": "1.0.0", "kept": "1.0.0" }, overrides: { leaf: "npm:real@^1.0.0" } },
      `    "leaf": ["real@1.0.0", `,
    ],
    [
      "an alias that an override declares, past a rule for the package that asks",
      {
        dependencies: { "has-leaf": "1.0.0", "kept": "1.0.0" },
        overrides: { "has-leaf": { leaf: "1.0.5" }, "leaf": "npm:real@^1.0.0" },
      },
      `    "leaf": ["real@1.0.0", `,
    ],
    [
      "a tag of another package, past an override for its own name",
      {
        dependencies: { "has-leaf": "1.0.0", "kept": "1.0.0", "leaf": "npm:real@latest" },
        overrides: { leaf: "1.0.0" },
      },
      `    "leaf": ["real@2.0.0", `,
    ],
  ])("keeps the package of a dependency that follows %s", async (_, manifest, bound) => {
    using registry = serveRegistry();
    using dir = createProject(registry, { "package.json": JSON.stringify({ name: "app", ...manifest }) });
    const lockfilePath = join(String(dir), "bun.lock");
    await succeed(String(dir), "install", "--lockfile-only");
    const lockfile = await file(lockfilePath).text();
    expect(lockfile).toContain(bound);

    const row = lockfile.split("\n").find(line => line.startsWith(`    "kept": `))!;
    await write(lockfilePath, lockfile.replace(row + "\n", hunks.same(row + "\n")));
    // The manifests that the first install left in the cache would answer in the place of the registry.
    await rm(join(String(dir), ".bun-cache"), { recursive: true, force: true });
    registry.requests.length = 0;

    // A dependency without a package goes to the registry, and there is none.
    const { err } = await succeed(String(dir), "install", "--lockfile-only");
    expect(err).toContain(mergedNote);
    expect(registry.manifestRequests()).toEqual([]);
    expect(await file(lockfilePath).text()).toBe(lockfile);
  });

  it("takes the later lockfileVersion when the sides have two", async () => {
    using registry = serveRegistry();
    const files = twoBranchesAddADependency(registry);
    files["bun.lock"] = files["bun.lock"].replace(
      `  "lockfileVersion": 2,\n`,
      hunks.merge(`  "lockfileVersion": 2,\n`, `  "lockfileVersion": 1,\n`),
    );
    using dir = createProject(registry, files);

    await succeed(String(dir), "install", "--lockfile-only");
    expect(registry.manifestRequests()).toEqual([]);
    const lockfile = await file(join(String(dir), "bun.lock")).text();
    expect(lockfile).toContain(`  "lockfileVersion": 2,\n`);
    expect(lockfile).toContain(`"kept": ["kept@1.0.0", `);
  });

  it("loads at the earlier lockfileVersion what the later one does not take", async () => {
    using registry = serveRegistry();
    const files = twoBranchesAddADependency(registry);
    // A tarball that is not on the registry and has no hash: lockfileVersion 1 takes it, 2 does not.
    const unhashed = `    "kept": ["kept@1.0.0", "http://127.0.0.1:1/kept-1.0.0.tgz", {}, ""],`;
    files["bun.lock"] = files["bun.lock"]
      .replace(`  "lockfileVersion": 2,\n`, hunks.merge(`  "lockfileVersion": 1,\n`, `  "lockfileVersion": 2,\n`))
      .replace(registry.row("kept", "kept@1.0.0"), unhashed);
    using dir = createProject(registry, files);

    const { err } = await succeed(String(dir), "install", "--lockfile-only");
    expect(err).toContain(mergedNote);
    expect(registry.manifestRequests()).toEqual([]);
    const lockfile = await file(join(String(dir), "bun.lock")).text();
    expect(lockfile).toContain(`  "lockfileVersion": 1,\n`);
    expect(lockfile).toContain(unhashed);
    expect(lockfile).toContain(`"left": ["left@1.0.0", `);
    expect(lockfile).toContain(`"right": ["right@1.0.0", `);
  });

  it.each([[["install", "--frozen-lockfile"]], [["ci"]], [["install", "--production"]]])(
    "bun %p fails and leaves bun.lock as it is",
    async args => {
      using registry = serveRegistry();
      const files = twoBranchesAddADependency(registry);
      using dir = createProject(registry, files);

      const { out, err, code } = await run(String(dir), ...args);
      expect(normalizeBunSnapshot(err, dir)).toMatchInlineSnapshot(`
        "error: bun.lock contains git merge conflict markers, but lockfile is frozen
        note: run bun install to merge both sides, then commit the updated bun.lock"
      `);
      expect(normalizeBunSnapshot(out, dir)).toMatchInlineSnapshot(`"bun install <version> (<revision>)"`);
      expect(code).toBe(1);
      expect(registry.requests).toEqual([]);
      expect(await file(join(String(dir), "bun.lock")).text()).toBe(files["bun.lock"]);
    },
  );

  it.each([["--dry-run"], ["--no-save"]])("bun install %s uses the merge and does not save it", async flag => {
    using registry = serveRegistry();
    const files = twoBranchesAddADependency(registry);
    using dir = createProject(registry, files);

    const { err } = await succeed(String(dir), "install", flag);
    expect(err).toContain(
      "note: bun.lock contains git merge conflict markers, using the merge of both sides. bun.lock is not saved\n",
    );
    expect(err).not.toContain("Saved lockfile");
    expect(registry.manifestRequests()).toEqual([]);
    expect(await file(join(String(dir), "bun.lock")).text()).toBe(files["bun.lock"]);
  });

  it("commands that only read the lockfile read the merge", async () => {
    using registry = serveRegistry();
    const files = twoBranchesAddADependency(registry);
    using dir = createProject(registry, files);

    const { out, err, code } = await run(String(dir), "pm", "ls");
    expect(normalizeBunSnapshot(err, dir)).toMatchInlineSnapshot(
      `"note: bun.lock contains git merge conflict markers, reading the merge of both sides. Run bun install to save it"`,
    );
    expect(normalizeBunSnapshot(out, dir)).toMatchInlineSnapshot(`
      "<dir> node_modules (3 installed)
      ├── kept@1.0.0
      ├── left@1.0.0
      └── right@1.0.0"
    `);
    expect(code).toBe(0);
    expect(registry.requests).toEqual([]);
    expect(await file(join(String(dir), "bun.lock")).text()).toBe(files["bun.lock"]);
  });

  it.each([[["why", "kept"]], [["outdated"]]])("bun %p reads the merge", async args => {
    using registry = serveRegistry();
    const files = twoBranchesAddADependency(registry);
    using dir = createProject(registry, files);

    const { out, err, code } = await run(String(dir), ...args);
    expect(err.split("\n").filter(line => line.startsWith("note: "))).toEqual([
      "note: bun.lock contains git merge conflict markers, reading the merge of both sides. Run bun install to save it",
    ]);
    expect(err).not.toContain("error:");
    expect(out).toContain("kept");
    expect(code).toBe(0);
    expect(await file(join(String(dir), "bun.lock")).text()).toBe(files["bun.lock"]);
  });

  it("a command that resolves nothing does not read a merge that lacks a package", async () => {
    using registry = serveRegistry();
    const files = twoBranchesAddADependency(registry);
    files["bun.lock"] = withoutThePackageOfLeaf(registry, files["bun.lock"]);
    using dir = createProject(registry, files);

    const { err, code } = await run(String(dir), "pm", "ls");
    expect(normalizeBunSnapshot(err, dir)).toMatchInlineSnapshot(`
      "note: bun.lock contains git merge conflict markers. Run bun install to merge both sides
      error: failed to parse lockfile: ParserError"
    `);
    expect(code).toBe(1);
    expect(registry.requests).toEqual([]);
  });

  // They change the lockfile and do not compare it with package.json first.
  it.each([
    [["pm", "trust", "kept"], "bun.lock contains git merge conflict markers"],
    [["audit", "fix"], "bun.lock contains git merge conflict markers"],
    [["dedupe"], "bun.lock contains git merge conflict markers, nothing to dedupe"],
  ])("bun %p tells to run bun install first", async (args, message) => {
    using registry = serveRegistry();
    const files = twoBranchesAddADependency(registry);
    using dir = createProject(registry, files);

    const { err, code } = await run(String(dir), ...args);
    expect(err).toContain(`error: ${message}\n`);
    expect(err.split("\n").filter(line => line.startsWith("note: "))).toEqual(["note: run 'bun install' first"]);
    expect(code).toBe(1);
    expect(registry.requests).toEqual([]);
    expect(await file(join(String(dir), "bun.lock")).text()).toBe(files["bun.lock"]);
  });

  it("bun pm pack does not merge", async () => {
    using registry = serveRegistry();
    const files = twoBranchesAddADependency(registry);
    using dir = createProject(registry, files);

    const { err, code } = await run(String(dir), "pm", "pack", "--dry-run");
    expect(err).toContain(`error: Expected string but found "<<<<<<<"`);
    expect(err).toContain("error: failed to parse lockfile: ParserError");
    expect(err).not.toContain("merge");
    expect(code).toBe(1);
    expect(await file(join(String(dir), "bun.lock")).text()).toBe(files["bun.lock"]);
  });

  it("leaves the conflict markers of package.json to the person", async () => {
    using registry = serveRegistry();
    const files = twoBranchesAddADependency(registry);
    files["package.json"] = `{
  "name": "app",
  "dependencies": {
    "kept": "^1.0.0",
${hunks.merge(`    "left": "1.0.0"\n`, `    "right": "1.0.0"\n`)}  }
}
`;
    using dir = createProject(registry, files);

    const { err, code } = await run(String(dir), "install");
    expect(err).toContain("package.json:5:1");
    expect(err).toContain("ParserError: failed to parse '");
    expect(err).not.toContain("Saved lockfile");
    expect(code).toBe(1);
    expect(registry.requests).toEqual([]);
    expect(await file(join(String(dir), "bun.lock")).text()).toBe(files["bun.lock"]);
  });

  // An install does with them what it does with every lockfile that does not parse, and says why.
  it.each([
    [
      "a marker that nothing closes",
      (text: string) => text.replace(">>>>>>> feature\n", ""),
      "the markers do not pair up",
    ],
    [
      "a side that is not JSON",
      (text: string) => text.replace("=======\n", "=======\n    not json\n"),
      "one side is not JSON",
    ],
    [
      "two hashes for one version",
      (text: string, kept: string) =>
        text.replace(kept, hunks.merge(kept, kept.replace(/"sha512-[^"]+"/, `"${otherHash}"`))),
      "one package has two tarballs or two integrity hashes (kept@1.0.0)",
    ],
    [
      "two hashes for one tarball",
      (text: string, kept: string, tarball: string, hash: string) =>
        text.replace(
          kept,
          hunks.merge(
            `    "kept": ["kept@${tarball}", {}, "${hash}"],\n`,
            `    "kept": ["kept@${tarball}", {}, "${otherHash}"],\n`,
          ),
        ),
      "one package has two tarballs or two integrity hashes (kept@<registry>/kept-1.0.0.tgz)",
    ],
    [
      "a tarball and a package of the registry at one path",
      (text: string, kept: string, tarball: string, hash: string) =>
        text.replace(kept, hunks.merge(`    "kept": ["kept@${tarball}", {}, "${hash}"],\n`, kept)),
      "the sides have two packages at one path, and one of them is not from the registry (kept)",
    ],
    [
      "a side that nests deeper than a lockfile",
      (text: string) =>
        text.replace(`  "packages": {\n`, `  "deep": ${'{"a":'.repeat(70)}1${"}".repeat(70)},\n  "packages": {\n`),
      "one side is not a lockfile",
    ],
    [
      // The loader has read the alias of the override by then. The install that follows must not know it.
      "a row that the loader does not take",
      (text: string, kept: string) =>
        text
          .replace(kept, hunks.same(kept.replace(/, "sha512-[^"]+"/, "")))
          .replace(
            `  "packages": {\n`,
            `  "overrides": {\n    "kept": "npm:uses-old-too@1.0.0",\n  },\n  "packages": {\n`,
          ),
      "the merge of both sides does not load",
    ],
    [
      "the lockfileVersion of a later bun",
      (text: string) =>
        text.replace(
          `  "lockfileVersion": 2,\n`,
          hunks.merge(`  "lockfileVersion": 2,\n`, `  "lockfileVersion": 99,\n`),
        ),
      "one side has a lockfileVersion that this version of bun does not read",
    ],
  ])("does not merge %s", async (_, damage, reason) => {
    using registry = serveRegistry();
    const files = twoBranchesAddADependency(registry);
    const damaged = damage(
      files["bun.lock"],
      registry.row("kept", "kept@1.0.0") + "\n",
      `${registry.origin}/kept-1.0.0.tgz`,
      integrity.get("kept@1.0.0")!,
    );
    expect(damaged).not.toBe(files["bun.lock"]);
    using dir = createProject(registry, { ...files, "bun.lock": damaged });

    const { err, code } = await run(String(dir), "install", "--lockfile-only");
    expect(err.replaceAll(registry.origin, "<registry>")).toContain(
      `note: bun.lock contains git merge conflict markers that bun cannot merge: ${reason}\n`,
    );
    expect(err).toContain("ParserError: failed to parse lockfile: 'bun.lock'");
    expect(err).toContain("warn: Ignoring lockfile");
    expect(code).toBe(0);
    // Resolved again: the version that both sides lock is lost.
    expect(await file(join(String(dir), "bun.lock")).text()).toContain(`"kept": ["kept@1.1.0", `);
  });

  it("a frozen install fails on a lockfile that it cannot merge", async () => {
    using registry = serveRegistry();
    const files = twoBranchesAddADependency(registry);
    files["bun.lock"] = files["bun.lock"].replace(">>>>>>> feature\n", "");
    using dir = createProject(registry, files);

    const { err, code } = await run(String(dir), "install", "--frozen-lockfile");
    expect(err).toContain(
      "note: bun.lock contains git merge conflict markers that bun cannot merge: the markers do not pair up\n",
    );
    expect(err).toContain("warn: Ignoring lockfile");
    expect(err).toContain("error: lockfile had changes, but lockfile is frozen");
    expect(code).toBe(1);
    expect(await file(join(String(dir), "bun.lock")).text()).toBe(files["bun.lock"]);
  });

  it("keeps one declaration when a side moved a dependency to another group", async () => {
    using registry = serveRegistry();
    const { row } = registry;
    // Ours has `shared` in "dependencies". Theirs moved it to "devDependencies" and to the next major.
    using dir = createProject(registry, {
      ...project({ shared: "^1.0.0" }),
      "bun.lock": `{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "app",
${hunks.merge(
  `      "dependencies": {\n        "shared": "^1.0.0",\n      },\n`,
  `      "devDependencies": {\n        "shared": "^2.0.0",\n      },\n`,
)}    },
  },
  "packages": {
${hunks.merge(`${row("shared", "shared@1.0.1")}\n`, `${row("shared", "shared@2.0.0")}\n`)}  }
}
`,
    });

    // package.json kept what ours has. Ours locks 1.0.1, and the registry has 1.0.2.
    await succeed(String(dir), "install", "--lockfile-only");
    expect(registry.manifestRequests()).toEqual(["/shared"]);
    expect(await savedLockfile(registry, dir)).toMatchInlineSnapshot(`
      "{
        "lockfileVersion": 2,
        "configVersion": 1,
        "workspaces": {
          "": {
            "name": "app",
            "dependencies": {
              "shared": "^1.0.0",
            },
          },
        },
        "packages": {
          "shared": ["shared@1.0.1", "<registry>/shared-1.0.1.tgz", {}, "<integrity>"],
        }
      }
      "
    `);
  });

  it("keeps the version of the side whose range package.json kept", async () => {
    using registry = serveRegistry();
    const { row } = registry;
    // Ours adds `left`. Theirs moves `shared` to the next major, on the line after it.
    using dir = createProject(registry, {
      ...project({ left: "1.0.0", shared: "^1.0.0" }),
      "bun.lock": `{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "app",
      "dependencies": {
${hunks.merge(`        "left": "1.0.0",\n        "shared": "^1.0.0",\n`, `        "shared": "^2.0.0",\n`)}      },
    },
  },
  "packages": {
${hunks.merge(
  `${row("left", "left@1.0.0")}\n\n${row("shared", "shared@1.0.1")}\n`,
  `${row("shared", "shared@2.0.0")}\n`,
)}  }
}
`,
    });

    await succeed(String(dir), "install", "--lockfile-only");
    // The resolver reads the manifest of a dependency before it takes a package for it.
    expect(registry.manifestRequests()).toEqual(["/shared"]);
    expect(await savedLockfile(registry, dir)).toMatchInlineSnapshot(`
      "{
        "lockfileVersion": 2,
        "configVersion": 1,
        "workspaces": {
          "": {
            "name": "app",
            "dependencies": {
              "left": "1.0.0",
              "shared": "^1.0.0",
            },
          },
        },
        "packages": {
          "left": ["left@1.0.0", "<registry>/left-1.0.0.tgz", {}, "<integrity>"],

          "shared": ["shared@1.0.1", "<registry>/shared-1.0.1.tgz", {}, "<integrity>"],
        }
      }
      "
    `);
  });

  it("keeps the version of the side whose catalog package.json kept", async () => {
    using registry = serveRegistry();
    const { row } = registry;
    using dir = createProject(registry, {
      "package.json": JSON.stringify({
        name: "app",
        workspaces: { packages: ["packages/*"], catalog: { shared: "^1.0.0" } },
      }),
      "packages/a/package.json": JSON.stringify({ name: "a", dependencies: { shared: "catalog:" } }),
      "bun.lock": `{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "app",
    },
    "packages/a": {
      "name": "a",
      "dependencies": {
        "shared": "catalog:",
      },
    },
  },
  "catalog": {
${hunks.merge(`    "shared": "^2.0.0",\n`, `    "shared": "^1.0.0",\n`)}  },
  "packages": {
    "a": ["a@workspace:packages/a"],

${hunks.merge(`${row("shared", "shared@2.0.0")}\n`, `${row("shared", "shared@1.0.1")}\n`)}  }
}
`,
    });

    await succeed(String(dir), "install", "--lockfile-only");
    expect(registry.manifestRequests()).toEqual(["/shared"]);
    const lockfile = await file(join(String(dir), "bun.lock")).text();
    expect(lockfile).toContain(`"shared": "^1.0.0",`);
    expect(lockfile).toContain(`"shared": ["shared@1.0.1", `);
    expect(lockfile).not.toContain("shared@2.0.0");
  });

  it("takes what is below a path from the side whose package keeps the path", async () => {
    using registry = serveRegistry();
    const { row } = registry;
    // Ours has `outer@1.0.0` with a `leaf@1.0.0` of its own, and `packs@1.0.0`, which has `leaf@1.0.0` in its tarball.
    // Theirs has the next version of both. They take the `leaf@1.0.5` of the root.
    using dir = createProject(registry, {
      ...project({ leaf: "1.0.5", outer: "^1.0.0", packs: ">=1.0.0" }),
      "bun.lock": `{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "app",
      "dependencies": {
        "leaf": "1.0.5",
        "outer": "^1.0.0",
        "packs": ">=1.0.0",
      },
    },
  },
  "packages": {
${row("leaf", "leaf@1.0.5")}

${hunks.merge(
  [
    row("outer", "outer@1.0.0"),
    row("outer/leaf", "leaf@1.0.0"),
    row("packs", "packs@1.0.0", { dependencies: { leaf: "1.0.0" } }),
    row("packs/leaf", "leaf@1.0.0", { bundled: true }),
  ].join("\n\n") + "\n",
  [row("outer", "outer@1.1.0"), row("packs", "packs@2.0.0")].join("\n\n") + "\n",
)}  }
}
`,
    });

    await succeed(String(dir), "install", "--lockfile-only");
    expect(registry.manifestRequests()).toEqual([]);
    expect(await savedLockfile(registry, dir)).toMatchInlineSnapshot(`
      "{
        "lockfileVersion": 2,
        "configVersion": 1,
        "workspaces": {
          "": {
            "name": "app",
            "dependencies": {
              "leaf": "1.0.5",
              "outer": "^1.0.0",
              "packs": ">=1.0.0",
            },
          },
        },
        "packages": {
          "leaf": ["leaf@1.0.5", "<registry>/leaf-1.0.5.tgz", {}, "<integrity>"],

          "outer": ["outer@1.1.0", "<registry>/outer-1.1.0.tgz", { "dependencies": { "leaf": "^1.0.0" } }, "<integrity>"],

          "packs": ["packs@2.0.0", "<registry>/packs-2.0.0.tgz", { "dependencies": { "leaf": "^1.0.5" } }, "<integrity>"],
        }
      }
      "
    `);
  });

  it("keeps what is below a package that lost its path", async () => {
    using registry = serveRegistry();
    const { row } = registry;
    // Ours pins `outer` to 1.0.0, which has a `leaf@1.0.0` of its own. Theirs took the next version.
    using dir = createProject(registry, {
      ...project({ leaf: "1.0.5", outer: "1.0.0" }),
      "bun.lock": `{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "app",
      "dependencies": {
        "leaf": "1.0.5",
${hunks.merge(`        "outer": "1.0.0",\n`, `        "outer": "^1.0.0",\n`)}      },
    },
  },
  "packages": {
${row("leaf", "leaf@1.0.5")}

${hunks.merge(
  `${row("outer", "outer@1.0.0")}\n\n${row("outer/leaf", "leaf@1.0.0")}\n`,
  `${row("outer", "outer@1.1.0")}\n`,
)}  }
}
`,
    });

    await succeed(String(dir), "install", "--lockfile-only");
    expect(registry.manifestRequests()).toEqual(["/outer"]);
    expect(await savedLockfile(registry, dir)).toMatchInlineSnapshot(`
      "{
        "lockfileVersion": 2,
        "configVersion": 1,
        "workspaces": {
          "": {
            "name": "app",
            "dependencies": {
              "leaf": "1.0.5",
              "outer": "1.0.0",
            },
          },
        },
        "packages": {
          "leaf": ["leaf@1.0.5", "<registry>/leaf-1.0.5.tgz", {}, "<integrity>"],

          "outer": ["outer@1.0.0", "<registry>/outer-1.0.0.tgz", { "dependencies": { "leaf": "^1.0.0" } }, "<integrity>"],

          "outer/leaf": ["leaf@1.0.0", "<registry>/leaf-1.0.0.tgz", {}, "<integrity>"],
        }
      }
      "
    `);
  });

  it("gives a dependency the version that its side locked, not the highest of the merge", async () => {
    using registry = serveRegistry();
    const { row } = registry;
    // Ours: workspace `a` takes `shared@1.0.0` from the root. Theirs: the root has 2.0.0, and workspace `b` has 1.0.2.
    using dir = createProject(registry, {
      "package.json": JSON.stringify({
        name: "app",
        workspaces: ["packages/*"],
        dependencies: { "uses-new": "1.0.0" },
      }),
      "packages/a/package.json": JSON.stringify({ name: "a", dependencies: { shared: "^1.0.0" } }),
      "packages/b/package.json": JSON.stringify({ name: "b", dependencies: { shared: "1.0.2" } }),
      "bun.lock": `{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "app",
${hunks.merge(
  `    },\n    "packages/a": {\n      "name": "a",\n      "dependencies": {\n        "shared": "^1.0.0",\n      },\n    },\n`,
  `      "dependencies": {\n        "uses-new": "1.0.0",\n      },\n    },\n    "packages/b": {\n      "name": "b",\n      "dependencies": {\n        "shared": "1.0.2",\n      },\n    },\n`,
)}  },
  "packages": {
${hunks.merge(
  `    "a": ["a@workspace:packages/a"],\n\n${row("shared", "shared@1.0.0")}\n`,
  `    "b": ["b@workspace:packages/b"],\n\n${row("b/shared", "shared@1.0.2")}\n\n${row("shared", "shared@2.0.0")}\n\n${row("uses-new", "uses-new@1.0.0")}\n`,
)}  }
}
`,
    });

    await succeed(String(dir), "install", "--lockfile-only");
    expect(registry.manifestRequests()).toEqual([]);
    expect(await savedLockfile(registry, dir)).toMatchInlineSnapshot(`
      "{
        "lockfileVersion": 2,
        "configVersion": 1,
        "workspaces": {
          "": {
            "name": "app",
            "dependencies": {
              "uses-new": "1.0.0",
            },
          },
          "packages/a": {
            "name": "a",
            "dependencies": {
              "shared": "^1.0.0",
            },
          },
          "packages/b": {
            "name": "b",
            "dependencies": {
              "shared": "1.0.2",
            },
          },
        },
        "packages": {
          "a": ["a@workspace:packages/a"],

          "b": ["b@workspace:packages/b"],

          "shared": ["shared@1.0.0", "<registry>/shared-1.0.0.tgz", {}, "<integrity>"],

          "uses-new": ["uses-new@1.0.0", "<registry>/uses-new-1.0.0.tgz", { "dependencies": { "shared": "2.0.0" } }, "<integrity>"],

          "b/shared": ["shared@1.0.2", "<registry>/shared-1.0.2.tgz", {}, "<integrity>"],

          "uses-new/shared": ["shared@2.0.0", "<registry>/shared-2.0.0.tgz", {}, "<integrity>"],
        }
      }
      "
    `);
  });

  it("keeps the packages of a workspace that one side moved", async () => {
    using registry = serveRegistry();
    const { row } = registry;
    // Ours moved workspace `a` to packages/alpha. Theirs gave it the dependency `leaf`.
    using dir = createProject(registry, {
      "package.json": JSON.stringify({ name: "app", workspaces: ["packages/*"] }),
      "packages/alpha/package.json": JSON.stringify({ name: "a", dependencies: { kept: "1.0.0", leaf: "^1.0.0" } }),
      "bun.lock": `{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "app",
    },
${hunks.merge(
  `    "packages/alpha": {\n      "name": "a",\n      "dependencies": {\n        "kept": "1.0.0",\n      },\n    },\n`,
  `    "packages/a": {\n      "name": "a",\n      "dependencies": {\n        "kept": "1.0.0",\n        "leaf": "^1.0.0",\n      },\n    },\n`,
)}  },
  "packages": {
${hunks.merge(`    "a": ["a@workspace:packages/alpha"],\n`, `    "a": ["a@workspace:packages/a"],\n`)}
${row("kept", "kept@1.0.0")}

${row("leaf", "leaf@1.0.0")}
  }
}
`,
    });

    await succeed(String(dir), "install", "--lockfile-only");
    // The dependencies of a workspace that changed are resolved again, and take what the lockfile has.
    expect(registry.manifestRequests()).toEqual(["/kept", "/leaf"]);
    const lockfile = await file(join(String(dir), "bun.lock")).text();
    expect(lockfile).toContain(`"a": ["a@workspace:packages/alpha"],`);
    expect(lockfile).toContain(`"leaf": ["leaf@1.0.0", `);
  });

  it("does not take the alias of an override for one package as the alias of all", async () => {
    using registry = serveRegistry();
    const { row } = registry;
    const hasLeaf = row("has-leaf", "has-leaf@1.0.0") + "\n";
    const overrides = { "has-leaf": { leaf: "npm:real@^1.0.0" } };
    // The `leaf` of `has-leaf` is `real`. git lost the row of the `leaf` that workspace `a` asks for.
    using dir = createProject(registry, {
      "package.json": JSON.stringify({
        name: "app",
        workspaces: ["packages/*"],
        dependencies: { "has-leaf": "1.0.0" },
        overrides,
      }),
      "packages/a/package.json": JSON.stringify({ name: "a", dependencies: { leaf: "^1.0.0" } }),
      "bun.lock": `{
  "lockfileVersion": 3,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "app",
      "dependencies": {
        "has-leaf": "1.0.0",
      },
    },
    "packages/a": {
      "name": "a",
      "dependencies": {
        "leaf": "^1.0.0",
      },
    },
  },
  "overrides": {
    "has-leaf": {
      "leaf": "npm:real@^1.0.0",
    },
  },
  "packages": {
    "a": ["a@workspace:packages/a"],

${hunks.same(hasLeaf)}
${row("leaf", "real@1.0.0")}
  }
}
`,
    });

    await succeed(String(dir), "install", "--lockfile-only");
    expect(registry.manifestRequests()).toEqual(["/leaf"]);
    const lockfile = await file(join(String(dir), "bun.lock")).text();
    // The `leaf` of the workspace is at the root now, so the one of `has-leaf` is below `has-leaf`.
    expect(lockfile).toContain(`"leaf": ["leaf@1.0.5", `);
    expect(lockfile).toContain(`"has-leaf/leaf": ["real@1.0.0", `);
  });

  it("resolves a dependency on a workspace that the merge does not list", async () => {
    using registry = serveRegistry();
    const { row } = registry;
    const kept = row("kept", "kept@1.0.0") + "\n";
    // git took the dependency on `b` from one side and lost the workspace itself: 2 of 134 merges of bun's own lockfiles.
    using dir = createProject(registry, {
      "package.json": JSON.stringify({
        name: "app",
        workspaces: ["packages/*"],
        dependencies: { b: "workspace:*", kept: "^1.0.0" },
      }),
      "packages/b/package.json": JSON.stringify({ name: "b", version: "1.0.0", dependencies: { left: "1.0.0" } }),
      "bun.lock": `{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "app",
      "dependencies": {
        "b": "workspace:*",
        "kept": "^1.0.0",
      },
    },
  },
  "packages": {
${hunks.same(kept)}  }
}
`,
    });

    await succeed(String(dir), "install", "--lockfile-only");
    expect(registry.manifestRequests()).toEqual(["/left"]);
    const lockfile = await file(join(String(dir), "bun.lock")).text();
    expect(lockfile).toContain(`"b": ["b@workspace:packages/b"],`);
    expect(lockfile).toContain(`"kept": ["kept@1.0.0", `);
    expect(lockfile).toContain(`"left": ["left@1.0.0", `);
  });

  it("merges scoped packages", async () => {
    using registry = serveRegistry();
    const { row } = registry;
    using dir = createProject(registry, {
      ...project({ "uses-scoped-new": "1.0.0", "uses-scoped-old": "1.0.0" }),
      "bun.lock": `{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "app",
      "dependencies": {
${hunks.merge(`        "uses-scoped-new": "1.0.0",\n`, `        "uses-scoped-old": "1.0.0",\n`)}      },
    },
  },
  "packages": {
${hunks.merge(
  `${row("@scope/shared", "@scope/shared@2.0.0")}\n\n${row("uses-scoped-new", "uses-scoped-new@1.0.0")}\n`,
  `${row("@scope/shared", "@scope/shared@1.0.0")}\n\n${row("uses-scoped-old", "uses-scoped-old@1.0.0")}\n`,
)}  }
}
`,
    });

    await succeed(String(dir), "install", "--lockfile-only");
    expect(registry.manifestRequests()).toEqual([]);
    expect(await savedLockfile(registry, dir)).toMatchInlineSnapshot(`
      "{
        "lockfileVersion": 2,
        "configVersion": 1,
        "workspaces": {
          "": {
            "name": "app",
            "dependencies": {
              "uses-scoped-new": "1.0.0",
              "uses-scoped-old": "1.0.0",
            },
          },
        },
        "packages": {
          "@scope/shared": ["@scope/shared@2.0.0", "<registry>/@scope/shared-2.0.0.tgz", {}, "<integrity>"],

          "uses-scoped-new": ["uses-scoped-new@1.0.0", "<registry>/uses-scoped-new-1.0.0.tgz", { "dependencies": { "@scope/shared": "2.0.0" } }, "<integrity>"],

          "uses-scoped-old": ["uses-scoped-old@1.0.0", "<registry>/uses-scoped-old-1.0.0.tgz", { "dependencies": { "@scope/shared": "1.0.0" } }, "<integrity>"],

          "uses-scoped-old/@scope/shared": ["@scope/shared@1.0.0", "<registry>/@scope/shared-1.0.0.tgz", {}, "<integrity>"],
        }
      }
      "
    `);
  });

  it("does not leave a range with the tarball that another dependency has at the path", async () => {
    using registry = serveRegistry();
    const { row } = registry;
    const tarball = `${registry.origin}/shared-2.0.0.tgz`;
    const kept = row("kept", "kept@1.0.0") + "\n";
    // The root takes `shared` from a tarball. git put `uses-old` next to it, and that looks for `shared@1.0.0` at the same path.
    using dir = createProject(registry, {
      ...project({ "kept": "1.0.0", "shared": tarball, "uses-old": "1.0.0" }),
      "bun.lock": `{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "app",
      "dependencies": {
        "kept": "1.0.0",
        "shared": "${tarball}",
        "uses-old": "1.0.0",
      },
    },
  },
  "packages": {
${hunks.same(kept)}
    "shared": ["shared@${tarball}", {}, "${integrity.get("shared@2.0.0")}"],

${row("uses-old", "uses-old@1.0.0")}
  }
}
`,
    });

    await succeed(String(dir), "install", "--lockfile-only");
    expect(registry.manifestRequests()).toEqual(["/shared"]);
    const lockfile = await savedLockfile(registry, dir);
    expect(lockfile).toContain(`"shared": ["shared@<registry>/shared-2.0.0.tgz", `);
    expect(lockfile).toContain(`"uses-old/shared": ["shared@1.0.0", `);
  });

  it("does not let a peer dependency speak for a dependency of the same name", async () => {
    using registry = serveRegistry();
    const { row } = registry;
    const kept = row("kept", "kept@1.0.0") + "\n";
    // git left `shared@2.0.0` for a root that asks for ^1.0.0. The range of the peer takes 2.0.0.
    const manifest = {
      name: "app",
      dependencies: { kept: "1.0.0" },
      devDependencies: { shared: "^1.0.0" },
      peerDependencies: { shared: ">=1.0.0" },
    };
    using dir = createProject(registry, {
      "package.json": JSON.stringify(manifest),
      "bun.lock": `{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "app",
      "dependencies": {
        "kept": "1.0.0",
      },
      "devDependencies": {
        "shared": "^1.0.0",
      },
      "peerDependencies": {
        "shared": ">=1.0.0",
      },
    },
  },
  "packages": {
${hunks.same(kept)}
${row("shared", "shared@2.0.0")}
  }
}
`,
    });

    await succeed(String(dir), "install", "--lockfile-only");
    expect(registry.manifestRequests()).toEqual(["/shared"]);
    const lockfile = await file(join(String(dir), "bun.lock")).text();
    expect(lockfile).toContain(`"shared": ["shared@1.0.2", `);
    expect(lockfile).not.toContain("shared@2.0.0");
  });

  it("resolves the dependencies of a package that the resolver takes from the merge", async () => {
    using registry = serveRegistry();
    const { row } = registry;
    // git took the `helper@2.0.0` of theirs, so the `tool@1.0.0` of ours has no `helper` that fits.
    // package.json has a new dependency that needs just that `tool@1.0.0`.
    using dir = createProject(registry, {
      ...project({ "needs-old-tool": "1.0.0", "tool": "^1.0.0" }),
      "bun.lock": `{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "app",
      "dependencies": {
        "tool": "^1.0.0",
      },
    },
  },
  "packages": {
${row("helper", "helper@2.0.0")}

${hunks.merge(`${row("tool", "tool@1.0.0")}\n`, `${row("tool", "tool@1.1.0")}\n`)}  }
}
`,
    });

    await succeed(String(dir), "install", "--lockfile-only");
    expect(registry.manifestRequests()).toEqual(["/helper", "/needs-old-tool", "/tool"]);
    expect(await savedLockfile(registry, dir)).toMatchInlineSnapshot(`
      "{
        "lockfileVersion": 2,
        "configVersion": 1,
        "workspaces": {
          "": {
            "name": "app",
            "dependencies": {
              "needs-old-tool": "1.0.0",
              "tool": "^1.0.0",
            },
          },
        },
        "packages": {
          "helper": ["helper@2.0.0", "<registry>/helper-2.0.0.tgz", {}, "<integrity>"],

          "needs-old-tool": ["needs-old-tool@1.0.0", "<registry>/needs-old-tool-1.0.0.tgz", { "dependencies": { "tool": "1.0.0" } }, "<integrity>"],

          "tool": ["tool@1.1.0", "<registry>/tool-1.1.0.tgz", { "dependencies": { "helper": "^2.0.0" } }, "<integrity>"],

          "needs-old-tool/tool": ["tool@1.0.0", "<registry>/tool-1.0.0.tgz", { "dependencies": { "helper": "^1.0.0" } }, "<integrity>"],

          "needs-old-tool/tool/helper": ["helper@1.0.0", "<registry>/helper-1.0.0.tgz", {}, "<integrity>"],
        }
      }
      "
    `);
  });

  it("keeps the configVersion of the sides, and the linker that comes with it", async () => {
    using registry = serveRegistry();
    const { row } = registry;
    using dir = tempDir("bun-lock-conflict-", {
      "package.json": JSON.stringify({
        name: "app",
        workspaces: ["packages/*"],
        dependencies: { kept: "^1.0.0", left: "1.0.0", right: "1.0.0" },
      }),
      "packages/a/package.json": JSON.stringify({ name: "a" }),
      // No linker here. With workspaces, configVersion 1 takes the isolated one.
      "bunfig.toml": Bun.TOML.stringify({ install: { registry: registry.url } }),
      "bun.lock": `{
  "lockfileVersion": 2,
  "configVersion": 0,
  "workspaces": {
    "": {
      "name": "app",
      "dependencies": {
        "kept": "^1.0.0",
${hunks.merge(`        "left": "1.0.0",\n`, `        "right": "1.0.0",\n`)}      },
    },
    "packages/a": {
      "name": "a",
    },
  },
  "packages": {
    "a": ["a@workspace:packages/a"],

${row("kept", "kept@1.0.0")}
${hunks.merge(`\n${row("left", "left@1.0.0")}\n`, `\n${row("right", "right@1.0.0")}\n`)}  }
}
`,
    });

    await succeed(String(dir), "install");
    expect(await file(join(String(dir), "bun.lock")).text()).toContain(`  "configVersion": 0,\n`);
    expect(await exists(join(String(dir), "node_modules", "kept", "package.json"))).toBe(true);
    expect(await exists(join(String(dir), "node_modules", ".bun"))).toBe(false);
  });

  it("leaves alone what a range cannot answer", async () => {
    using registry = serveRegistry();
    const { row } = registry;
    const kept = row("kept", "kept@1.0.0") + "\n";
    // `uses-alias-name` asks for `aliased@^2.0.0` and gets `real@2.0.0` through the alias of the root.
    // `has-optional` finds `shared@2.0.0` where it looks for its optional `shared@^1.0.0`, and the lockfile has no other.
    // `has-peer` is bound to the `shared@2.0.0` that is there for its peer `shared@^5.0.0`.
    const dependencies = {
      "aliased": "npm:real@^2.0.0",
      "has-optional": "1.0.0",
      "has-peer": "1.0.0",
      "kept": "1.0.0",
      "shared": "2.0.0",
      "uses-alias-name": "1.0.0",
    };
    const lockfile = (keptRow: string) => `{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "app",
      "dependencies": {
${Object.entries(dependencies)
  .map(([name, range]) => `        "${name}": "${range}",\n`)
  .join("")}      },
    },
  },
  "packages": {
${row("aliased", "real@2.0.0")}

${row("has-optional", "has-optional@1.0.0")}

${row("has-peer", "has-peer@1.0.0")}

${keptRow}
${row("shared", "shared@2.0.0")}

${row("uses-alias-name", "uses-alias-name@1.0.0")}
  }
}
`;
    using merged = createProject(registry, { ...project(dependencies), "bun.lock": lockfile(hunks.same(kept)) });
    using clean = createProject(registry, { ...project(dependencies), "bun.lock": lockfile(kept) });

    // With this linker each package has a node_modules of its own, with a link for each dependency that has a package.
    const linked = async (dir: string) => {
      await succeed(dir, "install", "--linker=isolated");
      const dependencyOf = async (name: string, dependency: string) => {
        const own = join(await realpath(join(dir, "node_modules", name)), "..", dependency, "package.json");
        if (!(await exists(own))) return "none";
        const { name: linkedName, version } = await file(own).json();
        return `${linkedName}@${version}`;
      };
      return {
        alias: await dependencyOf("uses-alias-name", "aliased"),
        optional: await dependencyOf("has-optional", "shared"),
        peer: await dependencyOf("has-peer", "shared"),
      };
    };
    const [fromMerge, fromClean] = await Promise.all([linked(String(merged)), linked(String(clean))]);
    expect(fromClean).toEqual({ alias: "real@2.0.0", optional: "shared@2.0.0", peer: "shared@2.0.0" });
    expect(fromMerge).toEqual(fromClean);
    expect(registry.manifestRequests()).toEqual([]);
    expect(await file(join(String(merged), "bun.lock")).text()).not.toContain("<<<<<<<");
  });

  type Rows = Record<"kept" | "left" | "right", string>;
  it.each([
    [
      "a side that has nothing",
      ({ kept, left, right }: Rows) => `  "packages": {\n${kept}\n\n${left}\n${hunks.merge("", `\n${right}\n`)}  }\n`,
    ],
    [
      'the line that opens "packages"',
      ({ kept, left, right }: Rows) =>
        hunks.diff3(
          `  "packages": {\n${kept}\n\n${left}\n  }\n`,
          `  "packages": {\n${kept}\n\n${right}\n  }\n`,
          `  "packages": {}\n`,
        ),
    ],
  ])("reads a hunk with %s", async (_, packages) => {
    using registry = serveRegistry();
    const { row } = registry;
    const files = twoBranchesAddADependency(registry);
    const head = files["bun.lock"].slice(0, files["bun.lock"].indexOf(`  "packages": {\n`));
    const rows = {
      kept: row("kept", "kept@1.0.0"),
      left: row("left", "left@1.0.0"),
      right: row("right", "right@1.0.0"),
    };
    files["bun.lock"] = `${head}${packages(rows)}}\n`;
    using dir = createProject(registry, files);

    const { err } = await succeed(String(dir), "install", "--lockfile-only");
    expect(err).toContain(mergedNote);
    expect(registry.manifestRequests()).toEqual([]);
    const lockfile = await file(join(String(dir), "bun.lock")).text();
    expect(lockfile).toContain(`"kept": ["kept@1.0.0", `);
    expect(lockfile).toContain(`"left": ["left@1.0.0", `);
    expect(lockfile).toContain(`"right": ["right@1.0.0", `);
  });

  it("bun install --lockfile-only saves the merge with --dry-run too, and says nothing else", async () => {
    using registry = serveRegistry();
    const files = twoBranchesAddADependency(registry);
    using dir = createProject(registry, files);

    const { err } = await succeed(String(dir), "install", "--lockfile-only", "--dry-run");
    expect(err).toContain(mergedNote);
    expect(await file(join(String(dir), "bun.lock")).text()).not.toContain("<<<<<<<");
  });

  it("bun install --silent merges and says nothing", async () => {
    using registry = serveRegistry();
    const files = twoBranchesAddADependency(registry);
    using dir = createProject(registry, files);
    using frozen = createProject(registry, files);

    const [merged, refused] = await Promise.all([
      run(String(dir), "install", "--silent", "--lockfile-only"),
      run(String(frozen), "install", "--silent", "--frozen-lockfile"),
    ]);
    expect(merged).toEqual({ out: "", err: "", code: 0 });
    expect(await file(join(String(dir), "bun.lock")).text()).toContain(`"right": ["right@1.0.0", `);
    expect(refused).toEqual({ out: "", err: "", code: 1 });
    expect(await file(join(String(frozen), "bun.lock")).text()).toBe(files["bun.lock"]);
  });

  it.each([
    [["add", "extra@1.0.0"], ["/extra"], { extra: "1.0.0", kept: "1.0.0", left: "1.0.0", right: "1.0.0" }],
    [["remove", "left"], [], { kept: "1.0.0", right: "1.0.0" }],
    [["update", "kept"], ["/kept"], { kept: "1.1.0", left: "1.0.0", right: "1.0.0" }],
    [["update", "--recursive"], ["/kept", "/left", "/right"], { kept: "1.1.0", left: "1.0.0", right: "1.0.0" }],
  ])("bun %p works on the merge", async (args, requests, versions) => {
    using registry = serveRegistry();
    using dir = createProject(registry, twoBranchesAddADependency(registry));

    const { err } = await succeed(String(dir), ...args, "--lockfile-only");
    expect(err.split("\n").filter(line => line.startsWith("note: "))).toEqual([mergedNote.trimEnd()]);
    expect(registry.manifestRequests()).toEqual(requests);
    const lockfile = await file(join(String(dir), "bun.lock")).text();
    expect(lockfile).not.toContain("<<<<<<<");
    const locked = Object.fromEntries(
      [...lockfile.matchAll(/^    "([^"]+)": \["[^"]+@([^"@]+)", /gm)].map(([, name, version]) => [name, version]),
    );
    expect(locked).toEqual(versions);
  });

  it("does not merge a lockfile of an earlier format that lacks a workspace", async () => {
    using registry = serveRegistry();
    // lockfileVersion 0 has the workspaces in "packages" only.
    using dir = createProject(registry, {
      "package.json": JSON.stringify({ name: "app", version: "1.0.0", workspaces: ["packages/*"] }),
      "packages/a/package.json": JSON.stringify({ name: "a", version: "1.0.0" }),
      "bun.lock": `{
  "lockfileVersion": 0,
  "workspaces": {
    "": {
      "name": "app",
    },
    "packages/a": {
      "name": "a",
    },
  },
  "packages": {
${hunks.merge("", "")}  }
}
`,
    });

    const { err, code } = await run(String(dir), "install", "--lockfile-only");
    expect(err).toContain(
      "note: bun.lock contains git merge conflict markers that bun cannot merge: a workspace has no package on either side\n",
    );
    expect(err).toContain("warn: Ignoring lockfile");
    expect(code).toBe(0);
    expect(await file(join(String(dir), "bun.lock")).text()).toContain(`"a": ["a@workspace:packages/a"],`);
  });

  // The loader takes a dependency without a package only from a merge. Without markers it is an error, as before.
  it.each([
    ["a package", `"uses-old": [`, `"shared": [`, "Failed to resolve prod dependency 'shared' for package 'uses-old'"],
    ["a workspace", `"a": [`, `"kept": [`, "Failed to resolve prod dependency 'kept' for package 'a'"],
  ])(
    "a lockfile without markers still fails on a dependency of %s that has no package",
    async (_, __, lost, message) => {
      using registry = serveRegistry();
      const { row } = registry;
      const lockfile = `{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "app",
      "dependencies": {
        "uses-old": "1.0.0",
      },
    },
    "packages/a": {
      "name": "a",
      "dependencies": {
        "kept": "1.0.0",
      },
    },
  },
  "packages": {
    "a": ["a@workspace:packages/a"],

${row("kept", "kept@1.0.0")}

${row("shared", "shared@1.0.0")}

${row("uses-old", "uses-old@1.0.0")}
  }
}
`;
      const damaged = lockfile
        .split("\n")
        .filter(line => !line.startsWith(`    ${lost}`))
        .join("\n");
      expect(damaged).not.toBe(lockfile);
      using dir = createProject(registry, {
        "package.json": JSON.stringify({
          name: "app",
          workspaces: ["packages/*"],
          dependencies: { "uses-old": "1.0.0" },
        }),
        "packages/a/package.json": JSON.stringify({ name: "a", dependencies: { kept: "1.0.0" } }),
        "bun.lock": damaged,
      });

      const { err, code } = await run(String(dir), "install", "--frozen-lockfile");
      expect(err).toContain(`error: ${message}\n`);
      expect(err).toContain("failed to parse lockfile: 'bun.lock'");
      expect(err).toContain("warn: Ignoring lockfile");
      expect(err).toContain("error: lockfile had changes, but lockfile is frozen");
      expect(code).toBe(1);
      expect(registry.requests).toEqual([]);
    },
  );
});
