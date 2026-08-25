import { CSV } from "bun";
import { describe, expect, test } from "bun:test";

describe("Bun.CSV.parse", () => {
  test("is exported from the Bun global and the bun module", () => {
    expect(Bun.CSV.parse).toBe(CSV.parse);
    expect(Bun.CSV.stringify).toBe(CSV.stringify);
    expect(typeof CSV.parse).toBe("function");
    expect(typeof CSV.stringify).toBe("function");
  });

  test("the first record names the columns by default", () => {
    expect(CSV.parse("name,age\nAda,36\nGrace,45\n")).toEqual([
      { name: "Ada", age: "36" },
      { name: "Grace", age: "45" },
    ]);
  });

  test("header: false gives arrays, the header row included", () => {
    expect(CSV.parse("name,age\nAda,36\n", { header: false })).toEqual([
      ["name", "age"],
      ["Ada", "36"],
    ]);
  });

  test("header as an array names the columns and treats every record as data", () => {
    expect(CSV.parse("Ada,36\nGrace,45", { header: ["name", "age"] })).toEqual([
      { name: "Ada", age: "36" },
      { name: "Grace", age: "45" },
    ]);
  });

  test("fields are always strings", () => {
    expect(CSV.parse("n,b,e\n1,true,\n-2.5,null,0", { header: false })).toEqual([
      ["n", "b", "e"],
      ["1", "true", ""],
      ["-2.5", "null", "0"],
    ]);
  });

  test("accepts every line ending", () => {
    const expected = [
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ];
    expect(CSV.parse("a,b\n1,2\n3,4\n", { header: false })).toEqual(expected);
    expect(CSV.parse("a,b\r\n1,2\r\n3,4\r\n", { header: false })).toEqual(expected);
    expect(CSV.parse("a,b\r1,2\r3,4\r", { header: false })).toEqual(expected);
    expect(CSV.parse("a,b\r\n1,2\n3,4\r", { header: false })).toEqual(expected);
  });

  test("a missing final line break does not matter", () => {
    expect(CSV.parse("a,b\n1,2", { header: false })).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(CSV.parse("a,b\n1,2\n", { header: false })).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  describe("quoted fields", () => {
    test("may contain the delimiter, quotes and line breaks", () => {
      expect(CSV.parse('a,b\n"x, y","say ""hi"""\n"line 1\nline 2","tail"\n')).toEqual([
        { a: "x, y", b: 'say "hi"' },
        { a: "line 1\nline 2", b: "tail" },
      ]);
    });

    test("keep a CRLF inside the field as written", () => {
      expect(CSV.parse('"a\r\nb",c\r\n', { header: false })).toEqual([["a\r\nb", "c"]]);
    });

    test("an empty quoted field is an empty string", () => {
      expect(CSV.parse('"",x\n', { header: false })).toEqual([["", "x"]]);
      expect(CSV.parse('x,""', { header: false })).toEqual([["x", ""]]);
    });

    test("only doubled quotes are unescaped, once", () => {
      expect(CSV.parse('""""\n', { header: false })).toEqual([['"']]);
      expect(CSV.parse('""""""\n', { header: false })).toEqual([['""']]);
      expect(CSV.parse('"a""b""c"\n', { header: false })).toEqual([['a"b"c']]);
    });

    test("a quote inside an unquoted field is literal", () => {
      expect(CSV.parse('5" floppy,x\n', { header: false })).toEqual([['5" floppy', "x"]]);
      expect(CSV.parse(' "not quoted",x\n', { header: false })).toEqual([[' "not quoted"', "x"]]);
    });

    test("an unterminated quoted field is a SyntaxError with the line", () => {
      const parse = () => CSV.parse('a,b\n1,"two\n3,4\n');
      expect(parse).toThrow(SyntaxError);
      expect(parse).toThrow("CSV Parse error: unterminated quoted field at line 2");
    });

    test("text after the closing quote is a SyntaxError with the line", () => {
      const parse = () => CSV.parse('a\n"x"y\n');
      expect(parse).toThrow(SyntaxError);
      expect(parse).toThrow("CSV Parse error: unexpected character after a closing quote at line 2");
    });
  });

  describe("records", () => {
    test("a short record leaves the missing columns empty", () => {
      expect(CSV.parse("a,b,c\n1\n2,3\n")).toEqual([
        { a: "1", b: "", c: "" },
        { a: "2", b: "3", c: "" },
      ]);
    });

    test("fields past the last column are dropped", () => {
      expect(CSV.parse("a,b\n1,2,3,4\n")).toEqual([{ a: "1", b: "2" }]);
    });

    test("the last of two columns with the same name wins", () => {
      expect(CSV.parse("a,a\n1,2\n")).toEqual([{ a: "2" }]);
    });

    test("numeric and empty column names are plain own properties", () => {
      expect(CSV.parse("0,,1\nx,y,z\n")).toEqual([{ 0: "x", "": "y", 1: "z" }]);
    });

    test("a __proto__ column is an own property and does not touch the prototype", () => {
      const [row] = CSV.parse("__proto__,a\nevil,1\n");
      expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
      expect(Object.getOwnPropertyDescriptor(row, "__proto__")?.value).toBe("evil");
      expect(row.a).toBe("1");
      expect(({} as any).evil).toBeUndefined();
    });

    test("only the header gives no records", () => {
      expect(CSV.parse("a,b\n")).toEqual([]);
      expect(CSV.parse("a,b")).toEqual([]);
    });

    test("an empty input gives no records", () => {
      expect(CSV.parse("")).toEqual([]);
      expect(CSV.parse("", { header: false })).toEqual([]);
      expect(CSV.parse("\n\n", { header: false })).toEqual([]);
    });

    test("a line with a single empty field is a record when it is not skipped", () => {
      expect(CSV.parse(",\n", { header: false })).toEqual([["", ""]]);
      expect(CSV.parse("\n", { header: false, skipEmptyLines: false })).toEqual([[""]]);
    });
  });

  describe("options", () => {
    test("delimiter", () => {
      expect(CSV.parse("a\tb\n1\t2\n", { delimiter: "\t" })).toEqual([{ a: "1", b: "2" }]);
      expect(CSV.parse("a;b\n1;2\n", { delimiter: ";" })).toEqual([{ a: "1", b: "2" }]);
      expect(CSV.parse("a|b\n1|2\n", { delimiter: "|" })).toEqual([{ a: "1", b: "2" }]);
      // A delimiter that is more than one byte in UTF-8.
      expect(CSV.parse("a→b\n1→2\n", { delimiter: "→" })).toEqual([{ a: "1", b: "2" }]);
      // The comma is an ordinary character then.
      expect(CSV.parse("a;b\n1,5;2\n", { delimiter: ";" })).toEqual([{ a: "1,5", b: "2" }]);
    });

    test("quote", () => {
      expect(CSV.parse("a,b\n'x, y','it''s'\n", { quote: "'" })).toEqual([{ a: "x, y", b: "it's" }]);
      // The double quote is an ordinary character then.
      expect(CSV.parse('a\n"x"\n', { quote: "'" })).toEqual([{ a: '"x"' }]);
    });

    test("trim strips spaces and tabs around fields", () => {
      expect(CSV.parse(" a , b \t\n 1 ,\t2\n", { trim: true })).toEqual([{ a: "1", b: "2" }]);
      expect(CSV.parse(" a , b \n 1 , 2 \n", { trim: false, header: false })).toEqual([
        [" a ", " b "],
        [" 1 ", " 2 "],
      ]);
    });

    test("trim lets a quoted field have spaces around it and keeps the spaces inside", () => {
      expect(CSV.parse('a,b\n "x, y" , " z "\n', { trim: true })).toEqual([{ a: "x, y", b: " z " }]);
    });

    test("trim does not eat a tab delimiter", () => {
      expect(CSV.parse("a\tb\tc\n1\t\t3\n", { delimiter: "\t", trim: true })).toEqual([{ a: "1", b: "", c: "3" }]);
    });

    test("skipEmptyLines is on by default", () => {
      expect(CSV.parse("a,b\n\n1,2\n\n\n3,4\n\n")).toEqual([
        { a: "1", b: "2" },
        { a: "3", b: "4" },
      ]);
      expect(CSV.parse("a\n\n1\n", { trim: true, header: false })).toEqual([["a"], ["1"]]);
      expect(CSV.parse("a\n  \n1\n", { trim: true, header: false })).toEqual([["a"], ["1"]]);
    });

    test("skipEmptyLines: false keeps them as records with one empty field", () => {
      expect(CSV.parse("a\n\n1\n", { header: false, skipEmptyLines: false })).toEqual([["a"], [""], ["1"]]);
      expect(CSV.parse("a,b\n\n1,2\n", { skipEmptyLines: false })).toEqual([
        { a: "", b: "" },
        { a: "1", b: "2" },
      ]);
    });

    test("rejects a delimiter or quote that is not one character", () => {
      expect(() => CSV.parse("a", { delimiter: "" })).toThrow(TypeError);
      expect(() => CSV.parse("a", { delimiter: ", " })).toThrow(
        "`delimiter` must be a string of exactly one character",
      );
      expect(() => CSV.parse("a", { quote: "''" })).toThrow("`quote` must be a string of exactly one character");
      expect(() => CSV.parse("a", { delimiter: 1 as any })).toThrow(TypeError);
      expect(() => CSV.parse("a", { delimiter: "\n" })).toThrow("`delimiter` cannot be a line break");
      expect(() => CSV.parse("a", { delimiter: "'", quote: "'" })).toThrow(
        "`delimiter` and `quote` must be different characters",
      );
    });

    test("rejects a header that is not a boolean or an array of strings", () => {
      expect(() => CSV.parse("a", { header: "yes" as any })).toThrow(TypeError);
      expect(() => CSV.parse("a", { header: [1] as any })).toThrow("`header` must be an array of strings");
    });

    test("undefined and null options mean the default", () => {
      expect(CSV.parse("a,b\n1,2\n", undefined)).toEqual([{ a: "1", b: "2" }]);
      expect(CSV.parse("a,b\n1,2\n", { header: null as any, delimiter: undefined, quote: null as any })).toEqual([
        { a: "1", b: "2" },
      ]);
    });
  });

  describe("input", () => {
    test("accepts UTF-8 bytes and a Blob", () => {
      const text = "name,city\nJosé,São Paulo\n";
      const expected = [{ name: "José", city: "São Paulo" }];
      expect(CSV.parse(new TextEncoder().encode(text))).toEqual(expected);
      expect(CSV.parse(Buffer.from(text))).toEqual(expected);
      expect(CSV.parse(new TextEncoder().encode(text).buffer)).toEqual(expected);
      expect(CSV.parse(new Blob([text]))).toEqual(expected);
    });

    test("handles non-Latin-1 text", () => {
      expect(CSV.parse("名前,年齢\n太郎,36\n😀,🎉\n")).toEqual([
        { 名前: "太郎", 年齢: "36" },
        { 名前: "😀", 年齢: "🎉" },
      ]);
    });

    test("skips a leading byte order mark", () => {
      expect(CSV.parse("\uFEFFa,b\n1,2\n")).toEqual([{ a: "1", b: "2" }]);
      expect(CSV.parse(Buffer.from("\xEF\xBB\xBFa,b\n1,2\n", "binary"))).toEqual([{ a: "1", b: "2" }]);
    });

    test("throws on a missing argument", () => {
      expect(() => (CSV.parse as any)()).toThrow("Expected a string to parse");
      expect(() => CSV.parse(null as any)).toThrow("Expected a string to parse");
    });
  });

  test("a large input", () => {
    const rows = 5_000;
    const lines = ["id,name,score\n"];
    for (let i = 0; i < rows; i++) {
      lines.push(`${i},"name, ${i}",${i * 1.5}\n`);
    }
    const text = lines.join("");
    const parsed = CSV.parse(text);
    expect(parsed).toHaveLength(rows);
    expect(parsed[0]).toEqual({ id: "0", name: "name, 0", score: "0" });
    expect(parsed[rows - 1]).toEqual({
      id: String(rows - 1),
      name: `name, ${rows - 1}`,
      score: String((rows - 1) * 1.5),
    });
  });
});

describe("Bun.CSV.stringify", () => {
  test("object rows get a header from the keys of the first row", () => {
    expect(
      CSV.stringify([
        { name: "Ada", age: 36 },
        { name: "Grace", age: 45 },
      ]),
    ).toBe("name,age\nAda,36\nGrace,45\n");
  });

  test("array rows are written as they are", () => {
    expect(CSV.stringify([["a", "b"], [1, 2], [3]])).toBe("a,b\n1,2\n3\n");
  });

  test("quotes only what needs it", () => {
    expect(CSV.stringify([["x, y", 'say "hi"', "line 1\nline 2", "crlf\r\n", " padded ", "\ttab", "plain"]])).toBe(
      '"x, y","say ""hi""","line 1\nline 2","crlf\r\n"," padded ","\ttab",plain\n',
    );
    expect(CSV.stringify([["", ""]])).toBe(",\n");
  });

  test("value conversions", () => {
    const date = new Date("2024-05-06T07:08:09.010Z");
    expect(
      CSV.stringify([[null, undefined, true, false, 0, -1.5, 10n, date, { a: 1 }, [1, "two"], () => {}, Symbol("s")]]),
    ).toBe(`,,true,false,0,-1.5,10,2024-05-06T07:08:09.010Z,"{""a"":1}","[1,""two""]",,\n`);
  });

  test("boxed primitives are unwrapped", () => {
    expect(CSV.stringify([[new String("a"), new Number(1), new Boolean(false)]])).toBe("a,1,false\n");
  });

  test("an invalid Date throws", () => {
    expect(() => CSV.stringify([[new Date(NaN)]])).toThrow("CSV.stringify cannot serialize an invalid Date");
  });

  test("a missing property is an empty field", () => {
    expect(CSV.stringify([{ a: 1, b: 2 }, { b: 3 }, { a: 4, c: "dropped" }])).toBe("a,b\n1,2\n,3\n4,\n");
  });

  test("columns selects and orders the properties", () => {
    expect(CSV.stringify([{ a: 1, b: 2, c: 3 }], { columns: ["c", "a"] })).toBe("c,a\n3,1\n");
    expect(CSV.stringify([{ a: 1 }], { columns: ["a", "missing"] })).toBe("a,missing\n1,\n");
  });

  test("columns is the header for array rows", () => {
    expect(CSV.stringify([[1, 2]], { columns: ["a", "b"] })).toBe("a,b\n1,2\n");
  });

  test("header: false leaves the header out", () => {
    expect(CSV.stringify([{ a: 1 }], { header: false })).toBe("1\n");
    expect(CSV.stringify([[1]], { columns: ["a"], header: false })).toBe("1\n");
  });

  test("no rows is an empty string, or just the header with columns", () => {
    expect(CSV.stringify([])).toBe("");
    expect(CSV.stringify([], { columns: ["a", "b"] })).toBe("a,b\n");
    expect(CSV.stringify([], { columns: ["a", "b"], header: false })).toBe("");
  });

  test("header names are quoted like any field", () => {
    expect(CSV.stringify([{ "first, name": "Ada", 'q"': 1 }])).toBe('"first, name","q"""\nAda,1\n');
  });

  test("delimiter and quote", () => {
    expect(CSV.stringify([["a\tb", "c"]], { delimiter: "\t" })).toBe('"a\tb"\tc\n');
    expect(CSV.stringify([["it's", 'say "hi"']], { quote: "'" })).toBe(`'it''s',say "hi"\n`);
    expect(CSV.stringify([{ a: "x;y" }], { delimiter: ";" })).toBe('a\n"x;y"\n');
  });

  test("non-Latin-1 text", () => {
    expect(CSV.stringify([{ 名前: "太郎", note: "😀, ok" }])).toBe('名前,note\n太郎,"😀, ok"\n');
    expect(CSV.stringify([["a→b"]], { delimiter: "→" })).toBe('"a→b"\n');
  });

  test("rows must all be arrays or all be objects", () => {
    expect(() => CSV.stringify("a,b" as any)).toThrow("CSV.stringify expects an array of rows");
    expect(() => CSV.stringify([1] as any)).toThrow("CSV.stringify: row 0 is not an array or an object");
    expect(() => CSV.stringify([["a"], { a: 1 }] as any)).toThrow(
      "CSV.stringify: row 1 is not an array like the first row",
    );
    expect(() => CSV.stringify([{ a: 1 }, null] as any)).toThrow(
      "CSV.stringify: row 1 is not an object like the first row",
    );
  });

  test("rejects bad options", () => {
    expect(() => CSV.stringify([], { columns: "a" as any })).toThrow("`columns` must be an array of strings");
    expect(() => CSV.stringify([], { delimiter: "ab" })).toThrow(
      "`delimiter` must be a string of exactly one character",
    );
    expect(() => CSV.stringify([], { delimiter: "\r" })).toThrow("`delimiter` cannot be a line break");
    expect(() => CSV.stringify([], { delimiter: '"' })).toThrow("`delimiter` and `quote` must be different characters");
  });

  test("round-trips through parse", () => {
    const rows = [
      { name: "Ada", note: 'says "hi", then\nleaves', city: " São Paulo " },
      { name: "Grace", note: "", city: "" },
    ];
    expect(CSV.parse(CSV.stringify(rows))).toEqual(rows);
    expect(CSV.parse(CSV.stringify(rows), { trim: true })).toEqual(rows);
    const arrays = [
      ["a", "b,c"],
      ["1", ""],
    ];
    expect(CSV.parse(CSV.stringify(arrays), { header: false })).toEqual(arrays);
  });
});
