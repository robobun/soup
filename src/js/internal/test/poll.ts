// `expect.poll(fn, options)` from bun:test: run `expect(await fn()).<matcher>(...)`
// again and again until it passes or the timeout runs out.

const { validateFunction, validateNumber, validateObject, validateString } = require("internal/validators");
const { hideFromStack } = require("internal/shared");
const { setTimeout, clearTimeout } = require("node:timers");

const isFakeTimers = $newRustFunction("FakeTimers.rs", "isFakeTimers", 0);
const dontCountAsAssertion = $newRustFunction("expect.rs", "jsDontCountAsAssertion", 1);

const nanoseconds = Bun.nanoseconds;
const sleep = Bun.sleep;
const MathMin = Math.min;
const ObjectHasOwn = Object.hasOwn;
const PromiseResolve = Promise.resolve.bind(Promise);

// setTimeout() cannot wait longer than this.
const TIMEOUT_MAX_MS = 2 ** 31 - 1;

type PollState = {
  /** The `expect` function that `poll` was called on. */
  expect: (value: unknown, message?: string) => Record<string, unknown>;
  /** `expect.prototype`, where the matchers live (custom ones included). */
  matchers: object;
  fn: () => unknown;
  interval: number;
  timeout: number;
  message: string | undefined;
};

const enum Outcome {
  /** The callback threw, or the promise it returned rejected. */
  Threw,
  /** The promise the callback returned did not settle before the deadline. */
  Pending,
  /** The matcher did not pass. */
  Failed,
}

// Matchers that make no sense on a polled value. Reading one of them throws.
const unsupported = {
  __proto__: null,
  resolves:
    "expect.poll() does not support .resolves: a promise returned by the callback is awaited before it is matched",
  rejects:
    "expect.poll() does not support .rejects: a callback that throws or rejects is retried. Catch the error in the callback and return it instead",
  toThrow:
    "expect.poll() does not support .toThrow(): a callback that throws is retried. Catch the error in the callback and return it instead",
  toThrowError:
    "expect.poll() does not support .toThrowError(): a callback that throws is retried. Catch the error in the callback and return it instead",
  toThrowErrorMatchingSnapshot: "expect.poll() does not support snapshot matchers",
  toThrowErrorMatchingInlineSnapshot: "expect.poll() does not support snapshot matchers",
  toMatchSnapshot: "expect.poll() does not support snapshot matchers",
  toMatchInlineSnapshot: "expect.poll() does not support snapshot matchers",
} as unknown as Record<string, string | undefined>;

const timedOut = Symbol("timedOut");

function poll(expect: unknown, fn: unknown, options: unknown) {
  if (!$isCallable(expect) || !$isObject((expect as { prototype: unknown }).prototype)) {
    throw new TypeError("expect.poll() must be called on the expect function");
  }
  validateFunction(fn, "fn");
  let interval = 50;
  let timeout = 1000;
  let message: string | undefined;
  if (options !== undefined) {
    validateObject(options, "options");
    const o = options as { interval?: unknown; timeout?: unknown; message?: unknown };
    if (o.interval !== undefined) {
      validateNumber(o.interval, "options.interval", 0);
      interval = o.interval as number;
    }
    if (o.timeout !== undefined) {
      validateNumber(o.timeout, "options.timeout", 0);
      timeout = o.timeout as number;
    }
    if (o.message !== undefined) {
      validateString(o.message, "options.message");
      message = o.message as string;
    }
  }
  const state: PollState = {
    expect: expect as PollState["expect"],
    matchers: (expect as { prototype: object }).prototype,
    fn: fn as () => unknown,
    interval,
    timeout,
    message,
  };
  return makeMatchers(state, false);
}

