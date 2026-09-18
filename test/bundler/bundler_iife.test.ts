import { describe } from "bun:test";
import { itBundled } from "./expectBundled";

// Loads /out.js the way a <script> tag does (global code: a top-level `var` and `this` are the
// global object), then prints an expression.
const script = (expression: string, file = "/out.js") => ({
  "/script.js": /* js */ `
    import { readFileSync } from "node:fs";
    import { runInThisContext } from "node:vm";
    runInThisContext(readFileSync(import.meta.dir + ${JSON.stringify(file)}, "utf8"));
    console.log(${expression});
  `,
});

describe("bundler", () => {
  for (const backend of ["api", "cli"] as const) {
    itBundled(`iife/GlobalName_${backend}`, {
      files: {
        "/entry.js": /* js */ `
          import { version } from "./version.js";
          export { version };
          export let count = 0;
          export function increment() {
            return ++count;
          }
          export default class Client {}
        `,
        "/version.js": /* js */ `export const version = "1.2.3";`,
      },
      format: "iife",
      globalName: "MyLib",
      backend,
      onAfterBundle(api) {
        api.expectFile("/out.js").toStartWith("var MyLib = (() => {\n");
        api.expectFile("/out.js").toEndWith("  return __toCommonJS(exports_entry);\n})();\n");
      },
      runtimeFiles: script(
        `JSON.stringify(MyLib), MyLib.__esModule, MyLib.default.name, MyLib.increment(), MyLib.count`,
      ),
      run: { file: "/script.js", stdout: '{"count":0,"version":"1.2.3"} true Client 1 1' },
    });
  }

  itBundled("iife/GlobalNameCommonJSEntry", {
    files: {
      "/entry.js": /* js */ `
        const { greeting } = require("./greeting.js");
        module.exports = function hello(name) {
          return greeting + ", " + name;
        };
        module.exports.greeting = greeting;
      `,
      "/greeting.js": /* js */ `exports.greeting = "hello";`,
    },
    format: "iife",
    globalName: "hello",
    runtimeFiles: script(`typeof hello, hello("bun"), hello.greeting`),
    run: { file: "/script.js", stdout: "function hello, bun hello" },
  });

  itBundled("iife/GlobalNameJSONEntry", {
    files: {
      "/config.json": `{ "name": "soup", "tags": ["a", "b"] }`,
    },
    entryPoints: ["/config.json"],
    outfile: "/out.js",
    format: "iife",
    globalName: "config",
    runtimeFiles: script(`JSON.stringify(config)`),
    run: { file: "/script.js", stdout: '{"name":"soup","tags":["a","b"]}' },
  });

  // The entry point is ESM that another file require()s, so it runs from its `init_` wrapper.
  itBundled("iife/GlobalNameWrappedESMEntry", {
    files: {
      "/entry.js": /* js */ `
        export const name = "entry";
        export const fromRequire = require("./cjs.js").seen;
      `,
      "/cjs.js": /* js */ `exports.seen = Object.keys(require("./entry.js")).join();`,
    },
    format: "iife",
    globalName: "MyLib",
    runtimeFiles: script(`JSON.stringify(MyLib)`),
    run: { file: "/script.js", stdout: '{"fromRequire":"fromRequire,name","name":"entry"}' },
  });

  itBundled("iife/GlobalNamePropertyPath", {
    files: {
      "/entry.js": /* js */ `export const id = "my-lib";`,
    },
    format: "iife",
    globalName: `app.plugins["my-lib"]`,
    onAfterBundle(api) {
      api.expectFile("/out.js").toStartWith(`var app;\n((app ||= {}).plugins ||= {})["my-lib"] = (() => {\n`);
    },
    runtimeFiles: {
      ...script(`JSON.stringify(app)`),
      // What is already there stays: several bundles can share one namespace.
      "/shared.js": /* js */ `
        import { readFileSync } from "node:fs";
        import { runInThisContext } from "node:vm";
        globalThis.app = { name: "app", plugins: { other: 1 } };
        runInThisContext(readFileSync(import.meta.dir + "/out.js", "utf8"));
        console.log(JSON.stringify(app));
      `,
    },
    run: [
      { file: "/script.js", stdout: '{"plugins":{"my-lib":{"id":"my-lib"}}}' },
      { file: "/shared.js", stdout: '{"name":"app","plugins":{"other":1,"my-lib":{"id":"my-lib"}}}' },
    ],
  });

  itBundled("iife/GlobalNameThis", {
    files: {
      "/entry.js": /* js */ `export const a = 1;`,
    },
    format: "iife",
    globalName: "this.libs.a",
    onAfterBundle(api) {
      api.expectFile("/out.js").toStartWith("(this.libs ||= {}).a = (() => {\n");
    },
    runtimeFiles: script(`JSON.stringify(globalThis.libs)`),
    run: { file: "/script.js", stdout: '{"a":{"a":1}}' },
  });

  itBundled("iife/GlobalNameMinified", {
    files: {
      "/entry.js": /* js */ `
        export const answer = 42;
        export function ask() {
          return answer;
        }
      `,
    },
    format: "iife",
    globalName: "a.b",
    minifyWhitespace: true,
    minifyIdentifiers: true,
    minifySyntax: true,
    onAfterBundle(api) {
      api.expectFile("/out.js").toStartWith("var a;(a||={}).b=(()=>{");
    },
    runtimeFiles: script(`a.b.ask(), Object.keys(a.b).join()`),
    run: { file: "/script.js", stdout: "42 answer,ask" },
  });

  // The banner and the directive stay in front, and the source map accounts for the lines the
  // assignment adds.
  itBundled("iife/GlobalNameBannerDirectiveSourceMap", {
    files: {
      "/entry.js": /* js */ `
        "use strict";
        console.log("mapped");
      `,
    },
    outdir: "/out",
    format: "iife",
    globalName: "ns.lib",
    banner: "/* banner */",
    sourceMap: "external",
    onAfterBundle(api) {
      api.expectFile("/out/entry.js").toStartWith(`/* banner */\n"use strict";\nvar ns;\n(ns ||= {}).lib = (() => {\n`);
    },
    snapshotSourceMap: {
      "entry.js.map": {
        files: ["../entry.js"],
        mappings: [["entry.js:2:'console'", "7:2:console"]],
      },
    },
    runtimeFiles: script(`typeof ns.lib`, "/out/entry.js"),
    run: { file: "/script.js", stdout: "mapped\nundefined" },
  });

  itBundled("iife/GlobalNameEveryEntryPoint", {
    files: {
      "/a.js": /* js */ `export const from = "a";`,
      "/b.js": /* js */ `export const from = "b";`,
    },
    entryPoints: ["/a.js", "/b.js"],
    outdir: "/out",
    format: "iife",
    globalName: "MyLib",
    runtimeFiles: {
      ...script(`MyLib.from`, "/out/a.js"),
      "/script-b.js": script(`MyLib.from`, "/out/b.js")["/script.js"],
    },
    run: [
      { file: "/script.js", stdout: "a" },
      { file: "/script-b.js", stdout: "b" },
    ],
  });

  itBundled("iife/GlobalNameWithoutExports", {
    files: {
      "/entry.js": /* js */ `console.log("ran");`,
    },
    format: "iife",
    globalName: "MyLib",
    onAfterBundle(api) {
      api.expectFile("/out.js").toStartWith("var MyLib = (() => {\n");
    },
    runtimeFiles: script(`typeof MyLib`),
    run: { file: "/script.js", stdout: "ran\nundefined" },
  });

  // The assignment is ASCII whatever the name is: Bun reads its own "// @bun" output as Latin-1.
  const accepted = {
    SingleQuotes: { globalName: `a['b']`, prefix: "var a;\n(a ||= {}).b = ", read: "a.b" },
    ReservedProperty: {
      globalName: "a.class.new",
      prefix: "var a;\n((a ||= {}).class ||= {}).new = ",
      read: "a.class.new",
    },
    ThisQuoted: { globalName: `this["x-y"]`, prefix: `this["x-y"] = `, read: `globalThis["x-y"]` },
    EmptyProperty: { globalName: `a[""]`, prefix: `var a;\n(a ||= {})[""] = `, read: `a[""]` },
    QuotesInProperty: { globalName: `a['"b"].c']`, prefix: `var a;\n(a ||= {})["\\"b\\"].c"] = `, read: `a['"b"].c']` },
    UnicodeVariable: { globalName: "café", prefix: "var caf\\u{e9} = ", read: "café" },
    UnicodeProperties: {
      globalName: `ns.café["名前"]`,
      prefix: `var ns;\n((ns ||= {})["caf\\u00E9"] ||= {})["\\u540D\\u524D"] = `,
      read: `ns.café["名前"]`,
    },
  };
  for (const [label, { globalName, prefix, read }] of Object.entries(accepted)) {
    itBundled(`iife/GlobalNameAccepted${label}`, {
      files: {
        "/entry.js": /* js */ `export const ok = ${JSON.stringify(label)};`,
      },
      format: "iife",
      target: "bun",
      globalName,
      onAfterBundle(api) {
        api.expectFile("/out.js").toStartWith("// @bun\n" + prefix + "(() => {\n");
      },
      runtimeFiles: script(`${read}.ok`),
      run: { file: "/script.js", stdout: label },
    });
  }

  itBundled("iife/GlobalNameEmptyIsUnset", {
    files: {
      "/entry.js": /* js */ `export const a = 1;`,
    },
    format: "iife",
    globalName: "",
    onAfterBundle(api) {
      api.expectFile("/out.js").toStartWith("(() => {\n");
    },
  });

  // Bun loads the script of an HTML entry point as a module, where `this` is undefined and a
  // `var` is not global: it gets no assignment.
  itBundled("iife/GlobalNameSkipsHTMLEntryPoint", {
    files: {
      "/index.html": `<!DOCTYPE html><html><body><script src="./app.js"></script></body></html>`,
      "/app.js": /* js */ `export const a = 1; console.log("app");`,
    },
    entryPoints: ["/index.html"],
    outdir: "/out",
    format: "iife",
    globalName: "this.app.main",
    onAfterBundle(api) {
      const src = api.readFile("/out/index.html").match(/src="\.\/([^"]+\.js)"/)![1];
      api.expectFile("/out/" + src).toStartWith("(() => {\n");
    },
  });

  // Nothing can read the exports of an IIFE that has no global name, so no exports object is made.
  itBundled("iife/NoGlobalNameNoExportsObject", {
    files: {
      "/entry.js": /* js */ `
        export const unused = 1;
        console.log("ran");
      `,
    },
    format: "iife",
    onAfterBundle(api) {
      api.expectFile("/out.js").toStartWith("(() => {\n");
      api.expectFile("/out.js").not.toContain("__toCommonJS");
      api.expectFile("/out.js").not.toContain("exports_entry");
    },
    run: { stdout: "ran" },
  });

  // An entry point that sits in a wrapper has to be called, global name or not.
  itBundled("iife/CommonJSEntryRuns", {
    files: {
      "/entry.js": /* js */ `
        module.exports = 1;
        console.log("cjs entry ran");
      `,
    },
    format: "iife",
    run: { stdout: "cjs entry ran" },
  });
  itBundled("iife/WrappedESMEntryRuns", {
    files: {
      "/entry.js": /* js */ `
        export const name = "entry";
        console.log("esm entry ran", require("./cjs.js").seen);
      `,
      "/cjs.js": /* js */ `exports.seen = Object.keys(require("./entry.js")).join();`,
    },
    format: "iife",
    run: { stdout: "esm entry ran name" },
  });

  const rejected = {
    LeadingDigit: "1abc",
    EmptySegment: "a..b",
    TrailingDot: "a.",
    ReservedWord: "class",
    StrictReservedWord: "let",
    Eval: "eval",
    BareThis: "this",
    UnquotedIndex: "a[b]",
    UnclosedBracket: "a[",
    UnclosedQuote: `a["b`,
    MissingBracket: `a["b"`,
    TextAfterBracket: `a["b"]c`,
    EscapeInQuotes: `a["b\\n"]`,
    Space: "a b",
    Dash: "a-b",
    Whitespace: " a",
  };
  for (const backend of ["api", "cli"] as const) {
    for (const [label, globalName] of Object.entries(rejected)) {
      itBundled(`iife/GlobalNameRejected${label}_${backend}`, {
        files: {
          "/entry.js": /* js */ `export const a = 1;`,
        },
        format: "iife",
        globalName,
        backend,
        bundleErrors: {
          "<bun>": [
            `Invalid global name ${JSON.stringify(globalName)}: expected a variable name or a property path, such as "MyLib" or "app.plugins.myLib"`,
          ],
        },
      });
    }

    for (const format of ["esm", "cjs"] as const) {
      itBundled(`iife/GlobalNameNeedsIIFE_${backend}_${format}`, {
        files: {
          "/entry.js": /* js */ `export const a = 1;`,
        },
        format,
        globalName: "MyLib",
        backend,
        bundleErrors: {
          "<bun>": ['A global name is only supported when format is set to "iife"'],
        },
      });
    }
  }
});
