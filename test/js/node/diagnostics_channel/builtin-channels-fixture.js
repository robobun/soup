// Runs under node and under bun, and prints the same thing under both: what the built-in channels of
// node:diagnostics_channel publish, in the order in which they publish it.
//
//   node --expose-gc builtin-channels-fixture.js
//   bun builtin-channels-fixture.js
"use strict";
const assert = require("node:assert");
const dc = require("node:diagnostics_channel");
const { once } = require("node:events");

const collect = typeof Bun !== "undefined" ? () => Bun.gc(true) : globalThis.gc;

const log = [];
function section(name) {
  log.push(`# ${name}`);
}

// The subscribers that the sections below need, each under its own name in the log.
function subscribe(name, onMessage) {
  dc.subscribe(name, onMessage);
  return () => dc.unsubscribe(name, onMessage);
}

// Nothing holds the channel of this subscription but the subscription itself. It is made before node:http is
// loaded, which is what a tracing library does: it subscribes first and the program loads its server later.
let earlyRequestStarts = 0;
dc.subscribe("http.server.request.start", function early() {
  earlyRequestStarts++;
});

async function subscriptionsOutliveTheirCaller() {
  section("a subscription holds its channel");
  dc.subscribe("fixture.nobody-holds-this-channel", message => log.push(`received ${message.text}`));
  for (let i = 0; i < 3; i++) {
    collect();
    await new Promise(resolve => setImmediate(resolve));
  }
  log.push(`hasSubscribers: ${dc.hasSubscribers("fixture.nobody-holds-this-channel")}`);
  dc.channel("fixture.nobody-holds-this-channel").publish({ text: "after a collection" });
}

async function httpServer() {
  section("http.Server");
  const http = require("node:http");
  const net = require("node:net");

  const server = http.createServer((request, response) => {
    log.push(`'request' ${request.method} ${request.url}`);
    response.setHeader("x-fixture", "1");
    response.end("ok");
  });
  const unsubscribe = [
    subscribe("tracing:net.server.listen:asyncStart", message => {
      assert.strictEqual(message.server, server);
      log.push(`net.server.listen asyncStart ${JSON.stringify(message.options)}`);
    }),
    subscribe("tracing:net.server.listen:asyncEnd", message => {
      assert.strictEqual(message.server, server);
      log.push("net.server.listen asyncEnd");
    }),
    subscribe("net.server.socket", message => {
      assert.ok(message.socket instanceof net.Socket);
      log.push("net.server.socket");
    }),
    subscribe("http.server.response.created", message => {
      assert.deepStrictEqual(Object.keys(message), ["request", "response"]);
      assert.ok(message.request instanceof http.IncomingMessage);
      assert.ok(message.response instanceof http.ServerResponse);
      assert.strictEqual(message.response.req, message.request);
      log.push(`http.server.response.created header=${message.response.getHeader("x-fixture")}`);
    }),
    subscribe("http.server.request.start", message => {
      assert.deepStrictEqual(Object.keys(message), ["request", "response", "socket", "server"]);
      assert.strictEqual(message.server, server);
      assert.strictEqual(message.socket, message.request.socket);
      assert.ok(message.socket instanceof net.Socket);
      log.push(`http.server.request.start ${message.request.url} header=${message.response.getHeader("x-fixture")}`);
    }),
    subscribe("http.server.response.finish", message => {
      assert.deepStrictEqual(Object.keys(message), ["request", "response", "socket", "server"]);
      assert.strictEqual(message.server, server);
      assert.ok(message.socket instanceof net.Socket);
      log.push(`http.server.response.finish ${message.request.url} header=${message.response.getHeader("x-fixture")}`);
    }),
  ];

  server.listen({ port: 0, host: "127.0.0.1", fixtureOption: true });
  await once(server, "listening");
  const { port } = server.address();

  const response = await new Promise((resolve, reject) => {
    http.get({ port, host: "127.0.0.1", path: "/plain", agent: false }, resolve).on("error", reject);
  });
  response.resume();
  await once(response, "end");
  log.push(`the subscriber from before node:http was loaded saw ${earlyRequestStarts} request`);

  // An upgrade that the server takes has no response, so nothing is announced for it.
  server.on("upgrade", (request, socket) => {
    log.push(`'upgrade' ${request.url}`);
    socket.end("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: fixture\r\n\r\n");
  });
  const upgraded = net.connect(port, "127.0.0.1");
  upgraded.write("GET /upgrade HTTP/1.1\r\nHost: fixture\r\nConnection: Upgrade\r\nUpgrade: fixture\r\n\r\n");
  upgraded.resume();
  await once(upgraded, "close");

  // A response that the program makes itself is announced where it is made.
  const standalone = new http.ServerResponse(new http.IncomingMessage(new net.Socket()));
  log.push(`standalone response made: ${standalone instanceof http.ServerResponse}`);

  server.close();
  await once(server, "close");
  for (const stop of unsubscribe) stop();
}

