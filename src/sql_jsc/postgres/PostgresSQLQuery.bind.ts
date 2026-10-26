import * as b from "../../codegen/bindgen-lib.ts";
import { PostgresSQLConnection } from "./PostgresSQLConnection.bind.ts";

const js = { capability: "js", throws: true } as const;

/** What a request is to a cursor: its statement, or the Close of its portal. */
export const CursorRequest = b.enumeration(["open", "close"]);

export const PostgresSQLQuery = b.class({
  rustPath: "crate::postgres::PostgresSQLQuery",
  refCounted: true,
  finalize: true,
  estimatedSize: true,
  internalFields: ["pendingValue", "target", "binding", "copy"],
  proto: {
    cancel: { capability: "js" },
    copyDone: { capability: "js" },
    copyFail: { args: { message: b.string.loose.utf8 }, capability: "js" },
    copyResume: {},
    copyWrite: { ...js, args: { chunk: b.any }, returns: b.bool },
    describeResult: { ...js, args: { number: b.any }, returns: b.any.returning("object", "null") },
    fetch: { ...js, args: { connection: PostgresSQLConnection }, passThis: true },
    run: { ...js, args: { connection: PostgresSQLConnection, query: b.any }, passThis: true },
    setCopy: { args: { callback: b.any, writable: b.bool.loose }, capability: "js", passThis: true },
    setCursor: { ...js, args: { request: CursorRequest, portal: b.u32, rows: b.u32 }, passThis: true },
    setMode: { ...js, args: { mode: b.any } },
    setPendingValue: {
      args: { value: b.any },
      capability: "js",
      passThis: true,
    },
  },
});
