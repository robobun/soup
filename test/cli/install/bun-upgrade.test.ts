import { spawn } from "bun";
import { crash_handler, upgrade_test_helpers } from "bun:internal-for-testing";
import { beforeAll, describe, expect, it } from "bun:test";
import {
  bunEnv,
  bunExe,
  isDebug,
  isLinux,
  isMusl,
  isRoot,
  isWindows,
  normalizeBunSnapshot,
  tempDir,
  tls,
  tmpdirSync,
} from "harness";
import { chmodSync, readdirSync, readFileSync, statSync } from "node:fs";
import { copyFile, link, realpath, writeFile } from "node:fs/promises";
import { basename, join } from "path";
const { openTempDirWithoutSharingDelete, closeTempDirHandle } = upgrade_test_helpers;

// A `bun upgrade` that goes on where a test expects it to stop would download
// the real canary build and swap it in. So every proxy variable names a port
// that nothing listens on, and only the local release servers are exempt.
const env = {
  ...bunEnv,
  HTTP_PROXY: "http://127.0.0.1:9",
  HTTPS_PROXY: "http://127.0.0.1:9",
  http_proxy: "http://127.0.0.1:9",
  https_proxy: "http://127.0.0.1:9",
  NO_PROXY: "localhost,127.0.0.1",
  no_proxy: "localhost,127.0.0.1",
};

// The asset `bun upgrade` picks for the target this test runs on, and the
// folder inside it.
const releaseOs = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
const releaseArch = process.arch === "arm64" ? "aarch64" : "x64";
const releaseFolder = `bun-${releaseOs}-${releaseArch}${isMusl ? "-musl" : ""}`;
const releaseAsset = `${releaseFolder}.zip`;

// Last line `bun upgrade` prints when the downloaded archive is not a zip. On
// POSIX `unzip` rejects it; on Windows Expand-Archive's failure is only noticed
// when the executable it should have produced is missing.
const unpackFailure = isWindows ? "error: Failed to verify Bun (code: ENOENT)\n" : "Unzip failed (exit code: 9)\n";

// `bun upgrade` swaps out the executable it runs as, so the release flows run a
// stand-in in a temp dir instead of bunExe() itself. A hard link is enough: the
// upgrade only renames directory entries (POSIX swaps the staged file in,
// Windows renames the old image to `<name>.outdated`), so bunExe() is never
// modified through the link. Unlike a copy, a link is not a new file, so
// Windows does not re-scan the 80+ MB image on first launch (about 2.4s per
// copy on the arm64 lane). A temp dir on another volume falls back to a copy.
async function installStandIn(dir: string): Promise<string> {
  const execPath = join(dir, basename(bunExe()));
  try {
    await link(await realpath(bunExe()), execPath);
  } catch {
    await copyFile(bunExe(), execPath);
  }
  return execPath;
}

// The flows that are expected to fail never reach the swap, so they all share
// one stand-in.
let standInDir: string;
let standInExe: string;
beforeAll(async () => {
  standInDir = tmpdirSync();
  standInExe = await installStandIn(standInDir);
});

// Every release flow prints one line naming the version bun decided to install.
// Canary builds (CI and `bun bd`) word it as a downgrade; release builds
// announce the new version. It is not necessarily the first line: when the
// version fetch takes longer than the progress bar's delay (a loaded machine
// running a debug build), a "Fetching version tags" line precedes it on POSIX.
function expectTargetsRelease(stderr: string, version: string) {
  expect(stderr.split("\n")).toContainAnyValues([
    `Downgrading from Bun ${Bun.version}-canary to Bun v${version}`,
    `Bun v${version} is out! You're on v${Bun.version}`,
  ]);
}

function fakeReleaseScript(version: string): string {
  return `#!/bin/sh\nprintf '%s\\n' '${version}'\n`;
}

// Cover every platform/arch/abi/cpu combination so the asset list matches
// whichever target this test runs on. Non-matching names are ignored.
function allAssetNames(profile = false) {
  const names: string[] = [];
  for (const os of ["windows", "linux", "darwin"]) {
    for (const arch of ["x64", "aarch64"]) {
      for (const abi of ["", "-musl"]) {
        for (const cpu of ["", "-baseline"]) {
          names.push(`bun-${os}-${arch}${abi}${cpu}${profile ? "-profile" : ""}.zip`);
        }
      }
    }
  }
  return names;
}

