import { CSV } from "bun";
import { expectType } from "./utilities";

// The default is a header row, so records are objects.
expectType(Bun.CSV.parse("a,b\n1,2")).is<Record<string, string>[]>();
expectType(CSV.parse("a,b\n1,2")).is<Record<string, string>[]>();
expectType(CSV.parse(new Uint8Array())).is<Record<string, string>[]>();
expectType(CSV.parse(new Blob(["a,b"]))).is<Record<string, string>[]>();
expectType(CSV.parse("a,b\n1,2", { header: true, trim: true })).is<Record<string, string>[]>();

// `header: false` gives arrays of strings.
expectType(CSV.parse("a,b\n1,2", { header: false })).is<string[][]>();
expectType(CSV.parse("a;b", { header: false, delimiter: ";", quote: "'", skipEmptyLines: false })).is<string[][]>();

// Column names given up front type the records.
expectType(CSV.parse("1,2", { header: ["id", "name"] })).is<Record<"id" | "name", string>[]>();

// A header flag that is not known at compile time gives the union.
declare const someBoolean: boolean;
expectType(CSV.parse("a,b", { header: someBoolean })).is<Record<string, string>[] | string[][]>();

expectType(CSV.stringify([{ a: 1, b: "two" }])).is<string>();
expectType(CSV.stringify([["a", 1, null, new Date()]], { header: false })).is<string>();
expectType(CSV.stringify([{ a: 1 }], { columns: ["a"], delimiter: "\t", quote: "'" })).is<string>();

// @ts-expect-error
CSV.parse();
// @ts-expect-error
CSV.parse({});
// @ts-expect-error
CSV.parse("a,b", { header: "yes" });
// @ts-expect-error
CSV.stringify("a,b");
