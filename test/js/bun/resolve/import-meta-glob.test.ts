// import.meta.glob(), Vite's glob import: https://vite.dev/guide/features.html#glob-import
// The bundler side is covered in test/bundler/bundler_import_meta_glob.test.ts.

import { describe, expect, test } from "bun:test";
import { writeFileSync } from "fs";
import { bunEnv, bunExe, tempDir } from "harness";
import path from "path";

async function spawn(cwd: string, args: string[], env: Record<string, string | undefined> = bunEnv) {
  await using proc = Bun.spawn({
    cmd: [bunExe(), ...args],
    env,
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

// Runs `entry` in a directory holding `files` and parses the JSON it prints.
async function run(files: Record<string, string>, entry = "main.js") {
  using dir = tempDir("import-meta-glob", files);
  const { stdout, stderr, exitCode } = await spawn(String(dir), [entry]);
  expect(stderr).toBe("");
  const result = JSON.parse(stdout);
  expect(exitCode).toBe(0);
  return result;
}

async function fails(source: string) {
  using dir = tempDir("import-meta-glob", { "main.js": source, "dir/a.js": "export default 1;" });
  const { stdout, stderr, exitCode } = await spawn(String(dir), ["main.js"]);
  expect(stdout).toBe("");
  expect(exitCode).toBe(1);
  return stderr;
}

const modules = {
  "modules/a.js": `export const name = "a"; export default "A";`,
  "modules/b.js": `export const name = "b"; export default "B";`,
  "modules/c.ts": `export const name: string = "c"; export default "C";`,
};

describe.concurrent("import.meta.glob", () => {
  test("maps each match to a function that imports it", async () => {
    expect(
      await run({
        ...modules,
        "main.js": `
          const found = import.meta.glob("./modules/*.js");
          const a = await found["./modules/a.js"]();
          console.log(JSON.stringify({
            keys: Object.keys(found),
            types: Object.values(found).map(load => typeof load),
            a: { ...a },
            sameModule: a === (await import("./modules/a.js")),
          }));
        `,
      }),
    ).toEqual({
      keys: ["./modules/a.js", "./modules/b.js"],
      types: ["function", "function"],
      a: { name: "a", default: "A" },
      sameModule: true,
    });
  });

  test("nothing is imported until a loader is called", async () => {
    expect(
      await run({
        "main.js": `
          globalThis.order = [];
          const found = import.meta.glob("./side-effects/*.js");
          order.push("globbed");
          await found["./side-effects/b.js"]();
          console.log(JSON.stringify(order));
        `,
        "side-effects/a.js": `order.push("a");`,
        "side-effects/b.js": `order.push("b");`,
      }),
    ).toEqual(["globbed", "b"]);
  });

  test("eager: true imports the modules up front", async () => {
    expect(
      await run({
        ...modules,
        "main.js": `
          import * as a from "./modules/a.js";
          const found = import.meta.glob("./modules/*", { eager: true });
          console.log(JSON.stringify({ found, sameModule: found["./modules/a.js"] === a }));
        `,
      }),
    ).toEqual({
      found: {
        "./modules/a.js": { name: "a", default: "A" },
        "./modules/b.js": { name: "b", default: "B" },
        "./modules/c.ts": { name: "c", default: "C" },
      },
      sameModule: true,
    });
  });

  test("eager imports are hoisted like import statements", async () => {
    expect(
      await run({
        "main.js": `
          globalThis.order ??= [];
          order.push("main");
          function later() {
            return import.meta.glob("./side-effects/*.js", { eager: true, import: "default" });
          }
          console.log(JSON.stringify({ order, later: later() }));
        `,
        "side-effects/a.js": `(globalThis.order ??= []).push("a"); export default 1;`,
        "side-effects/b.js": `(globalThis.order ??= []).push("b"); export default 2;`,
      }),
    ).toEqual({
      order: ["a", "b", "main"],
      later: { "./side-effects/a.js": 1, "./side-effects/b.js": 2 },
    });
  });

  test("import picks one export", async () => {
    expect(
      await run({
        ...modules,
        "main.js": `
          const lazyDefault = import.meta.glob("./modules/*.js", { import: "default" });
          const lazyNamed = import.meta.glob("./modules/*.js", { import: "name" });
          const star = import.meta.glob("./modules/a.js", { import: "*" });
          console.log(JSON.stringify({
            lazyDefault: await lazyDefault["./modules/b.js"](),
            lazyNamed: await lazyNamed["./modules/b.js"](),
            star: { ...(await star["./modules/a.js"]()) },
            eagerDefault: import.meta.glob("./modules/*.js", { import: "default", eager: true }),
            eagerNamed: import.meta.glob("./modules/*.js", { import: "name", eager: true }),
          }));
        `,
      }),
    ).toEqual({
      lazyDefault: "B",
      lazyNamed: "b",
      star: { name: "a", default: "A" },
      eagerDefault: { "./modules/a.js": "A", "./modules/b.js": "B" },
      eagerNamed: { "./modules/a.js": "a", "./modules/b.js": "b" },
    });
  });

  test("arrays of patterns, negation, ** and braces", async () => {
    expect(
      await run({
        "main.js": `
          console.log(JSON.stringify({
            recursive: Object.keys(import.meta.glob("./src/**/*.js")),
            several: Object.keys(import.meta.glob(["./lib/*.js", "./config/*.js", "./lib/helper.js"])),
            negated: Object.keys(import.meta.glob(["./src/**/*.js", "!**/button.js", "!./src/lib/**"])),
            braces: Object.keys(import.meta.glob("./{lib,config}/*.{js,json}")),
            classes: Object.keys(import.meta.glob("./src/**/[a-m]*.js")),
            parent: Object.keys(import.meta.glob("./src/lib/../*.js")),
            none: Object.keys(import.meta.glob("./nope/**/*.js")),
          }));
        `,
        "src/main.js": "",
        "src/lib/util.js": "",
        "src/components/button.js": "",
        "src/components/input.js": "",
        "lib/helper.js": "",
        "config/app.js": "",
        "config/settings.json": "{}",
      }),
    ).toEqual({
      recursive: ["./src/components/button.js", "./src/components/input.js", "./src/lib/util.js", "./src/main.js"],
      several: ["./config/app.js", "./lib/helper.js"],
      negated: ["./src/components/input.js", "./src/main.js"],
      braces: ["./config/app.js", "./config/settings.json", "./lib/helper.js"],
      classes: ["./src/components/button.js", "./src/components/input.js", "./src/main.js"],
      parent: ["./src/main.js"],
      none: [],
    });
  });

  test("the importing file is not a match", async () => {
    expect(
      await run({
        "main.js": `console.log(JSON.stringify(Object.keys(import.meta.glob("./*.js"))));`,
        "other.js": "",
      }),
    ).toEqual(["./other.js"]);
  });

  test("dotfiles and node_modules are skipped unless exhaustive", async () => {
    expect(
      await run({
        "main.js": `
          console.log(JSON.stringify({
            normal: Object.keys(import.meta.glob("./**/*.txt")),
            exhaustive: Object.keys(import.meta.glob("./**/*.txt", { exhaustive: true })),
            spelledOut: Object.keys(import.meta.glob("./.config/*.txt")),
          }));
        `,
        "a.txt": "",
        ".hidden.txt": "",
        ".config/b.txt": "",
        "node_modules/pkg/c.txt": "",
        "sub/node_modules/pkg/d.txt": "",
      }),
    ).toEqual({
      normal: ["./a.txt"],
      exhaustive: [
        "./.config/b.txt",
        "./.hidden.txt",
        "./a.txt",
        "./node_modules/pkg/c.txt",
        "./sub/node_modules/pkg/d.txt",
      ],
      spelledOut: ["./.config/b.txt"],
    });
  });

  test("keys are relative to the importing file, which may be in a subdirectory", async () => {
    expect(
      await run(
        {
          "src/app/main.js": `
            const up = import.meta.glob("../shared/*.js", { import: "default" });
            const deep = import.meta.glob("./views/**/*.js", { import: "default", eager: true });
            console.log(JSON.stringify({ up: await up["../shared/x.js"](), keys: Object.keys(up), deep }));
          `,
          "src/shared/x.js": `export default "x";`,
          "src/app/views/a/b/c.js": `export default "c";`,
        },
        "src/app/main.js",
      ),
    ).toEqual({ up: "x", keys: ["../shared/x.js"], deep: { "./views/a/b/c.js": "c" } });
  });

  test("patterns that start with / or ** are matched from the project root", async () => {
    expect(
      await run(
        {
          "src/app/main.js": `
            const rooted = import.meta.glob("/src/lib/*.js", { import: "default" });
            const anywhere = import.meta.glob("**/*.txt", { with: { type: "text" }, import: "default", eager: true });
            const mixed = import.meta.glob(["./*.js", "/src/lib/*.js"]);
            console.log(JSON.stringify({
              rooted: Object.keys(rooted),
              a: await rooted["/src/lib/a.js"](),
              anywhere,
              mixed: Object.keys(mixed),
            }));
          `,
          "src/app/sibling.js": "",
          "src/lib/a.js": `export default "a";`,
          "assets/hello.txt": "hello",
          "node_modules/pkg/readme.txt": "skipped",
        },
        "src/app/main.js",
      ),
    ).toEqual({
      rooted: ["/src/lib/a.js"],
      a: "a",
      anywhere: { "/assets/hello.txt": "hello" },
      mixed: ["/src/app/sibling.js", "/src/lib/a.js"],
    });
  });

  test("base moves where relative patterns match and what the keys are relative to", async () => {
    expect(
      await run(
        {
          "src/main.js": `
            const relative = import.meta.glob("./**/*.js", { base: "./pages", import: "default" });
            const upward = import.meta.glob("./*.js", { base: "../shared", import: "default", eager: true });
            const rooted = import.meta.glob("./*.txt", { base: "/assets", with: { type: "text" }, import: "default", eager: true });
            const negated = import.meta.glob(["./**/*.js", "!./nested/**"], { base: "./pages/" });
            console.log(JSON.stringify({
              relative: Object.keys(relative),
              home: await relative["./home.js"](),
              upward,
              rooted,
              negated: Object.keys(negated),
            }));
          `,
          "src/pages/home.js": `export default "home";`,
          "src/pages/nested/deep.js": `export default "deep";`,
          "src/home.js": `export default "wrong";`,
          "shared/s.js": `export default "s";`,
          "assets/t.txt": "t",
        },
        "src/main.js",
      ),
    ).toEqual({
      relative: ["./home.js", "./nested/deep.js"],
      home: "home",
      upward: { "./s.js": "s" },
      rooted: { "./t.txt": "t" },
      negated: ["./home.js"],
    });
  });

  test("with passes import attributes to every import", async () => {
    expect(
      await run({
        "main.js": `
          const lazy = import.meta.glob("./data/*", { with: { type: "text" } });
          const eager = import.meta.glob("./data/*", { with: { type: "text" }, eager: true, import: "default" });
          const json = import.meta.glob("./data/*.json", { eager: true, import: "default" });
          console.log(JSON.stringify({ lazy: (await lazy["./data/a.js"]()).default, eager, json }));
        `,
        "data/a.js": `throw new Error("not evaluated");`,
        "data/b.json": `{"b":1}`,
      }),
    ).toEqual({
      lazy: `throw new Error("not evaluated");`,
      eager: { "./data/a.js": `throw new Error("not evaluated");`, "./data/b.json": `{"b":1}` },
      json: { "./data/b.json": { b: 1 } },
    });
  });

  test("query is appended to every specifier", async () => {
    expect(
      await run({
        "main.js": `
          const string = import.meta.glob("./lib/*.js", { query: "?v=1", import: "search" });
          const bare = import.meta.glob("./lib/*.js", { query: "v=2", import: "search", eager: true });
          const object = import.meta.glob("./lib/*.js", { query: { a: "b", n: 1, t: true }, import: "search", eager: true });
          // The runtime loads a "?raw" specifier as text, so Vite's idiom for that carries over.
          const raw = import.meta.glob("./lib/*.js", { query: "?raw", import: "default", eager: true });
          console.log(JSON.stringify({ keys: Object.keys(string), string: await string["./lib/x.js"](), bare, object, raw }));
        `,
        "lib/x.js": `export const search = new URL(import.meta.url).search;`,
      }),
    ).toEqual({
      keys: ["./lib/x.js"],
      string: "?v=1",
      bare: { "./lib/x.js": "?v=2" },
      object: { "./lib/x.js": "?a=b&n=1&t=true" },
      raw: { "./lib/x.js": "export const search = new URL(import.meta.url).search;" },
    });
  });

  test("works in TypeScript, where unused imports are dropped", async () => {
    expect(
      await run(
        {
          ...modules,
          "main.ts": `
            type Mod = { name: string; default: string };
            const lazy = import.meta.glob<Mod>("./modules/*.ts") as Record<string, () => Promise<Mod>>;
            const eager = import.meta.glob<true, Mod>("./modules/*.ts", { eager: true });
            const names = import.meta.glob<string>("./modules/*", { eager: true, import: "name" })!;
            console.log(JSON.stringify({ lazy: (await lazy["./modules/c.ts"]()).name, eager, names }));
          `,
        },
        "main.ts",
      ),
    ).toEqual({
      lazy: "c",
      eager: { "./modules/c.ts": { name: "c", default: "C" } },
      names: { "./modules/a.js": "a", "./modules/b.js": "b", "./modules/c.ts": "c" },
    });
  });

  test("patterns may be written as constant expressions", async () => {
    expect(
      await run({
        ...modules,
        "main.js": `
          const dir = "modules";
          console.log(JSON.stringify({
            template: Object.keys(import.meta.glob(\`./modules/a.js\`)),
            folded: Object.keys(import.meta.glob("./mod" + "ules/" + \`\${"b"}.js\`)),
            optional: Object.keys(import.meta.glob?.("./modules/a.js")),
            computed: Object.keys(import.meta["glob"]("./modules/a.js")),
          }));
        `,
      }),
    ).toEqual({
      template: ["./modules/a.js"],
      folded: ["./modules/b.js"],
      optional: ["./modules/a.js"],
      computed: ["./modules/a.js"],
    });
  });

  test("file names with non-ASCII characters and glob metacharacters", async () => {
    expect(
      await run({
        "main.js": `
          const pages = import.meta.glob("./pages/**/*.js", { import: "default" });
          const eager = import.meta.glob("./pages/**/*.js", { import: "default", eager: true });
          const inside = import.meta.glob("./*.js", { base: "./pages/[id]", import: "default", eager: true });
          const loaded = {};
          for (const key in pages) loaded[key] = await pages[key]();
          console.log(JSON.stringify({ loaded, eager, inside }));
        `,
        "pages/[id]/page.js": `export default "id";`,
        "pages/日本語.js": `export default "nihongo";`,
        "pages/with space & (parens).js": `export default "space";`,
      }),
    ).toEqual({
      loaded: {
        "./pages/[id]/page.js": "id",
        "./pages/with space & (parens).js": "space",
        "./pages/日本語.js": "nihongo",
      },
      eager: {
        "./pages/[id]/page.js": "id",
        "./pages/with space & (parens).js": "space",
        "./pages/日本語.js": "nihongo",
      },
      inside: { "./page.js": "id" },
    });
  });

  test("a call in dead code is not expanded", async () => {
    expect(
      await run({
        "main.js": `
          if (false) import.meta.glob(notALiteral, { as: "raw" });
          console.log(JSON.stringify(typeof import.meta.glob));
        `,
      }),
    ).toBe("undefined");
  });

  test("a file that calls it is not served from the transpiler cache", async () => {
    using dir = tempDir("import-meta-glob-cache", {
      // Larger than the cache's minimum size.
      "main.js": `
        console.log(JSON.stringify(Object.keys(import.meta.glob("./dir/*.js"))));
        // ${Buffer.alloc(8 * 1024, "x").toString()}
      `,
      "dir/a.js": "",
      "cache/.keep": "",
    });
    const env = { ...bunEnv, BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(String(dir), "cache") };

    const first = await spawn(String(dir), ["main.js"], env);
    expect(first.stderr).toBe("");
    expect(JSON.parse(first.stdout)).toEqual(["./dir/a.js"]);

    writeFileSync(path.join(String(dir), "dir", "b.js"), "");
    const second = await spawn(String(dir), ["main.js"], env);
    expect(second.stderr).toBe("");
    expect(JSON.parse(second.stdout)).toEqual(["./dir/a.js", "./dir/b.js"]);
  });

  test("Bun.Transpiler leaves the call alone, there is no file to match next to", () => {
    const transpiler = new Bun.Transpiler({ loader: "ts" });
    expect(transpiler.transformSync(`const found = import.meta.glob("./*.ts", { eager: true });`)).toBe(
      `const found = import.meta.glob("./*.ts", { eager: true });\n`,
    );
  });

  describe("errors", () => {
    test.each([
      [`import.meta.glob()`, "import.meta.glob() expects a pattern and an optional options object"],
      [`import.meta.glob("./a", {}, 1)`, "import.meta.glob() expects a pattern and an optional options object"],
      [
        `let pattern = "./dir/*.js"; pattern += ""; import.meta.glob(pattern)`,
        "import.meta.glob() patterns must be a string literal or an array of string literals",
      ],
      [`import.meta.glob(["./dir/*.js", 1])`, "import.meta.glob() patterns must be string literals"],
      [`import.meta.glob("dir/*.js")`, `import.meta.glob() pattern "dir/*.js" must start with "./", "../" or "/"`],
      [
        `import.meta.glob(["./dir/*.js", "!dir/a.js"])`,
        `import.meta.glob() pattern "!dir/a.js" must start with "./", "../" or "/"`,
      ],
      [`import.meta.glob("!./dir/*.js")`, "import.meta.glob() needs at least one pattern that is not negated"],
      [`import.meta.glob("./dir/*.js", globalThis.options)`, "import.meta.glob() options must be an object literal"],
      [
        `import.meta.glob("./dir/*.js", { ...globalThis.options })`,
        "import.meta.glob() options must be written out as literals",
      ],
      [
        `import.meta.glob("./dir/*.js", { eager: globalThis.eager })`,
        'import.meta.glob() option "eager" must be `true` or `false`',
      ],
      [`import.meta.glob("./dir/*.js", { import: 1 })`, 'import.meta.glob() option "import" must be a string literal'],
      [
        `import.meta.glob("./dir/*.js", { base: "dir" })`,
        'import.meta.glob() option "base" must start with "./", "../" or "/"',
      ],
      [
        `import.meta.glob("./dir/*.js", { query: 1 })`,
        'import.meta.glob() option "query" must be a string literal or an object literal',
      ],
      [
        `import.meta.glob("./dir/*.js", { query: { a: [] } })`,
        "import.meta.glob() query values must be string, number or boolean literals",
      ],
      [
        `import.meta.glob("./dir/*.js", { with: "text" })`,
        'import.meta.glob() option "with" must be an object literal of import attributes',
      ],
      [
        `import.meta.glob("./dir/*.js", { as: "raw" })`,
        'import.meta.glob() does not support the deprecated "as" option',
      ],
      [`import.meta.glob("./dir/*.js", { egaer: true })`, 'import.meta.glob() does not have an option named "egaer"'],
    ])("%s", async (source, message) => {
      const stderr = await fails(source);
      expect(stderr).toContain("error: " + message);
      // The error points into the call.
      expect(stderr).toContain("main.js:1:");
    });
  });
});