// Build a minimal ZIP archive with a single stored (uncompressed) entry.
// `unzip -o` on POSIX restores the mode from the Unix external-attrs field;
// Expand-Archive on Windows ignores it.
function makeZipStored(entryName: string, data: Buffer, unixMode: number): Buffer {
  const nameBytes = Buffer.from(entryName, "utf8");
  const crc = Bun.hash.crc32(data);
  const size = data.length;

  const lfhLen = 30 + nameBytes.length;
  const cdhLen = 46 + nameBytes.length;
  const cdOffset = lfhLen + size;

  const buf = Buffer.alloc(lfhLen + size + cdhLen + 22);
  let p = 0;
  const u16 = (v: number) => {
    buf.writeUInt16LE(v, p);
    p += 2;
  };
  const u32 = (v: number) => {
    buf.writeUInt32LE(v >>> 0, p);
    p += 4;
  };
  const raw = (b: Buffer) => {
    b.copy(buf, p);
    p += b.length;
  };

  // Local file header
  u32(0x04034b50);
  u16(20); // version needed
  u16(0); // flags
  u16(0); // method: stored
  u16(0); // mtime
  u16(0); // mdate
  u32(crc);
  u32(size);
  u32(size);
  u16(nameBytes.length);
  u16(0);
  raw(nameBytes);
  raw(data);

  // Central directory header
  u32(0x02014b50);
  u16((3 << 8) | 20); // made by: Unix, spec 2.0
  u16(20);
  u16(0);
  u16(0);
  u16(0);
  u16(0);
  u32(crc);
  u32(size);
  u32(size);
  u16(nameBytes.length);
  u16(0);
  u16(0);
  u16(0);
  u16(0);
  u32((0o100000 | unixMode) << 16);
  u32(0); // LFH offset
  raw(nameBytes);

  // End of central directory
  u32(0x06054b50);
  u16(0);
  u16(0);
  u16(1);
  u16(1);
  u32(cdhLen);
  u32(cdOffset);
  u16(0);

  return buf;
}

// Write a release zip for the current target that, once unpacked, yields an
// executable at the path `bun upgrade` verifies. On POSIX a shell script is
// enough because `unzip` preserves the mode bits; on Windows the verify step
// spawns `bun.exe` directly, so the archive has to carry a real PE image.
async function writeFakeReleaseZip(outPath: string, version: string): Promise<void> {
  if (isWindows) {
    const exe = Buffer.from(await Bun.file(bunExe()).arrayBuffer());
    await writeFile(outPath, makeZipStored(`${releaseFolder}/bun.exe`, exe, 0o755));
  } else {
    const script = Buffer.from(fakeReleaseScript(version));
    await writeFile(outPath, makeZipStored(`${releaseFolder}/bun`, script, 0o755));
  }
}

// The two lookups of `bun upgrade`: the latest release, and the release of one tag.
const latestReleasePath = "/repos/Jarred-Sumner/bun-releases-for-updater/releases/latest";
const releaseByTagPath = (tagName: string) => `/repos/oven-sh/bun/releases/tags/${tagName}`;

type ReleaseServer = Bun.Server<undefined> & {
  env: Record<string, string>;
  /** The path of every request, in the order they arrived. */
  requests: string[];
};

function startReleaseServer(opts: {
  tagName: string;
  assetNames?: string[];
  zipPath?: string;
  zipBody?: string;
  digest?: string;
  /** The tag that the release says it has, when that is not the tag it is found under. */
  answeredTagName?: string;
  /** The status of the download, when the release has an asset that cannot be fetched. */
  downloadStatus?: number;
  /** The status of the lookup, when the API refuses it. */
  lookupStatus?: number;
  /**
   * Every asset is a zip of the one executable that `bun upgrade` looks for
   * in it, and that executable is a script which reports this version.
   */
  scriptVersion?: string;
}): ReleaseServer {
  const assetNames = opts.assetNames ?? allAssetNames();
  const requests: string[] = [];
  const server = Bun.serve({
    tls: tls,
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      requests.push(pathname);
      if (pathname.startsWith("/download/")) {
        if (opts.downloadStatus) return new Response("", { status: opts.downloadStatus });
        if (opts.zipPath) return new Response(Bun.file(opts.zipPath));
        if (opts.scriptVersion) {
          const folder = basename(pathname, ".zip");
          const executable = folder.endsWith("-profile") ? "bun-profile" : "bun";
          const script = Buffer.from(fakeReleaseScript(opts.scriptVersion));
          return new Response(makeZipStored(`${folder}/${executable}`, script, 0o755));
        }
        return new Response(opts.zipBody ?? "this is not a real zip archive");
      }
      if (opts.lookupStatus) return Response.json({ message: "Refused" }, { status: opts.lookupStatus });
      if (pathname !== latestReleasePath && pathname !== releaseByTagPath(opts.tagName)) {
        // What api.github.com answers for a tag that no release has.
        return Response.json({ message: "Not Found", status: "404" }, { status: 404 });
      }
      return new Response(
        JSON.stringify({
          tag_name: opts.answeredTagName ?? opts.tagName,
          assets: assetNames.map(name => ({
            url: "foo",
            content_type: "application/zip",
            name,
            ...(opts.digest ? { digest: opts.digest } : {}),
            browser_download_url: `https://${server.hostname}:${server.port}/download/${name}`,
          })),
        }),
      );
    },
  }) as ReleaseServer;
  server.requests = requests;
  server.env = {
    ...env,
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
    GITHUB_API_DOMAIN: `${server.hostname}:${server.port}`,
    // The upgrade-failure path exits via Global::exit(1) while the HTTP
    // thread and the intentionally-leaked progress/download buffers are
    // still live; LeakSanitizer reports those at exit and abort_on_error
    // turns the clean exit(1) into SIGABRT on the ASAN lane. Leak
    // detection is not what these tests assert.
    ASAN_OPTIONS: [env.ASAN_OPTIONS, "detect_leaks=0"].filter(Boolean).join(":"),
  };
  return server;
}

