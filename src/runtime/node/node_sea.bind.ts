// Internal bindings for node:sea
// The entrypoint for node:sea is `src/js/node/sea.ts`
import * as b from "../../codegen/bindgen-lib.ts";

export default b.module({ rustPath: "crate::node::sea" });

export const isSea = b.fn({ returns: b.bool });

/** A copy of the asset in an `ArrayBuffer` of its own. `undefined` when no asset has the key. */
export const getAsset = b.fn({
  args: { key: b.string.utf8 },
  returns: b.any,
  capability: "heap",
  throws: true,
});

/** The asset as a `Blob` of the bytes in the executable, which are not copied. `undefined` when no asset has the key. */
export const getAssetAsBlob = b.fn({
  args: { key: b.string.utf8 },
  returns: b.any,
  capability: "heap",
  throws: true,
});

export const getAssetKeys = b.fn({ returns: b.array(b.string.utf8) });
