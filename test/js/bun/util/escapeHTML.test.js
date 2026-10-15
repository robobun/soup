import { escapeHTML, unescapeHTML } from "bun";
import { describe, expect, it } from "bun:test";

describe("escapeHTML", () => {
  // The matrix of cases we need to test for:
  // 1. Works with short strings
  // 2. Works with long strings
  // 3. Works with latin1 strings
  // 4. Works with utf16 strings
  // 5. Works when the text to escape is somewhere in the middle
  // 6. Works when the text to escape is in the beginning
  // 7. Works when the text to escape is in the end
  // 8. Returns the same string when there's no need to escape
  it("works", () => {
    expect(escapeHTML("absolutely nothing to do here")).toBe("absolutely nothing to do here");
    expect(escapeHTML("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(escapeHTML("<")).toBe("&lt;");
    expect(escapeHTML(">")).toBe("&gt;");
    expect(escapeHTML("&")).toBe("&amp;");
    expect(escapeHTML("'")).toBe("&#x27;");
    expect(escapeHTML('"')).toBe("&quot;");
    expect(escapeHTML("\n")).toBe("\n");
    expect(escapeHTML("\r")).toBe("\r");
    expect(escapeHTML("\t")).toBe("\t");
    expect(escapeHTML("\f")).toBe("\f");
    expect(escapeHTML("\v")).toBe("\v");
    expect(escapeHTML("\b")).toBe("\b");
    expect(escapeHTML("\u00A0")).toBe("\u00A0");
    expect(escapeHTML("<script>ab")).toBe("&lt;script&gt;ab");
    expect(escapeHTML("<script>")).toBe("&lt;script&gt;");
    expect(escapeHTML("<script><script>")).toBe("&lt;script&gt;&lt;script&gt;");

    expect(escapeHTML("lalala" + "<script>alert(1)</script>" + "lalala")).toBe(
      "lalala&lt;script&gt;alert(1)&lt;/script&gt;lalala",
    );

    expect(escapeHTML("<script>alert(1)</script>" + "lalala")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;lalala");
    expect(escapeHTML("lalala" + "<script>alert(1)</script>")).toBe("lalala" + "&lt;script&gt;alert(1)&lt;/script&gt;");

    expect(escapeHTML("What does 😊 mean?")).toBe("What does 😊 mean?");
    const output = escapeHTML("<What does 😊");
    expect(output).toBe("&lt;What does 😊");
    expect(escapeHTML("<div>What does 😊 mean in text?")).toBe("&lt;div&gt;What does 😊 mean in text?");

    expect(escapeHTML(("lalala" + "<script>alert(1)</script>" + "lalala").repeat(900))).toBe(
      "lalala&lt;script&gt;alert(1)&lt;/script&gt;lalala".repeat(900),
    );
    expect(escapeHTML(("<script>alert(1)</script>" + "lalala").repeat(900))).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;lalala".repeat(900),
    );
    expect(escapeHTML(("lalala" + "<script>alert(1)</script>").repeat(900))).toBe(
      ("lalala" + "&lt;script&gt;alert(1)&lt;/script&gt;").repeat(900),
    );

    // the positions of the unicode codepoint are important
    // our simd code for U16 is at 8 bytes, so we need to especially check the boundaries
    expect(escapeHTML("😊lalala" + "<script>alert(1)</script>" + "lalala")).toBe(
      "😊lalala&lt;script&gt;alert(1)&lt;/script&gt;lalala",
    );
    expect(escapeHTML("<script>😊alert(1)</script>" + "lalala")).toBe("&lt;script&gt;😊alert(1)&lt;/script&gt;lalala");
    expect(escapeHTML("<script>alert(1)😊</script>" + "lalala")).toBe("&lt;script&gt;alert(1)😊&lt;/script&gt;lalala");
    expect(escapeHTML("<script>alert(1)</script>" + "😊lalala")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;😊lalala");
    expect(escapeHTML("<script>alert(1)</script>" + "lal😊ala")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;lal😊ala");
    expect(escapeHTML("<script>alert(1)</script>" + "lal😊ala".repeat(10))).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;" + "lal😊ala".repeat(10),
    );

    for (let i = 1; i < 10; i++)
      expect(escapeHTML("<script>alert(1)</script>" + "la😊".repeat(i))).toBe(
        "&lt;script&gt;alert(1)&lt;/script&gt;" + "la😊".repeat(i),
      );

    expect(escapeHTML("la😊" + "<script>alert(1)</script>")).toBe("la😊" + "&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(escapeHTML(("lalala" + "<script>alert(1)</script>😊").repeat(1))).toBe(
      ("lalala" + "&lt;script&gt;alert(1)&lt;/script&gt;😊").repeat(1),
    );

    expect(escapeHTML("😊".repeat(100))).toBe("😊".repeat(100));
    expect(escapeHTML("😊<".repeat(100))).toBe("😊&lt;".repeat(100));
    expect(escapeHTML("<😊>".repeat(100))).toBe("&lt;😊&gt;".repeat(100));
    expect(escapeHTML("😊")).toBe("😊");
    expect(escapeHTML("😊😊")).toBe("😊😊");
    expect(escapeHTML("😊lo")).toBe("😊lo");
    expect(escapeHTML("lo😊")).toBe("lo😊");

    expect(escapeHTML(" ".repeat(32) + "😊")).toBe(" ".repeat(32) + "😊");
    expect(escapeHTML(" ".repeat(32) + "😊😊")).toBe(" ".repeat(32) + "😊😊");
    expect(escapeHTML(" ".repeat(32) + "😊lo")).toBe(" ".repeat(32) + "😊lo");
    expect(escapeHTML(" ".repeat(32) + "lo😊")).toBe(" ".repeat(32) + "lo😊");
  });

  it("bad input doesn't crash", () => {
    escapeHTML("a".repeat(512) + String.fromCodePoint(0xd800));

    for (let i = 0; i < 768; i++) {
      escapeHTML("\xff" + "a".repeat(i));
      escapeHTML(String.fromCodePoint(0xd800) + "a".repeat(i));
      escapeHTML("a".repeat(i) + String.fromCodePoint(0xd800));
      escapeHTML(String.fromCodePoint(0xd800).repeat(i));
      escapeHTML("\xff" + String.fromCodePoint(0xd800).repeat(i));
      escapeHTML("\xff".repeat(i) + String.fromCodePoint(0xd800));
      escapeHTML(String.fromCodePoint(0xd800) + "\xff".repeat(i));
    }
  });

  it("escapes metacharacters adjacent to lone surrogates", () => {
    expect(escapeHTML("\uD800<x")).toBe("\uD800&lt;x");
    expect(escapeHTML("\uD800>x")).toBe("\uD800&gt;x");
    expect(escapeHTML("\uD800<img src=x onerror=alert(1)\uD800>")).toBe(
      "\uD800&lt;img src=x onerror=alert(1)\uD800&gt;",
    );
    expect(escapeHTML(("\uD800<" + "a".repeat(14)).repeat(8))).toBe(("\uD800&lt;" + "a".repeat(14)).repeat(8));
    expect(escapeHTML("\uD800a😊<b")).toBe("\uD800a😊&lt;b");
  });

  it("fuzz latin1", () => {
    for (let i = 0; i < 256; i++) {
      const initial = Buffer.alloc(i + 1, "a");
      for (let j = 0; j < i; j++) {
        const clone = Buffer.from(initial);
        clone[j] = ">".charCodeAt(0);
        Bun.escapeHTML(clone.toString());
      }
    }
  });

  it("fuzz utf16", () => {
    for (let i = 0; i < 256; i++) {
      const initial = new Uint16Array(i);
      initial.fill("a".charCodeAt(0));

      for (let j = 0; j < i; j++) {
        const clone = Buffer.from(initial);
        clone[j] = ">".charCodeAt(0);
        Bun.escapeHTML(clone.toString("utf16le"));
      }
    }
  });

  it("escapes every metacharacter", () => {
    expect(escapeHTML(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#x27;");
    // attribute-value metacharacters, as used by SSR
    expect(escapeHTML(`<a href="/x?a=1&b=2" title='it\\'s'>`)).toBe(
      "&lt;a href=&quot;/x?a=1&amp;b=2&quot; title=&#x27;it\\&#x27;s&#x27;&gt;",
    );
  });

  it("coerces non-string arguments", () => {
    expect(escapeHTML(123)).toBe("123");
    expect(escapeHTML(true)).toBe("true");
    expect(escapeHTML(false)).toBe("false");
    expect(escapeHTML(null)).toBe("null");
    expect(escapeHTML(undefined)).toBe("undefined");
    expect(escapeHTML({ toString: () => "<b>hi</b>" })).toBe("&lt;b&gt;hi&lt;/b&gt;");
    expect(escapeHTML([1, 2, 3])).toBe("1,2,3");
    // a symbol cannot be coerced to a string — the thrown exception must propagate
    expect(() => escapeHTML(Symbol.iterator)).toThrow("Cannot convert a symbol to a string");
  });

  it("returns the same string when nothing is escaped", () => {
    const latin1 = Buffer.alloc(64, "a").toString();
    expect(escapeHTML(latin1)).toBe(latin1);
    // utf16-backed, no metacharacters
    const utf16 = "café ☕ ".repeat(16);
    expect(escapeHTML(utf16)).toBe(utf16);
  });

  it("handles escapes at SIMD lane boundaries", () => {
    // the SIMD scan steps in lanes of 16 (latin1) and 8/16 (utf16); put a
    // metacharacter at each offset around those boundaries, as a prefix,
    // in the middle, and as a suffix.
    for (const width of [7, 8, 9, 15, 16, 17, 31, 32, 33, 63, 64, 65]) {
      for (let pos = 0; pos < width; pos++) {
        const latin1 = Buffer.alloc(width, "a");
        latin1[pos] = "<".charCodeAt(0);
        const expectedLatin1 = "a".repeat(pos) + "&lt;" + "a".repeat(width - pos - 1);
        expect(escapeHTML(latin1.toString("latin1"))).toBe(expectedLatin1);

        const u16 = new Uint16Array(width).fill("a".charCodeAt(0));
        u16[pos] = "<".charCodeAt(0);
        // force a utf16 backing store with a non-latin1 codepoint at the end
        const utf16Input = Buffer.from(u16.buffer).toString("utf16le") + "☕";
        const expectedUtf16 = "a".repeat(pos) + "&lt;" + "a".repeat(width - pos - 1) + "☕";
        expect(escapeHTML(utf16Input)).toBe(expectedUtf16);
      }
    }
  });

  it("handles densely packed escapes", () => {
    expect(escapeHTML("<".repeat(100))).toBe("&lt;".repeat(100));
    expect(escapeHTML("<>".repeat(100))).toBe("&lt;&gt;".repeat(100));
    expect(escapeHTML(`&<>"'`.repeat(50))).toBe("&amp;&lt;&gt;&quot;&#x27;".repeat(50));
  });
});

describe("unescapeHTML", () => {
  it("decodes named, decimal and hexadecimal references", () => {
    expect(unescapeHTML("&lt;p&gt;Tom &amp; Jerry&lt;/p&gt;")).toBe("<p>Tom & Jerry</p>");
    expect(unescapeHTML("&quot;&apos;&#39;&#x27;&#X27;")).toBe(`"''''`);
    expect(unescapeHTML("caf&eacute; &#9749; &#x2615; &copy; 2026")).toBe("café ☕ ☕ © 2026");
    expect(unescapeHTML("&hearts;&nbsp;&euro;&mdash;&hellip;")).toBe("♥\u00A0€—…");
    // the longest name there is
    expect(unescapeHTML("&CounterClockwiseContourIntegral;")).toBe("∳");
    // names are case-sensitive
    expect(unescapeHTML("&Eacute;&eacute;&AMP;&Amp;&LT;&Lt;")).toBe("Éé&&Amp;<≪");
    // one name, two code points
    expect(unescapeHTML("&NotEqualTilde;&fjlig;")).toBe("\u2242\u0338fj");
    // outside the BMP
    expect(unescapeHTML("&Afr;&#x1F600;&#128512;")).toBe("\u{1D504}😀😀");
  });

  it("leaves what is not a reference alone", () => {
    const texts = [
      "",
      "plain text",
      "a & b",
      "AT&T",
      "&",
      "&&",
      "&;",
      "& amp;",
      "&am;",
      "&bogus;",
      "&Amp;",
      "&#;",
      "&#x;",
      "&#xg;",
      "&#-1;",
      "&# 38;",
      "&\u00e9;",
      "&😊;",
      "trailing &",
    ];
    for (const text of texts) expect(unescapeHTML(text)).toBe(text);
  });

  it("takes the names of HTML 4 without their semicolon", () => {
    expect(unescapeHTML("&amp")).toBe("&");
    expect(unescapeHTML("&lt&gt&quot&amp")).toBe(`<>"&`);
    expect(unescapeHTML("&copy 2026 &reg&trade")).toBe("© 2026 ®&trade");
    expect(unescapeHTML("&frac12cup &sup2")).toBe("½cup ²");
    // the longest name wins, and what follows it is text
    expect(unescapeHTML("&notin; &notit; &not;")).toBe("∉ ¬it; ¬");
    expect(unescapeHTML("&ampere; &ltimes; &ltfoo")).toBe("&ere; ⋉ <foo");
    // the other names need it
    expect(unescapeHTML("&hearts &euro &apos &trade")).toBe("&hearts &euro &apos &trade");

    const html4 = (
      "AElig AMP Aacute Acirc Agrave Aring Atilde Auml COPY Ccedil ETH Eacute Ecirc Egrave Euml GT Iacute " +
      "Icirc Igrave Iuml LT Ntilde Oacute Ocirc Ograve Oslash Otilde Ouml QUOT REG THORN Uacute Ucirc " +
      "Ugrave Uuml Yacute aacute acirc acute aelig agrave amp aring atilde auml brvbar ccedil cedil cent " +
      "copy curren deg divide eacute ecirc egrave eth euml frac12 frac14 frac34 gt iacute icirc iexcl " +
      "igrave iquest iuml laquo lt macr micro middot nbsp not ntilde oacute ocirc ograve ordf ordm oslash " +
      "otilde ouml para plusmn pound quot raquo reg sect shy sup1 sup2 sup3 szlig thorn times uacute ucirc " +
      "ugrave uml uuml yacute yen yuml"
    ).split(" ");
    expect(html4).toHaveLength(106);
    for (const name of html4) {
      const decoded = unescapeHTML(`&${name};`);
      expect(decoded).not.toBe(`&${name};`);
      expect(unescapeHTML(`&${name}`)).toBe(decoded);
      expect(unescapeHTML(`&${name} &${name}x`)).toBe(`${decoded} ${decoded}x`);
    }
  });

  it("reads numeric references the way HTML does", () => {
    expect(unescapeHTML("&#65;&#x41;&#X41;&#x4a;&#x4A;&#0065;")).toBe("AAAJJA");
    // not a code point
    expect(unescapeHTML("&#0;&#x0;")).toBe("\uFFFD\uFFFD");
    expect(unescapeHTML("&#xD800;&#xDFFF;&#x110000;&#99999999999999999999;&#xFFFFFFFFFFFFFFFFF;")).toBe(
      "\uFFFD".repeat(5),
    );
    expect(unescapeHTML("&#x10FFFF;&#xD7FF;&#xE000;")).toBe("\u{10FFFF}\uD7FF\uE000");
    // the C1 controls are Windows-1252
    expect(unescapeHTML("&#128;&#x85;&#145;&#146;&#147;&#148;&#150;&#151;&#153;&#159;")).toBe("€…‘’“”–—™Ÿ");
    expect(unescapeHTML("&#129;&#x8D;&#143;&#144;&#157;")).toBe("\x81\x8D\x8F\x90\x9D");
    // the semicolon can be left out
    expect(unescapeHTML("&#38&#x26&#38x&#x26g&#38")).toBe("&&&x&g&");
  });

  it("attribute: true leaves the `&name=` of a query string alone", () => {
    const href = "/search?q=1&copy=2&amp;lang=en&lt=3&reg2&not";
    expect(unescapeHTML(href)).toBe("/search?q=1©=2&lang=en<=3®2¬");
    expect(unescapeHTML(href, { attribute: true })).toBe("/search?q=1&copy=2&lang=en&lt=3&reg2¬");
    expect(unescapeHTML(href, { attribute: false })).toBe(unescapeHTML(href));
    expect(unescapeHTML(href, {})).toBe(unescapeHTML(href));
    // a name with its semicolon and a numeric reference are references everywhere
    expect(unescapeHTML("&copy;=&#38=&#38a&notin;", { attribute: true })).toBe("©=&=&a∉");
    expect(unescapeHTML("&notit; &amp &amp", { attribute: true })).toBe("&notit; & &");
  });

  it("validates options", () => {
    expect(unescapeHTML("&amp;", undefined)).toBe("&");
    expect(unescapeHTML("&amp;", null)).toBe("&");
    expect(() => unescapeHTML("&amp;", true)).toThrow('The "options" argument must be of type object');
    expect(() => unescapeHTML("&amp;", "attribute")).toThrow(TypeError);
  });

  it("works with latin1 and utf16 strings", () => {
    // latin1 in, latin1 out
    expect(unescapeHTML("caf\xE9 &amp; cr&egrave;me")).toBe("café & crème");
    // latin1 in, and a reference to a character that latin1 does not have
    expect(unescapeHTML("caf\xE9 &amp; &hearts; cr\xE8me &#x1F600; \xFF&yuml;")).toBe("café & ♥ crème 😀 ÿÿ");
    // utf16 in
    expect(unescapeHTML("😊 &lt;☕&gt; &eacute;&hearts;")).toBe("😊 <☕> é♥");
    // lone surrogates pass through
    expect(unescapeHTML("\uD800&amp;\uDC00")).toBe("\uD800&\uDC00");

    for (let i = 0; i < 70; i++) {
      const pad = "a".repeat(i);
      expect(unescapeHTML("&lt;" + pad)).toBe("<" + pad);
      expect(unescapeHTML(pad + "&lt;" + pad)).toBe(pad + "<" + pad);
      expect(unescapeHTML(pad + "&lt;")).toBe(pad + "<");
      expect(unescapeHTML(pad + "&hearts;" + pad)).toBe(pad + "♥" + pad);
      expect(unescapeHTML("☕" + pad + "&lt;" + pad + "&#x1F600;")).toBe("☕" + pad + "<" + pad + "😀");
    }
  });

  it("undoes escapeHTML", () => {
    const texts = [
      `&<>"'`,
      `<script>alert('x' + "y" & 1)</script>`,
      "&amp;",
      "&lt;b&gt;",
      "a & b &amp c &#38; d &copy",
      "café ☕ <😊>",
      "&".repeat(100),
      `"'`.repeat(1000) + "☕",
    ];
    for (const text of texts) expect(unescapeHTML(escapeHTML(text))).toBe(text);
  });

  it("decodes what HTMLRewriter hands back", async () => {
    let text = "";
    let href;
    await new HTMLRewriter()
      .on("p", {
        text(chunk) {
          text += chunk.text;
        },
      })
      .on("a", {
        element(element) {
          href = element.getAttribute("href");
        },
      })
      .transform(new Response('<p>Tom &amp; Jerry &lt;3 caf&eacute;</p><a href="/search?q=1&copy=2&amp;lang=en">x</a>'))
      .text();
    expect(text).toBe("Tom &amp; Jerry &lt;3 caf&eacute;");
    expect(unescapeHTML(text)).toBe("Tom & Jerry <3 café");
    expect(href).toBe("/search?q=1&copy=2&amp;lang=en");
    expect(unescapeHTML(href, { attribute: true })).toBe("/search?q=1&copy=2&lang=en");
  });

  it("coerces non-string arguments", () => {
    expect(unescapeHTML(123)).toBe("123");
    expect(unescapeHTML(true)).toBe("true");
    expect(unescapeHTML(null)).toBe("null");
    expect(unescapeHTML(undefined)).toBe("undefined");
    expect(unescapeHTML()).toBe("undefined");
    expect(unescapeHTML({ toString: () => "&lt;b&gt;" })).toBe("<b>");
    expect(unescapeHTML(["&amp;", "&lt;"])).toBe("&,<");
    expect(() => unescapeHTML(Symbol.iterator)).toThrow("Cannot convert a symbol to a string");
  });

  it("handles densely packed and long input", () => {
    expect(unescapeHTML("&amp;".repeat(100_000))).toBe("&".repeat(100_000));
    expect(unescapeHTML("&".repeat(10_000))).toBe("&".repeat(10_000));
    expect(unescapeHTML(("x".repeat(1000) + "&hearts;").repeat(200))).toBe(("x".repeat(1000) + "♥").repeat(200));
    // a run of letters that is longer than any name
    expect(unescapeHTML("&" + "a".repeat(5000) + ";")).toBe("&" + "a".repeat(5000) + ";");
    expect(unescapeHTML("&amp" + "a".repeat(5000) + ";")).toBe("&" + "a".repeat(5000) + ";");
  });
});
