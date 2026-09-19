import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { bunEnv, bunExe, isWindows, tempDir } from "harness";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Starts `bun serve ...args` in `cwd` and waits for the URL it prints.
async function serve(cwd: string, args: string[] = [], env: Record<string, string> = {}) {
  const proc = Bun.spawn({
    cmd: [bunExe(), "serve", ...args],
    cwd,
    env: { ...bunEnv, ...env },
    stdout: "pipe",
    stderr: "inherit",
  });

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let stdout = "";
  let ended = false;
  let reading: Promise<void> | undefined;
  // One read at a time, however many tests wait.
  function readMore(): Promise<void> {
    return (reading ??= reader.read().then(({ value, done }) => {
      reading = undefined;
      ended = done;
      if (value) stdout += decoder.decode(value, { stream: true });
    }));
  }
  // Resolves with the match once stdout has a whole line that matches `pattern`.
  async function waitForOutput(pattern: RegExp): Promise<RegExpMatchArray> {
    while (true) {
      const match = stdout.match(pattern);
      if (match) return match;
      if (ended) throw new Error(`bun serve exited before printing ${pattern}\n${stdout}`);
      await readMore();
    }
  }

  const server = {
    url: "",
    waitForOutput,
    // Stops the server and resolves with everything it printed.
    async stop(): Promise<string> {
      proc.kill();
      while (!ended) await readMore();
      await proc.exited;
      return stdout;
    },
    async [Symbol.asyncDispose]() {
      await server.stop();
    },
  };
  try {
    server.url = (await waitForOutput(/^url: (http:\/\/\S+)\r?\n/m))[1];
  } catch (error) {
    await server.stop();
    throw error;
  }
  return server;
}

// fetch() normalizes the path of a URL and always sends a Host header. An attacker does not.
async function rawRequest(url: string, head: string): Promise<number> {
  const { hostname, port } = new URL(url);
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  let response = "";
  await Bun.connect({
    hostname,
    port: Number(port),
    socket: {
      open(socket) {
        socket.write(head + "\r\nConnection: close\r\n\r\n");
      },
      data(_socket, chunk) {
        response += chunk.toString();
      },
      close() {
        resolve(response);
      },
      error(_socket, error) {
        reject(error);
      },
    },
  });
  return Number((await promise).split(" ")[1]);
}

function rawGet(url: string, rawPath: string): Promise<number> {
  return rawRequest(url, `GET ${rawPath} HTTP/1.1\r\nHost: ${new URL(url).host}`);
}

