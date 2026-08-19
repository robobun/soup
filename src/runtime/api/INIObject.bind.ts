import * as b from "../../codegen/bindgen-lib.ts";

export default b.module({ rustPath: "crate::api::ini_object" });

export const INI = b.namespace({
  parse: {
    args: {
      /** The parsed values point into the input, so a shared buffer, which another thread can write, is copied. */
      input: b.bytes({
        from: ["string", "buffer", "blob"],
        otherwise: "toString",
        refuse: ["undefined", "null"],
        shared: "copied",
      }),
    },
    returns: b.any,
    capability: "heap",
    throws: true,
  },
});