function makeMatchers(state: PollState, negate: boolean): object {
  const get = function (_: object, name: string | symbol) {
    // "then": `await expect.poll(fn)` must not mistake this object for a thenable.
    if (typeof name !== "string" || name === "then") return undefined;
    if (name === "not") return makeMatchers(state, !negate);
    const reason = unsupported[name];
    if (reason !== undefined) throw new TypeError(reason);
    if (!ObjectHasOwn(state.matchers, name) || !$isCallable((state.matchers as Record<string, unknown>)[name])) {
      return undefined;
    }
    const matcher = function (...args: unknown[]) {
      // Created here, while the caller is on the stack, so that a failure points
      // at the `expect.poll()` line and not into a timer callback.
      const error = new Error("expect.poll()");
      return pollMatcher(state, negate, name, args, error);
    };
    hideFromStack(matcher);
    return matcher;
  };
  hideFromStack(get);
  return new Proxy({}, { get });
}

async function pollMatcher(
  state: PollState,
  negate: boolean,
  name: string,
  args: unknown[],
  error: Error,
): Promise<void> {
  const { expect, fn, interval, timeout, message } = state;
  if (isFakeTimers()) {
    error.message = "expect.poll() needs real timers, but fake timers are in use. Call jest.useRealTimers() first";
    throw error;
  }

  const deadline = nanoseconds() + timeout * 1e6;
  let attempts = 0;
  let counted = false;
  let lastOutcome = Outcome.Threw;
  let lastError: unknown;

  while (true) {
    attempts++;
    let value: unknown;
    let ok = true;
    try {
      value = fn();
      if ($isPromise(value) || ($isObject(value) && $isCallable((value as { then?: unknown }).then))) {
        value = await settleBefore(value as PromiseLike<unknown>, deadline);
        if (value === timedOut) {
          ok = false;
          lastOutcome = Outcome.Pending;
          lastError = undefined;
        }
      }
    } catch (e) {
      ok = false;
      lastOutcome = Outcome.Threw;
      lastError = e;
    }

    if (ok) {
      let assertion = message === undefined ? expect(value) : expect(value, message);
      // One poll is one assertion for expect.assertions(), however many attempts it takes.
      if (counted) dontCountAsAssertion(assertion);
      counted = true;
      if (negate) assertion = assertion.not as typeof assertion;
      try {
        const result = (assertion[name] as Function).$apply(assertion, args);
        if ($isPromise(result)) await result;
        return;
      } catch (e) {
        lastOutcome = Outcome.Failed;
        lastError = e;
      }
    }

    const remainingMs = (deadline - nanoseconds()) / 1e6;
    if (!(remainingMs > 0)) break;
    await sleep(MathMin(interval, remainingMs));
  }

  const tries = attempts === 1 ? "1 attempt" : `${attempts} attempts`;
  switch (lastOutcome) {
    case Outcome.Failed:
      if ($isObject(lastError) && typeof (lastError as Error).message === "string") {
        error.message = `expect.poll() timed out: the value did not pass within ${timeout}ms (${tries})\n\n${(lastError as Error).message}`;
      } else {
        error.message = `expect.poll() timed out: the value did not pass within ${timeout}ms (${tries})`;
        error.cause = lastError;
      }
      break;
    case Outcome.Threw:
      error.message = `expect.poll() timed out: the callback still threw after ${timeout}ms (${tries})`;
      error.cause = lastError;
      break;
    case Outcome.Pending:
      error.message = `expect.poll() timed out: the promise returned by the callback did not settle within ${timeout}ms (${tries})`;
      break;
  }
  throw error;
}

/** Resolves with the value of `thenable`, or with `timedOut` once `deadline` (in ns) has passed. */
function settleBefore(thenable: PromiseLike<unknown>, deadline: number): Promise<unknown> {
  const remainingMs = (deadline - nanoseconds()) / 1e6;
  const promise = PromiseResolve(thenable);
  if (!(remainingMs < TIMEOUT_MAX_MS)) return promise;
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(
      () => {
        timer = undefined;
        resolve(timedOut);
      },
      remainingMs > 0 ? remainingMs : 0,
    );
    promise.then(
      value => {
        if (timer !== undefined) clearTimeout(timer);
        resolve(value);
      },
      error => {
        if (timer !== undefined) clearTimeout(timer);
        reject(error);
      },
    );
  });
}

hideFromStack(poll, pollMatcher);

export default { poll };
