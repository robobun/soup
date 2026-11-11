// Bun.SMTPClient: sends mail to a mail server over SMTP (RFC 5321).
//
// The file has two halves that do not know each other:
//
//   - the message: addresses (RFC 5322), headers with encoded words for what is not
//     ASCII (RFC 2047), and the MIME tree of bodies and attachments (RFC 2045, 2046,
//     2183, 2231). Everything it writes is ASCII with CRLF line ends, so a server
//     needs no extension to take it.
//   - the connection: one socket, the greeting, EHLO, STARTTLS, AUTH, and one
//     MAIL/RCPT/DATA transaction per message. Commands are sent one at a time and
//     every reply is read before the next command.
//
// What a program passes in can come from a form on a web page, so the rules here are
// strict where an SMTP command or a header line is written: a CR, an LF or a NUL in an
// address, a name, a subject, a header or a file name is an error, never something to
// strip or to escape. Options and fields are the own properties of a plain object, each
// read once, and a name that is not known is an error: `requireTls` must not be a check
// that is silently not made, nothing on Object.prototype can switch one off, and what an
// instance of a class keeps on its prototype is not read as if it were not there. No
// method of an object of the caller is called for what ends up on the wire: not of an
// array, not of a Date, not of a Blob.

const AsyncContextFrame = require("internal/async_context_frame");
const isFrameOfStoppedModuleGraph = $newCppFunction("ModuleGraph.cpp", "jsFunctionIsFrameOfStoppedModuleGraph", 1);
// Bun.connect() in two steps, as node:net uses it: the socket is there before it is connected,
// so a connection attempt can be called off. The socket is always one for clear text, and TLS is
// put on it with upgradeTLS(), which checks the name of the certificate. A socket that is made
// for TLS here leaves that check to node:tls.
const newDetachedSocket = $bindgen("node_net_binding.bind.ts", "newDetachedSocket");
const doConnect = $bindgen("node_net_binding.bind.ts", "doConnect");

const ArrayBufferIsView = ArrayBuffer.isView;
const ArrayIsArray = Array.isArray;
const BlobPrototypeBytes = Blob.prototype.bytes;
// The file is loaded when Bun.SMTPClient is first read, and the program may have put something else
// in the place of Date by then: a mock, or a class that has nothing of it.
const DatePrototypeGetTime: unknown = Date?.prototype?.getTime;
const MathCeil = Math.ceil;
const MathFloor = Math.floor;
const MathMax = Math.max;
const MathMin = Math.min;
const NumberIsInteger = Number.isInteger;
const NumberIsNaN = Number.isNaN;
const ObjectGetPrototypeOf = Object.getPrototypeOf;
const ObjectKeys = Object.keys;
const SymbolAsyncDispose = Symbol.asyncDispose;
const SymbolDispose = Symbol.dispose;
const kInspect = Symbol.for("nodejs.util.inspect.custom");

type Inspect = (value: unknown, options: object) => string;
type Fields = Record<string, unknown>;

interface Address {
  name: string;
  address: string;
}

interface Reply {
  code: number;
  /** The text of the reply without the codes, one line of the reply per line. */
  text: string;
}

interface ResolvedOptions {
  host: string;
  port: number;
  /** TLS from the first byte (port 465), as opposed to STARTTLS on a plain connection. */
  secure: boolean;
  requireTLS: boolean;
  ignoreTLS: boolean;
  /** The caller's TLS options with the name that the certificate is checked against. */
  tls: Fields;
  /** `tls.rejectUnauthorized` is false: a certificate that is not trusted is taken. */
  lenient: boolean;
  /** What the client calls itself in EHLO. */
  name: string;
  user: string | undefined;
  pass: string | undefined;
  accessToken: string | undefined;
  method: string | undefined;
  connectionTimeout: number;
  socketTimeout: number;
  idleTimeout: number;
}

interface Envelope {
  /** Empty for the null sender, `MAIL FROM:<>`. */
  from: string;
  to: string[];
}

interface Attachment {
  filename: string | undefined;
  contentType: string;
  disposition: "attachment" | "inline";
  cid: string | undefined;
  content: Uint8Array | Blob;
}

/** A message whose fields have been checked. Only the contents of its Blobs are still to be read. */
interface Draft {
  envelope: Envelope;
  messageId: string | undefined;
  /** Needs the SMTPUTF8 extension: an address of the envelope has a local part that is not ASCII. */
  utf8: boolean;
  raw: Uint8Array | Blob | undefined;
  headers: string[];
  text: string | undefined;
  html: string | undefined;
  attachments: Attachment[];
}

const DEFAULT_CONNECTION_TIMEOUT = 30_000;
const DEFAULT_SOCKET_TIMEOUT = 5 * 60_000;
const DEFAULT_IDLE_TIMEOUT = 30_000;
/** How long the answer to RSET on a connection that was idle, and the answer to QUIT, may take. */
const PROBE_TIMEOUT = 5000;
/** A reply longer than this is not a reply. RFC 5321 gives a reply line 512 bytes. */
const MAX_REPLY_LENGTH = 64 * 1024;
/** How many replies may wait for a command to ask for them. One is usual: a greeting, or a goodbye. */
const MAX_WAITING_REPLIES = 8;
/** The longest string of addresses that is read. Some thousand recipients fit. */
const MAX_ADDRESS_LIST_LENGTH = 256 * 1024;
/** A server counts the messages of a connection and ends it at a limit of its own. This one is lower than most. */
const MAX_MESSAGES_PER_CONNECTION = 100;
/** The longest line a message may have (RFC 5322, section 2.1.1), without its CRLF. */
const MAX_LINE_LENGTH = 998;
/** The length a line of a header or of an encoded body is kept to. */
const LINE_LENGTH = 76;
/** The longest message ID, content ID, media type or header name: what has to fit on a line in one piece. */
const MAX_TOKEN_LENGTH = 255;

const OPTION_NAMES = [
  "url",
  "host",
  "hostname",
  "port",
  "secure",
  "requireTLS",
  "ignoreTLS",
  "tls",
  "auth",
  "name",
  "connectionTimeout",
  "socketTimeout",
  "idleTimeout",
];
const AUTH_NAMES = ["user", "pass", "accessToken", "method"];
const RAW_MESSAGE_NAMES = ["raw", "from", "to", "cc", "bcc", "envelope"];
const MESSAGE_NAMES = [
  "from",
  "to",
  "cc",
  "bcc",
  "replyTo",
  "subject",
  "text",
  "html",
  "attachments",
  "headers",
  "date",
  "messageId",
  "inReplyTo",
  "references",
  "envelope",
  "raw",
];
const ENVELOPE_NAMES = ["from", "to", "cc", "bcc"];
const ADDRESS_NAMES = ["name", "address"];
const ATTACHMENT_NAMES = ["filename", "content", "path", "encoding", "contentType", "cid", "contentDisposition"];
// What the socket reads of the options of TLS: the dictionary of src/runtime/socket/SSLConfig.bind.ts, and the
// `secureContext` of upgradeTLS(). A name that is not here would be a check that is silently not made, as
// `checkServerIdentity` is one: the socket checks the name of the certificate itself and calls nothing.
const TLS_NAMES = [
  "serverName",
  "servername",
  "rejectUnauthorized",
  "ca",
  "cert",
  "key",
  "passphrase",
  "caFile",
  "certFile",
  "keyFile",
  "dhParamsFile",
  "ciphers",
  "minVersion",
  "maxVersion",
  "secureOptions",
  "ALPNProtocols",
  "crl",
  "allowPartialTrustChain",
  "sigalgs",
  "ecdhCurve",
  "sessionTimeout",
  "clientRenegotiationLimit",
  "clientRenegotiationWindow",
  "requestCert",
  "lowMemoryMode",
  "secureContext",
];