describe.concurrent(() => {
  it("two invalid arguments, should display error message and suggest command", async () => {
    const cwd = tmpdirSync();
    await using proc = spawn({
      cmd: [bunExe(), "upgrade", "bun-types", "--dev"],
      cwd,
      stdout: "pipe",
      stdin: "pipe",
      stderr: "pipe",
      env,
    });

    const [out, err, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect(out).toBe("");
    expect(normalizeBunSnapshot(err)).toMatchInlineSnapshot(`
      "error: This command updates Bun itself, and does not take package names.
      note: Use \`bun update bun-types --dev\` instead."
    `);
    expect(exitCode).toBe(1);
  });

  it("two invalid arguments flipped, should display error message and suggest command", async () => {
    const cwd = tmpdirSync();
    await using proc = spawn({
      cmd: [bunExe(), "upgrade", "--dev", "bun-types"],
      cwd,
      stdout: "pipe",
      stdin: "pipe",
      stderr: "pipe",
      env,
    });

    const [out, err, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect(out).toBe("");
    expect(normalizeBunSnapshot(err)).toMatchInlineSnapshot(`
      "error: This command updates Bun itself, and does not take package names.
      note: Use \`bun update --dev bun-types\` instead."
    `);
    expect(exitCode).toBe(1);
  });

  it("one invalid argument, should display error message and suggest command", async () => {
    const cwd = tmpdirSync();
    await using proc = spawn({
      cmd: [bunExe(), "upgrade", "bun-types"],
      cwd,
      stdout: "pipe",
      stdin: "pipe",
      stderr: "pipe",
      env,
    });

    const [out, err, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect(out).toBe("");
    expect(normalizeBunSnapshot(err)).toMatchInlineSnapshot(`
      "error: This command updates Bun itself, and does not take package names.
      note: Use \`bun update bun-types\` instead."
    `);
    expect(exitCode).toBe(1);
  });

  it("one valid argument, should succeed", async () => {
    const cwd = tmpdirSync();
    await using proc = spawn({
      cmd: [bunExe(), "upgrade", "--help"],
      cwd,
      stdout: "pipe",
      stdin: "pipe",
      stderr: "pipe",
      env,
    });

    const [out, err, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect(out).toStartWith("Usage: bun upgrade [flags] [<version>]\n");
    expect(out).toContain(`\n  bun upgrade ${Bun.version.replace("-debug", "")}\n`);
    expect(err).toBe("");
    expect(exitCode).toBe(0);
  });

  it("takes the flags that choose the CA store", async () => {
    // With `--stable`, an upgrade that goes ahead asks the local server.
    using server = startReleaseServer({ tagName: "bun-v9.9.9" });
    using stagingRoot = tempDir("bun-upgrade-ca-store", {});
    await using proc = spawn({
      cmd: [standInExe, "upgrade", "--stable", "--use-openssl-ca", "--use-bundled-ca"],
      cwd: standInDir,
      stdout: "pipe",
      stdin: "pipe",
      stderr: "pipe",
      env: { ...server.env, BUN_TMPDIR: String(stagingRoot) },
    });

    const [out, err, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect(out).toBe("");
    expect(err).toBe("error: choose exactly one of --use-system-ca, --use-openssl-ca, or --use-bundled-ca\n");
    expect(exitCode).toBe(1);
  });

  it("two valid arguments, should succeed", async () => {
    // `--stable --profile` are both recognised flags; argument validation must
    // let them through. Only profile assets are served, so reaching the version
    // announcement also proves `--profile` was honored. The archive is garbage,
    // so the upgrade fails later, after argument parsing has accepted the flags.
    using server = startReleaseServer({ tagName: "bun-v9.9.9", assetNames: allAssetNames(true) });
    using stagingRoot = tempDir("bun-upgrade-args", {});
    await using proc = spawn({
      cmd: [standInExe, "upgrade", "--stable", "--profile"],
      cwd: standInDir,
      stdout: null,
      stdin: "pipe",
      stderr: "pipe",
      env: { ...server.env, BUN_TMPDIR: String(stagingRoot) },
    });

    const [err, exitCode] = await Promise.all([proc.stderr.text(), proc.exited]);
    expect(err).not.toContain("does not take package names");
    expectTargetsRelease(err, "9.9.9");
    expect(err).toEndWith(unpackFailure);
    expect(exitCode).toBe(1);
  });
});

it.concurrent(
  "completes against a locally-served release with the system temp dir held open without FILE_SHARE_DELETE",
  async () => {
    // `--stable` routes through the GitHub releases API (overridable via
    // GITHUB_API_DOMAIN) instead of the compiled-in canary URL, so the whole
    // download/unpack/verify/swap path runs against the local server. This flow
    // really swaps the executable, so it gets a stand-in of its own. The staging
    // directory must stay in the default temp dir: that is the directory held
    // open below.
    const version = Bun.version;
    const exeName = basename(bunExe());
    const installDir = tmpdirSync();
    const zipPath = join(tmpdirSync(), "release.zip");
    const [execPath] = await Promise.all([installStandIn(installDir), writeFakeReleaseZip(zipPath, version)]);

    using server = startReleaseServer({ tagName: `bun-v${version}`, zipPath });

    // On Windows, open the temporary directory without FILE_SHARE_DELETE before spawning
    // the upgrade process. This is to test for EBUSY errors.
    openTempDirWithoutSharingDelete();

    await using proc = Bun.spawn({
      cmd: [execPath, "upgrade", "--stable"],
      cwd: installDir,
      stdout: null,
      stdin: "pipe",
      stderr: "pipe",
      env: server.env,
    });

    const [stderr, exitCode] = await Promise.all([proc.stderr.text(), proc.exited]);
    closeTempDirHandle();

    if (stderr.includes("Congrats!")) {
      // A non-canary build is "already on" the version the server advertises
      // (its own) and stops before the download, so nothing may have changed.
      expect(stderr).toEndWith(`Congrats! You're already on the latest version of Bun (which is v${version})\n`);
      expect(readdirSync(installDir)).toEqual([exeName]);
    } else {
      expectTargetsRelease(stderr, version);
      expect(stderr).toEndWith(
        ` Upgraded.\n\nWelcome to Bun v${version}!\n\nWhat's new in Bun v${version}:\n\n    https://bun.com/blog/release-notes/bun-v${version}\n\nReport any bugs:\n\n    https://github.com/oven-sh/bun/issues\n\nCommit log:\n\n    https://github.com/oven-sh/bun/compare/bun-v${Bun.version}...bun-v${version}\n`,
      );
      if (isWindows) {
        // A running image cannot be deleted, so the old one is parked as
        // `.outdated`. The upgrade then ran `completions` with the installed
        // executable, which recreates the bunx hard link next to itself.
        expect(readdirSync(installDir).sort()).toEqual(
          [exeName, `${exeName}.outdated`, isDebug ? "bunx-debug.exe" : "bunx.exe"].sort(),
        );
      } else {
        expect(readdirSync(installDir)).toEqual([exeName]);
        expect(await Bun.file(execPath).text()).toBe(fakeReleaseScript(version));
      }
    }
    expect(exitCode).toBe(0);
  },
);

it.concurrent("recreates the staging directory in the temp dir instead of reusing a pre-existing one", async () => {
  const tagName = "bun-v9.9.9";
  // Simulate a directory that already exists at the predictable staging path
  // ($TMPDIR/<version>) before the upgrade runs, with content planted inside it.
  using stagingRoot = tempDir("bun-upgrade-staging", {
    "9.9.9": {
      "planted-before-upgrade.txt": "planted",
      "planted-subdir": {
        "bun": "#!/bin/sh\necho 9.9.9\n",
      },
    },
  });
  const stagingRootPath = String(stagingRoot);

  using server = startReleaseServer({ tagName });

  await using proc = Bun.spawn({
    // --stable forces the GitHub-release code path (with a predictable
    // version-named staging directory) even on canary/debug builds.
    cmd: [standInExe, "upgrade", "--stable"],
    cwd: standInDir,
    stdout: null,
    stdin: "pipe",
    stderr: "pipe",
    env: {
      ...server.env,
      BUN_TMPDIR: stagingRootPath,
    },
  });

  const [stderr, exitCode] = await Promise.all([proc.stderr.text(), proc.exited]);

  // The upgrade targeted v9.9.9 and got as far as unpacking into the staging
  // directory, where the bogus archive made it fail.
  expectTargetsRelease(stderr, "9.9.9");
  expect(stderr).toEndWith(unpackFailure);
  expect(server.requests).toEqual([latestReleasePath, `/download/${releaseAsset}`]);

  // Nothing that existed in the staging directory before the upgrade started
  // may survive into the directory the new binary is unpacked and verified in.
  // The failed unpack leaves nothing behind either: bun removes its own
  // download (bun.zip) again.
  expect(readdirSync(join(stagingRootPath, "9.9.9"))).toEqual([]);

  if (!isWindows) {
    // The staging directory must be freshly created with no group/other
    // access. The planted one was created with the default mode, so a reused
    // directory fails here.
    expect(statSync(join(stagingRootPath, "9.9.9")).mode & 0o077).toBe(0);
  }

  // The bogus archive must not be installed; the upgrade fails cleanly.
  expect(exitCode).toBe(1);
});

it.concurrent("verifies the downloaded release archive against the digest reported by the release asset", async () => {
  const archiveBody = "this is not a real zip archive";
  const correctDigest = `sha256:${new Bun.CryptoHasher("sha256").update(archiveBody).digest("hex")}`;
  const wrongDigest = `sha256:${Buffer.alloc(32, 0xab).toString("hex")}`;

  const runUpgrade = async (tagName: string, digest: string) => {
    using server = startReleaseServer({ tagName, digest, zipBody: archiveBody });
    using stagingRoot = tempDir("bun-upgrade-digest", {});

    await using proc = Bun.spawn({
      cmd: [standInExe, "upgrade", "--stable"],
      cwd: standInDir,
      stdout: null,
      stdin: "pipe",
      stderr: "pipe",
      env: { ...server.env, BUN_TMPDIR: String(stagingRoot) },
    });

    const [stderr, exitCode] = await Promise.all([proc.stderr.text(), proc.exited]);
    return {
      stderr,
      exitCode,
      // Returns whatever the upgrade staged before it gave up.
      staged: readdirSync(String(stagingRoot)),
      downloadUrl: `https://${server.hostname}:${server.port}/download/${releaseAsset}`,
    };
  };

  const [mismatched, matched] = await Promise.all([
    runUpgrade("bun-v9.9.7", wrongDigest),
    runUpgrade("bun-v9.9.8", correctDigest),
  ]);

  expectTargetsRelease(mismatched.stderr, "9.9.7");
  expect(mismatched.stderr).toEndWith(
    `error: The file downloaded from ${mismatched.downloadUrl} did not match the checksum reported by the GitHub API for this release.\n` +
      "note: run bun upgrade again to retry the download\n",
  );
  // Rejected before anything was written to disk.
  expect(mismatched.staged).toEqual([]);
  expect(mismatched.exitCode).toBe(1);

  expectTargetsRelease(matched.stderr, "9.9.8");
  // With a matching digest the archive is accepted and staged; this run only
  // fails afterwards because the body is not a zip.
  expect(matched.stderr).not.toContain("did not match the checksum");
  expect(matched.stderr).toEndWith(unpackFailure);
  expect(matched.staged).toEqual(["9.9.8"]);
  expect(matched.exitCode).toBe(1);
});

describe.concurrent("bun upgrade <version>", () => {
  const tagPath = releaseByTagPath("bun-v1.2.3");
  // The version of this build the way the messages name it: without the suffix of a debug build.
  const thisVersion = Bun.version.replace("-debug", "");
  const isCanary = crash_handler.getFeatureData().is_canary;

  // For a chosen version an x64 CPU without AVX2 gets the `-baseline` build,
  // so the name of the zip depends on the machine that runs the test.
  const zipName = (profile = false) =>
    `${releaseFolder}${process.arch === "x64" ? "(-baseline)?" : ""}${profile ? "-profile" : ""}\\.zip`;
  const download = (profile = false) => expect.stringMatching(new RegExp(`^/download/${zipName(profile)}$`));

  const installScript = (version: string) =>
    isWindows
      ? `iex "& {$(irm https://bun.com/install.ps1)} -Version ${version}"`
      : `curl -fsSL https://bun.com/install | bash -s "bun-v${version}"`;
  const installScriptNote =
    `note: Run the install script${isWindows ? " in PowerShell" : ""} for that version:\n` +
    `  ${installScript("1.2.3")}\n`;

  // Runs the stand-in that the failing flows share. Every request it makes goes to `server`.
  async function upgrade(server: ReleaseServer, args: string[], extraEnv: Record<string, string> = {}) {
    using stagingRoot = tempDir("bun-upgrade-version", {});
    await using proc = spawn({
      cmd: [standInExe, "upgrade", ...args],
      cwd: standInDir,
      stdout: "pipe",
      stdin: "pipe",
      stderr: "pipe",
      env: { ...server.env, BUN_TMPDIR: String(stagingRoot), ...extraEnv },
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    return { stdout, stderr, exitCode };
  }

  // The line that says which release was asked for. It names the running
  // version the way the line of `--stable` does.
  function expectInstalls(stderr: string, version: string) {
    expect(stderr.split("\n")).toContainAnyValues([
      `Installing Bun v${version}. You're on v${Bun.version}-canary`,
      `Installing Bun v${version}. You're on v${Bun.version}`,
    ]);
  }

  it.each([[["1.2.3"]], [["v1.2.3"]], [["bun-v1.2.3"]], [["--version", "1.2.3"]], [["--version=1.2.3"]]])(
    "%j asks for the release with that tag",
    async args => {
      using server = startReleaseServer({ tagName: "bun-v1.2.3" });
      const { stderr, exitCode } = await upgrade(server, args);

      expectInstalls(stderr, "1.2.3");
      // The archive is not a zip, so the flow ends after the download.
      expect(stderr).toEndWith(unpackFailure);
      expect(server.requests).toEqual([tagPath, download()]);
      expect(exitCode).toBe(1);
    },
  );

  it("a version is a stable release, also when BUN_CANARY asks for canary", async () => {
    using server = startReleaseServer({ tagName: "bun-v1.2.3" });
    const { stderr, exitCode } = await upgrade(server, ["1.2.3"], { BUN_CANARY: "1" });

    expectInstalls(stderr, "1.2.3");
    expect(server.requests).toEqual([tagPath, download()]);
    expect(exitCode).toBe(1);
  });

  it("--stable, --profile and a flag for the certificates go with a version", async () => {
    // Only the profile builds are there, so the download shows that --profile was honored.
    using server = startReleaseServer({ tagName: "bun-v1.2.3", assetNames: allAssetNames(true) });
    const { stderr, exitCode } = await upgrade(server, ["--stable", "1.2.3", "--profile", "--use-bundled-ca"]);

    expectInstalls(stderr, "1.2.3");
    expect(stderr).toEndWith(unpackFailure);
    expect(server.requests).toEqual([tagPath, download(true)]);
    expect(exitCode).toBe(1);
  });

  it.skipIf(!isLinux || process.arch !== "x64")("the CPU decides between the default build and -baseline", async () => {
    const hasAvx2 = /^flags\s*:.*\bavx2\b/m.test(readFileSync("/proc/cpuinfo", "utf8"));
    using server = startReleaseServer({ tagName: "bun-v1.2.3" });
    await upgrade(server, ["1.2.3"]);

    expect(server.requests).toEqual([tagPath, `/download/${releaseFolder}${hasAvx2 ? "" : "-baseline"}.zip`]);
  });

  // On Windows the archive of a release has to be this executable (see
  // writeFakeReleaseZip). It reports its own version and no other, and the
  // `--stable` flow above installs that one.
  it.skipIf(isWindows).each([
    { version: "1.2.3", args: ["1.2.3"], older: true },
    { version: "99.0.0", args: ["--stable", "v99.0.0"], older: false },
  ])("installs $version and says which way it went", async ({ version, args, older }) => {
    // This flow swaps the executable, so it gets a stand-in of its own.
    const installDir = tmpdirSync();
    const execPath = await installStandIn(installDir);
    using server = startReleaseServer({ tagName: `bun-v${version}`, scriptVersion: version });
    using stagingRoot = tempDir("bun-upgrade-version", {});

    await using proc = spawn({
      cmd: [execPath, "upgrade", ...args],
      cwd: installDir,
      stdout: null,
      stdin: "pipe",
      stderr: "pipe",
      env: { ...server.env, BUN_TMPDIR: String(stagingRoot) },
    });
    const [stderr, exitCode] = await Promise.all([proc.stderr.text(), proc.exited]);

    expectInstalls(stderr, version);
    // A release build also says how to go back. A canary build has no tag to go back to.
    const wayBack = isCanary
      ? ""
      : `\nTo go back to Bun v${thisVersion}, run the install script:\n\n    ${installScript(thisVersion)}\n`;
    expect(stderr).toEndWith(
      older
        ? ` Downgraded.\n\nWelcome to Bun v${version}!\n\nRelease notes for Bun v${version}:\n\n    https://bun.com/blog/release-notes/bun-v${version}\n\nReport any bugs:\n\n    https://github.com/oven-sh/bun/issues\n\nCommit log:\n\n    https://github.com/oven-sh/bun/compare/bun-v${version}...bun-v${Bun.version}\n${wayBack}`
        : ` Upgraded.\n\nWelcome to Bun v${version}!\n\nWhat's new in Bun v${version}:\n\n    https://bun.com/blog/release-notes/bun-v${version}\n\nReport any bugs:\n\n    https://github.com/oven-sh/bun/issues\n\nCommit log:\n\n    https://github.com/oven-sh/bun/compare/bun-v${Bun.version}...bun-v${version}\n`,
    );
    expect(server.requests).toEqual([releaseByTagPath(`bun-v${version}`), download()]);
    expect(readdirSync(installDir)).toEqual([basename(execPath)]);
    expect(await Bun.file(execPath).text()).toBe(fakeReleaseScript(version));
    expect(exitCode).toBe(0);
  });

  it("the version of this build: a canary build installs the release, a release build is already on it", async () => {
    using server = startReleaseServer({ tagName: `bun-v${thisVersion}` });
    const { stderr, exitCode } = await upgrade(server, [thisVersion]);

    if (isCanary) {
      expectInstalls(stderr, thisVersion);
      expect(stderr).toEndWith(unpackFailure);
      expect(server.requests).toEqual([releaseByTagPath(`bun-v${thisVersion}`), download()]);
      expect(exitCode).toBe(1);
    } else {
      expect({ stderr, requests: server.requests }).toEqual({
        stderr: `You're already on Bun v${thisVersion}\n`,
        requests: [],
      });
      expect(exitCode).toBe(0);
    }
  });

  it("a version that no release has is an error", async () => {
    using server = startReleaseServer({ tagName: "bun-v1.2.3" });
    const { stderr, exitCode } = await upgrade(server, ["9.9.9"]);

    expect(stderr).toEndWith(
      `error: Bun v9.9.9 was not found: ${server.hostname}:${server.port} has no release of oven-sh/bun with the tag bun-v9.9.9.\n` +
        "note: The releases are listed at https://github.com/oven-sh/bun/releases\n",
    );
    expect(server.requests).toEqual([releaseByTagPath("bun-v9.9.9")]);
    expect(exitCode).toBe(1);
  });

  it("a release without a build for this platform is an error", async () => {
    using server = startReleaseServer({ tagName: "bun-v1.2.3", assetNames: [] });
    const { stderr, exitCode } = await upgrade(server, ["1.2.3"]);

    expect(stderr).toMatch(new RegExp(`error: Bun v1\\.2\\.3 has no build for this platform \\(${zipName()}\\)\n$`));
    expect(server.requests).toEqual([tagPath]);
    expect(exitCode).toBe(1);
  });

  it("a release with another tag than the one that was asked for is not installed", async () => {
    using server = startReleaseServer({ tagName: "bun-v1.2.3", answeredTagName: "bun-v1.2.4" });
    const { stderr, exitCode } = await upgrade(server, ["1.2.3"]);

    expect(stderr).toEndWith("error: Asked for Bun v1.2.3, and the answer was the release bun-v1.2.4.\n");
    expect(server.requests).toEqual([tagPath]);
    expect(exitCode).toBe(1);
  });

  it("a lookup or a download that is refused names what answered, and the install script for the version", async () => {
    const run = async (refusal: { lookupStatus: number } | { downloadStatus: number }) => {
      using server = startReleaseServer({ tagName: "bun-v1.2.3", ...refusal });
      const result = await upgrade(server, ["1.2.3"]);
      return { ...result, requests: server.requests, origin: `https://${server.hostname}:${server.port}` };
    };
    const [lookup, zip] = await Promise.all([run({ lookupStatus: 403 }), run({ downloadStatus: 404 })]);

    expect(lookup.requests).toEqual([tagPath]);
    expect(lookup.stderr).toEndWith(
      `error: Bun v1.2.3 was not installed: ${lookup.origin}${tagPath} answered 403.\n${installScriptNote}`,
    );
    expect(lookup.exitCode).toBe(1);

    expect(zip.requests).toEqual([tagPath, download()]);
    expect(zip.stderr).toEndWith(
      `error: Bun v1.2.3 was not installed: ${zip.origin}${zip.requests[1]} answered 404.\n${installScriptNote}`,
    );
    expect(zip.exitCode).toBe(1);
  });

  // Root writes to a directory that nobody may write to.
  it.skipIf(isWindows || isRoot)(
    "an executable that cannot be replaced names the install script for the version",
    async () => {
      const installDir = tmpdirSync();
      const execPath = await installStandIn(installDir);
      using server = startReleaseServer({ tagName: "bun-v1.2.3", scriptVersion: "1.2.3" });
      using stagingRoot = tempDir("bun-upgrade-version", {});
      chmodSync(installDir, 0o555);

      try {
        await using proc = spawn({
          cmd: [execPath, "upgrade", "1.2.3"],
          cwd: installDir,
          stdout: null,
          stdin: "pipe",
          stderr: "pipe",
          env: { ...server.env, BUN_TMPDIR: String(stagingRoot) },
        });
        const [stderr, exitCode] = await Promise.all([proc.stderr.text(), proc.exited]);

        expect(stderr).toEndWith(
          `\n\nPlease reinstall Bun manually with the following command:\n   ${installScript("1.2.3")}\n`,
        );
        expect(exitCode).toBe(1);
      } finally {
        chmodSync(installDir, 0o755);
      }
    },
  );

  it("checks the download against the checksum of the release, and says so when the release has none", async () => {
    const archiveBody = "this is not a real zip archive";
    const correctDigest = `sha256:${new Bun.CryptoHasher("sha256").update(archiveBody).digest("hex")}`;
    const wrongDigest = `sha256:${Buffer.alloc(32, 0xab).toString("hex")}`;
    const warning = "warn: GitHub has no checksum for Bun v1.2.3, so the download is not verified\n";

    const run = async (digest?: string) => {
      using server = startReleaseServer({ tagName: "bun-v1.2.3", digest, zipBody: archiveBody });
      const result = await upgrade(server, ["1.2.3"]);
      return { ...result, downloadUrl: `https://${server.hostname}:${server.port}${server.requests[1]}` };
    };
    const [mismatched, matched, unchecked] = await Promise.all([run(wrongDigest), run(correctDigest), run()]);

    expect(mismatched.stderr).toEndWith(
      `error: The file downloaded from ${mismatched.downloadUrl} did not match the checksum reported by the GitHub API for this release.\n` +
        "note: run bun upgrade 1.2.3 again to retry the download\n",
    );
    expect(mismatched.exitCode).toBe(1);

    expect(matched.stderr).not.toContain("warn:");
    expect(matched.stderr).toEndWith(unpackFailure);
    expect(matched.exitCode).toBe(1);

    expect(unchecked.stderr).toContain(warning);
    expect(unchecked.stderr).toEndWith(unpackFailure);
    expect(unchecked.exitCode).toBe(1);
  });

  const moreThanOne =
    "error: This command installs one version of Bun, and more than one was given.\n" +
    "note: Use `bun upgrade 1.2.3`.\n";
  const canaryBeside =
    "error: A version and --canary were both given.\n" +
    "note: Use `bun upgrade 1.2.3` for that release, or `bun upgrade --canary` for the latest canary build.\n";
  const versionFlagAlone =
    `error: --version needs a version after it, as in \`bun upgrade --version ${thisVersion}\`.\n` +
    "note: To print the version of this Bun, use `bun --version`.\n";
  const besideAVersion = (flag: string) =>
    `error: This command does not take ${flag} with a version.\nnote: Use \`bun upgrade 1.2.3\`.\n`;
  const notFull = (word: string) =>
    `error: ${word} is not a full version.\n` +
    `note: A version has three numbers, as in \`bun upgrade ${thisVersion}\`.\n`;
  const notAVersion = (word: string, flag: string, what: string) =>
    `error: ${word} is not a version.\nnote: Use \`bun upgrade ${flag}\` for the latest ${what}.\n`;
  const packageName = (...args: string[]) =>
    "error: This command updates Bun itself, and does not take package names.\n" +
    `note: Use \`bun update ${args.join(" ")}\` instead.\n`;

  // The rows without a version in them have `--stable`, so that a build which
  // ignores the flag beside it asks this server for the latest release, and
  // fails the row.
  it.each([
    [["1.2.3", "1.3.0"], moreThanOne],
    [["1.2.3", "v1.2.3"], moreThanOne],
    [["--version", "1.2.3", "1.3.0"], moreThanOne],
    [["1.2.3", "--canary"], canaryBeside],
    [["--canary", "v1.2.3"], canaryBeside],
    [["--stable", "--version"], versionFlagAlone],
    [["--stable", "--version", "latest"], versionFlagAlone],
    [["--stable", "--version=1.2"], versionFlagAlone],
    // A flag that nothing reads must not leave the version to be installed, or the latest release in its place.
    [["1.2.3", "--dry-run"], besideAVersion("--dry-run")],
    [["--to", "1.2.3"], besideAVersion("--to")],
    [["1.2.3", "--baseline"], besideAVersion("--baseline")],
    [
      ["--stable", "--to=1.2.3"],
      "error: This command does not take --to=1.2.3.\nnote: Use `bun upgrade 1.2.3` to install that version.\n",
    ],
    // Words that are nearly a version get a note of their own.
    [["1.2"], notFull("1.2")],
    [["1.2.3.4"], notFull("1.2.3.4")],
    [["01.2.3"], notFull("01.2.3")],
    [["canary"], notAVersion("canary", "--canary", "canary build")],
    [["latest"], notAVersion("latest", "--stable", "stable release")],
    [["stable"], notAVersion("stable", "--stable", "stable release")],
    // Every other word is still taken for the name of a package.
    [["v8"], packageName("v8")],
    [["1.2.3-beta.1"], packageName("1.2.3-beta.1")],
    [["1.2.3+build"], packageName("1.2.3+build")],
    [["=1.2.3"], packageName("=1.2.3")],
    [["bun-1.2.3"], packageName("bun-1.2.3")],
    [["bun-v1.2.3", "bun-types"], packageName("bun-v1.2.3", "bun-types")],
  ])("%j is refused before any request", async (args, message) => {
    using server = startReleaseServer({ tagName: "bun-v1.2.3" });
    const { stdout, stderr, exitCode } = await upgrade(server, args);

    expect({ stdout, stderr, requests: server.requests }).toEqual({ stdout: "", stderr: message, requests: [] });
    expect(exitCode).toBe(1);
  });
});
