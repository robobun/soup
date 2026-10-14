import { beforeAll, describe, expect, test } from "bun:test";
import { bunEnv, bunExe, isASAN, isDebug, isWindows, MAX_PATH_BYTES, normalizeBunSnapshot, tempDir } from "harness";
import { readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "path";

test("coverage crash", () => {
  using dir = tempDir("cov", {
    "demo.test.ts": `class Y {
  #hello
}`,
  });
  const result = Bun.spawnSync([bunExe(), "test", "--coverage"], {
    cwd: dir,
    env: {
      ...bunEnv,
    },
    stdio: ["inherit", "inherit", "inherit"],
  });
  expect(result.exitCode).toBe(0);
  expect(result.signalCode).toBeUndefined();
});

test("lcov coverage reporter", () => {
  using dir = tempDir("cov", {
    "demo2.ts": `
import { Y } from "./demo1";

export function covered() {
  // this function IS covered
  return Y;
}

export function uncovered() {
  // this function is not covered
  return 42;
}

covered();
`,
    "demo1.ts": `
export class Y {
#hello;
};
    `,
  });
  const result = Bun.spawnSync([bunExe(), "test", "--coverage", "--coverage-reporter", "lcov", "./demo2.ts"], {
    cwd: dir,
    env: {
      ...bunEnv,
    },
    stdio: ["inherit", "inherit", "inherit"],
  });
  expect(result.exitCode).toBe(0);
  expect(result.signalCode).toBeUndefined();
  expect(normalizeBunSnapshot(readFileSync(path.join(dir, "coverage", "lcov.info"), "utf-8"), dir)).toMatchSnapshot(
    "lcov-coverage-reporter-output",
  );
});

// https://github.com/oven-sh/bun/issues/17502
describe("--coverage-reporter without --coverage turns coverage on", () => {
  const files = {
    "math.ts": `export function add(a: number, b: number) {
  return a + b;
}
export function sub(a: number, b: number) {
  return a - b;
}
`,
    "add.test.ts": `import { expect, test } from "bun:test";
import { add } from "./math";
test("add", () => {
  expect(add(1, 2)).toBe(3);
});
`,
    "sub.test.ts": `import { expect, test } from "bun:test";
import { sub } from "./math";
test("sub", () => {
  expect(sub(3, 2)).toBe(1);
});
`,
  };
  const cases = [
    { flags: ["--coverage-reporter=lcov"], lcov: true, table: false },
    { flags: ["--coverage-reporter", "lcov"], lcov: true, table: false },
    { flags: ["--coverage-reporter=text"], lcov: false, table: true },
    { flags: ["--coverage-reporter=text", "--coverage-reporter=lcov"], lcov: true, table: true },
    { flags: ["--coverage-reporter=lcov", "--parallel=2"], lcov: true, table: false },
  ];

  test.concurrent.each(cases.map(c => [c.flags.join(" "), c] as const))(
    "bun test %s",
    async (_, { flags, lcov, table }) => {
      using dir = tempDir("cov-reporter-alone", files);
      await using proc = Bun.spawn({
        cmd: [bunExe(), "test", ...flags],
        env: bunEnv,
        cwd: String(dir),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      const report = Bun.file(path.join(String(dir), "coverage", "lcov.info"));
      expect({
        lcov: (await report.exists()) && (await report.text()).includes("SF:math.ts"),
        table: / math\.ts +\| +100\.00 +\| +100\.00 +\|/.test(stderr),
        exitCode,
      }).toEqual({ lcov, table, exitCode: 0 });
    },
  );
});

// https://github.com/oven-sh/bun/issues/4099
describe("html coverage reporter", () => {
  const unescapeHTML = (text: string) =>
    text
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"')
      .replaceAll("&#x27;", "'")
      .replaceAll("&amp;", "&");

  // The index: the name of every file, the path of its page, its numbers and which of them are red ("low").
  function indexRows(index: string) {
    const row =
      /<tr><td><a href="([^"]*)">(.*?)<\/a><\/td><td class="num (ok|low)">([\d.]+)<\/td><td class="num count">(\d+\/\d+)<\/td><td class="num (ok|low)">([\d.]+)<\/td><td class="num count">(\d+\/\d+)<\/td><td class="bar"><progress class="(ok|low)" max="1" value="([\d.]+)">/g;
    return [...index.matchAll(row)].map(
      ([
        ,
        href,
        name,
        functionsClass,
        percentFunctions,
        functions,
        linesClass,
        percentLines,
        lines,
        barClass,
        bar,
      ]) => ({
        name: unescapeHTML(name).replaceAll("\\", "/"),
        page: decodeURIComponent(unescapeHTML(href)),
        percent: `${percentFunctions} | ${percentLines}`,
        functions,
        lines,
        classes: `${functionsClass} ${linesClass} ${barClass}`,
        bar: (Number(bar) * 100).toFixed(2),
      }),
    );
  }

  // The page of a file: "hit", "miss" or "" for every line of its source, and the text of the line.
  function sourceRows(page: string) {
    const row =
      /<tr id="L(\d+)"(?: class="(hit|miss)")?><td class="n"><a href="#L\1">\1<\/a><\/td><td class="c">(.*?)<\/td><\/tr>/gs;
    return [...page.matchAll(row)].map(([, , state = "", text]) => ({ state, text: unescapeHTML(text) }));
  }

  // The page of a file: what follows "Uncovered lines:", as the text reporter writes it, and where its links go.
  function uncoveredRanges(page: string) {
    const list = /<p class="uncovered">Uncovered lines: (.*?)<\/p>/.exec(page)?.[1] ?? "";
    return {
      ranges: list.replaceAll(/<[^>]*>/g, "").replaceAll(", ", ","),
      links: [...list.matchAll(/<a href="([^"]*)">(\d+)/g)].map(([, href, first]) => href === `#L${first}`),
    };
  }

  // The text table by file: "% Funcs | % Lines" and the uncovered lines.
  function tableRows(stderr: string) {
    const rows: Record<string, { percent: string; uncovered: string }> = {};
    for (const line of stderr.split("\n")) {
      const cells = line.split("|").map(cell => cell.trim());
      if (cells.length !== 4 || !/^[\d.]+$/.test(cells[1])) continue;
      rows[cells[0].replaceAll("\\", "/")] = { percent: `${cells[1]} | ${cells[2]}`, uncovered: cells[3] };
    }
    return rows;
  }

  // lcov.info by file: functions and lines hit/found, and "hit" or "miss" for every line it lists.
  function lcovRecords(dir: string) {
    const records: Record<string, { functions: string; lines: string; states: Record<string, string> }> = {};
    const lcov = readFileSync(path.join(dir, "coverage", "lcov.info"), "utf-8");
    for (const record of lcov.split("end_of_record")) {
      const file = /^SF:(.*)$/m.exec(record)?.[1];
      if (!file) continue;
      const count = (key: string) => new RegExp(`^${key}:(\\d+)$`, "m").exec(record)![1];
      records[file.replaceAll("\\", "/")] = {
        functions: `${count("FNH")}/${count("FNF")}`,
        lines: `${count("LH")}/${count("LF")}`,
        states: Object.fromEntries(
          [...record.matchAll(/^DA:(\d+),(\d+)$/gm)].map(([, line, hits]) => [line, hits === "0" ? "miss" : "hit"]),
        ),
      };
    }
    return records;
  }

  async function run(cwd: string, ...args: string[]) {
    await using proc = Bun.spawn({
      cmd: [bunExe(), "test", ...args],
      // Start both workers at once instead of when the first one is busy.
      env: { ...bunEnv, BUN_TEST_PARALLEL_SCALE_MS: "0" },
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    return { stdout, stderr, exitCode };
  }

  const project = {
    "bunfig.toml": `[test]\ncoverageSkipTestFiles = true\n`,
    "src/math.ts": `export function add(a: number, b: number) {
  return a + b;
}

// A comment is not executable.
export function subtract(a: number, b: number) {
  return a - b;
}
`,
    "src/text/escape.ts": `export const tag = "<script>alert('&')</script>";

export function never(list: string[]) {
  return list.length > 0 && list[0] < tag;
}
`,
    "add.test.ts": `import { expect, test } from "bun:test";
import { add } from "./src/math";

test("add", () => {
  expect(add(1, 2)).toBe(3);
});
`,
    "tag.test.ts": `import { expect, test } from "bun:test";
import { tag } from "./src/text/escape";

test("tag", () => {
  expect(tag).toStartWith("<script>");
});
`,
  };

  test.concurrent.each([
    ["in one process", []],
    ["with --parallel", ["--parallel=2"]],
  ])("writes an index and a page for every file %s", async (_, flags) => {
    using dir = tempDir("cov-html", project);
    const { stderr, exitCode } = await run(
      String(dir),
      "--coverage-reporter=html",
      "--coverage-reporter=lcov",
      "--coverage-reporter=text",
      ...flags,
    );
    const read = (file: string) => readFileSync(path.join(String(dir), "coverage", file), "utf-8");
    const index = read("index.html");
    const table = tableRows(stderr);
    const lcov = lcovRecords(String(dir));

    // The numbers are the ones the other two reporters give, and below the default threshold of 90% they are red.
    const files = ["src/math.ts", "src/text/escape.ts"] as const;
    expect(indexRows(index)).toEqual(
      files.map(name => ({
        name,
        page: `${name}.html`,
        percent: table[name].percent,
        functions: lcov[name].functions,
        lines: lcov[name].lines,
        classes: "low low low",
        bar: table[name].percent.split(" | ")[1],
      })),
    );
    const allFiles =
      /<tr><td>All files<\/td><td class="num low">([\d.]+)<\/td><td class="count"><\/td><td class="num low">([\d.]+)<\/td>/;
    expect(index.match(allFiles)?.slice(1).join(" | ")).toBe(table["All files"].percent);

    // Every line of a source is a row, marked as lcov.info lists it.
    for (const name of files) {
      const page = read(`${name}.html`);
      const lines = project[name].split("\n").slice(0, -1);
      expect(sourceRows(page)).toEqual(lines.map((text, i) => ({ state: lcov[name].states[i + 1] ?? "", text })));
      expect(uncoveredRanges(page)).toEqual({ ranges: table[name].uncovered, links: [true] });
    }
    const math = read("src/math.ts.html");
    expect(sourceRows(math).map(row => row.state)).toEqual(["hit", "hit", "", "", "", "miss", "miss", ""]);
    expect(math).toContain(`<p class="uncovered">Uncovered lines: <a href="#L6">6-7</a></p>`);
    expect(math).toContain(`<dd class="low">50.00% <small>1/2</small></dd>`);
    expect(math).toContain(`<dd class="low">50.00% <small>2/4</small></dd>`);

    // The source is text: a page has no script, and the index has its own alone.
    const escapePage = read("src/text/escape.ts.html");
    expect(escapePage).toContain(
      `<td class="c">export const tag = &quot;&lt;script&gt;alert(&#x27;&amp;&#x27;)&lt;/script&gt;&quot;;</td>`,
    );
    expect(escapePage).not.toContain("<script");
    expect(escapePage).toContain(
      `<nav><a href="../../index.html">All files</a></nav>\n<h1>${path.join("src", "text", "escape.ts")}</h1>`,
    );
    expect(index.match(/<script/g)).toHaveLength(1);
    expect(exitCode).toBe(0);
  });

  test.concurrent("coverageThreshold decides which numbers are red, and fails the run", async () => {
    using dir = tempDir("cov-html", {
      ...project,
      "bunfig.toml": `[test]\ncoverageSkipTestFiles = true\ncoverageThreshold = { lines = 0.5, functions = 0.5 }\n`,
    });
    const { exitCode } = await run(String(dir), "--coverage-reporter=html", "--coverage-dir=reports");
    const read = (file: string) => readFileSync(path.join(String(dir), "reports", file), "utf-8");
    const index = read("index.html");

    expect(indexRows(index).map(({ name, percent, classes }) => ({ name, percent, classes }))).toEqual([
      { name: "src/math.ts", percent: "50.00 | 50.00", classes: "ok ok ok" },
      { name: "src/text/escape.ts", percent: "0.00 | 33.33", classes: "low low low" },
    ]);
    expect(index).toContain(`<tr><td>All files</td><td class="num low">25.00</td>`);
    expect(read("src/math.ts.html")).toContain(
      `<div><dt>Functions</dt><dd class="ok">50.00% <small>1/2</small></dd></div>\n` +
        `<div><dt>Lines</dt><dd class="ok">50.00% <small>2/4</small></dd></div>`,
    );
    expect(exitCode).toBe(1);
  });

  test.concurrent("a second run overwrites its pages and leaves no temporary file", async () => {
    using dir = tempDir("cov-html", project);
    const coverage = path.join(String(dir), "coverage");
    const written = () =>
      readdirSync(coverage, { recursive: true })
        .map(file => String(file).replaceAll("\\", "/"))
        .sort();

    const first = await run(String(dir), "--coverage-reporter=html", "add.test.ts");
    expect(written()).toEqual(["index.html", "src", "src/math.ts.html"]);

    writeFileSync(path.join(String(dir), "src", "math.ts"), `${project["src/math.ts"]}export const more = 1;\n`);
    const second = await run(String(dir), "--coverage-reporter=html");
    expect(written()).toEqual(["index.html", "src", "src/math.ts.html", "src/text", "src/text/escape.ts.html"]);
    expect(sourceRows(readFileSync(path.join(coverage, "src", "math.ts.html"), "utf-8")).at(-1)?.text).toBe(
      "export const more = 1;",
    );
    expect([first.exitCode, second.exitCode]).toEqual([0, 0]);
  });

  test.concurrent("names that HTML, a URL or a file system cannot take as they are", async () => {
    // Windows takes no "<", ">" or ":" in a file name, no name of a device, and no name of 230 bytes in a temporary directory.
    const markup = isWindows ? "it's 100% &amp; ünï.ts" : "it's 100% <b>&amp; ünï.ts";
    const long = Buffer.alloc(230, "n").toString();
    const posix = {
      "src/a:b.ts": `export const colon = 2;\n`,
      "src/a_b.ts": `export const underscore = 3;\n`,
      "src/aux/con.ts": `export const device = 4;\n`,
      "src/x.html/inside.ts": `export const inside = 5;\n`,
      [`src/${long}1.ts`]: `export const first = 6;\n`,
      [`src/${long}2.ts`]: `export const second = 7;\n`,
    };
    using dir = tempDir("cov-html", {
      "bunfig.toml": `[test]\ncoverageSkipTestFiles = true\n`,
      [`src/${markup}`]: `export const markup = 1;\n`,
      ...(isWindows ? {} : posix),
      "names.test.ts": `import { expect, test } from "bun:test";
import { markup } from ${JSON.stringify(`./src/${markup}`)};
${Object.keys(isWindows ? {} : posix)
  .map(file => `import ${JSON.stringify(`./${file}`)};`)
  .join("\n")}

test("names", () => {
  expect(markup).toBe(1);
});
`,
    });
    const { stderr, exitCode } = await run(String(dir), "--coverage-reporter=html");
    const coverage = path.join(String(dir), "coverage");
    const index = readFileSync(path.join(coverage, "index.html"), "utf-8");
    const rows = indexRows(index);

    const short = Buffer.alloc(200, "n").toString();
    expect({ stderr, rows: rows.map(({ name, page }) => ({ name, page })) }).toEqual({
      stderr: expect.stringContaining("1 pass"),
      rows: [
        ...(isWindows
          ? []
          : [
              // Two names that become one: the second one is numbered.
              { name: "src/a:b.ts", page: "src/a_b.ts.html" },
              { name: "src/a_b.ts", page: "src/a_b.ts-2.html" },
              { name: "src/aux/con.ts", page: "src/_aux/_con.ts.html" },
            ]),
        { name: `src/${markup}`, page: isWindows ? `src/${markup}.html` : "src/it's 100% _b_&amp; ünï.ts.html" },
        ...(isWindows
          ? []
          : [
              { name: `src/${long}1.ts`, page: `src/${short}.html` },
              { name: `src/${long}2.ts`, page: `src/${short}-2.html` },
              // A page is a file that ends in .html, so a directory of pages does not.
              { name: "src/x.html/inside.ts", page: "src/x.html_/inside.ts.html" },
            ]),
      ],
    });
    // Every link of the index leads to a page that is about the file the link names.
    for (const { name, page } of rows) {
      const title = /<title>(.*?)<\/title>/.exec(readFileSync(path.join(coverage, page), "utf-8"))?.[1];
      expect(title).not.toMatch(/[<>'"]/);
      expect(unescapeHTML(title!).replaceAll("\\", "/")).toBe(name);
    }
    const encoded = isWindows ? "it&#x27;s%20100%25%20%26amp%3B" : "it&#x27;s%20100%25%20_b_%26amp%3B";
    expect(index).toContain(`<a href="src/${encoded}%20%C3%BCn%C3%AF.ts.html">`);
    expect(exitCode).toBe(0);
  });

  test.concurrent("a file outside the project directory has a page inside the coverage directory", async () => {
    using dir = tempDir("cov-html", {
      "packages/app/bunfig.toml": `[test]\ncoverageSkipTestFiles = true\n`,
      "packages/app/src/app.ts": `import { shared } from "../../shared/shared";
export const app = () => shared() + 1;
`,
      "packages/app/app.test.ts": `import { expect, test } from "bun:test";
import { app } from "./src/app";

test("app", () => {
  expect(app()).toBe(2);
});
`,
      "packages/shared/shared.ts": `export const shared = () => 1;\n`,
    });
    const cwd = path.join(String(dir), "packages", "app");
    const { exitCode } = await run(cwd, "--coverage-reporter=html");
    const read = (file: string) => readFileSync(path.join(cwd, "coverage", file), "utf-8");

    // In the order of the names, as the header of the column says.
    expect(indexRows(read("index.html")).map(({ name, page }) => ({ name, page }))).toEqual([
      { name: "../shared/shared.ts", page: "shared/shared.ts.html" },
      { name: "src/app.ts", page: "app/src/app.ts.html" },
    ]);
    expect(read("app/src/app.ts.html")).toContain(`<a href="../../index.html">All files</a>`);
    expect(read("shared/shared.ts.html")).toContain(`<a href="../index.html">All files</a>`);
    expect(exitCode).toBe(0);
  });

  test.concurrent("coverageReporter and coverageDir in bunfig.toml", async () => {
    const bunfig = `[test]\ncoverageSkipTestFiles = true\ncoverageReporter = ["html"]\ncoverageDir = "reports/coverage"\n`;
    using dir = tempDir("cov-html", { ...project, "bunfig.toml": bunfig });
    using nothingToReport = tempDir("cov-html", {
      ...project,
      "bunfig.toml": `${bunfig}coveragePathIgnorePatterns = ["**"]\n`,
    });
    const [all, none] = await Promise.all([String(dir), String(nothingToReport)].map(cwd => run(cwd, "--coverage")));
    const index = (cwd: string) => readFileSync(path.join(cwd, "reports", "coverage", "index.html"), "utf-8");

    expect(indexRows(index(String(dir))).map(row => row.page)).toEqual(["src/math.ts.html", "src/text/escape.ts.html"]);
    expect(all.stderr).not.toContain("% Funcs");
    // Without a file the text reporter prints 0.00 for "All files" in green.
    expect(indexRows(index(String(nothingToReport)))).toEqual([]);
    expect(index(String(nothingToReport))).toContain(
      `<tr><td>All files</td><td class="num ok">0.00</td><td class="count"></td><td class="num ok">0.00</td>`,
    );
    expect([all.exitCode, none.exitCode]).toEqual([0, 0]);
  });

  test.concurrent("a page says why it does not show a source, and has no links to lines then", async () => {
    const files = (bunfig: string, during: string) => ({
      "bunfig.toml": `[test]\ncoverageSkipTestFiles = true\ncoverageReporter = "html"\n${bunfig}`,
      "src/changes.ts": `export function one() {
  return 1;
}

export function two() {
  return 2;
}
`,
      "changes.test.ts": `import { expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { one } from "./src/changes";

test("changes", () => {
  expect(one()).toBe(1);
  const file = import.meta.dir + "/src/changes.ts";
  ${during}
});
`,
    });
    using shown = tempDir("cov-html", files("", ""));
    using removed = tempDir("cov-html", files("", "rmSync(file);"));
    using shortened = tempDir("cov-html", files("", `writeFileSync(file, "// one line\\n");`));
    using transpiled = tempDir("cov-html", files("coverageIgnoreSourcemaps = true\n", ""));
    const dirs = [shown, removed, shortened, transpiled].map(String);
    const runs = await Promise.all(dirs.map(dir => run(dir, "--coverage")));

    expect(
      dirs.map((dir, i) => {
        const page = readFileSync(path.join(dir, "coverage", "src", "changes.ts.html"), "utf-8");
        return {
          note: /<p class="note">(.*?)<\/p>/.exec(page)?.[1],
          rows: sourceRows(page).length,
          uncovered: uncoveredRanges(page),
          exitCode: runs[i].exitCode,
        };
      }),
    ).toEqual([
      { note: undefined, rows: 7, uncovered: { ranges: "5-6", links: [true] }, exitCode: 0 },
      {
        note: "The file could not be read, so its source is not shown.",
        rows: 0,
        uncovered: { ranges: "5-6", links: [] },
        exitCode: 0,
      },
      {
        note: "The file has fewer lines than the code that ran, so its source is not shown.",
        rows: 0,
        uncovered: { ranges: "5-6", links: [] },
        exitCode: 0,
      },
      {
        note: "coverageIgnoreSourcemaps is set: the line numbers are those of the transpiled code, so the source is not shown.",
        rows: 0,
        uncovered: { ranges: expect.stringMatching(/^\d/), links: [] },
        exitCode: 0,
      },
    ]);
  });

  test.concurrent("a module that is not a file has a page next to the index, and no file is read for it", async () => {
    using dir = tempDir("cov-html", {
      "bunfig.toml": `[test]\ncoverageSkipTestFiles = true\npreload = ["./preload.ts"]\n`,
      "preload.ts": `import { plugin } from "bun";

plugin({
  name: "virtual",
  setup(build) {
    build.module("virtual-math", () => ({
      contents: "export function add(a, b) {\\n  return a + b;\\n}\\n",
      loader: "js",
    }));
  },
});
`,
      // A file where the name of the module would be a path.
      "virtual-math": `not the module\n// line 2\n// line 3\n`,
      "virtual.test.ts": `import { expect, test } from "bun:test";
import { add } from "virtual-math";

test("virtual", async () => {
  const data = await import("data:text/javascript,export const one = () => 1; //../../outside");
  expect(add(1, 2) + data.one()).toBe(4);
});
`,
    });
    const { stderr, exitCode } = await run(String(dir), "--coverage-reporter=html");
    const coverage = path.join(String(dir), "coverage");
    const rows = indexRows(readFileSync(path.join(coverage, "index.html"), "utf-8"));

    expect({ stderr, rows: rows.map(({ name, page }) => ({ name, page })) }).toEqual({
      stderr: expect.stringContaining("1 pass"),
      rows: expect.arrayContaining([
        { name: "virtual-math", page: "virtual-math.html" },
        {
          name: "data:text/javascript,export const one = () => 1; //../../outside",
          page: "data_text_javascript,export const one = () =_ 1; __.._.._outside.html",
        },
      ]),
    });
    for (const { page } of rows.filter(row => !row.name.endsWith("preload.ts"))) {
      const text = readFileSync(path.join(coverage, page), "utf-8");
      expect(text).toContain(`<p class="note">This module is not a file, so there is no source to show.</p>`);
      expect(text).not.toContain("not the module");
    }
    expect(exitCode).toBe(0);
  });

  // Bun sizes the report of such a file for 2^31 lines, which takes a debug build 15 seconds to walk.
  test.skipIf(isDebug || isASAN).concurrent("a bundle that names a source map of its own is not shown", async () => {
    using dir = tempDir("cov-html", {
      "bunfig.toml": `[test]\ncoverageSkipTestFiles = true\n`,
      // What `bun build --target=bun --sourcemap=inline` makes of a src/two.ts that has `two` on its second line.
      "dist/two.js": `// @bun
// src/two.ts
function two() {
  return 2;
}
export {
  two
};

//# debugId=DCE865C90336C71D64756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vc3JjL3R3by50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsKICAgICIvLyBUaGUgYnVuZGxlIGhhcyB0aGlzIGZ1bmN0aW9uIG9uIGFub3RoZXIgbGluZSB0aGFuIHRoaXMgZmlsZS5cbmV4cG9ydCBmdW5jdGlvbiB0d28oKSB7XG4gIHJldHVybiAyO1xufVxuIgogIF0sCiAgIm1hcHBpbmdzIjogIjs7QUFDTyxTQUFTLEdBQUcsR0FBRztBQUFBLEVBQ3BCLE9BQU87QUFBQTsiLAogICJkZWJ1Z0lkIjogIkRDRTg2NUM5MDMzNkM3MUQ2NDc1NkUyMTY0NzU2RTIxIiwKICAibmFtZXMiOiBbXQp9
`,
      "bundle.test.ts": `import { expect, test } from "bun:test";
import { two } from "./dist/two.js";

test("bundle", () => {
  expect(two()).toBe(2);
});
`,
    });
    const { stderr, exitCode } = await run(String(dir), "--coverage-reporter=html");
    const page = readFileSync(path.join(String(dir), "coverage", "dist", "two.js.html"), "utf-8");

    expect(stderr).toContain("1 pass");
    expect(/<p class="note">(.*?)<\/p>/.exec(page)?.[1]).toBe(
      "This file names a source map of its own: the line numbers are those of the sources it was made from, so the file is not shown.",
    );
    expect(sourceRows(page)).toEqual([]);
    expect(exitCode).toBe(0);
  });

  test.concurrent("a row is a line as the report numbers it, whatever the bytes of the file", async () => {
    const lines = ["export function crlf() {", "  return 1;", "}", "export function cr() {", "  return 2;", "}"];
    const bytes = (...parts: (string | number[])[]) => Buffer.concat(parts.map(part => Buffer.from(part)));
    using dir = tempDir("cov-html", {
      "bunfig.toml": `[test]\ncoverageSkipTestFiles = true\n`,
      // A byte order mark, \r\n, \r, U+2028 and U+2029.
      "src/endings.ts": `\uFEFF${lines.slice(0, 3).join("\r\n")}\r\n${lines.slice(3, 6).join("\r")}\r// \u2028// \u2029`,
      // UTF-16, which the module loader converts.
      "src/utf16.js": bytes(
        [0xff, 0xfe],
        Buffer.from(`export function wide() {\n  return "\u00e9\u0a0a";\n}\n`, "utf16le"),
      ),
      // Latin-1: the line table reads the \n after the 0xE9 as a part of its character.
      "src/latin1.js": bytes("// caf", [0xe9], "\nexport function latin() {\n\treturn 1;\n}\n"),
      // A NUL, a byte that is no UTF-8, and a last line without a terminator.
      "src/zero.js": bytes(`export const zero = () => "a\0b"; // `, [0xff], "\nexport const last = () => 2;"),
      "bytes.test.ts": `import { expect, test } from "bun:test";
import { cr, crlf } from "./src/endings";
import { latin } from "./src/latin1.js";
import { wide } from "./src/utf16.js";
import { last, zero } from "./src/zero.js";

test("bytes", () => {
  expect(crlf() + cr() + latin() + last()).toBe(6);
  expect(zero() + wide()).toBe("a\\0b\u00e9\u0a0a");
});
`,
    });
    const { stderr, exitCode } = await run(String(dir), "--coverage-reporter=html", "--coverage-reporter=lcov");
    const lcov = lcovRecords(String(dir));
    const rows = (name: string) =>
      sourceRows(readFileSync(path.join(String(dir), "coverage", "src", `${name}.html`), "utf-8"));
    const marked = (name: string, texts: string[]) =>
      texts.map((text, i) => ({ state: lcov[`src/${name}`].states[i + 1] ?? "", text }));

    expect(stderr).toContain("1 pass");
    expect(rows("endings.ts")).toEqual(marked("endings.ts", [...lines, "// ", "// "]));
    expect(rows("utf16.js")).toEqual(marked("utf16.js", ["export function wide() {", `  return "\u00e9\u0a0a";`, "}"]));
    expect(rows("latin1.js")).toEqual(
      marked("latin1.js", ["// caf\uFFFD\nexport function latin() {", "\treturn 1;", "}"]),
    );
    expect(rows("zero.js")).toEqual(
      marked("zero.js", [`export const zero = () => "a\uFFFDb"; // \uFFFD`, "export const last = () => 2;"]),
    );
    // The marks are not lcov.info's alone: the first two lines of these functions ran.
    expect(rows("endings.ts").slice(0, 2)).toEqual([
      { state: "hit", text: lines[0] },
      { state: "hit", text: lines[1] },
    ]);
    expect(rows("utf16.js").map(row => row.state)).toEqual(["hit", "hit", ""]);
    expect(exitCode).toBe(0);
  });

  test.concurrent.each([
    ["in one process", []],
    ["with --parallel", ["--parallel=2"]],
  ])("fails when a page cannot be written %s", async (_, flags) => {
    using dir = tempDir("cov-html", {
      ...project,
      "bunfig.toml": `[test]\ncoverageSkipTestFiles = true\ncoverageDir = "blocked/coverage"\n`,
      "blocked": "a file where the coverage directory would go",
    });
    const { stderr, exitCode } = await run(String(dir), "--coverage-reporter=html", ...flags);

    expect(stderr).toContain("Failed to write blocked/coverage/src/math.ts.html");
    expect(exitCode).toBe(1);
  });

  test
    .skipIf(isWindows)
    .concurrent("ends with an error when the coverage directory is a dangling symlink", async () => {
      using dir = tempDir("cov-html", project);
      symlinkSync("missing", path.join(String(dir), "coverage"));
      const { stderr, exitCode } = await run(String(dir), "--coverage-reporter=html");

      expect(stderr).toContain("Failed to write coverage/src/math.ts.html");
      expect(exitCode).toBe(1);
    });

  test.concurrent("a reporter that is not text, lcov or html is an error", async () => {
    using onTheCommandLine = tempDir("cov-html", project);
    using inBunfig = tempDir("cov-html", {
      ...project,
      "bunfig.toml": `[test]\ncoverageReporter = ["html", "HTML"]\n`,
    });
    const [flag, bunfig] = await Promise.all([
      run(String(onTheCommandLine), "--coverage-reporter=html", "--coverage-reporter=htm"),
      run(String(inBunfig)),
    ]);

    expect(flag.stderr).toContain(
      "error: invalid coverage reporter 'htm'. Available options: 'text' (console output), 'lcov' (code coverage file), 'html' (browsable report)",
    );
    expect(bunfig.stderr).toContain(`Invalid coverage reporter "HTML"`);
    expect([flag.exitCode, bunfig.exitCode]).toEqual([1, 1]);
  });
});

test("coverage excludes node_modules directory", () => {
  using dir = tempDir("cov", {
    "node_modules/pi/index.js": `
    export const pi = 3.14;
    `,
    "demo.test.ts": `
    import { pi } from 'pi';
    console.log(pi);
    `,
  });
  const result = Bun.spawnSync([bunExe(), "test", "--coverage"], {
    cwd: dir,
    env: {
      ...bunEnv,
    },
    stdio: [null, null, "pipe"],
  });
  expect(result.stderr.toString("utf-8")).toContain("demo.test.ts");
  expect(result.stderr.toString("utf-8")).not.toContain("node_modules");
  expect(result.exitCode).toBe(0);
  expect(result.signalCode).toBeUndefined();
});

test("coveragePathIgnorePatterns - single pattern string", () => {
  using dir = tempDir("cov", {
    "bunfig.toml": `
[test]
coveragePathIgnorePatterns = "ignore-me.ts"
coverageSkipTestFiles = false
`,
    "include-me.ts": `
export function includeMe() {
  return "included";
}
`,
    "ignore-me.ts": `
export function ignoreMe() {
  return "ignored";
}
`,
    "test.test.ts": `
import { test, expect } from "bun:test";
import { includeMe } from "./include-me";
import { ignoreMe } from "./ignore-me";

test("should call both functions", () => {
  expect(includeMe()).toBe("included");
  expect(ignoreMe()).toBe("ignored");
});
`,
  });

  const result = Bun.spawnSync([bunExe(), "test", "--coverage"], {
    cwd: dir,
    env: {
      ...bunEnv,
    },
    stdio: [null, null, "pipe"],
  });

  let stderr = result.stderr.toString("utf-8");
  // Normalize output for cross-platform consistency
  stderr = normalizeBunSnapshot(stderr, dir);

  expect(stderr).toMatchInlineSnapshot(`
"test.test.ts:
(pass) should call both functions
---------------|---------|---------|-------------------
File           | % Funcs | % Lines | Uncovered Line #s
---------------|---------|---------|-------------------
All files      |  100.00 |  100.00 |
 include-me.ts |  100.00 |  100.00 | 
 test.test.ts  |  100.00 |  100.00 | 
---------------|---------|---------|-------------------

 1 pass
 0 fail
 2 expect() calls
Ran 1 test across 1 file."
`);
  expect(result.exitCode).toBe(0);
});

test("coveragePathIgnorePatterns - partial coverage without nan", () => {
  using dir = tempDir("cov", {
    "bunfig.toml": `
[test]
coveragePathIgnorePatterns = "ignore-me.ts"
coverageSkipTestFiles = false
`,
    "include-me.ts": `
export function includeMe() {
  return "included";
}

export function neverCalled() {
  return "never called";
}
`,
    "ignore-me.ts": `
export function ignoreMe() {
  return "ignored";
}
`,
    "test.test.ts": `
import { test, expect } from "bun:test";
import { includeMe } from "./include-me";
import { ignoreMe } from "./ignore-me";

test("should call only some functions", () => {
  expect(includeMe()).toBe("included");
  expect(ignoreMe()).toBe("ignored");
  // Note: neverCalled() is not called, so coverage should be partial
});
`,
  });

  const result = Bun.spawnSync([bunExe(), "test", "--coverage"], {
    cwd: dir,
    env: {
      ...bunEnv,
    },
    stdio: [null, null, "pipe"],
  });

  let stderr = result.stderr.toString("utf-8");
  // Normalize output for cross-platform consistency
  stderr = normalizeBunSnapshot(stderr, dir);

  expect(stderr).toMatchInlineSnapshot(`
"test.test.ts:
(pass) should call only some functions
---------------|---------|---------|-------------------
File           | % Funcs | % Lines | Uncovered Line #s
---------------|---------|---------|-------------------
All files      |   75.00 |   75.00 |
 include-me.ts |   50.00 |   50.00 | 6-7
 test.test.ts  |  100.00 |  100.00 | 
---------------|---------|---------|-------------------

 1 pass
 0 fail
 2 expect() calls
Ran 1 test across 1 file."
`);
  expect(result.exitCode).toBe(0);
});

test("coveragePathIgnorePatterns - array of patterns", () => {
  using dir = tempDir("cov", {
    "bunfig.toml": `
[test]
coveragePathIgnorePatterns = ["utils/**", "*.config.ts"]
coverageSkipTestFiles = false
`,
    "src/main.ts": `
export function main() {
  return "main";
}
`,
    "utils/helper.ts": `
export function helper() {
  return "helper";
}
`,
    "build.config.ts": `
export const config = { build: true };
`,
    "test.test.ts": `
import { test, expect } from "bun:test";
import { main } from "./src/main";
import { helper } from "./utils/helper";
import { config } from "./build.config";

test("should call all functions", () => {
  expect(main()).toBe("main");
  expect(helper()).toBe("helper");
  expect(config.build).toBe(true);
});
`,
  });

  const result = Bun.spawnSync([bunExe(), "test", "--coverage"], {
    cwd: dir,
    env: {
      ...bunEnv,
    },
    stdio: [null, null, "pipe"],
  });

  let stderr = result.stderr.toString("utf-8");
  // Normalize output for cross-platform consistency
  stderr = normalizeBunSnapshot(stderr, dir);

  expect(stderr).toMatchInlineSnapshot(`
"test.test.ts:
(pass) should call all functions
--------------|---------|---------|-------------------
File          | % Funcs | % Lines | Uncovered Line #s
--------------|---------|---------|-------------------
All files     |  100.00 |  100.00 |
 src/main.ts  |  100.00 |  100.00 | 
 test.test.ts |  100.00 |  100.00 | 
--------------|---------|---------|-------------------

 1 pass
 0 fail
 3 expect() calls
Ran 1 test across 1 file."
`);
  expect(result.exitCode).toBe(0);
});

test("coveragePathIgnorePatterns - glob patterns", () => {
  using dir = tempDir("cov", {
    "bunfig.toml": `
[test]
coveragePathIgnorePatterns = ["**/*.spec.ts", "test-utils/**"]
coverageSkipTestFiles = false
`,
    "src/feature.ts": `
export function feature() {
  return "feature";
}
`,
    "src/feature.spec.ts": `
export function featureSpec() {
  return "spec";
}
`,
    "test-utils/index.ts": `
export function testUtils() {
  return "utils";
}
`,
    "main.test.ts": `
import { test, expect } from "bun:test";
import { feature } from "./src/feature";
import { featureSpec } from "./src/feature.spec";
import { testUtils } from "./test-utils";

test("should call all functions", () => {
  expect(feature()).toBe("feature");
  expect(featureSpec()).toBe("spec");
  expect(testUtils()).toBe("utils");
});
`,
  });

  const result = Bun.spawnSync([bunExe(), "test", "--coverage"], {
    cwd: dir,
    env: {
      ...bunEnv,
    },
    stdio: [null, null, "pipe"],
  });

  let stderr = result.stderr.toString("utf-8");
  // Normalize output for cross-platform consistency
  stderr = normalizeBunSnapshot(stderr, dir);

  expect(stderr).toMatchInlineSnapshot(`
"main.test.ts:
(pass) should call all functions

src/feature.spec.ts:
----------------|---------|---------|-------------------
File            | % Funcs | % Lines | Uncovered Line #s
----------------|---------|---------|-------------------
All files       |  100.00 |  100.00 |
 main.test.ts   |  100.00 |  100.00 | 
 src/feature.ts |  100.00 |  100.00 | 
----------------|---------|---------|-------------------

 1 pass
 0 fail
 3 expect() calls
Ran 1 test across 2 files."
`);
  expect(result.exitCode).toBe(0);
});

test("coveragePathIgnorePatterns - lcov reporter", () => {
  using dir = tempDir("cov", {
    "bunfig.toml": `
[test]
coveragePathIgnorePatterns = "ignore-me.ts"
coverageSkipTestFiles = false
`,
    "include-me.ts": `
export function includeMe() {
  return "included";
}
`,
    "ignore-me.ts": `
export function ignoreMe() {
  return "ignored";
}
`,
    "test.test.ts": `
import { test, expect } from "bun:test";
import { includeMe } from "./include-me";
import { ignoreMe } from "./ignore-me";

test("should call both functions", () => {
  expect(includeMe()).toBe("included");
  expect(ignoreMe()).toBe("ignored");
});
`,
  });

  const result = Bun.spawnSync([bunExe(), "test", "--coverage", "--coverage-reporter", "lcov"], {
    cwd: dir,
    env: {
      ...bunEnv,
    },
    stdio: [null, null, "pipe"],
  });

  let lcovContent = readFileSync(path.join(dir, "coverage", "lcov.info"), "utf-8");
  // Normalize LCOV content for cross-platform consistency
  lcovContent = normalizeBunSnapshot(lcovContent, dir);

  expect(lcovContent).toMatchInlineSnapshot(`
"TN:
SF:include-me.ts
FNF:1
FNH:1
DA:2,1
DA:3,1
LF:2
LH:2
end_of_record
TN:
SF:test.test.ts
FNF:1
FNH:1
DA:2,1
DA:3,1
DA:4,1
DA:6,1
DA:7,1
DA:8,1
DA:9,1
LF:7
LH:7
end_of_record"
`);
  expect(result.exitCode).toBe(0);
});

test("coveragePathIgnorePatterns - invalid config type", () => {
  using dir = tempDir("cov", {
    "bunfig.toml": `
[test]
coveragePathIgnorePatterns = 123
coverageSkipTestFiles = false
`,
    "test.test.ts": `
import { test, expect } from "bun:test";

test("should pass", () => {
  expect(true).toBe(true);
});
`,
  });

  const result = Bun.spawnSync([bunExe(), "test", "--coverage"], {
    cwd: dir,
    env: {
      ...bunEnv,
    },
    stdio: [null, null, "pipe"],
  });

  let stderr = result.stderr.toString("utf-8");
  // Normalize error output for cross-platform consistency
  stderr = normalizeBunSnapshot(stderr, dir);

  expect(stderr).toMatchInlineSnapshot(`
"3 | coveragePathIgnorePatterns = 123
                                 ^
error: coveragePathIgnorePatterns must be a string or array of strings
    at <dir>/bunfig.toml:3:30

Invalid Bunfig: failed to load bunfig"
`);
  expect(result.exitCode).toBe(1);
});

test("coveragePathIgnorePatterns - invalid array item", () => {
  using dir = tempDir("cov", {
    "bunfig.toml": `
[test]
coveragePathIgnorePatterns = ["valid-pattern", 123]
coverageSkipTestFiles = false
`,
    "test.test.ts": `
import { test, expect } from "bun:test";

test("should pass", () => {
  expect(true).toBe(true);
});
`,
  });

  const result = Bun.spawnSync([bunExe(), "test", "--coverage"], {
    cwd: dir,
    env: {
      ...bunEnv,
    },
    stdio: [null, null, "pipe"],
  });

  let stderr = result.stderr.toString("utf-8");
  // Normalize error output for cross-platform consistency
  stderr = normalizeBunSnapshot(stderr, dir);

  expect(stderr).toMatchInlineSnapshot(`
"3 | coveragePathIgnorePatterns = ["valid-pattern", 123]
                                                   ^
error: coveragePathIgnorePatterns array must contain only strings
    at <dir>/bunfig.toml:3:48

Invalid Bunfig: failed to load bunfig"
`);
  expect(result.exitCode).toBe(1);
});

test("coveragePathIgnorePatterns - empty array", () => {
  using dir = tempDir("cov", {
    "bunfig.toml": `
[test]
coveragePathIgnorePatterns = []
coverageSkipTestFiles = false
`,
    "include-me.ts": `
export function includeMe() {
  return "included";
}
`,
    "test.test.ts": `
import { test, expect } from "bun:test";
import { includeMe } from "./include-me";

test("should call function", () => {
  expect(includeMe()).toBe("included");
});
`,
  });

  const result = Bun.spawnSync([bunExe(), "test", "--coverage"], {
    cwd: dir,
    env: {
      ...bunEnv,
    },
    stdio: [null, null, "pipe"],
  });

  let stderr = result.stderr.toString("utf-8");
  // Normalize output for cross-platform consistency
  stderr = normalizeBunSnapshot(stderr, dir);

  expect(stderr).toMatchInlineSnapshot(`
"test.test.ts:
(pass) should call function
---------------|---------|---------|-------------------
File           | % Funcs | % Lines | Uncovered Line #s
---------------|---------|---------|-------------------
All files      |  100.00 |  100.00 |
 include-me.ts |  100.00 |  100.00 | 
 test.test.ts  |  100.00 |  100.00 | 
---------------|---------|---------|-------------------

 1 pass
 0 fail
 1 expect() calls
Ran 1 test across 1 file."
`);
  expect(result.exitCode).toBe(0);
});

test("coveragePathIgnorePatterns - ignore all files", () => {
  using dir = tempDir("cov", {
    "bunfig.toml": `
[test]
coveragePathIgnorePatterns = "**"
coverageSkipTestFiles = false
`,
    "include-me.ts": `
export function includeMe() {
  return "included";
}
`,
    "test.test.ts": `
import { test, expect } from "bun:test";
import { includeMe } from "./include-me";

test("should call function", () => {
  expect(includeMe()).toBe("included");
});
`,
  });

  const result = Bun.spawnSync([bunExe(), "test", "--coverage"], {
    cwd: dir,
    env: {
      ...bunEnv,
    },
    stdio: [null, null, "pipe"],
  });

  let stderr = result.stderr.toString("utf-8");
  // Normalize output for cross-platform consistency
  stderr = normalizeBunSnapshot(stderr, dir);

  expect(stderr).toMatchInlineSnapshot(`
"test.test.ts:
(pass) should call function
-----------|---------|---------|-------------------
File       | % Funcs | % Lines | Uncovered Line #s
-----------|---------|---------|-------------------
All files  |    0.00 |    0.00 |
-----------|---------|---------|-------------------

 1 pass
 0 fail
 1 expect() calls
Ran 1 test across 1 file."
`);
  expect(result.exitCode).toBe(0);
});

// https://github.com/oven-sh/bun/issues/39930
// One worker executes count(), the other only imports the module. The
// import-only worker reports the unexecuted function's whole line range
// (blank line 5 included) as executable with zero hits. The merge must not
// let that over-approximation mark the fully executed function as
// partially covered.
test("--parallel merges line coverage across workers", async () => {
  using dir = tempDir("cov-parallel-merge", {
    "subject.ts": `await Bun.sleep(100);

export default function count(values: string[]) {
  const count = values.length;

  return count;
}
`,
    "execute.test.ts": `
import { expect, test } from "bun:test";
import count from "./subject.ts";

test("executes the function", () => {
  expect(count(["first", "second"])).toBe(2);
});
`,
    "importOnly.test.ts": `
import { expect, test } from "bun:test";
import count from "./subject.ts";

test("only imports the function", () => {
  expect(typeof count).toBe("function");
});
`,
  });
  await using proc = Bun.spawn({
    cmd: [bunExe(), "test", "--coverage", "--coverage-reporter=text", "--coverage-reporter=lcov", "--parallel=2"],
    env: bunEnv,
    cwd: String(dir),
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([proc.stderr.text(), proc.exited]);

  const lcov = readFileSync(path.join(String(dir), "coverage", "lcov.info"), "utf-8");
  const record = lcov.split("end_of_record").find(r => r.includes("SF:subject.ts"));
  expect(record).toBeDefined();
  // Blank line 5 is only "executable" in the worker that never ran count().
  expect(record).not.toContain("DA:5,");
  expect(record).toMatch(/LF:4\nLH:4\n/);

  expect(stderr).toMatch(/ subject\.ts +\| +100\.00 +\| +100\.00 +\| +\n/);
  expect(exitCode).toBe(0);
});

// https://github.com/oven-sh/bun/issues/40586
// Each worker executes a different function of the same module; the merged
// report must count a function as covered if any worker ran it.
test("--parallel merges function coverage across workers", async () => {
  // Each test file waits at import time until the other has started, so the
  // two can only make progress in two different workers.
  const rendezvous = (me: string, other: string) => `
await Bun.write("${me}.started", "");
for (const deadline = Date.now() + 60_000; !(await Bun.file("${other}.started").exists()); ) {
  if (Date.now() > deadline) throw new Error("${other} never started in another worker");
  await Bun.sleep(5);
}
`;
  using dir = tempDir("cov-parallel-fn-merge", {
    "bunfig.toml": `[test]\ncoverageSkipTestFiles = true\ncoverageThreshold = { lines = 1.0, functions = 1.0 }\n`,
    "subject.ts": `export function first() {
  return 1;
}
export function second() {
  return 2;
}
`,
    "first.test.ts": `${rendezvous("first", "second")}
import { expect, test } from "bun:test";
import { first } from "./subject.ts";

test("calls first", () => {
  expect(first()).toBe(1);
});
`,
    "second.test.ts": `${rendezvous("second", "first")}
import { expect, test } from "bun:test";
import { second } from "./subject.ts";

test("calls second", () => {
  expect(second()).toBe(2);
});
`,
  });
  await using proc = Bun.spawn({
    cmd: [bunExe(), "test", "--coverage", "--coverage-reporter=text", "--coverage-reporter=lcov", "--parallel=2"],
    env: { ...bunEnv, BUN_TEST_PARALLEL_SCALE_MS: "0" },
    cwd: String(dir),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);

  expect(stderr).toContain("2 pass");
  expect(stderr).toMatch(/ subject\.ts +\| +100\.00 +\| +100\.00 +\| +\n/);
  const lcov = readFileSync(path.join(String(dir), "coverage", "lcov.info"), "utf-8");
  const record = lcov.split("end_of_record").find(r => r.includes("SF:subject.ts"));
  expect(record).toMatch(/FNF:2\nFNH:2\n/);
  expect(exitCode).toBe(0);
});

// JSC records coverage per SourceProvider, and a file has one for each time
// it is loaded. Each case has a subject file of its own. Where a case loads
// its subject twice, one load runs the `if` branch and the other runs the
// `return` after it.
test("what is after a rejected await at the top level of a module did not run", async () => {
  using dir = tempDir("cov-top-level-await", {
    "subject.ts": `let ran = 0;
export const first = await 1;
ran++;
try {
  await Promise.reject(new Error());
  ran++;
} catch {
  ran++;
}
export default await ran;
export { ran };
`,
    "subject.test.ts": `
import { expect, test } from "bun:test";
import ran from "./subject.ts";

test("ran", () => {
  expect(ran).toBe(2);
});
`,
  });
  await using proc = Bun.spawn({
    cmd: [bunExe(), "test", "--coverage", "--coverage-reporter=lcov"],
    env: bunEnv,
    cwd: String(dir),
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([proc.stderr.text(), proc.exited]);

  const lcov = readFileSync(path.join(String(dir), "coverage", "lcov.info"), "utf-8");
  const record = lcov.split("end_of_record").find(r => r.includes("SF:subject.ts"));
  expect(record?.match(/^DA:.*$/gm)).toEqual([
    "DA:1,1",
    "DA:2,1",
    "DA:3,1",
    "DA:4,1",
    "DA:5,1",
    "DA:6,0",
    "DA:7,1",
    "DA:8,1",
    "DA:10,1",
    "DA:11,1",
  ]);
  expect(stderr).toContain(" 1 pass");
  expect(exitCode).toBe(0);
});

describe("a file loaded more than once counts every load", () => {
  const esm = `export function covered(n: number): number {
  if (n > 5) {
    return n * 2;
  }
  return n + 1;
}
`;
  const cjs = `exports.covered = function covered(n) {
  if (n > 5) {
    return n * 2;
  }
  return n + 1;
};
`;
  const compiledText =
    Buffer.alloc(12, "\n").toString() +
    "exports.other = function other(n) {\n  if (n > 5) {\n    return 1;\n  }\n  return 2;\n};\nexports.other(1);\n";

  const files = {
    "host-and-graph.ts": esm,
    "two-graphs.ts": esm,
    "cjs-host-and-graph.cjs": cjs,
    "query-strings.ts": esm,
    "overlapping-imports.ts": esm,
    "require-cache.cjs": cjs,
    // https://github.com/oven-sh/bun/issues/35345
    "issue-35345.ts": `export const MODULE_SCOPE = "evaluated";

export function fnA(x: number): number {
  const a = x + 1;
  return a * 2;
}

export function fnB(x: number): number {
  const b = x + 10;
  return b * 3;
}
`,
    "functions.ts": `export function first() {
  return 1;
}
export function second() {
  return 2;
}
export function third() {
  return 3;
}
`,
    "cjs-graph-alone.cjs": cjs,
    "compile-target.cjs": cjs,
    "compile.cjs": `
const Module = require("node:module");
exports.compileAs = (filename, text) => {
  const module = new Module(filename);
  module.filename = filename;
  module._compile(text, filename);
  return module.exports;
};
`,
    // With ONE_LOAD=1 the last three cases leave out the load under test, to compare against.
    "loads.test.ts": `
import { expect, test } from "bun:test";
import { codeCoverageForFile } from "bun:jsc";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { covered as hostAndGraph } from "./host-and-graph.ts";
import { first } from "./functions.ts";
const cjsHostAndGraph = require("./cjs-host-and-graph.cjs");
const compileTarget = require("./compile-target.cjs");

const oneLoad = !!process.env.ONE_LOAD;
// codeCoverageForFile() takes the path as the module loader spells it.
const here = name => join(import.meta.dir, name);

test("host-and-graph.ts", async () => {
  expect(hostAndGraph(1)).toBe(2);
  const hostAlone = codeCoverageForFile(here("host-and-graph.ts"), false);
  using graph = new Bun.ModuleGraph({});
  const subject = await graph.import(here("host-and-graph.ts"));
  expect(graph.run(() => subject.covered(10))).toBe(20);
  console.log(JSON.stringify({ hostAlone, both: codeCoverageForFile(here("host-and-graph.ts"), false) }));
  expect(() => codeCoverageForFile(here("never-loaded.ts"), false)).toThrow("No source for file");
});

test("two-graphs.ts", async () => {
  using a = new Bun.ModuleGraph({});
  using b = new Bun.ModuleGraph({});
  const inA = await a.import(here("two-graphs.ts"));
  const inB = await b.import(here("two-graphs.ts"));
  expect(a.run(() => inA.covered(10))).toBe(20);
  expect(b.run(() => inB.covered(1))).toBe(2);
});

test("cjs-host-and-graph.cjs", async () => {
  expect(cjsHostAndGraph.covered(1)).toBe(2);
  using graph = new Bun.ModuleGraph({});
  const subject = await graph.import(here("cjs-host-and-graph.cjs"));
  expect(graph.run(() => subject.covered(10))).toBe(20);
});

test("query-strings.ts", async () => {
  const a = await import("./query-strings.ts?a");
  const b = await import("./query-strings.ts?b");
  expect(a.covered).not.toBe(b.covered);
  expect(a.covered(10)).toBe(20);
  expect(b.covered(1)).toBe(2);
});

test("overlapping-imports.ts", async () => {
  const [a, b] = await Promise.all([import("./overlapping-imports.ts"), import("./overlapping-imports.ts")]);
  expect(a).toBe(b);
  expect(a.covered(10)).toBe(20);
  expect(b.covered(1)).toBe(2);
});

test("issue-35345.ts", async () => {
  const first = await import("./issue-35345.ts?bun-spec=1");
  expect(first.fnA(1)).toBe(4);
  const second = await import("./issue-35345.ts?bun-spec=2");
  expect(second.fnB(1)).toBe(33);
});

test("require-cache.cjs", () => {
  const a = require("./require-cache.cjs");
  delete require.cache[require.resolve("./require-cache.cjs")];
  const b = require("./require-cache.cjs");
  expect(a.covered).not.toBe(b.covered);
  expect(a.covered(10)).toBe(20);
  expect(b.covered(1)).toBe(2);
});

test("functions.ts", async () => {
  expect(first()).toBe(1);
  using graph = new Bun.ModuleGraph({});
  const subject = await graph.import(here("functions.ts"));
  expect(graph.run(() => subject.second())).toBe(2);
});

test("cjs-graph-alone.cjs", async () => {
  if (oneLoad) {
    expect(require("./cjs-graph-alone.cjs").covered(10)).toBe(20);
    return;
  }
  using graph = new Bun.ModuleGraph({});
  const subject = await graph.import(here("cjs-graph-alone.cjs"));
  expect(graph.run(() => subject.covered(10))).toBe(20);
});

test("compile-target.cjs", async () => {
  expect(compileTarget.covered(1)).toBe(2);
  if (oneLoad) return;
  using graph = new Bun.ModuleGraph({});
  const { compileAs } = await graph.import(here("compile.cjs"));
  const compiled = graph.run(() => compileAs(here("compile-target.cjs"), ${JSON.stringify(compiledText)}));
  expect(compiled.other(10)).toBe(1);
});

test("changed.ts", async () => {
  if (!oneLoad) {
    writeFileSync(here("changed.ts"), ${JSON.stringify(esm)});
    const before = await import("./changed.ts?before");
    expect(before.covered(10)).toBe(20);
  }
  writeFileSync(here("changed.ts"), ${JSON.stringify("export function unused() {\n  return 0;\n}\n" + esm)});
  const after = await import("./changed.ts?after");
  expect(after.covered(1)).toBe(2);
});
`,
  };

  // A plugin's onLoad result gets a new SourceProvider for every load, under --isolate too.
  // https://github.com/oven-sh/bun/issues/40386
  const pluginFiles = {
    "bunfig.toml": `[test]\npreload = ["./plugin.ts"]\n`,
    "plugin.ts": `
import { plugin } from "bun";

plugin({
  name: "passthrough",
  setup(build) {
    build.onLoad({ filter: /plugin-loaded\\.ts$/ }, async ({ path }) => {
      return { contents: await Bun.file(path).text(), loader: "ts" };
    });
  },
});
`,
    "plugin-loaded.ts": esm,
    "a.test.ts": `
import { expect, test } from "bun:test";
import { covered } from "./plugin-loaded.ts";

test("a", () => {
  expect(covered(10)).toBe(20);
});
`,
    "b.test.ts": `
import { expect, test } from "bun:test";
import { covered } from "./plugin-loaded.ts";

test("b", () => {
  expect(covered(1)).toBe(2);
});
`,
  };

  type Row = { functions: string; lines: string; uncovered: string };
  async function run(fixture: Record<string, string>, args: string[], env: Record<string, string> = {}) {
    using dir = tempDir("cov-loaded-twice", fixture);
    await using proc = Bun.spawn({
      cmd: [bunExe(), "test", "--coverage", "--coverage-reporter=text", "--coverage-reporter=lcov", ...args],
      env: { ...bunEnv, ...env },
      cwd: String(dir),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    if (exitCode !== 0) throw new Error(stderr);
    const rows: Record<string, Row> = {};
    for (const line of stderr.split("\n")) {
      const [file, functions, lines, uncovered] = line.split("|").map(column => column.trim());
      if (uncovered !== undefined) rows[file] = { functions, lines, uncovered };
    }
    const lcov: Record<string, string> = {};
    for (const record of readFileSync(path.join(String(dir), "coverage", "lcov.info"), "utf-8").split(
      "end_of_record",
    )) {
      const file = record.match(/^SF:(.+)$/m)?.[1];
      if (file) lcov[file] = record;
    }
    return { rows, lcov, stdout };
  }

  let loaded: Awaited<ReturnType<typeof run>>;
  let oneLoad: Awaited<ReturnType<typeof run>>;
  let pluginUnderIsolate: Awaited<ReturnType<typeof run>>;
  beforeAll(async () => {
    [loaded, oneLoad, pluginUnderIsolate] = await Promise.all([
      run(files, ["./loads.test.ts"]),
      run(files, ["./loads.test.ts"], { ONE_LOAD: "1" }),
      run(pluginFiles, ["--isolate", "./a.test.ts", "./b.test.ts"]),
    ]);
  });

  const fullyCovered: Row = { functions: "100.00", lines: "100.00", uncovered: "" };

  describe.each([
    ["by the host and by a Bun.ModuleGraph", "host-and-graph.ts"],
    ["by two Bun.ModuleGraphs", "two-graphs.ts"],
    ["CommonJS, by the host and by a Bun.ModuleGraph", "cjs-host-and-graph.cjs"],
    ["under two query strings", "query-strings.ts"],
    ["by two overlapping import()s", "overlapping-imports.ts"],
    ["again after a require.cache delete", "require-cache.cjs"],
  ])("%s", (_, file) => {
    test("is fully covered", () => {
      expect(loaded.rows[file]).toEqual(fullyCovered);
    });
  });

  test("from a plugin's onLoad, by two test files under --isolate", () => {
    expect(pluginUnderIsolate.rows["plugin-loaded.ts"]).toEqual(fullyCovered);
  });

  test("lcov has the functions and the lines of both loads (#35345)", () => {
    expect(loaded.lcov["issue-35345.ts"]).toMatch(/FNF:2\nFNH:2\n/);
    expect(loaded.lcov["issue-35345.ts"]).not.toMatch(/DA:\d+,0\n/);
  });

  test("a function counts if any load ran it, and not if none did", () => {
    // The host runs first(), a graph runs second(). third() spans lines 7 to 9.
    expect(loaded.rows["functions.ts"]).toEqual({
      functions: "66.67",
      lines: expect.any(String),
      uncovered: expect.stringMatching(/^[789](-[89])?$/),
    });
  });

  test("CommonJS, by a Bun.ModuleGraph alone, reports what the host alone reports", () => {
    expect(oneLoad.rows["cjs-graph-alone.cjs"].uncovered).not.toBe("");
    expect(loaded.rows["cjs-graph-alone.cjs"]).toEqual(oneLoad.rows["cjs-graph-alone.cjs"]);
  });

  // module._compile() names a file and brings a text of its own, which no
  // line table describes. In a graph it runs under a wrapping SourceProvider,
  // like the graph's load of the file itself, and must not count as one.
  test("module._compile() in a Bun.ModuleGraph does not count as a load of the file it names", () => {
    expect(oneLoad.rows["compile-target.cjs"].uncovered).not.toBe("");
    expect(loaded.rows["compile-target.cjs"]).toEqual(oneLoad.rows["compile-target.cjs"]);
  });

  // The line table and the source map on record describe one text, so a load
  // of another text starts the file's coverage over.
  test("a file that changed between two loads reports the last text alone", () => {
    expect(oneLoad.rows["changed.ts"].functions).toBe("50.00");
    expect(loaded.rows["changed.ts"]).toEqual(oneLoad.rows["changed.ts"]);
  });

  test("bun:jsc codeCoverageForFile()", () => {
    expect(JSON.parse(loaded.stdout.split("\n").find(line => line.startsWith("{"))!)).toEqual({
      hostAlone: expect.stringMatching(/host-and-graph\.ts \| +100\.00 \| +\d+\.\d+ \| \d/),
      both: expect.stringMatching(/host-and-graph\.ts \| +100\.00 \| +100\.00 \| $/),
    });
  });
});

test("prints the report when a data: URL is longer than the path buffer", async () => {
  using dir = tempDir("cov-long-data", {
    "bunfig.toml": `[test]\ncoverageSkipTestFiles = false\n`,
    "data.test.ts": `
import { test, expect } from "bun:test";

test("imports a data: URL", async () => {
  const url = "data:text/javascript," + encodeURIComponent("export default 1; //") + Buffer.alloc(${MAX_PATH_BYTES}, "x").toString();
  expect((await import(url)).default).toBe(1);
});
`,
  });
  await using proc = Bun.spawn({
    cmd: [bunExe(), "test", "--coverage", "--coverage-reporter=text", "--coverage-reporter=lcov"],
    cwd: String(dir),
    env: bunEnv,
    stdout: "ignore",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([proc.stderr.text(), proc.exited]);
  expect(stderr).toContain(" 1 pass");
  expect(readFileSync(path.join(String(dir), "coverage", "lcov.info"), "utf-8")).toContain("SF:data.test.ts\n");
  expect(exitCode).toBe(0);
});

test("reports an uncalled function on the last line of a // @bun file without a final newline", async () => {
  using dir = tempDir("cov-no-final-newline", {
    "prebuilt.js": "// @bun\nexport function first() {\n  return 1;\n}\nexport const second = () => 2;",
    "a.test.ts": `
      import { expect, test } from "bun:test";
      import { first } from "./prebuilt.js";
      test("calls first", () => { expect(first()).toBe(1); });
    `,
  });
  await using proc = Bun.spawn({
    cmd: [bunExe(), "test", "--coverage"],
    env: bunEnv,
    cwd: String(dir),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([proc.stderr.text(), proc.exited]);
  expect(stderr).toMatch(/prebuilt\.js +\| +50\.00 \|/);
  expect(exitCode).toBe(0);
});

// `braces.ts` in `source-positions-corpus.ts` has this for a file that Bun transpiles and reports by its source map.
test.concurrent.each(["// @bun", "// @bun with a source map", "coverageIgnoreSourcemaps"])(
  "both braces of an object are listed and no brace of a block is: %s",
  async mode => {
    // Laid out as the printer prints it, so that the lines are the same with coverageIgnoreSourcemaps.
    const lib = `export function f() {
  {
    globalThis.list = [
      {
        one: 1
      }
    ];
  }
  for (const item of globalThis.list) {
    return item;
  }
}
`;
    using dir = tempDir("cov-braces", {
      "lib.test.ts": `
        import { expect, test } from "bun:test";
        import { f } from "./lib.js";
        test("f", () => { expect(f()).toEqual({ one: 1 }); });
      `,
      ...(mode === "// @bun"
        ? { "lib.js": "// @bun\n" + lib + "await 0;\nif (false) globalThis.list = [\n  {\n  }\n];\n" }
        : mode === "// @bun with a source map"
          ? { "src/lib.js": lib }
          : { "lib.js": lib, "bunfig.toml": "[test]\ncoverageIgnoreSourcemaps = true\n" }),
    });
    if (mode === "// @bun with a source map") {
      await using build = Bun.spawn({
        cmd: [bunExe(), "build", "./src/lib.js", "--target=bun", "--sourcemap=linked", "--outdir=."],
        env: bunEnv,
        cwd: String(dir),
        stdout: "ignore",
        stderr: "inherit",
      });
      expect(await build.exited).toBe(0);
      expect(readFileSync(path.join(String(dir), "lib.js"), "utf-8")).toStartWith("// @bun\n");
    }
    await using proc = Bun.spawn({
      cmd: [bunExe(), "test", "--coverage", "--coverage-reporter=lcov"],
      env: bunEnv,
      cwd: String(dir),
      stdout: "ignore",
      stderr: "inherit",
    });
    const exitCode = await proc.exited;

    const lcov = readFileSync(path.join(String(dir), "coverage", "lcov.info"), "utf-8");
    const record = lcov.split("end_of_record").find(r => r.includes("lib.js\n"));
    expect(record).toBeDefined();
    const above = mode === "// @bun" ? 1 : 0;
    const count = (line: number) => record!.match(new RegExp(`^DA:${line + above},(\\d+)$`, "m"))?.[1];
    expect([2, 4, 6, 8, 11, 12].map(count)).toEqual([undefined, "1", "1", undefined, undefined, undefined]);
    if (mode === "// @bun") {
      expect(record).toContain("DA:16,0");
      expect(record).toContain("DA:17,0");
    }
    expect(exitCode).toBe(0);
  },
);

test("the braces of an object are listed when the file comes from the transpiler cache", async () => {
  using dir = tempDir("cov-transpiler-cache", {
    // The cache leaves out a file of less than 4 KB.
    "lib.ts": `export const list = [
  {
    one: 1,
  },
];
// ${Buffer.alloc(4096, "-")}
`,
    "lib.test.ts": `
import { test } from "bun:test";
import { list } from "./lib.ts";
test("list", () => { Object(list); });
`,
  });
  const cache = path.join(String(dir), "cache");
  const run = async () => {
    await using proc = Bun.spawn({
      cmd: [bunExe(), "test", "--coverage", "--coverage-reporter=lcov"],
      env: {
        ...bunEnv,
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: cache,
        // A debug build only writes the cache without it.
        BUN_DEBUG_ENABLE_RESTORE_FROM_TRANSPILER_CACHE: "1",
      },
      cwd: String(dir),
      stdout: "ignore",
      stderr: "inherit",
    });
    const exitCode = await proc.exited;
    const lcov = readFileSync(path.join(String(dir), "coverage", "lcov.info"), "utf-8");
    return { record: lcov.split("end_of_record").find(r => r.includes("lib.ts\n")), exitCode };
  };
  // A run that does not take the entry writes it again.
  const written = () =>
    readdirSync(cache).map(name => [name, statSync(path.join(cache, name), { bigint: true }).mtimeNs]);
  const printed = await run();
  const entries = written();
  expect(entries).not.toBeEmpty();
  expect(printed.record).toContain("DA:2,1\n");
  expect(printed.record).toContain("DA:4,1\n");
  expect(await run()).toEqual(printed);
  expect(written()).toEqual(entries);
  expect(printed.exitCode).toBe(0);
});

test("objects that are not in the file do not move the lines that are listed", async () => {
  using dir = tempDir("cov-generated-objects", {
    "macro.ts": `export const make = () => ({ a: { b: 1 }, c: [{}] });`,
    "lib.ts": `// 1
// 2
// 3
// 4
import { make } from "./macro.ts" with { type: "macro" };
declare const DEFINED: object;
export const made = make();
export const defined =
  DEFINED;
export const list = [
  {
    one: 1,
  },
];
`,
    "lib.test.ts": `
import { test } from "bun:test";
import * as lib from "./lib.ts";
test("lib", () => { Object(lib); });
`,
  });
  await using proc = Bun.spawn({
    cmd: [
      bunExe(),
      "test",
      "--coverage",
      "--coverage-reporter=lcov",
      "--define",
      'DEFINED={"a":1, "b":  { "c": [{  }] }}',
    ],
    env: bunEnv,
    cwd: String(dir),
    stdout: "ignore",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  const lcov = readFileSync(path.join(String(dir), "coverage", "lcov.info"), "utf-8");
  const record = lcov.split("end_of_record").find(r => r.includes("lib.ts\n"));
  expect(record!.match(/^DA:.*$/gm)).toEqual([7, 8, 9, 10, 11, 12, 13, 14].map(line => `DA:${line},1`));
  expect(exitCode).toBe(0);
});

test("node:inspector turns the profiler on and no brace is listed", async () => {
  const lib = `export const never = () => (
  {
    one: 1,
  }
);
`;
  using dir = tempDir("cov-inspector", {
    "lib.ts": lib,
    "bundled.js": "// @bun\n" + lib,
    "main.ts": `
import { codeCoverageForFile } from "bun:jsc";
import inspector from "node:inspector";
import { join } from "node:path";
const session = new inspector.Session();
session.connect();
session.post("Profiler.enable");
session.post("Profiler.startPreciseCoverage");
for (const file of ["lib.ts", "bundled.js"]) {
  await import("./" + file);
  console.log(codeCoverageForFile(join(import.meta.dir, file), false).split("|").at(-1));
}
`,
  });
  await using proc = Bun.spawn({
    cmd: [bunExe(), "main.ts"],
    env: bunEnv,
    cwd: String(dir),
    stdout: "pipe",
    stderr: "inherit",
  });
  const [stdout, exitCode] = await Promise.all([proc.stdout.text(), proc.exited]);
  expect(stdout).toBe(" 3\n 4\n");
  expect(exitCode).toBe(0);
});

test("an error has the same position with --coverage", async () => {
  using dir = tempDir("cov-error-position", {
    "lib.ts": `export function disposes() {
  {
    using thrower = { [Symbol.dispose]() { throw new Error("disposed"); } };
    Object(thrower);
  }
}
`,
    "lib.test.ts": `
import { test } from "bun:test";
import { disposes } from "./lib.ts";
test("disposes", () => {
  try {
    disposes();
  } catch (error) {
    console.log(error.stack.split("\\n").find(line => line.includes("at disposes")));
  }
});
`,
  });
  const [plain, covered] = await Promise.all(
    [[], ["--coverage"]].map(async flags => {
      await using proc = Bun.spawn({
        cmd: [bunExe(), "test", ...flags],
        env: bunEnv,
        cwd: String(dir),
        stdout: "pipe",
        stderr: "ignore",
      });
      const [stdout, exitCode] = await Promise.all([proc.stdout.text(), proc.exited]);
      return { frame: stdout.split("\n").find(line => line.includes("at disposes")), exitCode };
    }),
  );
  expect(plain.frame).toEndWith("lib.ts:5:3)");
  expect(covered).toEqual(plain);
  expect(plain.exitCode).toBe(0);
});

test("reports an error for a coverage directory longer than the path buffer", async () => {
  // A bunfig value can be longer than the buffer on every platform.
  using dir = tempDir("coverage-dir-too-long", {
    "bunfig.toml": `[test]\ncoverageDir = "${Buffer.alloc(100_000, "c").toString()}"\n`,
    "lib.ts": `export const covered = () => 1;`,
    "covered.test.ts": `
      import { test, expect } from "bun:test";
      import { covered } from "./lib";
      test("covered", () => { expect(covered()).toBe(1); });
    `,
  });
  await using proc = Bun.spawn({
    cmd: [bunExe(), "test", "--coverage", "--coverage-reporter=lcov"],
    env: bunEnv,
    cwd: String(dir),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([proc.stderr.text(), proc.exited]);

  expect(stderr).toContain("(pass) covered");
  expect(stderr).toContain("ENAMETOOLONG: File name too long: Failed to write lcov.info");
  expect(exitCode).toBe(1);
});

// https://github.com/oven-sh/bun/issues/7662
// In these fixtures a line that has to be missing from the report says
// "ignored", and a line that has to be reported as never run says "uncovered".
function linesThatSay(source: string, word: string) {
  return source.split("\n").flatMap((text, index) => (text.includes(word) ? [index + 1] : []));
}

// What lcov.info says about `file`: functions hit/found, the lines with no
// hits, and the lines it lists although the source says they are ignored.
function readLcov(dir: string, file: string, source: string) {
  const lcov = readFileSync(path.join(dir, "coverage", "lcov.info"), "utf-8");
  const record = lcov.split("end_of_record").find(record => record.includes(`SF:${file}\n`));
  if (!record) return undefined;
  const lines = [...record.matchAll(/^DA:(\d+),(\d+)$/gm)].map(match => [Number(match[1]), Number(match[2])]);
  const ignored = linesThatSay(source, "ignored");
  return {
    functions: `${/^FNH:(\d+)$/m.exec(record)![1]}/${/^FNF:(\d+)$/m.exec(record)![1]}`,
    uncovered: lines.filter(([, hits]) => hits === 0).map(([line]) => line),
    ignoredButListed: lines.map(([line]) => line).filter(line => ignored.includes(line)),
  };
}

const ignoreHintFixtures = {
  "bunfig.toml": `[test]\ncoverageSkipTestFiles = true\n`,
  "lines.ts": `export function run(flag: boolean) {
  if (flag) {
    /* v8 ignore next */
    console.log("ignored");
    console.log("uncovered");
  }
  if (flag) {
    // c8 ignore next 2
    console.log("ignored");
    console.log("ignored");
    console.log("uncovered");
  }
  if (flag) {
    console.log("ignored: the hint is after code"); /* istanbul ignore next */
    console.log("uncovered");
  }
  /* node:coverage disable */
  if (flag) { // ignored
    console.log("ignored");
  } // ignored
  /* node:coverage enable */
  /** v8 ignore start -- a reason, or @preserve for other tools */
  if (flag) { // ignored
    console.log("ignored");
  } // ignored
  /* v8 ignore stop */
  if (flag) {
    /* node:coverage ignore next 1 */
    console.log("ignored");
    console.log("uncovered");
  }
  if (flag) {
    /* istanbul ignore next: with a reason */
    console.log("ignored");
    console.log("ignored: after a string with // in it", "http://host/*"); // v8 ignore next
    console.log("uncovered");
  }
  return "done";
}
`,
  // A function that starts on an ignored line is ignored with its body and
  // with the functions inside it, whether it ran (debug) or not.
  "functions.ts": `export class Shape {
  sides: number;
  constructor() {
    this.sides = 4;
  }
  area() {
    return this.sides;
  }
  /* v8 ignore next */
  debug() { // ignored
    const inner = () => { // ignored
      return "ignored";
    }; // ignored
    return inner(); // ignored
  }
  // The first token of these has no source mapping of its own. Each is
  // followed by a method that is not ignored and has to stay in the report.
  get corners() {
    return this.sides;
  }
  /* v8 ignore next */
  async ignoredAsync() {
    return "ignored";
  }
  get edges() {
    return this.sides;
  }
  /* v8 ignore next */
  static async *ignoredGenerator() {
    yield "ignored";
  }
  set edges(value: number) {
    this.sides = value;
  }
  /* v8 ignore next */
  get ignoredGetter() {
    return "ignored";
  }
  ["computed"]() {
    return this.sides;
  }
  /* v8 ignore next */
  ["ignoredComputed"]() {
    return "ignored";
  }
  perimeter() {
    return this.sides;
  }
}

// c8 ignore next
export const ignoredArrow = (x: number) => {
  return "ignored" + x;
};

/* istanbul ignore next */
export function ignoredDeclaration() {
  return "ignored";
}
`,
  // A function at the very start of the transpiled code.
  "first-statement.ts": `/* v8 ignore next */
function ignoredHelper() {
  return "ignored";
}
export function used() {
  return 1;
}
`,
  // A module without functions. The hint is for line 2 and must not take the
  // whole file with it.
  "no-functions.ts": `/* v8 ignore next */
export const a = process.env.NEVER_SET_BY_ANYONE ?? "ignored";
export const b = 1;
export const c = b + 1;
`,
  // The function that wraps a CommonJS module has no line of its own: it
  // must not count as starting on line 2 and take the whole file with it.
  "commonjs.cjs": `/* v8 ignore next */
const optional = process.env.NEVER_SET_BY_ANYONE ? require("./never") : "ignored";
function used(flag) {
  if (flag) {
    return "uncovered";
  }
  return "used";
}
module.exports = { used, optional };
`,
  "crlf.js": `export function crlf(flag) {\r\n  if (flag) {\r\n    /* v8 ignore next */\r\n    console.log("ignored");\r\n    console.log("uncovered");\r\n  }\r\n  return 1;\r\n}\r\n`,
  "not-hints.ts": `export function notHints(flag: boolean) {
  if (flag) {
    /* v8 ignore if */
    console.log("uncovered");
    /* v8 ignores next */
    console.log("uncovered");
    /* eslint-disable-next-line -- v8 ignore next */
    console.log("uncovered");
    /* v8 ignore next
     */
    console.log("uncovered");
    /* v8 ignore stop */
    console.log("uncovered");
  }
  return 1;
}
`,
  "unterminated.ts": `export function first() {
  return 1;
}
/* v8 ignore start */
export function second() {
  return "ignored";
}
`,
  "whole-file.ts": `// A header comment.
/* istanbul ignore file */
export function a() {
  return 1;
}
export function b() {
  return 2;
}
`,
  "hints.test.ts": `
import { expect, test } from "bun:test";
import { run } from "./lines";
import { Shape } from "./functions";
import { used } from "./commonjs.cjs";
import { crlf } from "./crlf.js";
import { notHints } from "./not-hints";
import { first } from "./unterminated";
import { a } from "./whole-file";
import { used as usedAfterHelper } from "./first-statement";
import { c } from "./no-functions";

test("runs some of it", () => {
  expect(run(false)).toBe("done");
  const shape = new Shape();
  expect(shape.area()).toBe(4);
  expect(shape.debug()).toBe("ignored");
  shape.edges = 4;
  expect([shape.corners, shape.edges, shape.computed(), shape.perimeter()]).toEqual([4, 4, 4, 4]);
  expect(usedAfterHelper()).toBe(1);
  expect(c).toBe(2);
  expect(used(false)).toBe("used");
  expect(crlf(false)).toBe(1);
  expect(notHints(false)).toBe(1);
  expect(first()).toBe(1);
  expect(a()).toBe(1);
});
`,
  // A second file, so that --parallel has something to hand to a worker.
  "more.test.ts": `
import { expect, test } from "bun:test";
import { run } from "./lines";

test("runs it again", () => {
  expect(run(false)).toBe("done");
});
`,
};

test.concurrent.each([
  ["in one process", []],
  ["in --parallel workers", ["--parallel=2"]],
])("coverage ignore hints %s", async (_, flags) => {
  using dir = tempDir("cov-ignore-hints", ignoreHintFixtures);
  await using proc = Bun.spawn({
    cmd: [bunExe(), "test", "--coverage", "--coverage-reporter=text", "--coverage-reporter=lcov", ...flags],
    // Start both workers at once instead of when the first one is busy.
    env: { ...bunEnv, BUN_TEST_PARALLEL_SCALE_MS: "0" },
    cwd: String(dir),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);

  expect(stderr).toContain("2 pass");
  const functions = {
    "lines.ts": "1/1",
    // The constructor, area, corners, both edges, computed and perimeter.
    "functions.ts": "7/7",
    "first-statement.ts": "1/1",
    "commonjs.cjs": "1/1",
    "crlf.js": "1/1",
    "not-hints.ts": "1/1",
    "unterminated.ts": "1/1",
  };
  for (const [file, expected] of Object.entries(functions)) {
    const source = ignoreHintFixtures[file as keyof typeof ignoreHintFixtures];
    expect({ file, ...readLcov(String(dir), file, source) }).toEqual({
      file,
      functions: expected,
      uncovered: linesThatSay(source, "uncovered"),
      ignoredButListed: [],
    });
  }
  expect(readLcov(String(dir), "whole-file.ts", "")).toBeUndefined();
  // Line 2 is gone, lines 3 and 4 are still there.
  expect(readLcov(String(dir), "no-functions.ts", ignoreHintFixtures["no-functions.ts"])).toMatchObject({
    uncovered: [],
    ignoredButListed: [],
  });
  expect(stderr).toMatch(/ no-functions\.ts +\| +\d+\.\d+ +\| +100\.00 +\| *\n/);
  expect(stderr).toMatch(/ lines\.ts +\| +100\.00 +\| +\d+\.\d+ +\| 5,11,15,30,36\n/);
  expect(stderr).not.toContain("whole-file.ts");
  expect(exitCode).toBe(0);
});

test.concurrent("coverage ignore hints count towards coverageThreshold", async () => {
  const source = (hint: string) => `export function parse(input: string) {
  ${hint}
  if (typeof input !== "string") {
    throw new TypeError("never happens in the tests");
  }
  return input.trim();
}
`;
  const files = (hint: string) => ({
    "bunfig.toml": `[test]\ncoverageSkipTestFiles = true\ncoverageThreshold = 1.0\n`,
    "parse.ts": source(hint),
    "parse.test.ts": `
import { expect, test } from "bun:test";
import { parse } from "./parse";

test("parse", () => {
  expect(parse(" a ")).toBe("a");
});
`,
  });
  using without = tempDir("cov-ignore-threshold", files("// no hint here"));
  using withHint = tempDir("cov-ignore-threshold", files("/* v8 ignore next 3 */"));
  const run = async (cwd: string) => {
    await using proc = Bun.spawn({
      cmd: [bunExe(), "test", "--coverage"],
      env: bunEnv,
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    return { row: / parse\.ts +\|[^\n]*/.exec(stderr)?.[0].replace(/ +/g, " "), exitCode };
  };
  expect(await Promise.all([run(String(without)), run(String(withHint))])).toEqual([
    { row: " parse.ts | 100.00 | 75.00 | 4", exitCode: 1 },
    { row: " parse.ts | 100.00 | 100.00 | ", exitCode: 0 },
  ]);
});

// https://github.com/oven-sh/bun/issues/5928
describe("collectCoverageFrom", () => {
  // The table in stderr, one entry per row: `file | % Funcs | % Lines | Uncovered Line #s`.
  function tableRows(stderr: string) {
    return stderr
      .split("\n")
      .filter(line => line.startsWith(" ") && line.split("|").length === 4)
      .map(line =>
        line
          .replaceAll("\\", "/")
          .split("|")
          .map(cell => cell.trim())
          .join(" | ")
          .trimEnd(),
      );
  }

  // lcov.info by file: functions hit/found, lines hit/found and the lines it lists.
  function lcovRecords(dir: string) {
    const records: Record<string, { functions: string; lines: string; listed: number[] }> = {};
    const lcov = readFileSync(path.join(dir, "coverage", "lcov.info"), "utf-8");
    for (const record of lcov.split("end_of_record")) {
      const file = /^SF:(.*)$/m.exec(record)?.[1];
      if (!file) continue;
      const count = (key: string) => new RegExp(`^${key}:(\\d+)$`, "m").exec(record)![1];
      records[file.replaceAll("\\", "/")] = {
        functions: `${count("FNH")}/${count("FNF")}`,
        lines: `${count("LH")}/${count("LF")}`,
        listed: [...record.matchAll(/^DA:(\d+),\d+$/gm)].map(match => Number(match[1])),
      };
    }
    return records;
  }

  async function run(cwd: string, ...args: string[]) {
    await using proc = Bun.spawn({
      cmd: [bunExe(), "test", ...args],
      // Start both workers at once instead of when the first one is busy.
      env: { ...bunEnv, BUN_TEST_PARALLEL_SCALE_MS: "0" },
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    return { stdout, stderr, exitCode, rows: tableRows(stderr) };
  }

  const lcovFlags = ["--coverage", "--coverage-reporter=text", "--coverage-reporter=lcov"];

  const unused = `// Nothing imports this file.
import { used } from "./used";

export interface Shape {
  sides: number;
}

export function first(shape: Shape) {
  // A comment and an empty line in a function that never runs.

  return shape.sides + used();
}

export const second = () => {
  return 2;
};
`;
  const unusedRow = "src/unused.ts | 0.00 | 0.00 | 2,8,11,14-15";

  const project = {
    "bunfig.toml": `[test]
coverageSkipTestFiles = true
collectCoverageFrom = ["./src/**", "!src/generated/**"]
`,
    "src/used.ts": `export function used() {
  return 1;
}
export function notCalled() {
  return 2;
}
`,
    "src/unused.ts": unused,
    "src/unused.cjs": `function first() {
  return 1;
}
module.exports = { first };
`,
    "src/constants.ts": `export const one = 1;
export const two = one + 1;
`,
    "src/view.tsx": `export function View() {
  return <div>never rendered</div>;
}
`,
    // Nothing in these can run, so there is nothing to cover.
    "src/types.ts": `export interface OnlyTypes {
  name: string;
}
export type Maybe = OnlyTypes | null;
`,
    "src/augments.ts": `declare global {
  var fromSomewhere: number;
}
export {};
`,
    // Left out for its name: what is in it would have a row.
    "src/globals.d.ts": `export const notADeclaration = 1;\n`,
    "src/empty.ts": ``,
    "src/comments.ts": `// Only a comment.\n/* And another one. */\n`,
    // A file that nothing loads must not run because the report names it.
    "src/exits.ts": `console.log("a file that nothing loaded ran");
process.exit(3);
`,
    "src/does-not-parse.ts": `export function fine() {
  return 1;
}
export function broken( {
`,
    "src/calls-a-macro.ts": `import { macro } from "./used" with { type: "macro" };
export const value = macro();
`,
    "src/generated/out.ts": `export function generated() {
  return 1;
}
`,
    "src/node_modules/dependency/index.js": `export function dependency() {
  return 1;
}
`,
    "src/not-run.test.ts": `import { test } from "bun:test";
test("is not run", () => {});
`,
    "lib/outside.ts": `export function outside() {
  return 1;
}
`,
    "a.test.ts": `import { expect, test } from "bun:test";
import { outside } from "./lib/outside";
import { used } from "./src/used";

test("a", () => {
  expect(used() + outside()).toBe(2);
});
test("another", () => {});
`,
    "b.test.ts": `import { expect, test } from "bun:test";
import { used } from "./src/used";

test("b", () => {
  expect(used()).toBe(1);
});
`,
  };

  test.concurrent.each([
    ["in one process", []],
    ["with --isolate", ["--isolate"]],
    ["with --parallel", ["--parallel=2"]],
  ])("reports the files that nothing loaded %s", async (_, flags) => {
    using dir = tempDir("cov-collect-from", project);
    const { stdout, stderr, exitCode, rows } = await run(String(dir), "a.test.ts", "b.test.ts", ...lcovFlags, ...flags);

    expect(stderr).toContain("3 pass");
    // Not in it: lib/outside.ts, which is loaded and which the list does not
    // name, and what is in src/generated, in node_modules and in a test file.
    expect(rows).toEqual([
      "src/constants.ts | 100.00 | 0.00 | 1-2",
      "src/exits.ts | 100.00 | 0.00 | 1-2",
      "src/unused.cjs | 0.00 | 0.00 | 1-2,4",
      unusedRow,
      "src/used.ts | 50.00 | 50.00 | 4-5",
      "src/view.tsx | 0.00 | 0.00 | 1-2",
    ]);
    const records = lcovRecords(String(dir));
    expect(records).toEqual({
      // A module without functions has none to cover, as when it is loaded.
      "src/constants.ts": { functions: "0/0", lines: "0/2", listed: [1, 2] },
      "src/exits.ts": { functions: "0/0", lines: "0/2", listed: [1, 2] },
      // The function Bun wraps a CommonJS module in is not a function of the source.
      "src/unused.cjs": { functions: "0/1", lines: "0/3", listed: [1, 2, 4] },
      "src/unused.ts": { functions: "0/2", lines: "0/5", listed: [2, 8, 11, 14, 15] },
      "src/used.ts": { functions: "1/2", lines: "2/4", listed: [1, 2, 4, 5] },
      "src/view.tsx": { functions: "0/1", lines: "0/2", listed: [1, 2] },
    });
    // One line each, in the order of the paths, and then the table.
    expect(stderr).toContain(
      `warn: Failed to collect coverage from ${path.join("src", "calls-a-macro.ts")}:2:22: Macros are disabled\n` +
        `warn: Failed to collect coverage from ${path.join("src", "does-not-parse.ts")}:4:26: Expected identifier but found end of file\n` +
        "---",
    );
    expect(stderr.match(/warn:/g)).toHaveLength(2);
    expect(stdout).not.toContain("a file that nothing loaded ran");
    expect(exitCode).toBe(0);
  });

  test.concurrent("--collect-coverage-from replaces the list in bunfig.toml", async () => {
    using dir = tempDir("cov-collect-from", project);
    const [repeated, once, withoutCoverage] = await Promise.all([
      run(
        String(dir),
        "a.test.ts",
        "--coverage",
        "--collect-coverage-from",
        // A glob walk cannot follow a "/" in braces. The files are found all the same.
        "{src/generated,lib}/**",
        "--collect-coverage-from=lib/*.ts",
      ),
      run(String(dir), "a.test.ts", "--coverage", "--collect-coverage-from=src/u*.ts"),
      // The list asks for nothing by itself.
      run(String(dir), "a.test.ts", "--collect-coverage-from=src/u*.ts"),
    ]);
    expect({
      repeated: repeated.rows,
      once: once.rows,
      withoutCoverage: withoutCoverage.rows,
    }).toEqual({
      repeated: ["lib/outside.ts | 100.00 | 100.00 |", "src/generated/out.ts | 0.00 | 0.00 | 1-2"],
      once: [unusedRow, "src/used.ts | 50.00 | 50.00 | 4-5"],
      withoutCoverage: [],
    });
    expect(withoutCoverage.stderr).toContain("2 pass");
    expect(withoutCoverage.stderr).not.toContain("warn:");
    expect([repeated.exitCode, once.exitCode, withoutCoverage.exitCode]).toEqual([0, 0, 0]);
  });

  test.concurrent.each([
    ["with --parallel", ["--parallel=2"]],
    // One test file: --parallel runs it in this process.
    ["with --parallel and one test file", ["--parallel=2", "a.test.ts"]],
  ])("reads the list of --config %s", async (_, flags) => {
    using dir = tempDir("cov-collect-from", {
      ...project,
      "bunfig.toml": `[test]\ncoverageSkipTestFiles = true\n`,
      "other.toml": `[test]\ncoverageSkipTestFiles = true\ncollectCoverageFrom = "src/*.cjs"\n`,
    });
    const { rows, exitCode } = await run(String(dir), "--coverage", "--config=other.toml", ...flags);
    expect(rows).toEqual(["src/unused.cjs | 0.00 | 0.00 | 1-2,4"]);
    expect(exitCode).toBe(0);
  });

  test.concurrent("the last pattern that matches decides", async () => {
    using dir = tempDir("cov-collect-from", {
      "bunfig.toml": `[test]\ncoverageSkipTestFiles = true\n`,
      "src/a.ts": `export const a = 1;\n`,
      "src/generated/b.ts": `export const b = 1;\n`,
      "src/generated/kept.ts": `export const kept = 1;\n`,
      "tools/c.ts": `export const c = 1;\n`,
      "only.test.ts": `import { test } from "bun:test";\ntest("loads nothing", () => {});\n`,
    });
    const list = (...patterns: string[]) =>
      run(String(dir), "--coverage", ...patterns.map(pattern => `--collect-coverage-from=${pattern}`));
    const [included, excluded, negated] = await Promise.all([
      list("src/**", "!src/generated/**", "src/generated/kept.ts"),
      list("src/generated/kept.ts", "src/a.ts", "!src/generated/**"),
      // Every file that none of them names.
      list("!src/generated/**", "!**/a.ts"),
    ]);
    expect({
      included: included.rows,
      excluded: excluded.rows,
      negated: negated.rows,
    }).toEqual({
      included: ["src/a.ts | 100.00 | 0.00 | 1", "src/generated/kept.ts | 100.00 | 0.00 | 1"],
      excluded: ["src/a.ts | 100.00 | 0.00 | 1"],
      negated: ["tools/c.ts | 100.00 | 0.00 | 1"],
    });
  });

  test.concurrent("coveragePathIgnorePatterns applies to the files that nothing loaded", async () => {
    using dir = tempDir("cov-collect-from", {
      ...project,
      "bunfig.toml": `[test]
coverageSkipTestFiles = false
collectCoverageFrom = "src/*.ts"
coveragePathIgnorePatterns = ["src/u*", "src/does-not-parse.ts", "**/calls-a-macro.ts", "**/exits.ts"]
`,
    });
    const { rows, stderr, exitCode } = await run(String(dir), "a.test.ts", "--coverage");
    // With coverageSkipTestFiles off, a test file that did not run is a file that nothing loaded.
    expect(rows).toEqual(["src/constants.ts | 100.00 | 0.00 | 1-2", "src/not-run.test.ts | 0.00 | 0.00 | 1-2"]);
    expect(stderr).not.toContain("warn:");
    expect(exitCode).toBe(0);
  });

  test.concurrent("a file that nothing loaded counts towards coverageThreshold", async () => {
    using dir = tempDir("cov-collect-from", {
      "bunfig.toml": `[test]
coverageSkipTestFiles = true
coverageThreshold = 0.6
collectCoverageFrom = ["src/**"]
`,
      "src/used.ts": project["src/used.ts"],
      "src/unused.ts": unused,
      "a.test.ts": `import { expect, test } from "bun:test";
import { notCalled, used } from "./src/used";

test("a", () => {
  expect(used() + notCalled()).toBe(3);
});
`,
    });
    const { rows, stderr, exitCode } = await run(String(dir), "--coverage");
    expect(stderr).toContain("1 pass");
    expect(rows).toEqual([unusedRow, "src/used.ts | 100.00 | 100.00 |"]);
    expect(exitCode).toBe(1);
  });

  test.concurrent("a file that nothing loaded has a page in the html report", async () => {
    using dir = tempDir("cov-collect-from", {
      "bunfig.toml": `[test]\ncoverageSkipTestFiles = true\ncollectCoverageFrom = ["src/**"]\n`,
      "src/used.ts": project["src/used.ts"],
      "src/unused.ts": unused,
      "a.test.ts": `import { expect, test } from "bun:test";
import { used } from "./src/used";

test("a", () => {
  expect(used()).toBe(1);
});
`,
    });
    const { rows, exitCode } = await run(String(dir), ...lcovFlags, "--coverage-reporter=html");
    const read = (file: string) => readFileSync(path.join(String(dir), "coverage", file), "utf-8");
    const page = read("src/unused.ts.html");

    expect(rows[0]).toBe(unusedRow);
    expect(read("index.html")).toContain(
      `<a href="src/unused.ts.html">src/unused.ts</a></td><td class="num low">0.00</td>`,
    );
    // The lines that lcov.info lists are the lines that are marked, and none of them ran.
    expect([...page.matchAll(/<tr id="L(\d+)" class="miss">/g)].map(match => Number(match[1]))).toEqual(
      lcovRecords(String(dir))["src/unused.ts"].listed,
    );
    expect(page).not.toContain(`class="hit"`);
    expect(exitCode).toBe(0);
  });

  test.concurrent("a run has to run a test file to report the files that nothing loaded", async () => {
    using dir = tempDir("cov-collect-from", {
      "bunfig.toml": `[test]
coverageSkipTestFiles = true
collectCoverageFrom = ["src/**"]
coverageThreshold = 0.9
`,
      "src/unused.ts": unused,
      "only.test.ts": `import { test } from "bun:test";\ntest("one", () => {});\ntest("two", () => {});\n`,
    });
    const [emptyShard, someTests] = await Promise.all([
      run(String(dir), "--coverage", "--shard=2/2"),
      // The test file loads no file of the list. It has a report all the same.
      run(String(dir), ...lcovFlags, "-t", "one"),
    ]);
    expect({ rows: emptyShard.rows, exitCode: emptyShard.exitCode }).toEqual({ rows: [], exitCode: 0 });
    expect({ rows: someTests.rows, exitCode: someTests.exitCode }).toEqual({ rows: [unusedRow], exitCode: 1 });
    expect(lcovRecords(String(dir))).toEqual({
      "src/unused.ts": { functions: "0/2", lines: "0/5", listed: [2, 8, 11, 14, 15] },
    });
  });

  test.concurrent("a file has one row, and a test that changes directory moves nothing", async () => {
    using dir = tempDir("cov-collect-from", {
      "bunfig.toml": `[test]\ncoverageSkipTestFiles = true\ncollectCoverageFrom = ["src/**", "shared/**"]\n`,
      "shared/loaded.ts": project["src/used.ts"],
      "shared/unused.ts": `export const unused = 1;\n`,
      "src/index.ts": isWindows
        ? `export { used } from "../shared/loaded";\n`
        : `export { used } from "./linked/loaded";\n`,
      // Relative to the directory the test changes to, "src/**" is this file.
      "elsewhere/src/decoy.ts": `export const decoy = 1;\n`,
      "a.test.ts": `import { expect, test } from "bun:test";
import { used } from "./src/index";

test("a", () => {
  process.chdir("elsewhere");
  expect(used()).toBe(1);
});
`,
    });
    if (!isWindows) {
      // shared/loaded.ts through a directory, which the test imports it by, and
      // shared/unused.ts through a file, which the list finds it by a second time.
      symlinkSync(path.join(String(dir), "shared"), path.join(String(dir), "src", "linked"), "dir");
      symlinkSync(path.join(String(dir), "shared", "unused.ts"), path.join(String(dir), "src", "alias.ts"));
      symlinkSync(path.join(String(dir), "shared", "loaded.ts"), path.join(String(dir), "src", "loaded-alias.ts"));
    }
    const { rows, stderr, exitCode } = await run(String(dir), ...lcovFlags);
    expect(stderr).toContain("1 pass");
    expect(rows).toEqual([
      "shared/loaded.ts | 50.00 | 50.00 | 4-5",
      "shared/unused.ts | 100.00 | 0.00 | 1",
      "src/index.ts | 100.00 | 100.00 |",
    ]);
    // Written where the run started, with the paths it started with.
    expect(Object.keys(lcovRecords(String(dir)))).toEqual(["shared/loaded.ts", "shared/unused.ts", "src/index.ts"]);
    expect(exitCode).toBe(0);
  });

  test.concurrent("a --parallel run that --bail stops reports the files its tests loaded", async () => {
    using dir = tempDir("cov-collect-from", {
      "bunfig.toml": `[test]\ncoverageSkipTestFiles = true\ncollectCoverageFrom = ["src/**"]\n`,
      "src/used.ts": project["src/used.ts"],
      "src/unused.ts": unused,
      "a.test.ts": `import { expect, test } from "bun:test";
import { used } from "./src/used";

test("fails", () => {
  expect(used()).toBe(2);
});
`,
      "b.test.ts": `import { test } from "bun:test";\ntest("b", () => {});\n`,
    });
    const [stopped, finished] = await Promise.all([
      run(String(dir), "--coverage", "--parallel=2", "--bail"),
      run(String(dir), "--coverage", "--parallel=2"),
    ]);
    expect(stopped.stderr).toContain("Bailed out after 1 failure");
    expect({ rows: stopped.rows, exitCode: stopped.exitCode }).toEqual({
      rows: ["src/used.ts | 50.00 | 50.00 | 4-5"],
      exitCode: 1,
    });
    expect({ rows: finished.rows, exitCode: finished.exitCode }).toEqual({
      rows: [unusedRow, "src/used.ts | 50.00 | 50.00 | 4-5"],
      exitCode: 1,
    });
  });

  test.concurrent("comments, coverageIgnoreSourcemaps and // @bun apply to a file that nothing loaded", async () => {
    const files = (config: string) => ({
      "bunfig.toml": `[test]\ncoverageSkipTestFiles = true\ncollectCoverageFrom = ["src/**"]\n${config}`,
      "src/hints.ts": `export function kept() {
  return 1;
}
/* v8 ignore next */
export function ignored() {
  const inner = () => 2;
  return inner();
}
export const value = 1; /* v8 ignore next */
/* v8 ignore start */
export const a = 1;
/* v8 ignore stop */
export const last = 3;
`,
      "src/whole-file.ts": `/* v8 ignore file */
export const ignored = 1;
`,
      // The transpiler leaves this one as it is. Its last line has no end
      // and a function on it.
      "src/prebuilt.js": `// @bun
export function first() {
  return 1;
}
export const second = () => 2;`,
      "only.test.ts": `import { test } from "bun:test";\ntest("loads nothing", () => {});\n`,
    });
    using mapped = tempDir("cov-collect-from", files(""));
    using unmapped = tempDir("cov-collect-from", files("coverageIgnoreSourcemaps = true\n"));
    const [withMaps, withoutMaps] = await Promise.all([
      run(String(mapped), ...lcovFlags),
      run(String(unmapped), ...lcovFlags),
    ]);
    expect([withMaps.exitCode, withoutMaps.exitCode]).toEqual([0, 0]);
    expect(lcovRecords(String(mapped))).toEqual({
      "src/hints.ts": { functions: "0/1", lines: "0/3", listed: [1, 2, 13] },
      // Without a source map the lines are those of the text, and a comment is text.
      "src/prebuilt.js": { functions: "0/2", lines: "0/4", listed: [1, 2, 3, 5] },
    });
    // The lines are those of the transpiled text, which a comment cannot name.
    expect(Object.keys(lcovRecords(String(unmapped)))).toEqual([
      "src/hints.ts",
      "src/prebuilt.js",
      "src/whole-file.ts",
    ]);
    expect(withoutMaps.rows.find(row => row.startsWith("src/prebuilt.js"))).toBe(
      "src/prebuilt.js | 0.00 | 0.00 | 1-3,5",
    );
  });

  test.concurrent("says what is wrong with the list", async () => {
    using dir = tempDir("cov-collect-from", {
      "bunfig.toml": `[test]\ncoverageSkipTestFiles = true\n`,
      "number.toml": `[test]\ncollectCoverageFrom = 1\n`,
      "empty.toml": `[test]\ncollectCoverageFrom = ["src/**", ""]\n`,
      "src/unused.ts": unused,
      "only.test.ts": `import { test } from "bun:test";\ntest("loads nothing", () => {});\n`,
    });
    const [number, empty, emptyFlag, noFile, rootDir] = await Promise.all([
      run(String(dir), "--coverage", "--config=number.toml"),
      run(String(dir), "--coverage", "--config=empty.toml"),
      run(String(dir), "--coverage", "--collect-coverage-from="),
      run(String(dir), "--coverage", "--collect-coverage-from=source/**"),
      run(String(dir), "--coverage", "--collect-coverage-from=<rootDir>/src/**"),
    ]);
    expect(number.stderr).toContain("collectCoverageFrom must be a string or array of strings");
    expect(empty.stderr).toContain("collectCoverageFrom patterns cannot be empty strings");
    expect(emptyFlag.stderr).toContain("error: --collect-coverage-from expects a glob pattern");
    expect([number.exitCode, empty.exitCode, emptyFlag.exitCode]).toEqual([1, 1, 1]);
    // A list that names nothing is more likely a mistake than a project without files.
    expect(noFile.stderr).toContain("warn: No file matches collectCoverageFrom\n---");
    expect({ rows: noFile.rows, exitCode: noFile.exitCode }).toEqual({ rows: [], exitCode: 0 });
    expect({ rows: rootDir.rows, exitCode: rootDir.exitCode }).toEqual({ rows: [unusedRow], exitCode: 0 });
  });

  // What a file reports when nothing loads it, next to what it reports when a
  // test imports it and calls nothing of it, and when a test calls all of it.
  const shapes = {
    "functions.ts": `export function a(x: number) {
  // A comment and an empty line in the function.

  return x + 1;
}
export function b(x: number) {
  return x + 2;
}
`,
    "class-field.ts": `export class WithField {
  field = 1;
  method() {
    return this.field;
  }
}
`,
    "class-method.ts": `export class WithMethod {
  method() {
    return 1;
  }
}
`,
    "no-functions.ts": `export const one = 1;
export const two = one + 1;
`,
    "commonjs.cjs": `function a(x) {
  return x + 1;
}
function b(x) {
  return x + 2;
}
module.exports = { a, b };
`,
    "last-line.ts": `export function a(x: number) {
  return x; }
export const one = 1;
`,
    "async-generator.ts": `export async function a() {
  return 1;
}
export function* b() {
  yield 1;
}
`,
    "nested.ts": `export function outer() {
  function inner() {
    return () => 1;
  }
  return inner;
}
export const arrow = () => {
  return 2;
};
`,
    "types.ts": `export interface OnlyTypes {
  name: string;
}
`,
  };
  const callEverything = `
import * as functions from "./src/functions";
import { WithField } from "./src/class-field";
import { WithMethod } from "./src/class-method";
import * as noFunctions from "./src/no-functions";
import * as commonjs from "./src/commonjs.cjs";
import * as lastLine from "./src/last-line";
import * as asyncGenerator from "./src/async-generator";
import * as nested from "./src/nested";
import "./src/types";

export async function callEverything() {
  return [
    functions.a(1),
    functions.b(1),
    new WithField().method(),
    new WithMethod().method(),
    noFunctions.two,
    commonjs.a(1),
    commonjs.b(1),
    lastLine.a(1),
    await asyncGenerator.a(),
    [...asyncGenerator.b()],
    nested.outer()()(),
    nested.arrow(),
  ];
}
`;

  test.concurrent(
    "a file that nothing loaded has the functions of one that is imported and the lines of one that ran",
    async () => {
      const files = (testFile: string) => ({
        "bunfig.toml": `[test]\ncoverageSkipTestFiles = true\ncollectCoverageFrom = ["src/**"]\n`,
        ...Object.fromEntries(Object.entries(shapes).map(([name, source]) => [`src/${name}`, source])),
        "call-everything.ts": callEverything,
        "shapes.test.ts": testFile,
      });
      using nothingLoaded = tempDir(
        "cov-collect-from",
        files(`import { test } from "bun:test";\ntest("loads nothing", () => {});\n`),
      );
      using nothingCalled = tempDir(
        "cov-collect-from",
        files(`import { test } from "bun:test";\nimport "./call-everything";\ntest("calls nothing", () => {});\n`),
      );
      using everythingCalled = tempDir(
        "cov-collect-from",
        files(`import { expect, test } from "bun:test";
import { callEverything } from "./call-everything";
test("calls everything", async () => {
  expect(await callEverything()).toHaveLength(12);
});
`),
      );
      const dirs = [nothingLoaded, nothingCalled, everythingCalled].map(String);
      const runs = await Promise.all(dirs.map(dir => run(dir, ...lcovFlags)));
      expect(runs.map(({ exitCode }) => exitCode)).toEqual([0, 0, 0]);
      const [unloaded, imported, called] = dirs.map(lcovRecords);

      const names = Object.keys(shapes).filter(name => name !== "types.ts");
      expect(Object.keys(unloaded)).toEqual(names.map(name => `src/${name}`).sort());
      for (const name of names) {
        const file = `src/${name}`;
        const source = shapes[name as keyof typeof shapes].split("\n");
        expect({
          name,
          functions: unloaded[file].functions,
          lines: unloaded[file].lines.split("/")[0],
          linesOfARunThatAreMissing: called[file].listed.filter(line => !unloaded[file].listed.includes(line)),
          linesWithoutCode: unloaded[file].listed.filter(line => /^\s*(\/\/.*)?$/.test(source[line - 1])),
        }).toEqual({
          name,
          functions: `0/${imported[file].functions.split("/")[1]}`,
          lines: "0",
          linesOfARunThatAreMissing: [],
          linesWithoutCode: [],
        });
      }
    },
  );
});
