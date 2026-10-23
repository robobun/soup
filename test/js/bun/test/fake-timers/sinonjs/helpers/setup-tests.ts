import { expect, jest, vi } from "bun:test";
import { promisify } from "util";

let active = false;
export class FakeTimers {
  static [key: string]: any;
  [key: string]: any;
  private constructor() {}
  static install(opts: { now?: number | Date; loopLimit?: number; [key: string]: any } = { now: 0 }) {
    if (active) {
      vi.useRealTimers();
    }
    active = true;
    vi.useFakeTimers({ now: opts.now, loopLimit: opts.loopLimit });
    return new FakeTimers();
  }
  static createClock(now: number = 0, loopLimit?: number) {
    return FakeTimers.install({ now, loopLimit });
  }
  uninstall() {
    vi.useRealTimers();
    active = false;
  }
  tick(ms: number) {
    vi.advanceTimersByTime(ms);
  }
  tickAsync(ms: number) {
    return vi.advanceTimersByTimeAsync(ms);
  }
  nextAsync() {
    return vi.advanceTimersToNextTimerAsync();
  }
  runAllAsync() {
    return vi.runAllTimersAsync();
  }
  runToLastAsync() {
    return vi.runOnlyPendingTimersAsync();
  }
  hrtime(...args: Parameters<typeof process.hrtime>) {
    return process.hrtime(...args);
  }
  get setTimeout() {
    return setTimeout;
  }
  get setInterval() {
    return setInterval;
  }
  get queueMicrotask() {
    return queueMicrotask;
  }
  get Date() {
    return Date;
  }
  setSystemTime(time: number | Date) {
    jest.setSystemTime(time);
  }
  reset() {
    vi.clearAllTimers();
  }
  get now() {
    return Date.now();
  }
}

export function NOOP() {
  return undefined;
}

export const assert: any = (value: boolean) => {
  expect(value).toBeTrue();
};
Object.assign(assert, {
  equals(actual: unknown, expected: unknown) {
    // `equals` of @sinonjs/referee is a deep equal.
    expect(actual).toEqual(expected);
  },
  same(actual: unknown, expected: unknown) {
    expect(actual).toBe(expected);
  },
  exception(fn: () => void, message?: string | RegExp) {
    expect(fn).toThrow(message);
  },
  isTrue(value: unknown) {
    expect(value).toBe(true);
  },
  isFalse(value: unknown) {
    expect(value).toBe(false);
  },
  calledTwice(a) {
    expect(a.calls.length).toBe(2);
  },
  alwaysCalledWith(a, arg) {
    (expect(a.calls.every(c => c.includes(arg))) as any).toBeTrue(2);
  },
});
export const refute: any = {};
/** What the tests use of a sinon spy, over `jest.fn()`. */
function spy(implementation?: (...args: any[]) => any) {
  let thrown: { value: unknown } | undefined;
  const mock: any = jest.fn(function (this: unknown, ...args: unknown[]) {
    if (thrown) throw thrown.value;
    return implementation?.apply(this, args);
  });
  const order = (call: number) => mock.mock.invocationCallOrder[call];
  Object.defineProperties(mock, {
    called: { get: () => mock.mock.calls.length > 0 },
    notCalled: { get: () => mock.mock.calls.length === 0 },
    calledOnce: { get: () => mock.mock.calls.length === 1 },
    calledTwice: { get: () => mock.mock.calls.length === 2 },
    calledThrice: { get: () => mock.mock.calls.length === 3 },
    callCount: { get: () => mock.mock.calls.length },
    args: { get: () => mock.mock.calls },
    calls: { get: () => mock.mock.calls },
  });
  mock.calledBefore = (other: any) =>
    mock.mock.calls.length > 0 &&
    (other.mock.calls.length === 0 || order(0) < other.mock.invocationCallOrder[other.mock.calls.length - 1]);
  mock.calledWith = (...expected: unknown[]) =>
    mock.mock.calls.some((call: unknown[]) => expected.every((value, i) => Object.is(call[i], value)));
  mock.calledOn = (receiver: unknown) => mock.mock.contexts.some((context: unknown) => context === receiver);
  mock.getCall = (call: number) => ({
    args: mock.mock.calls[call],
    calledBefore: (other: { order: number }) => order(call) < other.order,
    get order() {
      return order(call);
    },
  });
  mock.throws = (value: unknown = new Error("Error")) => {
    thrown = { value };
    return mock;
  };
  return mock;
}

export const sinon: any = {
  spy,
  stub: () => spy(),
  fake: spy,
};

export const nextTickPresent = true;
export const queueMicrotaskPresent = true;
export const hrtimePresent = true;
export const hrtimeBigintPresent = true;
export const performanceNowPresent = true;
export const performanceMarkPresent = true;
export const setImmediatePresent = true;
export const utilPromisify = promisify;
export const promisePresent = true;
export const utilPromisifyAvailable = true;
export const addTimerReturnsObject = true;
export const globalObject = globalThis;
export const GlobalDate = Date;
