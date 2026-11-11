// A mail server for the tests of Bun.SMTPClient, and a reader for the messages it gets.
import { expect } from "bun:test";
import { tls as certificate } from "harness";
import net from "node:net";
import tls from "node:tls";

export interface Received {
  from: string;
  /** What followed the address in MAIL FROM, such as "SIZE=123". */
  parameters: string;
  to: string[];
  /** The message as the client sent it: dots unstuffed, without the line that ends the data. */
  data: string;
}

export interface Session {
  /** Every command of the session. EHLO and HELO are there without the name, AUTH without its argument. */
  commands: string[];
  /** What the client called itself. */
  hello: string;
  encrypted: boolean;
  authenticated: boolean;
}

type Scripted = string | { reply: string; hangUp: true } | undefined;

export interface ServerOptions {
  /** TLS from the first byte. */
  secure?: boolean;
  /** Offer STARTTLS. */
  starttls?: boolean;
  auth?: { user: string; pass?: string; accessToken?: string; methods?: string[] };
  /** Lines for the reply to EHLO after the ones the options above give. */
  extensions?: string[];
  greeting?: string | null;
  /**
   * Called with every command before the server handles it. A string is the reply, and the server
   * does nothing else with the command. "close" ends the connection, "silence" sends nothing, and
   * `{ reply, hangUp }` sends the reply and ends the connection.
   */
  reply?: (command: string, session: Session, server: MailServer) => Scripted;
  /** The reply to the end of the data. */
  accept?: string;
  /** Sent as soon as the data starts, and the connection is ended without reading it. */
  refuseData?: string;
  /**
   * With `refuseData`: the server first reads this many bytes of the data, then says it and closes
   * the connection at once, with the rest of the data on its way.
   */
  refuseDataAfter?: number;
  /** After QUIT the server says 221 and then nothing: it does not close, and it does not read. */
  stubborn?: boolean;
}

export class MailServer {
  messages: Received[] = [];
  sessions: Session[] = [];
  port = 0;
  #server: net.Server;
  #sockets = new Set<net.Socket>();
  #options: ServerOptions;

