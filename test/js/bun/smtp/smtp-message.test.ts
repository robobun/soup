import { describe, expect, spyOn, test } from "bun:test";
import { bunEnv, bunExe, tempDir } from "harness";
import { join } from "node:path";
import { decodeBody, decodeWords, MailServer, outline, parametersOf, parseMessage, type Part } from "./mail-server";

// What Bun.SMTPClient writes: the headers and the MIME tree of a message. The session is in smtp.test.ts.

const placement = (part: Part) => parametersOf(part.headers["content-disposition"].split(";").slice(1));

describe("a message of Bun.SMTPClient", () => {
  test("text: the headers, the body and what send() reports", async () => {
    await using server = await MailServer.listen();
    await using client = new Bun.SMTPClient(server.url);

    const date = new Date("2026-11-10T12:34:56Z");
    const result = await client.send({
      from: "Ada Lovelace <ada@example.com>",
      to: "grace@example.org",
      subject: "Hello",
      text: "Hi Grace,\nthe engine works.\n",
      date,
    });

    expect(server.messages).toHaveLength(1);
    const [message] = server.messages;
    expect({ from: message.from, to: message.to }).toEqual({ from: "ada@example.com", to: ["grace@example.org"] });
    const parsed = parseMessage(message.data);
    expect(parsed.headers).toEqual({
      "from": "Ada Lovelace <ada@example.com>",
      "to": "grace@example.org",
      "subject": "Hello",
      "message-id": result.messageId,
      "date": "Tue, 10 Nov 2026 12:34:56 +0000",
      "mime-version": "1.0",
      "content-type": "text/plain; charset=utf-8",
      "content-transfer-encoding": "7bit",
    });
    expect(parsed.body).toBe("Hi Grace,\r\nthe engine works.\r\n");
    expect(result).toEqual({
      messageId: expect.stringMatching(/^<[0-9a-f-]{36}@example\.com>$/),
      accepted: ["grace@example.org"],
      rejected: [],
      envelope: { from: "ada@example.com", to: ["grace@example.org"] },
      response: "250 2.0.0 Ok: queued as 1",
    });
    // Every line of the message ends with CRLF, and none is longer than 78 characters.
    expect(message.data.replaceAll("\r\n", "")).not.toMatch(/[\r\n]/);
    expect(message.data.split("\r\n").filter(line => line.length > 78)).toEqual([]);
  });

  test("text and html are alternatives, and what is not ASCII is quoted-printable", async () => {
    await using server = await MailServer.listen();
    await using client = new Bun.SMTPClient(server.url);

    const long = Buffer.alloc(600, "é").toString() + "你好世界👩‍👩‍👧‍👦" + Buffer.alloc(300, "界").toString();
    const text = "Grüße aus Köln — 你好 👋\nline two = 2  \n" + long + "\ntab at the end\t\n";
    const html = "<p>Grüße</p>\n<p>" + Buffer.alloc(300, "x").toString() + "</p>";
    await client.send({ from: "a@example.com", to: "b@example.com", subject: "s", text, html });

    const parsed = parseMessage(server.messages[0].data);
    expect(outline(parsed)).toEqual({ "multipart/alternative": ["text/plain", "text/html"] });
    const [plain, rich] = parsed.parts;
    expect(plain.headers["content-transfer-encoding"]).toBe("quoted-printable");
    expect(plain.parameters).toEqual({ charset: "utf-8" });
    expect(decodeBody(plain).toString()).toBe(text.replaceAll("\n", "\r\n"));
    expect(decodeBody(rich).toString()).toBe(html.replaceAll("\n", "\r\n"));
    // No line of an encoded body is longer than 76 characters, and none ends with a space.
    const lines = server.messages[0].data.split("\r\n");
    expect(lines.filter(line => line.length > 76)).toEqual([]);
    expect(lines.filter(line => /[ \t]$/.test(line))).toEqual([]);
    // A soft line break does not part the bytes of one character: each line decodes alone.
    const pieces = plain.body.split("=\r\n");
    expect(pieces.length).toBeGreaterThan(30);
    const undecodable = pieces.filter(line => {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(decodeBody({ ...plain, body: line }));
        return false;
      } catch {
        return true;
      }
    });
    expect(undecodable).toEqual([]);
  });

  test("attachments are base64 parts beside the body, with a type and a file name", async () => {
    using dir = tempDir("smtp-attachments", { "notes.txt": "from a path", "data.json": '{"n":1}' });
    await using server = await MailServer.listen();
    await using client = new Bun.SMTPClient(server.url);

    const bytes = new Uint8Array(1000).map((_, i) => i % 256);
    await client.send({
      from: "a@example.com",
      to: "b@example.com",
      subject: "files",
      text: "see attached",
      attachments: [
        { filename: "hello.txt", content: "hello" },
        { filename: "bytes.bin", content: bytes },
        { filename: "photo.png", content: new Blob(["png?"]) },
        { content: Bun.file(join(String(dir), "data.json")) },
        { path: join(String(dir), "notes.txt") },
        { filename: "encoded.txt", content: "aGk=", encoding: "base64", contentType: "text/x-custom" },
        { filename: "résumé «final».pdf", content: "pdf" },
        { filename: 'quote".txt', content: new Uint16Array([0x6968]).buffer },
        { filename: "", content: new Uint8Array(0) },
      ],
    });

    const parsed = parseMessage(server.messages[0].data);
    expect(outline(parsed)).toEqual({
      "multipart/mixed": [
        "text/plain",
        "text/plain",
        "application/octet-stream",
        "image/png",
        "application/json",
        "text/plain",
        "text/x-custom",
        "application/pdf",
        "text/plain",
        "application/octet-stream",
      ],
    });
    const attachments = parsed.parts.slice(1);
    expect(attachments.map(part => part.headers["content-transfer-encoding"])).toEqual(Array(9).fill("base64"));
    expect(attachments.map(part => decodeBody(part).toString("latin1"))).toEqual([
      "hello",
      Buffer.from(bytes).toString("latin1"),
      "png?",
      '{"n":1}',
      "from a path",
      "hi",
      "pdf",
      "hi",
      "",
    ]);
    expect(attachments.map(part => part.headers["content-disposition"])).toEqual([
      'attachment; filename="hello.txt"',
      'attachment; filename="bytes.bin"',
      'attachment; filename="photo.png"',
      'attachment; filename="data.json"',
      'attachment; filename="notes.txt"',
      'attachment; filename="encoded.txt"',
      "attachment; filename*=utf-8''r%C3%A9sum%C3%A9%20%C2%ABfinal%C2%BB.pdf",
      'attachment; filename="quote\\".txt"',
      'attachment; filename=""',
    ]);
    expect(attachments[0].parameters.name).toBe("hello.txt");
    expect(decodeWords(attachments[6].parameters.name)).toBe("résumé «final».pdf");
    // 76 characters of base64 on a line.
    expect(attachments[1].body.split("\r\n").map(line => line.length)).toEqual([...Array(17).fill(76), 44]);
  });

  test("a long file name that is not ASCII is written in pieces that each hold whole characters", async () => {
    await using server = await MailServer.listen();
    await using client = new Bun.SMTPClient(server.url);

    const long = "отчёт за ноябрь — 你好世界 " + Buffer.alloc(40, "é").toString() + " 👩‍👩‍👧‍👦.pdf";
    await client.send({
      from: "a@example.com",
      to: "b@example.com",
      text: "x",
      attachments: [
        { filename: long, content: "a" },
        // A lone surrogate has no UTF-8. It becomes U+FFFD, as in a subject.
        { filename: "half \ud83d.txt", content: "b" },
        // A control character is not written into a quoted string.
        { filename: "tab\there.txt", content: "c" },
        // Text that looks like an encoded word would be decoded by the reader.
        { filename: "=?UTF-8?B?aGk=?=.txt", content: "d" },
      ],
    });

    const { data } = server.messages[0];
    expect(data.split("\r\n").filter(line => line.length > 78)).toEqual([]);
    const [first, second, third, fourth] = parseMessage(data).parts.slice(1);
    const pieces = Object.entries(placement(first));
    expect(pieces.length).toBeGreaterThan(3);
    expect(pieces.map(([name]) => name)).toEqual(pieces.map((_, i) => `filename*${i}*`));
    // Each piece is valid UTF-8 alone: some mail programs decode them one at a time.
    const decoded = pieces.map(([, value], i) => decodeURIComponent(i === 0 ? value.replace(/^utf-8''/, "") : value));
    expect(decoded.join("")).toBe(long);
    expect(decodeWords(first.parameters.name)).toBe(long);
    expect(decodeURIComponent(placement(second)["filename*"])).toBe("utf-8''half \ufffd.txt");
    expect(placement(third)).toEqual({ "filename*": "utf-8''tab%09here.txt" });
    expect(placement(fourth)).toEqual({ "filename*": "utf-8''%3D%3FUTF-8%3FB%3FaGk%3D%3F%3D.txt" });
    expect(decodeWords(fourth.parameters.name)).toBe("=?UTF-8?B?aGk=?=.txt");
  });

  test("an attachment with a cid is related to the html", async () => {
    await using server = await MailServer.listen();
    await using client = new Bun.SMTPClient(server.url);

    await client.send({
      from: "a@example.com",
      to: "b@example.com",
      text: "plain",
      html: '<img src="cid:logo@example.com">',
      attachments: [
        { filename: "logo.png", content: "png", cid: "<logo@example.com>" },
        { filename: "terms.pdf", content: "pdf" },
      ],
    });

    const parsed = parseMessage(server.messages[0].data);
    expect(outline(parsed)).toEqual({
      "multipart/mixed": [
        { "multipart/alternative": ["text/plain", { "multipart/related": ["text/html", "image/png"] }] },
        "application/pdf",
      ],
    });
    const related = parsed.parts[0].parts[1];
    // RFC 2387: the type of the part that the others belong to.
    expect(related.parameters.type).toBe("text/html");
    const logo = related.parts[1];
    expect(logo.headers["content-id"]).toBe("<logo@example.com>");
    expect(logo.headers["content-disposition"]).toBe('inline; filename="logo.png"');
  });

  test("the boundaries of a message differ where crypto.randomUUID always gives the same", async () => {
    await using server = await MailServer.listen();
    await using client = new Bun.SMTPClient(server.url);
    const spy = spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000000");
    try {
      await client.send({
        from: "a@example.com",
        to: "b@example.com",
        text: "plain",
        html: '<img src="cid:logo">',
        attachments: [
          { filename: "logo.png", content: "png", cid: "logo" },
          { filename: "terms.pdf", content: "pdf" },
        ],
      });
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }

    const { data } = server.messages[0];
    const boundaries = [...data.matchAll(/boundary="([^"]+)"/g)].map(match => match[1]);
    expect(new Set(boundaries).size).toBe(3);
    expect(outline(parseMessage(data))).toEqual({
      "multipart/mixed": [
        { "multipart/alternative": ["text/plain", { "multipart/related": ["text/html", "image/png"] }] },
        "application/pdf",
      ],
    });
  });

  test("an attached message is 7bit when the type says that it is one, and a file otherwise", async () => {
    await using server = await MailServer.listen();
    await using client = new Bun.SMTPClient(server.url);
    const eml = "From: x@example.com\nSubject: inner\n\ninner body\n";

    await client.send({
      from: "a@example.com",
      to: "b@example.com",
      text: "forwarded",
      attachments: [
        // RFC 2046, section 5.2.1: no base64 for message/rfc822.
        { filename: "inner.eml", content: eml, contentType: "message/rfc822" },
        // The type of the extension alone does not make it one.
        { filename: "file.eml", content: eml },
        { filename: "blob.eml", content: new Blob([eml], { type: "message/rfc822" }) },
      ],
    });
    const [, explicit, byName, byBlob] = parseMessage(server.messages[0].data).parts;
    expect([explicit, byName, byBlob].map(part => [part.type, part.headers["content-transfer-encoding"]])).toEqual([
      ["message/rfc822", "7bit"],
      ["application/octet-stream", "base64"],
      ["application/octet-stream", "base64"],
    ]);
    expect(explicit.body).toBe(eml.replaceAll("\n", "\r\n"));
    expect(decodeBody(byName).toString()).toBe(eml);

    // What cannot be 7bit is an error, not a message that no program can read.
    const error = await client
      .send({
        from: "a@example.com",
        to: "b@example.com",
        attachments: [{ filename: "inner.eml", content: "Subject: Grüße\n\nx", contentType: "message/rfc822" }],
      })
      .catch(error => error);
    expect(error.code).toBe("ERR_INVALID_ARG_VALUE");
    expect(error.message).toContain("must be ASCII in lines of at most 998 characters");
    expect(server.messages).toHaveLength(1);
  });

  test("headers hold what is not ASCII as encoded words, and long ones are folded", async () => {
    await using server = await MailServer.listen();
    await using client = new Bun.SMTPClient(server.url);

    const subject = "Ünïcödé 你好 👩‍👩‍👧‍👦 " + Buffer.alloc(60, "ß").toString();
    const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    const result = await client.send({
      from: { name: "José «Pepe» Núñez", address: "jose@example.com" },
      to: ['"Doe, Jane" <jane@example.com>', { name: "Łukasz", address: "lukasz@example.com" }, "plain@example.com"],
      cc: "Åsa <asa@bücher.example>",
      bcc: { name: long, address: "long@example.com" },
      replyTo: ["Support (the team) <support@example.com>", { name: long, address: "long@example.com" }],
      subject,
      text: "x",
      headers: { "X-Long": long, "X-Tags": ["a", "b"], "List-Unsubscribe": "<mailto:u@example.com>" },
    });

    const { data } = server.messages[0];
    // Only ASCII goes over the wire, in lines of at most 78 characters.
    expect(data).not.toMatch(/[^\x00-\x7f]/);
    expect(data.split("\r\n").filter(line => line.length > 78)).toEqual([]);
    // An encoded word is at most 75 characters.
    expect((data.match(/=\?UTF-8\?B\?[^?]*\?=/g) ?? []).filter(word => word.length > 75)).toEqual([]);

    const { headers } = parseMessage(data);
    expect(decodeWords(headers.subject)).toBe(subject);
    expect(decodeWords(headers.from)).toBe("José «Pepe» Núñez <jose@example.com>");
    expect(decodeWords(headers.to)).toBe(
      '"Doe, Jane" <jane@example.com>, Łukasz <lukasz@example.com>, plain@example.com',
    );
    // The domain is in its ASCII form.
    expect(decodeWords(headers.cc)).toBe("Åsa <asa@xn--bcher-kva.example>");
    // A name that is longer than a line is in encoded words, which can be cut anywhere.
    expect(decodeWords(headers["reply-to"])).toBe(`Support <support@example.com>, ${long} <long@example.com>`);
    expect(headers["x-long"]).toBe(long);
    expect(headers["list-unsubscribe"]).toBe("<mailto:u@example.com>");
    expect(data.match(/^X-Tags: .*$/gm)).toEqual(["X-Tags: a", "X-Tags: b"]);
    expect(result.envelope.to).toEqual([
      "jane@example.com",
      "lukasz@example.com",
      "plain@example.com",
      "asa@xn--bcher-kva.example",
      "long@example.com",
    ]);
  });

  test("a header arrives as it was written: white space, text like an encoded word, and a word with no place to fold", async () => {
    await using server = await MailServer.listen();
    await using client = new Bun.SMTPClient(server.url);

    // Longer than a line, with two spaces in a row, a tab, and a space at its end.
    const spaced = "a value of more than one line that has  two spaces in a row, a tab\there and a space at its end ";
    const lookalike = "=?UTF-8?B?aGk=?= is not decoded";
    const unbroken = Buffer.alloc(1200, "u").toString();
    // Headers that a program reads. It does not decode encoded words, so there must be none.
    const unsubscribe =
      "<https://example.com/unsubscribe/dXNlcjQy=?source=mail&list=7>,  <mailto:unsubscribe@example.com?subject=unsubscribe>";
    const json = '{"category":["welcome"],"unique_args":{"user":"42","name":"John  Smith","plan":"pro"}}';
    await client.send({
      // Written as it is, a mail program would show this name as "Boss".
      from: { name: "=?UTF-8?B?Qm9zcw==?=", address: "a@example.com" },
      to: [
        { name: "John  Smith", address: "b@example.com" },
        { name: 'Say "hi" \\ twice', address: "c@example.com" },
      ],
      subject: lookalike,
      text: "x",
      headers: {
        "X-Spaced": spaced,
        "X-Unbroken": unbroken,
        "X-Short": " kept ",
        "List-Unsubscribe": unsubscribe,
        "X-SMTPAPI": json,
      },
    });

    const { data } = server.messages[0];
    const head = data.slice(0, data.indexOf("\r\n\r\n"));
    // No line of a header is only white space (RFC 5322, section 3.2.2), and none is over the limit.
    expect(head.split("\r\n").filter(line => line.trim() === "" || line.length > 998)).toEqual([]);
    // What is ASCII is written as it is, and unfolding gives it back to the last space.
    const lines = head.replace(/\r\n(?=[ \t])/g, "").split("\r\n");
    expect(lines).toContain("X-Spaced: " + spaced);
    expect(lines).toContain("X-Short:  kept ");
    expect(lines).toContain("List-Unsubscribe: " + unsubscribe);
    expect(lines).toContain("X-SMTPAPI: " + json);
    // The long ones are folded, in front of their own white space.
    expect(head).toContain(
      "\r\nX-Spaced: a value of more than one line that has  two spaces in a row, a tab\r\n\there and a space at its end \r\n",
    );
    expect(head).toContain("list=7>,\r\n  <mailto:");

    const { headers } = parseMessage(data);
    expect(decodeWords(headers.subject)).toBe(lookalike);
    expect(decodeWords(headers.from)).toBe("=?UTF-8?B?Qm9zcw==?= <a@example.com>");
    // Two spaces in a row are one to whoever reads a name without quotes.
    expect(headers.to).toBe('"John  Smith" <b@example.com>, "Say \\"hi\\" \\\\ twice" <c@example.com>');
    expect(decodeWords(headers["x-unbroken"])).toBe(unbroken);
  });

  test("the lines that the client writes itself have at most 78 characters where there is a place to fold", async () => {
    await using server = await MailServer.listen();
    await using client = new Bun.SMTPClient(server.url);

    const screenshot = "Screenshot 2024-01-01 at 10.00.00 AM - quarterly report for the board (final version 2).png";
    const quoted = 'Acme "Support" Team "EMEA" \\ "Sales" "Billing" "Legal" "Ops"';
    const inReplyTo = Buffer.alloc(60, "r").toString() + "@example.com";
    const references = [Buffer.alloc(60, "f").toString() + "@example.com", "second@example.com"];
    await client.send({
      from: { name: quoted, address: "noreply@mail.notifications-example.com" },
      to: "b@example.com",
      text: "x",
      inReplyTo,
      references,
      attachments: [
        { filename: "report.docx", content: "x" },
        { filename: screenshot, content: "x" },
      ],
    });

    const { data } = server.messages[0];
    expect(data.split("\r\n").filter(line => line.length > 78)).toEqual([]);
    const { headers, parts } = parseMessage(data);
    // With its quotes and backslashes the name is longer than a line takes, so it is in encoded words.
    expect(decodeWords(headers.from)).toBe(quoted + " <noreply@mail.notifications-example.com>");
    expect(headers["message-id"]).toMatch(/^<[0-9a-f-]{36}@mail\.notifications-example\.com>$/);
    expect(headers["in-reply-to"]).toBe(`<${inReplyTo}>`);
    expect(headers.references).toBe(references.map(id => `<${id}>`).join(" "));
    expect(parts[1].type).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(parts[1].parameters.name).toBe("report.docx");
    // A long name goes the way of one that is not ASCII: in pieces.
    expect(decodeWords(parts[2].parameters.name)).toBe(screenshot);
    const pieces = Object.entries(placement(parts[2]));
    expect(pieces.map(([name]) => name)).toEqual(pieces.map((_, i) => `filename*${i}*`));
    expect(decodeURIComponent(pieces.map(([, value]) => value).join("")).replace(/^utf-8''/, "")).toBe(screenshot);
  });

  test("the type of an attachment that the caller did not name comes from the Blob or the file name, and is never an error", async () => {
    using dir = tempDir("smtp-types", { "7f3a9c": "png bytes" });
    await using server = await MailServer.listen();
    await using client = new Bun.SMTPClient(server.url);

    await client.send({
      from: "a@example.com",
      to: "b@example.com",
      text: "x",
      attachments: [
        // A file whose path says nothing, under a name that does.
        { filename: "photo.png", path: join(String(dir), "7f3a9c") },
        // What a server wrote into Content-Type is not always a media type.
        { filename: "a.png", content: new Blob(["x"], { type: "image/png, image/png" }) },
        { filename: "b", content: new Blob(["x"], { type: "unknown" }) },
        { filename: "c.txt", content: new Blob(["x"], { type: "application/octet-stream" }) },
        // A type that says something is taken over the name.
        { filename: "d.bin", content: new Blob(["x"], { type: "image/webp" }) },
      ],
    });
    expect(
      parseMessage(server.messages[0].data)
        .parts.slice(1)
        .map(part => part.type),
    ).toEqual(["image/png", "image/png", "application/octet-stream", "text/plain", "image/webp"]);
  });

  test("bcc is in the envelope and not in the headers, and an envelope can be given", async () => {
    await using server = await MailServer.listen();
    await using client = new Bun.SMTPClient(server.url);

    await client.send({
      from: "a@example.com",
      to: "b@example.com, c@example.com",
      cc: ["d@example.com", "b@example.com"],
      bcc: "hidden@example.com",
      text: "x",
    });
    await client.send({
      from: "Newsletter <news@example.com>",
      to: "list@example.com",
      envelope: { from: "bounces+123@example.com", to: ["one@example.com", "two@example.com"] },
      text: "x",
      messageId: "custom-id@example.com",
      inReplyTo: "<first@example.com>",
      references: "<first@example.com> second@example.com",
    });
    // As Nodemailer has them: cc and bcc of an envelope are recipients too.
    await client.send({
      from: "a@example.com",
      to: "shown@example.com",
      envelope: { to: "one@example.com", cc: ["two@example.com"], bcc: "three@example.com" },
      text: "x",
    });
    // The null sender of a bounce: nothing comes back to it.
    await client.send({ from: "Mailer <mailer@example.com>", to: "b@example.com", envelope: { from: "" }, text: "x" });

    const [first, second, third, fourth] = server.messages;
    // An address that is named twice gets one copy.
    expect(first.to).toEqual(["b@example.com", "c@example.com", "d@example.com", "hidden@example.com"]);
    expect(first.data).not.toContain("hidden");
    expect({ from: second.from, to: second.to }).toEqual({
      from: "bounces+123@example.com",
      to: ["one@example.com", "two@example.com"],
    });
    expect(parseMessage(second.data).headers).toMatchObject({
      "from": "Newsletter <news@example.com>",
      "to": "list@example.com",
      "message-id": "<custom-id@example.com>",
      "in-reply-to": "<first@example.com>",
      "references": "<first@example.com> <second@example.com>",
    });
    expect(third.to).toEqual(["one@example.com", "two@example.com", "three@example.com"]);
    expect(parseMessage(third.data).headers.to).toBe("shown@example.com");
    expect(fourth.from).toBe("");
    expect(server.commands.filter(command => command.startsWith("MAIL")).at(-1)).toBe("MAIL FROM:<>");
    expect(parseMessage(fourth.data).headers).toMatchObject({
      "from": "Mailer <mailer@example.com>",
      "message-id": expect.stringMatching(/@example\.com>$/),
    });
  });

  test("a line that starts with a dot arrives as it was written", async () => {
    await using server = await MailServer.listen();
    await using client = new Bun.SMTPClient(server.url);

    const text = ".\n..\n.hidden file\nend\n.";
    await client.send({ from: "a@example.com", to: "b@example.com", text });
    await client.send({ from: "a@example.com", to: "b@example.com", raw: ".starts with a dot\r\n\r\n.\r\nbody\r\n" });

    // The last line gets its line end.
    expect(parseMessage(server.messages[0].data).body).toBe(text.replaceAll("\n", "\r\n") + "\r\n");
    expect(server.messages[1].data).toBe(".starts with a dot\r\n\r\n.\r\nbody\r\n");

    // A lone CR is a line end too, in a text as in a raw message: no server may read "\r.\r" as the end of the data.
    await client.send({ from: "a@example.com", to: "b@example.com", text: "a\r.\rb\nc\r\nd", html: "<p>a\rb</p>" });
    const { data } = server.messages[2];
    expect(data.replaceAll("\r\n", "")).not.toMatch(/[\r\n]/);
    expect(parseMessage(data).parts.map(part => part.body)).toEqual(["a\r\n.\r\nb\r\nc\r\nd", "<p>a\r\nb</p>"]);
  });

  test("lines that start with a dot do not cost a write each", async () => {
    await using server = await MailServer.listen();
    await using client = new Bun.SMTPClient(server.url);
    // The class of the sockets of Bun.connect, which the client writes to.
    using listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const probe = await Bun.connect({ hostname: "127.0.0.1", port: listener.port, socket: { data() {} } });
    const write = spyOn(Object.getPrototypeOf(probe), "write");
    probe.end();

    const lines = 20_000;
    const text = Buffer.alloc(lines * 2, ".\n").toString();
    try {
      await client.send({ from: "a@example.com", to: "b@example.com", text });
      // One for each command, and a few for the data, which the socket may take in pieces.
      expect(write.mock.calls.length).toBeLessThan(50);
    } finally {
      write.mockRestore();
    }
    expect(parseMessage(server.messages[0].data).body).toBe(Buffer.alloc(lines * 3, ".\r\n").toString());
  });

  test("a raw message is sent as it is, with every line end made a CRLF", async () => {
    await using server = await MailServer.listen();
    await using client = new Bun.SMTPClient(server.url);

    // With a lone LF as a line end, the "." line would end the data for a server that takes it
    // for one, and the rest would be commands (SMTP smuggling).
    const raw = "From: a@example.com\nSubject: raw\n\nfirst\n.\nMAIL FROM:<evil@example.com>\rlone CR\r\nno end";
    const result = await client.send({ from: "a@example.com", to: "b@example.com", raw });
    await client.send({
      envelope: { from: "a@example.com", to: "c@example.com" },
      raw: new TextEncoder().encode("Subject: bytes\r\n\r\nbody\r\n"),
    });
    await client.send({ from: "a@example.com", to: "d@example.com", raw: new Blob(["Subject: blob\r\n\r\nbody"]) });

    expect(server.messages.map(message => message.data)).toEqual([
      "From: a@example.com\r\nSubject: raw\r\n\r\nfirst\r\n.\r\nMAIL FROM:<evil@example.com>\r\nlone CR\r\nno end\r\n",
      "Subject: bytes\r\n\r\nbody\r\n",
      "Subject: blob\r\n\r\nbody\r\n",
    ]);
    expect(server.messages.map(message => message.to)).toEqual([
      ["b@example.com"],
      ["c@example.com"],
      ["d@example.com"],
    ]);
    expect(server.commands.filter(command => command.startsWith("MAIL"))).toHaveLength(3);
    // The headers of a raw message are its own, so there is no ID to report.
    expect(result.messageId).toBeUndefined();
  });

  test("a raw message with bytes that are not ASCII says BODY=8BITMIME to a server that has it", async () => {
    const raw = "Subject: Grüße\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nKöln\r\n";
    const parameters: Record<string, string[]> = {};
    for (const [name, extensions] of [
      ["with 8BITMIME", ["8BITMIME", "SIZE 1000"]],
      ["without", []],
    ] as const) {
      await using server = await MailServer.listen({ extensions: [...extensions] });
      await using client = new Bun.SMTPClient(server.url);
      await client.send({ from: "a@example.com", to: "b@example.com", raw });
      await client.send({ from: "a@example.com", to: "b@example.com", raw: "Subject: ASCII\r\n\r\nbody\r\n" });
      // What this client writes itself is ASCII whatever the text is.
      await client.send({ from: "a@example.com", to: "b@example.com", subject: "Grüße", text: "Köln" });
      parameters[name] = server.messages.map(message => message.parameters);
      expect(server.messages[0].data).toBe(raw);
    }
    expect(parameters).toEqual({
      "with 8BITMIME": [`SIZE=${Buffer.byteLength(raw)} BODY=8BITMIME`, "SIZE=24", expect.stringMatching(/^SIZE=\d+$/)],
      "without": ["", "", ""],
    });
  });

  test("what is sent is what send() was called with, whatever happens to the bytes afterwards", async () => {
    await using server = await MailServer.listen();
    await using client = new Bun.SMTPClient(server.url);

    const attachment = new Uint8Array(Buffer.from("the attachment"));
    const buffer = new Uint8Array(Buffer.from("an ArrayBuffer")).buffer;
    const raw = Buffer.from("Subject: raw\r\n\r\nthe raw message\r\n");
    const first = client.send({
      from: "a@example.com",
      to: "b@example.com",
      text: "x",
      attachments: [
        { filename: "a.txt", content: attachment },
        { filename: "b.txt", content: buffer },
      ],
    });
    const second = client.send({ from: "a@example.com", to: "b@example.com", raw });
    // Before either has been written: the messages wait for the connection.
    attachment.fill(0x58);
    new Uint8Array(buffer).fill(0x58);
    raw.fill(0x58);
    await Promise.all([first, second]);

    const { parts } = parseMessage(server.messages[0].data);
    expect(parts.slice(1).map(part => decodeBody(part).toString())).toEqual(["the attachment", "an ArrayBuffer"]);
    expect(server.messages[1].data).toBe("Subject: raw\r\n\r\nthe raw message\r\n");
  });

  test("nothing of what the caller passes is called: an array with methods of its own, a Blob with a bytes() of its own", async () => {
    await using server = await MailServer.listen();
    await using client = new Bun.SMTPClient(server.url);

    // The IDs are checked one by one. What is written must be those, and not what a method of the array says.
    const references: any = ["first@example.com", "second@example.com"];
    references.map = () => ["<ok@example.com>\r\n\r\nan injected body"];
    references.join = () => "<ok@example.com>\r\nBcc: victim@example.com";
    class Other extends Blob {
      async bytes() {
        return new TextEncoder().encode("Subject: other\n\nfirst\n.\nMAIL FROM:<victim@example.com>\n");
      }
    }
    await client.send({ from: "a@example.com", to: "b@example.com", text: "x", references });
    await client.send({
      from: "a@example.com",
      to: "b@example.com",
      raw: new Other(["Subject: mine\r\n\r\nbody\r\n"]),
    });
    await client.send({
      from: "a@example.com",
      to: "b@example.com",
      text: "x",
      attachments: [{ filename: "a.txt", content: new Other(["the attachment"]) }],
    });

    const [first, second, third] = server.messages;
    expect(parseMessage(first.data).headers.references).toBe("<first@example.com> <second@example.com>");
    expect(second.data).toBe("Subject: mine\r\n\r\nbody\r\n");
    expect(decodeBody(parseMessage(third.data).parts[1]).toString()).toBe("the attachment");
    expect(server.messages.map(received => received.data).join("")).not.toMatch(/victim|injected/);
  });

  test("a program that has replaced Date still sends mail, with the time that its Date.now() gives", async () => {
    await using server = await MailServer.listen();
    await using proc = Bun.spawn({
      cmd: [
        bunExe(),
        "-e",
        `globalThis.Date = class { static now() { return 86_400_000; } };
         const client = new Bun.SMTPClient(process.argv[1]);
         const result = await client.send({ from: "a@example.com", to: "b@example.com", text: "x" });
         console.log(result.response);
         await client.close();`,
        server.url,
      ],
      env: bunEnv,
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect({ stdout, stderr, exitCode }).toEqual({ stdout: "250 2.0.0 Ok: queued as 1\n", stderr: "", exitCode: 0 });
    expect(parseMessage(server.messages[0].data).headers.date).toBe("Fri, 02 Jan 1970 00:00:00 +0000");
  });

  test("the date is the time of the Date object, not what its methods say", async () => {
    await using server = await MailServer.listen();
    await using client = new Bun.SMTPClient(server.url);

    const date = new Date("2026-01-02T03:04:05Z");
    date.toUTCString = () => "Fri, 02 Jan 2026 03:04:05 GMT\r\nBcc: victim@example.com";
    date.getTime = () => 0;
    await client.send({ from: "a@example.com", to: "b@example.com", text: "x", date });

    const { data } = server.messages[0];
    expect(parseMessage(data).headers.date).toBe("Fri, 02 Jan 2026 03:04:05 +0000");
    expect(data).not.toContain("victim");
  });

  test("a line break in an address, a header or a file name is an error, and nothing is sent", async () => {
    await using server = await MailServer.listen();
    await using client = new Bun.SMTPClient(server.url);
    const good = { from: "a@example.com", to: "b@example.com", text: "x" };
    // Characters whose low byte is a CR, an LF, a colon or a space: nothing of them is a line
    // break, and a conversion that kept one byte of each would make them one.
    const low = (text: string) => Array.from(text, c => String.fromCharCode(c.charCodeAt(0) + 0x100)).join("");
    const smuggled = "x" + low("\r\nBcc: victim@example.com\r\nX:") + "@example.com";
    const ascii = { from: "bounces@example.com", to: "owner@example.com" };

    const bad: Record<string, object> = {
      "subject": { subject: "Hi\r\nBcc: victim@example.com" },
      "subject with a lone LF": { subject: "Hi\nBcc: victim@example.com" },
      "subject with a lone CR": { subject: "Hi\rBcc: victim@example.com" },
      "from": { from: "a@example.com\r\nRCPT TO:<victim@example.com>" },
      "name of from": { from: { name: "A\nBcc: victim@example.com", address: "a@example.com" } },
      "name of from with a lone CR": { from: { name: "A\rBcc: victim@example.com", address: "a@example.com" } },
      "to": { to: "b@example.com>\r\nDATA" },
      "to with a space": { to: "<b@example.com> SIZE=1>" },
      "to in brackets": { to: "B <b@example.com\n>" },
      "text after an address": { to: '<b@example.com> "B"' },
      "two addresses in brackets": { to: "<b@example.com> <c@example.com>" },
      "envelope": { envelope: { from: "a@example.com> BODY=8BITMIME" } },
      "header value": { headers: { "X-Test": "1\r\nSubject: injected" } },
      "header value with a lone CR": { headers: { "X-Test": "1\rSubject: injected" } },
      "header name": { headers: { "X-Test\r\nSubject": "1" } },
      "header name with a colon": { headers: { "X-Test: 1\r\nSubject": "1" } },
      "reserved header": { headers: { "Content-Type": "text/html" } },
      "file name": { attachments: [{ filename: 'a.txt"\r\nContent-Type: text/html', content: "x" }] },
      "file name with a lone CR": { attachments: [{ filename: "a.txt\rX-Evil: 1", content: "x" }] },
      "content type": { attachments: [{ filename: "a.txt", content: "x", contentType: "text/plain\r\nX-Evil: 1" }] },
      "content type with a parameter": {
        attachments: [{ filename: "a.txt", content: "x", contentType: "text/plain\r\nX-Evil: 1;\r\n\r\nbody" }],
      },
      "content type with a wide space": {
        attachments: [{ filename: "a.txt", content: "x", contentType: "text/plain\u2028; charset=utf-8" }],
      },
      "content type that holds parts": { attachments: [{ content: "x", contentType: "multipart/mixed" }] },
      "content id": { attachments: [{ filename: "a.png", content: "x", cid: "a>\r\nX-Evil: 1" }] },
      "message id": { messageId: "<a@example.com>\r\nX-Evil: 1" },
      "quoted local part": { to: '"a b"@example.com' },
      "two addresses in from": { from: "a@example.com, c@example.com" },
      "no recipient": { to: [] },
      "no recipient in the envelope": { envelope: { to: [] } },
      "NUL": { subject: "a\0b" },
      "an address of a megabyte": { to: Buffer.alloc(1 << 20, "a").toString() + "-@example.com" },
      // What is not ASCII is only for the envelope, also when an envelope is given.
      "from that is not ASCII": { from: smuggled },
      "from that is not ASCII, with an envelope": { from: smuggled, envelope: ascii },
      "to that is not ASCII, with an envelope": { to: smuggled, envelope: ascii },
      "cc that is not ASCII, with an envelope": { cc: "Name <" + smuggled + ">", envelope: ascii },
      "reply-to that is not ASCII, with an envelope": { replyTo: smuggled, envelope: ascii },
      "a lone surrogate in an address": { envelope: { to: "a\ud800b@example.com" } },
      // Dots where a parser of the header would stop.
      "two dots": { to: "a..b@example.com" },
      "a dot at the start": { to: ".a@example.com" },
      "a dot at the end": { to: "a.@example.com" },
      "a dot after the domain": { to: "a@example.com." },
      // What has to fit on a line in one piece.
      "a long message id": { messageId: Buffer.alloc(300, "i").toString() + "@example.com" },
      "a long content id": { attachments: [{ content: "x", cid: Buffer.alloc(300, "c").toString() }] },
      "a long header name": { headers: { ["X-" + Buffer.alloc(100, "n").toString()]: "1" } },
      "a long content type": {
        attachments: [{ content: "x", contentType: "text/" + Buffer.alloc(300, "t").toString() }],
      },
      // What a terminal or a mail program would read as something else than it is.
      "an escape sequence in a message id": { messageId: "a\x1b[31m@example.com" },
      "a tab in a message id": { inReplyTo: "a\tb@example.com" },
      "a DEL in a content id": { attachments: [{ content: "x", cid: "a\x7fb@example.com" }] },
      "a control character in a reference": { references: ["a@example.com", "b\x01@example.com"] },
      "a message id like an encoded word": { messageId: "=?UTF-8?B?aGk=?=@example.com" },
      "a reference like an encoded word": { references: "a@example.com =?UTF-8?Q?hi?=@example.com" },
      "a content id like an encoded word": { attachments: [{ content: "x", cid: "=?UTF-8?B?aGk=?=" }] },
      "a local part like an encoded word": { to: "=?UTF-8?Q?victim?=@example.com" },
    };
    const codes: Record<string, unknown> = {};
    for (const [name, fields] of Object.entries(bad)) {
      codes[name] = await client.send({ ...good, ...fields } as never).then(
        () => "sent",
        error => `${error.name} ${error.code}`,
      );
    }
    expect(codes).toEqual(Object.fromEntries(Object.keys(bad).map(name => [name, "TypeError ERR_INVALID_ARG_VALUE"])));
    // Not even a connection was made.
    expect(server.sessions).toEqual([]);
  });

  test("a field that is not known is an error, not something left out of the message", async () => {
    const client = new Bun.SMTPClient("smtp://127.0.0.1:1");
    const good = { from: "a@example.com", to: "b@example.com", text: "x" };
    const messages: Record<string, unknown> = {};
    for (const [name, message] of Object.entries({
      "a field of Nodemailer": { ...good, priority: "high" },
      "a misspelt field": { ...good, subjct: "Hello" },
      "a field next to raw": { from: "a@example.com", to: "b@example.com", raw: "Subject: x\r\n\r\nx", subject: "y" },
      "a field of an attachment": { ...good, attachments: [{ filename: "a.txt", href: "https://example.com/a.txt" }] },
      "a field of an envelope": { ...good, envelope: { sender: "a@example.com" } },
      "a field of an address": { ...good, to: { address: "b@example.com", group: [] } },
    })) {
      messages[name] = await client.send(message as never).then(
        () => "sent",
        error => `${error.code}: ${error.message}`,
      );
    }
    expect(messages).toEqual({
      "a field of Nodemailer":
        "ERR_INVALID_ARG_VALUE: The property 'message.priority' is not a field of a message. The fields are: from, to, cc, bcc, replyTo, subject, text, html, attachments, headers, date, messageId, inReplyTo, references, envelope, raw",
      "a misspelt field":
        "ERR_INVALID_ARG_VALUE: The property 'message.subjct' is not a field of a message. The fields are: from, to, cc, bcc, replyTo, subject, text, html, attachments, headers, date, messageId, inReplyTo, references, envelope, raw",
      "a field next to raw": `ERR_INVALID_ARG_VALUE: The property 'message.subject' cannot be set next to "raw", which can have: raw, from, to, cc, bcc, envelope`,
      "a field of an attachment":
        "ERR_INVALID_ARG_VALUE: The property 'message.attachments[0].href' is not a field of an attachment. The fields are: filename, content, path, encoding, contentType, cid, contentDisposition",
      "a field of an envelope":
        "ERR_INVALID_ARG_VALUE: The property 'message.envelope.sender' is not a field of an envelope. The fields are: from, to, cc, bcc",
      "a field of an address":
        "ERR_INVALID_ARG_VALUE: The property 'message.to.group' is not a field of an address. The fields are: name, address",
    });
  });

  test("an error about a message does not repeat the message", async () => {
    const client = new Bun.SMTPClient("smtp://127.0.0.1:1");
    const secret = "the text of the message, which is nobody's business";
    const errors: string[] = [];
    for (const message of [
      { from: "a@example.com", text: secret, html: secret },
      { from: "a@example.com", to: "b@example.com", text: secret, envelope: { to: [] } },
      { to: "b@example.com", text: secret },
      { from: "a@example.com", to: "b@example.com", text: secret, attachments: [{ filename: secret }] },
    ]) {
      const error = await client.send(message as never).catch(error => error);
      errors.push(`${error.code}: ${error.message}`);
    }
    expect(errors.filter(text => text.includes("nobody's business"))).toEqual([]);
    expect(errors).toEqual([
      `ERR_INVALID_ARG_VALUE: The property 'message.to' is required, unless "cc", "bcc" or "envelope.to" has a recipient`,
      "ERR_INVALID_ARG_VALUE: The property 'message.envelope.to' has no recipient",
      "ERR_INVALID_ARG_VALUE: The property 'message.from' is required",
      `ERR_INVALID_ARG_VALUE: The property 'message.attachments[0]' must have "content" or "path"`,
    ]);
  });

  test("arguments of the wrong type are TypeErrors", async () => {
    const client = new Bun.SMTPClient("smtp://127.0.0.1:1");
    const good = { from: "a@example.com", to: "b@example.com", text: "x" };
    const bad: Record<string, unknown> = {
      "no message": undefined,
      "a message that is a string": "hello",
      "text": { ...good, text: 1 },
      "html": { ...good, html: Buffer.from("<p>x</p>") },
      "subject": { ...good, subject: Symbol("s") },
      "to": { ...good, to: 1 },
      "attachments": { ...good, attachments: {} },
      "attachment": { ...good, attachments: ["file.txt"] },
      "attachment content": { ...good, attachments: [{ filename: "a", content: 1 }] },
      "date": { ...good, date: "2026-01-01" },
      "headers": { ...good, headers: [] },
      "envelope": { ...good, envelope: "a@example.com" },
      // A hole is not an ID, and is not a line of white space in the header either.
      "references with a hole": {
        ...good,
        references: Object.assign(Array(3), { 0: "a@example.com", 2: "c@example.com" }),
      },
    };
    const names: Record<string, unknown> = {};
    for (const [name, message] of Object.entries(bad)) {
      names[name] = await client.send(message as never).then(
        () => "sent",
        error => `${error.name} ${error.code}`,
      );
    }
    expect(names).toEqual(Object.fromEntries(Object.keys(bad).map(name => [name, "TypeError ERR_INVALID_ARG_TYPE"])));
  });

  test("a field is read once, and nothing of Object.prototype is a field", async () => {
    await using server = await MailServer.listen();
    await using client = new Bun.SMTPClient(server.url);

    let reads = 0;
    const message = {
      from: "a@example.com",
      get to() {
        // A second read would get another address than the one that was checked.
        return reads++ === 0 ? "b@example.com" : "victim@example.com";
      },
      text: "x",
    };
    const prototype = Object.prototype as Record<string, unknown>;
    const polluted = {
      bcc: "victim@example.com",
      cc: "victim@example.com",
      envelope: { to: "victim@example.com" },
      headers: { "X-Polluted": "1" },
      address: "victim@example.com",
      name: "Victim",
      cid: "polluted@example.com",
      contentType: "text/x-polluted",
      "X-Polluted": "1",
    };
    Object.assign(prototype, polluted);
    try {
      await client.send(message);
      await client.send({ from: { address: "a@example.com" }, to: [{ address: "b@example.com" }], text: "x" });
      // The objects inside a message: an envelope with a sender alone, an attachment, and headers.
      await client.send({
        from: { address: "a@example.com" },
        to: "b@example.com",
        envelope: { from: "bounces@example.com" },
        headers: { "X-Mine": "1" },
        html: "<p>x</p>",
        attachments: [{ filename: "a.txt", content: "x" }],
      });
    } finally {
      for (const name of Object.keys(polluted)) delete prototype[name];
    }
    expect(reads).toBe(1);
    expect(server.messages.map(received => received.to)).toEqual(Array(3).fill(["b@example.com"]));
    expect(server.messages.map(received => received.data).join("")).not.toMatch(/victim|polluted/i);
    expect(server.messages[2].from).toBe("bounces@example.com");
  });

  test("an object that has its fields on a prototype is an error, not a message without them", async () => {
    const client = new Bun.SMTPClient("smtp://127.0.0.1:1");
    const good = { from: "a@example.com", to: "b@example.com", text: "x" };
    class Envelope {
      get from() {
        return "bounces@example.com";
      }
      get to() {
        return "real-recipient@example.com";
      }
    }
    const template = { subject: "Your invoice", bcc: "accounting@example.com" };
    const errors: Record<string, unknown> = {};
    for (const [name, message] of Object.entries({
      "a message that inherits": Object.assign(Object.create(template), good),
      "a message that is an instance": Object.assign(new (class Mail {})(), good),
      "headers of the web": { ...good, headers: new Headers({ "X-Tenant": "1" }) },
      "headers in a Map": { ...good, headers: new Map([["X-Tenant", "1"]]) },
      "an envelope with getters": { ...good, envelope: new Envelope() },
      "an address that inherits": { ...good, to: Object.create({ address: "b@example.com" }) },
      "an attachment that inherits": { ...good, attachments: [Object.create({ content: "x" })] },
    })) {
      errors[name] = await client.send(message as never).then(
        () => "sent",
        error => `${error.code}: ${error.message}`,
      );
    }
    const reason =
      "must be a plain object. What an instance of a class has, or an object that inherits from another, is not read";
    expect(errors).toEqual({
      "a message that inherits": `ERR_INVALID_ARG_VALUE: The argument 'message' ${reason}`,
      "a message that is an instance": `ERR_INVALID_ARG_VALUE: The argument 'message' ${reason}`,
      "headers of the web": `ERR_INVALID_ARG_VALUE: The property 'message.headers' ${reason}`,
      "headers in a Map": `ERR_INVALID_ARG_VALUE: The property 'message.headers' ${reason}`,
      "an envelope with getters": `ERR_INVALID_ARG_VALUE: The property 'message.envelope' ${reason}`,
      "an address that inherits": `ERR_INVALID_ARG_VALUE: The property 'message.to' ${reason}`,
      "an attachment that inherits": `ERR_INVALID_ARG_VALUE: The property 'message.attachments[0]' ${reason}`,
    });
  });
});
