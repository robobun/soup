import * as b from "../../codegen/bindgen-lib.ts";

export default b.module({ rustPath: "crate::api::csv_object" });

export const CSV = b.namespace({
  parse: {
    args: {
      input: b.bytes({
        from: ["string", "buffer", "blob"],
        otherwise: "toString",
        refuse: ["undefined", "null"],
        shared: "copied",
        held: "handle",
      }),
      options: b.any,
    },
    returns: b.any,
    capability: "js",
    throws: true,
  },
  stringify: {
    args: { rows: b.any, options: b.any },
    returns: b.any,
    capability: "js",
    throws: true,
  },
});
