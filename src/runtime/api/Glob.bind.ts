import * as b from "../../codegen/bindgen-lib.ts";

export const GlobScanIgnore = b.union({
  pattern: b.string.utf8,
  patterns: b.array(b.string.utf8.owned),
});

export const GlobScanOptions = b.dictionary(
  {
    onlyFiles: b.bool.loose.nullable.default(true),
    throwErrorOnBrokenSymlink: b.bool.loose.nullable.default(false),
    followSymlinks: b.bool.loose.nullable.default(false),
    absolute: b.bool.loose.nullable.default(false),
    cwd: b.string.utf8.nullable,
    dot: b.bool.loose.nullable.default(false),
    ignore: GlobScanIgnore.falsyAsNull,
  },
  { allowArray: true },
);

export const GlobScanArgument = b.union({
  cwd: b.string.utf8,
  options: GlobScanOptions,
});

// Two signatures and not one with a union, so that `new Glob(string)` is the call that it was.
export const Glob = b.class({
  rustPath: "crate::api::glob::Glob",
  construct: [
    {
      args: { pattern: b.string.utf8.owned },
      capability: "heap",
      // What is neither a string nor an array comes here.
      expected: { pattern: "pattern must be a string or an array of strings" },
    },
    { args: { patterns: b.array(b.string.utf8.owned) }, capability: "heap", rustName: "from_list" },
  ],
  proto: {
    match: {
      args: { str: b.string.utf8 },
      returns: b.bool,
    },
    scan: {
      builtin: true,
      length: 1,
    },
    scanSync: {
      builtin: true,
      length: 1,
    },
    __scan: {
      args: { options: GlobScanArgument.nullable },
      returns: b.any,
      capability: "js",
      throws: true,
      privateSymbol: "globScan",
    },
    __scanSync: {
      args: { options: GlobScanArgument.nullable },
      returns: b.any,
      capability: "heap",
      throws: true,
      privateSymbol: "globScanSync",
    },
  },
});