async function runToExit(cwd: string, cmd: string[], env: Record<string, string | undefined> = bunEnv) {
  await using proc = Bun.spawn({ cmd: [bunExe(), ...cmd], cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

const site = {
  "secret.txt": "outside the served directory",
  "public/index.html": "<h1>home</h1>",
  "public/about.html": "<h1>about</h1>",
  "public/assets/app.js": "console.log(1);",
  "public/assets/data.bin": Buffer.alloc(1000, "x").toString(),
  "public/docs/guide/intro.md": "# intro",
  "public/docs/a & b's #1 100%.txt": "escaped",
  "public/docs/.hidden": "hidden",
  "public/docs/.well-known/nested.txt": "only the top-level .well-known is public",
  "public/blog/index.html": "<h1>blog</h1>",
  // The layout of a static export: a page, and a directory of the same name for the pages under it.
  "public/pricing.html": "<h1>pricing</h1>",
  "public/pricing/enterprise.html": "<h1>enterprise</h1>",
  "public/.env": "SECRET=1",
  "public/.git/config": "[core]",
  "public/.well-known/security.txt": "Contact: mailto:security@example.com",
};

describe.concurrent("bun serve", () => {
  describe("with the default options", () => {
    let dir: ReturnType<typeof tempDir>;
    let server: Awaited<ReturnType<typeof serve>>;
    let url: string;

    beforeAll(async () => {
      dir = tempDir("bun-serve", site);
      const root = join(String(dir), "public");
      if (!isWindows) {
        // "<" and ">" cannot be in a file name on Windows, and a symlink needs a privilege there.
        writeFileSync(join(root, "docs", "z <b>.txt"), "markup");
        symlinkSync(join(root, "about.html"), join(root, "link.html"));
        symlinkSync(join(String(dir), "secret.txt"), join(root, "escape.txt"));
        symlinkSync(join(String(dir), "secret.txt"), join(root, "docs", "escape.txt"));
        symlinkSync(join(root, ".git"), join(root, "git"));
      }
      server = await serve(String(dir), ["./public", "--port", "0"]);
      url = server.url;
    });

    afterAll(async () => {
      await server?.stop();
      dir?.[Symbol.dispose]();
    });

    test("serves files, index.html and clean URLs", async () => {
      const home = await fetch(url);
      expect(await home.text()).toBe("<h1>home</h1>");
      expect({
        status: home.status,
        type: home.headers.get("content-type"),
        cache: home.headers.get("cache-control"),
        etag: /^W\/"[0-9a-f]+-[0-9a-f]+"$/.test(home.headers.get("etag")!),
        lastModified: Number.isNaN(Date.parse(home.headers.get("last-modified")!)),
      }).toEqual({ status: 200, type: "text/html;charset=utf-8", cache: "no-cache", etag: true, lastModified: false });

      const script = await fetch(url + "assets/app.js");
      expect(await script.text()).toBe("console.log(1);");
      expect(script.headers.get("content-type")).toStartWith("text/javascript");

      // A directory's index.html is its page. "/about" finds "about.html", and so does "/pricing",
      // which is also a directory.
      expect(await (await fetch(url + "blog/")).text()).toBe("<h1>blog</h1>");
      expect(await (await fetch(url + "about")).text()).toBe("<h1>about</h1>");
      expect(await (await fetch(url + "pricing")).text()).toBe("<h1>pricing</h1>");
      expect(await (await fetch(url + "pricing/enterprise")).text()).toBe("<h1>enterprise</h1>");

      const missing = await fetch(url + "nope");
      expect({ status: missing.status, body: await missing.text() }).toEqual({ status: 404, body: "404 Not Found\n" });

      const post = await fetch(url + "about.html", { method: "POST" });
      expect({ status: post.status, allow: post.headers.get("allow") }).toEqual({ status: 405, allow: "GET, HEAD" });

      // Every request is logged.
      await server.waitForOutput(/^GET \/about 200 [\d.]+ms\r?\n/m);
      await server.waitForOutput(/^GET \/nope 404 [\d.]+ms\r?\n/m);
      await server.waitForOutput(/^POST \/about\.html 405 [\d.]+ms\r?\n/m);
    });

    test("redirects a directory to its trailing slash and lists it", async () => {
      // Relative links in the listing only resolve against the URL that ends in "/".
      const redirect = await fetch(url + "docs?x=1", { redirect: "manual" });
      expect({
        status: redirect.status,
        location: redirect.headers.get("location"),
        cache: redirect.headers.get("cache-control"),
      }).toEqual({ status: 301, location: "/docs/?x=1", cache: "no-cache" });

      // Directories first, names escaped, no dotfiles, no symlink that leaves the directory.
      const listing = await fetch(url + "docs/");
      expect(listing.headers.get("content-type")).toBe("text/html;charset=utf-8");
      const html = await listing.text();
      expect(html).toContain("<title>Index of /docs/</title>");
      expect([...html.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)].map(m => [m[1], m[2]])).toEqual([
        ["../", "../"],
        ["guide/", "guide/"],
        ["a%20%26%20b's%20%231%20100%25.txt", "a &amp; b&#x27;s #1 100%.txt"],
        ...(isWindows ? [] : [["z%20%3Cb%3E.txt", "z &lt;b&gt;.txt"]]),
      ]);
      expect(await (await fetch(url + "docs/a%20%26%20b's%20%231%20100%25.txt")).text()).toBe("escaped");

      const assets = await (await fetch(url + "assets/")).text();
      expect([...assets.matchAll(/<a href="([^"]+)">/g)].map(m => m[1])).toEqual(["../", "app.js", "data.bin"]);
    });

    test("answers conditional, Range and HEAD requests", async () => {
      const first = await fetch(url + "assets/data.bin");
      expect((await first.bytes()).length).toBe(1000);
      const etag = first.headers.get("etag")!;
      const lastModified = first.headers.get("last-modified")!;

      const byEtag = await fetch(url + "assets/data.bin", { headers: { "If-None-Match": `"other", ${etag}` } });
      expect({ status: byEtag.status, etag: byEtag.headers.get("etag"), body: await byEtag.text() }).toEqual({
        status: 304,
        etag,
        body: "",
      });
      const byDate = await fetch(url + "assets/data.bin", { headers: { "If-Modified-Since": lastModified } });
      expect(byDate.status).toBe(304);
      // If-None-Match wins over If-Modified-Since.
      const stale = await fetch(url + "assets/data.bin", {
        headers: { "If-None-Match": `"other"`, "If-Modified-Since": lastModified },
      });
      expect(stale.status).toBe(200);
      await stale.bytes();

      const range = await fetch(url + "assets/data.bin", { headers: { Range: "bytes=10-19" } });
      expect({
        status: range.status,
        contentRange: range.headers.get("content-range"),
        body: await range.text(),
      }).toEqual({ status: 206, contentRange: "bytes 10-19/1000", body: "xxxxxxxxxx" });

      const head = await fetch(url + "assets/data.bin", { method: "HEAD" });
      expect({ status: head.status, length: head.headers.get("content-length"), body: await head.text() }).toEqual({
        status: 200,
        length: "1000",
        body: "",
      });
    });

    test("does not serve anything outside the directory, or dotfiles", async () => {
      // The controls: the same kind of request finds a file that is inside.
      expect(await rawGet(url, "/docs/../about.html")).toBe(200);
      expect(await rawRequest(url, "GET /about.html HTTP/1.0")).toBe(200);

      for (const rawPath of [
        "/../secret.txt",
        "/%2e%2e/secret.txt",
        "/..%2fsecret.txt",
        "/..%2Fsecret.txt",
        "/docs/..%2f..%2fsecret.txt",
        "/docs/%2e%2e%2f%2e%2e%2fsecret.txt",
        "/docs/guide%2fintro.md",
        "//secret.txt",
        "/about.html%00",
        "/%E0%A4%A",
        ...(isWindows ? ["/..%5csecret.txt", "/docs%5cguide/intro.md", "/about.html::$DATA"] : []),
      ]) {
        expect([rawPath, await rawGet(url, rawPath)]).toEqual([rawPath, 404]);
      }
      // A request without a Host header has no URL to resolve against.
      expect(await rawRequest(url, "GET //secret.txt HTTP/1.0")).toBe(404);

      // Dotfiles are neither served nor listed. /.well-known/ is public by definition (RFC 8615).
      expect((await fetch(url + ".env")).status).toBe(404);
      expect((await fetch(url + ".git/config")).status).toBe(404);
      expect((await fetch(url + "docs/.hidden")).status).toBe(404);
      expect((await fetch(url + "docs/.well-known/nested.txt")).status).toBe(404);
      expect(await (await fetch(url + ".well-known/security.txt")).text()).toStartWith("Contact:");

      if (!isWindows) {
        // A symlink is followed, but not out of the directory and not into a hidden one.
        expect(await (await fetch(url + "link.html")).text()).toBe("<h1>about</h1>");
        expect((await fetch(url + "escape.txt")).status).toBe(404);
        expect((await fetch(url + "docs/escape.txt")).status).toBe(404);
        expect((await fetch(url + "git/config")).status).toBe(404);
      }
    });
  });

  test("--spa, --cors, --dotfiles and --quiet", async () => {
    using dir = tempDir("bun-serve-flags", { ...site, "public/404.html": "<h1>custom 404</h1>" });
    await using server = await serve(String(dir), ["public", "-p", "0", "--spa", "--cors", "--dotfiles", "-q"]);
    const { url } = server;

    // --spa: a route gets the app. A missing asset and a refused path stay a 404, and 404.html is
    // the page for them.
    const route = await fetch(url + "dashboard/settings");
    expect({ status: route.status, body: await route.text() }).toEqual({ status: 200, body: "<h1>home</h1>" });
    const asset = await fetch(url + "assets/missing.js");
    expect({ status: asset.status, body: await asset.text() }).toEqual({ status: 404, body: "<h1>custom 404</h1>" });
    expect(await rawGet(url, "/..%2fsecret")).toBe(404);

    // --cors
    expect(asset.headers.get("access-control-allow-origin")).toBe("*");
    const preflight = await fetch(url + "about.html", {
      method: "OPTIONS",
      headers: { "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "x-custom" },
    });
    expect({
      status: preflight.status,
      origin: preflight.headers.get("access-control-allow-origin"),
      methods: preflight.headers.get("access-control-allow-methods"),
      headers: preflight.headers.get("access-control-allow-headers"),
    }).toEqual({ status: 204, origin: "*", methods: "GET, HEAD, OPTIONS", headers: "x-custom" });

    // --dotfiles
    expect(await (await fetch(url + ".env")).text()).toBe("SECRET=1");
    expect(await (await fetch(url + "docs/")).text()).toContain(`<a href=".hidden">.hidden</a>`);

    // --quiet: nothing after the banner.
    expect(await server.stop()).not.toContain("GET ");
  });

  test("--no-listing, and no 404.html", async () => {
    using dir = tempDir("bun-serve-no-listing", site);
    await using server = await serve(String(dir), ["public", "--port=0", "--no-listing"]);

    const listing = await fetch(server.url + "docs/");
    expect({ status: listing.status, body: await listing.text() }).toEqual({ status: 404, body: "404 Not Found\n" });
    // A directory with an index.html is still served, and without --spa a route is not.
    expect(await (await fetch(server.url + "blog/")).text()).toBe("<h1>blog</h1>");
    expect((await fetch(server.url + "dashboard/settings")).status).toBe(404);
    expect((await fetch(server.url + "about.html")).headers.get("access-control-allow-origin")).toBeNull();
  });

  test("serves the current directory by default, and takes the next port when the default is taken", async () => {
    using dir = tempDir("bun-serve-default", { "who.txt": "bun serve" });
    // reusePort: a server that sets it too would share this port instead of failing to listen.
    using holder = Bun.serve({ hostname: "127.0.0.1", port: 0, reusePort: true, fetch: () => new Response("holder") });
    const port = String(holder.port);

    // This one exits by itself, so it can run while the server below starts.
    const explicitPort = runToExit(String(dir), ["serve", "--port", port]);

    // The default port is a suggestion. Two servers never share one.
    await using server = await serve(String(dir), [], { PORT: port, BUN_PORT: "", NODE_PORT: "" });
    expect(new URL(server.url).port).not.toBe(port);
    expect(await (await fetch(server.url + "who.txt")).text()).toBe("bun serve");
    // "/" has no index.html here: it lists the directory.
    expect(await (await fetch(server.url)).text()).toContain(`<a href="who.txt">who.txt</a>`);

    // An explicit port is not a suggestion.
    const taken = await explicitPort;
    expect(taken.stderr).toContain(`Is port ${port} in use?`);
    expect(taken.stderr).toContain("note: pass another --port, or --port 0 for any free port");
    expect(taken.exitCode).toBe(1);
  });

  test("a script or a file named serve wins, and `bun run serve` is not the server", async () => {
    using dir = tempDir("bun-serve-script", {
      "with-script/package.json": JSON.stringify({ scripts: { serve: "echo from the serve script" } }),
      "with-file/serve.ts": "console.log('from serve.ts');",
      "without/package.json": JSON.stringify({ scripts: {} }),
    });
    // `bun run` also looks for "serve" in $PATH, and some machine has one installed.
    const withoutPath = Object.fromEntries(Object.entries(bunEnv).filter(([key]) => key.toUpperCase() !== "PATH"));
    withoutPath.PATH = String(dir);

    const [script, file, run, ifPresent] = await Promise.all([
      runToExit(join(String(dir), "with-script"), ["serve"]),
      runToExit(join(String(dir), "with-file"), ["serve"]),
      runToExit(join(String(dir), "without"), ["run", "serve"], withoutPath),
      runToExit(join(String(dir), "without"), ["--if-present", "serve"]),
    ]);

    // What `bun serve` ran before the static file server existed, it still runs.
    expect(script.stdout).toBe("from the serve script\n");
    expect(script.exitCode).toBe(0);
    expect(file).toEqual({ stdout: "from serve.ts\n", stderr: "", exitCode: 0 });

    // `bun run` is for scripts and files, and --if-present asks about those too.
    expect(run.stderr).toContain(`Script not found "serve"`);
    expect(run.exitCode).toBe(1);
    expect(ifPresent).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  });

  test("reports bad arguments", async () => {
    using dir = tempDir("bun-serve-args", { "file.txt": "not a directory" });
    const cwd = String(dir);
    const [file, missing, port, host, unknown, help] = await Promise.all([
      runToExit(cwd, ["serve", "./file.txt"]),
      runToExit(cwd, ["serve", "./missing"]),
      runToExit(cwd, ["serve", "--port", "0x50"]),
      runToExit(cwd, ["serve", "--host="]),
      runToExit(cwd, ["serve", "--watch"]),
      runToExit(cwd, ["serve", "--help"]),
    ]);

    expect(file).toEqual({ stdout: "", stderr: `error: "./file.txt" is not a directory\n`, exitCode: 1 });
    expect(missing).toEqual({ stdout: "", stderr: `error: "./missing" does not exist\n`, exitCode: 1 });
    expect(port).toEqual({
      stdout: "",
      stderr: `error: --port expects a number from 0 to 65535, got "0x50"\n`,
      exitCode: 1,
    });
    // An empty hostname would listen on every interface.
    expect(host).toEqual({ stdout: "", stderr: "error: --host expects a hostname\n", exitCode: 1 });
    expect(unknown).toEqual({
      stdout: "",
      stderr:
        "error: Unknown option '--watch'\n" +
        `note: "bun serve --help" lists the options. Flags for Bun itself go before "serve".\n`,
      exitCode: 1,
    });

    expect(help.stdout).toStartWith("Usage: bun serve [dir] [options]");
    expect(help.exitCode).toBe(0);
  });
});
