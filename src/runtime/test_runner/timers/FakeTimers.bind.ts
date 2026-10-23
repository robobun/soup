import * as b from "../../../codegen/bindgen-lib.ts";

export default b.module({ rustPath: "crate::test_runner::timers::fake_timers" });

/** Returns `this`, which is `jest` or `vi`. */
const chainable = { passThis: true, returns: b.any, capability: "js", throws: true } as const;
/** Returns a promise that resolves with `this` when that is `vi`. What the sync twin throws rejects it. */
const asyncControl = { passThis: true, returns: b.any, capability: "js", throws: true } as const;

export const FakeTimersOptions = b.dictionary(
  {
    now: b.f64.allowDate.optional,
    /** Vitest's name for `timerLimit`. */
    loopLimit: { type: b.f64.optional, expected: "'loopLimit' must be a number of timers" },
    /** The most timers one `runAllTimers()` or `runAllTimersAsync()` fires. */
    timerLimit: { type: b.f64.optional, expected: "'timerLimit' must be a number of timers" },
  },
  { allowArray: true, reportedAs: "options" },
);
/** Jest 26 took `"modern"` or `"legacy"`. The string is ignored. */
export const FakeTimersImplementationOrOptions = b.union({
  implementation: b.string.allowStringObject,
  options: FakeTimersOptions,
});

export const useFakeTimers = b.fn({
  ...chainable,
  export: "Bun__FakeTimers__useFakeTimers",
  args: { options: FakeTimersImplementationOrOptions.optional },
  expected: { options: "useFakeTimers() expects an options object" },
});
export const useRealTimers = b.fn({ ...chainable, export: "Bun__FakeTimers__useRealTimers" });
export const advanceTimersToNextTimer = b.fn({ ...chainable, export: "Bun__FakeTimers__advanceTimersToNextTimer" });
export const advanceTimersToNextTimerAsync = b.fn({
  ...asyncControl,
  export: "Bun__FakeTimers__advanceTimersToNextTimerAsync",
  args: { steps: b.any },
});
export const advanceTimersByTime = b.fn({
  ...chainable,
  export: "Bun__FakeTimers__advanceTimersByTime",
  args: { milliseconds: b.f64 },
  expected: { milliseconds: "advanceTimersByTime() expects a number of milliseconds" },
});
export const advanceTimersByTimeAsync = b.fn({
  ...asyncControl,
  export: "Bun__FakeTimers__advanceTimersByTimeAsync",
  args: { milliseconds: b.any },
});
export const runOnlyPendingTimers = b.fn({ ...chainable, export: "Bun__FakeTimers__runOnlyPendingTimers" });
export const runOnlyPendingTimersAsync = b.fn({
  ...asyncControl,
  export: "Bun__FakeTimers__runOnlyPendingTimersAsync",
});
export const runAllTimers = b.fn({ ...chainable, export: "Bun__FakeTimers__runAllTimers" });
export const runAllTimersAsync = b.fn({ ...asyncControl, export: "Bun__FakeTimers__runAllTimersAsync" });
export const getTimerCount = b.fn({
  export: "Bun__FakeTimers__getTimerCount",
  returns: b.usize,
  capability: "heap",
  throws: true,
});
export const clearAllTimers = b.fn({ ...chainable, export: "Bun__FakeTimers__clearAllTimers" });
export const isFakeTimers = b.fn({ export: "Bun__FakeTimers__isFakeTimers", returns: b.bool });
