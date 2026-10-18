import { file, spawn, write } from "bun";
import { readTarball } from "bun:internal-for-testing";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { exists, rm } from "fs/promises";
import { bunExe, tempDir } from "harness";
import { join } from "path";
import { installEnv } from "registry";

type Manifests = Record<
  string,
  { tags?: Record<string, string>; versions: Record<string, Record<string, Record<string, string>>> }
>;

// What https://npm.jsr.io serves for the JSR packages `@std/path`, `@std/internal` and `@luca/flag`.
const jsrManifests: Manifests = {
  "@jsr/std__path": {
    tags: { latest: "2.0.0", canary: "2.1.0-canary.1" },
    versions: {
      "1.0.0": {},
      "1.0.8": { dependencies: { "@jsr/std__internal": "^1.0.5" } },
      "1.1.0": { dependencies: { "@jsr/std__internal": "^1.0.5" } },
      "2.0.0": { dependencies: { "@jsr/std__internal": "^1.0.5" } },
      "2.1.0-canary.1": {},
    },
  },
  "@jsr/std__internal": { versions: { "1.0.5": {}, "1.0.6": {} } },
  "@jsr/luca__flag": { versions: { "1.0.0": {}, "1.0.1": {} } },
};

// The default registry. `@std/path` is a package of its own here: a `jsr:` dependency must never get it.
const npmManifests: Manifests = {
  "@std/path": { versions: { "9.9.9": {} } },
  "no-deps": { versions: { "1.0.0": {}, "2.0.0": {} } },
  // Published with the specifiers as they were written, which is what `npm publish` does.
  "uses-jsr": { versions: { "1.0.0": { dependencies: { "@std/path": "jsr:^1.0.0" } } } },
  "uses-jsr-alias": { versions: { "1.0.0": { dependencies: { "std-path": "jsr:@std/path@2" } } } },
  "uses-invalid-jsr": { versions: { "1.0.0": { dependencies: { "path": "jsr:^1.0.0", "no-deps": "1.0.0" } } } },
};

/**
 * One server for both registries: `/<project>/npm/` is the default registry of a project and `/<project>/jsr/` is
 * its registry for the `@jsr` scope. The tarballs are where npm.jsr.io has them, `/~/<n>/<name>/<version>.tgz`.
 */
async function serveRegistries() {
  const tarballs = new Map<string, Uint8Array>();
  const integrity = new Map<string, string>();
  const add = async (registry: string, manifests: Manifests) => {
    for (const [name, { versions }] of Object.entries(manifests)) {
      for (const [version, extra] of Object.entries(versions)) {
        const bytes = await new Bun.Archive(
          {
            "package/package.json": JSON.stringify({ name, version, ...extra }),
            "package/index.js": `module.exports = ${JSON.stringify(`${name}@${version}`)};`,
          },
          { compress: "gzip" },
        ).bytes();
        tarballs.set(`${registry}/~/11/${name}/${version}.tgz`, bytes);
        integrity.set(
          `${registry}/${name}@${version}`,
          "sha512-" + new Bun.CryptoHasher("sha512").update(bytes).digest("base64"),
        );
      }
    }
  };
  await Promise.all([add("jsr", jsrManifests), add("npm", npmManifests)]);

  const requests = new Map<string, string[]>();
  /** The body of what each project published. */
  const published = new Map<string, any>();
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const { origin, pathname } = new URL(request.url);
      const [, project, registry, ...rest] = decodeURIComponent(pathname).split("/");
      const path = rest.join("/");
      if (request.method === "PUT") {
        published.set(project, await request.json());
        return new Response("OK");
      }
      const seen = requests.get(project) ?? [];
      requests.set(project, seen);
      // Every project has a token for its default registry. It is not for the registry of the `@jsr` scope.
      const leaked = registry === "jsr" && request.headers.has("authorization");
      seen.push(`${registry}: ${path}${leaked ? " (with the token of the default registry)" : ""}`);

      const tarball = tarballs.get(`${registry}/${path}`);
      if (tarball) return new Response(tarball);
      const manifest = (registry === "jsr" ? jsrManifests : registry === "npm" ? npmManifests : {})[path];
      if (!manifest) return Response.json({ error: "Not found" }, { status: 404 });
      const versions: Record<string, unknown> = {};
      for (const [version, extra] of Object.entries(manifest.versions)) {
        versions[version] = {
          name: path,
          version,
          ...extra,
          dist: {
            tarball: `${origin}/${project}/${registry}/~/11/${path}/${version}.tgz`,
            integrity: integrity.get(`${registry}/${path}@${version}`),
          },
        };
      }
      const latest = Object.keys(manifest.versions).sort(Bun.semver.order).at(-1)!;
      return Response.json({ name: path, versions, "dist-tags": { latest, ...manifest.tags } });
    },
  });
  return { server, requests, published, integrity };
}

let registries: Awaited<ReturnType<typeof serveRegistries>>;
beforeAll(async () => {
  registries = await serveRegistries();
});
afterAll(() => {
  registries.server.stop(true);
});

let projects = 0;

type ProjectFile = object | string | ((jsrRegistry: string) => string);

/** On several lines, so that the line of an error says which entry it is about. */
const manifest = (value: object) => JSON.stringify(value, null, 2) + "\n";

/** The machine's own registry configuration and proxy stay out of the tests. */
const isolatedEnv = (home: string) => ({
  ...installEnv(home),
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: home,
  BUN_CONFIG_REGISTRY: undefined,
  http_proxy: undefined,
  HTTP_PROXY: undefined,
  https_proxy: undefined,
  HTTPS_PROXY: undefined,
});

