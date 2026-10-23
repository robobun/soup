import * as b from "../../../codegen/bindgen-lib.ts";

export default b.module({ rustPath: "crate::test_runner::timers::fake_timers" });

/** A turn of an async control: the callback of its immediate, which queues itself again. */
export const asyncControlTurn = b.fn({
  export: "Bun__FakeTimers__asyncControlTurn",
  passCallee: true,
  args: { record: b.any },
  capability: "js",
  throws: true,
});