// The patterns are constants: src/codegen/builtin-parser.ts knows a regular expression only behind
// `=`, `(` and the like, reads `\\]` in one as an escaped bracket, and leaves the `$` intrinsics of
// the lines after a pattern that it misread as they are.
const LINE_BREAK = /[\r\n\0]/;
const NOT_ASCII = /[^\x00-\x7f]/;
const NOT_PRINTABLE = /[^\x20-\x7e]/;
/** A tab is the only control character that a header line may hold as it is. */
const NOT_HEADER_TEXT = /[^\x20-\x7e\t]/;
/** A whole encoded word (RFC 2047, section 2): whoever reads a header would decode it. */
const ENCODED_WORD = /=\?[^?\s]+\?[bBqQ]\?[^?\s]*\?=/;
/** Atoms (RFC 5322, section 3.2.3) with one space between them: a name that needs no quotes. */
const ATOMS = /^[A-Za-z0-9!#$%&'*+\-\/=?^_`{|}~]+(?: [A-Za-z0-9!#$%&'*+\-\/=?^_`{|}~]+)*$/;
/** Atoms with single dots between them. */
const LOCAL_PART = /^[A-Za-z0-9!#$%&'*+\-\/=?^_`{|}~]+(?:\.[A-Za-z0-9!#$%&'*+\-\/=?^_`{|}~]+)*$/;
/** The same, with every character that is not ASCII, for an address of the envelope. */
const LOCAL_PART_UTF8 =
  /^[A-Za-z0-9!#$%&'*+\-\/=?^_`{|}~\u0080-\u{10ffff}]+(?:\.[A-Za-z0-9!#$%&'*+\-\/=?^_`{|}~\u0080-\u{10ffff}]+)*$/u;
const DOMAIN_LITERAL = /^\[(?:IPv6:[0-9A-Fa-f:.]+|[0-9.]+)\]$/;
const HOST_NAME = /^[A-Za-z0-9_](?:[A-Za-z0-9_-]*[A-Za-z0-9_])?(?:\.[A-Za-z0-9_](?:[A-Za-z0-9_-]*[A-Za-z0-9_])?)*$/;
const HOST_FORBIDDEN = /[\s\0\/@]/;
const LOOPBACK_V4 = /^127(?:\.[0-9]{1,3}){3}$/;
const MEDIA_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:[ \t]*;[\x20-\x7e\t]*)?$/;
/** The type that says nothing about the content. */
const GENERIC_TYPE = /^application\/octet-stream(?:[ \t]*;|$)/i;
const CONTAINER_TYPE = /^(?:message|multipart)\//i;
const MESSAGE_TYPE = /^message\//i;
/** A header name is printable ASCII without a colon (RFC 5322, section 2.2). */
const HEADER_NAME = /^[\x21-\x39\x3b-\x7e]+$/;
/** What a message ID or a content ID cannot have: an angle bracket, a space, or anything that is not printable ASCII. */
const ID_FORBIDDEN = /[^\x21-\x7e]|[<>]/;
const WHITE_SPACE = /\s+/;
const FILE_EXTENSION = /^[A-Za-z0-9]{1,16}$/;
const CREDENTIAL_FORBIDDEN = /[\0\x01\r\n]/;
const ANY_LINE_END = /\r\n|\r|\n/g;
const QUOTED_SPECIAL = /[\\"]/g;
const EXTENDED_SPECIAL = /['()*]/g;
/** Three digits, then "-" when another line of the reply follows. */
const REPLY_LINE = /^[2-5][0-9][0-9](?:[ -]|$)/;
const KEYWORD_END = /[ =]/;
/** The error codes of a TLS handshake that failed, as opposed to a certificate that was refused. */
const TLS_FAILURE = /^(?:ECONNRESET|EPROTO|ERR_(?:SSL|OSSL)_)/;
/** The bytes that quoted-printable writes as codes, in a string with one character per byte. */
const QP_UNSAFE = /[^\x21-\x3c\x3e-\x7e \t\r\n]+/g;
const QP_SPACE_AT_LINE_END = /[ \t](?=\r\n)|[ \t]$/g;
const HEX_PAIR = /../g;

// ───────────────────────────── arguments ─────────────────────────────

/**
 * A TypeError about `name` that does not show its value: a password, a URL that may hold one, a
 * whole message, or a name that nobody knows what is behind.
 */
function invalid(name: string, reason: string): TypeError {
  const error = new TypeError(`The ${name.includes(".") ? "property" : "argument"} '${name}' ${reason}`);
  (error as TypeError & { code: string }).code = "ERR_INVALID_ARG_VALUE";
  return error;
}

/** The same for a value of the wrong type. It says the type and not the value. */
function invalidType(name: string, expected: string, value: unknown): TypeError {
  const received = value === null ? "null" : typeof value === "object" ? "an object" : `type ${typeof value}`;
  const error = new TypeError(
    `The "${name}" ${name.includes(".") ? "property" : "argument"} must be of type ${expected}. Received ${received}`,
  );
  (error as TypeError & { code: string }).code = "ERR_INVALID_ARG_TYPE";
  return error;
}

/** The start of `text`, for an error message. */
function preview(text: string): string {
  return text.length > 64 ? text.slice(0, 64) + "..." : text;
}

function validateString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string") throw invalidType(name, "string", value);
}

function validateBoolean(value: unknown, name: string): asserts value is boolean {
  if (typeof value !== "boolean") throw invalidType(name, "boolean", value);
}

function validateTimeout(value: unknown, name: string, min: number): number {
  if (typeof value !== "number") throw invalidType(name, "number", value);
  if (!(value >= min) || value > 2 ** 31 - 1) throw $ERR_OUT_OF_RANGE(name, `>= ${min} and < 2 ** 31`, value);
  return value;
}

/**
 * The caller's own properties, each read once, on an object without a prototype. What pollutes
 * Object.prototype (`ignoreTLS = true`) cannot switch a check off, and a getter or a Proxy is asked
 * once. A name that is not in `names` is an error: an option that is misspelt is an option that is
 * not applied, and a field that is not written is mail that differs from what was meant. For the
 * same reason the object has to be a plain one. An instance of a class, or an object that inherits
 * from another, would be read as if it had nothing of what its prototype has.
 */
function ownFields(value: unknown, name: string, names: readonly string[] | undefined, what: string): Fields {
  if (value === null || typeof value !== "object" || ArrayIsArray(value)) {
    throw invalidType(name, "object", value);
  }
  const prototype = ObjectGetPrototypeOf(value);
  // The Object.prototype of every realm has no prototype itself.
  if (prototype !== null && ObjectGetPrototypeOf(prototype) !== null) {
    throw invalid(
      name,
      "must be a plain object. What an instance of a class has, or an object that inherits from another, is not read",
    );
  }
  const own = { __proto__: null, ...(value as object) } as Fields;
  if (names !== undefined) {
    for (const key of ObjectKeys(own)) {
      if (!names.includes(key)) {
        throw invalid(
          `${name}.${key}`,
          `is not ${what}. ${what === "an option" ? "The options" : "The fields"} are: ${names.join(", ")}`,
        );
      }
    }
  }
  return own;
}

/** A line of a command or of a header cannot hold a CR, an LF or a NUL, and nothing may smuggle a second line in. */
function validateHeaderText(value: unknown, name: string): string {
  validateString(value, name);
  if (LINE_BREAK.test(value)) {
    throw $ERR_INVALID_ARG_VALUE(name, preview(value), "must not contain a line break or a NUL character");
  }
  return value;
}

function isASCII(text: string): boolean {
  return !NOT_ASCII.test(text);
}

// ───────────────────────────── addresses ─────────────────────────────

let domainToASCII: ((domain: string) => string) | undefined;

/**
 * Checks `address` and returns it with the domain in ASCII. It goes into `MAIL FROM:<...>` and
 * `RCPT TO:<...>` as it is returned, so the characters that could end the path or the command are
 * not accepted: no space, no control character, no angle bracket, no quoted local part. A local
 * part that is not ASCII is for the envelope alone (`utf8`), and for a server with SMTPUTF8.
 */
function normalizeAddress(address: unknown, name: string, utf8: boolean): string {
  validateString(address, name);
  // The longest address there is, in UTF-16 code units, with room to spare. The patterns below
  // are not run on megabytes.
  if (address.length > 512) {
    throw $ERR_INVALID_ARG_VALUE(name, preview(address), "is too long for an email address");
  }
  const at = address.lastIndexOf("@");
  const local = address.slice(0, at);
  let domain = address.slice(at + 1);
  if (at < 1 || !(utf8 ? LOCAL_PART_UTF8 : LOCAL_PART).test(local) || !address.isWellFormed()) {
    throw $ERR_INVALID_ARG_VALUE(
      name,
      address,
      !utf8 && at >= 1 && LOCAL_PART_UTF8.test(local)
        ? "has a local part that is not ASCII, which only the envelope of a message can have"
        : "is not an email address",
    );
  }
  // The characters of an encoded word are those of an atom, and mail programs decode the one as
  // readily as the other.
  if (ENCODED_WORD.test(local)) {
    throw $ERR_INVALID_ARG_VALUE(name, address, "has a local part that mail programs read as an encoded word");
  }
  if (!DOMAIN_LITERAL.test(domain)) {
    if (!isASCII(domain)) {
      domain = (domainToASCII ??= require("node:url").domainToASCII)(domain);
    }
    if (!HOST_NAME.test(domain)) {
      throw $ERR_INVALID_ARG_VALUE(name, address, "is not an email address");
    }
  }
  // RFC 5321, section 4.5.3.1: 64 octets for the local part, 255 for the domain.
  if (Buffer.byteLength(local) > 64 || domain.length > 255) {
    throw $ERR_INVALID_ARG_VALUE(name, address, "is too long for an email address");
  }
  return local + "@" + domain;
}

/**
 * Reads a list as it is written in a header: `a@example.com, "Doe, Jane" <jane@example.com>`.
 * A quoted string keeps its commas, a comment in parentheses is dropped, and an empty entry (a
 * comma at the end) is skipped.
 */
function parseAddressList(text: string, name: string, utf8: boolean, out: Address[]) {
  if (text.length > MAX_ADDRESS_LIST_LENGTH) {
    throw $ERR_INVALID_ARG_VALUE(name, preview(text), "is too long for a list of addresses");
  }
  if (LINE_BREAK.test(text)) {
    throw $ERR_INVALID_ARG_VALUE(name, preview(text), "must not contain a line break or a NUL character");
  }
  let display = "";
  let address: string | undefined;
  let quoted = false;
  const flush = () => {
    const rest = display.trim();
    if (address !== undefined) {
      out.push({ name: rest, address: normalizeAddress(address.trim(), name, utf8) });
    } else if (rest !== "") {
      // Without angle brackets the whole entry is the address. `"a b"@example.com` is not supported.
      if (quoted) throw $ERR_INVALID_ARG_VALUE(name, preview(text), "has a name without an address in angle brackets");
      out.push({ name: "", address: normalizeAddress(rest, name, utf8) });
    }
    display = "";
    address = undefined;
    quoted = false;
  };
  const length = text.length;
  for (let i = 0; i < length; i++) {
    const c = text[i];
    if (address !== undefined && c !== "," && c !== ";" && c !== "(" && c !== " " && c !== "\t") {
      throw $ERR_INVALID_ARG_VALUE(
        name,
        preview(text),
        c === "<" ? "has unbalanced angle brackets" : "has text after an address in angle brackets",
      );
    } else if (c === '"') {
      quoted = true;
      for (i++; i < length && text[i] !== '"'; i++) {
        if (text[i] === "\\" && i + 1 < length) i++;
        display += text[i];
      }
      if (i >= length) throw $ERR_INVALID_ARG_VALUE(name, preview(text), "has a quoted string that does not end");
    } else if (c === "<") {
      const end = text.indexOf(">", i);
      if (end === -1) throw $ERR_INVALID_ARG_VALUE(name, preview(text), "has unbalanced angle brackets");
      address = text.slice(i + 1, end);
      i = end;
    } else if (c === "(") {
      let depth = 1;
      for (i++; i < length && depth > 0; i++) {
        if (text[i] === "\\") i++;
        else if (text[i] === "(") depth++;
        else if (text[i] === ")") depth--;
      }
      if (depth > 0) throw $ERR_INVALID_ARG_VALUE(name, preview(text), "has a comment that does not end");
      i--;
    } else if (c === "," || c === ";") {
      flush();
    } else {
      display += c;
    }
  }
  flush();
}

function parseAddresses(value: unknown, name: string, utf8: boolean, out: Address[] = []): Address[] {
  if (value === undefined || value === null) return out;
  if (typeof value === "string") {
    parseAddressList(value, name, utf8, out);
  } else if (ArrayIsArray(value)) {
    for (let i = 0; i < value.length; i++) parseAddresses(value[i], `${name}[${i}]`, utf8, out);
  } else if (typeof value === "object") {
    const { name: display, address } = ownFields(value, name, ADDRESS_NAMES, "a field of an address");
    out.push({
      name: display === undefined || display === null ? "" : validateHeaderText(display, `${name}.name`).trim(),
      address: normalizeAddress(address, `${name}.address`, utf8),
    });
  } else {
    throw invalidType(name, "string, object or Array", value);
  }
  return out;
}

// ───────────────────────────── headers ─────────────────────────────

/**
 * `text` as encoded words (RFC 2047) in base64, one per line. A word is at most 75 characters and
 * a line that has one at most 76, and a word holds whole characters. `used` is how much of the
 * first line is taken.
 */
function encodeWords(text: string, used: number): string {
  const bytes = Buffer.from(text, "utf8");
  const length = bytes.length;
  // "=?UTF-8?B?" and "?=" are 12 characters, and 3 bytes take 4.
  const continuation = MathFloor((LINE_LENGTH - 1 - 12) / 4) * 3;
  let room = MathFloor((LINE_LENGTH - used - 12) / 4) * 3;
  let out = "";
  let start = 0;
  if (room < 6) {
    // Not worth a word: the value starts on a line of its own.
    out = "\r\n ";
    room = continuation;
  }
  while (start < length) {
    let end = MathMin(start + room, length);
    // A byte of the form 10xxxxxx continues a character.
    while (end < length && (bytes[end] & 0xc0) === 0x80) end--;
    if (start > 0) out += "\r\n ";
    out += "=?UTF-8?B?" + bytes.toString("base64", start, end) + "?=";
    start = end;
    room = continuation;
  }
  return out;
}

/** The length of the last line of `text`. */
function lastLineLength(text: string): number {
  return text.length - (text.lastIndexOf("\n") + 1);
}

/**
 * Folds a header line so that its lines have at most 78 characters where there is a place for it
 * (RFC 5322, section 2.2.3). A fold goes in front of a run of white space, and the whole run starts
 * the next line, so unfolding gives the line back as it was. No fold goes in front of white space
 * that ends the line, which would leave a line of white space alone, and none in front of the
 * value, which starts at `skip`.
 */
function fold(line: string, skip: number): string {
  let end = line.length;
  while (end > skip && (line[end - 1] === " " || line[end - 1] === "\t")) end--;
  let out = "";
  let start = 0;
  // The last place in the current line where a fold can go.
  let point = 0;
  for (let i = skip + 1; i <= end; i++) {
    if (i < end) {
      const c = line[i];
      const before = line[i - 1];
      if ((c !== " " && c !== "\t") || before === " " || before === "\t") continue;
    }
    // `i` is a place for a fold, or the end of the text.
    if (i - start > LINE_LENGTH + 2 && point > start) {
      out += line.slice(start, point) + "\r\n";
      start = point;
    }
    point = i;
  }
  return out + line.slice(start);
}

/**
 * A header whose value is text: Subject, and every header that the caller names. ASCII is written
 * as it is and folded at its own white space, because the header may be one that a program reads
 * (List-Unsubscribe), and a program does not decode encoded words.
 */
function textHeader(name: string, value: string): string {
  // What is not ASCII goes into encoded words. So does text that has one, which whoever reads the
  // header would decode (RFC 2047, section 7).
  if (NOT_HEADER_TEXT.test(value) || ENCODED_WORD.test(value)) {
    return name + ": " + encodeWords(value, name.length + 2);
  }
  const line = name + ": " + value;
  if (line.length <= LINE_LENGTH + 2) return line;
  const folded = fold(line, name.length + 2);
  // A word that is longer than a line may be has no place to fold. Encoded words can be cut anywhere.
  for (const part of folded.split("\r\n")) {
    if (part.length > MAX_LINE_LENGTH) return name + ": " + encodeWords(value, name.length + 2);
  }
  return folded;
}

/**
 * `value` as a quoted string, for a display name or a parameter of Content-Type. The backslash
 * comes first in the class of QUOTED_SPECIAL: see the note above the patterns.
 */
function quote(value: string): string {
  return '"' + value.replace(QUOTED_SPECIAL, "\\$&") + '"';
}

function formatAddress(entry: Address, used: number): string {
  const { name, address } = entry;
  if (name === "") return address;
  let phrase = "";
  if (!NOT_PRINTABLE.test(name) && !ENCODED_WORD.test(name)) {
    // Two spaces in a row are one to whoever reads a name without quotes.
    phrase = ATOMS.test(name) ? name : quote(name);
  }
  // A name that is not ASCII goes into encoded words, and so does one that does not fit on a line
  // with its quotes: encoded words can be cut anywhere.
  if (phrase === "" || phrase.length > LINE_LENGTH - 16) phrase = encodeWords(name, used);
  // The address, its brackets, the space in front and the comma that may follow.
  const width = (phrase.includes("\n") ? 0 : used) + lastLineLength(phrase) + address.length + 4;
  return phrase + (width <= LINE_LENGTH ? " <" : "\r\n <") + address + ">";
}

/** A header that lists addresses. Every address after the first starts a line. */
function addressHeader(name: string, list: Address[]): string {
  let out = name + ": ";
  for (let i = 0; i < list.length; i++) {
    if (i > 0) out += ",\r\n ";
    out += formatAddress(list[i], i === 0 ? name.length + 2 : 1);
  }
  return out;
}

/**
 * `;name*=utf-8''value` for a value that is not ASCII (RFC 2231, with the characters of RFC 5987),
 * in numbered pieces when it does not fit on one line. A piece holds whole characters, because
 * some programs decode each piece alone.
 */
function extendedParameter(name: string, value: string): string {
  const units: string[] = [];
  for (const character of value) {
    units.push(
      encodeURIComponent(character).replace(
        EXTENDED_SPECIAL,
        special => "%" + special.charCodeAt(0).toString(16).toUpperCase(),
      ),
    );
  }
  const whole = ` ${name}*=utf-8''${units.join("")}`;
  if (whole.length <= LINE_LENGTH + 2) return ";\r\n" + whole;
  let out = "";
  let index = 0;
  let line = ` ${name}*0*=utf-8''`;
  let empty = true;
  for (const unit of units) {
    // One character of the line is the ";" that the next piece puts after this one.
    if (!empty && line.length + unit.length > LINE_LENGTH + 1) {
      out += ";\r\n" + line;
      line = ` ${name}*${++index}*=`;
    }
    line += unit;
    empty = false;
  }
  return out + ";\r\n" + line;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** 1900-01-01 and 10000-01-01 in milliseconds: the years that a date of RFC 5322 can have. */
const MIN_TIME = -2_208_988_800_000;
const MAX_TIME = 253_402_300_800_000;

/**
 * The date of `time` in UTC as RFC 5322 writes it: "Tue, 10 Nov 2026 12:34:56 +0000". It is worked
 * out from the number. No method of a Date is called: the caller's object can have its own, and
 * the Date of the program can be anything.
 */
function formatDate(time: unknown): string {
  if (typeof time !== "number" || !(time >= MIN_TIME && time < MAX_TIME)) {
    throw invalid("message.date", "is not a date that a message can have: the year is from 1900 to 9999");
  }
  const seconds = MathFloor(time / 1000);
  const days = MathFloor(seconds / 86400);
  const second = seconds - days * 86400;
  // The day of the calendar from the days since 1970-01-01, in years that start in March, so
  // that the day a leap year adds is the last one.
  const shifted = days + 719468;
  const era = MathFloor(shifted / 146097);
  const dayOfEra = shifted - era * 146097;
  const yearOfEra = MathFloor(
    (dayOfEra - MathFloor(dayOfEra / 1460) + MathFloor(dayOfEra / 36524) - MathFloor(dayOfEra / 146096)) / 365,
  );
  const dayOfYear = dayOfEra - (365 * yearOfEra + MathFloor(yearOfEra / 4) - MathFloor(yearOfEra / 100));
  const marchMonth = MathFloor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - MathFloor((153 * marchMonth + 2) / 5) + 1;
  const month = marchMonth < 10 ? marchMonth + 2 : marchMonth - 10;
  const year = yearOfEra + era * 400 + (month < 2 ? 1 : 0);
  const two = (value: number) => (value < 10 ? "0" : "") + value;
  // 1970-01-01 was a Thursday.
  return (
    `${WEEKDAYS[(((days + 4) % 7) + 7) % 7]}, ${two(day)} ${MONTHS[month]} ${year} ` +
    `${two(MathFloor(second / 3600))}:${two(MathFloor(second / 60) % 60)}:${two(second % 60)} +0000`
  );
}

// The headers this file writes itself. Those with a value here have an option of their own, and
// none can be set through `headers`, which would put a second one beside the first.
const RESERVED_HEADERS = {
  // A lookup of a header name must not find what Object.prototype has.
  __proto__: null,
  "bcc": "bcc",
  "cc": "cc",
  "content-disposition": "",
  "content-id": "",
  "content-transfer-encoding": "",
  "content-type": "",
  "date": "date",
  "from": "from",
  "in-reply-to": "inReplyTo",
  "message-id": "messageId",
  "mime-version": "",
  "references": "references",
  "reply-to": "replyTo",
  "subject": "subject",
  "to": "to",
} as unknown as Record<string, string | undefined>;

/** A message ID or a content ID, without its angle brackets. */
function validateId(value: unknown, name: string, what: string): string {
  validateString(value, name);
  const id = value.startsWith("<") && value.endsWith(">") ? value.slice(1, -1) : value;
  if (id === "" || id.length > MAX_TOKEN_LENGTH || ID_FORBIDDEN.test(id) || ENCODED_WORD.test(id)) {
    throw $ERR_INVALID_ARG_VALUE(name, preview(value), `is not ${what}`);
  }
  return id;
}

/** A header that is one ID in angle brackets. An ID that does not fit behind the name starts the next line. */
function idHeader(name: string, id: string): string {
  return name + (name.length + id.length + 4 > LINE_LENGTH + 2 ? ":\r\n <" : ": <") + id + ">";
}

// ───────────────────────────── bodies ─────────────────────────────

function hexCodes(bytes: string): string {
  return Buffer.from(bytes, "latin1").toString("hex").toUpperCase().replace(HEX_PAIR, "=$&");
}

/** Whether the code that starts at `at` in a quoted-printable line is a byte that continues a character. */
function continuesCharacter(line: string, at: number): boolean {
  if (line[at] !== "=") return false;
  const digit = line.charCodeAt(at + 1);
  // "8", "9", "A" and "B": the bytes 0x80 to 0xBF.
  return digit === 0x38 || digit === 0x39 || digit === 0x41 || digit === 0x42;
}

/**
 * Quoted-printable (RFC 2045, section 6.7) of text whose line ends are CRLF. A line is at most 76
 * characters, a soft break never comes between the bytes of one character, and a space or a tab
 * at the end of a line is written as a code, because a mail server may strip it.
 */
function encodeQuotedPrintable(text: string): string {
  // One character per byte of the UTF-8, so that the patterns see bytes.
  const binary = isASCII(text) ? text : Buffer.from(text, "utf8").toString("latin1");
  const lines = binary.replace(QP_UNSAFE, hexCodes).replace(QP_SPACE_AT_LINE_END, hexCodes).split("\r\n");
  for (let l = 0; l < lines.length; l++) {
    const line = lines[l];
    const length = line.length;
    if (length <= LINE_LENGTH) continue;
    let out = "";
    let start = 0;
    while (length - start > LINE_LENGTH) {
      // The "=" of a soft break is the 76th character at most.
      let end = start + LINE_LENGTH - 1;
      // Not inside a code.
      if (line[end - 1] === "=") end -= 1;
      else if (line[end - 2] === "=") end -= 2;
      // Not inside a character: back to the byte that starts it.
      while (end - 3 > start && continuesCharacter(line, end)) end -= 3;
      out += line.slice(start, end) + "=\r\n";
      start = end;
    }
    lines[l] = out + line.slice(start);
  }
  return lines.join("\r\n");
}

/** A text body with its headers: as it is when it is short ASCII lines, otherwise quoted-printable. */
function textPart(subtype: string, text: string): string {
  // A lone CR or LF is a line end too.
  const normalized = text.replace(ANY_LINE_END, "\r\n");
  let plain = isASCII(normalized) && !normalized.includes("\0");
  if (plain) {
    for (const line of normalized.split("\r\n")) {
      if (line.length > LINE_LENGTH) {
        plain = false;
        break;
      }
    }
  }
  return (
    `Content-Type: text/${subtype}; charset=utf-8\r\n` +
    `Content-Transfer-Encoding: ${plain ? "7bit" : "quoted-printable"}\r\n\r\n` +
    (plain ? normalized : encodeQuotedPrintable(normalized))
  );
}

function encodeBase64Lines(bytes: Uint8Array): string {
  const encoded = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  const length = encoded.length;
  if (length <= LINE_LENGTH) return encoded;
  const lines = new Array<string>(MathCeil(length / LINE_LENGTH));
  for (let i = 0, n = 0; i < length; i += LINE_LENGTH) lines[n++] = encoded.slice(i, i + LINE_LENGTH);
  return lines.join("\r\n");
}

/**
 * An attached message (message/rfc822) as it is. RFC 2046, section 5.2.1, allows no base64 for
 * it, so it has to be what a message is without an extension: ASCII in lines of at most 998.
 */
function messageBody(attachment: Attachment, content: Uint8Array): string {
  const text = Buffer.from(content.buffer, content.byteOffset, content.byteLength)
    .toString("latin1")
    .replace(ANY_LINE_END, "\r\n");
  let fits = isASCII(text) && !text.includes("\0");
  if (fits) {
    for (const line of text.split("\r\n")) {
      if (line.length > MAX_LINE_LENGTH) {
        fits = false;
        break;
      }
    }
  }
  if (!fits) {
    throw invalid(
      "message.attachments",
      `has ${attachment.filename === undefined ? "a message" : quote(attachment.filename)} of the type ${attachment.contentType}, ` +
        "which must be ASCII in lines of at most 998 characters. Send it as application/octet-stream",
    );
  }
  return text;
}

function attachmentPart(attachment: Attachment, content: Uint8Array): string {
  const { filename, contentType, disposition, cid } = attachment;
  // A type that does not fit behind the name of the header starts the next line.
  let type = "Content-Type:" + (contentType.length + 15 > LINE_LENGTH + 2 ? "\r\n " : " ") + contentType;
  let placement = `Content-Disposition: ${disposition}`;
  if (filename !== undefined) {
    const quoted = quote(filename);
    if (!NOT_PRINTABLE.test(filename) && !ENCODED_WORD.test(filename) && quoted.length + 10 <= LINE_LENGTH + 2) {
      type += `;\r\n name=${quoted}`;
      placement += `;\r\n filename=${quoted}`;
    } else {
      // A name that is not ASCII, or that is longer than a line. Mail programs read one form or the
      // other: encoded words in `name` (not in the standard, and what most of them write), and
      // RFC 2231 in `filename*`.
      type += `;\r\n name="${encodeWords(filename, 7)}"`;
      placement += extendedParameter("filename", filename);
    }
  }
  const attached = MESSAGE_TYPE.test(contentType);
  return (
    type +
    `\r\nContent-Transfer-Encoding: ${attached ? "7bit" : "base64"}\r\n` +
    placement +
    (cid !== undefined ? `\r\nContent-ID: <${cid}>` : "") +
    "\r\n\r\n" +
    (attached ? messageBody(attachment, content) : encodeBase64Lines(content))
  );
}

/** Counts the boundaries of the process, so that two are different also where the random source is a mock. */
let boundaries = 0;

function multipart(subtype: string, parts: string[], parameters = ""): string {
  // 122 random bits: the text of a part cannot hold it by accident, and whoever writes a part
  // cannot guess it.
  const boundary = `bun-${crypto.randomUUID().replaceAll("-", "")}-${++boundaries}`;
  let out = `Content-Type: multipart/${subtype};${parameters}\r\n boundary="${boundary}"\r\n`;
  for (const part of parts) out += `\r\n--${boundary}\r\n${part}`;
  return out + `\r\n--${boundary}--`;
}

/**
 * The MIME tree, as mail programs expect it:
 *
 *   mixed
 *   ├─ alternative
 *   │  ├─ text/plain
 *   │  └─ related
 *   │     ├─ text/html
 *   │     └─ the attachments that have a `cid`, which the HTML shows
 *   └─ the other attachments
 *
 * A level that would have one child is left out.
 */
function buildBody(draft: Draft, contents: Uint8Array[]): string {
  const { text, html, attachments } = draft;
  const inline: string[] = [];
  const attached: string[] = [];
  for (let i = 0; i < attachments.length; i++) {
    const attachment = attachments[i];
    const part = attachmentPart(attachment, contents[i]);
    if (attachment.cid !== undefined && html !== undefined) inline.push(part);
    else attached.push(part);
  }
  let body: string;
  if (html !== undefined) {
    body = textPart("html", html);
    // RFC 2387, section 3.1: the type of the part that the others belong to.
    if (inline.length > 0) body = multipart("related", [body, ...inline], ' type="text/html";');
    if (text !== undefined) body = multipart("alternative", [textPart("plain", text), body]);
  } else {
    body = textPart("plain", text ?? "");
  }
  if (attached.length > 0) body = multipart("mixed", [body, ...attached]);
  return body;
}

// ───────────────────────────── messages ─────────────────────────────

/**
 * The bytes of a string, of a view or of a buffer, copied: what is sent is what send() was called
 * with, whatever the caller does with its memory afterwards. A Blob cannot change, and is read
 * when its message is about to be sent.
 */
function toBytes(value: unknown, name: string, encoding?: unknown): Uint8Array | Blob {
  if (typeof value === "string") {
    if (encoding !== undefined) {
      const encodingName = `${name.slice(0, name.lastIndexOf("."))}.encoding`;
      validateString(encoding, encodingName);
      if (!Buffer.isEncoding(encoding)) throw $ERR_INVALID_ARG_VALUE(encodingName, encoding);
    }
    return Buffer.from(value, (encoding as BufferEncoding | undefined) ?? "utf8");
  }
  if (ArrayBufferIsView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  }
  if (require("node:util/types").isAnyArrayBuffer(value)) return new Uint8Array(value as ArrayBuffer).slice();
  if ($inheritsBlob(value)) return value as Blob;
  throw invalidType(name, "string, ArrayBuffer, TypedArray, DataView or Blob", value);
}

function baseName(path: string): string {
  return path.slice(MathMin(path.length, MathMax(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1));
}

/** The media type that goes with the extension of `filename`, or "". */
function typeOfFileName(filename: string): string {
  const extension = filename.slice(filename.lastIndexOf(".") + 1);
  // The type of a Bun.file() comes from its name. It reads nothing.
  return extension.length < filename.length && FILE_EXTENSION.test(extension) ? Bun.file("file." + extension).type : "";
}

function isMediaType(type: unknown): type is string {
  return typeof type === "string" && type.length <= MAX_TOKEN_LENGTH && MEDIA_TYPE.test(type);
}

function validateAttachment(value: unknown, name: string): Attachment {
  const fields = ownFields(value, name, ATTACHMENT_NAMES, "a field of an attachment");
  const { path, encoding } = fields;
  let { filename, content, contentType, cid, contentDisposition } = fields;

  if (content === undefined && path !== undefined) {
    validateString(path, `${name}.path`);
    content = Bun.file(path);
  }
  if (content === undefined) throw invalid(name, 'must have "content" or "path"');
  const bytes = toBytes(content, `${name}.content`, encoding);
  const isBlob = $inheritsBlob(bytes);

  if (filename === undefined) {
    // The name of a Bun.file() is its path.
    const from = typeof path === "string" ? path : isBlob ? (bytes as { name?: unknown }).name : undefined;
    if (typeof from === "string" && from !== "") filename = baseName(from);
  }
  if (filename !== undefined) {
    // A lone surrogate becomes U+FFFD here, as it does wherever text is turned into UTF-8.
    filename = validateHeaderText(filename, `${name}.filename`).toWellFormed();
    if (Buffer.byteLength(filename as string) > 255) {
      throw $ERR_INVALID_ARG_VALUE(`${name}.filename`, preview(filename as string), "is longer than 255 bytes");
    }
  }

  if (contentType === undefined) {
    // The type of the Blob, unless it says nothing: the one of a Bun.file() comes from its path, and
    // the one of a fetched Blob from a header of a server. Then the type that goes with the file
    // name. Neither is the caller's, so one that is not a media type is passed over, not refused.
    const ofBlob = isBlob ? (bytes as Blob).type : "";
    let guessed: unknown = isMediaType(ofBlob) && !GENERIC_TYPE.test(ofBlob) ? ofBlob : undefined;
    if (guessed === undefined && filename !== undefined) guessed = typeOfFileName(filename as string);
    // An attached message is only sent as one when the caller says that it is one: see messageBody.
    contentType = isMediaType(guessed) && !CONTAINER_TYPE.test(guessed) ? guessed : "application/octet-stream";
  } else {
    validateHeaderText(contentType, `${name}.contentType`);
    if (!isMediaType(contentType)) {
      throw $ERR_INVALID_ARG_VALUE(`${name}.contentType`, preview(contentType as string), "is not a media type");
    }
    if (CONTAINER_TYPE.test(contentType) && !MESSAGE_TYPE.test(contentType)) {
      throw $ERR_INVALID_ARG_VALUE(`${name}.contentType`, contentType, "is not a type that an attachment can have");
    }
  }

  if (cid !== undefined) cid = validateId(cid, `${name}.cid`, "a content ID");
  if (contentDisposition === undefined) {
    contentDisposition = cid !== undefined ? "inline" : "attachment";
  } else if (contentDisposition !== "attachment" && contentDisposition !== "inline") {
    throw $ERR_INVALID_ARG_VALUE(`${name}.contentDisposition`, contentDisposition, 'must be "attachment" or "inline"');
  }

  return {
    filename: filename as string | undefined,
    contentType: contentType as string,
    disposition: contentDisposition as "attachment" | "inline",
    cid: cid as string | undefined,
    content: bytes,
  };
}

/** Everything about a message that can be wrong is found here, before a connection is made. */
function validateMessage(message: unknown): Draft {
  const fields = ownFields(message, "message", MESSAGE_NAMES, "a field of a message");
  const { from, to, cc, bcc, replyTo, subject, text, html, attachments, headers, date, messageId } = fields;
  const { inReplyTo, references, envelope, raw } = fields;
  if (raw !== undefined) {
    for (const key of ObjectKeys(fields)) {
      if (!RAW_MESSAGE_NAMES.includes(key)) {
        // The headers and the body of a raw message are in it.
        throw invalid(`message.${key}`, `cannot be set next to "raw", which can have: ${RAW_MESSAGE_NAMES.join(", ")}`);
      }
    }
  }

  // A raw message has headers of its own, so its addresses are only for the envelope.
  const forEnvelope = raw !== undefined;
  const fromList = parseAddresses(from, "message.from", forEnvelope);
  const toList = parseAddresses(to, "message.to", forEnvelope);
  const ccList = parseAddresses(cc, "message.cc", forEnvelope);
  const bccList = parseAddresses(bcc, "message.bcc", true);
  const replyToList = parseAddresses(replyTo, "message.replyTo", false);

  // The envelope is what the server is told in MAIL FROM and RCPT TO. It is the sender and every
  // recipient of the headers unless the message says otherwise.
  let sender: string | undefined = fromList[0]?.address;
  let recipients: string[] = [];
  for (const list of [toList, ccList, bccList]) {
    for (const { address } of list) recipients.push(address);
  }
  if (envelope !== undefined) {
    const parts = ownFields(envelope, "message.envelope", ENVELOPE_NAMES, "a field of an envelope");
    const { from: envelopeFrom, to: envelopeTo, cc: envelopeCc, bcc: envelopeBcc } = parts;
    if (envelopeFrom === "" || envelopeFrom === "<>") {
      // The null sender of a bounce or an automatic answer: nothing comes back to it (RFC 5321, section 4.5.5).
      sender = "";
    } else if (envelopeFrom !== undefined) {
      const list = parseAddresses(envelopeFrom, "message.envelope.from", true);
      if (list.length !== 1) throw invalid("message.envelope.from", "must be one address");
      sender = list[0].address;
    }
    if (envelopeTo !== undefined || envelopeCc !== undefined || envelopeBcc !== undefined) {
      const list = parseAddresses(envelopeTo, "message.envelope.to", true);
      parseAddresses(envelopeCc, "message.envelope.cc", true, list);
      parseAddresses(envelopeBcc, "message.envelope.bcc", true, list);
      recipients = list.map(entry => entry.address);
      if (recipients.length === 0) throw invalid("message.envelope.to", "has no recipient");
    }
  }
  if (sender === undefined) throw invalid("message.from", "is required");
  recipients = [...new Set(recipients)];
  if (recipients.length === 0) {
    throw invalid("message.to", 'is required, unless "cc", "bcc" or "envelope.to" has a recipient');
  }

  const draft: Draft = {
    envelope: { from: sender, to: recipients },
    messageId: undefined,
    utf8: !isASCII(sender) || recipients.some(address => !isASCII(address)),
    raw: undefined,
    headers: [],
    text: undefined,
    html: undefined,
    attachments: [],
  };

  if (raw !== undefined) {
    // A message that is already written. Its headers are the caller's.
    draft.raw = toBytes(raw, "message.raw");
    return draft;
  }

  if (fromList.length !== 1) throw invalid("message.from", "must be one address");

  const lines = draft.headers;
  lines.push(addressHeader("From", fromList));
  if (toList.length > 0) lines.push(addressHeader("To", toList));
  if (ccList.length > 0) lines.push(addressHeader("Cc", ccList));
  if (replyToList.length > 0) lines.push(addressHeader("Reply-To", replyToList));
  if (subject !== undefined) lines.push(textHeader("Subject", validateHeaderText(subject, "message.subject")));

  let id: string;
  if (messageId !== undefined) {
    id = validateId(messageId, "message.messageId", "a message ID");
  } else {
    // The null sender has no domain. The header address has one.
    const { address } = fromList[0];
    id = crypto.randomUUID() + address.slice(address.lastIndexOf("@"));
  }
  draft.messageId = `<${id}>`;
  lines.push(idHeader("Message-ID", id));

  let time: number;
  if (date === undefined) {
    time = Date.now();
  } else {
    if (!require("node:util/types").isDate(date)) throw invalidType("message.date", "Date", date);
    if (typeof DatePrototypeGetTime !== "function") {
      throw invalid("message.date", "cannot be read, because the Date of this program is not the built-in one");
    }
    time = DatePrototypeGetTime.$call(date);
    if (NumberIsNaN(time)) throw invalid("message.date", "is not a valid date");
  }
  lines.push("Date: " + formatDate(time));

  if (inReplyTo !== undefined) {
    lines.push(idHeader("In-Reply-To", validateId(inReplyTo, "message.inReplyTo", "a message ID")));
  }
  if (references !== undefined) {
    // One string can hold several, as the header does.
    const list = ArrayIsArray(references)
      ? references
      : typeof references === "string"
        ? references.trim().split(WHITE_SPACE)
        : [references];
    // Read by index into an array of this file: nothing of the caller's array is called, and a
    // hole in it is not an ID.
    const ids: string[] = [];
    for (let i = 0; i < list.length; i++) {
      ids.push(`<${validateId(list[i], `message.references[${i}]`, "a message ID")}>`);
    }
    if (ids.length > 0) {
      lines.push("References:" + (ids[0].length + 12 > LINE_LENGTH + 2 ? "\r\n " : " ") + ids.join("\r\n "));
    }
  }

  if (headers !== undefined) {
    const own = ownFields(headers, "message.headers", undefined, "");
    for (const key of ObjectKeys(own)) {
      if (key.length > LINE_LENGTH || !HEADER_NAME.test(key)) {
        throw $ERR_INVALID_ARG_VALUE("message.headers", preview(key), "is not a header name");
      }
      const option = RESERVED_HEADERS[key.toLowerCase()];
      if (option !== undefined) {
        throw $ERR_INVALID_ARG_VALUE(
          "message.headers",
          key,
          option === "" ? "is written by the client" : `is written from "${option}" of the message`,
        );
      }
      const value = own[key];
      const values = ArrayIsArray(value) ? value : [value];
      for (let i = 0; i < values.length; i++) {
        lines.push(textHeader(key, validateHeaderText(values[i], `message.headers["${key}"]`)));
      }
    }
  }
  lines.push("MIME-Version: 1.0");

  if (text !== undefined) {
    validateString(text, "message.text");
    draft.text = text;
  }
  if (html !== undefined) {
    validateString(html, "message.html");
    draft.html = html;
  }
  if (attachments !== undefined) {
    if (!ArrayIsArray(attachments)) throw invalidType("message.attachments", "Array", attachments);
    for (let i = 0; i < attachments.length; i++) {
      draft.attachments.push(validateAttachment(attachments[i], `message.attachments[${i}]`));
    }
  }
  return draft;
}

function readBytes(content: Uint8Array | Blob): Uint8Array | Promise<Uint8Array> {
  // Not the bytes() of the object: a subclass can have one of its own, and what that returns nobody has checked.
  return $inheritsBlob(content) ? BlobPrototypeBytes.$call(content) : (content as Uint8Array);
}

/**
 * Makes every line end a CRLF. The end of the data is a line with one dot, so a server that took a
 * lone LF for a line end would find it in text that another server passed through as one line
 * (that is SMTP smuggling).
 */
function normalizeLineEnds(bytes: Uint8Array): Uint8Array {
  const length = bytes.length;
  let extra = 0;
  for (let i = 0; i < length; i++) {
    const byte = bytes[i];
    if (byte === 0x0a) {
      if (i === 0 || bytes[i - 1] !== 0x0d) extra++;
    } else if (byte === 0x0d) {
      if (i + 1 === length || bytes[i + 1] !== 0x0a) extra++;
    }
  }
  if (extra === 0) return bytes;
  const out = new Uint8Array(length + extra);
  let o = 0;
  for (let i = 0; i < length; i++) {
    const byte = bytes[i];
    if (byte === 0x0a) {
      if (i === 0 || bytes[i - 1] !== 0x0d) out[o++] = 0x0d;
      out[o++] = 0x0a;
    } else if (byte === 0x0d) {
      out[o++] = 0x0d;
      if (i + 1 === length || bytes[i + 1] !== 0x0a) out[o++] = 0x0a;
    } else {
      out[o++] = byte;
    }
  }
  return out;
}

/** Whether a byte of `bytes` is not ASCII. */
function hasEighthBit(bytes: Uint8Array): boolean {
  for (let i = 0, length = bytes.length; i < length; i++) {
    if (bytes[i] > 0x7f) return true;
  }
  return false;
}

/**
 * The message as it goes to the server after DATA: every line ends with CRLF, the last one too.
 * Its length is what SIZE is about (RFC 1870).
 */
async function buildMessage(draft: Draft): Promise<Buffer> {
  const { raw } = draft;
  if (raw !== undefined) {
    const bytes = normalizeLineEnds(await readBytes(raw));
    const length = bytes.length;
    const message = Buffer.from(bytes.buffer, bytes.byteOffset, length);
    const complete = length === 0 || (length >= 2 && bytes[length - 2] === 0x0d && bytes[length - 1] === 0x0a);
    return complete ? message : Buffer.concat([message, Buffer.from("\r\n")]);
  }
  const { attachments } = draft;
  const contents = new Array<Uint8Array>(attachments.length);
  for (let i = 0; i < attachments.length; i++) contents[i] = await readBytes(attachments[i].content);
  const body = buildBody(draft, contents);
  const text = draft.headers.join("\r\n") + "\r\n" + body + (body.endsWith("\r\n") ? "" : "\r\n");
  // Every part of it was written as ASCII. A character that is not would be a mistake of this file,
  // and one that must not reach the wire as some other byte.
  if (!isASCII(text)) throw $ERR_INVALID_STATE("The message has a character that is not ASCII after it was encoded");
  return Buffer.from(text, "utf8");
}

/**
 * What is written after DATA: the message, in which each line that starts with a dot gets a second
 * one (RFC 5321, section 4.5.2), and the line with one dot that ends the data. A message that has
 * such lines is copied once, into one buffer: a write for each of them would be a packet, or a TLS
 * record, for each of them.
 */
function frameData(message: Buffer): Buffer[] {
  const length = message.length;
  const first = length > 0 && message[0] === 0x2e ? 1 : 0;
  let dots = first;
  for (let at = message.indexOf("\r\n.", 0, "latin1"); at !== -1; at = message.indexOf("\r\n.", at + 3, "latin1")) {
    dots++;
  }
  if (dots === 0) return [message, Buffer.from(".\r\n")];
  const out = Buffer.allocUnsafe(length + dots + 3);
  let from = 0;
  let to = 0;
  if (first === 1) out[to++] = 0x2e;
  for (let at = message.indexOf("\r\n.", 0, "latin1"); at !== -1; at = message.indexOf("\r\n.", at + 3, "latin1")) {
    // Up to the dot, and then a dot in front of it.
    to += message.copy(out, to, from, at + 2);
    out[to++] = 0x2e;
    from = at + 2;
  }
  to += message.copy(out, to, from, length);
  out[to++] = 0x2e;
  out[to++] = 0x0d;
  out[to++] = 0x0a;
  return [out];
}

// ───────────────────────────── the connection ─────────────────────────────

interface SMTPError extends Error {
  code: string;
  responseCode?: number;
  response?: string;
  command?: string;
  rejected?: string[];
}

/** A reply from 200 to 299: the server did what the command asked for. */
function isPositive(reply: Reply): boolean {
  const { code } = reply;
  return code >= 200 && code < 300;
}

function describe(reply: Reply): string {
  const { code, text } = reply;
  return text === "" ? String(code) : `${code} ${text.replaceAll("\n", " ")}`;
}

/** The words of the server go along with the error, and the command without its arguments. */
function withReply<E extends Error>(error: E, reply: Reply, command: string): E {
  const target = error as unknown as SMTPError;
  target.responseCode = reply.code;
  target.response = describe(reply);
  target.command = command;
  return error;
}

function closedByServer() {
  return $ERR_SMTP_CONNECTION_CLOSED("The server closed the connection");
}

/**
 * The error of a connection that ended behind the refusal of a recipient: the last words of the
 * server go along with it. They may be why it hung up.
 */
function afterRefusal(error: unknown, refusal: Reply | undefined): unknown {
  if (refusal !== undefined && $isObject(error) && (error as SMTPError).responseCode === undefined) {
    withReply(error as Error, refusal, "RCPT TO");
  }
  return error;
}

/**
 * The errors of a connection that the server ended before it had anything of the message. The
 * same message can go over another connection, and cannot arrive twice.
 */
const unsent = new WeakSet<object>();

/** What a command waits for. Nothing answers "close": the end of the connection rejects it. */
type Waiting = "reply" | "drain" | "handshake" | "close";

interface Waiter {
  kind: Waiting;
  resolve: (value: any) => void;
  reject: (error: unknown) => void;
}

class Connection {
  #options: ResolvedOptions;
  #socket: any = null;
  /** The socket while it connects. Closing it calls the attempt off. */
  #connecting: any = null;
  /** Rejects the wait for the connection, which the socket itself may leave pending. */
  #abortConnect: ((error: unknown) => void) | undefined;
  /** From STARTTLS on, the plain socket reports the encrypted bytes. Its events are not ours. */
  #upgraded = false;
  #handshake: { success: boolean; error: unknown } | undefined;
  /** What has arrived and is not a whole line yet, one character per byte. */
  #input = "";
  /** The lines so far of a reply that has more, and their length. */
  #lines: string[] = [];
  #replyLength = 0;
  #replies: Reply[] = [];
  #waiter: Waiter | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** Why the connection cannot be used any more. Set once. */
  #failure: unknown;
  #failed = false;
  #referenced = true;

  /** Whether the bytes are encrypted now. */
  secure = false;
  /** The keywords of the EHLO reply in upper case, with their parameters. */
  extensions = new Map<string, string>();
  /** How many messages the server took over this connection. */
  messages = 0;

  constructor(options: ResolvedOptions) {
    this.#options = options;
  }

  /** Open, and nothing has arrived that no command asked for. */
  get usable(): boolean {
    return !this.#failed && this.#socket !== null && this.#replies.length === 0 && !this.#receiving;
  }

  get open(): boolean {
    return !this.#failed && this.#socket !== null;
  }

  /** A part of a reply has arrived. */
  get #receiving(): boolean {
    return this.#input.length > 0 || this.#lines.length > 0;
  }

  ref() {
    this.#referenced = true;
    this.#socket?.ref();
  }

  unref() {
    this.#referenced = false;
    this.#socket?.unref();
  }

  #handlers(encrypted: boolean) {
    const connection = this;
    // What a socket reports after the connection was given up is nobody's.
    const stale = () => connection.#failed || (!encrypted && connection.#upgraded);
    return {
      open() {},
      data(_socket: unknown, chunk: Buffer) {
        if (!stale()) connection.#receive(chunk);
      },
      drain() {
        if (!stale()) connection.#settle("drain", undefined);
      },
      handshake(_socket: unknown, success: boolean, error: unknown) {
        if (connection.#failed) return;
        connection.#handshake = { success, error };
        connection.#settle("handshake", undefined);
      },
      end() {
        if (!stale()) connection.fail(closedByServer());
      },
      close(_socket: unknown, error: unknown) {
        connection.fail(error ?? closedByServer());
      },
      error(_socket: unknown, error: unknown) {
        connection.fail(error);
      },
      connectError(_socket: unknown, error: unknown) {
        connection.fail(error);
      },
    };
  }

  #receive(chunk: Buffer) {
    const input = this.#input + chunk.toString("latin1");
    let start = 0;
    for (;;) {
      const end = input.indexOf("\n", start);
      const length = (end === -1 ? input.length : end + 1) - start;
      if (this.#replyLength + length > MAX_REPLY_LENGTH) {
        this.fail($ERR_SMTP_INVALID_RESPONSE(`The server sent a reply of more than ${MAX_REPLY_LENGTH} bytes`));
        return;
      }
      if (end === -1) break;
      let line = input.slice(start, end);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      start = end + 1;
      if (!REPLY_LINE.test(line)) {
        this.fail($ERR_SMTP_INVALID_RESPONSE("The server sent a line that is not an SMTP reply"));
        return;
      }
      // The text is UTF-8 where it is not ASCII (RFC 6531).
      this.#lines.push(isASCII(line) ? line.slice(4) : Buffer.from(line.slice(4), "latin1").toString("utf8"));
      this.#replyLength += length;
      if (line[3] !== "-") {
        const reply: Reply = { code: Number(line.slice(0, 3)), text: this.#lines.join("\n") };
        this.#lines = [];
        this.#replyLength = 0;
        if (!this.#settle("reply", reply) && this.#replies.push(reply) > MAX_WAITING_REPLIES) {
          this.fail($ERR_SMTP_INVALID_RESPONSE("The server sent replies that no command asked for"));
          return;
        }
      }
    }
    this.#input = input.slice(start);
  }

  #wait(kind: Waiting, timeout = this.#options.socketTimeout): Promise<any> {
    if (this.#failed) return Promise.$reject(this.#failure);
    const { promise, resolve, reject } = Promise.withResolvers<any>();
    this.#waiter = { kind, resolve, reject };
    this.#timer = setTimeout(() => {
      this.fail(
        kind === "close"
          ? $ERR_SMTP_CONNECTION_CLOSED("The connection was closed while data was being sent")
          : $ERR_SMTP_TIMEOUT(
              kind === "drain"
                ? `The server took no data for ${timeout} ms`
                : kind === "handshake"
                  ? `The TLS handshake did not finish within ${timeout} ms`
                  : `The server did not answer within ${timeout} ms`,
            ),
      );
    }, timeout);
    return promise;
  }

  #settle(kind: Waiting, value: unknown): boolean {
    const waiter = this.#waiter;
    if (waiter === undefined || waiter.kind !== kind) return false;
    this.#waiter = undefined;
    clearTimeout(this.#timer);
    waiter.resolve(value);
    return true;
  }

  /**
   * The end of the connection, at once and for whatever reason. What waits on it is rejected with
   * `error`.
   */
  fail(error: unknown) {
    if (this.#failed) return;
    this.#failed = true;
    this.#failure = error;
    clearTimeout(this.#timer);
    // The waiter is taken first: closing the socket calls its handlers, and none of them may answer it.
    const waiter = this.#waiter;
    this.#waiter = undefined;
    const socket = this.#socket ?? this.#connecting;
    this.#socket = null;
    this.#connecting = null;
    socket?.terminate();
    this.#abortConnect?.(error);
    waiter?.reject(error);
  }

  /**
   * Closes this side of a session that is in order, with `goodbye` as its last words. Nothing
   * waits for the server to close its side, and the process does not stay for it: the socket lets
   * go of the process first, because one that has been ended is not asked again. With TLS the
   * socket itself waits some seconds for the server to answer the close, and then closes.
   */
  #end(error: unknown, goodbye?: string) {
    this.#failed = true;
    this.#failure = error;
    clearTimeout(this.#timer);
    const socket = this.#socket;
    this.#socket = null;
    if (socket === null) return;
    socket.unref();
    if (goodbye === undefined) socket.end();
    else socket.end(goodbye);
  }

  /** Leaves a session that is in order because of `error`, which it returns: QUIT, and no reset of the connection. */
  #leave<E>(error: E): E {
    if (!this.#failed) this.#end(error, "QUIT\r\n");
    return error;
  }

  /** The same for a reply of 421, with which the server says that it is closing the connection (RFC 5321, section 3.8). */
  #gone(reply: Reply, command: string, nothingSent: boolean): Error {
    const error = withReply(
      $ERR_SMTP_CONNECTION_CLOSED(`The server is closing the connection: ${describe(reply)}`),
      reply,
      command,
    );
    if (nothingSent) unsent.add(error);
    return this.#leave(error);
  }

  #reply(timeout?: number): Promise<Reply> {
    const reply = this.#replies.shift();
    if (reply !== undefined) return Promise.$resolve(reply);
    return this.#wait("reply", timeout);
  }

  async #write(data: Buffer | string) {
    const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    const length = bytes.length;
    let offset = 0;
    while (offset < length) {
      if (this.#failed) throw this.#failure;
      const written = this.#socket.write(bytes, offset, length - offset);
      if (written < 0) {
        // The socket knows that the connection is gone, and has not said so yet. What the server
        // sent before it went is still to be read, and it may be the reason: a refusal, and then
        // a hang-up. The end of the connection comes behind it and rejects this wait.
        await this.#wait("close", PROBE_TIMEOUT);
        throw this.#failure;
      }
      offset += written;
      if (offset < length) await this.#wait("drain");
    }
  }

  async command(line: string, timeout?: number): Promise<Reply> {
    await this.#write(line + "\r\n");
    return this.#reply(timeout);
  }

  /**
   * Puts TLS on the connection: at once for a port that starts with it, and after STARTTLS for the
   * others.
   */
  async #encrypt() {
    this.#upgraded = true;
    const [, encrypted] = this.#socket.upgradeTLS({ tls: this.#options.tls, socket: this.#handlers(true) });
    this.#socket = encrypted;
    if (!this.#referenced) encrypted.unref();
    if (this.#handshake === undefined) await this.#wait("handshake");
    const { success, error } = this.#handshake!;
    this.#handshake = undefined;
    if (!success) {
      const code = (error as { code?: unknown } | null | undefined)?.code;
      // `rejectUnauthorized: false` takes a certificate that is not trusted, or that is for another
      // name. It does not make a handshake that failed one that did not.
      const refusedCertificate = typeof code === "string" && !TLS_FAILURE.test(code);
      if (!(refusedCertificate && this.#options.lenient)) throw error ?? $ERR_SMTP_TLS("The TLS handshake failed");
    }
    this.secure = true;
  }

  /**
   * Connects and goes as far as a session that can take a message: greeting, EHLO, STARTTLS, AUTH.
   * All of it together has `connectionTimeout`.
   */
  async start() {
    const options = this.#options;
    const { host, port, secure, connectionTimeout } = options;
    let reached = `No connection to ${host}:${port}`;
    const timer = setTimeout(() => {
      this.fail($ERR_SMTP_CONNECTION_TIMEOUT(`${reached} within ${connectionTimeout} ms`));
    }, connectionTimeout);
    try {
      const connecting = newDetachedSocket(false);
      this.#connecting = connecting;
      const socket = await new Promise<any>((resolve, reject) => {
        this.#abortConnect = reject;
        doConnect(connecting, { hostname: host, port, socket: this.#handlers(false) }).then(resolve, reject);
      });
      this.#abortConnect = undefined;
      if (this.#failed) throw this.#failure;
      this.#connecting = null;
      this.#socket = socket;
      if (!this.#referenced) socket.unref();

      if (secure) {
        reached = `Connected to ${host}:${port}, but the TLS handshake did not finish`;
        await this.#encrypt();
      }
      reached = `Connected to ${host}:${port}, but the server sent no greeting`;
      // A port that starts with TLS says nothing until it has had a handshake.
      if (!secure) reached += ' (a port that starts with TLS needs "secure: true")';
      const greeting = await this.#reply();
      if (greeting.code !== 220) {
        throw this.#leave(
          withReply(
            $ERR_SMTP_UNEXPECTED_RESPONSE(`The server refused the connection: ${describe(greeting)}`),
            greeting,
            "CONNECT",
          ),
        );
      }

      reached = `Connected to ${host}:${port}, but the session was not ready`;
      await this.#hello();
      if (!this.secure && !options.ignoreTLS) {
        if (this.extensions.has("STARTTLS")) {
          await this.#startTLS();
          await this.#hello();
        } else if (options.requireTLS) {
          throw this.#leave($ERR_SMTP_TLS(`The server ${host}:${port} does not offer STARTTLS, and requireTLS is set`));
        }
      }
      if (options.user !== undefined) await this.#authenticate();
    } catch (error) {
      this.fail(error);
      // What the server said is the reason, also when it hung up behind it. Without a reply, the
      // first failure is: when the time ran out, the error of the socket is its consequence.
      throw (error as SMTPError | null | undefined)?.responseCode !== undefined ? error : this.#failure;
    } finally {
      clearTimeout(timer);
    }
  }

  async #hello() {
    const { name } = this.#options;
    const reply = await this.command(`EHLO ${name}`);
    this.extensions.clear();
    const { code, text } = reply;
    if (code === 250) {
      const lines = text.split("\n");
      // The first line greets. Each one after it names an extension.
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        const space = line.search(KEYWORD_END);
        const keyword = (space === -1 ? line : line.slice(0, space)).toUpperCase();
        this.extensions.set(keyword, space === -1 ? "" : line.slice(space + 1).trim());
      }
      return;
    }
    // A server from before 1995, or one that is made to look like it, knows HELO alone.
    if (code >= 500) {
      let answer: Reply | undefined;
      try {
        answer = await this.command(`HELO ${name}`);
      } catch {
        // The server hung up on it: what it said to EHLO is the reason.
      }
      if (answer !== undefined && answer.code === 250) return;
    }
    throw this.#leave(
      withReply($ERR_SMTP_UNEXPECTED_RESPONSE(`The server refused the greeting: ${describe(reply)}`), reply, "EHLO"),
    );
  }

  async #startTLS() {
    const reply = await this.command("STARTTLS");
    if (reply.code !== 220) {
      throw this.#leave(withReply($ERR_SMTP_TLS(`The server refused STARTTLS: ${describe(reply)}`), reply, "STARTTLS"));
    }
    // What came behind the reply in the same packet may have ended the connection already.
    if (this.#failed) throw this.#failure;
    // And what came in clear text after the reply would be read as if it came over TLS: a reply
    // that somebody between the two put there.
    if (this.#receiving || this.#replies.length > 0) {
      throw $ERR_SMTP_INVALID_RESPONSE("The server sent data after its reply to STARTTLS");
    }
    await this.#encrypt();
  }

  async #authenticate() {
    const options = this.#options;
    const { host, user, pass, accessToken, method: wanted } = options;
    // As net/smtp of Go does: a password does not cross a network in clear text unless the
    // program says so. A server between here and there that drops STARTTLS from the reply to
    // EHLO would otherwise read it.
    if (!this.secure && !options.ignoreTLS && !isLoopback(host)) {
      throw this.#leave(
        $ERR_SMTP_TLS(
          `The connection to ${host} is not encrypted, and the credentials are not sent over it. ` +
            "Set secure for a port that starts with TLS, or ignoreTLS to send them as they are",
        ),
      );
    }
    const offered = (this.extensions.get("AUTH") ?? "").toUpperCase().split(WHITE_SPACE).filter(Boolean);
    const usable = accessToken !== undefined ? ["XOAUTH2"] : ["PLAIN", "LOGIN"];
    const method = wanted !== undefined ? wanted : usable.find(candidate => offered.includes(candidate));
    if (method === undefined || !offered.includes(method)) {
      const offer = offered.length === 0 ? "offers no authentication" : `offers ${offered.join(", ")}`;
      throw this.#leave(
        $ERR_SMTP_AUTHENTICATION_FAILED(
          wanted !== undefined
            ? `The server ${host} does not offer ${wanted}, which auth.method asks for. It ${offer}`
            : offered.length === 0
              ? `The server ${host} does not offer authentication`
              : `The server ${host} ${offer}, and none of them can be used with these credentials`,
        ),
      );
    }

    let reply: Reply;
    if (method === "PLAIN") {
      reply = await this.#respond("PLAIN", Buffer.from(`\0${user}\0${pass}`, "utf8").toString("base64"));
    } else if (method === "LOGIN") {
      reply = await this.command("AUTH LOGIN");
      if (reply.code === 334) reply = await this.command(Buffer.from(user!, "utf8").toString("base64"));
      if (reply.code === 334) reply = await this.command(Buffer.from(pass!, "utf8").toString("base64"));
    } else {
      const token = `user=${user}\x01auth=Bearer ${accessToken}\x01\x01`;
      reply = await this.#respond("XOAUTH2", Buffer.from(token, "utf8").toString("base64"));
      // The server says why in a challenge, and the error only after an empty answer to it.
      if (reply.code === 334) reply = await this.command("");
    }
    if (reply.code !== 235) {
      throw this.#leave(
        withReply(
          $ERR_SMTP_AUTHENTICATION_FAILED(`Authentication failed: ${describe(reply)}`),
          reply,
          `AUTH ${method}`,
        ),
      );
    }
  }

  /**
   * `AUTH` with the response on the same line, where the two fit on a command line of 512 octets
   * (RFC 5321, section 4.5.3.1.4). A longer response, such as an access token of some thousand
   * characters, goes on a line of its own after the server asks for it (RFC 4954, section 4).
   */
  async #respond(method: string, response: string): Promise<Reply> {
    const line = `AUTH ${method} ${response}`;
    if (line.length <= 510) return this.command(line);
    const reply = await this.command(`AUTH ${method}`);
    return reply.code === 334 ? this.command(response) : reply;
  }

  /** One message. The connection can take another one after it, also when the server refused this one. */
  async deliver(envelope: Envelope, message: Buffer, utf8: boolean, eightBit: boolean) {
    const { extensions } = this;
    const size = message.length;
    if (utf8 && !extensions.has("SMTPUTF8")) {
      throw $ERR_SMTP_UNSUPPORTED(
        "An address has a local part that is not ASCII, and the server does not offer SMTPUTF8",
      );
    }
    const limit = Number(extensions.get("SIZE"));
    if (limit > 0 && size > limit) {
      throw $ERR_SMTP_MESSAGE_REJECTED(`The message has ${size} bytes, and the server takes ${limit} bytes at most`);
    }

    let mail = `MAIL FROM:<${envelope.from}>`;
    if (extensions.has("SIZE")) mail += ` SIZE=${size}`;
    // Only a raw message can hold bytes that are not ASCII. A server without the extension gets
    // them as they are, which is what every mail program does.
    if (eightBit && extensions.has("8BITMIME")) mail += " BODY=8BITMIME";
    if (utf8) mail += " SMTPUTF8";
    let reply = await this.command(mail);
    if (reply.code === 421) throw this.#gone(reply, "MAIL FROM", true);
    if (!isPositive(reply)) {
      throw withReply(
        $ERR_SMTP_SENDER_REJECTED(`The server refused the sender: ${describe(reply)}`),
        reply,
        "MAIL FROM",
      );
    }

    const accepted: string[] = [];
    const rejected: string[] = [];
    let refusal: Reply | undefined;
    for (const recipient of envelope.to) {
      try {
        reply = await this.command(`RCPT TO:<${recipient}>`);
      } catch (error) {
        throw afterRefusal(error, refusal);
      }
      if (reply.code === 421) throw this.#gone(reply, "RCPT TO", true);
      // 250, or 251 from a server that forwards the message.
      if (isPositive(reply)) {
        accepted.push(recipient);
      } else {
        rejected.push(recipient);
        refusal = reply;
      }
    }
    if (accepted.length === 0) {
      const error = withReply(
        $ERR_SMTP_RECIPIENTS_REJECTED(`The server refused every recipient: ${describe(refusal!)}`),
        refusal!,
        "RCPT TO",
      );
      (error as unknown as SMTPError).rejected = rejected;
      throw error;
    }

    try {
      reply = await this.command("DATA");
    } catch (error) {
      throw afterRefusal(error, refusal);
    }
    if (reply.code === 421) throw this.#gone(reply, "DATA", true);
    if (reply.code !== 354) {
      throw withReply($ERR_SMTP_MESSAGE_REJECTED(`The server refused the message: ${describe(reply)}`), reply, "DATA");
    }
    // From here on the server reads a message. If the data stops short, only the end of the
    // connection tells it that the rest is not coming.
    try {
      for (const chunk of frameData(message)) await this.#write(chunk);
      reply = await this.#reply();
    } catch (error) {
      this.fail(error);
      // A server that has enough of a message says so and hangs up. What it said is the reason,
      // and the closed connection is what followed.
      const early = this.#replies.shift();
      if (early === undefined || isPositive(early)) throw error;
      throw withReply($ERR_SMTP_MESSAGE_REJECTED(`The server refused the message: ${describe(early)}`), early, "DATA");
    }
    if (reply.code === 421) throw this.#gone(reply, "DATA", false);
    if (!isPositive(reply)) {
      throw withReply($ERR_SMTP_MESSAGE_REJECTED(`The server refused the message: ${describe(reply)}`), reply, "DATA");
    }
    this.messages++;
    return { accepted, rejected, response: describe(reply) };
  }

  /** Says QUIT, waits a moment for the answer, and closes. */
  async quit() {
    if (this.usable) {
      try {
        // The answer is 221, and nothing depends on it.
        await this.command("QUIT", MathMin(this.#options.socketTimeout, PROBE_TIMEOUT));
      } catch {}
    }
    if (!this.#failed) this.#end($ERR_SMTP_CONNECTION_CLOSED("The connection is closed"));
  }

  /** The same without the wait, for a connection that nobody is waiting for. */
  leave() {
    if (this.usable) this.#leave($ERR_SMTP_CONNECTION_CLOSED("The connection is closed"));
    else this.fail($ERR_SMTP_CONNECTION_CLOSED("The connection is closed"));
  }
}

function isLoopback(host: string): boolean {
  return host.toLowerCase() === "localhost" || host === "::1" || LOOPBACK_V4.test(host);
}

// ───────────────────────────── the client ─────────────────────────────

function defaultName(): string {
  // A server may look the name up, so only a full one is given. An address literal is always valid.
  const hostname = require("node:os").hostname();
  return hostname.includes(".") && HOST_NAME.test(hostname) ? hostname : "[127.0.0.1]";
}

function resolveOptions(first: unknown, second: unknown): ResolvedOptions {
  let url: unknown;
  let options: Fields;
  if (typeof first === "string" || first instanceof URL) {
    url = first;
    options =
      second === undefined ? ({ __proto__: null } as Fields) : ownFields(second, "options", OPTION_NAMES, "an option");
    if (options.url !== undefined) throw invalid("options.url", "cannot be set next to a URL");
  } else if (first === undefined || first === null) {
    throw $ERR_MISSING_ARGS(["url", "options"]);
  } else if (second !== undefined) {
    throw invalidType("url", "string or URL", first);
  } else {
    options = ownFields(first, "options", OPTION_NAMES, "an option");
    url = options.url;
  }

  let host: unknown = options.host;
  let hostOption = "options.host";
  if (host === undefined) {
    host = options.hostname;
    hostOption = "options.hostname";
  }
  let port: unknown = options.port;
  let secure: unknown = options.secure;
  let user: unknown;
  let pass: unknown;
  let accessToken: unknown;
  let method: unknown;

  // A URL may hold a password, so no message about one shows it.
  if (url !== undefined) {
    let parsed: URL;
    if (url instanceof URL) {
      parsed = url;
    } else {
      if (typeof url !== "string") throw invalidType("url", "string or URL", url);
      try {
        parsed = new URL(url);
      } catch {
        throw invalid(
          "url",
          'is not a URL. Write it as "smtp://user:password@host:port", with a user or a password in percent-encoding',
        );
      }
    }
    const { protocol, hostname, port: urlPort, username, password, pathname, search, hash } = parsed;
    if (protocol !== "smtp:" && protocol !== "smtps:") {
      throw invalid("url", 'must start with "smtp://" or "smtps://"');
    }
    if (hostname === "") throw invalid("url", 'has no host. Write it as "smtp://host:port"');
    // What is written there would look like it was applied.
    if (search !== "" || hash !== "" || (pathname !== "" && pathname !== "/")) {
      throw invalid(
        "url",
        "has a path, a query or a fragment, which are not read. Pass options as the second argument, " +
          'and write a "/", a "?" or a "#" of a password in percent-encoding',
      );
    }
    if (host === undefined) {
      host = hostname;
      hostOption = "url";
    }
    if (port === undefined && urlPort !== "") port = Number(urlPort);
    if (protocol === "smtps:") secure ??= true;
    if (username !== "") {
      try {
        user = decodeURIComponent(username);
        pass = decodeURIComponent(password);
      } catch {
        throw invalid("url", "has a user or a password that is not percent-encoded");
      }
    }
  }

  const auth = options.auth;
  if (auth !== undefined) {
    if (auth === null || typeof auth !== "object" || ArrayIsArray(auth)) {
      throw invalidType("options.auth", "object", auth);
    }
    ({ user, pass, accessToken, method } = ownFields(auth, "options.auth", AUTH_NAMES, "an option"));
    if (typeof user !== "string") throw invalidType("options.auth.user", "string", user);
    if (accessToken !== undefined) {
      if (typeof accessToken !== "string") throw invalidType("options.auth.accessToken", "string", accessToken);
      if (pass !== undefined) throw invalid("options.auth", 'must have "pass" or "accessToken", not both');
    } else if (typeof pass !== "string") {
      throw invalidType("options.auth.pass", "string", pass);
    }
    if (method !== undefined) {
      validateString(method, "options.auth.method");
      const wanted = method.toUpperCase();
      if (wanted !== "PLAIN" && wanted !== "LOGIN" && wanted !== "XOAUTH2") {
        throw invalid("options.auth.method", 'must be "PLAIN", "LOGIN" or "XOAUTH2"');
      }
      if ((wanted === "XOAUTH2") !== (accessToken !== undefined)) {
        throw invalid("options.auth.method", wanted === "XOAUTH2" ? 'needs "accessToken"' : 'needs "pass"');
      }
      method = wanted;
    }
  }
  if (user !== undefined) {
    // In AUTH PLAIN a NUL separates the parts, and in XOAUTH2 a ^A does.
    for (const [part, name] of [
      [user, "user"],
      [pass, "pass"],
      [accessToken, "accessToken"],
    ] as const) {
      if (typeof part === "string" && CREDENTIAL_FORBIDDEN.test(part)) {
        throw invalid(`options.auth.${name}`, "must not contain a control character");
      }
    }
    if (user === "") throw invalid("options.auth.user", "must not be empty");
  }

  if (host === undefined) host = "localhost";
  validateString(host, hostOption);
  // An empty host would be this machine, with the credentials of a URL that names another.
  if (host === "") throw invalid(hostOption, "must not be empty");
  let address: string = host;
  // An IPv6 address in brackets, as a URL has it.
  if (address.startsWith("[") && address.endsWith("]")) address = address.slice(1, -1);
  // The value is not in the message: a URL with a password is what gets here by mistake.
  if (HOST_FORBIDDEN.test(address)) {
    throw invalid(hostOption, "is not a host name. It is a name or an address alone, without a scheme or a user");
  }

  if (secure !== undefined) validateBoolean(secure, "options.secure");
  if (port === undefined) {
    // 465 is the port that starts with TLS, 587 the one for STARTTLS (RFC 8314).
    port = secure ? 465 : 587;
  } else if (typeof port !== "number") {
    throw invalidType("options.port", "number", port);
  } else if (!NumberIsInteger(port) || port < 1 || port > 65535) {
    throw $ERR_OUT_OF_RANGE("options.port", ">= 1 and <= 65535", port);
  }
  secure ??= port === 465;

  const { requireTLS = false, ignoreTLS = false, tls, name, connectionTimeout, socketTimeout, idleTimeout } = options;
  validateBoolean(requireTLS, "options.requireTLS");
  validateBoolean(ignoreTLS, "options.ignoreTLS");
  if (requireTLS && ignoreTLS) throw invalid("options.ignoreTLS", "cannot be set together with requireTLS");

  const settings =
    tls === undefined ? ({ __proto__: null } as Fields) : ownFields(tls, "options.tls", TLS_NAMES, "an option");
  // The name the certificate is checked against is the host that the program asked for, unless
  // the options name another.
  settings.serverName ??= settings.servername ?? address;

  let hello: string;
  if (name === undefined) {
    hello = defaultName();
  } else {
    validateString(name, "options.name");
    if (name.length > MAX_TOKEN_LENGTH || (!HOST_NAME.test(name) && !DOMAIN_LITERAL.test(name))) {
      throw invalid("options.name", "is not a host name or an address literal");
    }
    hello = name;
  }

  return {
    host: address,
    port: port as number,
    secure: secure as boolean,
    requireTLS,
    ignoreTLS,
    tls: settings,
    lenient: settings.rejectUnauthorized === false,
    name: hello,
    user: user as string | undefined,
    pass: pass as string | undefined,
    accessToken: accessToken as string | undefined,
    method: method as string | undefined,
    connectionTimeout:
      connectionTimeout === undefined
        ? DEFAULT_CONNECTION_TIMEOUT
        : validateTimeout(connectionTimeout, "options.connectionTimeout", 1),
    socketTimeout:
      socketTimeout === undefined ? DEFAULT_SOCKET_TIMEOUT : validateTimeout(socketTimeout, "options.socketTimeout", 1),
    idleTimeout:
      idleTimeout === undefined ? DEFAULT_IDLE_TIMEOUT : validateTimeout(idleTimeout, "options.idleTimeout", 0),
  };
}

class SMTPClient {
  #options: ResolvedOptions;
  /**
   * The frame of the Bun.ModuleGraph that made the client, if one did. Everything the client does
   * later runs in it, whoever calls: the socket, the timers and the chain of what waits are then
   * the maker's. A graph that only used the host's client does not take the connection along when
   * it is disposed, and a connection does not keep the AsyncLocalStorage stores of the caller that
   * happened to open it.
   */
  #ownerFrame = AsyncContextFrame.currentGraphFrame();
  #connection: Connection | undefined;
  /** Settles when everything that was asked for so far is done. One thing at a time uses the connection. */
  #tail: Promise<unknown> = Promise.$resolve();
  #pending = 0;
  /** Counts what was asked for. */
  #asked = 0;
  /** The error of the last attempt to get a session, and the last request that was waiting when it failed. */
  #refusal: unknown;
  #refusedUpTo = 0;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(url?: unknown, options?: unknown) {
    this.#options = resolveOptions(url, options);
  }

  /** Whether the Bun.ModuleGraph that made the client is gone. Its connection went with it. */
  get #disposed(): boolean {
    const ownerFrame = this.#ownerFrame;
    return ownerFrame !== undefined && isFrameOfStoppedModuleGraph(ownerFrame);
  }

  /** Whether a connection to the server is open. */
  get connected(): boolean {
    return !this.#disposed && (this.#connection?.open ?? false);
  }

  /** Whether what is sent is encrypted: on the open connection, or from the first byte of the next one. */
  get secure(): boolean {
    const connection = this.#connection;
    return connection?.open ? connection.secure : this.#options.secure;
  }

  #enqueue<T>(task: (number: number) => Promise<T>): Promise<T> {
    if (this.#disposed) {
      // Nothing of a disposed graph runs again, so what is asked of its client would wait for ever.
      return Promise.$reject(
        $ERR_SMTP_CONNECTION_CLOSED(
          "The Bun.ModuleGraph that made this client was disposed, and its connection with it",
        ),
      );
    }
    return AsyncContextFrame.run(this.#ownerFrame, this.#chain, this, task) as Promise<T>;
  }

  #chain<T>(task: (number: number) => Promise<T>): Promise<T> {
    const number = ++this.#asked;
    clearTimeout(this.#idleTimer);
    // An idle connection does not keep the process alive. One with work to do does.
    if (this.#pending++ === 0) this.#connection?.ref();
    // The promise that the caller gets has no handler of the client's. A send() that nobody waits
    // for and that fails is an unhandled rejection, as it is for every other promise.
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    const done = () => {
      if (--this.#pending === 0) this.#idle();
    };
    this.#tail = this.#tail
      .then(() => task(number))
      .then(
        value => {
          done();
          resolve(value);
        },
        error => {
          done();
          reject(error);
        },
      );
    return promise;
  }

  /** Nothing waits. The connection stays for the next message, but not for long and not in the way of the process. */
  #idle() {
    const connection = this.#connection;
    if (connection === undefined) return;
    connection.unref();
    const { idleTimeout } = this.#options;
    if (idleTimeout === 0 || !connection.open) return;
    this.#idleTimer = setTimeout(() => {
      if (this.#pending > 0 || this.#connection !== connection) return;
      this.#connection = undefined;
      connection.leave();
    }, idleTimeout);
    this.#idleTimer.unref();
  }

  /** A session that is ready for MAIL FROM, and whether it has been used before. */
  async #session(number: number): Promise<{ connection: Connection; reused: boolean }> {
    // This request was waiting while an attempt failed. It gets the same answer, not an attempt
    // of its own: a server that cannot be reached would take a timeout per message, and a wrong
    // password a refused login per message.
    if (number <= this.#refusedUpTo) throw this.#refusal;
    let connection = this.#connection;
    if (connection !== undefined) {
      // The server may have closed the connection while it was idle, and only a command finds
      // that out. RSET changes nothing in a session without a transaction.
      if (connection.usable && connection.messages < MAX_MESSAGES_PER_CONNECTION) {
        try {
          const probe = MathMin(this.#options.socketTimeout, PROBE_TIMEOUT);
          if (isPositive(await connection.command("RSET", probe))) return { connection, reused: true };
        } catch {}
      }
      this.#connection = undefined;
      await connection.quit();
    }
    connection = new Connection(this.#options);
    try {
      await connection.start();
    } catch (error) {
      // Whatever it was, the socket does not stay open behind it.
      connection.fail(error);
      this.#refusal = error;
      this.#refusedUpTo = this.#asked;
      throw error;
    }
    this.#connection = connection;
    return { connection, reused: false };
  }

  send(message: unknown) {
    let draft: Draft;
    try {
      draft = validateMessage(message);
    } catch (error) {
      return Promise.$reject(error);
    }
    return this.#enqueue(async number => {
      // A message that waited while an attempt to connect failed is not read and encoded for nothing.
      if (number <= this.#refusedUpTo) throw this.#refusal;
      const data = await buildMessage(draft);
      const eightBit = draft.raw !== undefined && hasEighthBit(data);
      for (let attempt = 0; ; attempt++) {
        const { connection, reused } = await this.#session(number);
        try {
          const { accepted, rejected, response } = await connection.deliver(draft.envelope, data, draft.utf8, eightBit);
          return { messageId: draft.messageId, accepted, rejected, envelope: draft.envelope, response };
        } catch (error) {
          // The server ended a connection that had carried other messages before it took anything
          // of this one: its limit of messages, or of time. The message goes over a new
          // connection, once.
          if (!(reused && attempt === 0 && unsent.has(error as object))) throw error;
        }
      }
    });
  }

  verify() {
    return this.#enqueue(async number => {
      await this.#session(number);
      return true;
    });
  }

  close() {
    // Closed already, by the graph.
    if (this.#disposed) return Promise.$resolve();
    return this.#enqueue(async () => {
      const connection = this.#connection;
      this.#connection = undefined;
      await connection?.quit();
    });
  }

  [SymbolAsyncDispose]() {
    return this.close();
  }

  [SymbolDispose]() {
    // A graph that is gone has closed the connection already.
    this.close().catch(() => {});
  }

  [kInspect](_depth: number, options: object, inspect: Inspect) {
    const { host, port } = this.#options;
    // Never the credentials.
    return `SMTPClient ${inspect({ host, port, secure: this.secure, connected: this.connected }, options)}`;
  }
}

export default SMTPClient;
