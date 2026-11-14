// Runs under node and under bun, and prints the same thing under both: what the built-in channels of
// node:diagnostics_channel publish in a cluster worker that shares the primary's listening socket.
"use strict";
const cluster = require("node:cluster");
const dc = require("node:diagnostics_channel");
const net = require("node:net");

if (cluster.isPrimary) {
  const worker = cluster.fork();
  worker.on("message", message => {
    if (message.port) {
      net.connect(message.port, "127.0.0.1").resume();
    } else {
      console.log(message.log.join("\n"));
      worker.disconnect();
    }
  });
} else {
  const log = [];
  dc.subscribe("tracing:net.server.listen:asyncStart", ({ server: listening }) => {
    log.push(`net.server.listen asyncStart ${listening === server ? "server" : "other"}`);
  });
  dc.subscribe("tracing:net.server.listen:asyncEnd", ({ server: listening }) => {
    log.push(`net.server.listen asyncEnd ${listening === server ? "server" : "other"}`);
  });
  dc.subscribe("tracing:net.server.listen:error", () => log.push("net.server.listen error"));
  // The worker takes the connection over from the primary. It is none that a client of its own makes.
  dc.subscribe("net.client.socket", () => log.push("net.client.socket"));
  dc.subscribe("net.server.socket", ({ socket }) => {
    log.push(`net.server.socket ${socket instanceof net.Socket ? "net.Socket" : typeof socket}`);
  });

  const server = net.createServer(socket => {
    log.push("'connection'");
    socket.end();
    // After the subscriber of "net.server.socket", which runs when this listener has returned.
    setImmediate(() => process.send({ log }));
  });
  server.listen(0, "127.0.0.1", () => {
    log.push("'listening'");
    process.send({ port: server.address().port });
  });
}
