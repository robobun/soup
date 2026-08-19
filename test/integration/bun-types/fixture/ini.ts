import { INI } from "bun";
import { expectType } from "./utilities";

expectType(Bun.INI.parse("a = 1")).is<INI.Section>();
expectType(INI.parse("a = 1")).is<INI.Section>();
expectType(INI.parse(new Uint8Array())).is<INI.Section>();
expectType(INI.parse(new Blob(["a = 1"]))).is<INI.Section>();

// The value space is closed: narrowing needs no casts.
{
  const database = INI.parse("[database]\nhost = localhost").database;
  expectType(database).is<INI.Value | undefined>();
  if (typeof database === "string") expectType(database).is<string>();
  else if (typeof database === "boolean") expectType(database).is<boolean>();
  else if (Array.isArray(database)) expectType(database).is<INI.Value[]>();
  else if (typeof database === "object" && database !== null) expectType(database.host).is<INI.Value | undefined>();
}

// @ts-expect-error
INI.parse();
// @ts-expect-error
INI.parse({});
