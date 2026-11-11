import { describe, expect, test } from "bun:test";
import { blackholePortSource, bunEnv, bunExe, isMusl, isWindows, tempDir, tls as certificate } from "harness";
import net from "node:net";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { decodeBody, MailServer, parseMessage, trusted, type ServerOptions } from "./mail-server";

// The session of Bun.SMTPClient: connecting, TLS, logging in, sending and what can go wrong. What
// a message looks like is in smtp-message.test.ts.

const message = { from: "a@example.com", to: "b@example.com", text: "x" };
const transaction = ["MAIL FROM:<a@example.com>", "RCPT TO:<b@example.com>", "DATA"];

/** Whether a connection to `host` reaches a server that listens on 127.0.0.1. */
async function reachesThisMachine(host: string): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  using listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open() {
        resolve(true);
      },
      data() {},
    },
  });
  Bun.connect({
    hostname: host,
    port: listener.port,
    socket: {
      open(socket) {
        socket.end();
      },
      data() {},
      connectError() {
        resolve(false);
      },
    },
  }).catch(() => resolve(false));
  // A name that leads nowhere may take its time to say so.
  const timer = setTimeout(resolve, 2000, false);
  try {
    return await promise;
  } finally {
    clearTimeout(timer);
  }
}

// Names under which a server on 127.0.0.1 can be reached that do not say that it is this machine:
// what inet_aton() takes for an address, the address that means any, a name with "localhost" in
// it, the name of the machine, and an IPv6 form. Which of them connect depends on the machine.
const otherNames = ["127.1", "0.0.0.0", "localhost.", hostname(), "::ffff:127.0.0.1"];
const reachable = await Promise.all(otherNames.map(reachesThisMachine));
const otherName = otherNames.find((_, i) => reachable[i]);

/** Lets the sockets of this process have `turns` rounds of the event loop. */
async function turns(count: number) {
  for (let i = 0; i < count; i++) await new Promise<void>(resolve => setImmediate(resolve));
}

