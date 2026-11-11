import { SMTPClient } from "bun";
import { expectType } from "./utilities";

const smtp = new Bun.SMTPClient("smtp://user:password@mail.example.com:587");
expectType(smtp).is<SMTPClient>();
new SMTPClient(new URL("smtps://mail.example.com"));
new SMTPClient("smtp://mail.example.com", { requireTLS: true, tls: { rejectUnauthorized: false } });
new SMTPClient({});
new SMTPClient({
  host: "mail.example.com",
  port: 465,
  secure: true,
  auth: { user: "ada", pass: "secret" },
  name: "client.example.com",
  connectionTimeout: 10_000,
  socketTimeout: 60_000,
  idleTimeout: 0,
});
new SMTPClient("smtps://10.0.0.5", { tls: { serverName: "mail.example.com" } });
new SMTPClient("smtps://10.0.0.5", { tls: { servername: "mail.example.com" } });
new SMTPClient({ hostname: "mail.example.com", auth: { user: "ada", pass: "secret", method: "LOGIN" } });
new SMTPClient({ url: "smtp://mail.example.com", auth: { user: "ada", accessToken: "ya29.token" } });
new SMTPClient({ auth: { user: "ada", accessToken: "ya29.token", method: "XOAUTH2" }, ignoreTLS: true });

// @ts-expect-error
new SMTPClient();
// @ts-expect-error
new SMTPClient(25);
// @ts-expect-error
new SMTPClient({ port: "25" });
// @ts-expect-error
new SMTPClient({ secure: "yes" });
// @ts-expect-error
new SMTPClient({ auth: { user: "ada" } });
// @ts-expect-error
new SMTPClient({ auth: { user: "ada", pass: "secret", accessToken: "token" } });
// @ts-expect-error
new SMTPClient({ auth: { user: "ada", pass: "secret", method: "XOAUTH2" } });
// @ts-expect-error
new SMTPClient({ auth: { user: "ada", pass: "secret", method: "CRAM-MD5" } });
// @ts-expect-error
new SMTPClient({ tls: true });
// @ts-expect-error
new SMTPClient("smtp://a.example", { url: "smtp://b.example" });
// @ts-expect-error
new SMTPClient({ tls: { checkServerIdentity: () => undefined } });
// @ts-expect-error
new SMTPClient({ idleTimeout: "30s" });
// @ts-expect-error
new SMTPClient({ requireTls: true });
// @ts-expect-error
new SMTPClient({ host: "mail.example.com", pool: true });
// @ts-expect-error
new SMTPClient({ auth: { user: "ada", password: "secret" } });

expectType(smtp.connected).is<boolean>();
expectType(smtp.secure).is<boolean>();
// @ts-expect-error
smtp.connected = true;

const sent = smtp.send({
  from: "Ada Lovelace <ada@example.com>",
  to: "grace@example.org, charles@example.org",
  cc: [{ name: "Mary", address: "mary@example.org" }, "luigi@example.org"],
  bcc: { address: "archive@example.com" },
  replyTo: "support@example.com",
  subject: "Hello",
  text: "Hi",
  html: "<p>Hi</p>",
  attachments: [
    { filename: "a.txt", content: "text" },
    { filename: "b.bin", content: new Uint8Array(4) },
    { filename: "c.bin", content: new ArrayBuffer(4), contentType: "application/octet-stream" },
    { content: Bun.file("./report.pdf") },
    { path: "./report.pdf", contentDisposition: "inline" },
    { filename: "logo.png", content: new Blob([]), cid: "logo@example.com" },
    { filename: "d.txt", content: "aGk=", encoding: "base64" },
  ],
  headers: { "X-Tag": "welcome", "X-Tags": ["a", "b"] },
  date: new Date(),
  messageId: "<id@example.com>",
  inReplyTo: "<first@example.com>",
  references: ["<first@example.com>"],
  envelope: { from: "bounces@example.com", to: ["grace@example.org"] },
});
expectType(sent).is<Promise<SMTPClient.SendResult>>();
sent.then(result => {
  expectType(result.messageId).is<string | undefined>();
  expectType(result.accepted).is<string[]>();
  expectType(result.rejected).is<string[]>();
  expectType(result.envelope).is<{ from: string; to: string[] }>();
  expectType(result.response).is<string>();
});

