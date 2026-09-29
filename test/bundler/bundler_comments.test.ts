import { describe, expect, test } from "bun:test";
import { tempDir } from "harness";
import { readdirSync, readFileSync } from "node:fs";
import { SourceMap, type SourceMapping } from "node:module";
import { join } from "node:path";
import { itBundled } from "./expectBundled";

describe("single-line comments", () => {
  itBundled("unix newlines", {
    files: {
      "/entry.js": `// This is a comment\nconsole.log("hello");\n// Another comment\n`,
    },
    onAfterBundle(api) {
      const output = api.readFile("/out.js");
      api.expectFile("/out.js").toContain("hello");
    },
  });

  itBundled("windows newlines", {
    files: {
      "/entry.js": `// This is a comment\r\nconsole.log("hello");\r\n// Another comment\r\n`,
    },
    onAfterBundle(api) {
      api.expectFile("/out.js").toContain("hello");
    },
  });

  itBundled("no trailing newline", {
    files: {
      "/entry.js": `// This is a comment\nconsole.log("hello");\n// No newline at end`,
    },
    onAfterBundle(api) {
      api.expectFile("/out.js").toContain("hello");
    },
  });

  itBundled("non-ascii characters", {
    files: {
      "/entry.js": `// 你好，世界\n// Привет, мир\n// こんにちは世界\nconsole.log("hello");\n`,
    },
    onAfterBundle(api) {
      api.expectFile("/out.js").toContain("hello");
    },
  });

  itBundled("emoji", {
    files: {
      "/entry.js": `// 🚀 🔥 💯\nconsole.log("hello");\n`,
    },
    onAfterBundle(api) {
      api.expectFile("/out.js").toContain("hello");
    },
  });

  itBundled("invalid surrogate pair at beginning", {
    files: {
      "/entry.js": `// \uDC00 invalid surrogate\nconsole.log("hello");\n`,
    },
    onAfterBundle(api) {
      api.expectFile("/out.js").toContain("hello");
    },
  });

  itBundled("invalid surrogate pair at end", {
    files: {
      "/entry.js": `// invalid surrogate \uD800\nconsole.log("hello");\n`,
    },
    onAfterBundle(api) {
      api.expectFile("/out.js").toContain("hello");
    },
  });

  itBundled("invalid surrogate pair in middle", {
    files: {
      "/entry.js": `// invalid \uD800\uDC00\uD800 surrogate\nconsole.log("hello");\n`,
    },
    onAfterBundle(api) {
      api.expectFile("/out.js").toContain("hello");
    },
  });

  itBundled("multiple comments on same line", {
    files: {
      "/entry.js": `const x = 5; // first comment // second comment\nconsole.log(x);\n`,
    },
    onAfterBundle(api) {
      api.expectFile("/out.js").toContain("console.log(x)");
    },
  });

  itBundled("comment with ASI", {
    files: {
      "/entry.js": `const x = 5// first comment // second comment\nconsole.log(x)`,
    },
    onAfterBundle(api) {
      api.expectFile("/out.js").toContain("console.log(x)");
    },
  });

  itBundled("comment at end of file without newline", {
    files: {
      "/entry.js": `console.log("hello"); //`,
    },
    onAfterBundle(api) {
      api.expectFile("/out.js").toContain("hello");
    },
  });

  itBundled("empty comments", {
    files: {
      "/entry.js": `//\n//\nconsole.log("hello");\n//`,
    },
    onAfterBundle(api) {
      api.expectFile("/out.js").toContain("hello");
    },
  });

  itBundled("comments with special characters", {
    files: {
      "/entry.js": `// Comment with \\ backslash\n// Comment with \" quote\n// Comment with \t tab\nconsole.log("hello");\n`,
    },
    onAfterBundle(api) {
      api.expectFile("/out.js").toContain("hello");
    },
  });

  itBundled("comments with control characters", {
    files: {
      "/entry.js": `// Comment with \u0000 NULL\n// Comment with \u0001 SOH\nconsole.log("hello");\n`,
    },
    onAfterBundle(api) {
      api.expectFile("/out.js").toContain("hello");
    },
  });

  itBundled("comments with minification", {
    files: {
      "/entry.js": `// This should be removed\nconsole.log("hello");\n// This too`,
    },
    minifyWhitespace: true,
    minifySyntax: true,
    onAfterBundle(api) {
      api.expectFile("/out.js").toEqualIgnoringWhitespace('console.log("hello");');
    },
  });

  for (const minify of [true, false]) {
    itBundled(
      `some code and an empty comment without newline preceding ${minify ? "with minification" : "without minification"}`,
      {
        files: {
          "/entry.js": `console.log("hello");//`,
        },
        minifyWhitespace: minify,
        minifySyntax: minify,
        run: {
          stdout: "hello",
        },
      },
    );
    itBundled(`some code and then only an empty comment ${minify ? "with minification" : "without minification"}`, {
      files: {
        "/entry.js": `console.log("hello");\n//`,
      },
      minifyWhitespace: minify,
      minifySyntax: minify,
      run: {
        stdout: "hello",
      },
    });
    itBundled(`only an empty comment ${minify ? "with minification" : "without minification"}`, {
      files: {
        "/entry.js": `//`,
      },
      minifyWhitespace: minify,
      minifySyntax: minify,
      run: {
        stdout: "",
      },
    });
    itBundled("only a comment", {
      files: {
        "/entry.js": `// This is a comment`,
      },
      minifyWhitespace: true,
      minifySyntax: true,
      run: {
        stdout: "",
      },
    });
  }

  itBundled("trailing //# sourceMappingURL=", {
    files: {
      "/entry.js": `// This is a comment\nconsole.log("hello");\n//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZXhhbXBsZS5qcyIsInNvdXJjZSI6Ii8vZXhhbXBsZS5qcyJ9`,
    },
    onAfterBundle(api) {
      api.expectFile("/out.js").toContain("hello");
    },
  });

  itBundled("trailing //# sourceMappingURL= with == at end", {
    files: {
      "/entry.js": `// This is a comment\nconsole.log("hello");\n//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZXhhbXBsZS5qcyIsInNvdXJjZSI6Ii8vZXhhbXBsZS5qcyJ9==`,
    },
    onAfterBundle(api) {
      api.expectFile("/out.js").toContain("hello");
    },
  });

  itBundled("trailing //# sourceMappingURL= with = at end", {
    files: {
      "/entry.js": `// This is a comment\nconsole.log("hello");\n//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZXhhbXBsZS5qcyIsInNvdXJjZSI6Ii8vZXhhbXBsZS5qcyJ9=`,
    },
    onAfterBundle(api) {
      api.expectFile("/out.js").toContain("hello");
    },
  });

  itBundled("leading //# sourceMappingURL= with = at end", {
    files: {
      "/entry.js": `//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZXhhbXBsZS5qcyIsInNvdXJjZSI6Ii8vZXhhbXBsZS5qcyJ9=\n// This is a comment\nconsole.log("hello");`,
    },
    onAfterBundle(api) {
      api.expectFile("/out.js").toContain("hello");
    },
  });

  itBundled("leading trailing newline //# sourceMappingURL= with = at end", {
    files: {
      "/entry.js": `//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZXhhbXBsZS5qcyIsInNvdXJjZSI6Ii8vZXhhbXBsZS5qcyJ9=\n// This is a comment\nconsole.log("hello");\n`,
    },
    onAfterBundle(api) {
      api.expectFile("/out.js").toContain("hello");
    },
  });

  itBundled("leading newline and sourcemap, trailing newline //# sourceMappingURL= with = at end", {
    files: {
      "/entry.js": `\n//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZXhhbXBsZS5qcyIsInNvdXJjZSI6Ii8vZXhhbXBsZS5qcyJ9=\n// This is a comment\nconsole.log("hello");\n`,
    },
    onAfterBundle(api) {
      api.expectFile("/out.js").toContain("hello");
    },
  });

  itBundled("__PURE__ comment in single-line comment basic", {
    files: {
      "/entry.js": `//#__PURE__\nconsole.log("hello");`,
    },
    onAfterBundle(api) {
      api.expectFile("/out.js").not.toContain("hello");
    },
  });

  itBundled("__PURE__ comment in single-line comment with spaces", {
    files: {
      "/entry.js": `// #__PURE__ \nconsole.log("hello");`,
    },
    onAfterBundle(api) {
      api.expectFile("/out.js").not.toContain("hello");
    },
  });

  // A marker that is not the first word of a `//` comment is prose, not an
  // annotation. An unused pure call is removed even without minification, so a
  // false match deletes code.
  itBundled("__PURE__ comment in single-line comment with text before", {
    files: {
      "/entry.js": `// some text #__PURE__\nconsole.log("hello");`,
    },
    onAfterBundle(api) {
      api.expectFile("/out.js").toContain("hello");
    },
  });

  itBundled("__PURE__ comment in single-line comment with tab before", {
    files: {
      "/entry.js": `//\t@__PURE__\nconsole.log("hello");`,
    },
    onAfterBundle(api) {
      api.expectFile("/out.js").not.toContain("hello");
    },
  });

  itBundled("quoted /*#__PURE__*/ inside a single-line comment", {
    files: {
      "/entry.js": `function repro() {\n  // \`/*#__PURE__*/\`\n  console.log("hello");\n}\nrepro();`,
    },
    run: {
      stdout: "hello",
    },
  });

  itBundled("quoted /*#__PURE__*/ after text inside a single-line comment", {
    files: {
      "/entry.js": `// Wrap class inside init: \`/*#__PURE__*/ (() => { let C = class C {}; return C; })()\`\nconsole.log("hello");`,
    },
    onAfterBundle(api) {
      api.expectFile("/out.js").toContain("hello");
    },
  });

  itBundled("many markers after leading whitespace in a single-line comment", {
    files: {
      "/entry.js": `//${Buffer.alloc(4096, " ").toString()}${Buffer.alloc(4096, "@").toString()}__PURE__\nconsole.log("hello");`,
    },
    onAfterBundle(api) {
      api.expectFile("/out.js").toContain("hello");
    },
  });

  itBundled("__PURE__ comment in single-line comment with text after", {
    files: {
      "/entry.js": `// #__PURE__ some text\nconsole.log("hello");`,
    },
    onAfterBundle(api) {
      api.expectFile("/out.js").not.toContain("hello");
    },
  });

  itBundled("__PURE__ comment in single-line comment with unicode characters", {
    files: {
      "/entry.js": `// 你好 #__PURE__ 世界\nconsole.log("hello");`,
    },
    onAfterBundle(api) {
      api.expectFile("/out.js").toContain("hello");
    },
  });

  itBundled("__PURE__ comment in single-line comment with unicode characters after", {
    files: {
      "/entry.js": `// #__PURE__ 世界\nconsole.log("hello");`,
    },
    onAfterBundle(api) {
      api.expectFile("/out.js").not.toContain("hello");
    },
  });

  itBundled("__PURE__ comment in single-line comment with emoji", {
    files: {
      "/entry.js": `// 🚀 #__PURE__ 🔥\nconsole.log("hello");`,
    },
    onAfterBundle(api) {
      api.expectFile("/out.js").toContain("hello");
    },
  });

  itBundled("__PURE__ comment in single-line comment with invalid surrogate pair", {
    files: {
      "/entry.js": `// \uD800 #__PURE__ \uDC00\nconsole.log("hello");`,
    },
    onAfterBundle(api) {
      api.expectFile("/out.js").toContain("hello");
    },
  });

  itBundled("multiple __PURE__ comments in single-line comments", {
    files: {
      "/entry.js": `//#__PURE__\nconsole.log("hello");\n//#__PURE__\nconsole.log("world");`,
    },
    onAfterBundle(api) {
      api.expectFile("/out.js").not.toContain("hello");
      api.expectFile("/out.js").not.toContain("world");
    },
  });

  itBundled("__PURE__ comment in single-line comment with minification", {
    files: {
      "/entry.js": `//#__PURE__\nconsole.log("hello");`,
    },
    minifyWhitespace: true,
    minifySyntax: true,
    onAfterBundle(api) {
      api.expectFile("/out.js").not.toContain("hello");
    },
  });

  itBundled("__PURE__ comment in single-line comment with windows newlines", {
    files: {
      "/entry.js": `//#__PURE__\r\nconsole.log("hello");`,
    },
    onAfterBundle(api) {
      api.expectFile("/out.js").not.toContain("hello");
    },
  });

  itBundled("__PURE__ comment in single-line comment at end of file", {
    files: {
      "/entry.js": `console.log("hello");\n//#__PURE__`,
    },
    onAfterBundle(api) {
      api.expectFile("/out.js").toContain("hello");
    },
  });

  itBundled("__PURE__ comment in single-line comment in middle of a statement", {
    files: {
      "/entry.js": `console.log(//#__PURE__\n123);`,
    },
    run: {
      stdout: "123",
    },
  });
});

