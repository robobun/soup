import { spawn } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { bunEnv, bunExe, tempDir } from "harness";
import { join } from "path";
import { installEnv, TestRegistry } from "registry";
import { pathToFileURL } from "url";

type Files = Record<string, string>;
type Linker = "hoisted" | "isolated";

const registry = new TestRegistry();

beforeAll(async () => {
  await registry.start();
});

afterAll(() => {
  registry.stop();
});

// resolve@1.9.0 depends on path-parse@1.0.6. one-dep@1.0.0 depends on no-deps@1.0.1, which does not fit the
// no-deps@1.0.0 of the project and is installed below one-dep.
const fixture: Files = {
  "package.json": JSON.stringify({
    name: "sbom-fixture",
    version: "1.2.3",
    description: "A project with dependencies",
    license: "Apache-2.0",
    author: { name: "Ada", email: "ada@example.com" },
    homepage: "https://example.com/sbom-fixture",
    dependencies: { "resolve": "1.9.0", "no-deps": "1.0.0", "one-dep": "1.0.0" },
    devDependencies: { "a-dep": "1.0.1" },
  }),
};

// A private root with two members. `foo` depends on `bar`.
const monorepo: Files = {
  "package.json": JSON.stringify({ name: "mono", private: true, workspaces: ["packages/*"] }),
  "packages/foo/package.json": JSON.stringify({
    name: "@mono/foo",
    version: "1.0.0",
    license: "MIT",
    dependencies: { "@mono/bar": "workspace:*", "no-deps": "1.0.0" },
  }),
  "packages/bar/package.json": JSON.stringify({
    name: "@mono/bar",
    version: "2.0.0",
    private: true,
    dependencies: { "@scoped/no-deps": "1.0.0" },
  }),
};

