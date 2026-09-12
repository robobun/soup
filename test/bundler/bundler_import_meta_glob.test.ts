import { describe, expect } from "bun:test";
import { readdirSync } from "fs";
import { itBundled } from "./expectBundled";

// import.meta.glob() is expanded by the parser, so the bundler only ever sees
// ordinary imports. The runtime side (patterns, options, errors) is covered in
// test/js/bun/resolve/import-meta-glob.test.ts.

describe("bundler", () => {
  const pages = {
    "/pages/about.js": /* js */ `
      export default "about";
      export const title = "About";
      export const unused = "DROPPED_about";
    `,
    "/pages/home.js": /* js */ `
      export default "home";
      export const title = "Home";
      export const unused = "DROPPED_home";
    `,
  };

  itBundled("import_meta_glob/Lazy", {
    files: {
      "/entry.js": /* js */ `
        const found = import.meta.glob("./pages/*.js");
        console.log(JSON.stringify(Object.keys(found)));
        for (const key in found) {
          const page = await found[key]();
          console.log(key, page.default, page.title);
        }
      `,
      ...pages,
    },
    run: {
      stdout: `["./pages/about.js","./pages/home.js"]\n./pages/about.js about About\n./pages/home.js home Home`,
    },
    onAfterBundle(api) {
      api.expectFile("/out.js").not.toContain("import.meta.glob");
    },
  });

  itBundled("import_meta_glob/LazySplitting", {
    files: {
      "/entry.js": /* js */ `
        const found = import.meta.glob("./pages/*.js");
        console.log((await found["./pages/home.js"]()).default);
      `,
      ...pages,
    },
    splitting: true,
    outdir: "/out",
    run: { file: "/out/entry.js", stdout: "home" },
    onAfterBundle(api) {
      // One chunk per matched module, loaded on demand.
      expect(readdirSync(api.outdir).sort()).toEqual([
        expect.stringMatching(/^about-.*\.js$/),
        "entry.js",
        expect.stringMatching(/^home-.*\.js$/),
      ]);
      api.expectFile("/out/entry.js").not.toContain("DROPPED");
      api.expectFile("/out/entry.js").toMatch(/"\.\/pages\/about\.js": \(\) => .*import\("\.\/about-.*\.js"\)/);
    },
  });

  itBundled("import_meta_glob/Eager", {
    files: {
      "/entry.js": /* js */ `
        const found = import.meta.glob("./pages/*.js", { eager: true });
        console.log(JSON.stringify(found));
      `,
      ...pages,
    },
    run: {
      stdout: JSON.stringify({
        "./pages/about.js": { default: "about", title: "About", unused: "DROPPED_about" },
        "./pages/home.js": { default: "home", title: "Home", unused: "DROPPED_home" },
      }),
    },
  });

  itBundled("import_meta_glob/EagerImportTreeShakes", {
    files: {
      "/entry.js": /* js */ `
        const titles = import.meta.glob("./pages/*.js", { eager: true, import: "title" });
        console.log(JSON.stringify(titles));
      `,
      ...pages,
    },
    run: { stdout: `{"./pages/about.js":"About","./pages/home.js":"Home"}` },
    onAfterBundle(api) {
      // Bound like `import { title } from`, so no namespace objects and no other exports.
      api.expectFile("/out.js").not.toContain("DROPPED");
      api.expectFile("/out.js").not.toContain("__export");
    },
  });

  for (const splitting of [false, true]) {
    itBundled(`import_meta_glob/LazyImportTreeShakes${splitting ? "Splitting" : ""}`, {
      files: {
        "/entry.js": /* js */ `
          const titles = import.meta.glob("./pages/*.js", { import: "title" });
          console.log(await titles["./pages/about.js"](), await titles["./pages/home.js"]());
        `,
        ...pages,
      },
      splitting,
      outdir: "/out",
      run: { file: "/out/entry.js", stdout: "About Home" },
      onAfterBundle(api) {
        for (const file of readdirSync(api.outdir)) {
          api.expectFile("/out/" + file).not.toContain("DROPPED");
        }
      },
    });
  }

  itBundled("import_meta_glob/UnusedResultIsRemoved", {
    files: {
      "/entry.js": /* js */ `
        const unused = import.meta.glob("./pages/*.js");
        console.log("done");
      `,
      ...pages,
    },
    run: { stdout: "done" },
    onAfterBundle(api) {
      api.expectFile("/out.js").not.toContain("pages");
    },
  });

  itBundled("import_meta_glob/WithAttributes", {
    files: {
      "/entry.js": /* js */ `
        const eager = import.meta.glob("./queries/*", { with: { type: "text" }, import: "default", eager: true });
        const lazy = import.meta.glob("./queries/*", { with: { type: "text" }, import: "default" });
        console.log(JSON.stringify({ eager, lazy: await lazy["./queries/b.js"]() }));
      `,
      "/queries/a.sql": `select 1`,
      "/queries/b.js": `throw new Error("not evaluated")`,
    },
    run: {
      stdout: JSON.stringify({
        eager: { "./queries/a.sql": "select 1", "./queries/b.js": `throw new Error("not evaluated")` },
        lazy: `throw new Error("not evaluated")`,
      }),
    },
  });

  itBundled("import_meta_glob/OtherLoaders", {
    files: {
      "/entry.ts": /* ts */ `
        const locales = import.meta.glob<Record<string, string>>("./locales/*.json", { eager: true, import: "default" });
        const views = import.meta.glob<{ default: () => string }>("./views/*.tsx");
        console.log(locales["./locales/fr.json"].hello, (await views["./views/a.tsx"]()).default());
      `,
      "/locales/en.json": `{"hello":"Hello"}`,
      "/locales/fr.json": `{"hello":"Bonjour"}`,
      "/views/a.tsx": `export default function A(): string { return "view a"; }`,
    },
    run: { stdout: "Bonjour view a" },
  });

  itBundled("import_meta_glob/FromRootAndBase", {
    // Patterns that start with "/" are matched from the directory bun runs in.
    backend: "cli",
    files: {
      "/src/entry.js": /* js */ `
        const rooted = import.meta.glob("/src/lib/*.js", { eager: true, import: "default" });
        const based = import.meta.glob("./*.js", { base: "./lib", eager: true, import: "default" });
        const fromRootBase = import.meta.glob("./*.js", { base: "/src/lib", eager: true, import: "default" });
        console.log(JSON.stringify({ rooted, based, fromRootBase }));
      `,
      "/src/lib/a.js": `export default "a";`,
    },
    entryPoints: ["/src/entry.js"],
    run: {
      stdout: JSON.stringify({
        rooted: { "/src/lib/a.js": "a" },
        based: { "./a.js": "a" },
        fromRootBase: { "./a.js": "a" },
      }),
    },
  });

  itBundled("import_meta_glob/FormatCJS", {
    files: {
      "/entry.js": /* js */ `
        const eager = import.meta.glob("./pages/*.js", { eager: true, import: "default" });
        const lazy = import.meta.glob("./pages/*.js", { import: "title" });
        lazy["./pages/home.js"]().then(title => console.log(JSON.stringify(eager), title));
      `,
      ...pages,
    },
    format: "cjs",
    target: "node",
    run: { stdout: `{"./pages/about.js":"about","./pages/home.js":"home"} Home` },
  });

  itBundled("import_meta_glob/Minify", {
    files: {
      "/entry.js": /* js */ `
        const eager = import.meta.glob("./pages/*.js", { eager: true, import: "default" });
        const lazy = import.meta.glob("./pages/*.js");
        console.log(JSON.stringify(eager), (await lazy["./pages/home.js"]()).title);
      `,
      ...pages,
    },
    minifySyntax: true,
    minifyIdentifiers: true,
    minifyWhitespace: true,
    run: { stdout: `{"./pages/about.js":"about","./pages/home.js":"home"} Home` },
  });

  itBundled("import_meta_glob/Compile", {
    compile: true,
    files: {
      "/entry.js": /* js */ `
        const eager = import.meta.glob("./pages/*.js", { eager: true, import: "default" });
        const lazy = import.meta.glob("./pages/*.js", { import: "title" });
        console.log(JSON.stringify(eager), await lazy["./pages/about.js"]());
      `,
      ...pages,
    },
    run: { stdout: `{"./pages/about.js":"about","./pages/home.js":"home"} About` },
  });

  itBundled("import_meta_glob/QueryGoesThroughPlugins", {
    files: {
      "/entry.js": /* js */ `
        const icons = import.meta.glob("./icons/*.svg", { query: "?raw", import: "default", eager: true });
        console.log(JSON.stringify(icons));
      `,
      "/icons/a.svg": `<svg id="a"/>`,
    },
    plugins(builder) {
      builder.onResolve({ filter: /\?raw$/ }, args => ({
        path: Bun.fileURLToPath(new URL(args.path.slice(0, -"?raw".length), Bun.pathToFileURL(args.importer))),
        namespace: "raw",
      }));
      builder.onLoad({ filter: /.*/, namespace: "raw" }, async args => ({
        contents: await Bun.file(args.path).text(),
        loader: "text",
      }));
    },
    run: { stdout: `{"./icons/a.svg":"<svg id=\\"a\\"/>"}` },
  });

  itBundled("import_meta_glob/NotExpandedInVirtualModules", {
    // A module that is not a file on disk has no directory to match in.
    files: {
      "/entry.js": /* js */ `
        import found from "virtual:glob";
        console.log(found);
      `,
      ...pages,
    },
    plugins(builder) {
      builder.onResolve({ filter: /^virtual:glob$/ }, args => ({ path: args.path, namespace: "virtual" }));
      builder.onLoad({ filter: /.*/, namespace: "virtual" }, () => ({
        contents: `export default typeof import.meta.glob;`,
        loader: "js",
      }));
    },
    run: { stdout: "undefined" },
  });

  itBundled("import_meta_glob/Errors", {
    files: {
      "/entry.js": /* js */ `
        import.meta.glob(globalThis.pattern);
        import.meta.glob("pages/*.js");
        import.meta.glob("./pages/*.js", { eager: 1 });
      `,
      ...pages,
    },
    bundleErrors: {
      "/entry.js": [
        "import.meta.glob() patterns must be a string literal or an array of string literals, because they are matched when the file is transpiled",
        `import.meta.glob() pattern "pages/*.js" must start with "./", "../" or "/"`,
        'import.meta.glob() option "eager" must be `true` or `false`',
      ],
    },
  });
});