expectType(smtp.send({ from: { name: "Ada", address: "ada@example.com" }, to: "grace@example.org" })).is<
  Promise<SMTPClient.SendResult>
>();
expectType(smtp.send({ raw: "Subject: x\r\n\r\nbody", from: "ada@example.com", to: "grace@example.org" })).is<
  Promise<SMTPClient.SendResult>
>();
smtp.send({ raw: new Uint8Array(0), envelope: { from: "ada@example.com", to: "grace@example.org" } });
smtp.send({ raw: Bun.file("./message.eml"), envelope: { from: "ada@example.com", to: ["grace@example.org"] } });
smtp.send({ raw: "Subject: x\r\n\r\nbody", envelope: { from: "", to: { address: "grace@example.org" } } });
smtp.send({
  from: "ada@example.com",
  to: "list@example.org",
  envelope: { from: { address: "bounces@example.com" }, cc: ["mary@example.org"], bcc: "archive@example.com" },
  references: "<first@example.com> <second@example.com>",
  attachments: [{ filename: "forwarded.eml", content: "Subject: x\r\n\r\nbody", contentType: "message/rfc822" }],
});

// @ts-expect-error
smtp.send();
// @ts-expect-error
smtp.send({ to: "grace@example.org", text: "no sender" });
// @ts-expect-error
smtp.send({ from: ["ada@example.com", "eve@example.com"], to: "grace@example.org" });
// @ts-expect-error
smtp.send({ from: "ada@example.com", to: 1 });
// @ts-expect-error
smtp.send({ from: "ada@example.com", to: "grace@example.org", subject: 1 });
// @ts-expect-error
smtp.send({ from: "ada@example.com", to: "grace@example.org", attachments: [{ content: 1 }] });
// @ts-expect-error
smtp.send({ from: "a@example.com", to: "b@example.org", attachments: [{ content: "x", contentDisposition: "x" }] });
// @ts-expect-error
smtp.send({ from: "ada@example.com", to: "grace@example.org", date: "2026-01-01" });
// @ts-expect-error
smtp.send({ from: "ada@example.com", to: "grace@example.org", headers: { "X-Number": 1 } });
// @ts-expect-error
smtp.send({ from: "ada@example.com", to: "grace@example.org", priority: "high" });
// @ts-expect-error
smtp.send({ from: "ada@example.com", to: "grace@example.org", html: new Uint8Array(1) });
// @ts-expect-error
smtp.send({ from: "ada@example.com", to: "grace@example.org", envelope: { sender: "bounces@example.com" } });
// @ts-expect-error
smtp.send({ from: "a@example.com", to: "b@example.org", attachments: [{ href: "https://example.com/a.txt" }] });
// @ts-expect-error
smtp.send({ raw: "Subject: x\r\n\r\nbody", from: "ada@example.com", to: "grace@example.org", subject: "y" });

expectType(smtp.verify()).is<Promise<true>>();
expectType(smtp.close()).is<Promise<void>>();

async function disposes() {
  await using client = new SMTPClient("smtp://localhost:2525");
  using other = new SMTPClient({ port: 2525 });
  try {
    await client.verify();
    await other.verify();
  } catch (cause) {
    const error = cause as SMTPClient.Error;
    expectType(error.name).is<"SMTPError">();
    expectType(error.responseCode).is<number | undefined>();
    expectType(error.response).is<string | undefined>();
    expectType(error.command).is<string | undefined>();
    expectType(error.rejected).is<string[] | undefined>();
    if (error.code === "ERR_SMTP_AUTHENTICATION_FAILED") return;
    // @ts-expect-error
    if (error.code === "ERR_SMTP_SOMETHING_ELSE") return;
  }
}
disposes;