describe("multi-line comments", () => {
  itBundled("comment with \\r\\n has sourcemap", {
    files: {
      "/entry.js": "/*!\r\n * Legal comment line 1\r\n * Legal comment line 2\r\n */\r\nexport const x = 1;",
    },
    sourceMap: "external",
    onAfterBundle(api) {
      const output = api.readFile("/out.js");
      const sourcemapContent = api.readFile("/out.js.map");
      const sourcemap = JSON.parse(sourcemapContent);
      const sm = new SourceMap(sourcemap);

      // Find the multi-line legal comment in the output
      const outputLines = output.split("\n");
      let commentLineIndex = -1;
      for (let i = 0; i < outputLines.length; i++) {
        if (outputLines[i].includes("Legal comment")) {
          commentLineIndex = i;
          break;
        }
      }

      expect(commentLineIndex).toBeGreaterThanOrEqual(0);

      // The multi-line legal comment should have a sourcemap entry
      const entry = sm.findEntry(commentLineIndex, 0) as SourceMapping;

      // Verify we found a mapping for the comment
      expect(entry).toBeTruthy();
      expect(Object.keys(entry).length).toBeGreaterThan(0);

      // The mapping should point back to the original source
      expect(entry!.originalSource!).toContain("entry.js");
      expect(typeof entry.originalLine).toBe("number");
      expect(entry.originalLine).toBeGreaterThanOrEqual(0);
    },
  });

  // The lexer skips >=512-byte block comment bodies with SIMD; these verify
  // large comments end-to-end (legal comment preservation, ASI, output code).
  itBundled("large legal comment is preserved and does not corrupt the code after it", {
    files: {
      "/entry.js":
        "/*!\r\n" +
        " * Legal header line with some padding text to make the comment large enough.\r\n".repeat(20) +
        " * Licensed under the ünïcödé license 🦊\r\n" +
        " */\r\n" +
        'console.log("hello");',
    },
    run: {
      stdout: "hello",
    },
    onAfterBundle(api) {
      const output = api.readFile("/out.js");
      expect(output).toContain("Legal header line with some padding text");
      expect(output).toContain("Licensed under the ünïcödé license 🦊");
    },
  });

  itBundled("newline inside a large block comment triggers ASI", {
    files: {
      "/entry.js": `function f() { return /*${Buffer.alloc(600, "x").toString()}\n${Buffer.alloc(600, "y").toString()}*/ "value" }\nconsole.log(String(f()));`,
    },
    run: {
      stdout: "undefined",
    },
  });

  itBundled("no ASI when a large block comment contains no newline", {
    files: {
      "/entry.js": `function f() { return /*${Buffer.alloc(1200, "x").toString()}*/ "value" }\nconsole.log(String(f()));`,
    },
    run: {
      stdout: "value",
    },
  });
});

