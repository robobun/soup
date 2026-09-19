// This is the file that loads when you run `bun serve`: a static file server for one directory.
// It is a wrapper around Bun.serve() and does nothing you could not write yourself.
import type { Server } from "bun";
import type { Stats } from "node:fs";

// `import` cannot be used in this file and only Bun builtin modules can be used.
const path = require("node:path");
const fs = require("node:fs");

const initial = performance.now();

const usage = `Usage: bun serve [dir] [options]

Serve a directory of static files over HTTP. Without [dir], the current directory.

Options:
  -p, --port <number>     Port to listen on (default: BUN_PORT, PORT or NODE_PORT from the environment, or 3000.
                          If another server has the default port, the next free one)
      --host <hostname>   Hostname to listen on (default: 127.0.0.1). Use 0.0.0.0 to reach it from other devices
  -s, --spa               Serve index.html for paths that match no file, for single-page apps
      --cors              Allow requests from any origin (Access-Control-Allow-Origin: *)
      --no-listing        Answer 404 for a directory without an index.html instead of listing it
      --dotfiles          Serve and list files and directories whose name starts with "."
  -q, --quiet             Do not log requests
  -h, --help              Print this help

Flags for Bun itself go before "serve": bun --smol serve ./dist

Examples:
  bun serve
  bun serve ./dist --port 8080
  bun serve ./dist --spa
  bun serve ~/Downloads --host 0.0.0.0

A request for a directory gets its index.html, or a listing of the directory. "/about" also finds
"about.html". A 404.html in the served directory is the page for paths that match nothing. Files are
sent with an ETag and Last-Modified, are revalidated by the browser on every load (Cache-Control:
no-cache), and support Range requests.
`;

type Options = {
  root: string;
  port: number | undefined;
  hostname: string;
  spa: boolean;
  cors: boolean;
  listing: boolean;
  dotfiles: boolean;
  quiet: boolean;
};

type Found = {
  /** The file with every symlink resolved, inside the served directory. */
  real: string;
  stat: Stats;
};

// Bun.enableANSIColors is about the terminal. `bun serve > access.log` must not get escape codes.
function hasColors(fd: 1 | 2): boolean {
  return Bun.enableANSIColors && (require("node:tty").isatty(fd) || !!Bun.env.FORCE_COLOR);
}

function fail(message: string, note?: string): never {
  const colors = hasColors(2);
  console.error((colors ? "\x1b[31merror\x1b[0m\x1b[2m:\x1b[0m " : "error: ") + message);
  if (note) console.error((colors ? "\x1b[2mnote:\x1b[0m " : "note: ") + note);
  process.exit(1);
}

function parseOptions(args: string[]): Options {
  const { parseArgs } = require("node:util");
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        port: { type: "string", short: "p" },
        host: { type: "string" },
        spa: { type: "boolean", short: "s" },
        cors: { type: "boolean" },
        "no-listing": { type: "boolean" },
        dotfiles: { type: "boolean" },
        quiet: { type: "boolean", short: "q" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error: any) {
    if (typeof error?.code !== "string" || !error.code.startsWith("ERR_PARSE_ARGS_")) throw error;
    // parseArgs() goes on about "--", which Bun has already taken out of the arguments.
    const message: string =
      error.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" ? error.message.split(". ")[0] : error.message;
    fail(message, `"bun serve --help" lists the options. Flags for Bun itself go before "serve".`);
  }

  const { values, positionals } = parsed;
  if (values.help) {
    console.log(usage);
    process.exit(0);
  }

  const directories: number = positionals.length;
  if (directories > 1) fail(`bun serve takes one directory, got ${directories}: ${positionals.join(" ")}`);

  let port: number | undefined;
  const portOption: string | undefined = values.port;
  if (portOption !== undefined) {
    port = /^\d+$/.test(portOption) ? Number(portOption) : NaN;
    if (!(port <= 65535)) fail(`--port expects a number from 0 to 65535, got "${portOption}"`);
  }

  // Bun.serve() takes an empty hostname for "every interface".
  if (values.host === "") fail("--host expects a hostname");

  const directory: string = positionals[0] ?? ".";
  const root: string = path.resolve(directory);
  try {
    if (!fs.statSync(root).isDirectory()) fail(`${JSON.stringify(directory)} is not a directory`);
  } catch (error: any) {
    fail(
      `${JSON.stringify(directory)} ${error?.code === "ENOENT" ? "does not exist" : `cannot be read (${error?.code})`}`,
    );
  }

  return {
    root,
    port,
    // Not "localhost": Bun.serve() binds that name to whichever of ::1 and 127.0.0.1 is free, so a
    // port that another server already has on one of the two would not count as taken.
    hostname: values.host ?? "127.0.0.1",
    spa: !!values.spa,
    cors: !!values.cors,
    listing: !values["no-listing"],
    dotfiles: !!values.dotfiles,
    quiet: !!values.quiet,
  };
}

