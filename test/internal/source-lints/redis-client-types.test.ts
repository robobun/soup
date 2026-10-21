import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { RedisClient } from "../../../src/runtime/valkey_jsc/valkey.bind.ts";
import { notQueueableInTransaction } from "../../js/valkey/transaction-not-queueable.ts";

// `class RedisClient` in packages/bun-types/redis.d.ts is a hand-written mirror
// of the `proto` table in src/runtime/valkey_jsc/valkey.bind.ts, which is
// what bindgen installs on RedisClient.prototype. Nothing else
// compares the two: five commands registered by the first Bun.redis commit were
// still undeclared fourteen redis.d.ts commits later, so calling them works at
// runtime and fails to type-check. This lint loads the same module the codegen
// loads and requires the class body to declare exactly the members the tables
// install.

// Registered members that are not declared yet, each with the open PR that
// declares it. Delete the entry when that PR lands: the lint fails while a name
// listed here is declared (or is no longer registered).
const pendingDeclarations: Record<string, string> = {
  pubsub: "#39208",
  select: "#39208",
  // Not usable until #35521 lands: psubscribe() takes no listener today, so
  // every pmessage the server sends is dropped.
  psubscribe: "#35521",
  punsubscribe: "#35521",
};

// Registered on RedisClient.prototype, but only the object multi() returns can
// use it (anywhere else it throws), so the declaration is a member of
// `interface RedisTransaction` and `class RedisClient` has none.
const declaredOnTransaction = ["exec"];

const schemaFile = "src/runtime/valkey_jsc/valkey.bind.ts";
const listFile = "test/js/valkey/transaction-not-queueable.ts";
const dtsFile = "packages/bun-types/redis.d.ts";
const root = path.resolve(import.meta.dir, "..", "..", "..");

// Every member the codegen installs: prototype members by name, static
// members as "static name". A well-known symbol stays in the table's `@@x`
// spelling; parseClassBody maps the class body's `[Symbol.x]` onto it.
const registered = new Set<string>();
for (const [members, prefix] of [
  [RedisClient.protoMembers, ""],
  [RedisClient.staticMembers, "static "],
] as const) {
  for (const member of members) registered.add(prefix + member.name);
}
if (RedisClient.construct) registered.add("constructor");

const dts = readFileSync(path.join(root, dtsFile), "utf8");
const { declared, overloads, unrecognized } = parseClassBody(dts);

function parseClassBody(dts: string): {
  declared: Set<string>;
  overloads: Map<string, number>;
  unrecognized: string[];
} {
  const open = /^  export class RedisClient \{$/m.exec(dts);
  if (open === null) throw new Error(`${dtsFile} no longer declares \`export class RedisClient {\``);
  const bodyStart = open.index + open[0].length;
  const bodyEnd = dts.indexOf("\n  }\n", bodyStart);
  if (bodyEnd === -1) throw new Error(`${dtsFile}: unterminated class RedisClient body`);

  const body = dts
    .slice(bodyStart, bodyEnd)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

  const declared = new Set<string>();
  // How many times each member is declared: a method's overloads.
  const overloads = new Map<string, number>();
  const unrecognized: string[] = [];
  // Members start at the class body's four-space indent. The only other lines
  // at that indent are the `): ...;` closers of multi-line signatures, which
  // start with punctuation, so everything else at that indent is a member and
  // has to parse: a declaration shape this does not know is reported rather
  // than skipped.
  const member = /^(static )?(?:readonly )?(?:(?:get|set) )?(?:\[Symbol\.(\w+)\]|([A-Za-z_$][\w$]*))\s*\??\s*[(:<]/;
  for (const [line] of body.matchAll(/^    [^\s)\]}>].*$/gm)) {
    const m = member.exec(line.slice(4));
    if (m === null) {
      unrecognized.push(line.trim());
      continue;
    }
    const name = (m[1] ?? "") + (m[2] !== undefined ? `@@${m[2]}` : m[3]);
    declared.add(name);
    overloads.set(name, (overloads.get(name) ?? 0) + 1);
  }
  return { declared, overloads, unrecognized };
}

