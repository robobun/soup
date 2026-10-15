import * as b from "../../codegen/bindgen-lib.ts";

export default b.module({ rustPath: "crate::api::unescape_html" });

/** `Bun.unescapeHTML(input, options?)`. A string without a reference is returned as it is, so `input` stays a value. */
export const unescapeHTML = b.fn({
  args: { input: b.any, options: b.any },
  returns: b.any,
  capability: "js",
  throws: true,
});