// `names` are the components of a path inside the served directory. RFC 8615 makes /.well-known/,
// at the top only, a public location.
function hasHidden(names: string[]): boolean {
  return names.some((name, depth) => name.startsWith(".") && !(depth === 0 && name === ".well-known"));
}

// The path segments of a request, percent-decoded, or null for a path that never maps to a file.
// `new URL()` has already resolved "." and ".." segments, spelled literally or percent-encoded.
// What is left to refuse is a separator or a NUL that only appears after decoding ("%2F", "%00"),
// an empty segment ("//"), and on Windows "\" and ":" (a drive or an alternate data stream).
function decodeSegments(pathname: string): { segments: string[]; trailingSlash: boolean } | null {
  // pathname always starts with "/"
  const raw = pathname.split("/").slice(1);
  const trailingSlash = raw[raw.length - 1] === "";
  if (trailingSlash) raw.pop();

  const segments: string[] = [];
  for (const part of raw) {
    let segment: string;
    try {
      segment = decodeURIComponent(part);
    } catch {
      return null;
    }
    if (
      segment === "" ||
      segment === "." ||
      segment === ".." ||
      segment.includes("/") ||
      segment.includes("\0") ||
      (process.platform === "win32" && (segment.includes("\\") || segment.includes(":")))
    ) {
      return null;
    }
    segments.push(segment);
  }
  return { segments, trailingSlash };
}