describe("legal comments", () => {
  const project = {
    "/project/entry.js": /* js */ `
      /*! (c) the project */
      import "./a";
      import "./b";
      import "pkg-a";
      import "pkg-b";
      import "@scope/pkg-c/lib/c.js";
      console.log("entry");
    `,
    "/project/a.js": /* js */ `
      /*! (c) the project */
      //! only in a
      console.log("a");
    `,
    "/project/b.js": /* js */ `
      /*!
       * b, line 1
       * b, line 2
       */
      function b() {
        //! inside a function of b
        return "b";
      }
      console.log(b());
    `,
    "/project/node_modules/pkg-a/index.js": /* js */ `
      /*! same text in two packages */
      console.log("pkg-a");
    `,
    "/project/node_modules/pkg-b/index.js": /* js */ `
      /*! same text in two packages */
      console.log("pkg-b");
    `,
    "/project/node_modules/@scope/pkg-c/lib/c.js": /* js */ `
      //! a line that has */ in it
      /*!
       * pkg-c, line 1
       */
      console.log("pkg-c");
    `,
  };
  const stdout = "a\nb\npkg-a\npkg-b\npkg-c\nentry";
  const firstParty = [
    "/*! (c) the project */",
    "//! only in a",
    "/*!",
    " * b, line 1",
    " * b, line 2",
    " */",
    "//! inside a function of b",
    "",
  ].join("\n");

  itBundled("eof: each text once, the packages by path", {
    files: project,
    entryPoints: ["/project/entry.js"],
    legalComments: "eof",
    run: { stdout },
    onAfterBundle(api) {
      const output = api.readFile("/out.js");
      const code = output.slice(0, output.indexOf("/*!"));
      expect(code).toEndWith('console.log("entry");\n');
      expect(code).not.toContain("//!");
      expect(output.slice(code.length)).toBe(
        firstParty +
          [
            "/*! Bundled license information:",
            "",
            "pkg-a/index.js:",
            "pkg-b/index.js:",
            "  (*! same text in two packages *)",
            "",
            "@scope/pkg-c/lib/c.js:",
            "  (*! a line that has * / in it *)",
            "  (*!",
            "   * pkg-c, line 1",
            "   *)",
            "*/",
            "",
          ].join("\n"),
      );
    },
  });

  itBundled("eof: the path of a package starts after the last node_modules", {
    files: {
      "/project/entry.js": /* js */ `
        import "outer";
        import "./my_node_modules/first-party";
        console.log("entry");
      `,
      "/project/my_node_modules/first-party.js": /* js */ `
        //! not in node_modules
        console.log("first-party");
      `,
      "/project/node_modules/outer/index.js": /* js */ `
        //! outer
        import "inner";
        console.log("outer");
      `,
      "/project/node_modules/outer/node_modules/inner/lib/index.js": /* js */ `
        //! inner
        console.log("inner");
      `,
      "/project/node_modules/outer/node_modules/inner/package.json": JSON.stringify({
        name: "inner",
        main: "./lib/index.js",
      }),
    },
    entryPoints: ["/project/entry.js"],
    legalComments: "eof",
    run: { stdout: "inner\nouter\nfirst-party\nentry" },
    onAfterBundle(api) {
      expect(api.readFile("/out.js")).toEndWith(
        [
          'console.log("entry");',
          "//! not in node_modules",
          "/*! Bundled license information:",
          "",
          "inner/lib/index.js:",
          "  (*! inner *)",
          "",
          "outer/index.js:",
          "  (*! outer *)",
          "*/",
          "",
        ].join("\n"),
      );
    },
  });

  itBundled("eof: two files with the same path in their package are two files", {
    files: {
      "/project/entry.js": /* js */ `
        import "a";
        import "b";
        import "pkg";
      `,
      "/project/node_modules/a/index.js": `import "pkg";`,
      "/project/node_modules/a/node_modules/pkg/index.js": `/*! pkg 1, MIT */ console.log("pkg 1 of a");`,
      "/project/node_modules/b/index.js": `import "pkg";`,
      "/project/node_modules/b/node_modules/pkg/index.js": `/*! pkg 2, GPL */ console.log("pkg 2 of b");`,
      "/project/node_modules/pkg/index.js": `/*! pkg 1, MIT */ console.log("pkg 1");`,
    },
    entryPoints: ["/project/entry.js"],
    legalComments: "eof",
    run: { stdout: "pkg 1 of a\npkg 2 of b\npkg 1" },
    onAfterBundle(api) {
      expect(api.readFile("/out.js")).toEndWith(
        [
          'console.log("pkg 1");',
          "/*! Bundled license information:",
          "",
          "pkg/index.js:",
          "  (*! pkg 1, MIT *)",
          "",
          "pkg/index.js:",
          "  (*! pkg 2, GPL *)",
          "*/",
          "",
        ].join("\n"),
      );
    },
  });

  itBundled("linked: a file next to the chunk, and a comment that names it", {
    files: project,
    entryPoints: ["/project/entry.js"],
    outdir: "/out",
    backend: "cli",
    legalComments: "linked",
    run: { file: "/out/entry.js", stdout },
    onAfterBundle(api) {
      const code = api.readFile("/out/entry.js");
      expect(code).toEndWith('console.log("entry");\n/*! For license information please see entry.js.LEGAL.txt */\n');
      expect(code.match(/\/\*!|\/\/!/g)).toEqual(["/*!"]);
      expect(api.readFile("/out/entry.js.LEGAL.txt")).toBe(
        firstParty +
          [
            "",
            "Bundled license information:",
            "",
            "pkg-a/index.js:",
            "pkg-b/index.js:",
            "  /*! same text in two packages */",
            "",
            "@scope/pkg-c/lib/c.js:",
            "  //! a line that has */ in it",
            "  /*!",
            "   * pkg-c, line 1",
            "   */",
            "",
          ].join("\n"),
      );
    },
  });

  itBundled("external: the file, and no comment", {
    files: project,
    entryPoints: ["/project/entry.js"],
    outdir: "/out",
    legalComments: "external",
    minifyWhitespace: true,
    run: { file: "/out/entry.js", stdout },
    onAfterBundle(api) {
      const code = api.readFile("/out/entry.js");
      expect(code).not.toContain("/*");
      expect(code).not.toContain("//");
      expect(api.readFile("/out/entry.js.LEGAL.txt")).toStartWith(firstParty + "\nBundled license information:\n");
    },
  });

  itBundled("none: no comment and no file", {
    files: project,
    entryPoints: ["/project/entry.js"],
    outdir: "/out",
    legalComments: "none",
    minifyWhitespace: true,
    run: { file: "/out/entry.js", stdout },
    onAfterBundle(api) {
      const code = api.readFile("/out/entry.js");
      expect(code).not.toContain("/*");
      expect(code).not.toContain("//");
      expect(readdirSync(api.join("/out"))).toEqual(["entry.js"]);
    },
  });

  itBundled("inline is the default", {
    files: project,
    entryPoints: ["/project/entry.js"],
    outdir: "/out",
    run: { file: "/out/entry.js", stdout },
    onAfterBundle(api) {
      const code = api.readFile("/out/entry.js");
      expect(code.match(/\(c\) the project/g)).toHaveLength(2);
      expect(code.match(/same text in two packages/g)).toHaveLength(2);
      expect(code).toContain("  //! inside a function of b\n");
      expect(code).not.toContain("Bundled license information");
      expect(readdirSync(api.join("/out"))).toEqual(["entry.js"]);
    },
  });

  const nested = {
    "/entry.js": [
      "export function f() {",
      "  if (globalThis.x) {",
      "    /*!",
      "     * as deep as the code",
      "       * deeper",
      "     */",
      "    return 1;",
      "  }",
      "\tconsole.log(2); /*! after code",
      "\t\t\t\tfour",
      "\t  three, which is less than the column of the comment */",
      "}",
      '"éééé"; /*! after 8 characters, which are 12 bytes',
      "          ten */",
      "f();",
    ].join("\n"),
  };

  itBundled("inline: the lines of a comment are indented like the code of the output", {
    files: nested,
    onAfterBundle(api) {
      expect(api.readFile("/out.js")).toContain(
        [
          "  if (globalThis.x) {",
          "    /*!",
          "     * as deep as the code",
          "       * deeper",
          "     */",
          "    return 1;",
          "  }",
          "  console.log(2);",
          "  /*! after code",
          "  \tfour",
          "  three, which is less than the column of the comment */",
          "}",
          "/*! after 8 characters, which are 12 bytes",
          "  ten */",
          "f();",
        ].join("\n"),
      );
    },
  });

  itBundled("eof: the lines of a comment lose the indentation of the source", {
    files: nested,
    legalComments: "eof",
    run: { stdout: "2" },
    onAfterBundle(api) {
      expect(api.readFile("/out.js")).toEndWith(
        [
          "};",
          "/*!",
          " * as deep as the code",
          "   * deeper",
          " */",
          "/*! after code",
          "\tfour",
          "three, which is less than the column of the comment */",
          "/*! after 8 characters, which are 12 bytes",
          "  ten */",
          "",
        ].join("\n"),
      );
    },
  });

  itBundled("windows newlines are not in the file", {
    files: {
      "/entry.js": "/*!\r\n * line 1\r\n * line 2\r\n */\r\n//! line\r\nconsole.log(1);\r\n",
      "/entry.css": "/*!\r\n * line 1\r\n * line 2\r\n */\r\n.a { color: red }\r\n",
    },
    entryPoints: ["/entry.js", "/entry.css"],
    outdir: "/out",
    legalComments: "external",
    onAfterBundle(api) {
      expect(readFileSync(api.join("/out/entry.js.LEGAL.txt"), "utf8")).toBe(
        "/*!\n * line 1\n * line 2\n */\n//! line\n",
      );
      expect(readFileSync(api.join("/out/entry.css.LEGAL.txt"), "utf8")).toBe("/*!\n * line 1\n * line 2\n */\n");
    },
  });

  itBundled("eof: after the wrapper of the format, before the footer", {
    files: {
      "/entry.js": /* js */ `
        /*! (c) entry */
        export const value = 1;
        console.log("ran");
      `,
    },
    format: "iife",
    globalName: "Lib",
    banner: "// banner",
    footer: "// footer",
    legalComments: "eof",
    onAfterBundle(api) {
      expect(api.readFile("/out.js")).toEndWith("})();\n/*! (c) entry */\n\n// footer\n");
    },
  });

  itBundled("eof: a bundle for bun runs", {
    files: {
      "/entry.js": /* js */ `
        /*! (c) entry */
        module.exports = 1;
        console.log("ran");
      `,
    },
    target: "bun",
    format: "cjs",
    legalComments: "eof",
    run: { stdout: "ran" },
    onAfterBundle(api) {
      expect(api.readFile("/out.js")).toEndWith("})\n/*! (c) entry */\n");
    },
  });

  itBundled("linked: one file for each chunk that has legal comments", {
    files: {
      "/a.js": /* js */ `
        /*! (c) a */
        import { shared } from "./shared";
        console.log("a", shared);
      `,
      "/b.js": /* js */ `
        import { shared } from "./shared";
        console.log("b", shared);
      `,
      "/shared.js": /* js */ `
        /*! (c) shared */
        export const shared = "shared";
      `,
    },
    entryPoints: ["/a.js", "/b.js"],
    outdir: "/out",
    splitting: true,
    minChunkSize: 0,
    chunkNaming: "shared-[hash].[ext]",
    legalComments: "linked",
    run: [
      { file: "/out/a.js", stdout: "a shared" },
      { file: "/out/b.js", stdout: "b shared" },
    ],
    onAfterBundle(api) {
      const files = readdirSync(api.join("/out")).sort();
      const chunk = files.find(file => file.startsWith("shared-") && file.endsWith(".js"))!;
      expect(files).toEqual(["a.js", "a.js.LEGAL.txt", "b.js", chunk, chunk + ".LEGAL.txt"]);
      expect(api.readFile("/out/a.js.LEGAL.txt")).toBe("/*! (c) a */\n");
      expect(api.readFile(`/out/${chunk}.LEGAL.txt`)).toBe("/*! (c) shared */\n");
      expect(api.readFile("/out/a.js")).toEndWith("/*! For license information please see a.js.LEGAL.txt */\n");
      expect(api.readFile(`/out/${chunk}`)).toEndWith(`/*! For license information please see ${chunk}.LEGAL.txt */\n`);
      expect(api.readFile("/out/b.js")).not.toContain("LEGAL");
    },
  });

  itBundled("linked: the source map comment stays last, and both have the public path", {
    files: {
      "/entry.js": /* js */ `
        /*! (c) entry */
        console.log("ran");
      `,
    },
    outdir: "/out",
    sourceMap: "linked",
    publicPath: "https://cdn.example.com/assets/",
    legalComments: "linked",
    onAfterBundle(api) {
      const code = api.readFile("/out/entry.js");
      expect(code).toEndWith(
        "\n/*! For license information please see https://cdn.example.com/assets/entry.js.LEGAL.txt */\n" +
          "//# sourceMappingURL=https://cdn.example.com/assets/entry.js.map\n",
      );
      expect(code).not.toContain("(c) entry");
      expect(readdirSync(api.join("/out")).sort()).toEqual(["entry.js", "entry.js.LEGAL.txt", "entry.js.map"]);
    },
  });

  itBundled("linked: the public path and the name of the file cannot end the comment", {
    files: {
      "/entry.js": /* js */ `
        /*! (c) entry */
        console.log("ran");
      `,
    },
    outdir: "/out",
    publicPath: "https://cdn.example.com/*",
    entryNaming: "/[name].[ext]",
    legalComments: "linked",
    run: { file: "/out/entry.js", stdout: "ran" },
    onAfterBundle(api) {
      expect(api.readFile("/out/entry.js")).toEndWith(
        "\n/*! For license information please see https://cdn.example.com/* /entry.js.LEGAL.txt */\n",
      );
    },
  });

  for (const legalComments of ["eof", "linked"] as const) {
    itBundled(`${legalComments}: the bytecode is that of the chunk with its last comment`, {
      files: {
        "/entry.js": /* js */ `
          /*! (c) entry */
          console.log("ran");
        `,
      },
      outdir: "/out",
      target: "bun",
      format: "cjs",
      bytecode: true,
      legalComments,
      run: {
        file: "/out/entry.js",
        env: { BUN_JSC_verboseDiskCache: "1" },
        validate({ stdout, stderr }) {
          expect({ stdout, stderr }).toEqual({
            stdout: "ran\n",
            stderr: expect.stringMatching(/^\[Disk Cache\] Cache hit for sourceCode/),
          });
        },
      },
      onAfterBundle(api) {
        expect(api.readFile("/out/entry.js")).toEndWith(
          legalComments === "eof"
            ? "})\n/*! (c) entry */\n"
            : "})\n/*! For license information please see entry.js.LEGAL.txt */\n",
        );
      },
    });
  }

  itBundled("eof: the source map is that of the code without the comment", {
    files: {
      "/entry.js": /* js */ `
        /*!
         * four
         * lines
         */
        console.log("ran");
      `,
    },
    outdir: "/out",
    sourceMap: "external",
    legalComments: "eof",
    onAfterBundle(api) {
      const lines = api.readFile("/out/entry.js").split("\n");
      const generated = lines.findIndex(line => line.includes('console.log("ran")'));
      expect(lines.slice(generated + 1, generated + 5)).toEqual(["/*!", " * four", " * lines", " */"]);
      const map = new SourceMap(JSON.parse(api.readFile("/out/entry.js.map")));
      const original = map.findEntry(generated, 0) as SourceMapping;
      expect(original.originalSource).toEndWith("entry.js");
      expect(original.originalLine).toBe(4);
    },
  });

  itBundled("a comment in code that tree shaking removes goes with it", {
    files: {
      "/entry.js": /* js */ `
        import { used } from "./lib";
        console.log(used());
      `,
      "/lib.js": /* js */ `
        export function used() {
          //! in used
          return "used";
        }
        export function unused() {
          //! in unused
          return "unused";
        }
      `,
    },
    legalComments: "eof",
    run: { stdout: "used" },
    onAfterBundle(api) {
      expect(api.readFile("/out.js")).toEndWith("console.log(used());\n//! in used\n");
    },
  });

  const closingTags = {
    "index.html": `<!doctype html><html><head><link rel="stylesheet" href="./style.css"></head><body><script type="module" src="./app.js"></script></body></html>`,
    "app.js": `//! </script>\nconsole.log("app");\n`,
    "style.css": `/*! </style> */\nbody { color: red }\n`,
  };

  test.each(["inline", "eof"] as const)("%s: a closing tag in a comment is as it was written", async legalComments => {
    using dir = tempDir("legal-comments-closing-tags", closingTags);
    const build = await Bun.build({
      entrypoints: [join(String(dir), "app.js"), join(String(dir), "style.css")],
      legalComments,
    });
    const [js, css] = await Promise.all(build.outputs.map(output => output.text()));
    expect(js).toContain("//! </script>\n");
    expect(css).toContain("/*! </style> */\n");
  });

  test.each(["inline", "eof"] as const)(
    "%s: a closing tag in a comment is escaped in an HTML file",
    async legalComments => {
      using dir = tempDir("legal-comments-standalone-html", closingTags);
      const build = await Bun.build({
        entrypoints: [join(String(dir), "index.html")],
        compile: true,
        target: "browser",
        legalComments,
      });
      expect(build.outputs.map(output => output.loader)).toEqual(["html"]);
      const html = await build.outputs[0].text();
      expect(html).toContain("//! <\\/script>\n");
      expect(html).toContain("/*! <\\/style> */\n");
      expect(html.match(/<\/script>|<\/style>/g)).toEqual(["</style>", "</script>"]);
    },
  );

  const stylesheets = {
    "/project/entry.css": /* css */ `
      /*! (c) the project */
      @import "./a.css";
      @import "pkg/index.css";
      .entry { color: red }
    `,
    "/project/a.css": /* css */ `
      /*! (c) the project */
      /*!
       * only in a
       */
      .a { color: green }
    `,
    "/project/node_modules/pkg/index.css": /* css */ `
      /*! (c) pkg */
      .pkg { color: blue }
    `,
  };

  itBundled("eof: css", {
    files: stylesheets,
    entryPoints: ["/project/entry.css"],
    outdir: "/out",
    legalComments: "eof",
    onAfterBundle(api) {
      const css = api.readFile("/out/entry.css");
      const rules = css.slice(0, css.indexOf("/*!"));
      expect(rules).toEndWith(".entry {\n  color: red;\n}\n");
      expect(css.slice(rules.length)).toBe(
        [
          "/*! (c) the project */",
          "/*!",
          " * only in a",
          " */",
          "/*! Bundled license information:",
          "",
          "pkg/index.css:",
          "  (*! (c) pkg *)",
          "*/",
          "",
        ].join("\n"),
      );
      expect(readdirSync(api.join("/out"))).toEqual(["entry.css"]);
    },
  });

  itBundled("linked: css", {
    files: stylesheets,
    entryPoints: ["/project/entry.css"],
    outdir: "/out",
    legalComments: "linked",
    onAfterBundle(api) {
      const css = api.readFile("/out/entry.css");
      expect(css).toEndWith(
        ".entry {\n  color: red;\n}\n/*! For license information please see entry.css.LEGAL.txt */\n",
      );
      expect(css.match(/\/\*!/g)).toHaveLength(1);
      expect(api.readFile("/out/entry.css.LEGAL.txt")).toBe(
        [
          "/*! (c) the project */",
          "/*!",
          " * only in a",
          " */",
          "",
          "Bundled license information:",
          "",
          "pkg/index.css:",
          "  /*! (c) pkg */",
          "",
        ].join("\n"),
      );
    },
  });

  itBundled("none: css", {
    files: stylesheets,
    entryPoints: ["/project/entry.css"],
    outdir: "/out",
    legalComments: "none",
    onAfterBundle(api) {
      expect(api.readFile("/out/entry.css")).not.toContain("/*!");
      expect(readdirSync(api.join("/out"))).toEqual(["entry.css"]);
    },
  });
});