  constructor(options: ServerOptions = {}) {
    this.#options = options;
    this.#server = options.secure
      ? tls.createServer({ key: certificate.key, cert: certificate.cert }, socket => this.#session(socket, true))
      : net.createServer(socket => this.#session(socket, false));
    this.#server.on("connection", socket => {
      this.#sockets.add(socket);
      socket.on("close", () => this.#sockets.delete(socket));
    });
  }

  static async listen(options: ServerOptions = {}, hostname = "127.0.0.1") {
    const server = new MailServer(options);
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    server.#server.once("error", reject);
    server.#server.listen(0, hostname, resolve);
    await promise;
    server.port = (server.#server.address() as net.AddressInfo).port;
    return server;
  }

  get url() {
    return `${this.#options.secure ? "smtps" : "smtp"}://127.0.0.1:${this.port}`;
  }

  /** Every command of every session, in order. */
  get commands() {
    return this.sessions.flatMap(session => session.commands);
  }

  /** Ends every open connection, as a server does with one that was idle for too long. */
  dropConnections() {
    for (const socket of this.#sockets) socket.destroy();
  }

  /** Resolves when every connection that is open now has closed. */
  async connectionsClosed() {
    await Promise.all(
      [...this.#sockets].map(socket => {
        const { promise, resolve } = Promise.withResolvers<void>();
        if (socket.destroyed) resolve();
        else socket.once("close", () => resolve());
        return promise;
      }),
    );
  }

  async [Symbol.asyncDispose]() {
    this.dropConnections();
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#server.close(() => resolve());
    await promise;
  }

  #session(socket: net.Socket, encrypted: boolean, session?: Session) {
    const options = this.#options;
    if (session === undefined) {
      session = { commands: [], hello: "", encrypted, authenticated: false };
      this.sessions.push(session);
      if (options.greeting !== null) socket.write(`${options.greeting ?? "220 mail.test ESMTP"}\r\n`);
    }
    session.encrypted = encrypted;
    const state = session;
    let buffer = "";
    let current: Received | undefined;
    let receiving = false;
    // The AUTH exchange in progress: what the next line is.
    let expecting: "user" | "pass" | "plain" | "xoauth2" | "xoauth2-ack" | undefined;
    let loginUser = "";
    let refusedAfter = 0;

    const send = (line: string) => void socket.write(line + "\r\n");
    const login = (user: string, secret: string, kind: "pass" | "accessToken") => {
      const { auth } = options;
      if (auth && auth.user === user && auth[kind] === secret) {
        state.authenticated = true;
        send("235 2.7.0 Authentication successful");
      } else {
        send("535 5.7.8 Authentication credentials invalid");
      }
    };

    const plain = (response: string) => {
      const [, user, pass] = Buffer.from(response, "base64").toString().split("\0");
      return login(user, pass, "pass");
    };
    const xoauth2 = (response: string) => {
      const fields = Buffer.from(response, "base64").toString().split("\x01");
      const user = fields[0]?.replace(/^user=/, "");
      const token = fields[1]?.replace(/^auth=Bearer /, "");
      if (options.auth?.user === user && options.auth?.accessToken === token) {
        state.authenticated = true;
        return send("235 2.7.0 Accepted");
      }
      expecting = "xoauth2-ack";
      return send("334 " + Buffer.from('{"status":"401"}').toString("base64"));
    };

    const onLine = (line: string) => {
      // The response to AUTH on a line of its own, for a client that did not put it behind the command.
      if (expecting === "plain" || expecting === "xoauth2") {
        const respond = expecting === "plain" ? plain : xoauth2;
        expecting = undefined;
        state.commands.push("(response)");
        return respond(line);
      }
      if (expecting === "user") {
        loginUser = Buffer.from(line, "base64").toString();
        expecting = "pass";
        return send("334 UGFzc3dvcmQ6");
      }
      if (expecting === "pass") {
        expecting = undefined;
        return login(loginUser, Buffer.from(line, "base64").toString(), "pass");
      }
      if (expecting === "xoauth2-ack") {
        expecting = undefined;
        return send("535 5.7.8 Username and Password not accepted");
      }

      const words = line.split(" ");
      const verb = words[0].toUpperCase();
      if (verb === "EHLO" || verb === "HELO") state.hello = words.slice(1).join(" ");
      state.commands.push(
        verb === "AUTH" ? words.slice(0, 2).join(" ") : verb === "EHLO" || verb === "HELO" ? verb : line,
      );

      const scripted = options.reply?.(line, state, this);
      if (scripted === "close") return void socket.destroy();
      if (scripted === "silence") return;
      if (typeof scripted === "object") return void socket.end(scripted.reply + "\r\n");
      if (scripted !== undefined) return send(scripted);

      switch (verb) {
        case "EHLO": {
          const lines = ["mail.test greets you"];
          if (options.starttls && !state.encrypted) lines.push("STARTTLS");
          if (options.auth) lines.push(`AUTH ${(options.auth.methods ?? ["PLAIN", "LOGIN", "XOAUTH2"]).join(" ")}`);
          lines.push(...(options.extensions ?? []));
          return send(lines.map((text, i) => `250${i === lines.length - 1 ? " " : "-"}${text}`).join("\r\n"));
        }
        case "HELO":
          return send("250 mail.test");
        case "STARTTLS": {
          socket.removeAllListeners("data");
          socket.write("220 2.0.0 Ready to start TLS\r\n", () => {
            const secure = new tls.TLSSocket(socket, {
              isServer: true,
              key: certificate.key,
              cert: certificate.cert,
            });
            secure.on("error", () => {});
            state.commands.push("(TLS handshake)");
            this.#session(secure, true, state);
          });
          return;
        }
        case "AUTH": {
          const [, method, argument] = words;
          // A command line has 512 octets at most (RFC 5321, section 4.5.3.1.4).
          if (line.length > 510) return send("500 5.5.6 Line too long");
          if (method === "PLAIN" || method === "XOAUTH2") {
            if (argument === undefined) {
              expecting = method === "PLAIN" ? "plain" : "xoauth2";
              return send("334 ");
            }
            return method === "PLAIN" ? plain(argument) : xoauth2(argument);
          }
          if (method === "LOGIN") {
            expecting = "user";
            return send("334 VXNlcm5hbWU6");
          }
          return send("504 5.5.4 Unrecognized authentication type");
        }
        case "MAIL": {
          if (options.auth && !state.authenticated) return send("530 5.7.0 Authentication required");
          const match = /^MAIL FROM:<([^>]*)>\s*(.*)$/i.exec(line);
          if (!match) return send("501 5.5.4 Syntax error");
          current = { from: match[1], parameters: match[2], to: [], data: "" };
          return send("250 2.1.0 Sender ok");
        }
        case "RCPT": {
          const match = /^RCPT TO:<([^>]*)>$/i.exec(line);
          if (!match || !current) return send("503 5.5.1 Bad sequence of commands");
          if (match[1].startsWith("nobody@")) return send("550 5.1.1 No such user here");
          current.to.push(match[1]);
          return send("250 2.1.5 Recipient ok");
        }
        case "DATA":
          if (!current || current.to.length === 0) return send("503 5.5.1 Bad sequence of commands");
          if (options.refuseData !== undefined && options.refuseDataAfter === undefined) {
            send("354 End data with <CR><LF>.<CR><LF>");
            return void socket.end(options.refuseData + "\r\n");
          }
          receiving = true;
          return send("354 End data with <CR><LF>.<CR><LF>");
        case "RSET":
          current = undefined;
          return send("250 2.0.0 Reset");
        case "NOOP":
          return send("250 2.0.0 OK");
        case "QUIT":
          send("221 2.0.0 Bye");
          if (options.stubborn) return void socket.pause();
          return void socket.end();
        default:
          return send("500 5.5.2 Command not recognized");
      }
    };

    socket.on("error", () => {});
    // Where the search for the end of the data goes on: a large message is not searched again
    // with every chunk.
    let searched = 0;
    socket.on("data", chunk => {
      if (receiving && options.refuseDataAfter !== undefined) {
        // Enough of it: the refusal, and the end of the connection with data still on its way.
        if ((refusedAfter += chunk.length) >= options.refuseDataAfter) {
          socket.write(options.refuseData + "\r\n");
          socket.destroy();
        }
        return;
      }
      buffer += chunk.toString("latin1");
      for (;;) {
        if (receiving) {
          // The data ends with a line that has one dot. It may be the first line.
          const end = buffer.startsWith(".\r\n") ? -2 : buffer.indexOf("\r\n.\r\n", searched);
          if (end === -1) {
            searched = Math.max(0, buffer.length - 4);
            return;
          }
          const data = end === -2 ? "" : buffer.slice(0, end + 2);
          buffer = buffer.slice(end + 5);
          searched = 0;
          receiving = false;
          const unstuffed = data.includes("\n.") || data.startsWith(".") ? data.replace(/^\./gm, "") : data;
          current!.data = Buffer.from(unstuffed, "latin1").toString("utf8");
          this.messages.push(current!);
          current = undefined;
          send(options.accept ?? `250 2.0.0 Ok: queued as ${this.messages.length}`);
          continue;
        }
        const end = buffer.indexOf("\r\n");
        if (end === -1) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        onLine(line);
        // STARTTLS hands the socket to a new reader.
        if (socket.listenerCount("data") === 0) return;
      }
    });
  }
}

// ───────────────────────────── reading a message back ─────────────────────────────

export interface Part {
  /** Header names in lower case. Folded lines are joined, and white space at the ends of a value is dropped. */
  headers: Record<string, string>;
  /** The media type without its parameters. */
  type: string;
  parameters: Record<string, string>;
  /** The body as it is written, for a part that has no parts. */
  body: string;
  parts: Part[];
}

/** The parameters of a header such as Content-Type, from its pieces between the semicolons. */
export function parametersOf(pieces: string[]): Record<string, string> {
  const parameters: Record<string, string> = {};
  for (const parameter of pieces) {
    const equals = parameter.indexOf("=");
    if (equals === -1) continue;
    parameters[parameter.slice(0, equals).trim().toLowerCase()] = parameter
      .slice(equals + 1)
      .trim()
      .replace(/^"(.*)"$/, "$1");
  }
  return parameters;
}

export function parseMessage(raw: string): Part {
  const split = raw.indexOf("\r\n\r\n");
  const head = split === -1 ? raw : raw.slice(0, split);
  const body = split === -1 ? "" : raw.slice(split + 4);
  const headers: Record<string, string> = {};
  // Unfolded as RFC 5322, section 2.2.3, says: the line break goes, and the white space behind it stays.
  for (const line of head.replace(/\r\n(?=[ \t])/g, "").split("\r\n")) {
    const colon = line.indexOf(":");
    headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
  }
  const [type, ...rest] = (headers["content-type"] ?? "text/plain").split(";");
  const parameters = parametersOf(rest);
  const parts: Part[] = [];
  if (type.startsWith("multipart/")) {
    const delimiter = "--" + parameters.boundary;
    const pieces = ("\r\n" + body).split("\r\n" + delimiter);
    // The first piece is the preamble, and the last starts with "--".
    for (const piece of pieces.slice(1, -1)) parts.push(parseMessage(piece.replace(/^\r\n/, "")));
    expect(pieces.at(-1)!.startsWith("--")).toBe(true);
  }
  return { headers, type: type.trim(), parameters, body, parts };
}

/** The content of a part, through its transfer encoding. */
export function decodeBody(part: Part): Buffer {
  const encoding = part.headers["content-transfer-encoding"];
  if (encoding === "base64") return Buffer.from(part.body, "base64");
  if (encoding === "quoted-printable") {
    const bytes = part.body
      .replace(/=\r\n/g, "")
      .replace(/=([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    return Buffer.from(bytes, "latin1");
  }
  return Buffer.from(part.body, "latin1");
}

/** Encoded words (RFC 2047) back to text. Each word is decoded alone, as a mail program does. */
export function decodeWords(value: string): string {
  return value
    .replace(/(\?=)\s+(=\?)/g, "$1$2")
    .replace(/=\?UTF-8\?B\?([^?]*)\?=/g, (_, data) =>
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(data, "base64")),
    );
}

/** The media types of a message as a tree. */
export function outline(part: Part): unknown {
  return part.parts.length > 0 ? { [part.type]: part.parts.map(outline) } : part.type;
}

/** What makes the client trust the certificate of the server. */
export const trusted = { ca: certificate.cert };