test(`every member of class RedisClient in ${dtsFile} has a shape this lint can read`, () => {
  expect(unrecognized).toEqual([]);
});

test(`${dtsFile} declares every RedisClient member ${schemaFile} installs`, () => {
  const undeclared = [...registered]
    .filter(
      name => !declared.has(name) && !Object.hasOwn(pendingDeclarations, name) && !declaredOnTransaction.includes(name),
    )
    .sort();
  expect(undeclared).toEqual([]);
});

test(`${dtsFile} declares no RedisClient member ${schemaFile} does not install`, () => {
  const phantom = [...declared].filter(name => !registered.has(name)).sort();
  expect(phantom).toEqual([]);
});

test("pendingDeclarations lists only members that are still registered and still undeclared", () => {
  const stale = Object.entries(pendingDeclarations)
    .flatMap(([name, pr]) => {
      if (!registered.has(name)) return [`${name} (${pr}) is no longer registered in ${schemaFile}`];
      if (declared.has(name)) return [`${name} (${pr}) is declared in ${dtsFile} now; delete its entry`];
      return [];
    })
    .sort();
  expect(stale).toEqual([]);
});

// `interface RedisTransaction` (the type of what multi() returns) is derived
// from `class RedisClient`: every member except the names in
// `RedisTransaction.NotQueueable`, with each overload re-typed by
// `RedisTransaction.Queued`. The tests below hold the hand-written parts of
// that derivation to what the runtime does.

test(`${dtsFile} declares in interface RedisTransaction what only a transaction can call`, () => {
  const open = /^  export interface RedisTransaction<[^\n]*\{$/m.exec(dts);
  if (open === null) throw new Error(`${dtsFile} no longer declares \`export interface RedisTransaction\``);
  const bodyStart = open.index + open[0].length;
  const body = dts.slice(bodyStart, dts.indexOf("\n  }\n", bodyStart)).replace(/\/\*[\s\S]*?\*\//g, "");
  const members = [...body.matchAll(/^    ([A-Za-z_$][\w$]*)\s*[(<]/gm)].map(m => m[1]).sort();
  expect(members).toEqual([...declaredOnTransaction].sort());
  expect(declaredOnTransaction.filter(name => !registered.has(name) || declared.has(name))).toEqual([]);
});

test(`RedisTransaction.NotQueueable in ${dtsFile} is notQueueableInTransaction in ${listFile}`, () => {
  const union = /^    type NotQueueable =([^;]*);$/m.exec(dts);
  if (union === null) throw new Error(`${dtsFile} no longer declares \`type NotQueueable\``);
  const names = [...union[1].matchAll(/"([^"]+)"/g)].map(m => m[1]).sort();
  expect(names).toEqual([...notQueueableInTransaction].sort());
  // A name that is not a member would leave nothing out and hide a typo.
  expect(notQueueableInTransaction.filter(name => !registered.has(name))).toEqual([]);
});

test(`notQueueableInTransaction in ${listFile} names every accessor of RedisClient`, () => {
  // `RedisTransaction.Commands` turns every member it is not told to leave out into a command method.
  const accessors = [...RedisClient.getters, ...RedisClient.internalFieldAccessors].map(accessor => accessor.name);
  expect(accessors.length).toBeGreaterThan(0);
  expect(accessors.filter(name => !(notQueueableInTransaction as readonly string[]).includes(name))).toEqual([]);
});

test(`no RedisClient method has more overloads than RedisTransaction.Queued in ${dtsFile} keeps`, () => {
  const slots = [...dts.matchAll(/^      \(\.\.\.args: infer A\d+\): infer R\d+;$/gm)].length;
  expect(slots).toBeGreaterThan(0);
  const dropped = [...overloads].filter(([, count]) => count > slots).map(([name, count]) => `${name} (${count})`);
  expect(dropped).toEqual([]);
});
