import { describe, expect, test } from "bun:test";
import { bunEnv, bunExe, tempDir } from "harness";
import { writeFileSync } from "node:fs";
import path, { dirname, join, resolve } from "node:path";
import { itBundled } from "./expectBundled";

describe("bundler", () => {
  const loadFixture = {
    "index.ts": /* ts */ `
      import { foo } from "./foo.magic";
      console.log(foo);
    `,
    "foo.magic": `
      hello world
    `,
    "another_file.ts": `
      export const foo = "foo";
    `,
  };
  const resolveFixture = {
    "index.ts": /* ts */ `
      import { foo } from "./foo.magic";
      console.log(foo);
    `,
    "foo.ts": /* ts */ `
      export const foo = "foo";
    `,
  };

  itBundled("plugin/Resolve", {
    files: resolveFixture,
    // The bundler testing api has a shorthand where the plugins array can be
    // the `setup` function of one plugin.
    plugins(builder) {
      builder.onResolve({ filter: /\.magic$/ }, args => {
        return {
          path: resolve(dirname(args.importer), args.path.replace(/\.magic$/, ".ts")),
        };
      });
    },
    run: {
      stdout: "foo",
    },
  });
  itBundled("plugin/Load", {
    files: loadFixture,
    plugins(builder) {
      builder.onLoad({ filter: /\.magic$/ }, async args => {
        const text = await Bun.file(args.path).text();
        return {
          contents: `export const foo = ${JSON.stringify(text.toUpperCase())};`,
          loader: "ts",
        };
      });
    },
    run: {
      stdout: "HELLO WORLD",
    },
  });
  itBundled("plugin/LoadImplicitLoader", {
    files: loadFixture,
    plugins(builder) {
      builder.onLoad({ filter: /\.magic$/ }, async args => {
        const text = await Bun.file(args.path).text();
        return {
          contents: `export const foo = ${JSON.stringify(text.toUpperCase())};`,
        };
      });
    },
    run: {
      stdout: "HELLO WORLD",
    },
  });

  itBundled("plugin/LoadXmlLoader", {
    files: {
      "/index.ts": /* ts */ `
        import doc from "./data.magic";
        import feed from "./feed.xml";
        console.log(JSON.stringify([doc, feed]));
      `,
      "/data.magic": `<config env="test"><name>app</name></config>`,
      "/feed.xml": `<feed><entry>1</entry><entry>2</entry></feed>`,
    },
    plugins(builder) {
      builder.onLoad({ filter: /\.magic$/ }, async args => ({
        contents: await Bun.file(args.path).text(),
        loader: "xml",
      }));
      // .xml files report their default loader and can rely on it implicitly.
      builder.onLoad({ filter: /\.xml$/ }, async args => {
        if (args.loader !== "xml") throw new Error("expected args.loader to be xml, got " + args.loader);
        return { contents: await Bun.file(args.path).text() };
      });
    },
    run: {
      stdout: '[{"config":{"@env":"test","name":"app"}},{"feed":{"entry":["1","2"]}}]',
    },
  });
  // A plugin can produce binary modules: typed array or string contents with the bytes loader.
  itBundled("plugin/LoadBytesLoader", {
    files: {
      "/index.ts": /* ts */ `
        import generated from "./table.gen";
        import greeting from "./greeting.gen-text";
        console.log(generated.constructor.name, Array.from(generated).join(","), new TextDecoder().decode(greeting));
      `,
      // Resolved on disk, contents replaced by the plugin.
      "/table.gen": "placeholder",
      "/greeting.gen-text": "placeholder",
    },
    plugins(builder) {
      builder.onLoad({ filter: /\.gen$/ }, () => ({
        contents: new Uint8Array([0, 1, 2, 254, 255]),
        loader: "bytes",
      }));
      builder.onLoad({ filter: /\.gen-text$/ }, () => ({
        contents: "h\u00e9llo",
        loader: "bytes",
      }));
    },
    run: { stdout: "Uint8Array 0,1,2,254,255 h\u00e9llo" },
  });

  // Load Plugin Errors
  itBundled("plugin/LoadThrow", {
    files: loadFixture,
    plugins(builder) {
      builder.onLoad({ filter: /\.magic$/ }, args => {
        throw new Error("error here");
      });
    },
    bundleErrors: {
      "/foo.magic": [`error here`],
    },
  });
  itBundled("plugin/LoadThrowPrimative", {
    files: loadFixture,
    plugins(builder) {
      builder.onLoad({ filter: /\.magic$/ }, args => {
        throw "123";
      });
    },
    bundleErrors: {
      "/foo.magic": [`123`],
    },
  });
  itBundled("plugin/LoadThrowAsync", {
    files: loadFixture,
    plugins(builder) {
      builder.onLoad({ filter: /\.magic$/ }, async args => {
        throw new Error("error here");
      });
    },
    bundleErrors: {
      "/foo.magic": [`error here`],
    },
  });
  itBundled("plugin/LoadThrowPrimativeAsync", {
    files: loadFixture,
    plugins(builder) {
      builder.onLoad({ filter: /\.magic$/ }, async args => {
        throw 123;
      });
    },
    bundleErrors: {
      "/foo.magic": [`123`],
    },
  });
  // A max-length 16-bit rope throws "Out of memory" the first time it's flattened.
  // `external: true` skips the JS-side path checks, which would flatten it first.
  test.concurrent("plugin/fails the build when a returned string can't be flattened", async () => {
    using dir = tempDir("plugin-string-answer-cannot-flatten", {
      "entry.ts": `import { foo } from "./foo.magic"; console.log(foo);`,
      "foo.magic": `hello world`,
      "build.mjs": `
        let huge = "\\u0100";
        for (let i = 0; i < 30; i++) huge = huge + huge + "\\u0100";
        console.log("length=" + (huge.length === 2 ** 31 - 1));

        async function run(name, answer) {
          const { success, logs } = await Bun.build({
            entrypoints: ["./entry.ts"],
            throw: false,
            plugins: [{
              name,
              setup(build) {
                build.onResolve({ filter: /foo\\.magic$/ }, args => {
                  console.log(name + ": resolve returned");
                  return answer.resolve ? answer.resolve(args.path) : undefined;
                });
                build.onLoad({ filter: /\\.magic$/ }, () => {
                  console.log(name + ": load returned");
                  return answer.load ? answer.load() : undefined;
                });
              },
            }],
          });
          const errors = logs.map(l => l.level + " " + JSON.stringify(l.message) + " " + l.position?.file.split(/[\\\\/]/).pop());
          console.log(name + ": success=" + success + " " + errors.join(", "));
        }

        await run("contents", { load: () => ({ contents: huge, loader: "js" }) });
        await run("path", { resolve: () => ({ path: huge, external: true }) });
        await run("namespace", { resolve: path => ({ path, namespace: huge, external: true }) });
        await run("ok", { load: () => ({ contents: "export const foo = 1;", loader: "js" }) });
      `,
    });

    await using proc = Bun.spawn({
      cmd: [bunExe(), "build.mjs"],
      env: bunEnv,
      cwd: String(dir),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);

    expect({ stdout, stderr }).toEqual({
      stdout: [
        "length=true",
        "contents: resolve returned",
        "contents: load returned",
        'contents: success=false error "Out of memory" foo.magic',
        "path: resolve returned",
        'path: success=false error "Out of memory" entry.ts',
        "namespace: resolve returned",
        'namespace: success=false error "Out of memory" entry.ts',
        "ok: resolve returned",
        "ok: load returned",
        "ok: success=true ",
        "",
      ].join("\n"),
      stderr: "",
    });
    expect(exitCode).toBe(0);
  });
  itBundled("plugin/ResolveAndLoadDefaultExport", {
    files: {
      "index.ts": /* ts */ `
      import foo from "./foo.magic";
      console.log(foo);
    `,
      "foo.magic": `
      hello world
    `,
    },
    plugins(builder) {
      builder.onResolve({ filter: /\.magic$/ }, async args => {
        return {
          path: path.resolve(args.importer, args.path),
        };
      });
      builder.onLoad({ filter: /\.magic$/ }, async args => {
        return {
          contents: `export default "foo";`,
          loader: "js",
        };
      });
    },
    run: {
      stdout: "foo",
    },
  });

  for (const value of [null, undefined, true, 1, "string", {} as never]) {
    const str = JSON.stringify(value) ?? "undefined";
    itBundled(`plugin/ResolveEntryPointReturns${str.charAt(0).toUpperCase() + str.slice(1)}`, {
      files: {
        "index.ts": /* ts */ `
          console.log("hello world");
        `,
      },
      plugins(builder) {
        builder.onResolve({ filter: /.*/ }, () => {
          return value as never;
        });
      },
      run: {
        stdout: "hello world",
      },
    });
  }

  // Load Plugin Errors
  itBundled("plugin/ResolveThrow", {
    files: resolveFixture,
    plugins(builder) {
      builder.onResolve({ filter: /\.magic$/ }, args => {
        throw new Error("error here");
      });
    },
    bundleErrors: {
      "/index.ts": [`error here`],
    },
  });
  itBundled("plugin/ResolveThrowPrimative", {
    files: resolveFixture,
    plugins(builder) {
      builder.onResolve({ filter: /\.magic$/ }, args => {
        throw "123";
      });
    },
    bundleErrors: {
      "/index.ts": [`123`],
    },
  });
  itBundled("plugin/ResolveThrowAsync", {
    files: resolveFixture,
    plugins(builder) {
      builder.onResolve({ filter: /\.magic$/ }, async args => {
        throw new Error("error here");
      });
    },
    bundleErrors: {
      "/index.ts": [`error here`],
    },
  });
  itBundled("plugin/ResolveThrowPrimativeAsync", {
    files: resolveFixture,
    plugins(builder) {
      builder.onResolve({ filter: /\.magic$/ }, async args => {
        throw 123;
      });
    },
    bundleErrors: {
      "/index.ts": [`123`],
    },
  });

  //
  itBundled("plugin/ResolvePrefix", ({ root }) => {
    let onResolveCount = 0;

    return {
      files: {
        "index.ts": /* ts */ `
        import * as foo from "magic:some_string";
        import * as bar from "./other_file.ts";
        console.log(foo.foo, bar.bar);
      `,
        "foo.ts": /* ts */ `
        export const foo = "foo";
      `,
        "other_file.ts": /* ts */ `
        export const bar = "bar";
      `,
      },
      plugins(builder) {
        builder.onResolve({ filter: /.*/, namespace: "magic" }, args => {
          throw new Error("should not be called. magic: does not make this a namespace");
        });
        builder.onResolve({ filter: /^magic:.*/ }, args => {
          expect(args.path).toBe("magic:some_string");
          expect(args.importer).toBe(path.join(root, "index.ts"));
          expect(args.namespace).toBe("file");
          expect(args.kind).toBe("import-statement");
          onResolveCount++;

          return {
            path: path.resolve(path.dirname(args.importer), "foo.ts"),
          };
        });
      },
      run: {
        stdout: "foo bar",
      },
      onAfterBundle(api) {
        expect(onResolveCount).toBe(1);
      },
    };
  });
  itBundled("plugin/ResolveNamespaceFilterIgnored", ({ root }) => {
    let onResolveCountBad = 0;

    return {
      files: {
        "index.ts": /* ts */ `
          import * as foo from "magic:some_string";
          import * as bar from "./other_file.ts";
          console.log(foo.foo, bar.bar);
        `,
        "foo.ts": /* ts */ `
          export const foo = "foo";
        `,
        "other_file.ts": /* ts */ `
          export const bar = "bar";
        `,
      },
      plugins(builder) {
        // this was being called when it shouldnt
        builder.onResolve({ filter: /.*/, namespace: "magic" }, () => {
          onResolveCountBad++;
          return null as never;
        });
        builder.onResolve({ filter: /magic:some_string/, namespace: "magic" }, () => {
          onResolveCountBad++;
          return null as never;
        });
        builder.onResolve({ filter: /magic:some_string/ }, args => {
          return {
            path: path.resolve(path.dirname(args.importer), "foo.ts"),
          };
        });
      },
      run: {
        stdout: "foo bar",
      },
      onAfterBundle(api) {
        try {
          expect(onResolveCountBad).toBe(0);
        } catch (error) {
          console.error(
            "resolve plugins with namespace constraint should not be called when the namespace is not matched, even if prefix like `magic:`",
          );
          throw error;
        }
      },
    };
  });
  itBundled("plugin/ResolveAndLoadNamespace", ({ root }) => {
    return {
      files: {
        "index.ts": /* ts */ `
          import * as foo from "magic:some_string";
          console.log(foo.foo);
        `,
      },
      plugins(builder) {
        builder.onResolve({ filter: /magic:some_string/ }, args => {
          return {
            path: "namespace_path",
            namespace: "my_namespace",
          };
        });
        // the path given is already resolved, so it should not re-resolve
        builder.onResolve({ filter: /namespace_path/, namespace: "my_namespace" }, args => {
          throw new Error("SHOULD NOT BE CALLED");
        });
        builder.onResolve({ filter: /namespace_path/ }, args => {
          throw new Error("SHOULD NOT BE CALLED");
        });
        builder.onLoad({ filter: /namespace_path/, namespace: "my_namespace" }, args => {
          expect(args.path).toBe("namespace_path");
          expect(args.namespace).toBe("my_namespace");

          return {
            contents: "export const foo = 'foo';",
            loader: "js",
          };
        });
        builder.onLoad({ filter: /.*/, namespace: "my_namespace" }, args => {
          throw new Error("SHOULD NOT BE CALLED");
        });
      },
      run: {
        stdout: "foo",
      },
    };
  });
  itBundled("plugin/ResolveAndLoadNamespaceNested", ({ root }) => {
    let counter1 = 0;
    let counter2 = 0;
    return {
      todo: true,
      files: {
        "index.ts": /* ts */ `
          import * as foo from "magic:some_string";
          console.log(foo.foo);
        `,
        "foo.ts": /* ts */ `
          export const foo = "foo";
        `,
      },
      plugins(builder) {
        builder.onResolve({ filter: /.*/ }, args => {
          counter1++;
        });
        builder.onResolve({ filter: /magic:some_string/ }, args => {
          return {
            path: "namespace_path",
            namespace: "my_namespace",
          };
        });
        // the path given is already resolved, so it should not re-resolve
        builder.onResolve({ filter: /namespace_path/, namespace: "my_namespace" }, args => {
          throw new Error("SHOULD NOT BE CALLED 1, " + JSON.stringify(args));
        });
        builder.onResolve({ filter: /namespace_path/ }, args => {
          throw new Error("SHOULD NOT BE CALLED 2, " + JSON.stringify(args));
        });
        // load
        builder.onLoad({ filter: /.*/, namespace: "my_namespace" }, args => {
          expect(args.path).toBe("namespace_path");
          expect(args.namespace).toBe("my_namespace");

          return {
            contents: "import 'nested_import';export const foo = 'foo';",
            loader: "js",
          };
        });
        // nested_import should not be resolved as a file namespace
        builder.onResolve({ filter: /nested_import/, namespace: "file" }, args => {
          throw new Error("SHOULD NOT BE CALLED 3, " + JSON.stringify(args));
        });
        builder.onResolve({ filter: /nested_import/, namespace: "my_namespace" }, args => {
          expect(args.path).toBe("nested_import");
          expect(args.namespace).toBe("my_namespace");
          // gonna let this passthrough
          counter2 += 1;
        });
        // but it can be resolved with no namespace filter
        builder.onResolve({ filter: /nested_import/ }, args => {
          expect(args.path).toBe("nested_import");
          expect(args.namespace).toBe("my_namespace");
          return {
            path: root + "/foo.ts",
            namespace: "file",
          };
        });
        builder.onResolve({ filter: /.*/ }, args => {
          // entrypoint should hit this but this is a catch all
          if (args.kind === "import-statement") {
            throw new Error("SHOULD NOT BE CALLED 4, " + JSON.stringify(args));
          }
        });
      },
      run: {
        stdout: "foo",
      },
      onAfterBundle(api) {
        expect(counter1).toBe(3);
        expect(counter2).toBe(1);
      },
    };
  });
  // Like esbuild, an external import is printed with the path that onResolve returned.
  itBundled("plugin/ResolveExternalRewritesPath", {
    files: {
      "index.ts": /* ts */ `
        import React from "react";
        import { createRoot } from "react-dom/client";
        export { h } from "preact";
        export * from "mobx";
        console.log(React, createRoot, await import("lodash"));
      `,
    },
    plugins(builder) {
      builder.onResolve({ filter: /^(react|react-dom\/client|preact|mobx|lodash)$/ }, args => {
        return { path: "https://esm.sh/" + args.path, external: true };
      });
    },
    onAfterBundle(api) {
      const contents = api.readFile("/out.js");
      expect(contents).toContain(`from "https://esm.sh/react"`);
      expect(contents).toContain(`from "https://esm.sh/react-dom/client"`);
      expect(contents).toContain(`from "https://esm.sh/preact"`);
      expect(contents).toContain(`from "https://esm.sh/mobx"`);
      expect(contents).toContain(`import("https://esm.sh/lodash")`);
      for (const original of ["react", "react-dom/client", "preact", "mobx", "lodash"]) {
        expect(contents).not.toContain(`"${original}"`);
      }
    },
  });
  itBundled("plugin/ResolveExternalRewritesPathRequire", {
    files: {
      "index.ts": /* ts */ `
        const React = require("react");
        console.log(React);
      `,
    },
    format: "cjs",
    plugins(builder) {
      builder.onResolve({ filter: /^react$/ }, () => {
        return { path: "./vendor/react.cjs", external: true };
      });
    },
    onAfterBundle(api) {
      const contents = api.readFile("/out.js");
      expect(contents).toContain(`require("./vendor/react.cjs")`);
      expect(contents).not.toContain(`require("react")`);
    },
  });
  for (const format of ["esm", "cjs"] as const) {
    itBundled(`plugin/ResolveExternalRewritesRelativeImport_${format}`, {
      files: {
        "/a.js": /* js */ `
          import { v } from "./b.js";
          console.log(v);
        `,
        "/b.js": `export const v = "bundled";`,
      },
      target: "bun",
      format,
      plugins(builder) {
        builder.onResolve({ filter: /b\.js$/ }, () => {
          return { path: "/somewhere/else/b.js", external: true };
        });
      },
      onAfterBundle(api) {
        const contents = api.readFile("/out.js");
        expect(contents).toContain(
          format === "esm" ? `import { v } from "/somewhere/else/b.js";` : `require("/somewhere/else/b.js")`,
        );
        expect(contents).not.toContain(`"./b.js"`);
        expect(contents).not.toContain(`"bundled"`);
      },
    });
  }
  // rewriteExternalWithNamespace and rewriteExternalWithoutNamespace in
  // https://github.com/evanw/esbuild/blob/f6058f8364fe7ab91ca57a83e02577ed74c9cae4/scripts/plugin-tests.js#L680-L728
  for (const namespace of ["for-testing", undefined]) {
    itBundled(`plugin/RewriteExternal${namespace ? "WithNamespace" : "WithoutNamespace"}`, {
      files: {
        "/in.js": /* js */ `
          import { exists } from "extern";
          export default exists;
        `,
        "/check.js": /* js */ `
          const fs = require("fs");
          console.log(require("./out.js").default === fs.exists);
        `,
      },
      format: "cjs",
      plugins(builder) {
        builder.onResolve({ filter: /^extern$/ }, () => {
          return { path: "fs", external: true, namespace };
        });
      },
      run: {
        file: "/check.js",
        stdout: "true",
      },
    });
  }
  itBundled("plugin/ResolveOverrideFile", ({ root }) => {
    return {
      files: {
        "index.ts": /* ts */ `
          import * as foo from "./foo.ts";
          console.log(foo.foo);
        `,
        "foo.ts": /* ts */ `
          export const foo = "FAILED";
        `,
        "bar.ts": /* ts */ `
          export const foo = "foo";
        `,
      },
      plugins(builder) {
        builder.onResolve({ filter: /foo.ts$/ }, args => {
          return {
            path: root + "/bar.ts",
          };
        });
      },
      run: {
        stdout: "foo",
      },
    };
  });
  itBundled("plugin/ResolveOnceWhenSameFile", ({ root }) => {
    let onResolveCount = 0;
    return {
      todo: true,
      files: {
        "index.ts": /* ts */ `
          import * as foo from "./foo.ts";
          import * as foo2 from "./foo.ts";
          console.log(foo.foo, foo2.foo);
        `,
        "foo.ts": /* ts */ `
          export const foo = "FAILED";
        `,
        "bar.ts": /* ts */ `
          export const foo = "this string should exist once";
        `,
      },
      plugins(builder) {
        builder.onResolve({ filter: /foo.ts$/ }, args => {
          onResolveCount++;
          return {
            path: root + "/bar.ts",
          };
        });
      },
      run: {
        stdout: "this string should exist once this string should exist once",
      },
      onAfterBundle(api) {
        expect(onResolveCount).toBe(1);
        const contents = api.readFile("/out.js");
        expect([...contents.matchAll(/this string should exist once/g)].length).toBe(1);
      },
    };
  });
  itBundled("plugin/ResolveTwoImportsSeparateFiles", ({ root }) => {
    let onResolveCount = 0;
    let importers: string[] = [];
    return {
      files: {
        "index.ts": /* ts */ `
          import * as foo from "./one.ts";
          import * as bar from "./two.ts";
          console.log(foo.foo, bar.bar);
        `,
        "one.ts": /* ts */ `
          import * as imported from "./foo.ts";
          export const foo = imported.foo;
        `,
        "two.ts": /* ts */ `
          import * as imported from "./foo.ts";
          export const bar = imported.foo;
        `,
        "bar.ts": /* ts */ `
          export const foo = "this string should exist once";
        `,
      },
      plugins(builder) {
        builder.onResolve({ filter: /foo.ts$/ }, args => {
          importers.push(args.importer);
          onResolveCount++;
          return {
            path: root + "/bar.ts",
          };
        });
      },
      run: {
        stdout: "this string should exist once this string should exist once",
      },
      onAfterBundle(api) {
        expect(importers.sort()).toEqual([path.join(root, "one.ts"), path.join(root, "two.ts")].sort());
        expect(onResolveCount).toBe(2);
        const contents = api.readFile("/out.js");
        expect([...contents.matchAll(/this string should exist once/g)].length).toBe(1);
      },
    };
  });
  itBundled("plugin/ManyFiles", ({ root }) => {
    const FILES = process.platform === "win32" ? 50 : 200; // windows is slower at this
    const create = (fn: (i: number) => string) => new Array(FILES).fill(0).map((_, i) => fn(i));

    let onResolveCount = 0;
    let importers: string[] = [];
    return {
      files: {
        "index.ts": /* ts */ `
          ${create(i => `import * as foo${i} from "./${i}.magic";`).join("\n")}
          ${create(i => `console.log(foo${i}.foo);`).join("\n")}
        `,
      },
      plugins(builder) {
        builder.onResolve({ filter: /\.magic$/ }, async args => {
          importers.push(args.importer);
          onResolveCount++;
          return {
            path: args.path,
            namespace: "magic",
          };
        });
        builder.onLoad({ filter: /\.magic$/, namespace: "magic" }, async args => {
          return {
            contents: `export const foo = "${args.path}";`,
            loader: "js",
          };
        });
      },
      run: {
        stdout: create(i => `./${i}.magic`).join("\n"),
      },
      onAfterBundle(api) {},
    };
  });
  itBundled("plugin/TwoPluginBug", ({ root }) => {
    return {
      files: {
        "index.ts": /* ts */ `
          import { foo } from "plugin1";
          console.log(foo);
        `,
      },
      plugins: [
        {
          name: "1",
          setup(builder) {
            builder.onResolve({ filter: /plugin1/ }, args => {
              return {
                path: "plugin1",
                namespace: "plugin1",
              };
            });
            builder.onLoad({ filter: /plugin1/, namespace: "plugin1" }, args => {
              return {
                contents: "export * from 'plugin2';",
                loader: "js",
              };
            });
          },
        },
        {
          name: "2",
          setup(builder) {
            builder.onResolve({ filter: /plugin2/ }, args => {
              return {
                path: "plugin2",
                namespace: "plugin2",
              };
            });
            builder.onLoad({ filter: /plugin2/, namespace: "plugin2" }, args => {
              return {
                contents: "export const foo = 'foo';",
                loader: "js",
              };
            });
          },
        },
      ],
      run: {
        stdout: "foo",
      },
    };
  });
  itBundled("plugin/LoadCalledOnce", ({ root }) => {
    let resolveCount = 0;
    let loadCount = 0;
    return {
      files: {
        "index.ts": /* ts */ `
          import { foo } from "plugin:first";
          import { foo as foo2 } from "plugin:second";
          import { foo as foo3 } from "plugin:third";
          console.log(foo === foo2, foo === foo3);
        `,
      },
      plugins: [
        {
          name: "1",
          setup(builder) {
            builder.onResolve({ filter: /^plugin:/ }, args => {
              resolveCount++;
              return {
                path: "plugin",
                namespace: "plugin",
              };
            });
            builder.onLoad({ filter: /^plugin$/, namespace: "plugin" }, args => {
              loadCount++;
              return {
                contents: "export const foo = { };",
                loader: "js",
              };
            });
          },
        },
      ],
      run: {
        stdout: "true true",
      },
      onAfterBundle(api) {
        expect(resolveCount).toBe(3);
        expect(loadCount).toBe(1);
      },
    };
  });
  itBundled("plugin/ResolveManySegfault", ({ root }) => {
    let resolveCount = 0;
    let loadCount = 0;
    return {
      files: {
        "index.ts": /* ts */ `
          import { foo as foo1 } from "plugin:100";
          console.log(foo1);
        `,
      },
      plugins: [
        {
          name: "1",
          setup(builder) {
            builder.onResolve({ filter: /^plugin:/ }, args => {
              resolveCount++;
              return {
                path: args.path,
                namespace: "plugin",
              };
            });
            builder.onLoad({ filter: /^plugin:/, namespace: "plugin" }, args => {
              loadCount++;
              const number = parseInt(args.path.replace("plugin:", ""));
              if (number > 1) {
                const numberOfImports = number > 100 ? 100 : number;
                const imports = Array.from({ length: numberOfImports })
                  .map((_, i) => `import { foo as foo${i} } from "plugin:${number - i - 1}";`)
                  .join("\n");
                const exports = `export const foo = ${Array.from({ length: numberOfImports })
                  .map((_, i) => `foo${i}`)
                  .join(" + ")};`;
                return {
                  contents: `${imports}\n${exports}`,
                  loader: "js",
                };
              } else {
                return {
                  contents: `export const foo = 1;`,
                  loader: "js",
                };
              }
            });
          },
        },
      ],
      run: true,
      onAfterBundle(api) {
        expect(resolveCount).toBe(5050);
        expect(loadCount).toBe(101);
      },
      timeoutScale: 3,
    };
  });
  // itBundled("plugin/ManyPlugins", ({ root }) => {
  //   const pluginCount = 4000;
  //   let resolveCount = 0;
  //   let loadCount = 0;
  //   return {
  //     files: {
  //       "index.ts": /* ts */ `
  //         import { foo as foo1 } from "plugin1:file";
  //         import { foo as foo2 } from "plugin4000:file";
  //         console.log(foo1, foo2);
  //       `,
  //     },
  //     plugins: Array.from({ length: pluginCount }).map((_, i) => ({
  //       name: `${i}`,
  //       setup(builder) {
  //         builder.onResolve({ filter: new RegExp(`^plugin${i}:file$`) }, args => {
  //           resolveCount++;
  //           return {
  //             path: `plugin${i}:file`,
  //             namespace: `plugin${i}`,
  //           };
  //         });
  //         builder.onLoad({ filter: new RegExp(`^plugin${i}:file$`), namespace: `plugin${i}` }, args => {
  //           loadCount++;
  //           return {
  //             contents: `export const foo = ${i};`,
  //             loader: "js",
  //           };
  //         });
  //       },
  //     })),
  //     run: {
  //       stdout: `${pluginCount - 1} ${pluginCount - 1}`,
  //     },
  //     onAfterBundle(api) {
  //       expect(resolveCount).toBe(pluginCount * 2);
  //       expect(loadCount).toBe(pluginCount);
  //     },
  //   };
  // });
  itBundled("plugin/NamespaceOnLoadBug", () => {
    return {
      files: {
        "index.ts": /* ts */ `
          import { foo } from "plugin:file";
          console.log(foo);
        `,
      },
      plugins(build) {
        build.onResolve({ filter: /^plugin:/ }, args => {
          return {
            path: args.path,
            namespace: "this",
          };
        });
        build.onLoad({ filter: /.*/, namespace: "that" }, args => {
          return {
            contents: "export const foo = 'FAILED';",
            loader: "js",
          };
        });
        build.onLoad({ filter: /.*/, namespace: "this" }, args => {
          return {
            contents: `export const foo = '${args.namespace}';`,
            loader: "js",
          };
        });
      },
    };
  });
  itBundled("plugin/EntrypointResolve", ({ root }) => {
    return {
      todo: true,
      files: {},
      entryPointsRaw: ["plugin"],
      plugins(build) {
        build.onResolve({ filter: /^plugin$/ }, args => {
          expect(args.path).toBe("plugin");
          expect(args.importer).toBe("");
          expect(args.kind).toBe("entry-point-build");
          expect(args.namespace).toBe("");
          // expect(args.pluginData).toEqual(undefined);
          // expect(args.resolveDir).toEqual(root);
          return {
            path: args.path,
            namespace: "plugin",
          };
        });
        build.onLoad({ filter: /.*/, namespace: "plugin" }, args => {
          console.log(args);
          return {
            contents: `console.log("it works")`,
          };
        });
      },
      run: {
        file: "./out/plugin.js",
        stdout: "it works",
      },
    };
  });
  itBundled("plugin/Options", ({ getConfigRef }) => {
    return {
      files: {
        "index.ts": /* ts */ `
          console.log("it works");
        `,
      },
      entryPoints: ["./index.ts"],
      plugins(build) {
        expect(build.config).toBe(getConfigRef() as typeof build.config);
      },
    };
  });
  itBundled("plugin/ESBuildInitialOptions", ({ root }) => {
    return {
      files: {
        "index.ts": /* ts */ `
          console.log("it works");
        `,
      },
      external: ["esbuild"],
      entryPoints: ["./index.ts"],
      backend: "api",
      plugins(build) {
        const opts = (build as any).initialOptions;
        expect(opts.bundle).toEqual(true);
        expect(opts.entryPoints).toEqual([join(root, "index.ts")]);
        expect(opts.external).toEqual(["esbuild"]);
        expect(opts.format).toEqual("esm");
        expect(opts.minify).toEqual(false);
        expect(opts.minifyIdentifiers).toEqual(undefined);
        expect(opts.minifySyntax).toEqual(undefined);
        expect(opts.minifyWhitespace).toEqual(undefined);
        expect(opts.outdir).toEqual(root);
        expect(opts.platform).toEqual("browser");
        expect(opts.sourcemap).toEqual(undefined);
      },
    };
  });

  itBundled("plugin/FileLoaderWithCustomContents", {
    files: {
      "index.html": /* html */ `
        <!DOCTYPE html>
        <html>
          <head>
            <title>Test</title>
          </head>
          <body>
            <img src="./image.jpeg" />
            <script src="./script.js"></script>
          </body>
        </html>
      `,
      "script.js": /* js */ `
        console.log("Script loaded");
      `,
      "image.jpeg": "actual image data would be here",
    },
    entryPoints: ["./index.html"],
    outdir: "/out",
    plugins(build) {
      // This plugin intercepts .jpeg files and returns them with custom contents
      // This previously caused a crash because additional_files wasn't populated
      build.onLoad({ filter: /\.jpe?g$/ }, async args => {
        return {
          loader: "file",
          contents: "custom image contents",
        };
      });
    },
    onAfterBundle(api) {
      // Verify the build succeeded and files were created
      api.assertFileExists("index.html");
      // The image should be copied with a hashed name
      const html = api.readFile("index.html");
      expect(html).toContain('src="');
      expect(html).toContain('.jpeg"');
    },
  });

  itBundled("plugin/FileLoaderMultipleAssets", {
    files: {
      "index.js": /* js */ `
        import imgUrl from "./image.png";
        import wasmUrl from "./module.wasm";
        console.log(imgUrl, wasmUrl);
      `,
      "image.png": "png data",
      "module.wasm": "wasm data",
    },
    entryPoints: ["./index.js"],
    outdir: "/out",
    plugins(build) {
      // Test multiple file types with custom contents
      build.onLoad({ filter: /\.(png|wasm)$/ }, async args => {
        const ext = args.path.split(".").pop();
        return {
          loader: "file",
          contents: `custom ${ext} contents`,
        };
      });
    },
    run: {
      stdout: /\.(png|wasm)/,
    },
    onAfterBundle(api) {
      // Verify the build succeeded and files were created
      api.assertFileExists("index.js");
      const js = api.readFile("index.js");
      // Should contain references to the copied files
      expect(js).toContain('.png"');
      expect(js).toContain('.wasm"');
    },
  });

  test.concurrent("plugin/onLoad that returns nothing for an asset leaves it to the file loader", async () => {
    using dir = tempDir("plugin-onload-declines-asset", {
      "index.ts": `
        import logo from "./logo.png";
        console.log(logo);
      `,
      "logo.png": "png bytes",
      "build.mjs": `
        import { basename } from "node:path";
        const result = await Bun.build({
          entrypoints: ["./index.ts"],
          outdir: "./out",
          naming: { asset: "[name].[ext]" },
          plugins: [
            {
              name: "yaml-only",
              setup(build) {
                build.onLoad({ filter: /.*/ }, args =>
                  args.path.endsWith(".yaml") ? { contents: "export default 1", loader: "js" } : undefined,
                );
              },
            },
          ],
        });
        console.log(result.outputs.map(output => output.kind + " " + basename(output.path)).sort().join("\\n"));
        console.log(await Bun.file("./out/logo.png").text());
      `,
    });

    await using proc = Bun.spawn({
      cmd: [bunExe(), "build.mjs"],
      env: bunEnv,
      cwd: String(dir),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);

    expect(stderr).toBe("");
    expect(stdout).toBe("asset logo.png\nentry-point index.js\npng bytes\n");
    expect(exitCode).toBe(0);
  });

  itBundled("plugin/OnEndBasic", ({ root }) => {
    let onEndCalled = false;

    return {
      files: {
        "index.ts": `
          console.log("Hello from main");
        `,
      },
      outdir: "/out",
      plugins(builder) {
        builder.onEnd(() => {
          onEndCalled = true;
        });
      },
      onAfterBundle(api) {
        expect(onEndCalled).toBe(true);
        expect(api.readFile("out/index.js")).toContain("Hello from main");
      },
    };
  });

  itBundled("plugin/OnEndMultipleCallbacks", ({ root }) => {
    const callOrder: string[] = [];

    return {
      files: {
        "index.ts": /* ts */ `
          export const value = 42;
        `,
      },
      outdir: "/out",
      plugins(builder) {
        builder.onEnd(() => {
          callOrder.push("first");
        });

        builder.onEnd(() => {
          callOrder.push("second");
        });

        builder.onEnd(() => {
          callOrder.push("third");
        });
      },
      onAfterBundle(api) {
        expect(callOrder).toEqual(["first", "second", "third"]);
        expect(api.readFile("out/index.js")).toContain("42");
      },
    };
  });

  itBundled("plugin/OnEndWithAsyncCallback", ({ root }) => {
    let asyncCompleted = false;

    return {
      files: {
        "index.ts": /* ts */ `
          export default "async test";
        `,
      },
      outdir: "/out",
      plugins(builder) {
        builder.onEnd(async () => {
          await new Promise(resolve => setTimeout(resolve, 10));
          asyncCompleted = true;
        });
      },
      onAfterBundle(api) {
        expect(asyncCompleted).toBe(true);
        expect(api.readFile("out/index.js")).toContain("async test");
      },
    };
  });

  itBundled("plugin/OnEndWithMultiplePlugins", ({ root }) => {
    const events: string[] = [];

    return {
      files: {
        "index.ts": /* ts */ `
          import "./module.js";
          console.log("main");
        `,
        "module.js": /* js */ `
          console.log("module");
        `,
      },
      outdir: "/out",
      plugins: [
        {
          name: "plugin1",
          setup(builder) {
            builder.onEnd(() => {
              events.push("plugin1-end");
            });
          },
        },
        {
          name: "plugin2",
          setup(builder) {
            builder.onEnd(() => {
              events.push("plugin2-end");
            });
          },
        },
      ],
      onAfterBundle(api) {
        expect(events).toContain("plugin1-end");
        expect(events).toContain("plugin2-end");
        expect(api.readFile("out/index.js")).toContain("main");
        expect(api.readFile("out/index.js")).toContain("module");
      },
    };
  });

  itBundled("plugin/OnEndWithBuildResult", () => {
    let buildResult: Bun.BuildOutput | null = null;
    let callbackExecuted = false;

    return {
      files: {
        "index.ts": /* ts */ `
          export const result = "success";
        `,
      },
      outdir: "/out",
      plugins(builder) {
        builder.onEnd(result => {
          callbackExecuted = true;
          buildResult = result;
        });
      },
      onAfterBundle(api) {
        expect(callbackExecuted).toBe(true);
        expect(buildResult).toBeDefined();
        expect(buildResult!.outputs).toBeDefined();
        expect(Array.isArray(buildResult!.outputs)).toBe(true);
        expect(api.readFile("out/index.js")).toContain("success");
      },
    };
  });

  itBundled("plugin/OnEndWithFileWrite", ({ root }) => {
    let fileWritten = false;

    return {
      files: {
        "index.ts": /* ts */ `
          export const data = { version: "1.0.0" };
        `,
      },
      outdir: "/out",
      plugins(builder) {
        builder.onEnd(async () => {
          const metadata = {
            buildTime: new Date().toISOString(),
            files: ["index.js"],
          };
          await Bun.write(join(root, "out", "build-metadata.json"), JSON.stringify(metadata, null, 2));
          fileWritten = true;
        });
      },
      onAfterBundle(api) {
        expect(fileWritten).toBe(true);
        expect(api.readFile("out/index.js")).toContain("1.0.0");
        // Check if metadata file was created
        api.assertFileExists("out/build-metadata.json");
        const metadata = JSON.parse(api.readFile("out/build-metadata.json"));
        expect(metadata.files).toEqual(["index.js"]);
        expect(metadata.buildTime).toBeDefined();
      },
    };
  });

  itBundled("plugin/OnEndWithThrowOnErrorTrue", ({ root }) => {
    let onEndCalled = false;
    let onEndCalledBeforePromiseResolved = false;

    return {
      files: {
        "index.ts": `
          // This will cause a build error
          import { nonExistent } from "./does-not-exist";
          console.log(nonExistent);
        `,
      },
      outdir: "/out",
      throw: true,
      bundleErrors: {
        "/index.ts": [`Could not resolve: "./does-not-exist"`],
      },
      plugins(builder) {
        builder.onEnd(result => {
          onEndCalled = true;
          expect(result.success).toBe(false);
          expect(result.logs).toBeDefined();
          expect(result.logs.length).toBeGreaterThan(0);
        });
      },
      onAfterBundle() {
        expect(onEndCalled).toBe(true);
        expect(onEndCalledBeforePromiseResolved).toBe(true);
      },
    };
  });

  itBundled("plugin/OnEndWithThrowOnErrorFalse", ({ root }) => {
    let onEndCalled = false;
    let onEndCalledBeforePromiseResolved = false;
    let promiseResolved = false;

    return {
      files: {
        "index.ts": `
          // This will cause a build error
          import { nonExistent } from "./does-not-exist";
          console.log(nonExistent);
        `,
      },
      outdir: "/out",
      throw: false,
      bundleErrors: {
        "/index.ts": [`Could not resolve: "./does-not-exist"`],
      },
      plugins(builder) {
        builder.onEnd(result => {
          onEndCalled = true;
          // Check that promise hasn't resolved yet
          onEndCalledBeforePromiseResolved = !promiseResolved;
          // Result should contain errors
          expect(result.success).toBe(false);
          expect(result.logs).toBeDefined();
          expect(result.logs.length).toBeGreaterThan(0);
        });
      },
      onAfterBundle(api) {
        promiseResolved = true;
        // Verify onEnd was called before the promise resolved
        expect(onEndCalled).toBe(true);
        expect(onEndCalledBeforePromiseResolved).toBe(true);
      },
    };
  });

  itBundled("plugin/OnEndAlwaysFiresOnSuccess", ({ root }) => {
    let onEndCalled = false;
    let onEndCalledBeforePromiseResolved = false;
    let promiseResolved = false;

    return {
      files: {
        "index.ts": `
          export const success = true;
          console.log("Build successful");
        `,
      },
      outdir: "/out",
      throw: true, // Doesn't matter since build will succeed
      plugins(builder) {
        builder.onEnd(result => {
          onEndCalled = true;
          // Check that promise hasn't resolved yet
          onEndCalledBeforePromiseResolved = !promiseResolved;
          // Result should indicate success
          expect(result.success).toBe(true);
          expect(result.outputs).toBeDefined();
          expect(result.outputs.length).toBeGreaterThan(0);
        });
      },
      onAfterBundle(api) {
        promiseResolved = true;
        // Verify onEnd was called before the promise resolved
        expect(onEndCalled).toBe(true);
        expect(onEndCalledBeforePromiseResolved).toBe(true);
        expect(api.readFile("out/index.js")).toContain("Build successful");
      },
    };
  });

  itBundled("plugin/OnEndMultipleCallbacksWithError", ({ root }) => {
    const callOrder: string[] = [];
    let promiseResolved = false;

    return {
      files: {
        "index.ts": `
          // This will cause a build error
          import { missing } from "./missing-module";
        `,
      },
      outdir: "/out",
      throw: false, // Let the build continue so we can check callbacks
      plugins(builder) {
        builder.onEnd(() => {
          callOrder.push("first");
          expect(promiseResolved).toBe(false);
        });
        builder.onEnd(() => {
          callOrder.push("second");
          expect(promiseResolved).toBe(false);
        });
        builder.onEnd(() => {
          callOrder.push("third");
          expect(promiseResolved).toBe(false);
        });
      },
      onAfterBundle(api) {
        promiseResolved = true;
        expect(callOrder).toEqual(["first", "second", "third"]);
      },
    };
  });

  itBundled("plugin/OnEndBuildFailsThrowsSync", () => {
    let onEndCalled = false;
    let onEndError: Error | null = null;

    return {
      files: {
        "index.ts": `
          import { missing } from "./does-not-exist.ts";
          console.log(missing);
        `,
      },
      outdir: "/out",
      plugins(builder) {
        builder.onEnd(() => {
          onEndCalled = true;
          onEndError = new Error("onEnd was called after build failure");
        });
      },
      bundleErrors: {
        "/index.ts": [`Could not resolve: "./does-not-exist.ts"`],
      },
      onAfterBundle(api) {
        expect(onEndCalled).toBe(true);
        expect(onEndError).toBeTruthy();
      },
    };
  });

  itBundled("plugin/OnEndBuildFailsThrowsAsyncMicrotask", () => {
    let onEndCalled = false;
    let asyncCompleted = false;

    return {
      files: {
        "index.ts": `
          import { missing } from "./does-not-exist.ts";
          console.log(missing);
        `,
      },
      outdir: "/out",
      plugins(builder) {
        builder.onEnd(async () => {
          onEndCalled = true;
          await Promise.resolve();
          asyncCompleted = true;
        });
      },
      bundleErrors: {
        "/index.ts": [`Could not resolve: "./does-not-exist.ts"`],
      },
      onAfterBundle(api) {
        expect(onEndCalled).toBe(true);
        expect(asyncCompleted).toBe(true);
      },
    };
  });

  itBundled("plugin/OnEndBuildFailsThrowsAsyncActual", () => {
    let onEndCalled = false;
    let asyncCompleted = false;

    return {
      files: {
        "index.ts": `
          import { missing } from "./does-not-exist.ts";
          console.log(missing);
        `,
      },
      outdir: "/out",
      plugins(builder) {
        builder.onEnd(async () => {
          onEndCalled = true;
          await Bun.sleep(0); // Actual async
          asyncCompleted = true;
        });
      },
      bundleErrors: {
        "/index.ts": [`Could not resolve: "./does-not-exist.ts"`],
      },
      onAfterBundle(api) {
        expect(onEndCalled).toBe(true);
        expect(asyncCompleted).toBe(true);
      },
    };
  });

  itBundled("plugin/OnEndBuildSucceedsThrowsAsyncMicrotask", () => {
    let onEndCalled = false;
    let asyncCompleted = false;

    return {
      files: {
        "index.ts": `
          console.log("Build succeeds");
        `,
      },
      outdir: "/out",
      plugins(builder) {
        builder.onEnd(async () => {
          onEndCalled = true;
          await Promise.resolve(); // Microtask
          // Test async microtask completion
          asyncCompleted = true;
        });
      },
      onAfterBundle(api) {
        expect(onEndCalled).toBe(true);
        expect(asyncCompleted).toBe(true);
        expect(api.readFile("out/index.js")).toContain("Build succeeds");
      },
    };
  });

  itBundled("plugin/OnEndBuildSucceedsThrowsAsyncActual", () => {
    let onEndCalled = false;
    let asyncCompleted = false;

    return {
      files: {
        "index.ts": `
          console.log("Build succeeds");
        `,
      },
      outdir: "/out",
      plugins(builder) {
        builder.onEnd(async () => {
          onEndCalled = true;
          await Bun.sleep(0); // Actual async
          // Test actual async completion
          asyncCompleted = true;
        });
      },
      onAfterBundle(api) {
        expect(onEndCalled).toBe(true);
        expect(asyncCompleted).toBe(true);
        expect(api.readFile("out/index.js")).toContain("Build succeeds");
      },
    };
  });

  itBundled("plugin/OnEndWithGCBeforeAwait", () => {
    let onEndCalled = false;

    return {
      files: {
        "index.ts": `
          console.log("Build succeeds");
        `,
      },
      outdir: "/out",
      plugins(builder) {
        builder.onEnd(async () => {
          onEndCalled = true;
          Bun.gc(true); // Force GC before await
          await Bun.sleep(0);
          Bun.gc(true); // Force GC after await
        });
      },
      onAfterBundle(api) {
        expect(onEndCalled).toBe(true);
        expect(api.readFile("out/index.js")).toContain("Build succeeds");
      },
    };
  });

  itBundled("plugin/OnEndMultipleMixedErrors", () => {
    const events: string[] = [];
    let errorCount = 0;

    return {
      files: {
        "index.ts": `
          console.log("Build succeeds");
        `,
      },
      outdir: "/out",
      throw: false,
      plugins(builder) {
        builder.onEnd(() => {
          events.push("first-success");
        });

        builder.onEnd(() => {
          events.push("second-throw");
          errorCount++;
          throw new Error("second callback error");
        });

        builder.onEnd(async () => {
          events.push("third-throw");
          await Promise.resolve();
          events.push("third-throw-after-await");
          errorCount++;
          throw new Error("third callback error");
        });

        builder.onEnd(() => {
          events.push("fourth-success");
        });

        builder.onEnd(async () => {
          events.push("fifth-throw");
          await Bun.sleep(0);
          // Shouldn't reach here, promise should have already rejected elsewhere
          events.push("fifth-throw-after-await");
          errorCount++;
          throw new Error("fifth callback error");
        });
      },
      bundleErrors: {
        "<bun>": ["second callback error"],
      },
      onAfterApiBundle(build) {
        expect(build.success).toBe(false);
        expect(events).toMatchInlineSnapshot(`
          [
            "first-success",
            "second-throw",
            "third-throw",
            "fourth-success",
            "fifth-throw",
            "third-throw-after-await",
          ]
        `);
        expect(errorCount).toBe(2);
      },
    };
  });

  itBundled("plugin/OnEndFirstThrowsRestRun", () => {
    const events: string[] = [];

    return {
      files: {
        "index.ts": `
          export const test = "multiple callbacks";
        `,
      },
      outdir: "/out",
      throw: false,
      plugins(builder) {
        builder.onEnd(() => {
          events.push("first");
          throw new Error("first callback error");
        });

        builder.onEnd(() => {
          events.push("second");
        });

        builder.onEnd(async () => {
          events.push("third");
          await Promise.resolve();
        });

        builder.onEnd(() => {
          events.push("fourth");
        });
      },
      bundleErrors: {
        "<bun>": ["first callback error"],
      },
      onAfterApiBundle(build) {
        expect(build.success).toBe(false);
        expect(events).toEqual(["first", "second", "third", "fourth"]);
      },
    };
  });

  itBundled("plugin/OnEndMultipleAsyncWithGC", () => {
    const events: string[] = [];

    return {
      files: {
        "index.ts": `
          export default "gc test";
        `,
      },
      outdir: "/out",
      plugins(builder) {
        builder.onEnd(async () => {
          events.push("first-start");
          Bun.gc(true);
          await Bun.sleep(0);
          events.push("first-end");
        });

        builder.onEnd(async () => {
          events.push("second-start");
          await Promise.resolve();
          Bun.gc(true);
          events.push("second-end");
        });

        builder.onEnd(async () => {
          events.push("third-start");
          Bun.gc(true);
          await Bun.sleep(0);
          Bun.gc(true);
          events.push("third-end");
        });
      },
      onAfterBundle(api) {
        expect(events).toEqual(["first-start", "second-start", "third-start", "second-end", "first-end", "third-end"]);
        expect(api.readFile("out/index.js")).toContain("gc test");
      },
    };
  });

  itBundled("plugin/OnEndMultipleCallbacksSomeThrow", () => {
    const events: string[] = [];

    return {
      files: {
        "index.ts": `
          // Build will succeed but some onEnd callbacks throw
          export const test = "multiple callbacks with errors";
        `,
      },
      outdir: "/out",
      throw: false,
      plugins(builder) {
        builder.onEnd(() => {
          events.push("first");
        });

        builder.onEnd(() => {
          events.push("second-throw");
          throw new Error("second throws");
        });

        builder.onEnd(async () => {
          events.push("third-async");
          await Bun.sleep(0);
          throw new Error("third throws async");
        });

        builder.onEnd(() => {
          events.push("fourth");
        });
      },
      bundleErrors: {
        "<bun>": ["second throws"],
      },
      onAfterApiBundle(build) {
        expect(build.success).toBe(false);
        expect(events).toEqual(["first", "second-throw", "third-async", "fourth"]);
      },
    };
  });

  itBundled("plugin/OnEndAsyncErrorsAreAwaited", () => {
    let asyncStarted = false;
    let asyncCompleted = false;

    return {
      files: {
        "index.ts": `
          export const test = "async error test";
        `,
      },
      outdir: "/out",
      plugins(builder) {
        builder.onEnd(async () => {
          asyncStarted = true;
          await Bun.sleep(5);
          asyncCompleted = true;
          throw new Error("async error after delay");
        });
      },
      bundleErrors: {
        "<bun>": ["async error after delay"],
      },
      onAfterApiBundle(build) {
        expect(build.success).toBe(false);
        expect(asyncStarted).toBe(true);
        expect(asyncCompleted).toBe(true);
      },
    };
  });

  for (const [name, call, tuple] of [
    ["addFilter", 1, `[123, () => {}]`],
    ["onBeforeParse", 3, `[123, {}, "symbol", undefined]`],
  ] as const) {
    test.concurrent(`plugin/${name} throws a TypeError when the filter is not a RegExp`, async () => {
      using dir = tempDir("plugin-filter-not-regexp", {
        "index.ts": `console.log("hi");`,
        "build.mjs": `
          const originalEntries = Map.prototype.entries;
          let calls = 0;
          try {
            await Bun.build({
              entrypoints: ["./index.ts"],
              plugins: [
                {
                  name: "entries",
                  setup(build) {
                    Map.prototype.entries = function () {
                      if (++calls !== ${call}) return originalEntries.call(this);
                      Map.prototype.entries = originalEntries;
                      return [["file", [${tuple}]]][Symbol.iterator]();
                    };
                  },
                },
              ],
            });
            console.log("resolved");
          } catch (e) {
            console.log([e.name, e.code, e.message].join("|"));
          } finally {
            Map.prototype.entries = originalEntries;
          }
          console.log("calls=" + calls);
        `,
      });

      await using proc = Bun.spawn({
        cmd: [bunExe(), "build.mjs"],
        env: bunEnv,
        cwd: String(dir),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);

      expect({ stdout, stderr }).toEqual({
        stdout: `TypeError|ERR_INVALID_ARG_TYPE|Expected filter (1st argument) to be a RegExp\ncalls=${call}\n`,
        stderr: "",
      });
      expect(exitCode).toBe(0);
    });
  }

  // An entry point that onResolve leaves without a module used to be dropped
  // without a log entry: the linker aborted on an empty chunk list when it was
  // the only entry point, and the build silently emitted only the other entry
  // points otherwise. A declined entry point that the package.json "browser"
  // field disables gets the same error as without plugins.
  test.concurrent("plugin/entry point left without a module by onResolve fails the build", async () => {
    using dir = tempDir("plugin-entry-point-without-module", {
      "package.json": JSON.stringify({ name: "app", browser: { "./disabled.js": false } }),
      "entry.js": `console.log("entry");`,
      "live.js": `console.log("live");`,
      "disabled.js": `console.log("disabled");`,
      "build.mjs": `
        const declined = [];
        const plugins = [
          {
            name: "externalize-entry",
            setup(build) {
              build.onResolve({ filter: /entry\\.js$/ }, args => ({ path: args.path, external: true }));
            },
          },
          {
            name: "decline-disabled",
            setup(build) {
              build.onResolve({ filter: /disabled\\.js$/ }, args => {
                declined.push(args.path);
              });
            },
          },
        ];
        const results = {};
        for (const [name, entrypoints] of Object.entries({
          external: ["./entry.js"],
          externalNextToLiveEntryPoint: ["./entry.js", "./live.js"],
          declinedThenDisabledByBrowserField: ["./disabled.js"],
        })) {
          const result = await Bun.build({ entrypoints, target: "browser", plugins, throw: false });
          results[name] = {
            success: result.success,
            logs: result.logs.map(log => log.message),
            outputs: result.outputs.map(output => output.path),
          };
        }
        results.declined = declined;
        console.log(JSON.stringify(results));
      `,
    });

    await using proc = Bun.spawn({
      cmd: [bunExe(), "build.mjs"],
      env: bunEnv,
      cwd: String(dir),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);

    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({
      external: {
        success: false,
        logs: ['The entry point "./entry.js" cannot be marked as external'],
        outputs: [],
      },
      externalNextToLiveEntryPoint: {
        success: false,
        logs: ['The entry point "./entry.js" cannot be marked as external'],
        outputs: [],
      },
      declinedThenDisabledByBrowserField: {
        success: false,
        logs: ['"./disabled.js" is disabled due to "browser" field in package.json (entry point)'],
        outputs: [],
      },
      declined: ["./disabled.js"],
    });
    expect(exitCode).toBe(0);
  });

  // Two entry point names that onResolve maps to one file make one output file.
  for (const splitting of [false, true]) {
    test.concurrent(`plugin/two entry points that resolve to one file (splitting: ${splitting})`, async () => {
      using dir = tempDir("plugin-two-entry-points-one-file", {
        "entry.ts": `console.log("entry");`,
      });
      const result = await Bun.build({
        entrypoints: ["first-name", "second-name"],
        outdir: join(String(dir), "out"),
        splitting,
        throw: false,
        plugins: [
          {
            name: "alias",
            setup(build) {
              build.onResolve({ filter: /-name$/ }, () => ({ path: join(String(dir), "entry.ts") }));
            },
          },
        ],
      });
      expect({
        success: result.success,
        logs: result.logs.map(log => log.message),
        outputs: result.outputs.map(output => path.basename(output.path)),
      }).toEqual({ success: true, logs: [], outputs: ["second-name.js"] });
    });
  }

  test.concurrent("plugin/internal plugin object checks its receiver and rejects new filters after setup", async () => {
    using dir = tempDir("plugin-private-object", {
      "entry.js": `export default 1;`,
      "fixture.mjs": /* js */ `
        import { getProtectedObjects } from "bun:jsc";
        const hasOwn = Object.prototype.hasOwnProperty;
        // The plugin object is a protected cell. Some other protected cells throw on property lookup.
        function findPlugin() {
          for (const object of getProtectedObjects()) {
            try {
              if (object && typeof object === "object" && hasOwn.call(object, "addFilter")) return object;
            } catch {}
          }
        }
        const attempt = call => {
          try {
            call();
            return "accepted";
          } catch (e) {
            return e.code ?? e.name;
          }
        };

        const leaked = [];
        for (const name of ["promises", "onEndCallbacks"]) {
          Object.defineProperty(Object.prototype, name, {
            configurable: true,
            get() {
              if (hasOwn.call(this, "addFilter")) leaked.push(name);
            },
            set(value) {
              Object.defineProperty(this, name, { value, writable: true, enumerable: true, configurable: true });
            },
          });
        }

        let plugin;
        const outcomes = {};
        const result = await Bun.build({
          entrypoints: ["./entry.js"],
          throw: false,
          plugins: [
            {
              name: "probe",
              // A callable Proxy isn't a JSFunction.
              setup: new Proxy(build => {
                plugin = findPlugin();
                outcomes.duringSetup = attempt(() => plugin.addFilter(/never/, "probe", 1));
                build.onEnd(() => {});
                build.onLoad({ filter: /entry/ }, () => {
                  outcomes.duringBuild = attempt(() => plugin.addFilter(/never/, "probe", 1));
                });
              }, {}),
            },
          ],
        });
        const calls = {
          addFilter: [/x/, "a", 1],
          addError: [0, new Error("x")],
          onLoadAsync: [0, null, null],
          onResolveAsync: [0, null, null, null],
          onBeforeParse: [/x/, "a", {}, "symbol"],
          generateDeferPromise: [0],
          resolveBinding: [],
        };
        const receivers = Object.entries(calls).map(([name, args]) => attempt(() => plugin[name].apply(undefined, args)));
        console.log(JSON.stringify({ success: result.success, leaked, outcomes, receivers }));
      `,
    });

    await using proc = Bun.spawn({
      cmd: [bunExe(), "fixture.mjs"],
      env: bunEnv,
      cwd: String(dir),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);

    expect(stderr).toBe("");
    expect(JSON.parse(stdout || "null")).toEqual({
      success: true,
      leaked: [],
      outcomes: { duringSetup: "accepted", duringBuild: "ERR_INVALID_STATE" },
      receivers: Array(7).fill("ERR_INVALID_THIS"),
    });
    expect(exitCode).toBe(0);
  });

  // build.resolve(): the answers come from the resolver of the build, as data, and asking
  // leaves no trace in the build.
  test.concurrent("plugin/build.resolve() gives what the resolver of the build finds", async () => {
    using dir = tempDir("plugin-resolve-default", {
      "entry.js": `import { b } from "virtual"; console.log(b);`,
      "lib/b.js": `export const b = 42;`,
      "lib/unused.js": `export const unused = 1;`,
      "node_modules/pkg/package.json": JSON.stringify({ name: "pkg", main: "./main.js", sideEffects: false }),
      "node_modules/pkg/main.js": `module.exports = 1;`,
      "node_modules/dual/package.json": JSON.stringify({
        name: "dual",
        exports: { import: "./esm.js", require: "./cjs.js" },
      }),
      "node_modules/dual/esm.js": `export default 1;`,
      "node_modules/dual/cjs.js": `module.exports = 1;`,
    });
    const root = String(dir);
    const answers: Record<string, any> = {};
    const result = await Bun.build({
      entrypoints: [join(root, "entry.js")],
      external: ["left-out"],
      files: { [join(root, "in-memory.js")]: "export default 1;" },
      metafile: true,
      throw: false,
      plugins: [
        {
          name: "asks",
          setup(build) {
            build.onResolve({ filter: /^virtual$/ }, async args => {
              const ask = (path: string) => build.resolve(path, { kind: args.kind, resolveDir: args.resolveDir });
              answers.file = await ask("./lib/b.js");
              answers.fromImporter = await build.resolve("./b.js", {
                kind: "require-call",
                importer: join(root, "lib", "unused.js"),
              });
              answers.relativeResolveDir = await build.resolve("./b.js", {
                kind: "dynamic-import",
                resolveDir: path.relative(process.cwd(), join(root, "lib")),
              });
              answers.package = await ask("pkg");
              answers.external = await ask("left-out");
              answers.inMemory = await ask("./in-memory.js");
              answers.missing = await ask("./missing.js");
              answers.missingPackage = await build.resolve("missing-package", {
                kind: args.kind,
                resolveDir: args.resolveDir,
                pluginName: "asks",
              });
              // The kind picks the condition of "exports".
              answers.imported = await build.resolve("dual", { kind: "import-statement", resolveDir: root });
              answers.required = await build.resolve("dual", { kind: "require-call", resolveDir: root });
              answers.dataUrl = await ask("data:text/plain,hello");
              // Without a directory, what needs none has an answer.
              const kind = "import-statement";
              answers.noDirectory = await build.resolve("./lib/b.js", { kind });
              answers.noDirectoryPackage = await build.resolve("pkg", { kind });
              answers.noDirectoryExternal = await build.resolve("left-out", { kind });
              answers.noDirectoryAbsolute = await build.resolve(join(root, "lib", "b.js"), { kind });
              answers.noDirectoryInMemory = await build.resolve(join(root, "in-memory.js"), { kind, resolveDir: "" });
              answers.askedOnly = await ask("./lib/unused.js");
              return { path: answers.file.path };
            });
          },
        },
      ],
    });

    const found = (file: string, rest = {}) => ({
      errors: [],
      warnings: [],
      path: file,
      external: false,
      sideEffects: true,
      namespace: "file",
      suffix: "",
      pluginData: undefined,
      ...rest,
    });
    const failed = (text: string, pluginName = "") => ({
      errors: [{ id: "", pluginName, text, location: null, notes: [], detail: undefined }],
      warnings: [],
      path: "",
      external: false,
      sideEffects: false,
      namespace: "",
      suffix: "",
      pluginData: undefined,
    });
    expect(answers).toEqual({
      file: found(join(root, "lib", "b.js")),
      fromImporter: found(join(root, "lib", "b.js")),
      relativeResolveDir: found(join(root, "lib", "b.js")),
      package: found(join(root, "node_modules", "pkg", "main.js"), { sideEffects: false }),
      external: found("left-out", { external: true, namespace: "" }),
      inMemory: found(join(root, "in-memory.js").replaceAll("\\", "/")),
      missing: failed('Could not resolve: "./missing.js"'),
      missingPackage: failed('Could not resolve: "missing-package". Maybe you need to "bun install"?', "asks"),
      imported: found(join(root, "node_modules", "dual", "esm.js")),
      required: found(join(root, "node_modules", "dual", "cjs.js")),
      dataUrl: found("data:text/plain,hello", { external: true, namespace: "" }),
      noDirectory: failed(
        'Could not resolve: "./lib/b.js". build.resolve() has no directory to look from: pass "resolveDir", or an "importer" in the "file" namespace',
      ),
      noDirectoryPackage: failed(
        'Could not resolve: "pkg". build.resolve() has no directory to look from: pass "resolveDir", or an "importer" in the "file" namespace',
      ),
      noDirectoryExternal: found("left-out", { external: true, namespace: "" }),
      noDirectoryAbsolute: found(join(root, "lib", "b.js")),
      noDirectoryInMemory: found(join(root, "in-memory.js").replaceAll("\\", "/")),
      askedOnly: found(join(root, "lib", "unused.js")),
    });
    // Every answer has the eight keys, also where a value is undefined.
    for (const answer of Object.values(answers)) {
      expect(Object.keys(answer)).toEqual([
        "errors",
        "warnings",
        "path",
        "external",
        "sideEffects",
        "namespace",
        "suffix",
        "pluginData",
      ]);
    }
    // A path that was only asked about is not in the build, and one that did not resolve is not in its log.
    expect({
      success: result.success,
      logs: result.logs.map(log => log.message),
      inputs: Object.keys(result.metafile!.inputs)
        .map(input => path.basename(input))
        .sort(),
    }).toEqual({ success: true, logs: [], inputs: ["b.js", "entry.js"] });
  });

  // The same package resolves to another file for another target or condition. build.resolve()
  // and the import of the same build have to name the same one.
  test.concurrent("plugin/build.resolve() and the import agree", async () => {
    using dir = tempDir("plugin-resolve-agrees", {
      "entry.js": `
        import "fields";
        import "conditions";
        import "./local.js";
        import "left-out";
        import "other-name";
        import "node:path";
      `,
      "local.js": `export default "local";`,
      "substitute.js": `export default "substitute";`,
      "node_modules/fields/package.json": JSON.stringify({
        name: "fields",
        main: "./main.js",
        module: "./module.js",
        browser: "./browser.js",
      }),
      "node_modules/fields/main.js": `module.exports = "main";`,
      "node_modules/fields/module.js": `export default "module";`,
      "node_modules/fields/browser.js": `export default "browser";`,
      "node_modules/conditions/package.json": JSON.stringify({
        name: "conditions",
        exports: { ".": { custom: "./custom.js", default: "./default.js" } },
      }),
      "node_modules/conditions/custom.js": `export default "custom";`,
      "node_modules/conditions/default.js": `export default "default";`,
      "build.mjs": `
        import { relative } from "node:path";
        const specifiers = ["fields", "conditions", "./local.js", "left-out", "other-name", "node:path"];
        const rows = [];
        for (const target of ["browser", "bun", "node"]) {
          for (const conditions of [[], ["custom"]]) {
            const asked = {};
            const result = await Bun.build({
              entrypoints: ["./entry.js"],
              target,
              conditions,
              external: ["left-out"],
              alias: { "other-name": "./substitute.js" },
              metafile: true,
              throw: false,
              plugins: [
                {
                  name: "asks",
                  setup(build) {
                    build.onLoad({ filter: /entry\\.js$/ }, async args => {
                      for (const specifier of specifiers) {
                        const answer = await build.resolve(specifier, { kind: "import-statement", importer: args.path });
                        // A module that Bun has in itself, like what a browser build gets for a Node.js
                        // builtin, has the namespace "node" and a path that is no file. The build
                        // lists it under the name of the import.
                        asked[specifier] =
                          answer.namespace === "node"
                            ? [specifier, answer.external]
                            : answer.external
                              ? [answer.path, true]
                              : [relative(process.cwd(), answer.path).replaceAll("\\\\", "/"), false];
                      }
                    });
                  },
                },
              ],
            });
            if (!result.success) throw new AggregateError(result.logs);
            const imported = {};
            for (const record of result.metafile.inputs["entry.js"].imports) {
              imported[record.original ?? record.path] = [record.path, record.external === true];
            }
            for (const specifier of specifiers) {
              rows.push({ target, conditions, specifier, asked: asked[specifier], imported: imported[specifier] });
            }
          }
        }
        console.log(JSON.stringify(rows));
      `,
    });

    await using proc = Bun.spawn({
      cmd: [bunExe(), "build.mjs"],
      env: bunEnv,
      cwd: String(dir),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);

    expect(stderr).toBe("");
    const rows: { target: string; conditions: string[]; specifier: string; asked: unknown; imported: unknown }[] =
      JSON.parse(stdout || "[]");
    expect(rows.length).toBe(36);
    expect(rows.filter(row => !Bun.deepEquals(row.asked, row.imported))).toEqual([]);
    // The answers differ by target and by condition, so the rows above compare more than one file.
    const asked = (target: string, conditions: string[], specifier: string) =>
      rows.find(
        row => row.target === target && row.specifier === specifier && Bun.deepEquals(row.conditions, conditions),
      )?.asked;
    expect({
      browser: asked("browser", [], "fields"),
      bun: asked("bun", [], "fields"),
      custom: asked("node", ["custom"], "conditions"),
      default: asked("node", [], "conditions"),
      alias: asked("bun", [], "other-name"),
      external: asked("bun", [], "left-out"),
      builtin: asked("bun", [], "node:path"),
    }).toEqual({
      browser: ["node_modules/fields/browser.js", false],
      bun: ["node_modules/fields/module.js", false],
      custom: ["node_modules/conditions/custom.js", false],
      default: ["node_modules/conditions/default.js", false],
      alias: ["substitute.js", false],
      external: ["left-out", true],
      builtin: ["path", true],
    });
    expect(exitCode).toBe(0);
  });

  // The onResolve callbacks of every plugin are asked first, the caller's too. pluginData is how
  // a callback knows its own question.
  test.concurrent("plugin/build.resolve() asks the onResolve callbacks first", async () => {
    using dir = tempDir("plugin-resolve-chain", {
      "entry.js": `import "wrapped"; import "./other.js";`,
      "wrapped.js": `export default 1;`,
      "other.js": `export default 2;`,
    });
    const root = String(dir);
    const told: unknown[] = [];
    const answers: Record<string, any> = {};
    const virtualDirectories: unknown[] = [];
    const guardedCalls: unknown[] = [];
    const thrownSymbol = Symbol("thrown");
    const thrownBare = Object.create(null);
    const result = await Bun.build({
      entrypoints: [join(root, "entry.js")],
      throw: false,
      plugins: [
        {
          name: "first",
          setup(build) {
            build.onResolve({ filter: /^wrapped$/ }, async args => {
              told.push({ ...args });
              // The question comes back to this callback. It leaves it to the rest.
              if (args.pluginData?.asked) return;
              answers.self = await build.resolve("wrapped", {
                kind: "dynamic-import",
                importer: args.importer,
                resolveDir: join(root, "nowhere"),
                pluginData: { asked: true },
              });
              answers.virtual = await build.resolve("virtual:module", { kind: args.kind, importer: args.importer });
              answers.virtualAgain = await build.resolve("virtual:module", { kind: args.kind });
              // A callback that was registered with a namespace is asked only by a call that names it.
              answers.withoutNamespace = await build.resolve("guarded", { kind: args.kind });
              answers.withNamespace = await build.resolve("guarded", { kind: args.kind, namespace: "file" });
              answers.throws = await build.resolve("throws", { kind: args.kind, pluginName: "first" });
              answers.throwsSymbol = await build.resolve("throws-symbol", { kind: args.kind });
              answers.throwsBare = await build.resolve("throws-bare", { kind: args.kind });
              answers.nested = await build.resolve("nested", { kind: args.kind, importer: args.importer });
              answers.together = await Promise.all(
                ["./wrapped.js", "./other.js", "./missing.js"].map(path =>
                  build.resolve(path, { kind: args.kind, importer: args.importer }),
                ),
              );
              return { path: answers.self.path };
            });
          },
        },
        {
          name: "second",
          setup(build) {
            build.onResolve({ filter: /^wrapped$/ }, args => {
              told.push({ ...args, plugin: "second" });
              return { path: join(root, "wrapped.js"), pluginData: { answeredBy: "second" } };
            });
            build.onResolve({ filter: /^virtual:/ }, args => {
              virtualDirectories.push(args.resolveDir);
              return { path: args.path.slice("virtual:".length), namespace: "virtual" };
            });
            build.onResolve({ filter: /^guarded$/, namespace: "file" }, args => {
              guardedCalls.push(args.namespace);
              return { path: args.path, external: true };
            });
            build.onResolve({ filter: /^throws$/ }, () => {
              throw new RangeError("the callback threw");
            });
            build.onResolve({ filter: /^throws-symbol$/ }, () => {
              throw thrownSymbol;
            });
            build.onResolve({ filter: /^throws-bare$/ }, () => {
              throw thrownBare;
            });
            build.onResolve({ filter: /^nested$/ }, async args => {
              // Asked by build.resolve(), and asking on.
              const inner = await build.resolve("./other.js", { kind: args.kind, importer: args.importer });
              return { path: inner.path, pluginData: inner.errors.length };
            });
            build.onLoad({ filter: /.*/, namespace: "virtual" }, () => ({ contents: "" }));
          },
        },
      ],
    });

    // An import of the build tells its callbacks what it did before: there is no `pluginData` key.
    expect(told[0]).toStrictEqual({
      path: "wrapped",
      importer: join(root, "entry.js"),
      namespace: "file",
      resolveDir: root,
      kind: "import-statement",
    });
    expect(told.slice(1)).toEqual([
      // What build.resolve() was given is what the callbacks are told.
      {
        path: "wrapped",
        importer: join(root, "entry.js"),
        namespace: "file",
        resolveDir: join(root, "nowhere"),
        kind: "dynamic-import",
        pluginData: { asked: true },
      },
      {
        path: "wrapped",
        importer: join(root, "entry.js"),
        namespace: "file",
        resolveDir: join(root, "nowhere"),
        kind: "dynamic-import",
        pluginData: { asked: true },
        plugin: "second",
      },
    ]);
    const answered = (rest: object) => ({
      errors: [],
      warnings: [],
      external: false,
      sideEffects: true,
      namespace: "file",
      suffix: "",
      pluginData: undefined,
      ...rest,
    });
    expect(answers.self).toEqual(answered({ path: join(root, "wrapped.js"), pluginData: { answeredBy: "second" } }));
    expect(answers.virtual).toEqual(answered({ path: "module", namespace: "virtual" }));
    // Nothing is remembered: the callback ran for each question. A question without a directory
    // tells the callbacks an empty one.
    expect(answers.virtualAgain).toEqual(answers.virtual);
    expect(virtualDirectories).toEqual([root, ""]);
    expect(answers.withoutNamespace.errors.map((error: any) => error.text)).toEqual([
      'Could not resolve: "guarded". build.resolve() has no directory to look from: pass "resolveDir", or an "importer" in the "file" namespace',
    ]);
    expect(answers.withNamespace).toEqual(answered({ path: "guarded", external: true }));
    expect(guardedCalls).toEqual(["file"]);
    // The name of the plugin that threw is not known, and `pluginName` is not it.
    expect(answers.throws.errors).toEqual([
      {
        id: "",
        pluginName: "",
        text: "the callback threw",
        location: null,
        notes: [],
        detail: expect.any(RangeError),
      },
    ]);
    // What a callback throws can be anything, also what has no text.
    expect(answers.throwsSymbol.errors.map((error: any) => [error.text, error.detail === thrownSymbol])).toEqual([
      ["Symbol(thrown)", true],
    ]);
    expect(answers.throwsBare.errors.map((error: any) => [error.text, error.detail === thrownBare])).toEqual([
      ["An onResolve() callback threw a value that has no text", true],
    ]);
    expect({ ...answers.throws, errors: [] }).toEqual({
      errors: [],
      warnings: [],
      path: "",
      external: false,
      sideEffects: false,
      namespace: "",
      suffix: "",
      pluginData: undefined,
    });
    expect(answers.nested).toEqual(answered({ path: join(root, "other.js"), pluginData: 0 }));
    expect(answers.together.map((answer: any) => [answer.path, answer.errors.map((error: any) => error.text)])).toEqual(
      [
        [join(root, "wrapped.js"), []],
        [join(root, "other.js"), []],
        ["", ['Could not resolve: "./missing.js"']],
      ],
    );
    expect({ success: result.success, logs: result.logs.map(log => log.message) }).toEqual({ success: true, logs: [] });
  });

  // The build has a resolver from its start to the last answer of its plugins. Outside of
  // that, build.resolve() says so: at once where a promise could never settle.
  test.concurrent("plugin/build.resolve() outside of an onResolve or onLoad callback", async () => {
    using dir = tempDir("plugin-resolve-lifecycle", {
      "entry.js": `import "./a.js"; import "./b.js";`,
      "a.js": `export default 1;`,
      "b.js": `export default 2;`,
    });
    const root = String(dir);
    const outcomes: Record<string, unknown> = {};
    const attempt = (call: () => unknown) => {
      try {
        call();
        return "returned";
      } catch (error: any) {
        return [error.code ?? error.name, error.message];
      }
    };
    const settled = (promise: Promise<any>) =>
      promise.then(
        answer => answer.path,
        error => [error.code ?? error.name, error.message],
      );
    const ask = { kind: "import-statement", resolveDir: root } as const;
    let builder: Bun.PluginBuilder;
    let floating: Promise<unknown>;
    let outlivesTheBuild: Promise<unknown>;
    const buildEnded = Promise.withResolvers<void>();
    const result = await Bun.build({
      entrypoints: [join(root, "entry.js")],
      throw: false,
      plugins: [
        {
          name: "asks",
          async setup(build) {
            builder = build;
            outcomes.setup = attempt(() => build.resolve("./a.js", ask));
            await Promise.resolve();
            outcomes.setupAfterAwait = attempt(() => build.resolve("./a.js", ask));
            build.onStart(() => {
              outcomes.onStart = attempt(() => build.resolve("./a.js", ask));
            });
            build.onEnd(async () => {
              buildEnded.resolve();
              outcomes.onEnd = await settled(build.resolve("./a.js", ask));
            });
            build.onResolve({ filter: /^slow$/ }, async () => {
              await buildEnded.promise;
              return undefined;
            });
            build.onResolve({ filter: /[ab]\.js$/ }, args => {
              // What this plugin asks comes back to its own callback.
              if (args.pluginData === "asked") return undefined;
              if (args.path === "./b.js") {
                // Not waited for: the callback answers first, and the promise still settles.
                floating = settled(
                  build.resolve(args.path, { kind: args.kind, importer: args.importer, pluginData: "asked" }),
                );
                // A callback that this one makes run waits until the build is over.
                outlivesTheBuild = settled(build.resolve("slow", ask));
                return undefined;
              }
              return (async () => {
                outcomes.noKind = await settled(build.resolve("./a.js", { resolveDir: root } as any));
                outcomes.unknownKind = await settled(build.resolve("./a.js", { ...ask, kind: "import" as any }));
                outcomes.pathIsNoString = attempt(() => build.resolve(1 as any, ask));
                outcomes.optionsAreNoObject = attempt(() => build.resolve("./a.js", "import-statement" as any));
                outcomes.kindIsNoString = attempt(() => build.resolve("./a.js", { ...ask, kind: 1 as any }));
                outcomes.unknownOption = attempt(() => build.resolve("./a.js", { ...ask, resolvedir: root } as any));
                outcomes.with = attempt(() => build.resolve("./a.js", { ...ask, with: { type: "json" } } as any));
                outcomes.otherNamespace = attempt(() => build.resolve("./a.js", { ...ask, namespace: "made-up" }));
                outcomes.withUndefined = await settled(
                  build.resolve("./a.js", { ...ask, with: undefined, pluginData: "asked" } as any),
                );
                // A directory with a NUL in its name is none. The name of a module can have one.
                outcomes.nulInResolveDir = attempt(() => build.resolve("./a.js", { ...ask, resolveDir: "\0" }));
                outcomes.nulInImporter = await build
                  .resolve("./a.js", {
                    ...ask,
                    resolveDir: undefined,
                    importer: join(root, "\0virtual"),
                    pluginData: "asked",
                  })
                  .then(answer => answer.errors.length);
                outcomes.nulFirstInImporter = await build
                  .resolve("./a.js", { kind: "import-statement", importer: "\0virtual:pkg/x", pluginData: "asked" })
                  .then(answer => answer.errors.length);
                return undefined;
              })();
            });
          },
        },
      ],
    });
    outcomes.floating = await floating!;
    outcomes.outlivesTheBuild = await outlivesTheBuild!;
    outcomes.afterTheBuild = await settled(builder!.resolve("./a.js", ask));

    const notStarted = [
      "ERR_INVALID_STATE",
      "Invalid state: build.resolve() was called before the build started. Call it in an onResolve() or onLoad() callback",
    ];
    const noCallbackRuns = [
      "ERR_INVALID_STATE",
      "Invalid state: build.resolve() was called while no onResolve() or onLoad() callback of the build was running",
    ];
    expect(outcomes).toEqual({
      setup: notStarted,
      setupAfterAwait: notStarted,
      onStart: notStarted,
      onEnd: noCallbackRuns,
      noKind: ["TypeError", 'Must specify "kind" when calling "resolve"'],
      unknownKind: ["TypeError", 'Invalid kind: "import"'],
      pathIsNoString: ["ERR_INVALID_ARG_TYPE", 'The "path" argument must be of type string. Received type number (1)'],
      optionsAreNoObject: [
        "ERR_INVALID_ARG_TYPE",
        `The "options" argument must be of type object. Received type string ('import-statement')`,
      ],
      kindIsNoString: [
        "ERR_INVALID_ARG_TYPE",
        'The "options.kind" property must be of type string. Received type number (1)',
      ],
      unknownOption: ["TypeError", 'Invalid option in resolve() call: "resolvedir"'],
      with: ["TypeError", 'build.resolve() does not support the "with" option yet'],
      otherNamespace: ["TypeError", 'build.resolve() does not support a "namespace" other than "file" yet'],
      withUndefined: join(root, "a.js"),
      nulInResolveDir: [
        "ERR_INVALID_ARG_VALUE",
        "The property 'options.resolveDir' must be a string without null bytes. Received '\\x00'",
      ],
      nulInImporter: 1,
      nulFirstInImporter: 1,
      floating: join(root, "b.js"),
      outlivesTheBuild: [
        "ERR_INVALID_STATE",
        'Invalid state: build.resolve("slow") has no build to ask: no onResolve() or onLoad() callback of the build was running any more when the onResolve() callbacks that it asked had answered',
      ],
      afterTheBuild: noCallbackRuns,
    });
    expect({ success: result.success, logs: result.logs.map(log => log.message) }).toEqual({ success: true, logs: [] });
  });

  test.concurrent("plugin/build.resolve() in onLoad, before and after defer()", async () => {
    using dir = tempDir("plugin-resolve-onload", {
      "entry.js": `import "./first.js"; import "./second.js";`,
      "first.js": `export default 1;`,
      "second.js": `export default 2;`,
    });
    const root = String(dir);
    const answers: Record<string, string> = {};
    const result = await Bun.build({
      entrypoints: [join(root, "entry.js")],
      throw: false,
      plugins: [
        {
          name: "asks",
          setup(build) {
            build.onLoad({ filter: /first\.js$/ }, async args => {
              const ask = () => build.resolve("./second.js", { kind: "import-statement", importer: args.path });
              answers.before = (await ask()).path;
              await args.defer();
              answers.after = (await ask()).path;
              return undefined;
            });
          },
        },
      ],
    });
    expect(answers).toEqual({ before: join(root, "second.js"), after: join(root, "second.js") });
    expect({ success: result.success, logs: result.logs.map(log => log.message) }).toEqual({ success: true, logs: [] });
  });

  // A server that imports a page has two graphs, and the same path can be another module in each.
  // build.resolve() answers for the graph of the import that the calling callback runs for. Once
  // that callback has waited, nothing says which import a call belongs to, and there is an answer
  // only where both graphs give the same one.
  test.concurrent("plugin/build.resolve() in a build with a graph for a server and one for its page", async () => {
    using dir = tempDir("plugin-resolve-two-graphs", {
      "server.ts": `import page from "./index.html";\nimport { shared } from "./shared.ts";\nimport cond from "cond";\nconsole.log(typeof page, shared, cond);`,
      "index.html": `<!DOCTYPE html><html><head></head><body><script type="module" src="./client.ts"></script></body></html>`,
      "client.ts": `import { shared } from "./shared.ts";\nimport cond from "cond";\nconsole.log(shared, cond);`,
      "shared.ts": `import { value } from "./value.ts";\nexport const shared = value;`,
      "value.ts": `export const value = 1;`,
      "node_modules/cond/package.json": JSON.stringify({
        name: "cond",
        exports: { ".": { browser: "./browser.js", bun: "./bun.js", default: "./default.js" } },
      }),
      "node_modules/cond/browser.js": `export default "cond-browser";`,
      "node_modules/cond/bun.js": `export default "cond-bun";`,
      "node_modules/cond/default.js": `export default "cond-default";`,
    });
    const root = String(dir);
    const inCallback: Record<string, string> = {};
    const afterAwait: Record<string, string> = {};
    const inOnLoad: Record<string, string> = {};
    const told = (answer: Bun.ResolveResult) =>
      answer.errors.length > 0 ? answer.errors[0].text : path.relative(root, answer.path).replaceAll("\\", "/");
    const build = (plugins: Bun.BunPlugin[]) =>
      Bun.build({ entrypoints: [join(root, "server.ts")], target: "bun", throw: false, plugins });
    const result = await build([
      {
        name: "asks",
        setup(build) {
          build.onResolve({ filter: /^cond$/ }, async args => {
            if (args.pluginData === "asked") return undefined;
            // Only `resolveDir` says where the import is. The call is made before the first await.
            const from = { kind: args.kind, resolveDir: args.resolveDir, pluginData: "asked" };
            const answer = await build.resolve("cond", from);
            const importer = path.basename(args.importer);
            inCallback[importer] = told(answer);
            if (importer === "client.ts") {
              afterAwait.cond = told(await build.resolve("cond", from));
              afterAwait.relative = told(await build.resolve("./value.ts", from));
            }
            return { path: answer.path };
          });
          build.onLoad({ filter: /shared\.ts$/ }, args => {
            const asked = build.resolve("cond", { kind: "import-statement", importer: args.path, pluginData: "asked" });
            return asked.then(answer => {
              inOnLoad[args.side] = told(answer);
              return undefined;
            });
          });
        },
      },
    ]);

    expect(inCallback).toEqual({
      "server.ts": "node_modules/cond/bun.js",
      "client.ts": "node_modules/cond/browser.js",
    });
    expect(inOnLoad).toEqual({ server: "node_modules/cond/bun.js", client: "node_modules/cond/browser.js" });
    expect(afterAwait).toEqual({
      cond: 'build.resolve() cannot tell which graph asks for "cond": this build has more than one (a server and its pages), and the path is not the same module in each. Call build.resolve() in an onResolve() or onLoad() callback before the first await of that callback',
      relative: "value.ts",
    });
    expect({ success: result.success, logs: result.logs.map(log => log.message) }).toEqual({
      success: true,
      logs: [],
    });
    // Each graph bundles the file that it gets without the plugin.
    const bundled = async (outputs: Bun.BuildArtifact[]) =>
      (await Promise.all(outputs.map(output => output.text())))
        .map(text => ["cond-bun", "cond-browser", "cond-default"].filter(marker => text.includes(marker)).join("+"))
        .filter(Boolean)
        .sort();
    expect(await bundled(result.outputs)).toEqual(await bundled((await build([])).outputs));
    expect(await bundled(result.outputs)).toEqual(["cond-browser", "cond-bun"]);
  });

  // The resolver reads a directory once per build, and build.resolve() can make it read one before
  // an import would have. A file that a plugin writes there afterwards is found all the same: by
  // the import, also when an onResolve callback declines it, and by the plugin when it asks again.
  for (const then of ["the file is imported", "a callback declines the import", "the plugin asks again"]) {
    test.concurrent(`plugin/build.resolve() before a plugin writes into the directory, and then ${then}`, async () => {
      using dir = tempDir("plugin-resolve-late-file", {
        "entry.js": `import "generated:a";`,
        "generated/a.js": `import "generated:b";`,
      });
      const root = String(dir);
      const answers: Record<string, string> = {};
      const result = await Bun.build({
        entrypoints: [join(root, "entry.js")],
        throw: false,
        plugins: [
          {
            name: "generates",
            setup(build) {
              const ask = (kind: Bun.ImportKind) => build.resolve("./generated/c.js", { kind, resolveDir: root });
              build.onResolve({ filter: /^generated:a$/ }, async args => {
                answers.before = (await ask(args.kind)).path;
                return { path: join(root, "generated", "a.js") };
              });
              build.onResolve({ filter: /^generated:b$/ }, async args => {
                writeFileSync(join(root, "generated", "c.js"), `export default "c";`);
                writeFileSync(join(root, "generated", "b.js"), `import c from "./c.js";\nconsole.log(c);`);
                if (then === "the plugin asks again") answers.after = (await ask(args.kind)).path;
                return { path: join(root, "generated", "b.js") };
              });
              if (then === "a callback declines the import") {
                build.onResolve({ filter: /c\.js$/ }, () => undefined);
              }
            },
          },
        ],
      });
      expect(answers).toEqual({
        before: "",
        ...(then === "the plugin asks again" && { after: join(root, "generated", "c.js") }),
      });
      expect({ success: result.success, logs: result.logs.map(log => log.message) }).toEqual({
        success: true,
        logs: [],
      });
    });
  }

  // An entry point is looked up past the directory cache too, as the build looks its own up.
  test.concurrent("plugin/build.resolve() for an entry point that a plugin writes", async () => {
    using dir = tempDir("plugin-resolve-late-entry", {
      "entry.js": `console.log("entry");`,
      "build.mjs": `
        import { writeFileSync } from "node:fs";
        const answers = {};
        const result = await Bun.build({
          entrypoints: ["./entry.js", "./generated.js"],
          throw: false,
          plugins: [
            {
              name: "generates",
              setup(build) {
                build.onResolve({ filter: /.*/ }, async ({ path, ...args }) => {
                  if (args.pluginData === "asked") return undefined;
                  if (path === "./generated.js") {
                    // The directory is read for this, and the file is written after.
                    await build.resolve("./entry.js", { ...args, pluginData: "asked" });
                    writeFileSync("generated.js", 'console.log("generated");');
                  }
                  const answer = await build.resolve(path, { ...args, pluginData: "asked" });
                  answers[path] = answer.errors.length > 0 ? answer.errors[0].text : "found";
                  return undefined;
                });
              },
            },
          ],
        });
        const missing = await Bun.build({
          entrypoints: ["./entry.js"],
          plugins: [
            {
              name: "asks",
              setup(build) {
                build.onLoad({ filter: /entry\\.js$/ }, async () => {
                  const answer = await build.resolve("./nowhere.js", { kind: "entry-point-build", resolveDir: "." });
                  answers.missing = answer.errors.map(error => error.text);
                });
              },
            },
          ],
        });
        console.log(JSON.stringify({ success: result.success, logs: result.logs.map(log => log.message), answers }));
      `,
    });

    await using proc = Bun.spawn({
      cmd: [bunExe(), "build.mjs"],
      env: bunEnv,
      cwd: String(dir),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);

    expect(stderr).toBe("");
    expect(JSON.parse(stdout || "null")).toEqual({
      success: true,
      logs: [],
      answers: {
        "./entry.js": "found",
        "./generated.js": "found",
        // The text that the build has for an entry point that is not there.
        missing: ['ModuleNotFound resolving "./nowhere.js" (entry point)'],
      },
    });
    expect(exitCode).toBe(0);
  });

  // The resolver says what is wrong with a package.json once, when it reads it. A plugin that asks
  // first must not take that from the build: the import of the build reports it all the same.
  test.concurrent("plugin/build.resolve() leaves the build what the resolver reports", async () => {
    const files = {
      "entry.js": `import "badpkg";`,
      "node_modules/badpkg/package.json": `{ "name": "badpkg", "main": `,
      "node_modules/badpkg/index.js": `console.log("badpkg");`,
    };
    using plain = tempDir("plugin-resolve-diagnostics-plain", files);
    using asked = tempDir("plugin-resolve-diagnostics-asked", files);
    const outcome = async (root: string, plugins: Bun.BunPlugin[]) => {
      const result = await Bun.build({ entrypoints: [join(root, "entry.js")], throw: false, plugins });
      return {
        success: result.success,
        logs: result.logs.map(log => log.message.replaceAll(root, "<root>")),
      };
    };
    let answer: Bun.ResolveResult | undefined;
    const withoutPlugin = await outcome(String(plain), []);
    const withPlugin = await outcome(String(asked), [
      {
        name: "asks",
        setup(build) {
          build.onResolve({ filter: /.*/ }, async ({ path, ...args }) => {
            if (args.pluginData === "asked") return undefined;
            const result = await build.resolve(path, { ...args, pluginData: "asked" });
            if (path === "badpkg") answer = result;
            return undefined;
          });
        },
      },
    ]);

    expect(withoutPlugin.success).toBe(false);
    expect(withoutPlugin.logs.length).toBeGreaterThan(0);
    expect(withPlugin).toEqual(withoutPlugin);
    // The path resolved, so the result has no error. What the resolver reported is a warning.
    expect({
      path: answer!.path,
      errors: answer!.errors,
      warnings: answer!.warnings.map(warning => warning.text.replaceAll(String(asked), "<root>")),
    }).toEqual({
      path: join(String(asked), "node_modules", "badpkg", "index.js"),
      errors: [],
      warnings: withoutPlugin.logs,
    });
  });

  // esbuild's way to fail an import with what build.resolve() found.
  test.concurrent("plugin/onResolve fails the import with the errors that it returns", async () => {
    using dir = tempDir("plugin-resolve-errors-returned", {
      "entry.js": `import "./missing-thing.js";`,
    });
    const root = String(dir);
    const result = await Bun.build({
      entrypoints: [join(root, "entry.js")],
      throw: false,
      plugins: [
        {
          name: "asks",
          setup(build) {
            build.onResolve({ filter: /missing-thing/ }, async ({ path, ...args }) => {
              if (args.pluginData === "asked") return undefined;
              const answer = await build.resolve(path, { ...args, pluginData: "asked" });
              return { errors: answer.errors };
            });
          },
        },
      ],
    });
    expect({ success: result.success, logs: result.logs.map(log => log.message) }).toEqual({
      success: false,
      logs: ['Could not resolve: "./missing-thing.js"'],
    });
  });

  // A plugin that hands every import of a build to build.resolve() gets the build that has no
  // plugin: entry points as they are written, and every kind of import under the name that
  // onResolve is told it by.
  test.concurrent("plugin/build.resolve() takes what onResolve is told, for every kind of import", async () => {
    using dir = tempDir("plugin-resolve-forwards", {
      "entry.js": `
        import value from "./esm.js";
        const required = require("./cjs.cjs");
        const lazy = await import("./lazy.js");
        console.log([value, required.value, lazy.default].join(" "));
      `,
      "esm.js": `export default "esm";`,
      "cjs.cjs": `exports.value = "cjs";`,
      "lazy.js": `export default "lazy";`,
      "src/second.js": `console.log("second");`,
      "styles.css": `@import "./imported.css";\n@import "./print.css" supports(display: grid);\nbody { background: url(./pixel.png); }`,
      "imported.css": `p { color: red; }`,
      "print.css": `p { color: black; }`,
      "pixel.png": "not really a png",
      "build.mjs": `
        const told = [];
        const forward = {
          name: "forward",
          setup(build) {
            build.onResolve({ filter: /.*/ }, async ({ path, ...args }) => {
              if (args.pluginData?.forwarded) return;
              told.push([path, args.kind]);
              const answer = await build.resolve(path, { ...args, pluginData: { forwarded: true } });
              if (answer.errors.length > 0) throw new Error(answer.errors[0].text);
              return { path: answer.path, external: answer.external };
            });
          },
        };
        const output = async plugins => {
          const result = await Bun.build({
            entrypoints: ["./entry.js", "src/second.js", "styles.css"],
            target: "bun",
            plugins,
          });
          return Promise.all(result.outputs.map(async output => [output.path, await output.text()]));
        };
        const plain = await output([]);
        const forwarded = await output([forward]);
        console.log(JSON.stringify({ same: Bun.deepEquals(plain, forwarded), outputs: plain.length, told: told.sort() }));
        // Every name that a callback can be told is a name that build.resolve() takes.
        const kinds = {};
        await Bun.build({
          entrypoints: ["./esm.js"],
          plugins: [
            {
              name: "kinds",
              setup(build) {
                build.onLoad({ filter: /esm\\.js$/ }, async args => {
                  for (const kind of [
                    "entry-point-run", "entry-point-build", "import-statement", "require-call", "dynamic-import",
                    "require-resolve", "import-rule", "url-token", "composes", "html_manifest", "internal",
                    "entry-point", "composes-from",
                  ]) {
                    const answer = await build.resolve("./lazy.js", { kind, importer: args.path });
                    kinds[kind] = answer.path.endsWith("lazy.js");
                  }
                });
              },
            },
          ],
        });
        console.log(JSON.stringify(kinds));
      `,
    });

    await using proc = Bun.spawn({
      cmd: [bunExe(), "build.mjs"],
      env: bunEnv,
      cwd: String(dir),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);

    expect(stderr).toBe("");
    const [forwarded, kinds] = stdout
      .trim()
      .split("\n")
      .map(line => JSON.parse(line));
    expect(forwarded).toEqual({
      same: true,
      outputs: expect.any(Number),
      told: [
        ["./cjs.cjs", "require-call"],
        ["./entry.js", "entry-point-build"],
        ["./esm.js", "import-statement"],
        ["./imported.css", "import-rule"],
        ["./lazy.js", "dynamic-import"],
        ["./pixel.png", "url-token"],
        ["./print.css", "import-rule"],
        ["src/second.js", "entry-point-build"],
        ["styles.css", "entry-point-build"],
      ],
    });
    expect(kinds).toEqual({
      "entry-point-run": true,
      "entry-point-build": true,
      "import-statement": true,
      "require-call": true,
      "dynamic-import": true,
      "require-resolve": true,
      "import-rule": true,
      "url-token": true,
      "composes": true,
      "html_manifest": true,
      "internal": true,
      "entry-point": true,
      "composes-from": true,
    });
    expect(exitCode).toBe(0);
  });

  // The callbacks answer without waiting for what they asked, hundreds of times, and the process
  // can end while answers are on their way. Nothing is asked of a build that has ended.
  test.concurrent("plugin/build.resolve() that no callback waits for", async () => {
    const count = 100;
    using dir = tempDir("plugin-resolve-floating", {
      "entry.js": Array.from({ length: count }, (_, i) => `import "./file${i}.js";`).join("\n"),
      ...Object.fromEntries(Array.from({ length: count }, (_, i) => [`file${i}.js`, `export default ${i};`])),
      "build.mjs": `
        const exits = process.argv[2] === "exit";
        const pending = [];
        const result = await Bun.build({
          entrypoints: ["./entry.js"],
          plugins: [
            {
              name: "asks",
              setup(build) {
                build.onResolve({ filter: /file\\d+\\.js$/ }, args => {
                  if (args.pluginData === "asked") return;
                  for (let i = 0; i < 4; i++) {
                    pending.push(
                      build.resolve(args.path, { kind: args.kind, importer: args.importer, pluginData: "asked" }),
                    );
                  }
                  if (exits && pending.length === ${count * 2}) process.exit(0);
                });
              },
            },
          ],
        });
        const answers = await Promise.all(pending);
        console.log(JSON.stringify({
          success: result.success,
          asked: answers.length,
          found: answers.filter(answer => /file\\d+\\.js$/.test(answer.path) && answer.errors.length === 0).length,
        }));
      `,
    });

    async function run(...args: string[]) {
      await using proc = Bun.spawn({
        cmd: [bunExe(), "build.mjs", ...args],
        // The process that exits frees its VM, and with it the answers that are on their way.
        env: args.length > 0 ? { ...bunEnv, BUN_DESTRUCT_VM_ON_EXIT: "1" } : bunEnv,
        cwd: String(dir),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      return { stdout, stderr, exitCode };
    }
    const [whole, exiting] = await Promise.all([run(), run("exit")]);
    expect(whole.stderr).toBe("");
    expect(JSON.parse(whole.stdout || "null")).toEqual({ success: true, asked: count * 4, found: count * 4 });
    expect(whole.exitCode).toBe(0);
    expect(exiting).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  });

  test.concurrent("plugin/onResolve is told the kind of every import", async () => {
    using dir = tempDir("plugin-onresolve-kinds", {
      "entry.js": `
        import value from "./esm.js";
        const required = require("./cjs.cjs");
        const lazy = await import("./lazy.js");
        console.log(value, required.value, lazy.default, require.resolve("./resolved.js"));
      `,
      "esm.js": `export default "esm";`,
      "cjs.cjs": `exports.value = "cjs";`,
      "lazy.js": `export default "lazy";`,
      "resolved.js": `export default "resolved";`,
      "styles.css": `@import "./imported.css";\n@import "./print.css" supports(display: grid);\nbody { background: url(./pixel.png); }`,
      "imported.css": `p { color: red; }`,
      "print.css": `p { color: black; }`,
      "pixel.png": "not really a png",
      "button.module.css": `.button { composes: base from "./base.module.css"; }`,
      "base.module.css": `.base { color: blue; }`,
      "modules.js": `import styles from "./button.module.css";\nconsole.log(styles.button);`,
      "build.mjs": `
        const told = [];
        const result = await Bun.build({
          entrypoints: ["./entry.js", "./styles.css", "./modules.js"],
          target: "bun",
          plugins: [
            {
              name: "kinds",
              setup(build) {
                build.onResolve({ filter: /.*/ }, args => {
                  told.push([args.path, args.kind]);
                });
              },
            },
          ],
        });
        console.log(JSON.stringify({ success: result.success, told: told.sort() }));
      `,
    });

    await using proc = Bun.spawn({
      cmd: [bunExe(), "build.mjs"],
      env: bunEnv,
      cwd: String(dir),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);

    expect(stderr).toBe("");
    expect(JSON.parse(stdout || "null")).toEqual({
      success: true,
      told: [
        ["./base.module.css", "composes"],
        ["./button.module.css", "import-statement"],
        ["./cjs.cjs", "require-call"],
        ["./entry.js", "entry-point-build"],
        ["./esm.js", "import-statement"],
        ["./imported.css", "import-rule"],
        ["./lazy.js", "dynamic-import"],
        ["./modules.js", "entry-point-build"],
        ["./pixel.png", "url-token"],
        ["./print.css", "import-rule"],
        ["./resolved.js", "require-resolve"],
        ["./styles.css", "entry-point-build"],
      ],
    });
    expect(exitCode).toBe(0);
  });
});