// A response class of the program that hands its parent the request and nothing else. Its response is announced
// once, like any other.
async function httpServerWithAResponseClassOfTheProgram() {
  section("http.Server with a ServerResponse class of the program");
  const http = require("node:http");

  class ResponseOfTheProgram extends http.ServerResponse {
    constructor(request) {
      super(request);
    }
  }
  const server = http.createServer({ ServerResponse: ResponseOfTheProgram }, (request, response) => {
    log.push(`'request' ${response.constructor.name}`);
    response.end("ok");
  });
  const unsubscribe = ["http.server.response.created", "http.server.request.start", "http.server.response.finish"].map(
    name => subscribe(name, message => log.push(`${name} ${message.response.constructor.name}`)),
  );

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const response = await new Promise((resolve, reject) => {
    http.get({ port: server.address().port, host: "127.0.0.1", agent: false }, resolve).on("error", reject);
  });
  response.resume();
  await once(response, "end");

  server.close();
  await once(server, "close");
  for (const stop of unsubscribe) stop();
}

// A server reads HTTP from any stream that it is handed as a connection, and announces the requests on it too.
async function httpServerOverAStream() {
  section("http.Server over a stream of the program");
  const http = require("node:http");
  const { duplexPair } = require("node:stream");

  const server = http.createServer((request, response) => {
    log.push(`'request' ${request.url}`);
    response.end("ok");
  });
  const unsubscribe = [
    subscribe("http.server.response.created", message => {
      log.push(`http.server.response.created ${message.request.url}`);
    }),
    subscribe("http.server.request.start", message => {
      assert.strictEqual(message.server, server);
      assert.strictEqual(message.socket, message.request.socket);
      log.push(`http.server.request.start ${message.request.url}`);
    }),
    subscribe("http.server.response.finish", message => {
      assert.strictEqual(message.server, server);
      assert.strictEqual(message.socket, message.request.socket);
      log.push(`http.server.response.finish ${message.request.url}`);
    }),
  ];

  const [clientSide, serverSide] = duplexPair();
  server.emit("connection", serverSide);
  clientSide.end("GET /over-a-stream HTTP/1.1\r\nHost: fixture\r\nConnection: close\r\n\r\n");
  let answer = "";
  clientSide.setEncoding("latin1");
  clientSide.on("data", chunk => (answer += chunk));
  await once(clientSide, "end");
  log.push(`answered ${answer.split("\r\n", 1)[0]}`);
  for (const stop of unsubscribe) stop();
}