describe("Bun.SMTPClient session", () => {
  test("says EHLO, then one MAIL, RCPT and DATA per message, and QUIT on close()", async () => {
    await using server = await MailServer.listen({ extensions: ["SIZE 1000000", "8BITMIME", "PIPELINING"] });
    const client = new Bun.SMTPClient({ host: "127.0.0.1", port: server.port, name: "client.example.com" });
    expect(client.connected).toBe(false);

    const two = { from: "a@example.com", to: ["b@example.com", "c@example.com"], text: "x" };
    await client.send(two);
    expect(client.connected).toBe(true);
    await client.send(two);
    await client.close();
    expect(client.connected).toBe(false);

    const size = Buffer.byteLength(server.messages[0].data);
    expect(server.sessions).toHaveLength(1);
    expect(server.sessions[0].hello).toBe("client.example.com");
    expect(server.commands).toEqual([
      "EHLO",
      `MAIL FROM:<a@example.com> SIZE=${size}`,
      "RCPT TO:<b@example.com>",
      "RCPT TO:<c@example.com>",
      "DATA",
      // Asks whether the connection is still there before it is used again.
      "RSET",
      `MAIL FROM:<a@example.com> SIZE=${size}`,
      "RCPT TO:<b@example.com>",
      "RCPT TO:<c@example.com>",
      "DATA",
      "QUIT",
    ]);

    // A closed client connects again when it is used.
    await client.send(message);
    expect(server.sessions).toHaveLength(2);
    await client.close();
  });

  test("calls itself by the host name of the machine when that is a full name, and by an address otherwise", async () => {
    await using server = await MailServer.listen();
    await using client = new Bun.SMTPClient(server.url);
    await client.verify();
    expect(server.sessions[0].hello).toMatch(/^(\[127\.0\.0\.1\]|[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+)$/);
  });

  test("messages sent at once go one after the other, in the order of the calls", async () => {
    await using server = await MailServer.listen();
    await using client = new Bun.SMTPClient(server.url);

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        client.send({
          from: "a@example.com",
          to: `to${i}@example.com`,
          text: "x",
          // The first one has a file to read before it can be written.
          attachments: i === 0 ? [{ filename: "a.txt", content: new Blob(["a"]) }] : [],
        }),
      ),
    );
    expect(server.sessions).toHaveLength(1);
    expect(server.messages.map(received => received.to[0])).toEqual([0, 1, 2, 3, 4].map(i => `to${i}@example.com`));
    expect(results.map(result => result.response)).toEqual([1, 2, 3, 4, 5].map(n => `250 2.0.0 Ok: queued as ${n}`));
  });

  test("close() sends what is waiting first, and says QUIT once", async () => {
    await using server = await MailServer.listen();
    const client = new Bun.SMTPClient(server.url);

    const sends = [1, 2, 3].map(i => client.send({ ...message, to: `to${i}@example.com` }));
    await client.close();
    // They were sent before close() was done, so nothing is left to wait for.
    expect(server.messages.map(received => received.to[0])).toEqual([1, 2, 3].map(i => `to${i}@example.com`));
    await Promise.all(sends);
    expect(server.sessions).toHaveLength(1);
    expect(server.commands.filter(command => command === "QUIT")).toEqual(["QUIT"]);
    expect(server.commands.at(-1)).toBe("QUIT");
  });

  test("connects again when the server has closed an idle connection", async () => {
    await using server = await MailServer.listen();
    await using client = new Bun.SMTPClient(server.url);

    await client.send(message);
    server.dropConnections();
    await client.send(message);
    expect(server.messages).toHaveLength(2);
    expect(server.sessions).toHaveLength(2);

    // A server that says goodbye in answer to the check of the connection.
    await using polite = await MailServer.listen({
      reply: (command, session) =>
        command === "RSET" && session.commands.filter(c => c === "RSET").length === 1
          ? "421 4.4.2 Idle for too long, closing"
          : undefined,
    });
    await using other = new Bun.SMTPClient(polite.url);
    await other.send(message);
    await other.send(message);
    expect(polite.messages).toHaveLength(2);
    expect(polite.sessions).toHaveLength(2);
  });

  test("a reply that no command asked for is not taken for the answer to the next command", async () => {
    // The goodbye comes in the same packet as the answer to the data, so the client has it before
    // the next message starts.
    await using server = await MailServer.listen({ accept: "250 2.0.0 Ok\r\n421 4.4.2 Closing soon" });
    await using client = new Bun.SMTPClient(server.url);

    expect((await client.send(message)).response).toBe("250 2.0.0 Ok");
    expect((await client.send(message)).response).toBe("250 2.0.0 Ok");
    // Neither RSET nor MAIL went to the session that had said 421.
    expect(server.sessions.map(session => session.commands)).toEqual([
      ["EHLO", ...transaction],
      ["EHLO", ...transaction],
    ]);
  });

  test("verify() connects and logs in without sending anything", async () => {
    await using server = await MailServer.listen({ auth: { user: "ada", pass: "secret" } });
    await using client = new Bun.SMTPClient(server.url, { auth: { user: "ada", pass: "secret" } });
    expect(await client.verify()).toBe(true);
    expect(server.commands).toEqual(["EHLO", "AUTH PLAIN"]);
    expect(server.sessions[0].authenticated).toBe(true);

    await using wrong = new Bun.SMTPClient(server.url, { auth: { user: "ada", pass: "wrong" } });
    expect(await wrong.verify().catch(error => error.code)).toBe("ERR_SMTP_AUTHENTICATION_FAILED");
  });

  test("reads replies of several lines, and falls back to HELO", async () => {
    await using server = await MailServer.listen({
      greeting: "220-mail.test ESMTP\r\n220-second line\r\n220 third line",
      reply: command => (command.startsWith("EHLO") ? "502 5.5.1 Command not implemented" : undefined),
      accept: "250-2.0.0 Ok\r\n250 queued as ABC",
    });
    await using client = new Bun.SMTPClient(server.url);
    const result = await client.send(message);
    expect(result.response).toBe("250 2.0.0 Ok queued as ABC");
    expect(server.commands).toEqual(["EHLO", "HELO", ...transaction]);
  });

  test("a reply that comes in pieces is one reply", async () => {
    // Every piece in a turn of the event loop of its own, so that the client reads it alone: cut
    // inside a line, between the lines of one reply, and between a CR and its LF.
    const server = net.createServer(socket => {
      socket.setNoDelay(true);
      const inPieces = async (...pieces: string[]) => {
        for (const piece of pieces) {
          socket.write(piece);
          await turns(2);
        }
      };
      inPieces("22", "0 mail.test ESMTP\r", "\n");
      socket.on("data", chunk => {
        const line = chunk.toString();
        if (line.startsWith("EHLO"))
          inPieces("250-mail.test\r\n", "250-SIZE 100\r\n", "250-PIPE", "LINING\r\n250 8BITMIME\r\n");
        else if (line.startsWith("RSET")) inPieces("25", "0 Reset\r\n");
        else if (line.startsWith("QUIT")) socket.end("221 Bye\r\n");
      });
      socket.on("error", () => {});
    });
    const { promise, resolve } = Promise.withResolvers<void>();
    server.listen(0, "127.0.0.1", resolve);
    await promise;
    try {
      const client = new Bun.SMTPClient({ port: (server.address() as net.AddressInfo).port, host: "127.0.0.1" });
      expect(await client.verify()).toBe(true);
      // The limit of SIZE is known before MAIL FROM is sent: the whole answer to EHLO was read.
      const error = await client.send({ ...message, text: Buffer.alloc(200, "x").toString() }).catch(e => e);
      expect(error.code).toBe("ERR_SMTP_MESSAGE_REJECTED");
      expect(error.message).toContain("takes 100 bytes at most");
      await client.close();
    } finally {
      server.close();
    }
  });

  test("await using closes the connection", async () => {
    await using server = await MailServer.listen();
    {
      await using client = new Bun.SMTPClient(server.url);
      await client.verify();
    }
    expect(server.commands).toEqual(["EHLO", "QUIT"]);
  });

  test.each([
    ["in clear text", {}],
    ["after STARTTLS", { starttls: true }],
    ["with TLS", { secure: true }],
  ] as const)("an idle connection does not keep the process alive %s", async (_, options) => {
    await using server = await MailServer.listen(options);
    await using proc = Bun.spawn({
      cmd: [
        bunExe(),
        "-e",
        `const client = new Bun.SMTPClient(process.argv[1], { tls: { ca: process.env.SMTP_TEST_CA } });
         const message = { from: "a@example.com", to: "b@example.com", text: "x" };
         const result = await client.send(message);
         console.log(result.response, client.connected, client.secure);
         // Nobody waits for this one. The process stays until it is sent, and no longer.
         client.send(message);`,
        server.url,
      ],
      env: { ...bunEnv, SMTP_TEST_CA: certificate.cert },
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect({ stdout, stderr, exitCode }).toEqual({
      stdout: `250 2.0.0 Ok: queued as 1 true ${options !== undefined && Object.keys(options).length > 0}\n`,
      stderr: "",
      exitCode: 0,
    });
    expect(server.messages).toHaveLength(2);
  });

  test("an idle connection is closed with QUIT after idleTimeout", async () => {
    await using server = await MailServer.listen();
    await using client = new Bun.SMTPClient(server.url, { idleTimeout: 20 });

    await client.send(message);
    await server.connectionsClosed();
    expect(server.commands).toEqual(["EHLO", ...transaction, "QUIT"]);
    expect(client.connected).toBe(false);

    // The next message has a connection of its own.
    await client.send(message);
    expect(server.sessions).toHaveLength(2);
  });

  // module-graph-isolation.test.ts, "every property of Bun is classified", names this test.
  test("the connection of a client is the maker's: a Bun.ModuleGraph takes its own along, and leaves the host's", async () => {
    using dir = tempDir("smtp-graph", {
      "tenant-fixture.ts": `
        export const client = new Bun.SMTPClient(process.env.SMTP_URL);
        // The tenant is the first to use the client of the host, so the connection is opened for it.
        export const sent = hostClient.send({ from: "tenant@example.com", to: "b@example.com", text: "x" });
      `,
    });
    await using server = await MailServer.listen();
    await using hostClient = new Bun.SMTPClient(server.url);
    const graph = new Bun.ModuleGraph({
      globals: {
        hostClient,
        process: Object.create(process, { env: { value: { ...process.env, SMTP_URL: server.url } } }),
      },
    });
    let disposed = false;
    using _ = {
      [Symbol.dispose]() {
        if (!disposed) graph.dispose();
      },
    };
    const tenant = await graph.import(join(String(dir), "tenant-fixture.ts"));
    await tenant.sent;
    // The host is the one that has the tenant's client connect. The connection is the tenant's all the same.
    expect(await tenant.client.verify()).toBe(true);
    expect(server.sessions).toHaveLength(2);

    graph.dispose();
    disposed = true;
    // The host's client has its connection, and takes the next message over it.
    expect(hostClient.connected).toBe(true);
    await hostClient.send(message);
    expect(server.sessions[0].commands).toEqual([
      "EHLO",
      "MAIL FROM:<tenant@example.com>",
      "RCPT TO:<b@example.com>",
      "DATA",
      "RSET",
      ...transaction,
    ]);
    // The tenant's connection went with the graph, without a QUIT, and its client says so.
    expect(server.sessions[1].commands).toEqual(["EHLO"]);
    const error = await tenant.client.send(message).catch((error: Error) => error);
    expect({ code: error.code, message: error.message }).toEqual({
      code: "ERR_SMTP_CONNECTION_CLOSED",
      message: "The Bun.ModuleGraph that made this client was disposed, and its connection with it",
    });
    expect(server.sessions).toHaveLength(2);
    // It is closed, and closing it again is nothing to fail for.
    expect(tenant.client.connected).toBe(false);
    expect(await tenant.client.close()).toBeUndefined();
  });

  test("a send() that nobody waits for fails like any promise that nobody waits for", async () => {
    // Nothing listens here.
    const unused = await MailServer.listen();
    const { port } = unused;
    await unused[Symbol.asyncDispose]();
    await using proc = Bun.spawn({
      cmd: [
        bunExe(),
        "-e",
        `new Bun.SMTPClient({ host: "127.0.0.1", port: ${port} }).send({ from: "a@example.com", to: "b@example.com", text: "x" });`,
      ],
      env: bunEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect(stderr).toContain("ECONNREFUSED");
    expect({ stdout, exitCode }).toEqual({ stdout: "", exitCode: 1 });
  });

  test.each([
    ["after STARTTLS", { starttls: true }],
    ["with TLS", { secure: true }],
  ] as const)(
    "the process does not stay for a server that leaves the end of a TLS session unanswered %s",
    async (_, options) => {
      // After QUIT this server says 221, and then neither closes nor reads what the client sends.
      await using server = await MailServer.listen({ ...options, stubborn: true });
      await using proc = Bun.spawn({
        cmd: [
          bunExe(),
          "-e",
          `const client = new Bun.SMTPClient(process.argv[1], { tls: { ca: process.env.SMTP_TEST_CA } });
         await client.send({ from: "a@example.com", to: "b@example.com", text: "x" });
         await client.close();
         console.log("closed", client.connected);`,
          server.url,
        ],
        env: { ...bunEnv, SMTP_TEST_CA: certificate.cert },
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      expect({ stdout, stderr, exitCode }).toEqual({ stdout: "closed false\n", stderr: "", exitCode: 0 });
      expect(server.commands.at(-1)).toBe("QUIT");
    },
  );

  // 4 MB on the wire: more than a socket takes in one write, so the rest waits for it to drain.
  test.each([
    ["in clear text", {}],
    ["after STARTTLS", { starttls: true }],
  ] as const)("a large attachment arrives whole %s", async (_, options) => {
    const bytes = Buffer.alloc(3 * 1024 * 1024);
    for (let i = 0; i < bytes.length; i += 65536) crypto.getRandomValues(bytes.subarray(i, i + 65536));
    await using server = await MailServer.listen(options);
    await using client = new Bun.SMTPClient(server.url, { tls: trusted });
    await client.send({ ...message, attachments: [{ filename: "big.bin", content: bytes }] });
    const received = decodeBody(parseMessage(server.messages[0].data).parts[1]);
    expect([received.length, Bun.hash(received)]).toEqual([bytes.length, Bun.hash(bytes)]);
  });

  test("a server that ends a connection with 421 gets the message over a new one", async () => {
    // Three messages per connection, and then 421 to every MAIL FROM, with the connection left open.
    let mails = 0;
    await using server = await MailServer.listen({
      reply: (command, session) => {
        if (!command.startsWith("MAIL")) return undefined;
        mails++;
        return session.commands.filter(c => c.startsWith("MAIL")).length > 3
          ? "421 4.7.0 Too many messages in this connection"
          : undefined;
      },
    });
    await using client = new Bun.SMTPClient(server.url);
    for (let i = 0; i < 8; i++) await client.send({ ...message, to: `to${i}@example.com` });

    // Nothing of a message had been sent when its MAIL FROM got the 421, so each arrived once.
    expect(server.messages.map(received => received.to[0])).toEqual(
      Array.from({ length: 8 }, (_, i) => `to${i}@example.com`),
    );
    expect(server.sessions).toHaveLength(3);
    expect(mails).toBe(10);
    // The client said QUIT to a session that had said 421.
    expect(server.sessions[0].commands.slice(-2)).toEqual(["MAIL FROM:<a@example.com>", "QUIT"]);
  });

  test.each(["RCPT", "DATA"])(
    "421 in answer to %s on a connection that was used: the server has nothing of the message, and gets it over a new one",
    async verb => {
      let said = false;
      await using server = await MailServer.listen({
        reply: (command, _session, server) => {
          // Once, to the second message.
          if (said || server.messages.length !== 1 || !command.startsWith(verb)) return undefined;
          said = true;
          return "421 4.7.0 Too many messages in this connection";
        },
      });
      await using client = new Bun.SMTPClient(server.url);
      await client.send(message);
      await client.send({ ...message, to: "second@example.com" });
      expect(server.messages.map(received => received.to[0])).toEqual(["b@example.com", "second@example.com"]);
      expect(server.sessions).toHaveLength(2);
      expect(server.sessions[0].commands.at(-1)).toBe("QUIT");
    },
  );

  test("421 in answer to the data is not sent again: the server may have the message", async () => {
    const options: ServerOptions = {};
    await using server = await MailServer.listen(options);
    await using client = new Bun.SMTPClient(server.url);
    await client.send(message);
    // The connection has carried a message, which is when a 421 before the data is tried again.
    options.accept = "421 4.3.0 Closing, try again later";
    const error = await client.send({ ...message, to: "second@example.com" }).catch(error => error);
    expect([error.code, error.command, error.responseCode]).toEqual(["ERR_SMTP_CONNECTION_CLOSED", "DATA", 421]);
    // One copy of each at the server, and no second session.
    expect(server.messages.map(received => received.to[0])).toEqual(["b@example.com", "second@example.com"]);
    expect(server.sessions).toHaveLength(1);
  });

  test("421 on a new connection, to a recipient or after the data is an error with the reply, and ends the session", async () => {
    const seen: Record<string, unknown> = {};
    for (const [name, options] of Object.entries({
      "MAIL FROM": { reply: (command: string) => (command.startsWith("MAIL") ? "421 4.3.2 Shutting down" : undefined) },
      "RCPT TO": {
        reply: (command: string) => (command === "RCPT TO:<c@example.com>" ? "421 4.7.0 Too many errors" : undefined),
      },
      "DATA": { accept: "421 4.3.0 Try again later" },
    } satisfies Record<string, ServerOptions>)) {
      await using server = await MailServer.listen(options);
      await using client = new Bun.SMTPClient(server.url);
      const error = await client
        .send({ ...message, to: ["b@example.com", "c@example.com", "d@example.com"] })
        .catch(e => e);
      seen[name] = [error.code, error.command, error.responseCode, error.message, client.connected];
      // No second try, because the connection was new, and no recipient after the one that got the 421.
      expect(server.sessions).toHaveLength(1);
      if (name === "RCPT TO") expect(server.commands).not.toContain("RCPT TO:<d@example.com>");
    }
    expect(seen).toEqual({
      "MAIL FROM": [
        "ERR_SMTP_CONNECTION_CLOSED",
        "MAIL FROM",
        421,
        "The server is closing the connection: 421 4.3.2 Shutting down",
        false,
      ],
      "RCPT TO": [
        "ERR_SMTP_CONNECTION_CLOSED",
        "RCPT TO",
        421,
        "The server is closing the connection: 421 4.7.0 Too many errors",
        false,
      ],
      "DATA": [
        "ERR_SMTP_CONNECTION_CLOSED",
        "DATA",
        421,
        "The server is closing the connection: 421 4.3.0 Try again later",
        false,
      ],
    });
  });

  test("a connection carries a hundred messages, and the next one has a new connection", async () => {
    await using server = await MailServer.listen();
    await using client = new Bun.SMTPClient(server.url);
    for (let i = 0; i < 101; i++) await client.send(message);
    expect(server.messages).toHaveLength(101);
    expect(server.sessions.map(session => session.commands.filter(c => c === "DATA").length)).toEqual([100, 1]);
    expect(server.sessions[0].commands.at(-1)).toBe("QUIT");
  });

  test("the messages that wait while a connection attempt fails share its error", async () => {
    // A server that takes the connection and says nothing.
    await using mute = await MailServer.listen({ greeting: null });
    await using client = new Bun.SMTPClient(mute.url, { connectionTimeout: 100 });

    // The last ones have a file that is not there. Nothing reads the files of a message that is not
    // going to be sent, so nothing finds that out.
    const missing = { ...message, attachments: [{ path: join(tmpdir(), "smtp-test-no-such-file.bin") }] };
    const results = await Promise.allSettled([
      ...Array.from({ length: 4 }, () => client.send(message)),
      client.send(missing),
      client.send(missing),
    ]);
    const errors = results.map(result => (result as PromiseRejectedResult).reason);
    expect(errors.map(error => error.code)).toEqual(Array(6).fill("ERR_SMTP_CONNECTION_TIMEOUT"));
    // One attempt, and not a timeout per message.
    expect(new Set(errors).size).toBe(1);
    expect(mute.sessions).toHaveLength(1);

    // What is asked for afterwards is a new attempt.
    expect(await client.verify().catch(error => error.code)).toBe("ERR_SMTP_CONNECTION_TIMEOUT");
    expect(mute.sessions).toHaveLength(2);
  });

  test("a connection that does not answer the check is replaced", async () => {
    await using server = await MailServer.listen({
      reply: command => (command === "RSET" ? "silence" : undefined),
    });
    // The check has five seconds, or socketTimeout when that is less. A second is time enough for
    // every other reply of the session, also on a machine that has more to do.
    await using client = new Bun.SMTPClient(server.url, { socketTimeout: 1000 });
    await client.send(message);
    await client.send(message);
    expect(server.messages).toHaveLength(2);
    expect(server.sessions.map(session => session.commands)).toEqual([
      ["EHLO", ...transaction, "RSET"],
      ["EHLO", ...transaction],
    ]);
  });
});

// ───────────────────────────── authentication and TLS ─────────────────────────────

describe("Bun.SMTPClient authentication", () => {
  test("uses PLAIN, LOGIN or XOAUTH2, whichever the server offers for the credentials", async () => {
    const used: Record<string, unknown> = {};
    for (const [name, methods, auth] of [
      ["plain", ["PLAIN", "LOGIN"], { user: "ada@example.com", pass: "p@ss wörd" }],
      ["login", ["LOGIN"], { user: "ada@example.com", pass: "p@ss wörd" }],
      ["forced login", ["PLAIN", "LOGIN"], { user: "ada@example.com", pass: "p@ss wörd", method: "login" }],
      ["xoauth2", ["PLAIN", "XOAUTH2"], { user: "ada@example.com", accessToken: "ya29.token" }],
    ] as const) {
      await using server = await MailServer.listen({
        auth: { user: "ada@example.com", pass: "p@ss wörd", accessToken: "ya29.token", methods: [...methods] },
      });
      await using client = new Bun.SMTPClient(server.url, { auth });
      await client.send(message);
      used[name] = [server.commands[1], server.sessions[0].authenticated, server.messages.length];
    }
    expect(used).toEqual({
      "plain": ["AUTH PLAIN", true, 1],
      "login": ["AUTH LOGIN", true, 1],
      "forced login": ["AUTH LOGIN", true, 1],
      "xoauth2": ["AUTH XOAUTH2", true, 1],
    });
  });

  test("a response that does not fit on the command line of AUTH goes on a line of its own", async () => {
    // An access token is often a JWT of some thousand characters, and a command line has 512.
    const accessToken = Buffer.alloc(2000, "t").toString();
    const pass = Buffer.alloc(500, "p").toString();
    await using server = await MailServer.listen({ auth: { user: "ada", pass, accessToken } });
    await using byToken = new Bun.SMTPClient(server.url, { auth: { user: "ada", accessToken } });
    await using byPassword = new Bun.SMTPClient(server.url, { auth: { user: "ada", pass } });
    await using wrong = new Bun.SMTPClient(server.url, { auth: { user: "ada", accessToken: accessToken + "x" } });
    expect(await byToken.verify()).toBe(true);
    expect(await byPassword.verify()).toBe(true);
    const error = await wrong.verify().catch(error => error);
    expect([error.code, error.command, error.responseCode]).toEqual([
      "ERR_SMTP_AUTHENTICATION_FAILED",
      "AUTH XOAUTH2",
      535,
    ]);
    expect(server.sessions.map(session => [session.commands, session.authenticated])).toEqual([
      [["EHLO", "AUTH XOAUTH2", "(response)"], true],
      [["EHLO", "AUTH PLAIN", "(response)"], true],
      [["EHLO", "AUTH XOAUTH2", "(response)"], false],
    ]);
  });

  test("the user and the password of a URL are decoded", async () => {
    await using server = await MailServer.listen({ auth: { user: "ada@example.com", pass: "p@ss:w/rd" } });
    await using client = new Bun.SMTPClient(`smtp://ada%40example.com:p%40ss%3Aw%2Frd@127.0.0.1:${server.port}`);
    await client.send(message);
    expect(server.sessions[0].authenticated).toBe(true);
    // The credentials are not shown.
    expect(Bun.inspect(client).replace(/\s+/g, " ")).toBe(
      `SMTPClient { host: '127.0.0.1', port: ${server.port}, secure: false, connected: true }`,
    );
  });

  test("a refused login is an error with the reply of the server, and the password is not in it", async () => {
    await using server = await MailServer.listen({ auth: { user: "ada", pass: "right" } });
    const errors: unknown[] = [];
    const base64 = (text: string) => Buffer.from(text).toString("base64");
    for (const auth of [
      { user: "ada", pass: "wrong-password" },
      { user: "ada", pass: "wrong-password", method: "LOGIN" },
      { user: "ada", accessToken: "wrong-token" },
    ]) {
      await using client = new Bun.SMTPClient(server.url, { auth });
      const error = await client.send(message).catch(error => error);
      const shown = Bun.inspect(error) + JSON.stringify({ ...error, message: error.message, stack: error.stack });
      // Neither as it is nor as it went over the wire.
      for (const secret of [
        "wrong",
        base64("wrong-password"),
        base64("\0ada\0wrong-password"),
        base64("user=ada\x01auth=Bearer wrong-token\x01\x01"),
      ]) {
        expect(shown).not.toContain(secret);
      }
      errors.push([error.name, error.code, error.responseCode, error.response, error.command, error.message]);
    }
    expect(errors).toEqual([
      [
        "SMTPError",
        "ERR_SMTP_AUTHENTICATION_FAILED",
        535,
        "535 5.7.8 Authentication credentials invalid",
        "AUTH PLAIN",
        "Authentication failed: 535 5.7.8 Authentication credentials invalid",
      ],
      [
        "SMTPError",
        "ERR_SMTP_AUTHENTICATION_FAILED",
        535,
        "535 5.7.8 Authentication credentials invalid",
        "AUTH LOGIN",
        "Authentication failed: 535 5.7.8 Authentication credentials invalid",
      ],
      [
        "SMTPError",
        "ERR_SMTP_AUTHENTICATION_FAILED",
        535,
        "535 5.7.8 Username and Password not accepted",
        "AUTH XOAUTH2",
        "Authentication failed: 535 5.7.8 Username and Password not accepted",
      ],
    ]);
    expect(server.messages).toEqual([]);
    // A session that the client gives up in good order ends with QUIT, not with a reset.
    await server.connectionsClosed();
    expect(server.sessions.map(session => session.commands.at(-1))).toEqual(["QUIT", "QUIT", "QUIT"]);
  });

  test("fails when the server offers no method for the credentials", async () => {
    await using none = await MailServer.listen();
    await using other = await MailServer.listen({
      auth: { user: "ada", pass: "secret", methods: ["CRAM-MD5", "GSSAPI"] },
    });
    await using plain = await MailServer.listen({ auth: { user: "ada", pass: "secret", methods: ["PLAIN"] } });
    const messages: string[] = [];
    for (const [server, auth] of [
      [none, { user: "ada", pass: "secret" }],
      [other, { user: "ada", pass: "secret" }],
      [plain, { user: "ada", pass: "secret", method: "LOGIN" }],
      [none, { user: "ada", pass: "secret", method: "PLAIN" }],
    ] as const) {
      await using client = new Bun.SMTPClient(server.url, { auth });
      const error = await client.send(message).catch(error => error);
      expect(error.code).toBe("ERR_SMTP_AUTHENTICATION_FAILED");
      messages.push(error.message);
      // The message did not go out without the login either.
      expect(server.commands.filter(command => command !== "EHLO" && command !== "QUIT")).toEqual([]);
    }
    expect(messages).toEqual([
      "The server 127.0.0.1 does not offer authentication",
      "The server 127.0.0.1 offers CRAM-MD5, GSSAPI, and none of them can be used with these credentials",
      "The server 127.0.0.1 does not offer LOGIN, which auth.method asks for. It offers PLAIN",
      "The server 127.0.0.1 does not offer PLAIN, which auth.method asks for. It offers no authentication",
    ]);
  });

  test("upgrades with STARTTLS before it logs in", async () => {
    await using server = await MailServer.listen({ starttls: true, auth: { user: "ada", pass: "secret" } });
    await using client = new Bun.SMTPClient(server.url, { auth: { user: "ada", pass: "secret" }, tls: trusted });
    expect(client.secure).toBe(false);
    await client.send(message);
    expect(client.secure).toBe(true);
    expect(server.commands).toEqual([
      "EHLO",
      "STARTTLS",
      "(TLS handshake)",
      // What the server offers is asked again: the first answer came in clear text.
      "EHLO",
      "AUTH PLAIN",
      ...transaction,
    ]);
    expect(server.sessions[0]).toMatchObject({ encrypted: true, authenticated: true });
    expect(server.messages).toHaveLength(1);
  });

  test("smtps:// and port 465 start with TLS", async () => {
    await using server = await MailServer.listen({ secure: true, auth: { user: "ada", pass: "secret" } });
    await using client = new Bun.SMTPClient(server.url, { auth: { user: "ada", pass: "secret" }, tls: trusted });
    expect(client.secure).toBe(true);
    await client.send(message);
    expect(server.commands).toEqual(["EHLO", "AUTH PLAIN", ...transaction]);

    expect(new Bun.SMTPClient({ host: "mail.example.com", port: 465 }).secure).toBe(true);
    expect(new Bun.SMTPClient({ host: "mail.example.com" }).secure).toBe(false);
    expect(new Bun.SMTPClient({ host: "mail.example.com", port: 465, secure: false }).secure).toBe(false);
    expect(new Bun.SMTPClient("smtps://mail.example.com").secure).toBe(true);
  });

  test("a certificate that is not trusted ends the connection before anything is sent", async () => {
    const seen: Record<string, unknown> = {};
    for (const [name, options] of [
      ["starttls", { starttls: true }],
      ["implicit", { secure: true }],
    ] as const) {
      await using server = await MailServer.listen({ ...options, auth: { user: "ada", pass: "secret" } });
      const auth = { user: "ada", pass: "secret" };

      await using strict = new Bun.SMTPClient(server.url, { auth });
      const error = await strict.send(message).catch(error => error);

      // The name is checked as well as the chain, under either spelling of the option.
      await using misnamed = new Bun.SMTPClient(server.url, { auth, tls: { ...trusted, serverName: "other.example" } });
      const wrongName = await misnamed.send(message).catch(error => error);
      await using alias = new Bun.SMTPClient(server.url, { auth, tls: { ...trusted, servername: "other.example" } });
      const wrongAlias = await alias.send(message).catch(error => error);
      const before = server.commands.filter(c => !["EHLO", "STARTTLS", "(TLS handshake)"].includes(c));

      // `rejectUnauthorized: false` takes what it gets: a chain that is not trusted, and another name.
      await using lenient = new Bun.SMTPClient(server.url, { auth, tls: { rejectUnauthorized: false } });
      await lenient.send(message);
      await using any = new Bun.SMTPClient(server.url, {
        auth,
        tls: { rejectUnauthorized: false, serverName: "other.example" },
      });
      await any.send(message);

      seen[name] = {
        error: error.code,
        wrongName: wrongName.code,
        wrongAlias: wrongAlias.code,
        sentBefore: before,
        delivered: server.messages.length,
      };
    }
    const expected = {
      error: "DEPTH_ZERO_SELF_SIGNED_CERT",
      wrongName: "ERR_TLS_CERT_ALTNAME_INVALID",
      wrongAlias: "ERR_TLS_CERT_ALTNAME_INVALID",
      sentBefore: [],
      delivered: 2,
    };
    expect(seen).toEqual({ starttls: expected, implicit: expected });
  });

  // The certificate of the tests is for 127.0.0.1 and for localhost.
  test.skipIf(!reachable[0])("the name that the certificate is checked against is the host", async () => {
    for (const secure of [false, true]) {
      await using server = await MailServer.listen(secure ? { secure } : { starttls: true });
      await using client = new Bun.SMTPClient({ host: "127.1", port: server.port, secure, tls: trusted });
      expect(await client.send(message).catch(error => error.code)).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
      expect(server.messages).toEqual([]);
    }
  });

  test("a server that offers STARTTLS and then refuses it gets no login and no message", async () => {
    await using server = await MailServer.listen({
      starttls: true,
      auth: { user: "ada", pass: "secret" },
      reply: command => (command === "STARTTLS" ? "454 4.7.0 TLS not available due to a temporary reason" : undefined),
    });
    // Also where the credentials may go in clear text, which 127.0.0.1 is.
    await using client = new Bun.SMTPClient(server.url, { auth: { user: "ada", pass: "secret" } });
    const error = await client.send(message).catch(error => error);
    expect([error.code, error.command, error.responseCode]).toEqual(["ERR_SMTP_TLS", "STARTTLS", 454]);
    await server.connectionsClosed();
    expect(server.commands).toEqual(["EHLO", "STARTTLS", "QUIT"]);
  });

  test("what the server offers in clear text does not count after STARTTLS", async () => {
    await using server = await MailServer.listen({
      starttls: true,
      // A limit of five bytes, and a login, that only the first answer has.
      reply: (command, session) =>
        command.startsWith("EHLO") && !session.encrypted
          ? "250-mail.test\r\n250-STARTTLS\r\n250-AUTH PLAIN\r\n250 SIZE 5"
          : undefined,
    });
    await using client = new Bun.SMTPClient(server.url, { tls: trusted });
    await client.send(message);
    expect(server.messages).toHaveLength(1);
    expect(server.messages[0].parameters).toBe("");

    await using withLogin = new Bun.SMTPClient(server.url, { tls: trusted, auth: { user: "ada", pass: "secret" } });
    const error = await withLogin.send(message).catch(error => error);
    expect([error.code, error.message]).toEqual([
      "ERR_SMTP_AUTHENTICATION_FAILED",
      "The server 127.0.0.1 does not offer authentication",
    ]);
  });

  test("TLS options that the socket refuses end the connection", async () => {
    for (const options of [{ starttls: true }, { secure: true }]) {
      await using server = await MailServer.listen(options);
      await using client = new Bun.SMTPClient(server.url, { tls: { ca: 123 as never } });
      const error = await client.send(message).catch(error => error);
      expect(error).toBeInstanceOf(Error);
      expect(client.connected).toBe(false);
      // The server is not left with a connection that nothing will use.
      await server.connectionsClosed();
      expect(server.messages).toEqual([]);
    }
  });

  test("requireTLS fails where the server has no STARTTLS, and ignoreTLS does not use it", async () => {
    await using plain = await MailServer.listen();
    await using strict = new Bun.SMTPClient(plain.url, { requireTLS: true });
    const error = await strict.send(message).catch(error => error);
    expect({ code: error.code, message: error.message }).toEqual({
      code: "ERR_SMTP_TLS",
      message: `The server 127.0.0.1:${plain.port} does not offer STARTTLS, and requireTLS is set`,
    });
    await plain.connectionsClosed();
    expect(plain.commands).toEqual(["EHLO", "QUIT"]);

    await using capable = await MailServer.listen({ starttls: true });
    await using ignoring = new Bun.SMTPClient(capable.url, { ignoreTLS: true });
    await ignoring.send(message);
    expect(capable.commands).not.toContain("STARTTLS");
    expect(ignoring.secure).toBe(false);
  });

  // A server that is not this machine by its name and has no STARTTLS, or had it taken out of its
  // answer on the way. Only "localhost", 127.x.x.x and ::1 are this machine to the client.
  describe.each(otherNames.map((name, i) => [name, reachable[i]] as const))(
    "credentials do not cross a network in clear text: %s",
    (host, reaches) => {
      test.skipIf(!reaches).each([
        ["a password", { user: "ada", pass: "secret" }],
        ["an access token", { user: "ada", accessToken: "token" }],
      ])("%s", async (_, auth) => {
        await using server = await MailServer.listen({ auth: { user: "ada", pass: "secret", accessToken: "token" } });
        await using client = new Bun.SMTPClient({ host, port: server.port, auth });
        const error = await client.send(message).catch(error => error);
        expect({ code: error.code, message: error.message }).toEqual({
          code: "ERR_SMTP_TLS",
          message:
            `The connection to ${host} is not encrypted, and the credentials are not sent over it. ` +
            "Set secure for a port that starts with TLS, or ignoreTLS to send them as they are",
        });
        await server.connectionsClosed();
        expect(server.commands).toEqual(["EHLO", "QUIT"]);
      });
    },
  );

  test.skipIf(otherName === undefined)("ignoreTLS sends the credentials as they are", async () => {
    await using server = await MailServer.listen({ auth: { user: "ada", pass: "secret" } });
    const auth = { user: "ada", pass: "secret" };
    await using client = new Bun.SMTPClient({ host: otherName, port: server.port, auth, ignoreTLS: true });
    await client.send(message);
    expect(server.sessions[0].authenticated).toBe(true);
  });

  test("the names of this machine take a login in clear text", async () => {
    await using server = await MailServer.listen({ auth: { user: "ada", pass: "secret" } });
    for (const host of ["127.0.0.1", "localhost", "LOCALHOST"]) {
      await using client = new Bun.SMTPClient({ host, port: server.port, auth: { user: "ada", pass: "secret" } });
      expect(await client.verify()).toBe(true);
    }
    expect(server.sessions.map(session => session.authenticated)).toEqual([true, true, true]);
  });

  test("what the server sends in clear text after its reply to STARTTLS is not read as an answer", async () => {
    const errors: unknown[] = [];
    for (const injected of [
      // The answer to the EHLO that the client sends after the handshake, put there in advance.
      "250-injected\r\n250 AUTH PLAIN",
      // The start of one, without its last line.
      "250-injected\r\n250-SIZE 5",
      // And something that is no reply at all.
      "HELLO THERE",
    ]) {
      await using server = await MailServer.listen({
        starttls: true,
        reply: command => (command === "STARTTLS" ? "220 2.0.0 Ready\r\n" + injected : undefined),
      });
      await using client = new Bun.SMTPClient(server.url, { tls: trusted });
      const error = await client.send(message).catch(error => error);
      errors.push([error.name, error.code, error.message, client.connected]);
    }
    expect(errors).toEqual([
      ["SMTPError", "ERR_SMTP_INVALID_RESPONSE", "The server sent data after its reply to STARTTLS", false],
      ["SMTPError", "ERR_SMTP_INVALID_RESPONSE", "The server sent data after its reply to STARTTLS", false],
      ["SMTPError", "ERR_SMTP_INVALID_RESPONSE", "The server sent a line that is not an SMTP reply", false],
    ]);
  });

  test("a TLS handshake that does not finish is a timeout", async () => {
    // The server says that it is ready for TLS, and then says nothing, whatever arrives.
    const stalled: ServerOptions = {
      starttls: true,
      reply: (command, session) =>
        command === "STARTTLS" ? "220 Ready" : session.commands.includes("STARTTLS") ? "silence" : undefined,
    };
    await using first = await MailServer.listen(stalled);
    // A second each: the greeting and the two commands before the handshake need their time on a
    // debug build that has just started.
    await using second = await MailServer.listen(stalled);
    await using byConnectionTimeout = new Bun.SMTPClient(first.url, { tls: trusted, connectionTimeout: 1000 });
    await using bySocketTimeout = new Bun.SMTPClient(second.url, { tls: trusted, socketTimeout: 1000 });
    const [error, other] = await Promise.all([
      byConnectionTimeout.send(message).catch(error => error),
      bySocketTimeout.send(message).catch(error => error),
    ]);
    expect([error.name, error.code, error.message]).toEqual([
      "SMTPError",
      "ERR_SMTP_CONNECTION_TIMEOUT",
      `Connected to 127.0.0.1:${first.port}, but the session was not ready within 1000 ms`,
    ]);
    expect([other.name, other.code, other.message]).toEqual([
      "SMTPError",
      "ERR_SMTP_TIMEOUT",
      "The TLS handshake did not finish within 1000 ms",
    ]);
  });
});

// ───────────────────────────── refusals and failures ─────────────────────────────

describe("Bun.SMTPClient errors", () => {
  test("reports the recipients the server refused, and fails when it refused all", async () => {
    await using server = await MailServer.listen();
    await using client = new Bun.SMTPClient(server.url);

    const some = await client.send({ ...message, to: ["b@example.com", "nobody@example.com"], cc: "c@example.com" });
    expect(some).toMatchObject({ accepted: ["b@example.com", "c@example.com"], rejected: ["nobody@example.com"] });

    const error = await client
      .send({ ...message, to: ["nobody@example.com", "nobody@example.org"] })
      .catch(error => error);
    const { name, message: text, code, responseCode, response, command, rejected } = error;
    expect({ name, message: text, code, responseCode, response, command, rejected }).toEqual({
      name: "SMTPError",
      message: "The server refused every recipient: 550 5.1.1 No such user here",
      code: "ERR_SMTP_RECIPIENTS_REJECTED",
      responseCode: 550,
      response: "550 5.1.1 No such user here",
      command: "RCPT TO",
      rejected: ["nobody@example.com", "nobody@example.org"],
    });

    // The connection is the same one, and takes the next message.
    await client.send(message);
    expect(server.sessions).toHaveLength(1);
    expect(server.messages.map(received => received.to)).toEqual([
      ["b@example.com", "c@example.com"],
      ["b@example.com"],
    ]);
  });

  test("a refused sender, a refused message and a server that is too busy", async () => {
    const seen: Record<string, unknown> = {};
    for (const [name, options] of Object.entries({
      "sender": {
        reply: (command: string) => (command.startsWith("MAIL") ? "553 5.1.8 Sender address rejected" : undefined),
      },
      "data": { reply: (command: string) => (command === "DATA" ? "554 5.7.1 No" : undefined) },
      "content": { accept: "552-5.3.4 Message\r\n552 too large" },
      "greeting": { greeting: "554 5.3.2 No SMTP service here" },
      "busy": { reply: (command: string) => (command.startsWith("EHLO") ? "421 4.3.2 Too busy" : undefined) },
      // The server says why it does not want the client, and hangs up: what it said is the error.
      "blocked": {
        reply: (command: string) =>
          command.startsWith("EHLO") ? { reply: "554 5.7.1 Your address is on a blocklist", hangUp: true } : undefined,
      },
      // The server has enough of the message before it has all of it, says so and hangs up.
      "refused while it was sent": { refuseData: "552 5.3.4 Message too big" },
    } satisfies Record<string, ServerOptions>)) {
      await using server = await MailServer.listen(options);
      await using client = new Bun.SMTPClient(server.url);
      const error = await client.send(message).catch(error => error);
      seen[name] = [error.code, error.command, error.responseCode, error.response];
    }
    expect(seen).toEqual({
      "sender": ["ERR_SMTP_SENDER_REJECTED", "MAIL FROM", 553, "553 5.1.8 Sender address rejected"],
      "data": ["ERR_SMTP_MESSAGE_REJECTED", "DATA", 554, "554 5.7.1 No"],
      "content": ["ERR_SMTP_MESSAGE_REJECTED", "DATA", 552, "552 5.3.4 Message too large"],
      "greeting": ["ERR_SMTP_UNEXPECTED_RESPONSE", "CONNECT", 554, "554 5.3.2 No SMTP service here"],
      "busy": ["ERR_SMTP_UNEXPECTED_RESPONSE", "EHLO", 421, "421 4.3.2 Too busy"],
      "blocked": ["ERR_SMTP_UNEXPECTED_RESPONSE", "EHLO", 554, "554 5.7.1 Your address is on a blocklist"],
      "refused while it was sent": ["ERR_SMTP_MESSAGE_REJECTED", "DATA", 552, "552 5.3.4 Message too big"],
    });
  });

  test.each([
    ["in clear text", {}],
    ["after STARTTLS", { starttls: true }],
  ] as const)(
    "a refusal in the middle of a large message is the error, not the connection that closed behind it %s",
    async (_, options) => {
      // The server reads 200 kB of some megabytes, says no, and closes with the rest on its way.
      await using server = await MailServer.listen({
        ...options,
        refuseData: "552 5.3.4 Message too big",
        refuseDataAfter: 200_000,
      });
      await using client = new Bun.SMTPClient(server.url, { tls: trusted });
      const error = await client
        .send({ ...message, attachments: [{ filename: "big.bin", content: new Uint8Array(6 * 1024 * 1024) }] })
        .catch(error => error);
      expect([error.code, error.command, error.responseCode, error.response]).toEqual([
        "ERR_SMTP_MESSAGE_REJECTED",
        "DATA",
        552,
        "552 5.3.4 Message too big",
      ]);
      expect(client.connected).toBe(false);
    },
  );

  test("a connection that ends behind the refusal of a recipient has that refusal in its error", async () => {
    await using server = await MailServer.listen({
      reply: command =>
        command === "RCPT TO:<first@example.com>" ? { reply: "550 5.7.1 Relaying denied", hangUp: true } : undefined,
    });
    await using client = new Bun.SMTPClient(server.url);
    const error = await client.send({ ...message, to: ["first@example.com", "second@example.com"] }).catch(e => e);
    expect([error.code, error.command, error.responseCode, error.response]).toEqual([
      "ERR_SMTP_CONNECTION_CLOSED",
      "RCPT TO",
      550,
      "550 5.7.1 Relaying denied",
    ]);
  });

  test("a server that does not answer is a timeout, and the message says what was reached", async () => {
    await using mute = await MailServer.listen({ greeting: null });
    await using first = new Bun.SMTPClient(mute.url, { connectionTimeout: 100 });
    const noGreeting = await first.send(message).catch(error => error);
    expect({ code: noGreeting.code, message: noGreeting.message }).toEqual({
      code: "ERR_SMTP_CONNECTION_TIMEOUT",
      message:
        `Connected to 127.0.0.1:${mute.port}, but the server sent no greeting ` +
        `(a port that starts with TLS needs "secure: true") within 100 ms`,
    });

    await using stalled = await MailServer.listen({
      reply: command => (command.startsWith("MAIL") ? "silence" : undefined),
    });
    // The greeting and the answer to EHLO have this time too.
    await using second = new Bun.SMTPClient(stalled.url, { socketTimeout: 1000 });
    const noAnswer = await second.send(message).catch(error => error);
    expect({ code: noAnswer.code, message: noAnswer.message }).toEqual({
      code: "ERR_SMTP_TIMEOUT",
      message: "The server did not answer within 1000 ms",
    });
    // It was the answer to MAIL FROM that did not come.
    expect(stalled.commands).toEqual(["EHLO", "MAIL FROM:<a@example.com>"]);
    expect(second.connected).toBe(false);
  });

  test("a connection that ends, or that does not speak SMTP", async () => {
    await using closing = await MailServer.listen({
      reply: command => (command.startsWith("RCPT") ? "close" : undefined),
    });
    await using first = new Bun.SMTPClient(closing.url);
    expect(await first.send(message).catch(error => error.code)).toBe("ERR_SMTP_CONNECTION_CLOSED");
    expect(first.connected).toBe(false);

    await using http = await MailServer.listen({ greeting: "HTTP/1.1 400 Bad Request" });
    await using second = new Bun.SMTPClient(http.url);
    const error = await second.send(message).catch(error => error);
    expect({ code: error.code, message: error.message }).toEqual({
      code: "ERR_SMTP_INVALID_RESPONSE",
      message: "The server sent a line that is not an SMTP reply",
    });

    await using endless = await MailServer.listen({
      greeting:
        Array(70)
          .fill("220-" + Buffer.alloc(1000, "a"))
          .join("\r\n") + "\r\n220 end",
    });
    await using third = new Bun.SMTPClient(endless.url);
    expect(await third.send(message).catch(error => error.code)).toBe("ERR_SMTP_INVALID_RESPONSE");

    // Replies that no command asked for do not pile up.
    await using flooding = await MailServer.listen({
      reply: command => (command.startsWith("EHLO") ? Array(20).fill("250 more").join("\r\n") : undefined),
    });
    await using flooded = new Bun.SMTPClient(flooding.url);
    const flood = await flooded.send(message).catch(error => error);
    expect({ code: flood.code, message: flood.message }).toEqual({
      code: "ERR_SMTP_INVALID_RESPONSE",
      message: "The server sent replies that no command asked for",
    });
    expect(flooding.messages).toEqual([]);

    // Nothing listens here.
    const unused = await MailServer.listen();
    const { port } = unused;
    await unused[Symbol.asyncDispose]();
    await using fourth = new Bun.SMTPClient({ host: "127.0.0.1", port });
    expect(await fourth.send(message).catch(error => error.code)).toBe("ECONNREFUSED");
  });

  test("an address that needs SMTPUTF8 is only sent to a server that has it", async () => {
    const raw = "Subject: x\r\n\r\nx\r\n";
    await using without = await MailServer.listen();
    await using first = new Bun.SMTPClient(without.url);
    const error = await first.send({ envelope: { from: "a@example.com", to: "用户@example.com" }, raw }).catch(e => e);
    expect(error.code).toBe("ERR_SMTP_UNSUPPORTED");
    expect(without.commands).toEqual(["EHLO"]);

    await using capable = await MailServer.listen({ extensions: ["SMTPUTF8"] });
    await using second = new Bun.SMTPClient(capable.url);
    await second.send({ envelope: { from: "a@example.com", to: "用户@例え.example" }, raw });
    // In the envelope of a message that the client writes too: bcc is nowhere else.
    await second.send({ ...message, bcc: "秘密@example.com" });
    expect(
      capable.commands.filter(c => /^(MAIL|RCPT)/.test(c)).map(command => Buffer.from(command, "latin1").toString()),
    ).toEqual([
      "MAIL FROM:<a@example.com> SMTPUTF8",
      "RCPT TO:<用户@xn--r8jz45g.example>",
      "MAIL FROM:<a@example.com> SMTPUTF8",
      "RCPT TO:<b@example.com>",
      "RCPT TO:<秘密@example.com>",
    ]);

    // Written into a header, such an address needs every server on the way to have the extension.
    const inHeader = await second.send({ ...message, to: "用户@example.com" }).catch(e => e);
    expect(inHeader.code).toBe("ERR_INVALID_ARG_VALUE");
    expect(inHeader.message).toStartWith(
      "The property 'message.to' has a local part that is not ASCII, which only the envelope of a message can have.",
    );
  });

  // Not where the helper has no port to offer.
  test.skipIf(isWindows || isMusl)("a connection attempt that hangs is called off, and the process ends", async () => {
    await using proc = Bun.spawn({
      cmd: [
        bunExe(),
        "-e",
        `${blackholePortSource}
         const client = new Bun.SMTPClient({ host: "127.0.0.1", port, connectionTimeout: 100 });
         const sends = [1, 2, 3].map(() => client.send({ from: "a@example.com", to: "b@example.com", text: "x" }));
         const results = await Promise.allSettled(sends);
         console.log(results.map(result => result.reason.message.replace(String(port), "PORT")).join("\\n"));
         filler.destroy();`,
      ],
      env: bunEnv,
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect({ stdout, stderr, exitCode, signalCode: proc.signalCode }).toEqual({
      stdout: Array(3).fill("No connection to 127.0.0.1:PORT within 100 ms").join("\n") + "\n",
      stderr: "",
      exitCode: 0,
      signalCode: null,
    });
  });

  test("the process ends after a connection attempt that timed out", async () => {
    await using mute = await MailServer.listen({ greeting: null });
    await using proc = Bun.spawn({
      cmd: [
        bunExe(),
        "-e",
        `const client = new Bun.SMTPClient(process.argv[1], { connectionTimeout: 100 });
         const sends = [1, 2, 3].map(() => client.send({ from: "a@example.com", to: "b@example.com", text: "x" }));
         console.log((await Promise.allSettled(sends)).map(result => result.reason.code).join(" "));`,
        mute.url,
      ],
      env: bunEnv,
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect({ stdout, stderr, exitCode }).toEqual({
      stdout: Array(3).fill("ERR_SMTP_CONNECTION_TIMEOUT").join(" ") + "\n",
      stderr: "",
      exitCode: 0,
    });
  });
});

// ───────────────────────────── options ─────────────────────────────

describe("new Bun.SMTPClient()", () => {
  test("takes a URL, options, or both", () => {
    const describeClient = (...args: ConstructorParameters<typeof Bun.SMTPClient>) =>
      Bun.inspect(new Bun.SMTPClient(...args)).replace(/\s+/g, " ");
    expect({
      "url": describeClient("smtp://mail.example.com"),
      "url with a port": describeClient("smtp://mail.example.com:2525"),
      "url with a slash": describeClient("smtp://mail.example.com:2525/"),
      "smtps": describeClient("smtps://user:pass@mail.example.com"),
      "URL object": describeClient(new URL("smtps://mail.example.com:2465")),
      "options": describeClient({ host: "mail.example.com", port: 25 }),
      "hostname": describeClient({ hostname: "mail.example.com", secure: true }),
      "no host": describeClient({}),
      "url in options": describeClient({ url: "smtp://mail.example.com:2525", secure: true }),
      "url and options": describeClient("smtp://mail.example.com", { port: 26 }),
      "ipv6": describeClient("smtp://[::1]:2525"),
      "ipv6 in brackets": describeClient({ host: "[::1]", port: 25 }),
    }).toEqual({
      "url": "SMTPClient { host: 'mail.example.com', port: 587, secure: false, connected: false }",
      "url with a port": "SMTPClient { host: 'mail.example.com', port: 2525, secure: false, connected: false }",
      "url with a slash": "SMTPClient { host: 'mail.example.com', port: 2525, secure: false, connected: false }",
      "smtps": "SMTPClient { host: 'mail.example.com', port: 465, secure: true, connected: false }",
      "URL object": "SMTPClient { host: 'mail.example.com', port: 2465, secure: true, connected: false }",
      "options": "SMTPClient { host: 'mail.example.com', port: 25, secure: false, connected: false }",
      "hostname": "SMTPClient { host: 'mail.example.com', port: 465, secure: true, connected: false }",
      "no host": "SMTPClient { host: 'localhost', port: 587, secure: false, connected: false }",
      "url in options": "SMTPClient { host: 'mail.example.com', port: 2525, secure: true, connected: false }",
      "url and options": "SMTPClient { host: 'mail.example.com', port: 26, secure: false, connected: false }",
      "ipv6": "SMTPClient { host: '::1', port: 2525, secure: false, connected: false }",
      "ipv6 in brackets": "SMTPClient { host: '::1', port: 25, secure: false, connected: false }",
    });
  });

  test("an error about a URL or about the credentials does not show a password", () => {
    const messages: string[] = [];
    for (const args of [
      ["http://ada:hunter2@mail.example.com"],
      ["smtp://ada:hunter2@mail.example.com:port"],
      ["smtp://ada:hunter2%zz@mail.example.com"],
      // Characters that a pattern for the user and the password of a URL could stop at.
      ["ftp://ada:hunter2/with?odd#chars@mail.example.com"],
      ["smtp:ada:hunter2@mail.example.com"],
      ["smtp://ada:hunter2@mail.example.com/?requireTLS=true"],
      [{ url: 5, auth: { user: "ada", pass: "hunter2" } }],
      [{ auth: { user: "ada", pass: "hunter2", accessToken: "hunter2-token" } }],
      [{ auth: { user: "ada", pass: 7481905 } }],
      [{ auth: { user: "ada", accessToken: ["hunter2"] } }],
      [{ auth: "ada:hunter2" }],
      [{ auth: { user: "ada", password: "hunter2" } }],
      [{ auth: { user: "ada", pass: "hunter2\r\nMAIL FROM:<a@b.c>" } }],
      [{ auth: { user: "ada\0hunter2", pass: "x" } }],
      [{ user: "ada", password: "hunter2" }],
      // A URL where a host name belongs, and other values that are in the wrong place.
      [{ host: "smtp://ada:hunter2@mail.example.com" }],
      [{ hostname: "ada:hunter2@mail.example.com" }],
      [{ host: ["hunter2"] }],
      ["smtp://mail.example.com", "smtp://ada:hunter2@other.example.com"],
      [{ name: "ada:hunter2@client.example.com" }],
      [{ port: "hunter2" }],
      [{ secure: "hunter2" }],
      [{ connectionTimeout: "hunter2" }],
      [{ auth: { user: "ada", pass: "x", method: "hunter2" } }],
      [{ tls: "hunter2" }],
    ] as unknown[][]) {
      try {
        new (Bun.SMTPClient as any)(...args);
        messages.push("no error");
      } catch (error: any) {
        messages.push(`${error.name} ${error.code}: ${error.message}`);
      }
    }
    expect(messages.filter(text => /hunter2|7481905/.test(text))).toEqual([]);
    expect(messages).toEqual([
      `TypeError ERR_INVALID_ARG_VALUE: The argument 'url' must start with "smtp://" or "smtps://"`,
      `TypeError ERR_INVALID_ARG_VALUE: The argument 'url' is not a URL. Write it as "smtp://user:password@host:port", with a user or a password in percent-encoding`,
      "TypeError ERR_INVALID_ARG_VALUE: The argument 'url' has a user or a password that is not percent-encoded",
      `TypeError ERR_INVALID_ARG_VALUE: The argument 'url' is not a URL. Write it as "smtp://user:password@host:port", with a user or a password in percent-encoding`,
      `TypeError ERR_INVALID_ARG_VALUE: The argument 'url' has no host. Write it as "smtp://host:port"`,
      `TypeError ERR_INVALID_ARG_VALUE: The argument 'url' has a path, a query or a fragment, which are not read. Pass options as the second argument, and write a "/", a "?" or a "#" of a password in percent-encoding`,
      'TypeError ERR_INVALID_ARG_TYPE: The "url" argument must be of type string or URL. Received type number',
      `TypeError ERR_INVALID_ARG_VALUE: The property 'options.auth' must have "pass" or "accessToken", not both`,
      'TypeError ERR_INVALID_ARG_TYPE: The "options.auth.pass" property must be of type string. Received type number',
      'TypeError ERR_INVALID_ARG_TYPE: The "options.auth.accessToken" property must be of type string. Received an object',
      'TypeError ERR_INVALID_ARG_TYPE: The "options.auth" property must be of type object. Received type string',
      "TypeError ERR_INVALID_ARG_VALUE: The property 'options.auth.password' is not an option. The options are: user, pass, accessToken, method",
      "TypeError ERR_INVALID_ARG_VALUE: The property 'options.auth.pass' must not contain a control character",
      "TypeError ERR_INVALID_ARG_VALUE: The property 'options.auth.user' must not contain a control character",
      "TypeError ERR_INVALID_ARG_VALUE: The property 'options.user' is not an option. The options are: url, host, hostname, port, secure, requireTLS, ignoreTLS, tls, auth, name, connectionTimeout, socketTimeout, idleTimeout",
      "TypeError ERR_INVALID_ARG_VALUE: The property 'options.host' is not a host name. It is a name or an address alone, without a scheme or a user",
      "TypeError ERR_INVALID_ARG_VALUE: The property 'options.hostname' is not a host name. It is a name or an address alone, without a scheme or a user",
      'TypeError ERR_INVALID_ARG_TYPE: The "options.host" property must be of type string. Received an object',
      'TypeError ERR_INVALID_ARG_TYPE: The "options" argument must be of type object. Received type string',
      "TypeError ERR_INVALID_ARG_VALUE: The property 'options.name' is not a host name or an address literal",
      'TypeError ERR_INVALID_ARG_TYPE: The "options.port" property must be of type number. Received type string',
      'TypeError ERR_INVALID_ARG_TYPE: The "options.secure" property must be of type boolean. Received type string',
      'TypeError ERR_INVALID_ARG_TYPE: The "options.connectionTimeout" property must be of type number. Received type string',
      `TypeError ERR_INVALID_ARG_VALUE: The property 'options.auth.method' must be "PLAIN", "LOGIN" or "XOAUTH2"`,
      'TypeError ERR_INVALID_ARG_TYPE: The "options.tls" property must be of type object. Received type string',
    ]);
  });

  test("refuses options that cannot work, and names that are not options", () => {
    const codeOf = (...args: unknown[]) => {
      try {
        new (Bun.SMTPClient as any)(...args);
        return "no error";
      } catch (error: any) {
        return `${error.name} ${error.code}`;
      }
    };
    expect({
      "nothing": codeOf(),
      "no URL in front of the options": codeOf(undefined, { requireTLS: true }),
      "a number": codeOf(25),
      "two objects": codeOf({ host: "a.example" }, { port: 25 }),
      "not a url": codeOf("mail.example.com:25"),
      "a url in the options next to a URL": codeOf("smtp://a.example", { url: "smtp://b.example" }),
      "port 0": codeOf({ port: 0 }),
      "port 70000": codeOf({ port: 70000 }),
      "port as text": codeOf({ port: "25" }),
      "host with a space": codeOf({ host: "mail.example.com\r\nEHLO" }),
      "hostname that is a number": codeOf({ hostname: 5 }),
      "secure": codeOf({ secure: "yes" }),
      "both TLS flags": codeOf({ requireTLS: true, ignoreTLS: true }),
      "auth without a user": codeOf({ auth: { pass: "secret" } }),
      "auth without a password": codeOf({ auth: { user: "ada" } }),
      "auth method": codeOf({ auth: { user: "ada", pass: "secret", method: "CRAM-MD5" } }),
      "xoauth2 without a token": codeOf({ auth: { user: "ada", pass: "secret", method: "XOAUTH2" } }),
      "name": codeOf({ name: "my host\r\nMAIL FROM:<a@b.c>" }),
      "timeout": codeOf({ socketTimeout: 0 }),
      "timeout as text": codeOf({ connectionTimeout: "1s" }),
      "idle timeout": codeOf({ idleTimeout: -1 }),
      "tls": codeOf({ tls: true }),
      // A check that is misspelt is a check that is not made.
      "a misspelt option": codeOf({ requireTls: true }),
      "an option of Nodemailer": codeOf({ host: "a.example", pool: true }),
      "a service of Nodemailer": codeOf({ service: "gmail", auth: { user: "ada", pass: "secret" } }),
      // An empty host would be this machine, with the credentials that the URL has for another.
      "an empty host next to a URL": codeOf("smtp://ada:secret@a.example", { host: "" }),
      // What is on a prototype would be read as absent: a check that is not made, a login that is left out.
      "an instance of a class": codeOf(
        new (class Settings {
          host = "a.example";
          get requireTLS() {
            return true;
          }
        })(),
      ),
      "an object that inherits its options": codeOf(Object.create({ host: "a.example", requireTLS: true })),
      "a URL object where the options go": codeOf("smtp://a.example", new URL("smtp://b.example")),
      "auth that is an instance": codeOf({
        auth: new (class Login {
          user = "ada";
          pass = "secret";
        })(),
      }),
      "tls that inherits": codeOf({ tls: Object.create({ rejectUnauthorized: true }) }),
      // The socket calls no function to check the certificate, so one that is given would never run.
      "tls.checkServerIdentity": codeOf({ tls: { checkServerIdentity: () => undefined } }),
      "a misspelt option of TLS": codeOf({ tls: { rejectUnauthorised: true } }),
    }).toEqual({
      "nothing": "TypeError ERR_MISSING_ARGS",
      "no URL in front of the options": "TypeError ERR_MISSING_ARGS",
      "a number": "TypeError ERR_INVALID_ARG_TYPE",
      "two objects": "TypeError ERR_INVALID_ARG_TYPE",
      "not a url": "TypeError ERR_INVALID_ARG_VALUE",
      "a url in the options next to a URL": "TypeError ERR_INVALID_ARG_VALUE",
      "port 0": "RangeError ERR_OUT_OF_RANGE",
      "port 70000": "RangeError ERR_OUT_OF_RANGE",
      "port as text": "TypeError ERR_INVALID_ARG_TYPE",
      "host with a space": "TypeError ERR_INVALID_ARG_VALUE",
      "hostname that is a number": "TypeError ERR_INVALID_ARG_TYPE",
      "secure": "TypeError ERR_INVALID_ARG_TYPE",
      "both TLS flags": "TypeError ERR_INVALID_ARG_VALUE",
      "auth without a user": "TypeError ERR_INVALID_ARG_TYPE",
      "auth without a password": "TypeError ERR_INVALID_ARG_TYPE",
      "auth method": "TypeError ERR_INVALID_ARG_VALUE",
      "xoauth2 without a token": "TypeError ERR_INVALID_ARG_VALUE",
      "name": "TypeError ERR_INVALID_ARG_VALUE",
      "timeout": "RangeError ERR_OUT_OF_RANGE",
      "timeout as text": "TypeError ERR_INVALID_ARG_TYPE",
      "idle timeout": "RangeError ERR_OUT_OF_RANGE",
      "tls": "TypeError ERR_INVALID_ARG_TYPE",
      "a misspelt option": "TypeError ERR_INVALID_ARG_VALUE",
      "an option of Nodemailer": "TypeError ERR_INVALID_ARG_VALUE",
      "a service of Nodemailer": "TypeError ERR_INVALID_ARG_VALUE",
      "an empty host next to a URL": "TypeError ERR_INVALID_ARG_VALUE",
      "an instance of a class": "TypeError ERR_INVALID_ARG_VALUE",
      "an object that inherits its options": "TypeError ERR_INVALID_ARG_VALUE",
      "a URL object where the options go": "TypeError ERR_INVALID_ARG_VALUE",
      "auth that is an instance": "TypeError ERR_INVALID_ARG_VALUE",
      "tls that inherits": "TypeError ERR_INVALID_ARG_VALUE",
      "tls.checkServerIdentity": "TypeError ERR_INVALID_ARG_VALUE",
      "a misspelt option of TLS": "TypeError ERR_INVALID_ARG_VALUE",
    });
    expect(() => new Bun.SMTPClient(Object.create({ host: "a.example" }))).toThrow(
      "The argument 'options' must be a plain object. What an instance of a class has, or an object that inherits from another, is not read",
    );
    // An object of another realm is as plain as one of this one.
    expect(
      () => new Bun.SMTPClient(runInNewContext("({ host: 'a.example', tls: {}, auth: { user: 'a', pass: 'b' } })")),
    ).not.toThrow();
    // The message names the property that is wrong.
    expect(() => new Bun.SMTPClient({ hostname: 5 as never })).toThrow('"options.hostname"');
  });

  test("what Object.prototype has is not an option of a client that is made from a URL alone", async () => {
    await using server = await MailServer.listen({ starttls: true, auth: { user: "ada", pass: "secret" } });
    await using proc = Bun.spawn({
      cmd: [
        bunExe(),
        "-e",
        `Object.assign(Object.prototype, { ignoreTLS: true, name: "evil.example", auth: { user: "eve", pass: "x" }, port: 1 });
         const client = new Bun.SMTPClient(process.argv[1]);
         console.log(await client.verify().catch(error => error.code));`,
        `smtp://ada:secret@127.0.0.1:${server.port}`,
      ],
      env: bunEnv,
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    // The client went for STARTTLS, and did not trust the certificate.
    expect({ stdout, stderr, exitCode }).toEqual({ stdout: "DEPTH_ZERO_SELF_SIGNED_CERT\n", stderr: "", exitCode: 0 });
    expect(server.commands).toEqual(["EHLO", "STARTTLS", "(TLS handshake)"]);
    expect(server.sessions[0].hello).not.toBe("evil.example");
  });

  test("what Object.prototype has is not an option", async () => {
    await using server = await MailServer.listen({ starttls: true, auth: { user: "ada", pass: "secret" } });
    // In a process of its own: the prototype of every object is not for a test to change.
    await using proc = Bun.spawn({
      cmd: [
        bunExe(),
        "-e",
        `Object.assign(Object.prototype, {
           ignoreTLS: true,
           host: "127.0.0.2",
           port: 1,
           url: "smtp://127.0.0.2:1",
           auth: { user: "eve", pass: "x" },
           tls: { rejectUnauthorized: false },
           rejectUnauthorized: false,
           method: "LOGIN",
           name: "evil.example",
         });
         const client = new Bun.SMTPClient(process.argv[1], { auth: { user: "ada", pass: "secret" }, tls: { ca: process.env.SMTP_TEST_CA } });
         const result = await client.send({ from: "a@example.com", to: "b@example.com", text: "x" });
         console.log(result.response, client.secure);
         await client.close();
         // Without the certificate authority the certificate is still refused.
         const strict = new Bun.SMTPClient(process.argv[1], { auth: { user: "ada", pass: "secret" } });
         console.log(await strict.verify().catch(error => error.code));`,
        server.url,
      ],
      env: { ...bunEnv, SMTP_TEST_CA: certificate.cert },
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect({ stdout, stderr, exitCode }).toEqual({
      stdout: "250 2.0.0 Ok: queued as 1 true\nDEPTH_ZERO_SELF_SIGNED_CERT\n",
      stderr: "",
      exitCode: 0,
    });
    expect(server.sessions[0].commands).toEqual([
      "EHLO",
      "STARTTLS",
      "(TLS handshake)",
      "EHLO",
      "AUTH PLAIN",
      ...transaction,
      "QUIT",
    ]);
    expect(server.sessions[0].hello).not.toBe("evil.example");
  });
});