// RFC 9110 section 13.1: If-None-Match wins over If-Modified-Since, and compares weakly.
function isFresh(req: Request, etag: string, mtimeMs: number): boolean {
  const ifNoneMatch = req.headers.get("if-none-match");
  if (ifNoneMatch !== null) {
    if (ifNoneMatch.trim() === "*") return true;
    const opaque = etag.slice(2);
    for (let candidate of ifNoneMatch.split(",")) {
      candidate = candidate.trim();
      if (candidate.startsWith("W/")) candidate = candidate.slice(2);
      if (candidate === opaque) return true;
    }
    return false;
  }

  const ifModifiedSince = req.headers.get("if-modified-since");
  if (ifModifiedSince !== null) {
    const since = Date.parse(ifModifiedSince);
    // Last-Modified has a resolution of one second.
    return !Number.isNaN(since) && Math.floor(mtimeMs / 1000) * 1000 <= since;
  }

  return false;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function formatTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const listingStyle = `
body { font: 14px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; max-width: 64rem; margin: 2rem auto; padding: 0 1rem; }
h1 { font-size: 1rem; }
table { border-collapse: collapse; width: 100%; }
td { padding: 0 1.5rem 0 0; white-space: nowrap; vertical-align: top; }
td:first-child { width: 100%; white-space: normal; word-break: break-all; }
td + td { text-align: right; opacity: 0.6; font-variant-numeric: tabular-nums; }
a { text-decoration: none; }
a:hover { text-decoration: underline; }
`;

async function start() {
  const options = parseOptions(process.argv.slice(2));
  const { root, spa, cors, listing, dotfiles, quiet } = options;
  const colors = hasColors(1);
  // .native, like fs.promises.realpath() below: only that one expands a Windows 8.3 short name
  // ("C:\\Users\\RUNNER~1"), and the two have to agree on how the served directory is spelled.
  const realRoot: string = fs.realpathSync.native(root);

  // Everything that is served goes through here. The checks are on the path with every symlink
  // resolved: a link may not lead out of the served directory, and neither a link nor a name the
  // filesystem treats as equal (a Windows 8.3 short name) may lead into a hidden one.
  async function find(file: string): Promise<Found | null> {
    try {
      let real: string = await fs.promises.realpath(file);
      // A drive root comes back without its separator, and "C:" alone is the current directory of
      // that drive.
      if (process.platform === "win32" && /^[a-z]:$/i.test(real)) real += path.sep;
      if (real !== realRoot) {
        const relative: string = path.relative(realRoot, real);
        if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) return null;
        if (!dotfiles && hasHidden(relative.split(path.sep))) return null;
      }
      return { real, stat: await fs.promises.stat(real) };
    } catch {
      return null;
    }
  }

  const baseHeaders: Record<string, string> = cors ? { "Access-Control-Allow-Origin": "*" } : {};

  function text(status: number, body: string, headers: Record<string, string> = {}): Response {
    return new Response(body + "\n", {
      status,
      headers: { ...baseHeaders, "Content-Type": "text/plain;charset=utf-8", ...headers },
    });
  }

  // Bun.serve() answers a Range request for a Bun.file() body by itself.
  async function sendFile(req: Request, { real, stat }: Found, status = 200): Promise<Response> {
    try {
      await fs.promises.access(real, fs.constants.R_OK);
    } catch {
      return text(403, "403 Forbidden");
    }

    // The modification time in milliseconds, where Last-Modified only has seconds: a file that is
    // rebuilt twice within a second still gets a new ETag.
    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    const headers = {
      ...baseHeaders,
      "ETag": etag,
      "Last-Modified": new Date(stat.mtimeMs).toUTCString(),
      "Cache-Control": "no-cache",
    };
    if (status === 200 && isFresh(req, etag, stat.mtimeMs)) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(Bun.file(real), { status, headers });
  }

  async function sendListing(segments: string[], directory: string): Promise<Response> {
    let names: string[];
    try {
      names = await fs.promises.readdir(directory);
    } catch (error: any) {
      return error?.code === "EACCES" || error?.code === "EPERM"
        ? text(403, "403 Forbidden")
        : text(404, "404 Not Found");
    }

    const entries: { name: string; isDirectory: boolean; size: number; mtime: Date }[] = [];
    await Promise.all(
      names.map(async name => {
        if (!dotfiles && hasHidden([...segments, name])) return;
        const found = await find(path.join(directory, name));
        if (found === null) return;
        const { stat } = found;
        // Anything else (a socket, a FIFO, a device) is a 404 when it is requested.
        if (!stat.isFile() && !stat.isDirectory()) return;
        entries.push({ name, isDirectory: stat.isDirectory(), size: stat.size, mtime: stat.mtime });
      }),
    );
    entries.sort((a, b) => {
      const directoryFirst = a.isDirectory;
      if (directoryFirst !== b.isDirectory) return directoryFirst ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });

    const title = Bun.escapeHTML(`Index of /${segments.map(segment => segment + "/").join("")}`);
    let rows = segments.length === 0 ? "" : `<tr><td><a href="../">../</a></td><td></td><td></td></tr>\n`;
    for (const { name, isDirectory, size, mtime } of entries) {
      const slash = isDirectory ? "/" : "";
      rows +=
        `<tr><td><a href="${encodeURIComponent(name)}${slash}">${Bun.escapeHTML(name)}${slash}</a></td>` +
        `<td>${isDirectory ? "" : formatSize(size)}</td><td>${formatTime(mtime)}</td></tr>\n`;
    }

    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${title}</title>
<style>${listingStyle}</style>
</head>
<body>
<h1>${title}</h1>
<table>
${rows}</table>
</body>
</html>
`;
    return new Response(html, {
      headers: { ...baseHeaders, "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-cache" },
    });
  }

  // `route` is the last segment of a path that could be a route of a single-page app, or null for
  // a path that was refused: that one gets a 404 with or without --spa.
  async function sendNotFound(req: Request, route: string | null | undefined): Promise<Response> {
    // A name with a dot is a missing asset. Answering it with the app's HTML hides the 404.
    if (spa && route !== null && !route?.includes(".")) {
      const index = await find(path.join(root, "index.html"));
      if (index?.stat.isFile()) return sendFile(req, index);
    }

    const notFoundPage = await find(path.join(root, "404.html"));
    if (notFoundPage?.stat.isFile()) return sendFile(req, notFoundPage, 404);

    return text(404, "404 Not Found");
  }

  async function respond(req: Request, url: URL): Promise<Response> {
    const method = req.method;
    if (method === "OPTIONS" && cors) {
      return new Response(null, {
        status: 204,
        headers: {
          ...baseHeaders,
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
          "Access-Control-Allow-Headers": req.headers.get("access-control-request-headers") ?? "*",
          "Access-Control-Max-Age": "86400",
        },
      });
    }
    if (method !== "GET" && method !== "HEAD") {
      return text(405, "405 Method Not Allowed", { Allow: cors ? "GET, HEAD, OPTIONS" : "GET, HEAD" });
    }

    const decoded = decodeSegments(url.pathname);
    if (decoded === null) return sendNotFound(req, null);

    const { segments, trailingSlash } = decoded;
    if (!dotfiles && hasHidden(segments)) return sendNotFound(req, null);

    const lastSegment = segments[segments.length - 1];
    const file: string = path.join(root, ...segments);
    const found = await find(file);

    if (found?.stat.isFile() && !trailingSlash) {
      return sendFile(req, found);
    }

    // Clean URLs: "/about" finds "about.html", also next to a directory named "about".
    if (!trailingSlash && lastSegment !== undefined && !lastSegment.includes(".")) {
      const html = await find(file + ".html");
      if (html?.stat.isFile()) return sendFile(req, html);
    }

    if (found?.stat.isDirectory()) {
      // Relative links in a directory's page only resolve against a URL that ends in "/". The
      // pathname starts with one "/" and a non-empty segment here, so this cannot redirect off-site.
      // A browser would cache a 301 for good, and the next project on this port has other directories.
      if (!trailingSlash && segments.length > 0) {
        return new Response(null, {
          status: 301,
          headers: { ...baseHeaders, "Location": url.pathname + "/" + url.search, "Cache-Control": "no-cache" },
        });
      }
      const index = await find(path.join(file, "index.html"));
      if (index?.stat.isFile()) return sendFile(req, index);
      if (listing) return sendListing(segments, found.real);
    }

    return sendNotFound(req, lastSegment);
  }

  function logRequest(req: Request, target: string, status: number, startedAt: number) {
    const elapsed = (performance.now() - startedAt).toFixed(1);
    if (colors) {
      const color = status >= 500 ? 31 : status >= 400 ? 33 : status >= 300 ? 36 : 32;
      console.log(`\x1b[2m${req.method}\x1b[0m ${target} \x1b[${color}m${status}\x1b[0m \x1b[2m${elapsed}ms\x1b[0m`);
    } else {
      console.log(`${req.method} ${target} ${status} ${elapsed}ms`);
    }
  }

  async function fetch(req: Request): Promise<Response> {
    const startedAt = performance.now();
    // Without a usable Host header, req.url is only the path.
    const href = req.url.startsWith("/") ? "http://localhost" + req.url : req.url;
    const url = URL.parse(href);
    let response: Response;
    try {
      response = url === null ? text(400, "400 Bad Request") : await respond(req, url);
    } catch (error) {
      console.error(error);
      response = text(500, "500 Internal Server Error");
    }
    if (!quiet) logRequest(req, url === null ? req.url : url.pathname + url.search, response.status, startedAt);
    return response;
  }

  function listen(port: number | undefined): Server<undefined> {
    return Bun.serve({
      hostname: options.hostname,
      port,
      development: false,
      // `development: false` alone turns reusePort on, and two servers could then share a port.
      reusePort: false,
      fetch,
      // A file that went away between the lookup and the response.
      error(error: any) {
        if (error?.code === "ENOENT") return text(404, "404 Not Found");
        console.error(error);
        return text(500, "500 Internal Server Error");
      },
    });
  }

  let server: Server<undefined>;
  try {
    try {
      server = listen(options.port);
    } catch (error: any) {
      if (error?.code !== "EADDRINUSE" || options.port !== undefined) throw error;

      // The default port is a suggestion: take the next free one. Which port that was (--port
      // for Bun itself, bunfig.toml, the environment, or 3000) is only in the message.
      let port = Number(/\bport (\d+)\b/.exec(error.message)?.[1] ?? 3000);
      for (let remainingTries = 10; ; remainingTries--) {
        if (remainingTries === 0 || port >= 65535) throw error;
        try {
          server = listen(++port);
          break;
        } catch (retryError: any) {
          if (retryError?.code !== "EADDRINUSE") throw retryError;
        }
      }
    }
  } catch (error: any) {
    fail(
      error?.message ?? String(error),
      options.port !== undefined && error?.code === "EADDRINUSE"
        ? "pass another --port, or --port 0 for any free port"
        : undefined,
    );
  }

  const elapsed = (performance.now() - initial).toFixed(2);

  const relativeRoot: string = path.relative(process.cwd(), root);
  const displayRoot =
    relativeRoot === ""
      ? "."
      : relativeRoot === ".." || relativeRoot.startsWith(".." + path.sep) || path.isAbsolute(relativeRoot)
        ? root
        : "." + path.sep + relativeRoot;

  const urls: string[] = [];
  if (server.hostname === "0.0.0.0" || server.hostname === "::") {
    urls.push(`http://localhost:${server.port}/`);
    const interfaces = require("node:os").networkInterfaces();
    for (const name in interfaces) {
      for (const { address, family, internal } of interfaces[name]) {
        if (!internal && family === "IPv4") urls.push(`http://${address}:${server.port}/`);
      }
    }
  } else {
    urls.push(String(server.url));
  }

  if (colors) {
    console.log(
      `\x1b[1;34mBun\x1b[0m \x1b[1;34mv${Bun.version}\x1b[0m \x1b[2mready in\x1b[0m \x1b[1m${elapsed}\x1b[0m ms\n`,
    );
    for (const url of urls) console.log(`\x1b[1;34m➜\x1b[0m \x1b[36m${url}\x1b[0m`);
    console.log(`  \x1b[2mserving ${displayRoot}\x1b[0m\n`);
  } else {
    console.log(`Bun v${Bun.version} ready in ${elapsed} ms\n`);
    for (const url of urls) console.log(`url: ${url}`);
    console.log(`dir: ${displayRoot}\n`);
  }
}

export default start;
