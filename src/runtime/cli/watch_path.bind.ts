import * as b from "../../codegen/bindgen-lib.ts";

export default b.module({ rustPath: "crate::cli::watch_path" });

// The listeners of the `fs.watch()` watchers of a `--watch-path`. Each carries its `Root` as function data.
const listener = {
  passCallee: true,
  args: { eventType: b.any, filename: b.any },
  capability: "js",
  throws: true,
} as const;

export const onAboveEvent = b.fn({ ...listener, export: "Bun__WatchPath__onAboveEvent" });
export const onOwnEvent = b.fn({ ...listener, export: "Bun__WatchPath__onOwnEvent" });