/** A project whose default registry and `@jsr` registry are the two above. */
function project(files: Record<string, ProjectFile>) {
  const id = `p${projects++}`;
  const base = `${registries.server.url.origin}/${id}`;
  const contents = (value: ProjectFile) =>
    typeof value === "function" ? value(`${base}/jsr/`) : typeof value === "string" ? value : JSON.stringify(value);
  const dir = tempDir("jsr-", {
    ...Object.fromEntries(Object.entries(files).map(([path, value]) => [path, contents(value)])),
    "bunfig.toml": ({ root }) =>
      Bun.TOML.stringify({
        install: {
          cache: join(root, ".bun-cache"),
          registry: { url: `${base}/npm/`, token: "token-of-the-default-registry" },
          saveTextLockfile: true,
          scopes: { "@jsr": `${base}/jsr/` },
        },
      })!,
  });
  const cwd = String(dir);
  const runIn = async (directory: string, ...args: string[]) => {
    await using proc = spawn({
      cmd: [bunExe(), ...args],
      cwd: join(cwd, directory),
      env: isolatedEnv(cwd),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    return { stdout, stderr, exitCode };
  };
  /** Runs a command that has to succeed. */
  const okIn = async (directory: string, ...args: string[]) => {
    const result = await runIn(directory, ...args);
    expect(result.stderr).not.toContain("error:");
    expect(result.exitCode).toBe(0);
    return result;
  };
  return {
    cwd,
    /** The registry requests of this project so far, as `<registry>: <path>`, sorted. */
    requests: () => [...(registries.requests.get(id) ?? [])].sort(),
    /** The requests that went to the default registry, sorted. A `jsr:` dependency makes none. */
    npmRequests: () => (registries.requests.get(id) ?? []).filter(request => request.startsWith("npm: ")).sort(),
    /** What `bun publish` sent. */
    published: () => registries.published.get(id),
    run: (...args: string[]) => runIn(".", ...args),
    ok: (...args: string[]) => okIn(".", ...args),
    okIn,
    json: (path: string) => file(join(cwd, path)).json(),
    text: (path: string) => file(join(cwd, path)).text(),
    /** bun.lock, parsed. */
    lockfile: async () => Bun.JSONC.parse(await file(join(cwd, "bun.lock")).text()) as any,
    /** `name@version` of the package that is installed at `<directory>/node_modules/<name>`. */
    async installed(name: string, directory = ".") {
      const { name: actual, version } = await file(join(cwd, directory, "node_modules", name, "package.json")).json();
      return `${actual}@${version}`;
    },
    /** `installed()` of several names. */
    async installedAll(names: string[], directory = ".") {
      const entries = names.map(async name => [name, await this.installed(name, directory)]);
      return Object.fromEntries(await Promise.all(entries));
    },
    [Symbol.dispose]: () => dir[Symbol.dispose](),
  };
}

describe.concurrent("bun install", () => {
  test("jsr:<range> installs the package that the dependency is named after", async () => {
    using p = project({ "package.json": { name: "app", dependencies: { "@std/path": "jsr:^1.0.0" } } });
    await p.ok("install");

    expect(await p.installedAll(["@std/path", "@jsr/std__internal"])).toEqual({
      "@std/path": "@jsr/std__path@1.1.0",
      "@jsr/std__internal": "@jsr/std__internal@1.0.6",
    });
    // Nothing is asked of the default registry, which has another `@std/path`.
    expect(p.requests()).toEqual([
      "jsr: @jsr/std__internal",
      "jsr: @jsr/std__path",
      "jsr: ~/11/@jsr/std__internal/1.0.6.tgz",
      "jsr: ~/11/@jsr/std__path/1.1.0.tgz",
    ]);
    // The specifier stays as it was written.
    expect(await p.json("package.json")).toEqual({ name: "app", dependencies: { "@std/path": "jsr:^1.0.0" } });
  });

  test("bun.lock has the npm: alias that each specifier stands for", async () => {
    const dependencies = {
      "@std/path": "jsr:~1.0.0",
      "std-path": "jsr:@std/path@2",
      "@luca/flag": "jsr:@luca/flag@^1.0.0",
      "flag": "npm:@jsr/luca__flag@^1.0.0",
      "uses-jsr": "1.0.0",
    };
    using p = project({ "package.json": { name: "app", dependencies } });
    await p.ok("install");

    const { workspaces, packages } = await p.lockfile();
    expect(workspaces[""].dependencies).toEqual({
      "@std/path": "npm:@jsr/std__path@~1.0.0",
      "std-path": "npm:@jsr/std__path@2",
      "@luca/flag": "npm:@jsr/luca__flag@^1.0.0",
      "flag": "npm:@jsr/luca__flag@^1.0.0",
      "uses-jsr": "1.0.0",
    });
    const resolved = Object.entries<any[]>(packages).map(([name, [resolution]]) => [name, resolution]);
    expect(Object.fromEntries(resolved)).toEqual({
      "@jsr/std__internal": "@jsr/std__internal@1.0.6",
      "@luca/flag": "@jsr/luca__flag@1.0.1",
      "@std/path": "@jsr/std__path@1.0.8",
      "flag": "@jsr/luca__flag@1.0.1",
      "std-path": "@jsr/std__path@2.0.0",
      "uses-jsr": "uses-jsr@1.0.0",
    });
    expect(packages["@std/path"].slice(1, 3)).toEqual([
      expect.stringMatching(/\/jsr\/~\/11\/@jsr\/std__path\/1\.0\.8\.tgz$/),
      { dependencies: { "@jsr/std__internal": "^1.0.5" } },
    ]);
    // What the package of the registry declares. The version that the project has is in its range.
    expect(packages["uses-jsr"][2]).toEqual({ dependencies: { "@std/path": "npm:@jsr/std__path@^1.0.0" } });
  });

  test.each([
    ["an exact version", { "@std/path": "jsr:1.0.0" }, { "@std/path": "@jsr/std__path@1.0.0" }],
    ["a dist-tag", { "@std/path": "jsr:canary" }, { "@std/path": "@jsr/std__path@2.1.0-canary.1" }],
    ["no version", { "@std/path": "jsr:@std/path" }, { "@std/path": "@jsr/std__path@2.0.0" }],
    ["a name and a range", { "@std/path": "jsr:@std/path@^1.0.0" }, { "@std/path": "@jsr/std__path@1.1.0" }],
    ["another name", { "std-path": "jsr:@std/path@~1.0.0" }, { "std-path": "@jsr/std__path@1.0.8" }],
    ["a range of two comparators", { "@std/path": "jsr:>=1.0.0 <1.1.0" }, { "@std/path": "@jsr/std__path@1.0.8" }],
    [
      "two names for one package",
      { "std-path": "jsr:@std/path@1.0.0", "@std/path": "jsr:2" },
      { "std-path": "@jsr/std__path@1.0.0", "@std/path": "@jsr/std__path@2.0.0" },
    ],
    ["whitespace around the range", { "@std/path": " jsr: ^1.0.0 " }, { "@std/path": "@jsr/std__path@1.1.0" }],
    ["whitespace around the name", { "path": " jsr: @std/path @ ~1.0.0 " }, { "path": "@jsr/std__path@1.0.8" }],
  ])("jsr: with %s", async (_, dependencies, expected) => {
    using p = project({ "package.json": { name: "app", dependencies } });
    await p.ok("install");
    expect(await p.installedAll(Object.keys(expected))).toEqual(expected);
    expect(p.npmRequests()).toEqual([]);
  });

  test("every dependency group takes jsr:", async () => {
    using p = project({
      "package.json": {
        name: "app",
        devDependencies: { "@luca/flag": "jsr:1.0.0" },
        optionalDependencies: { "@std/internal": "jsr:1.0.5" },
        peerDependencies: { "@std/path": "jsr:1.0.0" },
      },
    });
    await p.ok("install");
    expect(await p.installedAll(["@luca/flag", "@std/internal", "@std/path"])).toEqual({
      "@luca/flag": "@jsr/luca__flag@1.0.0",
      "@std/internal": "@jsr/std__internal@1.0.5",
      "@std/path": "@jsr/std__path@1.0.0",
    });
  });

  test("an install that has nothing to do leaves bun.lock as it is", async () => {
    using p = project({
      "package.json": {
        name: "root",
        workspaces: ["packages/*"],
        dependencies: { "@std/path": "jsr:^1.0.0", "no-deps": "^1.0.0" },
      },
      // The same package, spelled in the two other ways.
      "packages/a/package.json": { name: "a", dependencies: { "@std/path": "jsr:@std/path@^1.0.0" } },
      "packages/b/package.json": { name: "b", dependencies: { "@std/path": "npm:@jsr/std__path@^1.0.0" } },
    });
    await p.ok("install");
    const lockfile = await p.text("bun.lock");

    // Each of these writes bun.lock again.
    for (const args of [["install"], ["install", "--force"], ["install", "--lockfile-only"]]) {
      await p.ok(...args);
      expect(await p.text("bun.lock")).toBe(lockfile);
    }

    // From the lockfile alone: the tarballs are in the cache, so there is nothing to ask a registry for.
    await rm(join(p.cwd, "node_modules"), { recursive: true, force: true });
    const before = p.requests().length;
    await p.ok("install", "--frozen-lockfile");
    expect(p.requests().length).toBe(before);
    expect(await p.installed("@std/path")).toBe("@jsr/std__path@1.1.0");
  });

  test("a frozen install fails when a jsr: range changed", async () => {
    using p = project({ "package.json": { name: "app", dependencies: { "@std/path": "jsr:^1.0.0" } } });
    await p.ok("install");
    await write(join(p.cwd, "package.json"), JSON.stringify({ name: "app", dependencies: { "@std/path": "jsr:^2" } }));
    const { stderr, exitCode } = await p.run("install", "--frozen-lockfile");
    expect(stderr).toContain("lockfile had changes, but lockfile is frozen");
    expect(exitCode).toBe(1);
  });

  test("a jsr: specifier and the npm: alias it stands for are the same dependency", async () => {
    const spellings = ["jsr:^1.0.0", "npm:@jsr/std__path@^1.0.0", "jsr:@std/path@^1.0.0", "jsr:^1.0.0"];
    using p = project({ "package.json": { name: "app", dependencies: { "@std/path": spellings[0] } } });
    await p.ok("install");
    const lockfile = await p.text("bun.lock");
    const requests = p.requests();

    for (const spelling of spellings.slice(1)) {
      await write(
        join(p.cwd, "package.json"),
        JSON.stringify({ name: "app", dependencies: { "@std/path": spelling } }),
      );
      await p.ok("install", "--frozen-lockfile");
      // Not frozen: this one may write bun.lock, and has no reason to.
      await p.ok("install");
      expect(await p.text("bun.lock")).toBe(lockfile);
    }
    expect(p.requests()).toEqual(requests);
  });

  test("a bun.lock that has jsr: specifiers is read", async () => {
    // bun 1.3 copies the specifiers of a pnpm-lock.yaml into bun.lock as they are written.
    using p = project({
      "package.json": { name: "app", dependencies: { "@std/path": "jsr:^1.0.0", "std-path": "jsr:@std/path@~1.0.0" } },
    });
    await p.ok("install");
    const written = (await p.text("bun.lock"))
      .replace(`"@std/path": "npm:@jsr/std__path@^1.0.0"`, `"@std/path": "jsr:^1.0.0"`)
      .replace(`"std-path": "npm:@jsr/std__path@~1.0.0"`, `"std-path": "jsr:@std/path@~1.0.0"`);
    expect(written).toContain(`"std-path": "jsr:@std/path@~1.0.0"`);
    await write(join(p.cwd, "bun.lock"), written);
    await rm(join(p.cwd, "node_modules"), { recursive: true, force: true });

    await p.ok("install", "--frozen-lockfile");
    expect(await p.installedAll(["@std/path", "std-path"])).toEqual({
      "@std/path": "@jsr/std__path@1.1.0",
      "std-path": "@jsr/std__path@1.0.8",
    });
    // An install that changes nothing does not write the file, so a bun that reads `jsr:` as a git remote and
    // installs from this lockfile all the same continues to.
    await p.ok("install");
    expect(await p.text("bun.lock")).toBe(written);

    // One that does change something writes the aliases.
    await p.ok("add", "no-deps@1.0.0");
    expect((await p.lockfile()).workspaces[""].dependencies).toEqual({
      "@std/path": "npm:@jsr/std__path@^1.0.0",
      "no-deps": "1.0.0",
      "std-path": "npm:@jsr/std__path@~1.0.0",
    });
  });

  test("a bun.lock with a jsr: dependency of a package that names no JSR package is read", async () => {
    using p = project({ "package.json": { name: "app", dependencies: { "uses-jsr": "1.0.0" } } });
    await p.ok("install");
    const lockfile = await p.text("bun.lock");
    const edited = lockfile.replace(
      `"dependencies": { "@std/path": "npm:@jsr/std__path@^1.0.0" }`,
      `"dependencies": { "@std/path": "npm:@jsr/std__path@^1.0.0", "path": "jsr:^1.0.0" }`,
    );
    expect(edited).not.toBe(lockfile);
    await write(join(p.cwd, "bun.lock"), edited);
    await rm(join(p.cwd, "node_modules"), { recursive: true, force: true });

    const requests = p.requests().length;
    await p.ok("install", "--frozen-lockfile");
    // The lockfile was used: nothing was resolved again.
    expect(p.requests().length).toBe(requests);
    expect(await p.installed("@std/path")).toBe("@jsr/std__path@1.1.0");
  });

  test("the isolated linker", async () => {
    using p = project({ "package.json": { name: "app", dependencies: { "@std/path": "jsr:^1.0.0" } } });
    await p.ok("install", "--linker=isolated");
    expect(await p.installed("@std/path")).toBe("@jsr/std__path@1.1.0");
    expect(await exists(join(p.cwd, "node_modules", "@jsr"))).toBe(false);
  });

  test("workspaces and a catalog", async () => {
    using p = project({
      "package.json": {
        name: "root",
        workspaces: {
          packages: ["packages/*"],
          catalog: { "@luca/flag": "jsr:^1.0.0" },
          catalogs: { old: { "flag": "jsr:@luca/flag@1.0.0" } },
        },
      },
      "packages/a/package.json": {
        name: "a",
        dependencies: { "@std/path": "jsr:^1.0.0", "@luca/flag": "catalog:", "flag": "catalog:old" },
      },
      "packages/b/package.json": { name: "b", dependencies: { "@std/path": "jsr:^2.0.0" } },
    });
    await p.ok("install", "--linker=isolated");
    expect({
      a: await p.installedAll(["@std/path", "@luca/flag", "flag"], "packages/a"),
      b: await p.installedAll(["@std/path"], "packages/b"),
    }).toEqual({
      a: {
        "@std/path": "@jsr/std__path@1.1.0",
        "@luca/flag": "@jsr/luca__flag@1.0.1",
        "flag": "@jsr/luca__flag@1.0.0",
      },
      b: { "@std/path": "@jsr/std__path@2.0.0" },
    });
    expect(p.npmRequests()).toEqual([]);

    const { workspaces, catalog, catalogs } = await p.lockfile();
    expect({ catalog, catalogs, a: workspaces["packages/a"].dependencies }).toEqual({
      catalog: { "@luca/flag": "npm:@jsr/luca__flag@^1.0.0" },
      catalogs: { old: { "flag": "npm:@jsr/luca__flag@1.0.0" } },
      a: { "@luca/flag": "catalog:", "@std/path": "npm:@jsr/std__path@^1.0.0", "flag": "catalog:old" },
    });

    await p.ok("install", "--linker=isolated", "--frozen-lockfile");
  });

  test("a package of the registry that depends on jsr:", async () => {
    using p = project({
      "package.json": {
        name: "app",
        dependencies: { "no-deps": "1.0.0", "uses-jsr": "1.0.0", "uses-jsr-alias": "1.0.0" },
      },
    });
    await p.ok("install");
    expect(await p.installedAll(["@std/path", "std-path"])).toEqual({
      "@std/path": "@jsr/std__path@1.1.0",
      "std-path": "@jsr/std__path@2.0.0",
    });
    // The default registry is asked for the three packages and for nothing that a `jsr:` dependency is named after.
    expect(p.npmRequests()).toEqual([
      "npm: no-deps",
      "npm: uses-jsr",
      "npm: uses-jsr-alias",
      "npm: ~/11/no-deps/1.0.0.tgz",
      "npm: ~/11/uses-jsr-alias/1.0.0.tgz",
      "npm: ~/11/uses-jsr/1.0.0.tgz",
    ]);

    await rm(join(p.cwd, "node_modules"), { recursive: true, force: true });
    await p.ok("install", "--frozen-lockfile");
    expect(await p.installedAll(["@std/path", "std-path"])).toEqual({
      "@std/path": "@jsr/std__path@1.1.0",
      "std-path": "@jsr/std__path@2.0.0",
    });
  });

  test("a package of the registry with a jsr: dependency that names no JSR package", async () => {
    using p = project({ "package.json": { name: "app", dependencies: { "uses-invalid-jsr": "1.0.0" } } });
    // It is not this project's mistake: the rest of the package is installed.
    const { stderr } = await p.ok("install");
    expect(stderr).toContain(
      `warn: skipping invalid JSR dependency of uses-invalid-jsr@1.0.0 ("path": "jsr:^1.0.0" in "dependencies")`,
    );
    expect(await p.installed("no-deps")).toBe("no-deps@1.0.0");
    expect(await exists(join(p.cwd, "node_modules", "path"))).toBe(false);
    expect(p.requests()).toEqual([
      "npm: no-deps",
      "npm: uses-invalid-jsr",
      "npm: ~/11/no-deps/1.0.0.tgz",
      "npm: ~/11/uses-invalid-jsr/1.0.0.tgz",
    ]);
  });

  test("a folder with jsr: dependencies", async () => {
    using p = project({
      "package.json": { name: "app", dependencies: { "dep": "file:./dep" } },
      "dep/package.json": {
        name: "dep",
        version: "1.0.0",
        dependencies: { "@std/path": "jsr:^1.0.0", "path": "jsr:^1" },
      },
    });
    const { stderr } = await p.ok("install");
    // The folder is not a package of this project, so what is wrong in it is a warning.
    expect(stderr).toContain(`warn: skipping dependency "path": JSR package names have a scope, like jsr:@scope/name`);
    expect(await p.installed("@std/path")).toBe("@jsr/std__path@1.1.0");
    expect(p.npmRequests()).toEqual([]);
  });

  test.each([
    // the dependency, the message, where the specifier is in the package.json below
    ["a name without a scope", ["path", "jsr:^1.0.0"], "JSR package names have a scope, like jsr:@scope/name", "4:13"],
    ["a named package without a scope", ["path", "jsr:path@^1.0.0"], "JSR package names have a scope", "4:13"],
    ["a scope without a name", ["path", "jsr:@std@1"], "invalid JSR package name", "4:13"],
    ["a name that is not one", ["path", "jsr:@std/pa th@1"], "invalid JSR package name", "4:13"],
    ["a git repository", ["@std/path", "jsr:@std/path@github:denoland/std"], "invalid JSR version", "4:18"],
    ["a folder", ["@std/path", "jsr:@std/path@./std"], "invalid JSR version", "4:18"],
    ["a tarball", ["@std/path", "jsr:@std/path@path.tgz"], "invalid JSR version", "4:18"],
    ["another alias", ["@std/path", "jsr:@std/path@npm:left-pad"], "invalid JSR version", "4:18"],
    ["two versions", ["@std/path", "jsr:@std/path@1.0.0@latest"], "invalid JSR version", "4:18"],
  ])("jsr: with %s is an error", async (_, [name, specifier], message, location) => {
    using p = project({ "package.json": manifest({ name: "app", dependencies: { [name]: specifier } }) });
    const { stderr, exitCode } = await p.run("install");
    expect(stderr).toContain(`error: ${message}`);
    // It points at the specifier.
    expect(stderr).toContain(`package.json:${location}`);
    expect(stderr).not.toContain("git clone");
    expect(exitCode).toBe(1);
    expect(p.requests()).toEqual([]);
  });

  test("an entry of a catalog that names no JSR package is an error", async () => {
    using p = project({
      "package.json": manifest({
        name: "root",
        workspaces: { packages: ["packages/*"], catalog: { "path": "jsr:^1.0.0" } },
      }),
      "packages/a/package.json": { name: "a", dependencies: { "path": "catalog:" } },
    });
    const { stderr, exitCode } = await p.run("install");
    expect(stderr).toContain("error: JSR package names have a scope, like jsr:@scope/name");
    expect(stderr).toContain("package.json:8:15");
    expect(exitCode).toBe(1);
    expect(p.requests()).toEqual([]);
  });

  test("overrides take jsr: as a value and in the key of a rule", async () => {
    using p = project({
      "package.json": {
        name: "app",
        dependencies: { "no-deps": "^1.0.0", "uses-jsr": "1.0.0", "uses-jsr-alias": "1.0.0" },
        overrides: {
          // `no-deps` is replaced by a JSR package.
          "no-deps": "jsr:@luca/flag@1.0.0",
          // A `jsr:` dependency is an alias, and a rule is for an alias when its key says so.
          "@std/path@jsr:^1": "jsr:1.0.8",
          "std-path@jsr:@std/path@2": "jsr:@std/path@1.0.0",
        },
      },
    });
    const { stderr } = await p.ok("install");
    expect(stderr).not.toContain("warn:");
    expect(await p.installedAll(["no-deps", "@std/path", "std-path"])).toEqual({
      "no-deps": "@jsr/luca__flag@1.0.0",
      "@std/path": "@jsr/std__path@1.0.8",
      "std-path": "@jsr/std__path@1.0.0",
    });
    expect((await p.lockfile()).overrides).toEqual({
      "no-deps": "npm:@jsr/luca__flag@1.0.0",
      "@std/path@npm:@jsr/std__path@^1": { ".": "npm:@jsr/std__path@1.0.8" },
      "std-path@npm:@jsr/std__path@2": { ".": "npm:@jsr/std__path@1.0.0" },
    });
    await p.ok("install", "--frozen-lockfile");
  });

  test("an override that is $name takes the specifier of that dependency as it is written", async () => {
    using p = project({
      "package.json": {
        name: "app",
        dependencies: { "@luca/flag": "jsr:1.0.0", "uses-jsr": "1.0.0" },
        // `jsr:1.0.0` under the name `@std/path` is the JSR package `@std/path`, not `@luca/flag`.
        overrides: { "@std/path@jsr:^1": "$@luca/flag" },
      },
    });
    const { stderr } = await p.ok("install");
    expect(stderr).not.toContain("warn:");
    expect(await p.installedAll(["@std/path", "@luca/flag"])).toEqual({
      "@std/path": "@jsr/std__path@1.0.0",
      "@luca/flag": "@jsr/luca__flag@1.0.0",
    });
    await p.ok("install", "--frozen-lockfile");
  });

  test("packageExtensions take jsr:", async () => {
    using p = project({
      "package.json": {
        name: "app",
        dependencies: { "no-deps": "1.0.0" },
        packageExtensions: {
          "no-deps@1": { dependencies: { "@luca/flag": "jsr:^1.0.0", "internal": "jsr:@std/internal@1.0.5" } },
        },
      },
    });
    await p.ok("install");
    expect(await p.installedAll(["@luca/flag", "internal"])).toEqual({
      "@luca/flag": "@jsr/luca__flag@1.0.1",
      "internal": "@jsr/std__internal@1.0.5",
    });
    expect(p.npmRequests()).toEqual(["npm: no-deps", "npm: ~/11/no-deps/1.0.0.tgz"]);
    await p.ok("install", "--frozen-lockfile");
  });

  test("an import that the runtime installs", async () => {
    using p = project({
      "package.json": { name: "app", dependencies: { "@std/path": "jsr:~1.0.0", "std-path": "jsr:@std/path@2" } },
      "index.js": `console.log(require("@std/path"), require("std-path"));`,
    });
    const { stdout } = await p.ok("--install=force", "index.js");
    expect(stdout).toBe("@jsr/std__path@1.0.8 @jsr/std__path@2.0.0\n");
    expect(p.npmRequests()).toEqual([]);
  });

  test("a jsr: dependency that names no JSR package and that nothing imports leaves the runtime alone", async () => {
    using p = project({
      "package.json": {
        name: "app",
        dependencies: { "@std/path": "jsr:~1.0.0", "path": "jsr:^1.0.0" },
        overrides: { "@jsr/std__internal": "1.0.5" },
      },
      "index.js": `console.log(require("@std/path"), require("@jsr/std__internal"));`,
    });
    const { stdout, stderr } = await p.ok("--install=force", "index.js");
    // The override of the project is still read.
    expect(stdout).toBe("@jsr/std__path@1.0.8 @jsr/std__internal@1.0.5\n");
    expect(stderr).toBe("");
  });

  test("an import by a package in node_modules that the runtime installs", async () => {
    using p = project({
      "index.js": `console.log(require("installed"));`,
      "node_modules/installed/package.json": {
        name: "installed",
        version: "1.0.0",
        dependencies: { "@std/path": "jsr:~1.0.0" },
      },
      "node_modules/installed/index.js": `module.exports = require("@std/path");`,
    });
    const { stdout } = await p.ok("--install=fallback", "index.js");
    expect(stdout).toBe("@jsr/std__path@1.0.8\n");
    // Not `@std/path` of the default registry.
    expect(p.npmRequests()).toEqual([]);
  });

  test.each([
    [
      "the project",
      {
        "package.json": { name: "app", dependencies: { "no-deps": "jsr:^1.0.0" } },
        "index.js": `console.log(require("no-deps"));`,
      },
      "--install=force",
    ],
    [
      "a package in node_modules",
      {
        "index.js": `console.log(require("installed"));`,
        "node_modules/installed/package.json": {
          name: "installed",
          version: "1.0.0",
          dependencies: { "no-deps": "jsr:^1.0.0" },
        },
        "node_modules/installed/index.js": `module.exports = require("no-deps");`,
      },
      "--install=fallback",
    ],
  ])(
    "the runtime does not install another package for a jsr: dependency of %s that names none",
    async (_, files, mode) => {
      using p = project(files);
      const { stdout, stderr, exitCode } = await p.run(mode, "index.js");
      expect(stderr).toContain(`"no-deps" in "`);
      expect(stderr).toContain("JSR package names have a scope, like jsr:@scope/name");
      // `no-deps` of the default registry is another package.
      expect(stdout).toBe("");
      expect(p.requests()).toEqual([]);
      expect(exitCode).toBe(1);
    },
  );

  test("a pnpm-lock.yaml with jsr: specifiers is migrated", async () => {
    // What pnpm 10.18 writes for these dependencies, with `@std/path` held at a version that is not the newest.
    const resolution = (jsrRegistry: string, name: string, version: string) =>
      `{integrity: ${registries.integrity.get(`jsr/${name}@${version}`)}, tarball: ${jsrRegistry}~/11/${name}/${version}.tgz}`;
    using p = project({
      "package.json": {
        name: "app",
        dependencies: { "@std/path": "jsr:^1.0.0", "std-path": "jsr:@std/path@~1.0.0", "@luca/flag": "jsr:1.0.0" },
      },
      "pnpm-lock.yaml": jsrRegistry => `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      '@luca/flag':
        specifier: jsr:1.0.0
        version: '@jsr/luca__flag@1.0.0'
      '@std/path':
        specifier: jsr:^1.0.0
        version: '@jsr/std__path@1.0.8'
      std-path:
        specifier: jsr:@std/path@~1.0.0
        version: '@jsr/std__path@1.0.8'

packages:

  '@jsr/luca__flag@1.0.0':
    resolution: ${resolution(jsrRegistry, "@jsr/luca__flag", "1.0.0")}

  '@jsr/std__internal@1.0.5':
    resolution: ${resolution(jsrRegistry, "@jsr/std__internal", "1.0.5")}

  '@jsr/std__path@1.0.8':
    resolution: ${resolution(jsrRegistry, "@jsr/std__path", "1.0.8")}

snapshots:

  '@jsr/luca__flag@1.0.0': {}

  '@jsr/std__internal@1.0.5': {}

  '@jsr/std__path@1.0.8':
    dependencies:
      '@jsr/std__internal': 1.0.5
`,
    });
    const { stderr } = await p.ok("install");
    expect(stderr).toContain("migrated lockfile from pnpm-lock.yaml");
    expect(await p.installedAll(["@std/path", "std-path", "@luca/flag", "@jsr/std__internal"])).toEqual({
      "@std/path": "@jsr/std__path@1.0.8",
      "std-path": "@jsr/std__path@1.0.8",
      "@luca/flag": "@jsr/luca__flag@1.0.0",
      "@jsr/std__internal": "@jsr/std__internal@1.0.5",
    });
    expect((await p.lockfile()).workspaces[""].dependencies).toEqual({
      "@luca/flag": "npm:@jsr/luca__flag@1.0.0",
      "@std/path": "npm:@jsr/std__path@^1.0.0",
      "std-path": "npm:@jsr/std__path@~1.0.0",
    });
    await p.ok("install", "--frozen-lockfile");
  });
});

describe.concurrent("bun add", () => {
  test.each([
    // what is typed, the entry it leaves, the name it is installed under, what is installed
    ["jsr:@std/path", { "@std/path": "jsr:^2.0.0" }, "@std/path", "@jsr/std__path@2.0.0"],
    ["jsr:@std/path@^1.0.0", { "@std/path": "jsr:^1.0.0" }, "@std/path", "@jsr/std__path@1.1.0"],
    ["jsr:@std/path@1.0.8", { "@std/path": "jsr:1.0.8" }, "@std/path", "@jsr/std__path@1.0.8"],
    ["jsr:@std/path@1.x", { "@std/path": "jsr:1.x" }, "@std/path", "@jsr/std__path@1.1.0"],
    ["jsr:@std/path@canary", { "@std/path": "jsr:^2.1.0-canary.1" }, "@std/path", "@jsr/std__path@2.1.0-canary.1"],
    ["@std/path@jsr:~1.0.0", { "@std/path": "jsr:~1.0.0" }, "@std/path", "@jsr/std__path@1.0.8"],
    ["@std/path@jsr:@std/path", { "@std/path": "jsr:^2.0.0" }, "@std/path", "@jsr/std__path@2.0.0"],
    ["std-path@jsr:@std/path", { "std-path": "jsr:@std/path@^2.0.0" }, "std-path", "@jsr/std__path@2.0.0"],
    ["std-path@jsr:@std/path@^1", { "std-path": "jsr:@std/path@^1" }, "std-path", "@jsr/std__path@1.1.0"],
  ])("bun add %s", async (spec, dependencies, name, installed) => {
    using p = project({ "package.json": { name: "app" } });
    await p.ok("add", spec);
    expect(await p.json("package.json")).toEqual({ name: "app", dependencies });
    expect(await p.installed(name)).toBe(installed);
    expect(p.npmRequests()).toEqual([]);

    // The lockfile agrees with the package.json that was written.
    await p.ok("install", "--frozen-lockfile");
  });

  test("--exact and --dev", async () => {
    using p = project({ "package.json": { name: "app" } });
    await p.ok("add", "--exact", "--dev", "jsr:@std/path");
    expect(await p.json("package.json")).toEqual({ name: "app", devDependencies: { "@std/path": "jsr:2.0.0" } });
  });

  test("next to a package of the default registry, and again over the entry", async () => {
    using p = project({ "package.json": { name: "app", dependencies: { "@std/path": "jsr:^1.0.0" } } });
    await p.ok("add", "no-deps@1.0.0", "jsr:@luca/flag");
    expect(await p.json("package.json")).toEqual({
      name: "app",
      dependencies: { "@luca/flag": "jsr:^1.0.1", "@std/path": "jsr:^1.0.0", "no-deps": "1.0.0" },
    });
    expect(await p.installed("@std/path")).toBe("@jsr/std__path@1.1.0");

    // Like `bun add <name>`, it moves to the version that `latest` is.
    await p.ok("add", "jsr:@std/path");
    expect(await p.json("package.json")).toEqual({
      name: "app",
      dependencies: { "@luca/flag": "jsr:^1.0.1", "@std/path": "jsr:^2.0.0", "no-deps": "1.0.0" },
    });
    expect(await p.installed("@std/path")).toBe("@jsr/std__path@2.0.0");
  });

  test("the package of the default registry with the same name replaces the entry", async () => {
    using p = project({ "package.json": { name: "app", dependencies: { "@std/path": "jsr:^1.0.0" } } });
    await p.ok("install");
    await p.ok("add", "@std/path");
    expect(await p.json("package.json")).toEqual({ name: "app", dependencies: { "@std/path": "^9.9.9" } });
    expect(await p.installed("@std/path")).toBe("@std/path@9.9.9");
  });

  test("an npm: alias of the same package replaces the entry and stays an alias", async () => {
    using p = project({ "package.json": { name: "app", dependencies: { "@std/path": "jsr:^1.0.0" } } });
    await p.ok("install");
    await p.ok("add", "@std/path@npm:@jsr/std__path@2");
    expect(await p.json("package.json")).toEqual({
      name: "app",
      dependencies: { "@std/path": "npm:@jsr/std__path@2" },
    });
    expect(await p.installed("@std/path")).toBe("@jsr/std__path@2.0.0");
  });

  test("--catalog", async () => {
    using p = project({
      "package.json": { name: "root", workspaces: { packages: ["packages/*"], catalog: {} } },
      "packages/a/package.json": { name: "a" },
    });
    const specs = ["jsr:@std/path", "jsr:@luca/flag@1.0.0", "std-path@jsr:@std/path@~1.0.0"];
    await p.okIn("packages/a", "add", "--catalog", ...specs);
    expect(await p.json("packages/a/package.json")).toEqual({
      name: "a",
      dependencies: { "@luca/flag": "catalog:", "@std/path": "catalog:", "std-path": "catalog:" },
    });
    expect((await p.json("package.json")).workspaces.catalog).toEqual({
      "@luca/flag": "jsr:1.0.0",
      "@std/path": "jsr:^2.0.0",
      "std-path": "jsr:@std/path@~1.0.0",
    });
    await p.ok("install", "--frozen-lockfile");

    // `bun update` moves the entries of the catalog and keeps how they are spelled.
    await p.ok("update", "--latest");
    expect((await p.json("package.json")).workspaces.catalog).toEqual({
      "@luca/flag": "jsr:1.0.1",
      "@std/path": "jsr:^2.0.0",
      "std-path": "jsr:@std/path@~2.0.0",
    });
  });

  test("--catalog takes the entry that the catalog has", async () => {
    using p = project({
      "package.json": {
        name: "root",
        workspaces: { packages: ["packages/*"], catalog: { "@std/path": "jsr:^1.0.0" } },
      },
      "packages/a/package.json": { name: "a", dependencies: { "@std/path": "catalog:" } },
      "packages/b/package.json": { name: "b" },
      "packages/c/package.json": { name: "c" },
    });
    await p.ok("install");
    // Without a version, and with the one that the entry has.
    await p.okIn("packages/b", "add", "--catalog", "jsr:@std/path");
    await p.okIn("packages/c", "add", "jsr:@std/path@^1.0.0");
    expect({
      catalog: (await p.json("package.json")).workspaces.catalog,
      b: (await p.json("packages/b/package.json")).dependencies,
      c: (await p.json("packages/c/package.json")).dependencies,
    }).toEqual({
      catalog: { "@std/path": "jsr:^1.0.0" },
      b: { "@std/path": "catalog:" },
      c: { "@std/path": "catalog:" },
    });
    expect({
      b: await p.installed("@std/path", "packages/b"),
      c: await p.installed("@std/path", "packages/c"),
    }).toEqual({ b: "@jsr/std__path@1.1.0", c: "@jsr/std__path@1.1.0" });
  });

  test("an entry of the catalog for another package does not stand in for jsr:@scope/name", async () => {
    using p = project({
      "package.json": {
        name: "root",
        // `@std/path` of the default registry, and the JSR package in a catalog of its own.
        workspaces: {
          packages: ["packages/*"],
          catalog: { "@std/path": "^9.0.0" },
          catalogs: { jsr: { "@std/path": "jsr:^1.0.0" } },
        },
      },
      "packages/a/package.json": { name: "a" },
      "packages/b/package.json": { name: "b", dependencies: { "@std/path": "catalog:jsr" } },
      "packages/c/package.json": { name: "c" },
    });
    await p.ok("install");
    await p.okIn("packages/a", "add", "jsr:@std/path");
    // The entry that `b` refers to is the package that was asked for, and stays.
    await p.okIn("packages/b", "add", "--catalog", "jsr:@std/path");
    expect({
      catalogs: (await p.json("package.json")).workspaces,
      a: (await p.json("packages/a/package.json")).dependencies,
      b: (await p.json("packages/b/package.json")).dependencies,
    }).toEqual({
      catalogs: {
        packages: ["packages/*"],
        catalog: { "@std/path": "^9.0.0" },
        catalogs: { jsr: { "@std/path": "jsr:^1.0.0" } },
      },
      a: { "@std/path": "jsr:^2.0.0" },
      b: { "@std/path": "catalog:jsr" },
    });
    expect({
      a: await p.installed("@std/path", "packages/a"),
      b: await p.installed("@std/path", "packages/b"),
    }).toEqual({ a: "@jsr/std__path@2.0.0", b: "@jsr/std__path@1.1.0" });

    // With --catalog the entry of the other package is replaced, and the command says so.
    const { stderr } = await p.okIn("packages/c", "add", "--catalog", "jsr:@std/path");
    expect(stderr).toContain(`catalog entry @std/path changed from "^9.0.0" to "jsr:latest"`);
    expect((await p.json("package.json")).workspaces.catalog).toEqual({ "@std/path": "jsr:^2.0.0" });
    expect(await p.installed("@std/path", "packages/c")).toBe("@jsr/std__path@2.0.0");
    await p.ok("install", "--frozen-lockfile");
  });

  test("--catalog takes the range that the package.json has for jsr:@scope/name", async () => {
    using p = project({
      "package.json": { name: "root", workspaces: ["packages/*"] },
      "packages/a/package.json": { name: "a", dependencies: { "@std/path": "jsr:^1.0.0" } },
    });
    await p.ok("install");
    await p.okIn("packages/a", "add", "--catalog", "jsr:@std/path");
    const root = await p.json("package.json");
    expect({
      catalog: root.catalog ?? root.workspaces.catalog,
      a: (await p.json("packages/a/package.json")).dependencies,
      installed: await p.installed("@std/path", "packages/a"),
    }).toEqual({
      catalog: { "@std/path": "jsr:^1.0.0" },
      a: { "@std/path": "catalog:" },
      installed: "@jsr/std__path@1.1.0",
    });
  });

  test.each([
    ["jsr:path", `error: JSR package names have a scope, like jsr:@scope/name: jsr:path`],
    ["jsr:path@1.0.0", "error: JSR package names have a scope, like jsr:@scope/name: jsr:path@1.0.0"],
    ["jsr:^1.0.0", "error: JSR package names have a scope, like jsr:@scope/name: jsr:^1.0.0"],
    ["path@jsr:^1.0.0", "error: JSR package names have a scope, like jsr:@scope/name: path@jsr:^1.0.0"],
    ["jsr:@std", "error: invalid JSR package name: jsr:@std"],
    ["jsr:@std/path@github:denoland/std", "error: invalid JSR version: expected a version, a range or a tag: jsr:@std"],
    ["jsr:@std/path@1.0.0@latest", "error: invalid JSR version: expected a version, a range or a tag: jsr:@std"],
  ])("bun add %s is an error", async (spec, message) => {
    using p = project({ "package.json": { name: "app" } });
    const { stderr, exitCode } = await p.run("add", spec);
    expect(stderr).toContain(message);
    expect(exitCode).toBe(1);
    expect(p.requests()).toEqual([]);
    expect(await p.json("package.json")).toEqual({ name: "app" });
  });

  test("bun remove", async () => {
    using p = project({
      "package.json": {
        name: "app",
        dependencies: { "@std/path": "jsr:^1.0.0", "@luca/flag": "jsr:^1.0.0", "@std/internal": "jsr:^1.0.0" },
      },
    });
    await p.ok("install");
    // By the name of the dependency, and by what it was added as.
    await p.ok("remove", "@std/path", "jsr:@std/internal");
    expect(await p.json("package.json")).toEqual({ name: "app", dependencies: { "@luca/flag": "jsr:^1.0.0" } });
    expect(await exists(join(p.cwd, "node_modules", "@std"))).toBe(false);
  });
});

describe.concurrent("bun update", () => {
  // What `pnpm update` and `pnpm update --latest` (10.18) leave for the same three entries.
  const dependencies = {
    "@std/path": "jsr:^1.0.0",
    "std-path": "jsr:@std/path@~1.0.0",
    "@luca/flag": "jsr:1.0.0",
  };

  test("keeps jsr: and moves the range", async () => {
    using p = project({ "package.json": { name: "app", dependencies } });
    await p.ok("install");
    await p.ok("update");
    expect(await p.json("package.json")).toEqual({
      name: "app",
      dependencies: { "@std/path": "jsr:^1.1.0", "std-path": "jsr:@std/path@~1.0.8", "@luca/flag": "jsr:1.0.0" },
    });
    await p.ok("install", "--frozen-lockfile");
  });

  test("--latest", async () => {
    using p = project({ "package.json": { name: "app", dependencies } });
    await p.ok("install");
    await p.ok("update", "--latest");
    expect(await p.json("package.json")).toEqual({
      name: "app",
      dependencies: { "@std/path": "jsr:^2.0.0", "std-path": "jsr:@std/path@~2.0.0", "@luca/flag": "jsr:1.0.1" },
    });
    expect(await p.installedAll(["@std/path", "std-path"])).toEqual({
      "@std/path": "@jsr/std__path@2.0.0",
      "std-path": "@jsr/std__path@2.0.0",
    });
    await p.ok("install", "--frozen-lockfile");
  });

  test("of one dependency", async () => {
    using p = project({
      "package.json": {
        name: "app",
        dependencies: { "@std/path": "jsr:^1.0.0", "std-path": "jsr:@std/path@1.0.0", "@luca/flag": "jsr:~1.0.0" },
      },
    });
    await p.ok("install");
    await p.ok("update", "@std/path");
    expect(await p.json("package.json")).toEqual({
      name: "app",
      dependencies: { "@std/path": "jsr:^1.1.0", "std-path": "jsr:@std/path@1.0.0", "@luca/flag": "jsr:~1.0.0" },
    });

    await p.ok("update", "@std/path", "--latest");
    expect(await p.json("package.json")).toEqual({
      name: "app",
      dependencies: { "@std/path": "jsr:^2.0.0", "std-path": "jsr:@std/path@1.0.0", "@luca/flag": "jsr:~1.0.0" },
    });
    expect(await p.installedAll(["@std/path", "std-path"])).toEqual({
      "@std/path": "@jsr/std__path@2.0.0",
      "std-path": "@jsr/std__path@1.0.0",
    });
    await p.ok("install", "--frozen-lockfile");
  });

  test("of one dependency keeps the form it is written in", async () => {
    using p = project({ "package.json": { name: "app", dependencies: { "@std/path": "jsr:@std/path@^1.0.0" } } });
    await p.ok("install");
    await p.ok("update", "@std/path");
    expect(await p.json("package.json")).toEqual({
      name: "app",
      dependencies: { "@std/path": "jsr:@std/path@^1.1.0" },
    });
    await p.ok("install", "--frozen-lockfile");
  });

  test("of one dependency keeps a range that names no version", async () => {
    // `bun update no-deps` leaves "1.x", ">=1.0.0 <2.0.0" and "*" as they are. So does it behind `jsr:`.
    const ranges = { "@std/path": "jsr:1.x", "std-path": "jsr:@std/path@>=1.0.0 <2.0.0", "@luca/flag": "jsr:*" };
    using p = project({ "package.json": { name: "app", dependencies: ranges } });
    await p.ok("install");
    await p.ok("update", "@std/path", "std-path", "@luca/flag");
    expect(await p.json("package.json")).toEqual({ name: "app", dependencies: ranges });
    expect(await p.installedAll(["@std/path", "std-path", "@luca/flag"])).toEqual({
      "@std/path": "@jsr/std__path@1.1.0",
      "std-path": "@jsr/std__path@1.1.0",
      "@luca/flag": "@jsr/luca__flag@1.0.1",
    });
    await p.ok("install", "--frozen-lockfile");
  });

  test("of jsr:@scope/name is the dependency of that name", async () => {
    using p = project({ "package.json": { name: "app", dependencies } });
    await p.ok("install");
    // Not a request for the tag `latest`: the entry stays in its range.
    await p.ok("update", "jsr:@std/path");
    expect(await p.json("package.json")).toEqual({
      name: "app",
      dependencies: { ...dependencies, "@std/path": "jsr:^1.1.0" },
    });
    expect(await p.installed("@std/path")).toBe("@jsr/std__path@1.1.0");

    await p.ok("update", "--latest", "jsr:@std/path");
    expect(await p.json("package.json")).toEqual({
      name: "app",
      dependencies: { ...dependencies, "@std/path": "jsr:^2.0.0" },
    });
    await p.ok("install", "--frozen-lockfile");
  });

  test("of the npm package, which every entry for it follows", async () => {
    using p = project({
      "package.json": {
        name: "app",
        dependencies: {
          "@std/path": "jsr:^1.0.0",
          "std-path": "jsr:@std/path@^1.0.0",
          "std-path-alias": "npm:@jsr/std__path@^1.0.0",
          "@luca/flag": "jsr:~1.0.0",
        },
      },
    });
    await p.ok("install");
    await p.ok("update", "@jsr/std__path", "--latest");
    expect(await p.json("package.json")).toEqual({
      name: "app",
      dependencies: {
        "@std/path": "jsr:^2.0.0",
        "std-path": "jsr:@std/path@^2.0.0",
        "std-path-alias": "npm:@jsr/std__path@^2.0.0",
        "@luca/flag": "jsr:~1.0.0",
      },
    });
    await p.ok("install", "--frozen-lockfile");
  });

  test("to a range", async () => {
    using p = project({ "package.json": { name: "app", dependencies: { "@std/path": "jsr:~1.0.0" } } });
    await p.ok("install");
    await p.ok("update", "@std/path@^2");
    // The entry keeps how it pins a version, as an entry of the default registry does.
    expect(await p.json("package.json")).toEqual({ name: "app", dependencies: { "@std/path": "jsr:~2.0.0" } });
    expect(await p.installed("@std/path")).toBe("@jsr/std__path@2.0.0");
  });

  test("bun outdated", async () => {
    using p = project({ "package.json": { name: "app", dependencies: { "@std/path": "jsr:1.0.0" } } });
    await p.ok("install");
    const { stdout } = await p.ok("outdated");
    const rows = stdout
      .split("\n")
      .filter(line => line.includes("@std/path"))
      .map(line => line.split(/[│|]/).map(cell => cell.trim()));
    // package, current, update, latest
    expect(rows).toEqual([["", "@std/path@npm:@jsr/std__path", "1.0.0", "1.0.0", "2.0.0", ""]]);
  });

  test("bun info", async () => {
    using p = project({ "package.json": { name: "app" } });
    expect((await p.ok("info", "jsr:@std/path", "version")).stdout).toBe("2.0.0\n");
    expect((await p.ok("info", "jsr:@std/path@^1", "version")).stdout).toBe("1.1.0\n");
    expect(p.npmRequests()).toEqual([]);

    const { stderr, exitCode } = await p.run("info", "jsr:path");
    expect(stderr).toContain("error: JSR package names have a scope, like jsr:@scope/name: jsr:path");
    expect(exitCode).toBe(1);

    const json = await p.run("info", "jsr:path", "--json");
    expect(JSON.parse(json.stdout)).toEqual({
      error: "JSR package names have a scope, like jsr:@scope/name",
      version: "jsr:path",
    });
    expect(json.exitCode).toBe(1);
  });
});

describe.concurrent("bun pm pack", () => {
  const packed = (tarball: string) =>
    JSON.parse(readTarball(tarball).entries.find((entry: any) => entry.pathname === "package/package.json").contents);
  // `pnpm pack` (10.18) writes the same for these, except that it refuses `repo`.
  const written = {
    dependencies: {
      "@std/path": "jsr:^1.0.0",
      "std-path": "jsr:@std/path@~1.0.0",
      "@luca/flag": "jsr:1.0.0",
      "internal": "jsr:@std/internal",
      "no-deps": "^1.0.0",
      // A git remote on a host that is named `jsr`, as before.
      "repo": "jsr:owner/repo.git",
    },
    devDependencies: { "@std/internal": "jsr:latest" },
    peerDependencies: { "flag": "jsr:@luca/flag@1" },
  };
  const publishedAs = {
    dependencies: {
      "@std/path": "npm:@jsr/std__path@^1.0.0",
      "std-path": "npm:@jsr/std__path@~1.0.0",
      "@luca/flag": "npm:@jsr/luca__flag@1.0.0",
      "internal": "npm:@jsr/std__internal",
      "no-deps": "^1.0.0",
      "repo": "jsr:owner/repo.git",
    },
    devDependencies: { "@std/internal": "npm:@jsr/std__internal@latest" },
    peerDependencies: { "flag": "npm:@jsr/luca__flag@1" },
  };

  test("writes the npm: alias of a jsr: dependency, which a package manager without jsr: reads", async () => {
    using p = project({ "package.json": { name: "lib", version: "1.2.3", ...written } });
    await p.ok("pm", "pack");

    expect(packed(join(p.cwd, "lib-1.2.3.tgz"))).toEqual({ name: "lib", version: "1.2.3", ...publishedAs });
    // The project keeps what was written.
    expect(await p.json("package.json")).toEqual({ name: "lib", version: "1.2.3", ...written });
  });

  test("bun publish sends the same", async () => {
    using p = project({ "package.json": { name: "lib", version: "1.2.3", ...written } });
    await p.ok("publish");

    const { versions, _attachments } = p.published();
    expect(versions["1.2.3"]).toMatchObject(publishedAs);
    await write(join(p.cwd, "published.tgz"), Buffer.from(_attachments["lib-1.2.3.tgz"].data, "base64"));
    expect(packed(join(p.cwd, "published.tgz"))).toEqual({ name: "lib", version: "1.2.3", ...publishedAs });
  });

  test("a jsr: entry of a catalog", async () => {
    using p = project({
      "package.json": {
        name: "root",
        workspaces: { packages: ["packages/*"], catalog: { "@std/path": "jsr:^1.0.0" } },
      },
      "packages/lib/package.json": { name: "lib", version: "1.2.3", dependencies: { "@std/path": "catalog:" } },
    });
    await p.ok("install");
    await p.okIn("packages/lib", "pm", "pack");
    expect(packed(join(p.cwd, "packages", "lib", "lib-1.2.3.tgz")).dependencies).toEqual({
      "@std/path": "npm:@jsr/std__path@^1.0.0",
    });
  });

  test("a jsr: specifier that names no JSR package is an error", async () => {
    using p = project({ "package.json": { name: "lib", version: "1.2.3", dependencies: { "path": "jsr:^1.0.0" } } });
    const { stderr, exitCode } = await p.run("pm", "pack");
    expect(stderr).toContain(`error: Failed to resolve JSR version for "path" in \`dependencies\``);
    expect(stderr).toContain("JSR package names have a scope");
    expect(exitCode).toBe(1);
    expect(await exists(join(p.cwd, "lib-1.2.3.tgz"))).toBe(false);
  });

  test("bun pm diff reads a folder as it is published, and two folders as they are written", async () => {
    const lib = { name: "lib", version: "1.2.3", dependencies: { "@std/path": "jsr:^1.0.0" } };
    const alias = { ...lib, dependencies: { "@std/path": "npm:@jsr/std__path@^1.0.0" } };
    using p = project({
      "lib/package.json": manifest(lib),
      "lib/index.js": "module.exports = 1;\n",
      "alias/package.json": manifest(alias),
      "alias/index.js": "module.exports = 1;\n",
      "out/.keep": "",
    });
    await p.okIn("lib", "pm", "pack", "--quiet", "--destination", join(p.cwd, "out"));
    const tarball = join(p.cwd, "out", "lib-1.2.3.tgz");

    // The tarball has the alias, and that is what the folder publishes.
    expect(packed(tarball).dependencies).toEqual(alias.dependencies);
    expect(await p.run("pm", "diff", tarball, "./lib")).toEqual({
      stdout: `${tarball} → ./lib\nNo differences (2 files)\n`,
      stderr: "",
      exitCode: 0,
    });
    // Two folders: the difference between the files on disk.
    const folders = await p.run("pm", "diff", "./lib", "./alias", "--json");
    expect(JSON.parse(folders.stdout)).toMatchObject({
      files: [{ path: "package.json", linesAdded: 1, linesRemoved: 1 }],
      notes: ["dependencies @std/path: jsr:^1.0.0 → npm:@jsr/std__path@^1.0.0"],
    });
    expect(folders.exitCode).toBe(0);
  });

  test("bun pm diff takes jsr:@scope/name", async () => {
    using p = project({ "package.json": { name: "app" } });
    const { stdout, exitCode } = await p.run("pm", "diff", "jsr:@std/path@1.0.0", "jsr:@std/path@1.0.8", "--name-only");
    expect(stdout.split("\n").filter(line => /^[AMD] /.test(line))).toEqual(["M index.js", "M package.json"]);
    expect(exitCode).toBe(0);
    expect(p.npmRequests()).toEqual([]);

    const invalid = await p.run("pm", "diff", "jsr:path@1.0.0", "jsr:path@1.0.8");
    expect(invalid.stderr).toContain("error: JSR package names have a scope, like jsr:@scope/name: jsr:path@1.0.0");
    expect(invalid.exitCode).toBe(1);
  });
});

describe("the registry of the @jsr scope", () => {
  /** A proxy that records where each request wants to go and lets none through. */
  function proxy() {
    const hosts: string[] = [];
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket, data) {
          hosts.push(data.toString().split("\r\n")[0]);
          socket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n");
        },
      },
    });
    return { hosts, url: `http://127.0.0.1:${server.port}`, [Symbol.dispose]: () => void server.stop(true) };
  }

  const dependencies = { "@std/path": "jsr:^1.0.0", "flag": "npm:@jsr/luca__flag@1.0.0", "no-deps": "1.0.0" };

  /** Where `bun install` goes for these three dependencies. */
  async function hostsOf(files: Record<string, string>, env: Record<string, string> = {}, args: string[] = []) {
    using blocked = proxy();
    using dir = tempDir("jsr-default-", {
      "package.json": JSON.stringify({ name: "app", dependencies }),
      ...files,
    });
    const { url } = blocked;
    await using proc = spawn({
      cmd: [bunExe(), "install", ...args],
      cwd: String(dir),
      env: {
        ...isolatedEnv(String(dir)),
        ...{ http_proxy: url, HTTP_PROXY: url, https_proxy: url, HTTPS_PROXY: url, no_proxy: "", NO_PROXY: "" },
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([proc.stderr.text(), proc.exited]);
    // Every request was refused.
    expect(stderr).toContain("error:");
    expect(exitCode).toBe(1);
    return blocked.hosts.sort();
  }

  const jsr = "CONNECT npm.jsr.io:443 HTTP/1.1";
  const npm = "CONNECT registry.npmjs.org:443 HTTP/1.1";
  const configured = "CONNECT jsr.example.com:443 HTTP/1.1";
  const mirror = "CONNECT registry.example.com:443 HTTP/1.1";

  test.concurrent.each([
    ["nothing is configured", {}],
    ["npm's registry is the one that is configured", { ".npmrc": "registry=https://registry.npmjs.org\n" }],
  ])("is npm.jsr.io when %s", async (_, config) => {
    expect(await hostsOf(config)).toEqual([jsr, jsr, npm]);
  });

  test.concurrent.each([
    [".npmrc", { ".npmrc": "@jsr:registry=https://jsr.example.com/npm/\n" }],
    ["bunfig.toml", { "bunfig.toml": `[install.scopes]\n"@jsr" = "https://jsr.example.com/npm/"\n` }],
  ])("is the one that %s has for the scope", async (_, config) => {
    expect(await hostsOf(config)).toEqual([configured, configured, npm]);
  });

  // As for every scope. The token was written for the default registry, so it does not go to JSR.
  test.concurrent("is the default registry for an entry of the scope that only has a token", async () => {
    expect(await hostsOf({ "bunfig.toml": `[install.scopes]\n"@jsr" = { token = "abc" }\n` })).toEqual([npm, npm, npm]);
  });

  // A registry that stands in for npm's may have the packages of JSR, and what a lockfile pinned there stays there.
  test.concurrent.each([
    ["bunfig.toml", { "bunfig.toml": `[install]\nregistry = "https://registry.example.com/"\n` }, {}],
    [".npmrc", { ".npmrc": "registry=https://registry.example.com/\n" }, {}],
    ["the environment", {}, { BUN_CONFIG_REGISTRY: "https://registry.example.com/" }],
  ])("is the default registry when %s has another than npm's", async (_, config, env) => {
    expect(await hostsOf(config, env)).toEqual([mirror, mirror, mirror]);
  });

  test.concurrent("follows --registry", async () => {
    const bunfig = `[install]\nregistry = "https://registry.example.com/"\n`;
    expect(await hostsOf({}, {}, ["--registry", "https://registry.example.com/"])).toEqual([mirror, mirror, mirror]);
    expect(await hostsOf({ "bunfig.toml": bunfig }, {}, ["--registry", "https://registry.npmjs.org/"])).toEqual([
      jsr,
      jsr,
      npm,
    ]);
    // The token of the scope stays with the registry of the config files, which it was written for.
    const withToken = `${bunfig}[install.scopes]\n"@jsr" = { token = "abc" }\n`;
    expect(await hostsOf({ "bunfig.toml": withToken }, {}, ["--registry", "https://registry.npmjs.org/"])).toEqual([
      mirror,
      mirror,
      npm,
    ]);
  });

  test.concurrent("is the one that is configured for the scope, next to another default registry", async () => {
    const bunfig = `[install]\nregistry = "https://registry.example.com/"\n[install.scopes]\n"@jsr" = "https://jsr.example.com/npm/"\n`;
    expect(await hostsOf({ "bunfig.toml": bunfig })).toEqual([configured, configured, mirror]);
  });
});
