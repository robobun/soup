import * as b from "../../codegen/bindgen-lib.ts";

export default b.module({ rustPath: "crate::test_runner::snapshot_serializer" });

// What a serializer of `expect.addSnapshotSerializer()` is handed to print the values it leaves to the formatter.
const js = { returns: b.any, capability: "js", throws: true } as const;

/** `printer(value, config, indentation, depth, refs)`, the last argument of `serialize()`. */
export const printer = b.fn({
  ...js,
  export: "Bun__SnapshotSerializer__printer",
  args: { value: b.any, config: b.any, indentation: b.any, depth: b.any, refs: b.any },
});
/** `print(value)` of the older interface, bound to the indent level, `config` and `refs`. */
export const printChild = b.fn({
  ...js,
  export: "Bun__SnapshotSerializer__printChild",
  args: { level: b.any, config: b.any, refs: b.any, value: b.any },
});
/** `indent(text)` of the older interface, bound to the indent level. */
export const indentLines = b.fn({
  ...js,
  export: "Bun__SnapshotSerializer__indentLines",
  args: { level: b.any, text: b.string.loose.utf8 },
});