async function netServer() {
  section("net.Server");
  const net = require("node:net");

  const server = net.createServer(socket => {
    log.push("'connection'");
    socket.end();
  });
  const unsubscribe = [
    subscribe("tracing:net.server.listen:asyncStart", message => {
      log.push(
        `net.server.listen asyncStart ${message.server === server ? "server" : "other"} port=${typeof message.options.port}`,
      );
    }),
    subscribe("tracing:net.server.listen:asyncEnd", message => {
      log.push(`net.server.listen asyncEnd ${message.server === server ? "server" : "other"}`);
    }),
    subscribe("tracing:net.server.listen:error", message => {
      log.push(`net.server.listen error ${message.error.code}`);
    }),
    subscribe("net.client.socket", message => {
      assert.ok(message.socket instanceof net.Socket);
      log.push(`net.client.socket connecting=${message.socket.connecting}`);
    }),
    subscribe("net.server.socket", message => {
      assert.ok(message.socket instanceof net.Socket);
      log.push("net.server.socket");
    }),
  ];

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();

  const client = net.connect(port, "127.0.0.1");
  client.resume();
  await once(client, "close");

  // The port is taken.
  const second = net.createServer();
  second.on("error", error => log.push(`'error' ${error.code}`));
  second.listen(port, "127.0.0.1");
  await once(second, "error");

  server.close();
  await once(server, "close");
  for (const stop of unsubscribe) stop();
}

async function childProcess() {
  section("child_process");
  const { ChildProcess, spawn, spawnSync } = require("node:child_process");

  const unsubscribe = [
    subscribe("child_process", message => {
      assert.ok(message.process instanceof ChildProcess);
      log.push(`child_process pid=${typeof message.process.pid}`);
    }),
    subscribe("tracing:child_process.spawn:start", message => {
      assert.deepStrictEqual(Object.keys(message), ["process", "options"]);
      log.push(`child_process.spawn start pid=${typeof message.process.pid} file=${typeof message.options.file}`);
    }),
    subscribe("tracing:child_process.spawn:end", message => {
      assert.deepStrictEqual(Object.keys(message), ["process"]);
      log.push(`child_process.spawn end pid=${typeof message.process.pid}`);
    }),
    subscribe("tracing:child_process.spawn:error", message => {
      assert.deepStrictEqual(Object.keys(message), ["process", "error"]);
      const { error } = message;
      log.push(`child_process.spawn error ${error.code} syscall=${error.syscall} message=${error.message}`);
    }),
    // The pipes of a child are no connections that a client makes.
    subscribe("net.client.socket", () => log.push("net.client.socket")),
  ];

  const child = spawn(process.execPath, ["-e", "0"], { stdio: ["ignore", "pipe", "pipe", "pipe"] });
  log.push(`spawn() returned pid=${typeof child.pid}`);
  await once(child, "close");

  spawnSync(process.execPath, ["-e", "0"]);
  log.push("spawnSync() returned");

  const missing = spawn("fixture-command-that-does-not-exist");
  log.push("spawn() of a missing command returned");
  const [error] = await once(missing, "error");
  log.push(`'error' ${error.code} syscall=${error.syscall}`);

  for (const stop of unsubscribe) stop();
}

async function workerThreads() {
  section("worker_threads");
  const { Worker } = require("node:worker_threads");

  const unsubscribe = subscribe("worker_threads", message => {
    assert.deepStrictEqual(Object.keys(message), ["worker"]);
    assert.ok(message.worker instanceof Worker);
    log.push("worker_threads");
  });
  process.once("worker", () => log.push("'worker' of process"));
  const worker = new Worker("1", { eval: true });
  log.push("new Worker() returned");
  await once(worker, "exit");
  unsubscribe();
}

function tracingChannels() {
  section("TracingChannel#hasSubscribers");
  const tracing = dc.tracingChannel("fixture.tracing");
  const handlers = { asyncEnd() {} };
  log.push(`before: ${tracing.hasSubscribers}`);
  tracing.subscribe(handlers);
  log.push(`subscribed: ${tracing.hasSubscribers}`);
  tracing.unsubscribe(handlers);
  log.push(`unsubscribed: ${tracing.hasSubscribers}`);
}

(async () => {
  await subscriptionsOutliveTheirCaller();
  await httpServer();
  await httpServerWithAResponseClassOfTheProgram();
  await httpServerOverAStream();
  await netServer();
  await childProcess();
  await workerThreads();
  tracingChannels();
  console.log(log.join("\n"));
})();
