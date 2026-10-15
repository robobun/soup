// Internal bindings for node:perf_hooks
// The entrypoint for node:perf_hooks is `src/js/node/perf_hooks.ts`
import * as b from "../../codegen/bindgen-lib.ts";

export default b.module({ rustPath: "crate::node::node_perf_hooks_binding" });

/** `[counted, idle]` in milliseconds, or `undefined` until the event loop of this thread counts. */
export const eventLoopIdleTime = b.fn({ returns: b.array(b.f64).optional });