// Not disposed: the tests and the installs they spawn read it until the file is done.
const gitConfigDir = tempDir("sbom-gitconfig", { gitconfig: "" });
const gitEnv = {
  ...bunEnv,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: join(String(gitConfigDir), "gitconfig"),
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

async function gitRepo(manifest: Record<string, unknown>) {
  const repoDir = tempDir("sbom-git-repo", { "package.json": JSON.stringify(manifest) });
  let commit = "";
  for (const args of [
    ["init", "-q"],
    ["add", "package.json"],
    ["commit", "-q", "-m", "init", "--no-gpg-sign"],
    ["rev-parse", "HEAD"],
  ]) {
    await using proc = spawn({
      cmd: ["git", ...args],
      cwd: String(repoDir),
      env: gitEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect(stderr).not.toContain("fatal:");
    expect(exitCode).toBe(0);
    commit = stdout.trim();
  }
  return { url: `git+${pathToFileURL(String(repoDir))}`, commit, [Symbol.dispose]: () => repoDir[Symbol.dispose]() };
}

async function install(dir: string, ...args: string[]) {
  await using proc = spawn({
    cmd: [bunExe(), "install", ...args],
    env: installEnv(dir, gitEnv),
    cwd: dir,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([proc.stderr.text(), proc.exited]);
  expect(stderr).not.toContain("error:");
  expect(exitCode).toBe(0);
}

async function setup(files: Files = fixture, linker: Linker = "hoisted", ...installArgs: string[]) {
  const { packageDir } = await registry.createTestDir({ bunfigOpts: { linker }, files });
  await install(packageDir, ...installArgs);
  return packageDir;
}

async function sbom(dir: string, ...args: string[]) {
  await using proc = spawn({
    cmd: [bunExe(), "pm", "sbom", ...args],
    env: bunEnv,
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const DIGEST = "<the sha512 of bun.lock>";

// The sha512 of every package of bun.lock that has one, as hex, by the first field of its row (`name@version`).
function lockedDigests(dir: string) {
  const lock = Bun.JSONC.parse(readFileSync(join(dir, "bun.lock"), "utf8")) as { packages: Record<string, unknown[]> };
  const digests: Record<string, string> = {};
  for (const row of Object.values(lock.packages)) {
    const integrity = row.find(field => typeof field === "string" && field.startsWith("sha512-")) as string | undefined;
    if (integrity) digests[row[0] as string] = Buffer.from(integrity.slice("sha512-".length), "base64").toString("hex");
  }
  return digests;
}

const withoutRegistry = (url: string) => url.replace(registry.registryUrl(), "<registry>/");

// Parses a CycloneDX document and takes out of it what differs from run to run, after a look at each such value.
function stableCyclonedx(dir: string, stdout: string) {
  expect(stdout.endsWith("}\n")).toBeTrue();
  const doc = JSON.parse(stdout);

  expect(doc.serialNumber).toMatch(new RegExp(`^urn:uuid:${UUID}$`));
  expect(doc.metadata.timestamp).toMatch(TIMESTAMP);
  expect(doc.metadata.tools).toEqual({ components: [{ type: "application", name: "bun", version: Bun.version }] });
  delete doc.serialNumber;
  delete doc.metadata.timestamp;
  delete doc.metadata.tools;

  const digests = lockedDigests(dir);
  for (const component of doc.components) {
    for (const reference of component.externalReferences ?? []) reference.url = withoutRegistry(reference.url);
    if (component.purl) component.purl = withoutRegistry(component.purl);
    if (component.hashes) {
      expect(component.hashes).toEqual([{ alg: "SHA-512", content: digests[component["bom-ref"]] }]);
      component.hashes = DIGEST;
    }
  }
  return doc;
}

async function cyclonedx(dir: string, ...args: string[]) {
  const { stdout, stderr, exitCode } = await sbom(dir, ...args);
  expect(stderr).toBe("");
  const doc = stableCyclonedx(dir, stdout);
  expect(exitCode).toBe(0);
  return doc;
}

// A directory with one `file:` dependency for each of `manifests`, named `dep00`, `dep01`, ... so that one
// `bun pm sbom` shows what it makes of each.
async function setupWithManifests(manifests: Record<string, unknown>[]) {
  const names = manifests.map((_, i) => `dep${String(i).padStart(2, "0")}`);
  return await setup({
    "package.json": JSON.stringify({
      name: "manifests-fixture",
      version: "1.0.0",
      dependencies: Object.fromEntries(names.map(name => [name, `file:./deps/${name}`])),
    }),
    ...Object.fromEntries(
      manifests.map((manifest, i) => [
        `deps/${names[i]}/package.json`,
        JSON.stringify({ name: names[i], version: "1.0.0", ...manifest }),
      ]),
    ),
  });
}

function stableSpdx(dir: string, stdout: string) {
  const doc = JSON.parse(stdout);

  expect(doc.creationInfo).toEqual({
    created: expect.stringMatching(TIMESTAMP),
    creators: [`Tool: bun-${Bun.version}`],
  });
  expect(doc.documentNamespace).toMatch(new RegExp(`^http://spdx\\.org/spdxdocs/[A-Za-z0-9.-]+-${UUID}$`));
  delete doc.creationInfo;
  // A UUID is 36 characters.
  doc.documentNamespace = doc.documentNamespace.slice(0, -36) + "<uuid>";

  const digests = lockedDigests(dir);
  for (const pkg of doc.packages) {
    if (pkg.checksums) {
      // A registry package is `name@version` in bun.lock, a tarball is `name@url`.
      const digest = digests[`${pkg.name}@${pkg.versionInfo}`] ?? digests[`${pkg.name}@${pkg.downloadLocation}`];
      expect(pkg.checksums).toEqual([{ algorithm: "SHA512", checksumValue: digest }]);
      pkg.checksums = DIGEST;
    }
    pkg.downloadLocation = withoutRegistry(pkg.downloadLocation);
  }
  return doc;
}

async function spdx(dir: string, ...args: string[]) {
  const { stdout, stderr, exitCode } = await sbom(dir, "--sbom-format", "spdx", ...args);
  expect(stderr).toBe("");
  const doc = stableSpdx(dir, stdout);
  expect(exitCode).toBe(0);
  return doc;
}

// A package of the test registry as a CycloneDX component. The registry packages have no license.
const library = (name: string, version: string, rest: Record<string, unknown> = {}) => ({
  "bom-ref": `${name}@${version}`,
  type: "library",
  name,
  version,
  scope: "required",
  purl: `pkg:npm/${name}@${version}`,
  hashes: DIGEST,
  externalReferences: [{ type: "distribution", url: `<registry>/${name}/-/${name}-${version}.tgz` }],
  properties: [{ name: "cdx:npm:package:path", value: `node_modules/${name}` }],
  ...rest,
});

const pathParse = {
  description: "Node.js path.parse() ponyfill",
  // The author of path-parse has a site where an email goes: `Javier Blanco <http://jbgutierrez.info>`.
  authors: [{ name: "Javier Blanco" }],
  licenses: [{ license: { id: "MIT" } }],
  externalReferences: [
    { type: "distribution", url: "<registry>/path-parse/-/path-parse-1.0.6.tgz" },
    { type: "vcs", url: "https://github.com/jbgutierrez/path-parse.git" },
    { type: "website", url: "https://github.com/jbgutierrez/path-parse#readme" },
    { type: "issue-tracker", url: "https://github.com/jbgutierrez/path-parse/issues" },
  ],
};

const resolve = {
  description: "resolve like require.resolve() on behalf of files asynchronously and synchronously",
  authors: [{ name: "James Halliday", email: "mail@substack.net" }],
  licenses: [{ license: { id: "MIT" } }],
  externalReferences: [
    { type: "distribution", url: "<registry>/resolve/-/resolve-1.9.0.tgz" },
    { type: "vcs", url: "git://github.com/browserify/resolve.git" },
  ],
};

const project = {
  "bom-ref": "sbom-fixture@1.2.3",
  type: "library",
  name: "sbom-fixture",
  version: "1.2.3",
  scope: "required",
  description: "A project with dependencies",
  authors: [{ name: "Ada", email: "ada@example.com" }],
  licenses: [{ license: { id: "Apache-2.0" } }],
  purl: "pkg:npm/sbom-fixture@1.2.3",
  externalReferences: [{ type: "website", url: "https://example.com/sbom-fixture" }],
  properties: [{ name: "cdx:npm:package:path", value: "" }],
};

const development = { name: "cdx:npm:package:development", value: "true" };

// The scope of each component, with a note for the ones that are there for development alone.
const scopes = (doc: any) =>
  Object.fromEntries(
    doc.components.map((component: any) => [
      component["bom-ref"],
      (component.properties ?? []).some((property: any) => property.name === development.name)
        ? `${component.scope}, for development`
        : component.scope,
    ]),
  );

const relationships = (doc: any) =>
  doc.relationships.map((r: any) => [r.spdxElementId, r.relationshipType, r.relatedSpdxElement]);

describe("bun pm sbom", () => {
  let dir: string;
  let isolatedDir: string;
  let monoDir: string;

  beforeAll(async () => {
    [dir, isolatedDir, monoDir] = await Promise.all([setup(), setup(fixture, "isolated"), setup(monorepo)]);
  });

  test.concurrent("prints a CycloneDX document of the project and what it depends on", async () => {
    expect(await cyclonedx(dir)).toEqual({
      $schema: "http://cyclonedx.org/schema/bom-1.6.schema.json",
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      version: 1,
      metadata: { lifecycles: [{ phase: "build" }], component: project },
      components: [
        library("a-dep", "1.0.1", {
          properties: [{ name: "cdx:npm:package:path", value: "node_modules/a-dep" }, development],
        }),
        library("no-deps", "1.0.0"),
        library("no-deps", "1.0.1", {
          properties: [{ name: "cdx:npm:package:path", value: "node_modules/one-dep/node_modules/no-deps" }],
        }),
        library("one-dep", "1.0.0"),
        library("path-parse", "1.0.6", pathParse),
        library("resolve", "1.9.0", resolve),
      ],
      dependencies: [
        { ref: "sbom-fixture@1.2.3", dependsOn: ["a-dep@1.0.1", "no-deps@1.0.0", "one-dep@1.0.0", "resolve@1.9.0"] },
        { ref: "a-dep@1.0.1", dependsOn: [] },
        { ref: "no-deps@1.0.0", dependsOn: [] },
        { ref: "no-deps@1.0.1", dependsOn: [] },
        { ref: "one-dep@1.0.0", dependsOn: ["no-deps@1.0.1"] },
        { ref: "path-parse@1.0.6", dependsOn: [] },
        { ref: "resolve@1.9.0", dependsOn: ["path-parse@1.0.6"] },
      ],
    });
  });

  test.concurrent("--sbom-format spdx prints an SPDX document", async () => {
    const npm = (name: string, version: string, path: string, rest: Record<string, unknown> = {}) => ({
      name,
      SPDXID: `SPDXRef-Package-${name}-${version}`,
      versionInfo: version,
      packageFileName: path,
      downloadLocation: `<registry>/${name}/-/${name}-${version}.tgz`,
      filesAnalyzed: false,
      homepage: "NOASSERTION",
      licenseDeclared: "NOASSERTION",
      externalRefs: [
        { referenceCategory: "PACKAGE-MANAGER", referenceType: "purl", referenceLocator: `pkg:npm/${name}@${version}` },
      ],
      checksums: DIGEST,
      ...rest,
    });
    const id = (name: string) => `SPDXRef-Package-${name}`;
    const root = id("sbom-fixture-1.2.3");

    expect(await spdx(dir)).toEqual({
      spdxVersion: "SPDX-2.3",
      dataLicense: "CC0-1.0",
      SPDXID: "SPDXRef-DOCUMENT",
      name: "sbom-fixture@1.2.3",
      documentNamespace: "http://spdx.org/spdxdocs/sbom-fixture-1.2.3-<uuid>",
      documentDescribes: [root],
      packages: [
        {
          name: "sbom-fixture",
          SPDXID: root,
          versionInfo: "1.2.3",
          description: "A project with dependencies",
          originator: "Person: Ada (ada@example.com)",
          primaryPackagePurpose: "LIBRARY",
          downloadLocation: "NOASSERTION",
          filesAnalyzed: false,
          homepage: "https://example.com/sbom-fixture",
          licenseDeclared: "Apache-2.0",
          externalRefs: [
            {
              referenceCategory: "PACKAGE-MANAGER",
              referenceType: "purl",
              referenceLocator: "pkg:npm/sbom-fixture@1.2.3",
            },
          ],
        },
        npm("a-dep", "1.0.1", "node_modules/a-dep"),
        npm("no-deps", "1.0.0", "node_modules/no-deps"),
        npm("no-deps", "1.0.1", "node_modules/one-dep/node_modules/no-deps"),
        npm("one-dep", "1.0.0", "node_modules/one-dep"),
        npm("path-parse", "1.0.6", "node_modules/path-parse", {
          description: pathParse.description,
          originator: "Person: Javier Blanco",
          homepage: "https://github.com/jbgutierrez/path-parse#readme",
          licenseDeclared: "MIT",
        }),
        npm("resolve", "1.9.0", "node_modules/resolve", {
          description: resolve.description,
          originator: "Person: James Halliday (mail@substack.net)",
          licenseDeclared: "MIT",
        }),
      ],
      relationships: [
        { spdxElementId: "SPDXRef-DOCUMENT", relatedSpdxElement: root, relationshipType: "DESCRIBES" },
        // A devDependency is described from its own side.
        { spdxElementId: id("a-dep-1.0.1"), relatedSpdxElement: root, relationshipType: "DEV_DEPENDENCY_OF" },
        { spdxElementId: root, relatedSpdxElement: id("no-deps-1.0.0"), relationshipType: "DEPENDS_ON" },
        { spdxElementId: root, relatedSpdxElement: id("one-dep-1.0.0"), relationshipType: "DEPENDS_ON" },
        { spdxElementId: root, relatedSpdxElement: id("resolve-1.9.0"), relationshipType: "DEPENDS_ON" },
        { spdxElementId: id("one-dep-1.0.0"), relatedSpdxElement: id("no-deps-1.0.1"), relationshipType: "DEPENDS_ON" },
        {
          spdxElementId: id("resolve-1.9.0"),
          relatedSpdxElement: id("path-parse-1.0.6"),
          relationshipType: "DEPENDS_ON",
        },
      ],
    });
  });

  test.concurrent("--sbom-type sets what the project is, in both formats", async () => {
    const [application, framework, spdxApplication] = await Promise.all([
      cyclonedx(dir, "--sbom-type", "application"),
      cyclonedx(dir, "--sbom-type=framework", "--sbom-format=cyclonedx"),
      spdx(dir, "--sbom-type", "application"),
    ]);
    expect(application.metadata.component).toEqual({ ...project, type: "application" });
    expect(framework.metadata.component).toEqual({ ...project, type: "framework" });
    // Only the project has a type of its own.
    expect(application.components.map((component: any) => component.type)).toEqual(Array(6).fill("library"));
    expect(spdxApplication.packages.map((pkg: any) => pkg.primaryPackagePurpose)).toEqual([
      "APPLICATION",
      ...Array(6).fill(undefined),
    ]);
  });

  test.concurrent.each([
    [["--sbom-format", "xml"], 'error: --sbom-format must be "cyclonedx" or "spdx", not "xml"\n'],
    [["--sbom-type", "app"], 'error: --sbom-type must be "library", "application" or "framework", not "app"\n'],
    [["resolve"], "error: bun pm sbom does not take arguments\nnote: --production and --omit choose what is listed\n"],
  ])("%j is an error", async (args, message) => {
    expect(await sbom(dir, ...args)).toEqual({ stdout: "", stderr: message, exitCode: 1 });
  });

  test.concurrent("--production and --omit leave out what bun install would leave out", async () => {
    const refs = (doc: any) => doc.components.map((component: any) => component["bom-ref"]);
    const production = ["no-deps@1.0.0", "no-deps@1.0.1", "one-dep@1.0.0", "path-parse@1.0.6", "resolve@1.9.0"];

    const [prod, omitDev] = await Promise.all([cyclonedx(dir, "--production"), cyclonedx(dir, "--omit=dev")]);
    expect(refs(prod)).toEqual(production);
    expect(refs(omitDev)).toEqual(production);
    expect(prod.dependencies[0]).toEqual({
      ref: "sbom-fixture@1.2.3",
      dependsOn: ["no-deps@1.0.0", "one-dep@1.0.0", "resolve@1.9.0"],
    });
  });

  test.concurrent("an optional dependency has the scope optional, and --omit=optional leaves it out", async () => {
    const optionalDir = await setup({
      "package.json": JSON.stringify({
        name: "optional-fixture",
        version: "1.0.0",
        dependencies: { "no-deps": "1.0.0" },
        optionalDependencies: { "one-dep": "1.0.0" },
      }),
    });
    const [all, omitted, asSpdx] = await Promise.all([
      cyclonedx(optionalDir),
      cyclonedx(optionalDir, "--omit=optional"),
      spdx(optionalDir),
    ]);
    // no-deps@1.0.1 is there for one-dep alone, so it is as optional as one-dep.
    expect(scopes(all)).toEqual({
      "no-deps@1.0.0": "required",
      "no-deps@1.0.1": "optional",
      "one-dep@1.0.0": "optional",
    });
    expect(scopes(omitted)).toEqual({ "no-deps@1.0.0": "required" });
    expect(relationships(asSpdx)).toEqual([
      ["SPDXRef-DOCUMENT", "DESCRIBES", "SPDXRef-Package-optional-fixture-1.0.0"],
      ["SPDXRef-Package-optional-fixture-1.0.0", "DEPENDS_ON", "SPDXRef-Package-no-deps-1.0.0"],
      ["SPDXRef-Package-one-dep-1.0.0", "OPTIONAL_DEPENDENCY_OF", "SPDXRef-Package-optional-fixture-1.0.0"],
      ["SPDXRef-Package-one-dep-1.0.0", "DEPENDS_ON", "SPDXRef-Package-no-deps-1.0.1"],
    ]);
  });

  test.concurrent("a package of a devDependency and of an optionalDependency is optional, as in npm sbom", async () => {
    // one-dep depends on no-deps@1.0.1, which the project has as an optionalDependency too.
    const overlapDir = await setup({
      "package.json": JSON.stringify({
        name: "overlap-fixture",
        version: "1.0.0",
        devDependencies: { "one-dep": "1.0.0" },
        optionalDependencies: { "no-deps": "1.0.1" },
      }),
    });

    const [all, production, withoutOptional] = await Promise.all([
      cyclonedx(overlapDir),
      cyclonedx(overlapDir, "--production"),
      cyclonedx(overlapDir, "--omit=optional"),
    ]);
    expect(scopes(all)).toEqual({
      "no-deps@1.0.1": "optional",
      "one-dep@1.0.0": "required, for development",
    });
    expect(scopes(production)).toEqual({ "no-deps@1.0.1": "optional" });
    // Without the optionalDependency, no-deps is there for one-dep alone.
    expect(scopes(withoutOptional)).toEqual({
      "no-deps@1.0.1": "required, for development",
      "one-dep@1.0.0": "required, for development",
    });
  });

  test.concurrent("a peer dependency is a prerequisite, and an optional peer is optional", async () => {
    // `ui` has no-deps as a peer and as a devDependency. Its optional peer a-dep is an optionalDependency of the root.
    const peersDir = await setup({
      "package.json": JSON.stringify({
        name: "peers-fixture",
        private: true,
        workspaces: ["packages/*"],
        optionalDependencies: { "a-dep": "1.0.1" },
      }),
      "packages/ui/package.json": JSON.stringify({
        name: "ui",
        version: "1.0.0",
        peerDependencies: { "no-deps": "1.0.0", "a-dep": "1.0.1" },
        peerDependenciesMeta: { "a-dep": { optional: true } },
        devDependencies: { "no-deps": "1.0.0" },
      }),
    });
    const [root, ui, aDep, noDeps] = ["peers-fixture", "ui-workspace-packages-ui", "a-dep-1.0.1", "no-deps-1.0.0"].map(
      name => `SPDXRef-Package-${name}`,
    );

    const [doc, asSpdx] = await Promise.all([cyclonedx(peersDir), spdx(peersDir)]);
    expect(scopes(doc)).toEqual({
      "a-dep@1.0.1": "optional",
      "no-deps@1.0.0": "required",
      "ui@workspace:packages/ui": "required",
    });
    // One relationship for the two dependencies of `ui` on no-deps: the peer one, which a user of `ui` has too.
    expect(relationships(asSpdx)).toEqual([
      ["SPDXRef-DOCUMENT", "DESCRIBES", root],
      [aDep, "OPTIONAL_DEPENDENCY_OF", root],
      [root, "DEPENDS_ON", ui],
      [aDep, "OPTIONAL_DEPENDENCY_OF", ui],
      [ui, "HAS_PREREQUISITE", noDeps],
    ]);
  });

  test.concurrent("lists a package once, where the isolated linker has put it", async () => {
    const doc = await cyclonedx(isolatedDir);
    const store = (entry: string, name: string) => [
      { name: "cdx:npm:package:path", value: `node_modules/.bun/${entry}/node_modules/${name}` },
    ];
    expect(doc.components).toEqual([
      library("a-dep", "1.0.1", { properties: [...store("a-dep@1.0.1", "a-dep"), development] }),
      library("no-deps", "1.0.0", { properties: store("no-deps@1.0.0", "no-deps") }),
      library("no-deps", "1.0.1", { properties: store("no-deps@1.0.1", "no-deps") }),
      library("one-dep", "1.0.0", { properties: store("one-dep@1.0.0", "one-dep") }),
      library("path-parse", "1.0.6", { ...pathParse, properties: store("path-parse@1.0.6", "path-parse") }),
      library("resolve", "1.9.0", { ...resolve, properties: store("resolve@1.9.0", "resolve") }),
    ]);
  });

  test.concurrent("lists the workspaces, and gives the private ones no package URL", async () => {
    const doc = await cyclonedx(monoDir);
    expect(doc.metadata.component).toEqual({
      "bom-ref": "mono",
      type: "library",
      name: "mono",
      scope: "required",
      properties: [
        { name: "cdx:npm:package:path", value: "" },
        { name: "cdx:npm:package:private", value: "true" },
      ],
    });
    expect(doc.components).toEqual([
      {
        "bom-ref": "@mono/bar@workspace:packages/bar",
        type: "library",
        group: "@mono",
        name: "bar",
        version: "2.0.0",
        scope: "required",
        properties: [
          { name: "cdx:npm:package:path", value: "packages/bar" },
          { name: "cdx:npm:package:private", value: "true" },
        ],
      },
      {
        "bom-ref": "@mono/foo@workspace:packages/foo",
        type: "library",
        group: "@mono",
        name: "foo",
        version: "1.0.0",
        scope: "required",
        licenses: [{ license: { id: "MIT" } }],
        purl: "pkg:npm/%40mono/foo@1.0.0",
        properties: [{ name: "cdx:npm:package:path", value: "packages/foo" }],
      },
      {
        ...library("no-deps", "1.0.0"),
        "bom-ref": "@scoped/no-deps@1.0.0",
        group: "@scoped",
        purl: "pkg:npm/%40scoped/no-deps@1.0.0",
        externalReferences: [{ type: "distribution", url: "<registry>/@scoped/no-deps/-/no-deps-1.0.0.tgz" }],
        properties: [{ name: "cdx:npm:package:path", value: "node_modules/@scoped/no-deps" }],
      },
      library("no-deps", "1.0.0"),
    ]);
    expect(doc.dependencies).toEqual([
      { ref: "mono", dependsOn: ["@mono/bar@workspace:packages/bar", "@mono/foo@workspace:packages/foo"] },
      { ref: "@mono/bar@workspace:packages/bar", dependsOn: ["@scoped/no-deps@1.0.0"] },
      { ref: "@mono/foo@workspace:packages/foo", dependsOn: ["@mono/bar@workspace:packages/bar", "no-deps@1.0.0"] },
      { ref: "@scoped/no-deps@1.0.0", dependsOn: [] },
      { ref: "no-deps@1.0.0", dependsOn: [] },
    ]);
  });

  test.concurrent("in a workspace, describes that workspace and what it depends on", async () => {
    const { stdout, stderr, exitCode } = await sbom(join(monoDir, "packages", "bar"));
    expect(stderr).toBe("");
    const doc = stableCyclonedx(monoDir, stdout);
    expect(doc.metadata.component["bom-ref"]).toBe("@mono/bar@workspace:packages/bar");
    expect(doc.dependencies).toEqual([
      { ref: "@mono/bar@workspace:packages/bar", dependsOn: ["@scoped/no-deps@1.0.0"] },
      { ref: "@scoped/no-deps@1.0.0", dependsOn: [] },
    ]);
    expect(exitCode).toBe(0);
  });

  test.concurrent("in a workspace that the lockfile does not have, says so", async () => {
    const newDir = await setup(monorepo, "hoisted", "--lockfile-only");
    mkdirSync(join(newDir, "packages", "new"));
    writeFileSync(join(newDir, "packages", "new", "package.json"), JSON.stringify({ name: "@mono/new" }));
    expect(await sbom(join(newDir, "packages", "new"))).toEqual({
      stdout: "",
      stderr: "error: the package.json of this directory is not in the lockfile\nnote: run 'bun install' first\n",
      exitCode: 1,
    });
  });

  test.concurrent("bun pm --help lists sbom and its flags", async () => {
    await using proc = spawn({
      cmd: [bunExe(), "pm", "--help"],
      env: bunEnv,
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    const block = stdout.slice(stdout.indexOf("bun pm sbom"), stdout.indexOf("bun pm licenses"));
    for (const flag of ["--sbom-format", "--sbom-type", "--prod"]) expect(block).toContain(flag);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });

  test.concurrent("a license is an SPDX identifier, an SPDX expression or a name", async () => {
    const cases: [license: Record<string, unknown>, cyclonedx: object | undefined, spdx: string, comment?: string][] = [
      // The list of SPDX has no regard for case. The document has the spelling of the list.
      [{ license: "mit" }, { license: { id: "MIT" } }, "MIT"],
      [{ license: "(ISC)" }, { license: { id: "ISC" } }, "ISC"],
      [{ license: "GPL-2.0+" }, { license: { id: "GPL-2.0+" } }, "GPL-2.0+"],
      [{ license: { type: "bsd-3-clause" } }, { license: { id: "BSD-3-Clause" } }, "BSD-3-Clause"],
      [{ license: "(MIT OR Apache-2.0)" }, { expression: "(MIT OR Apache-2.0)" }, "(MIT OR Apache-2.0)"],
      [{ license: "mit  AND (isc OR 0bsd)" }, { expression: "MIT AND (ISC OR 0BSD)" }, "MIT AND (ISC OR 0BSD)"],
      [{ license: "MIT+" }, { expression: "MIT+" }, "MIT+"],
      [
        { license: "GPL-2.0-only WITH classpath-exception-2.0" },
        { expression: "GPL-2.0-only WITH Classpath-exception-2.0" },
        "GPL-2.0-only WITH Classpath-exception-2.0",
      ],
      // The `licenses` array that package.json had before it had `license`.
      [{ licenses: [{ type: "MIT" }, { type: "ISC" }] }, { expression: "(MIT OR ISC)" }, "(MIT OR ISC)"],
      // SPDX would have to define the license that a `LicenseRef-` names.
      [
        { license: "MIT OR LicenseRef-acme-1.0" },
        { expression: "MIT OR LicenseRef-acme-1.0" },
        "NOASSERTION",
        "MIT OR LicenseRef-acme-1.0",
      ],
      // More parentheses than any license has. The parser stops there.
      ...[
        "SEE LICENSE IN LICENSE.txt",
        "UNLICENSED",
        "Apache 2.0",
        "MIT OR",
        "MIT WITH ISC",
        "(MIT",
        "MIT or ISC",
        `${Buffer.alloc(40, "(")}MIT${Buffer.alloc(40, ")")}`,
      ].map((text): [Record<string, unknown>, object, string, string] => [
        { license: text },
        { license: { name: text } },
        "NOASSERTION",
        text,
      ]),
      [{}, undefined, "NOASSERTION"],
    ];
    const licensesDir = await setupWithManifests(cases.map(([manifest]) => manifest));

    const [{ components }, { packages }] = await Promise.all([cyclonedx(licensesDir), spdx(licensesDir)]);
    expect(
      cases.map(([manifest], i) => [
        manifest,
        components[i].licenses?.[0],
        packages[i + 1].licenseDeclared,
        packages[i + 1].licenseComments,
      ]),
    ).toEqual(cases.map(([manifest, cdx, declared, comment]) => [manifest, cdx, declared, comment]));
  });

  test.concurrent("takes a repository and an author in the forms that a package.json has them in", async () => {
    const description = 'a "quoted"\n\tline \u0001 \u2028 é 🍜';
    const cases: [manifest: Record<string, unknown>, component: Record<string, unknown>][] = [
      [{ repository: "owner/repo" }, { vcs: "https://github.com/owner/repo" }],
      [{ repository: "github:owner/repo" }, { vcs: "https://github.com/owner/repo" }],
      [{ repository: "gitlab:owner/repo" }, { vcs: "https://gitlab.com/owner/repo" }],
      [{ repository: "bitbucket:owner/repo" }, { vcs: "https://bitbucket.org/owner/repo" }],
      // The https form, which is the one that bun clones such a dependency from first.
      [{ repository: { url: "git@github.com:owner/repo.git" } }, { vcs: "https://github.com/owner/repo.git" }],
      [{ repository: "git.example.com:owner/repo" }, { vcs: "https://git.example.com/owner/repo" }],
      [{ repository: { url: "git+https://example.com/repo.git" } }, { vcs: "git+https://example.com/repo.git" }],
      [{ repository: "https://user:secret@example.com/repo.git" }, { vcs: "https://example.com/repo.git" }],
      // Not a place that a reader of the document could go to.
      [{ repository: "owner/repo/with/more" }, {}],
      [{ repository: "has a space" }, {}],
      [{ repository: "gist:11081aaa281" }, {}],
      [{ repository: "ssh://git@github.com:owner/repo.git" }, {}],
      [{ homepage: "https://example.com/50%", bugs: "https://example.com/[bugs]" }, {}],
      [{ homepage: "not a url", bugs: "https://example.com/bugs" }, { "issue-tracker": "https://example.com/bugs" }],
      [
        { homepage: "https://example.com/", bugs: { url: "https://example.com/issues", email: "bugs@example.com" } },
        { "website": "https://example.com/", "issue-tracker": "https://example.com/issues" },
      ],
      [
        { author: "Ada Lovelace <ada@example.com> (https://example.com)" },
        { authors: [{ name: "Ada Lovelace", email: "ada@example.com" }] },
      ],
      [{ author: { name: "Ada", url: "https://example.com" } }, { authors: [{ name: "Ada" }] }],
      [{ author: "<ada@example.com>" }, { authors: [{ email: "ada@example.com" }] }],
      [{ author: "<https://example.com>" }, {}],
      [{ author: "Ada <ada@example.com@example.org>" }, { authors: [{ name: "Ada" }] }],
      // JSON has to escape these.
      [{ description }, { description }],
    ];
    const formsDir = await setupWithManifests(cases.map(([manifest]) => manifest));

    const { components } = await cyclonedx(formsDir);
    expect(
      components.map(({ authors, description, externalReferences = [] }: any) => ({
        ...Object.fromEntries(externalReferences.map((reference: any) => [reference.type, reference.url])),
        ...(authors && { authors }),
        ...(description && { description }),
      })),
    ).toEqual(cases.map(([, component]) => component));
  });

  test.concurrent("describes a git dependency and a tarball by where they come from", async () => {
    using repo = await gitRepo({ name: "git-pkg", version: "3.0.0", license: "ISC" });
    const tarball = `${registry.registryUrl()}no-deps/-/no-deps-1.0.1.tgz`;
    const sourcesDir = await setup({
      "package.json": JSON.stringify({
        name: "sources-fixture",
        version: "1.0.0",
        dependencies: { "git-pkg": repo.url, "no-deps": tarball },
      }),
    });
    // A package URL keeps `:` and `/` of a URL in a qualifier and escapes the rest.
    const qualifier = (url: string) => encodeURIComponent(url).replaceAll("%3A", ":").replaceAll("%2F", "/");

    const { components } = await cyclonedx(sourcesDir);
    expect(components).toEqual([
      {
        "bom-ref": `git-pkg@${repo.url}#${repo.commit}`,
        type: "library",
        name: "git-pkg",
        version: "3.0.0",
        scope: "required",
        licenses: [{ license: { id: "ISC" } }],
        purl: `pkg:npm/git-pkg@3.0.0?vcs_url=${qualifier(`${repo.url}@${repo.commit}`)}`,
        externalReferences: [{ type: "vcs", url: repo.url.slice("git+".length) }],
        properties: [{ name: "cdx:npm:package:path", value: "node_modules/git-pkg" }],
      },
      {
        "bom-ref": `no-deps@${tarball}`,
        type: "library",
        name: "no-deps",
        version: "1.0.1",
        scope: "required",
        purl: "pkg:npm/no-deps@1.0.1?download_url=<registry>/no-deps/-/no-deps-1.0.1.tgz",
        hashes: DIGEST,
        externalReferences: [{ type: "distribution", url: "<registry>/no-deps/-/no-deps-1.0.1.tgz" }],
        properties: [{ name: "cdx:npm:package:path", value: "node_modules/no-deps" }],
      },
    ]);

    const { packages } = await spdx(sourcesDir);
    expect(packages.map((pkg: any) => pkg.downloadLocation)).toEqual([
      "NOASSERTION",
      `${repo.url}@${repo.commit}`,
      "<registry>/no-deps/-/no-deps-1.0.1.tgz",
    ]);
  });

  test.concurrent(
    "reads git and tarball dependencies from bun.lock, without the credentials of their URLs",
    async () => {
      const commit = "0123456789abcdef0123456789abcdef01234567";
      const integrity = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;
      const dependencies = {
        "gh-pkg": "github:owner/gh-pkg#v1",
        "scp-pkg": "git@git.example.com:owner/scp-pkg.git",
        "tar-pkg": "https://user:secret@example.com/tar-pkg-1.0.0.tgz",
        "token-pkg": "git+https://secret-token@example.com/owner/token-pkg.git",
      };
      using lockDir = tempDir("sbom-lock-only", {
        "package.json": JSON.stringify({ name: "lock-fixture", version: "1.0.0", dependencies }),
        "bun.lock": JSON.stringify({
          lockfileVersion: 1,
          workspaces: { "": { name: "lock-fixture", dependencies } },
          packages: {
            "gh-pkg": ["gh-pkg@github:owner/gh-pkg#abc1234", {}, "owner-gh-pkg-abc1234", integrity],
            "scp-pkg": [`scp-pkg@git+ssh://git@git.example.com:owner/scp-pkg.git#${commit}`, {}, commit],
            "tar-pkg": ["tar-pkg@https://user:secret@example.com/tar-pkg-1.0.0.tgz", {}, integrity],
            "token-pkg": [`token-pkg@git+https://secret-token@example.com/owner/token-pkg.git#${commit}`, {}, commit],
          },
        }),
      });
      const notInstalled =
        "warn: 4 packages in the lockfile are not installed, so the document has no license, author or description for them\n" +
        "note: run 'bun install' first\n";
      const hashes = [{ alg: "SHA-512", content: Buffer.alloc(64, 7).toString("hex") }];

      const [asCyclonedx, asSpdx] = await Promise.all([
        sbom(String(lockDir)),
        sbom(String(lockDir), "--sbom-format", "spdx"),
      ]);
      expect(asCyclonedx.stderr).toBe(notInstalled);
      expect(asCyclonedx.stdout + asSpdx.stdout).not.toContain("secret");
      expect(JSON.parse(asCyclonedx.stdout).components).toEqual([
        {
          "bom-ref": "gh-pkg@github:owner/gh-pkg#abc1234",
          type: "library",
          name: "gh-pkg",
          scope: "required",
          purl: "pkg:npm/gh-pkg?vcs_url=git%2Bhttps://github.com/owner/gh-pkg.git%40abc1234",
          hashes,
          externalReferences: [{ type: "vcs", url: "https://github.com/owner/gh-pkg" }],
        },
        {
          "bom-ref": `scp-pkg@git+ssh://git.example.com:owner/scp-pkg.git#${commit}`,
          type: "library",
          name: "scp-pkg",
          scope: "required",
          purl: `pkg:npm/scp-pkg?vcs_url=git%2Bhttps://git.example.com/owner/scp-pkg.git%40${commit}`,
          externalReferences: [{ type: "vcs", url: "https://git.example.com/owner/scp-pkg.git" }],
        },
        {
          "bom-ref": "tar-pkg@https://example.com/tar-pkg-1.0.0.tgz",
          type: "library",
          name: "tar-pkg",
          scope: "required",
          purl: "pkg:npm/tar-pkg?download_url=https://example.com/tar-pkg-1.0.0.tgz",
          hashes,
          externalReferences: [{ type: "distribution", url: "https://example.com/tar-pkg-1.0.0.tgz" }],
        },
        {
          "bom-ref": `token-pkg@git+https://example.com/owner/token-pkg.git#${commit}`,
          type: "library",
          name: "token-pkg",
          scope: "required",
          purl: `pkg:npm/token-pkg?vcs_url=git%2Bhttps://example.com/owner/token-pkg.git%40${commit}`,
          externalReferences: [{ type: "vcs", url: "https://example.com/owner/token-pkg.git" }],
        },
      ]);
      expect(asCyclonedx.exitCode).toBe(0);

      expect(asSpdx.stderr).toBe(notInstalled);
      // The hash of a GitHub dependency is of a tarball that its git location does not give, so SPDX has none.
      expect(
        JSON.parse(asSpdx.stdout).packages.map((pkg: any) => [pkg.name, pkg.downloadLocation, pkg.checksums?.length]),
      ).toEqual([
        ["lock-fixture", "NOASSERTION", undefined],
        ["gh-pkg", "git+https://github.com/owner/gh-pkg.git@abc1234", undefined],
        ["scp-pkg", `git+https://git.example.com/owner/scp-pkg.git@${commit}`, undefined],
        ["tar-pkg", "https://example.com/tar-pkg-1.0.0.tgz", 1],
        ["token-pkg", `git+https://example.com/owner/token-pkg.git@${commit}`, undefined],
      ]);
      expect(asSpdx.exitCode).toBe(0);
    },
  );

  test.concurrent("reads the lockfile of pnpm when there is no bun.lock, and does not write one", async () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const locked = `git+ssh://git@example.com/org/pkg-a.git#${commit}`;
    using pnpmDir = tempDir("sbom-pnpm", {
      "package.json": JSON.stringify({
        name: "pnpm-fixture",
        version: "1.0.0",
        dependencies: { "pkg-a": "git+ssh://git@example.com/org/pkg-a.git#v1" },
      }),
      "pnpm-lock.yaml": [
        "lockfileVersion: '9.0'",
        "",
        "importers:",
        "",
        "  .:",
        "    dependencies:",
        "      pkg-a:",
        "        specifier: git+ssh://git@example.com/org/pkg-a.git#v1",
        `        version: ${locked}`,
        "",
        "packages:",
        "",
        `  pkg-a@${locked}:`,
        `    resolution: {commit: ${commit}, repo: ssh://git@example.com/org/pkg-a.git, type: git}`,
        "    version: 1.0.0",
        "",
        "snapshots:",
        "",
        `  pkg-a@${locked}: {}`,
        "",
      ].join("\n"),
    });

    const { stdout, stderr, exitCode } = await sbom(String(pnpmDir));
    expect(stderr.replace(/^\[[\d.]+m?s\]/, "[time]")).toBe(
      "[time] migrated lockfile from pnpm-lock.yaml\n" +
        "warn: 1 package in the lockfile is not installed, so the document has no license, author or description for it\n" +
        "note: run 'bun install' first\n",
    );
    // The commit is the one of pnpm-lock.yaml, which has no other record of it.
    expect(JSON.parse(stdout).components).toEqual([
      {
        "bom-ref": `pkg-a@git+ssh://example.com/org/pkg-a.git#${commit}`,
        type: "library",
        name: "pkg-a",
        scope: "required",
        purl: `pkg:npm/pkg-a?vcs_url=git%2Bhttps://example.com/org/pkg-a.git%40${commit}`,
        externalReferences: [{ type: "vcs", url: "https://example.com/org/pkg-a.git" }],
      },
    ]);
    expect(exitCode).toBe(0);
    expect(readdirSync(String(pnpmDir)).sort()).toEqual(["package.json", "pnpm-lock.yaml"]);
  });

  test.concurrent("gives two packages whose names differ by one character SPDX identifiers of their own", async () => {
    // An SPDX identifier has letters, digits, `.` and `-`, so both of these come out as `u-v-d-1`.
    const collisionDir = await setup({
      "package.json": JSON.stringify({
        name: "collision-fixture",
        version: "1.0.0",
        dependencies: { "u_v": "file:./d/1", "u-v": "file:./d_1" },
      }),
      "d/1/package.json": JSON.stringify({ name: "u_v", version: "1.0.0" }),
      "d_1/package.json": JSON.stringify({ name: "u-v", version: "1.0.0" }),
    });
    const { packages, relationships } = await spdx(collisionDir);
    expect(packages.map((pkg: any) => [pkg.name, pkg.SPDXID])).toEqual([
      ["collision-fixture", "SPDXRef-Package-collision-fixture-1.0.0"],
      ["u-v", "SPDXRef-Package-u-v-d-1"],
      ["u_v", "SPDXRef-Package-u-v-d-1-2"],
    ]);
    expect(relationships.map((r: any) => r.relatedSpdxElement)).toEqual([
      "SPDXRef-Package-collision-fixture-1.0.0",
      "SPDXRef-Package-u-v-d-1",
      "SPDXRef-Package-u-v-d-1-2",
    ]);
  });

  test.concurrent("needs bun.lock, and node_modules only for what a package.json says", async () => {
    const lockOnlyDir = await setup(fixture, "hoisted", "--lockfile-only");
    const { stdout, stderr, exitCode } = await sbom(lockOnlyDir);
    expect(stderr).toBe(
      "warn: 6 packages in the lockfile are not installed, so the document has no license, author or description for them\n" +
        "note: run 'bun install' first\n",
    );
    expect(exitCode).toBe(0);
    const doc = stableCyclonedx(lockOnlyDir, stdout);
    // Made before a build. What the lockfile has is all there.
    expect(doc.metadata.lifecycles).toEqual([{ phase: "pre-build" }]);
    const fromLockfile = ["bom-ref", "type", "name", "version", "scope", "purl", "hashes", "externalReferences"];
    expect(doc.components.map((component: any) => Object.keys(component))).toEqual([
      // That a-dep is a devDependency is in the lockfile too.
      [...fromLockfile, "properties"],
      ...Array(5).fill(fromLockfile),
    ]);
    expect(doc.dependencies).toHaveLength(7);

    rmSync(join(lockOnlyDir, "bun.lock"));
    expect(await sbom(lockOnlyDir)).toEqual({
      stdout: "",
      stderr: "error: missing lockfile, nothing to list\nnote: run 'bun install' first\n",
      exitCode: 1,
    });
  });
});
