import * as b from "../codegen/bindgen-lib.ts";

export default b.module({ rustPath: "crate::SemverObject" });

export const semver = b.namespace({
  satisfies: {
    args: { version: b.string.loose.utf8, range: b.string.loose.utf8 },
    returns: b.bool,
    throws: true,
  },
  order: {
    args: { left: b.string.loose.utf8, right: b.string.loose.utf8 },
    returns: b.i32,
    capability: "heap",
    throws: true,
  },
  parse: {
    args: { version: b.string.loose.utf8.nullable },
    returns: b.any,
    capability: "js",
    throws: true,
    length: 1,
  },
  inc: {
    args: {
      version: b.string.loose.utf8.nullable,
      release: b.any,
      identifier: b.any,
      identifierBase: b.any,
    },
    returns: b.any,
    capability: "js",
    throws: true,
    length: 2,
  },
  maxSatisfying: {
    args: { versions: b.any, range: b.string.loose.utf8 },
    returns: b.any,
    capability: "js",
    throws: true,
  },
  minSatisfying: {
    args: { versions: b.any, range: b.string.loose.utf8 },
    returns: b.any,
    capability: "js",
    throws: true,
  },
});
