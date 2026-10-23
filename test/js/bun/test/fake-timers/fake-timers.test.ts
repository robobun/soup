import { RedisClient, SQL } from "bun";
import { timerInternals } from "bun:internal-for-testing";
import { heapStats } from "bun:jsc";
import { jest, setSystemTime } from "bun:test";
import { bunEnv, bunExe, isASAN, isDebug, isLinux, tempDir } from "harness";
import { spawnSync as childProcessSpawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { setInterval as setIntervalIterator } from "node:timers/promises";
import { afterEach, describe, expect, test, vi } from "vitest";

afterEach(() => vi.useRealTimers());

class Order {
  items: { timePerf: number; timeDate: number; message: string }[] = [];
  startPerf: number = 0;
  startDate: number = 0;
  constructor() {
    this.startPerf = performance.now();
    this.startDate = Date.now();
  }
  add(message: string) {
    this.items.push({
      timePerf: performance.now() - this.startPerf,
      timeDate: Date.now() - this.startDate,
      message,
    });
  }

  takeOrderMessages(): string[] {
    const result = this.items.map(item => item.message);
    this.items = [];
    return result;
  }
}

test("fake timers", async () => {
  expect(vi.useFakeTimers()).toBe(vi);
  const order = new Order();
  setTimeout(() => {
    order.add("setTimeout");
  }, 0);
  expect(vi.useRealTimers()).toBe(vi);
  await Bun.sleep(10);
  expect(order.takeOrderMessages()).toEqual([]); // it was created as a fake timer, so it should not have triggered
});

describe("advanceTimersToNextTimer", () => {
  test("one setTimeout", async () => {
    const order = new Order();
    vi.useFakeTimers();
    setTimeout(() => {
      order.add("setTimeout");
    }, 0);
    expect(order.takeOrderMessages()).toEqual([]);
    vi.advanceTimersToNextTimer();
    expect(order.takeOrderMessages()).toEqual(["setTimeout"]);
    vi.useRealTimers();
  });
  test("setInterval", async () => {
    const order = new Order();
    vi.useFakeTimers();
    const interval = setInterval(() => {
      order.add("setInterval");
    }, 10);
    expect(order.takeOrderMessages()).toEqual([]);
    vi.advanceTimersToNextTimer();
    expect(order.takeOrderMessages()).toEqual(["setInterval"]);
    vi.advanceTimersToNextTimer();
    expect(order.takeOrderMessages()).toEqual(["setInterval"]);
    clearInterval(interval);
    vi.advanceTimersToNextTimer();
    expect(order.takeOrderMessages()).toEqual([]);
    vi.useRealTimers();
  });
  test("sorted timeouts", async () => {
    const order = new Order();
    vi.useFakeTimers();
    setTimeout(() => {
      order.add("10");
    }, 10);
    setTimeout(() => {
      order.add("9");
      setTimeout(() => order.add("14"), 5);
    }, 9);
    setTimeout(() => {
      order.add("20");
    }, 20);
    expect(order.takeOrderMessages()).toEqual([]);
    vi.advanceTimersToNextTimer();
    expect(order.takeOrderMessages()).toEqual(["9"]);
    vi.advanceTimersToNextTimer();
    expect(order.takeOrderMessages()).toEqual(["10"]);
    vi.advanceTimersToNextTimer();
    expect(order.takeOrderMessages()).toEqual(["14"]);
    vi.advanceTimersToNextTimer();
    expect(order.takeOrderMessages()).toEqual(["20"]);
    vi.advanceTimersToNextTimer();
    expect(order.takeOrderMessages()).toEqual([]);
    vi.useRealTimers();
  });
  test("alternating intervals", async () => {
    vi.useFakeTimers();
    const order = new Order();
    setInterval(() => {
      order.add("setInterval 1");
    }, 9);
    setInterval(() => {
      order.add("setInterval 2");
    }, 10);
    expect(order.takeOrderMessages()).toEqual([]);
    vi.advanceTimersToNextTimer();
    expect(order.takeOrderMessages()).toEqual(["setInterval 1"]);
    vi.advanceTimersToNextTimer();
    expect(order.takeOrderMessages()).toEqual(["setInterval 2"]);
    vi.advanceTimersToNextTimer();
    expect(order.takeOrderMessages()).toEqual(["setInterval 1"]);
    vi.advanceTimersToNextTimer();
    expect(order.takeOrderMessages()).toEqual(["setInterval 2"]);
    vi.useRealTimers();
  });
});
describe("advanceTimersByTime", () => {
  test("setInterval", () => {
    vi.useFakeTimers();
    const order = new Order();

    const interval = setInterval(() => {
      order.add("setInterval");
    }, 6);
    vi.advanceTimersByTime(10);
    expect(order.takeOrderMessages()).toEqual(["setInterval"]);
    vi.advanceTimersByTime(10);
    expect(order.takeOrderMessages()).toEqual(["setInterval", "setInterval"]);
    clearInterval(interval);
    vi.advanceTimersByTime(10);
    expect(order.takeOrderMessages()).toEqual([]);
    vi.useRealTimers();
  });

  test.each([NaN, -1, Infinity, 2 ** 32])("advanceTimersByTime(%p) throws and does not move the clock", ms => {
    vi.useFakeTimers({ now: 1000 });
    expect(() => vi.advanceTimersByTime(ms)).toThrow("ms is out of range. It must be >= 0 and <= 4294967295");
    expect(Date.now()).toBe(1000);
    expect(performance.now()).toBe(0);
  });
});
describe("runOnlyPendingTimers", () => {
  test("two setIntervals", () => {
    vi.useFakeTimers();
    const order = new Order();
    setInterval(() => order.add("100"), 100);
    setInterval(() => order.add("24"), 24);
    expect(order.takeOrderMessages()).toEqual([]);
    vi.runOnlyPendingTimers();
    expect(order.takeOrderMessages()).toEqual(["24", "24", "24", "24", "100"]);
    vi.runOnlyPendingTimers();
    expect(order.takeOrderMessages()).toEqual(["24", "24", "24", "24", "100"]);
    vi.useRealTimers();
  });
});
describe("runAllTimers", () => {
  test("two setIntervals", () => {
    vi.useFakeTimers();
    const order = new Order();
    setTimeout(() => {
      order.add("10");
    }, 10);
    setTimeout(() => {
      order.add("9");
      setTimeout(() => order.add("14"), 5);
    }, 9);
    setTimeout(() => {
      order.add("20");
    }, 20);
    expect(order.takeOrderMessages()).toEqual([]);
    vi.runAllTimers();
    expect(order.takeOrderMessages()).toEqual(["9", "10", "14", "20"]);
  });

  test("throws once timerLimit timers have run and more remain", () => {
    vi.useFakeTimers({ timerLimit: 2 });
    const fired: number[] = [];
    for (const ms of [10, 20, 30]) setTimeout(() => fired.push(ms), ms);
    expect(() => vi.runAllTimers()).toThrow("Aborting after running 2 timers, assuming an infinite loop!");
    expect({ fired, remaining: vi.getTimerCount() }).toEqual({ fired: [10, 20], remaining: 1 });
  });

  test.each([
    ["below", 2],
    ["at", 3],
  ])("does not throw when the last timer runs %s timerLimit", (_where, count) => {
    vi.useFakeTimers({ timerLimit: 3 });
    let fires = 0;
    const tick = () => {
      if (++fires < count) setTimeout(tick, 10);
    };
    setTimeout(tick, 10);
    expect(vi.runAllTimers()).toBe(vi);
    expect({ fires, remaining: vi.getTimerCount() }).toEqual({ fires: count, remaining: 0 });
  });

  test("each useFakeTimers() call starts from the default timerLimit", () => {
    vi.useFakeTimers({ timerLimit: 1 });
    vi.useFakeTimers();
    const fired: number[] = [];
    for (const ms of [10, 20, 30]) setTimeout(() => fired.push(ms), ms);
    vi.runAllTimers();
    expect(fired).toEqual([10, 20, 30]);
  });

  // Each source re-arms itself on every fire, so the heap never empties. It
  // gives up after `giveUpAfter` fires only so that a build without the limit
  // fails the assertion instead of spinning inside runAllTimers(), where no
  // test timeout can interrupt it.
  const giveUpAfter = 1000;
  test.each<[string, (keepGoing: () => boolean) => void]>([
    [
      "setInterval",
      keepGoing => {
        const id = setInterval(() => {
          if (!keepGoing()) clearInterval(id);
        }, 10);
      },
    ],
    [
      "a recursive setTimeout",
      keepGoing => {
        const tick = () => {
          if (keepGoing()) setTimeout(tick, 10);
        };
        setTimeout(tick, 10);
      },
    ],
    [
      "Bun.cron",
      keepGoing => {
        const job = Bun.cron("* * * * *", () => {
          if (!keepGoing()) job.stop();
        });
      },
    ],
  ])("throws after timerLimit timers when %s re-arms itself forever", (_name, start) => {
    vi.useFakeTimers({ timerLimit: 50 });
    let fires = 0;
    start(() => ++fires < giveUpAfter);
    expect(() => vi.runAllTimers()).toThrow("Aborting after running 50 timers, assuming an infinite loop!");
    expect({ fires, remaining: vi.getTimerCount() }).toEqual({ fires: 50, remaining: 1 });
  });

  // 100000 timers take about 12 seconds in a debug build, so this runs on
  // plain release builds only. runAllTimersAsync() has the same limit.
  test.skipIf(isDebug || isASAN)("the default timerLimit is 100000", () => {
    vi.useFakeTimers();
    let fires = 0;
    const tick = () => {
      if (++fires <= 100_000) setTimeout(tick, 1);
    };
    setTimeout(tick, 1);
    expect(() => vi.runAllTimers()).toThrow("Aborting after running 100000 timers, assuming an infinite loop!");
    expect({ fires, remaining: vi.getTimerCount() }).toEqual({ fires: 100_000, remaining: 1 });
  });

  describe("the limit option of useFakeTimers()", () => {
    const threeTimers = () => {
      const fired: number[] = [];
      for (const ms of [10, 20, 30]) setTimeout(() => fired.push(ms), ms);
      return fired;
    };
    const options = (option: "timerLimit" | "loopLimit", limit: unknown) =>
      ({ [option]: limit }) as { timerLimit?: number; loopLimit?: number };

    // `timerLimit` is the name in Jest, `loopLimit` the name in Vitest.
    test.each(["timerLimit", "loopLimit"] as const)("%s is the limit", option => {
      vi.useFakeTimers(options(option, 2));
      const fired = threeTimers();
      expect(() => vi.runAllTimers()).toThrow("Aborting after running 2 timers, assuming an infinite loop!");
      expect(fired).toEqual([10, 20]);
    });

    test("timerLimit wins over loopLimit", () => {
      vi.useFakeTimers({ timerLimit: 1, loopLimit: 2 });
      const fired = threeTimers();
      expect(() => vi.runAllTimers()).toThrow("Aborting after running 1 timers, assuming an infinite loop!");
      expect(fired).toEqual([10]);
    });

    // Jest: `timerLimit || 100_000`.
    test.each(["timerLimit", "loopLimit"] as const)("%s: 0 is the default, not a limit of no timers", option => {
      vi.useFakeTimers(options(option, 0));
      const fired = threeTimers();
      vi.runAllTimers();
      expect(fired).toEqual([10, 20, 30]);
    });

    test("a fraction is cut off", () => {
      vi.useFakeTimers({ timerLimit: 2.9 });
      const fired = threeTimers();
      expect(() => vi.runAllTimers()).toThrow("Aborting after running 2 timers, assuming an infinite loop!");
      expect(fired).toEqual([10, 20]);
    });

    test.each(["timerLimit", "loopLimit"] as const)("%s out of range throws", option => {
      for (const limit of [-1, NaN, Infinity, 2 ** 32]) {
        expect(() => vi.useFakeTimers(options(option, limit))).toThrow(
          `'${option}' is out of range. It must be >= 0 and <= 4294967295`,
        );
        expect(vi.isFakeTimers()).toBe(false);
      }
    });

    test.each(["timerLimit", "loopLimit"] as const)("%s that is not a number throws", option => {
      for (const limit of ["10", null, {}, true]) {
        expect(() => vi.useFakeTimers(options(option, limit))).toThrow(`'${option}' must be a number of timers`);
        expect(vi.isFakeTimers()).toBe(false);
      }
    });
  });
});
describe("getTimerCount", () => {
  test("returns correct count of pending timers", () => {
    vi.useFakeTimers();
    expect(vi.getTimerCount()).toBe(0);
    setTimeout(() => {}, 10);
    expect(vi.getTimerCount()).toBe(1);
    setTimeout(() => {}, 20);
    expect(vi.getTimerCount()).toBe(2);
    const interval = setInterval(() => {}, 30);
    expect(vi.getTimerCount()).toBe(3);
    vi.advanceTimersToNextTimer();
    expect(vi.getTimerCount()).toBe(2);
    clearInterval(interval);
    expect(vi.getTimerCount()).toBe(1);
    vi.runAllTimers();
    expect(vi.getTimerCount()).toBe(0);
  });
  test("throws error if fake timers not active", () => {
    expect(() => vi.getTimerCount()).toThrow("Fake timers are not active");
  });

  // Only Linux applies `ulimit -s` to the main thread's stack.
  test.skipIf(!isLinux)("walks a deep timer heap without overflowing the stack", async () => {
    // Debug builds need 0.1 ms to create a timer, and their bigger frames overflow sooner.
    const N = isDebug ? 5_000 : 10_000;
    const script = `
      import { jest } from "bun:test";
      jest.useFakeTimers();
      // Decreasing deadlines link the timers into a single chain of child nodes.
      // Bun.sleep() timers fire without calling into JS.
      const sleeps = [];
      for (let i = 0; i < ${N}; i++) sleeps.push(Bun.sleep(${N} - i));
      let pending, left;
      // At the deepest JS frame, native code has about 128 KB of stack to work with.
      (function dive() {
        try {
          dive();
        } catch {
          pending ??= jest.getTimerCount();
          left ??= jest.runOnlyPendingTimers().getTimerCount();
        }
      })();
      jest.useRealTimers();
      await Promise.all(sleeps);
      console.log("pending", pending, "left", left);
    `;
    await using proc = Bun.spawn({
      // JavaScriptCore caps JS frames at 5 MB of stack. With a smaller stack,
      // the recursion above reaches the real end of the stack.
      cmd: ["sh", "-c", 'ulimit -s 4096 && exec "$0" -e "$1"', bunExe(), script],
      // The environment also lives on that stack, and JavaScriptCore doesn't account for it.
      env: Object.fromEntries(Object.entries(bunEnv).filter(([name]) => /^BUN_|SAN_OPTIONS$/.test(name))),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect(stdout).toBe(`pending ${N} left 0\n`);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });
});
describe("clearAllTimers", () => {
  test("clears all pending timers", () => {
    vi.useFakeTimers();
    const order = new Order();
    setTimeout(() => order.add("1"), 10);
    setTimeout(() => order.add("2"), 20);
    setInterval(() => order.add("3"), 30);
    expect(vi.getTimerCount()).toBe(3);
    expect(vi.clearAllTimers()).toBe(vi);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(100);
    expect(order.takeOrderMessages()).toEqual([]);
  });
  test("throws error if fake timers not active", () => {
    expect(() => vi.clearAllTimers()).toThrow("Fake timers are not active");
  });
});
describe("AbortSignal.timeout", () => {
  const N = 500;

  function liveAbortSignals(): number {
    Bun.gc(true);
    Bun.gc(true);
    return heapStats().objectTypeCounts.AbortSignal ?? 0;
  }

  // A pending timeout signal with an abort listener is kept alive by the
  // runtime itself (the listener has to run when the timer fires), so with no
  // JS reference to them these wrappers live exactly as long as the runtime
  // believes their timer is still pending. The bounds below leave room for the
  // odd wrapper that conservative stack scanning keeps alive or lets go of.
  function leakObservedTimeouts() {
    for (let i = 0; i < N; i++) {
      AbortSignal.timeout(1_000_000).addEventListener("abort", () => {});
    }
  }

  test("pending signals stay alive while the fake heap holds their timer", () => {
    vi.useFakeTimers();
    const before = liveAbortSignals();
    leakObservedTimeouts();
    expect(vi.getTimerCount()).toBe(N);
    expect(liveAbortSignals() - before).toBeGreaterThan(N * 0.9);
  });

  // useRealTimers() and clearAllTimers() drop the pending fake timers, so these
  // signals can never abort anymore and nothing should keep them alive. They
  // used to stay pinned (with their listeners) for the rest of the process.
  test("useRealTimers() releases the signals whose timers it dropped", () => {
    const before = liveAbortSignals();
    vi.useFakeTimers();
    leakObservedTimeouts();
    vi.useRealTimers();
    expect(liveAbortSignals() - before).toBeLessThan(N * 0.1);
  });

  test("clearAllTimers() releases the signals whose timers it cleared", () => {
    vi.useFakeTimers();
    const before = liveAbortSignals();
    leakObservedTimeouts();
    vi.clearAllTimers();
    expect(vi.getTimerCount()).toBe(0);
    expect(liveAbortSignals() - before).toBeLessThan(N * 0.1);
  });

  test("a signal the program still holds is left unaborted once its fake timer is dropped", () => {
    vi.useFakeTimers();
    const signal = AbortSignal.timeout(1);
    vi.useRealTimers();
    const dependent = AbortSignal.any([signal]);
    signal.addEventListener("abort", () => {});
    liveAbortSignals();
    expect({ aborted: signal.aborted, dependentAborted: dependent.aborted }).toEqual({
      aborted: false,
      dependentAborted: false,
    });
  });

  test("fires through advanceTimersByTime", () => {
    vi.useFakeTimers();
    const signal = AbortSignal.timeout(1000);
    const reasons: string[] = [];
    signal.addEventListener("abort", () => reasons.push(signal.reason.name));
    vi.advanceTimersByTime(999);
    expect({ aborted: signal.aborted, reasons }).toEqual({ aborted: false, reasons: [] });
    vi.advanceTimersByTime(1);
    expect({ aborted: signal.aborted, reasons }).toEqual({ aborted: true, reasons: ["TimeoutError"] });
  });
});
// A timer that a fake timer's callback arms with no delay is scheduled 1ms
// later, as in @sinonjs/fake-timers. At the current instant it is due again
// within the advanceTimersByTime() / runOnlyPendingTimers() call that runs the
// callback, and a callback that re-arms itself that way keeps the call from
// ever returning. setTimeout(fn, 0) is always 1ms; AbortSignal.timeout(0) and
// Bun.sleep(0) are the timers that can have no delay.
describe("a zero-delay timer armed by a timer callback", () => {
  // Ends a chain of re-armed timers, so a drain that keeps firing them at one
  // instant fails an assertion and does not spin.
  const GIVE_UP = 50;

  describe("AbortSignal.timeout(0) re-armed by its own abort listener", () => {
    /** Returns `performance.now()` at each abort. */
    function rearmOnAbort(): number[] {
      const abortedAt: number[] = [];
      const arm = () =>
        AbortSignal.timeout(0).addEventListener("abort", () => {
          abortedAt.push(performance.now());
          if (abortedAt.length < GIVE_UP) arm();
        });
      arm();
      return abortedAt;
    }

    test("advanceTimersByTime() fires it once per millisecond", () => {
      vi.useFakeTimers();
      const abortedAt = rearmOnAbort();
      vi.advanceTimersByTime(3);
      expect({ abortedAt, now: performance.now(), pending: vi.getTimerCount() }).toEqual({
        abortedAt: [0, 1, 2, 3],
        now: 3,
        pending: 1,
      });
    });

    test("runOnlyPendingTimers() fires the pending one only", () => {
      vi.useFakeTimers();
      const abortedAt = rearmOnAbort();
      vi.runOnlyPendingTimers();
      expect({ abortedAt, now: performance.now(), pending: vi.getTimerCount() }).toEqual({
        abortedAt: [0],
        now: 0,
        pending: 1,
      });
    });

    test("advanceTimersToNextTimer() moves the clock to the re-armed one", () => {
      vi.useFakeTimers();
      const abortedAt = rearmOnAbort();
      vi.advanceTimersToNextTimer();
      vi.advanceTimersToNextTimer();
      expect({ abortedAt, now: performance.now(), pending: vi.getTimerCount() }).toEqual({
        abortedAt: [0, 1],
        now: 1,
        pending: 1,
      });
    });

    test("a nested advanceTimersToNextTimer() in the listener, before it re-arms", () => {
      vi.useFakeTimers();
      const abortedAt: number[] = [];
      const arm = () => {
        AbortSignal.timeout(0).addEventListener("abort", () => {
          abortedAt.push(performance.now());
          // Fires `other` and returns into this listener, which still runs.
          vi.advanceTimersToNextTimer();
          if (abortedAt.length < GIVE_UP) arm();
        });
        // `other`: due at the same instant, after the one above.
        AbortSignal.timeout(0).addEventListener("abort", () => {});
      };
      arm();
      vi.advanceTimersByTime(1);
      expect({ abortedAt, now: performance.now(), pending: vi.getTimerCount() }).toEqual({
        abortedAt: [0, 1],
        now: 1,
        pending: 2,
      });
    });
  });

  // A jest timer control runs the microtasks of a timer before the next timer
  // only when no event loop task is on the stack. The first tests of a file run
  // that way, so the loop gets a test file of its own.
  test("a `while (..) await Bun.sleep(0)` loop ends when its condition does", async () => {
    using dir = tempDir("fake-timers-sleep-loop", {
      "sleep-loop.test.ts": `
        import { jest, test } from "bun:test";
        test.each(["advanceTimersByTime", "runOnlyPendingTimers"])("%s", control => {
          jest.useFakeTimers();
          let done = false;
          const polledAt = [];
          setTimeout(() => (done = true), 3);
          (async () => {
            while (!done && polledAt.length < ${GIVE_UP}) {
              polledAt.push(performance.now());
              await Bun.sleep(0);
            }
          })();
          if (control === "advanceTimersByTime") jest.advanceTimersByTime(5);
          else jest.runOnlyPendingTimers();
          console.log(JSON.stringify({ control, polledAt, done, now: performance.now(), pending: jest.getTimerCount() }));
          jest.useRealTimers();
        });
      `,
    });
    await using proc = Bun.spawn({
      cmd: [bunExe(), "test", "sleep-loop.test.ts"],
      env: bunEnv,
      cwd: String(dir),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    const results = stdout
      .split("\n")
      .filter(line => line.startsWith("{"))
      .map(line => JSON.parse(line));
    expect({ results, exitCode }, stderr).toEqual({
      results: [
        { control: "advanceTimersByTime", polledAt: [0, 0, 1, 2], done: true, now: 5, pending: 0 },
        { control: "runOnlyPendingTimers", polledAt: [0, 0, 1, 2], done: true, now: 3, pending: 0 },
      ],
      exitCode: 0,
    });
  });

  test("AbortSignal.timeout(0) fires 1ms after the callback that armed it", () => {
    vi.useFakeTimers();
    let signal!: AbortSignal;
    setTimeout(() => (signal = AbortSignal.timeout(0)), 5);
    vi.advanceTimersByTime(5);
    expect({ aborted: signal.aborted, pending: vi.getTimerCount() }).toEqual({ aborted: false, pending: 1 });
    vi.advanceTimersByTime(1);
    expect({ aborted: signal.aborted, pending: vi.getTimerCount() }).toEqual({ aborted: true, pending: 0 });
  });

  test("Bun.sleep(0) resolves 1ms after the callback that called it", async () => {
    vi.useFakeTimers();
    let sleep!: Promise<void>;
    setTimeout(() => (sleep = Bun.sleep(0)), 5);
    vi.advanceTimersByTime(5);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1);
    expect(vi.getTimerCount()).toBe(0);
    await sleep;
  });

  test("a timer that was already due 1ms later fires before it", () => {
    vi.useFakeTimers();
    const order: string[] = [];
    setTimeout(() => order.push("setTimeout(1)"), 1);
    AbortSignal.timeout(0).addEventListener("abort", () => {
      AbortSignal.timeout(0).addEventListener("abort", () => order.push("timeout(0)"));
    });
    vi.advanceTimersByTime(1);
    expect(order).toEqual(["setTimeout(1)", "timeout(0)"]);
  });

  test("armed outside a timer callback, it is due at the current instant", () => {
    vi.useFakeTimers();
    vi.advanceTimersByTime(5);
    const signal = AbortSignal.timeout(0);
    vi.runOnlyPendingTimers();
    expect({ aborted: signal.aborted, now: performance.now() }).toEqual({ aborted: true, now: 5 });
  });

  // Not a zero delay: a nested timer control in the callback stops the clock
  // on the deadline the interval is then re-armed for.
  test.each([
    { period: 5, nested: 5, advance: 20, firedAt: [5, 10, 15, 20] },
    { period: 1, nested: 0, advance: 4, firedAt: [1, 2, 3, 4] },
  ])(
    "setInterval(fn, $period) re-armed onto the current instant keeps its period",
    ({ period, nested, advance, firedAt }) => {
      vi.useFakeTimers();
      const at: number[] = [];
      const interval = setInterval(() => {
        at.push(performance.now());
        if (at.length === 1) vi.advanceTimersByTime(nested);
      }, period);
      vi.advanceTimersByTime(advance);
      clearInterval(interval);
      expect(at).toEqual(firedAt);
    },
  );
});
// Only the timers a test schedules itself are faked. Timeouts the runtime arms
// for its own purposes keep running on the real clock: getTimerCount() does not
// count them, they fire while fake timers are active, and useRealTimers(), which
// drops every fake timer, does not disarm them.
describe("runtime timeouts are not fake timers", () => {
  // Outlives the 50ms timeout by a wide margin but still exits on its own, so a
  // timeout that never fires shows up as a normal exit instead of a hang.
  const sleepArgs = ["-e", "await Bun.sleep(3000)"];
  const sleepingChild = () => ({
    cmd: [bunExe(), ...sleepArgs],
    env: bunEnv,
    stdout: "ignore" as const,
    stderr: "ignore" as const,
    timeout: 50,
    killSignal: "SIGKILL" as const,
  });

  test("Bun.spawn({ timeout }) kills the child while fake timers are active", async () => {
    vi.useFakeTimers();
    await using proc = Bun.spawn(sleepingChild());
    expect(vi.getTimerCount()).toBe(0);
    await proc.exited;
    expect({ exitCode: proc.exitCode, signalCode: proc.signalCode }).toEqual({ exitCode: null, signalCode: "SIGKILL" });
  });

  test("Bun.spawn({ timeout }) armed under fake timers survives useRealTimers()", async () => {
    vi.useFakeTimers();
    await using proc = Bun.spawn(sleepingChild());
    vi.useRealTimers();
    await proc.exited;
    expect({ exitCode: proc.exitCode, signalCode: proc.signalCode }).toEqual({ exitCode: null, signalCode: "SIGKILL" });
  });

  test("Bun.spawnSync({ timeout }) times out while fake timers are active", () => {
    vi.useFakeTimers();
    const result = Bun.spawnSync(sleepingChild());
    expect({ exitedDueToTimeout: result.exitedDueToTimeout, signalCode: result.signalCode }).toEqual({
      exitedDueToTimeout: true,
      signalCode: "SIGKILL",
    });
  });

  // node:child_process's sync functions hand their timeout to Bun.spawnSync.
  test("child_process.spawnSync({ timeout }) times out while fake timers are active", () => {
    vi.useFakeTimers();
    const result = childProcessSpawnSync(bunExe(), sleepArgs, {
      env: bunEnv,
      stdio: "ignore",
      timeout: 50,
      killSignal: "SIGKILL",
    }) as { signal: NodeJS.Signals | null; error?: NodeJS.ErrnoException };
    expect({ signal: result.signal, code: result.error?.code }).toEqual({ signal: "SIGKILL", code: "ETIMEDOUT" });
  });

  // Accepts connections and never answers, so only the client's own connection
  // timeout can end a connection attempt.
  function silentServer() {
    const accepted = Promise.withResolvers<void>();
    const listener = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open() {
          accepted.resolve();
        },
        data() {},
        close() {},
        error() {},
      },
    });
    return {
      port: listener.port,
      accepted: accepted.promise,
      [Symbol.dispose]() {
        listener.stop(true);
      },
    };
  }

  test.each([
    ["postgres", "ERR_POSTGRES_CONNECTION_TIMEOUT"],
    ["mysql", "ERR_MYSQL_CONNECTION_TIMEOUT"],
  ])("%s connectionTimeout armed under fake timers survives useRealTimers()", async (protocol, code) => {
    using server = silentServer();
    vi.useFakeTimers();
    const db = new SQL({ url: `${protocol}://user:pass@127.0.0.1:${server.port}/db`, connectionTimeout: 0.1, max: 1 });
    try {
      const connecting = db.connect().then(
        () => "connected",
        error => error.code,
      );
      await server.accepted;
      const fakeTimers = vi.getTimerCount();
      vi.useRealTimers();
      expect(fakeTimers).toBe(0);
      expect(await connecting).toBe(code);
    } finally {
      await db.close({ timeout: 0 });
    }
  });

  test("RedisClient connectionTimeout armed under fake timers survives useRealTimers()", async () => {
    using server = silentServer();
    vi.useFakeTimers();
    const client = new RedisClient(`redis://127.0.0.1:${server.port}`, {
      connectionTimeout: 100,
      autoReconnect: false,
    });
    try {
      const command = client.get("key").then(
        () => "replied",
        error => error.code,
      );
      await server.accepted;
      const fakeTimers = vi.getTimerCount();
      vi.useRealTimers();
      expect(fakeTimers).toBe(0);
      expect(await command).toBe("ERR_REDIS_CONNECTION_TIMEOUT");
    } finally {
      client.close();
    }
  });
});

// Deadlines the runtime measures in JS (the connect-retry budget of Bun.SQL) read monotonicNowMs().
test("monotonicNowMs() is not a mocked clock", () => {
  const ONE_HOUR = 60 * 60 * 1000;
  const beforeFakeTimers = timerInternals.monotonicNowMs();
  vi.useFakeTimers();
  const atActivation = timerInternals.monotonicNowMs();
  vi.advanceTimersByTime(ONE_HOUR);
  const afterAdvance = timerInternals.monotonicNowMs();
  expect({
    mockedTimerClock: timerInternals.timerClockMs(),
    performanceNow: performance.now(),
    // the mocked clocks restart from 0 on activation
    restarted: atActivation < beforeFakeTimers,
    advancedByTheHour: afterAdvance - atActivation >= ONE_HOUR,
  }).toEqual({
    mockedTimerClock: ONE_HOUR,
    performanceNow: ONE_HOUR,
    restarted: false,
    advancedByTheHour: false,
  });
});

// Bun.cron() is mockable, so a job created under fake timers lives in the fake
// heap, and useRealTimers() / clearAllTimers() drop it with the rest. Like a
// dropped setInterval it has to end up stopped, rather than holding the process
// open for a timer that can never fire.
describe("Bun.cron() job dropped from the fake heap", () => {
  test.each(["jest.useRealTimers()", "jest.clearAllTimers(); jest.useRealTimers()"])(
    "does not keep the process alive after %s",
    async drop => {
      await using proc = Bun.spawn({
        cmd: [
          bunExe(),
          "-e",
          `const { jest } = Bun.jest();
           jest.useFakeTimers();
           Bun.cron("* * * * *", () => {});
           ${drop};
           console.log("exiting");`,
        ],
        env: bunEnv,
        stdout: "pipe",
        stderr: "pipe",
        // A child that hangs (the bug) is killed rather than left behind.
        timeout: 10_000,
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      expect({ stdout, stderr, exitCode, signalCode: proc.signalCode }).toEqual({
        stdout: "exiting\n",
        stderr: "",
        exitCode: 0,
        signalCode: null,
      });
    },
  );
});
describe("isFakeTimers", () => {
  test("returns true when fake timers are active", () => {
    expect(vi.isFakeTimers()).toBe(false);
    vi.useFakeTimers();
    expect(vi.isFakeTimers()).toBe(true);
    vi.useRealTimers();
    expect(vi.isFakeTimers()).toBe(false);
  });
  test("returns false by default", () => {
    expect(vi.isFakeTimers()).toBe(false);
  });
});
describe("Date.now() mocking", () => {
  test("Date.now() before and after vi.useFakeTimers() should be roughly equal", () => {
    const beforeFake = Date.now();
    vi.useFakeTimers();
    const afterFake = Date.now();

    // The fake time should start at approximately the real time
    // Allow a tolerance of 100ms for the time it takes to call useFakeTimers()
    const diff = Math.abs(afterFake - beforeFake);
    expect(diff).toBeLessThan(100);
  });

  test("Date.now() should be mocked when fake timers are active", () => {
    vi.useFakeTimers();
    const start = Date.now();

    // Advance time by 1000ms
    vi.advanceTimersByTime(1000);

    // Date.now() should reflect the advanced time
    expect(Date.now()).toBe(start + 1000);

    // Advance more time
    vi.advanceTimersByTime(500);
    expect(Date.now()).toBe(start + 1500);
  });

  test("Date.now() returns to real time when fake timers are disabled", () => {
    vi.useFakeTimers();
    const initialFakeTime = Date.now();
    vi.advanceTimersByTime(1000);
    const advancedFakeTime = Date.now();
    expect(advancedFakeTime).toBe(initialFakeTime + 1000);

    vi.useRealTimers();

    // After disabling fake timers, Date.now() should return real time
    // The real time should be close to when we started (within a few ms)
    // It should NOT be the advanced fake time
    const realNow = Date.now();
    // Allow 1ms tolerance for rounding
    expect(Math.abs(realNow - initialFakeTime)).toBeLessThan(10);
    expect(realNow).toBeLessThan(advancedFakeTime); // Real time hasn't advanced as much as fake time
  });

  test("Date.now() advances with advanceTimersToNextTimer", () => {
    vi.useFakeTimers();
    const start = Date.now();

    setTimeout(() => {}, 100);
    setTimeout(() => {}, 200);

    vi.advanceTimersToNextTimer();
    expect(Date.now()).toBe(start + 100);

    vi.advanceTimersToNextTimer();
    expect(Date.now()).toBe(start + 200);
  });

  test("Date.now() is consistent with timer callbacks", () => {
    vi.useFakeTimers();
    const start = Date.now();
    let capturedTime = 0;

    setTimeout(() => {
      capturedTime = Date.now();
    }, 500);

    vi.advanceTimersByTime(500);

    // The time captured in the callback should match
    expect(capturedTime).toBe(start + 500);
    expect(Date.now()).toBe(start + 500);
  });
});

describe("timer controls called from inside a timer callback", () => {
  const T0 = 1_000_000;

  test("runOnlyPendingTimers() in a setInterval callback doesn't move the clock backwards", () => {
    vi.useFakeTimers({ now: T0 });
    const seen: [string, number, number][] = [];
    let n = 0;
    const interval = setInterval(() => {
      n++;
      seen.push(["interval " + n, Date.now() - T0, performance.now()]);
      vi.runOnlyPendingTimers();
    }, 1);
    setTimeout(() => seen.push(["timeout", Date.now() - T0, performance.now()]), 10);
    vi.advanceTimersByTime(10);
    // Tick 1 fires the 10 ms timeout. Tick 2 was due at 2, so it fires late at 10.
    expect(seen).toEqual([
      ["interval 1", 1, 1],
      ["timeout", 10, 10],
      ["interval 2", 10, 10],
    ]);
    expect(Date.now() - T0).toBe(10);
    clearInterval(interval);
    vi.useRealTimers();
  });

  test("a nested advanceTimersByTime() in a setTimeout callback doesn't move the clock backwards", () => {
    vi.useFakeTimers({ now: T0 });
    setTimeout(() => vi.advanceTimersByTime(100), 5);
    vi.advanceTimersByTime(10);
    expect(Date.now() - T0).toBe(105);
    expect(performance.now()).toBe(105);
    vi.useRealTimers();
  });
});

test("useRealTimers() called from a timer callback isn't undone when the advance completes", () => {
  const realBefore = performance.now();
  vi.useFakeTimers({ now: 0 });
  setTimeout(() => vi.useRealTimers(), 10);
  vi.advanceTimersByTime(100);
  expect(vi.isFakeTimers()).toBe(false);
  expect(Date.now()).toBeGreaterThan(1e12);
  expect(performance.now()).toBeGreaterThanOrEqual(realBefore);
});

test("workers with fake timers don't share a clock", async () => {
  // Each worker sets its own system time, runs its pending timers and then checks Date.now().
  const workerSrc = /* js */ `
    const { jest } = Bun.jest(__filename);
    const { parentPort, workerData } = require("worker_threads");
    const { now, target } = workerData;
    const mismatches = [];
    for (let r = 0; r < 400; r++) {
      jest.useFakeTimers({ now });
      let n = 0;
      setTimeout(() => n++, 1000);
      const iv = setInterval(() => { if (n++ > 3) clearInterval(iv); }, 100);
      jest.setSystemTime(target);
      jest.runOnlyPendingTimers();
      const after = Date.now();
      if (after !== target + 1000) mismatches.push({ round: r, after, expected: target + 1000 });
      jest.useRealTimers();
    }
    parentPort.postMessage(mismatches);
  `;
  const mainSrc = /* js */ `
    const { Worker } = require("worker_threads");
    const results = {};
    const configs = [{ now: 0, target: 1e12 }, { now: 2 ** 40, target: 0 }];
    let done = 0;
    for (const workerData of configs) {
      const w = new Worker(${JSON.stringify(workerSrc)}, { eval: true, workerData });
      w.on("error", err => { console.error(err); process.exit(1); });
      w.on("message", mismatches => {
        results[workerData.now] = mismatches;
        if (++done === configs.length) {
          console.log(JSON.stringify(results));
          process.exit(0);
        }
      });
    }
  `;
  await using proc = Bun.spawn({
    cmd: [bunExe(), "-e", mainSrc],
    env: bunEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  expect(stderr).toBe("");
  expect(JSON.parse(stdout)).toEqual({ "0": [], [2 ** 40]: [] });
  expect(exitCode).toBe(0);
});

describe("performance.now() mocking", () => {
  test("performance.now() should be mocked when fake timers are active", () => {
    vi.useFakeTimers();
    const start = performance.now();

    // Advance time by 1000ms
    vi.advanceTimersByTime(1000);

    // performance.now() should reflect the advanced time
    expect(performance.now()).toBe(1000);

    // Advance more time
    vi.advanceTimersByTime(500);
    expect(performance.now()).toBe(1500);
  });

  test("performance.now() returns to real time when fake timers are disabled", () => {
    const initialRealTime = performance.now();
    vi.useFakeTimers();
    const initialFakeTime = performance.now();
    expect(initialFakeTime).toBe(0);
    vi.advanceTimersByTime(1000);
    const advancedFakeTime = performance.now();
    expect(advancedFakeTime).toBe(1000);

    vi.useRealTimers();

    // After disabling fake timers, performance.now() should return real time
    const realNow = performance.now();
    expect(realNow - initialRealTime).toBeLessThan(100);
  });

  test("performance.now() advances with advanceTimersToNextTimer", () => {
    vi.useFakeTimers();
    const start = performance.now();

    setTimeout(() => {}, 100);
    setTimeout(() => {}, 200);

    vi.advanceTimersToNextTimer();
    expect(performance.now()).toBe(start + 100);

    vi.advanceTimersToNextTimer();
    expect(performance.now()).toBe(start + 200);
  });

  test("performance.now() is consistent with timer callbacks", () => {
    vi.useFakeTimers();
    const start = performance.now();
    let capturedTime = 0;

    setTimeout(() => {
      capturedTime = performance.now();
    }, 500);

    vi.advanceTimersByTime(500);

    // The time captured in the callback should match
    expect(capturedTime).toBe(start + 500);
    expect(performance.now()).toBe(start + 500);
  });

  test("performance.now() and Date.now() are both mocked consistently", () => {
    vi.useFakeTimers();
    const perfStart = performance.now();
    const dateStart = Date.now();

    vi.advanceTimersByTime(1000);

    // Both should have advanced by the same amount
    expect(performance.now()).toBe(perfStart + 1000);
    expect(Date.now()).toBe(dateStart + 1000);

    vi.advanceTimersByTime(500);
    expect(performance.now()).toBe(perfStart + 1500);
    expect(Date.now()).toBe(dateStart + 1500);
  });

  test("performance.timeOrigin follows the fake clock", () => {
    const realTimeOrigin = performance.timeOrigin;
    const fakeNow = new Date("2000-01-01T00:00:00.000Z").getTime();
    vi.useFakeTimers({ now: fakeNow });

    // performance.now() restarts at 0, so the fake epoch is the origin.
    expect(performance.now()).toBe(0);
    expect(performance.timeOrigin).toBe(fakeNow);
    expect(performance.timeOrigin + performance.now()).toBe(Date.now());

    vi.advanceTimersByTime(5000);
    expect(performance.timeOrigin).toBe(fakeNow);
    expect(performance.timeOrigin + performance.now()).toBe(Date.now());

    // setSystemTime moves Date.now() but not performance.now(), so the origin moves with it.
    const jumped = new Date("2010-06-15T12:00:00.000Z").getTime();
    setSystemTime(jumped);
    expect(Date.now()).toBe(jumped);
    expect(performance.now()).toBe(5000);
    expect(performance.timeOrigin).toBe(jumped - 5000);
    expect(performance.timeOrigin + performance.now()).toBe(Date.now());
    expect(performance.toJSON().timeOrigin).toBe(performance.timeOrigin);

    vi.useRealTimers();
    expect(performance.timeOrigin).toBe(realTimeOrigin);
  });

  test("performance.timeOrigin is not affected by setSystemTime without fake timers", () => {
    const realTimeOrigin = performance.timeOrigin;
    setSystemTime(new Date("2000-01-01T00:00:00.000Z"));
    expect(new Date().getUTCFullYear()).toBe(2000);
    expect(performance.timeOrigin).toBe(realTimeOrigin);
    setSystemTime();
  });

  // setSystemTime() with no argument, NaN, or an Invalid Date resets Date.now()
  // to the real clock. The origin goes back to real with it.
  test.each([undefined, NaN, new Date(NaN)])(
    "setSystemTime(%p) under fake timers resets performance.timeOrigin too",
    reset => {
      const realTimeOrigin = performance.timeOrigin;
      const realBefore = Date.now();
      vi.useFakeTimers({ now: 5000 });
      expect(performance.timeOrigin).toBe(5000);

      setSystemTime(reset);
      expect(Date.now()).toBeGreaterThanOrEqual(realBefore);
      expect(performance.timeOrigin).toBe(realTimeOrigin);
      expect(performance.toJSON().timeOrigin).toBe(realTimeOrigin);

      // The next tick of the fake clock overrides Date.now() again, and the origin follows it.
      vi.advanceTimersByTime(1000);
      expect(Date.now()).toBe(6000);
      expect(performance.timeOrigin).toBe(5000);
      expect(performance.timeOrigin + performance.now()).toBe(Date.now());
    },
  );

  test.each([Infinity, -Infinity])("setSystemTime(%p) throws and leaves the clocks alone", ms => {
    const realBefore = Date.now();
    expect(() => setSystemTime(ms)).toThrow("setSystemTime() expects a finite number or a Date");
    expect(Date.now()).toBeGreaterThanOrEqual(realBefore);

    vi.useFakeTimers({ now: 5000 });
    expect(() => setSystemTime(ms)).toThrow("setSystemTime() expects a finite number or a Date");
    expect(Date.now()).toBe(5000);
    expect(performance.timeOrigin).toBe(5000);
  });
});

describe("useFakeTimers with options", () => {
  test("useFakeTimers({ now: number }) sets Date.now() to the specified value", () => {
    const targetTime = 1000000000000; // January 9, 2001
    vi.useFakeTimers({ now: targetTime });

    expect(Date.now()).toBe(targetTime);

    // Advance time and verify it continues from that point
    vi.advanceTimersByTime(1000);
    expect(Date.now()).toBe(targetTime + 1000);
  });

  test("useFakeTimers({ now: Date }) sets Date.now() to the Date's timestamp", () => {
    const targetDate = new Date("2001-01-09T00:00:00.000Z");
    const targetTime = targetDate.getTime();
    vi.useFakeTimers({ now: targetDate });

    expect(Date.now()).toBe(targetTime);

    // Advance time and verify it continues from that point
    vi.advanceTimersByTime(5000);
    expect(Date.now()).toBe(targetTime + 5000);
  });

  test("useFakeTimers({ now: 0 }) sets Date.now() to epoch", () => {
    vi.useFakeTimers({ now: 0 });

    expect(Date.now()).toBe(0);

    vi.advanceTimersByTime(100);
    expect(Date.now()).toBe(100);
  });

  test("useFakeTimers without options uses current time", () => {
    const beforeFake = Date.now();
    vi.useFakeTimers();
    const afterFake = Date.now();

    // Should start at approximately the current real time
    const diff = Math.abs(afterFake - beforeFake);
    expect(diff).toBeLessThan(100);
  });

  test("timers scheduled with custom now work correctly", () => {
    const targetTime = 5000000000000;
    vi.useFakeTimers({ now: targetTime });

    const order: string[] = [];

    setTimeout(() => {
      order.push("first");
      expect(Date.now()).toBe(targetTime + 100);
    }, 100);

    setTimeout(() => {
      order.push("second");
      expect(Date.now()).toBe(targetTime + 200);
    }, 200);

    expect(order).toEqual([]);

    vi.advanceTimersByTime(100);
    expect(order).toEqual(["first"]);

    vi.advanceTimersByTime(100);
    expect(order).toEqual(["first", "second"]);
  });

  test("performance.now() starts at 0 regardless of custom now", () => {
    const targetTime = 1000000000000;
    vi.useFakeTimers({ now: targetTime });

    // performance.now() should still start at 0
    expect(performance.now()).toBe(0);

    vi.advanceTimersByTime(500);
    expect(performance.now()).toBe(500);
    expect(Date.now()).toBe(targetTime + 500);
  });

  test.each(["modern", "legacy"] as const)("useFakeTimers(%j) accepts legacy Jest string argument", implementation => {
    expect(() => vi.useFakeTimers(implementation as any)).not.toThrow();
    expect(vi.isFakeTimers()).toBe(true);
    vi.useRealTimers();
    expect(vi.isFakeTimers()).toBe(false);
  });

  test("useFakeTimers still rejects non-string non-object arguments", () => {
    expect(() => vi.useFakeTimers(123 as any)).toThrow("useFakeTimers() expects an options object");
    expect(vi.isFakeTimers()).toBe(false);
  });

  // NaN is the "no override" sentinel of the Date.now() override. A NaN clock
  // left Date.now() real while performance.timeOrigin read NaN.
  test.each([NaN, Infinity, -Infinity, new Date(NaN)])("useFakeTimers({ now: %p }) throws", now => {
    const realTimeOrigin = performance.timeOrigin;
    expect(() => vi.useFakeTimers({ now })).toThrow("'now' must be a finite number or a valid Date");
    expect(vi.isFakeTimers()).toBe(false);
    expect(performance.timeOrigin).toBe(realTimeOrigin);
    expect(performance.toJSON().timeOrigin).toBe(realTimeOrigin);
  });
});

// The async controls wait a turn of the real event loop before the first timer
// and after each timer they fire, so what awaits a timer has run before the
// next timer fires. A sync control cannot do that from a promise callback,
// which is where the body of an async test runs after its first real await.
describe("async timer controls", () => {
  const controls = [
    "advanceTimersByTimeAsync",
    "advanceTimersToNextTimerAsync",
    "runAllTimersAsync",
    "runOnlyPendingTimersAsync",
  ] as const;

  /** A turn of the real event loop: `setImmediate` is not a fake timer. */
  const turn = () => new Promise<void>(resolve => setImmediate(resolve));

  /** The message of what `promise` rejects with. */
  const rejection = (promise: Promise<unknown>) =>
    promise.then(
      () => "did not reject",
      (error: Error) => error.message,
    );

  /** Counts the turns of the real event loop until the returned function is called. */
  const countTurns = () => {
    let turns = 0;
    let counting = true;
    const count = () => {
      if (!counting) return;
      turns++;
      setImmediate(count);
    };
    setImmediate(count);
    return () => {
      counting = false;
      return turns;
    };
  };

  /** How much later than now a zero-delay timer is due, when it is armed outside a timer callback. */
  const zeroDelayIsDueIn = () => {
    const before = performance.now();
    const signal = AbortSignal.timeout(0);
    vi.advanceTimersToNextTimer();
    expect(signal.aborted).toBe(true);
    return performance.now() - before;
  };

  test("jest and vi have the same four functions", () => {
    for (const name of controls) {
      expect(vi[name]).toBeFunction();
      expect(jest[name]).toBe(vi[name]);
    }
  });

  test.each(controls)("%s() rejects when fake timers are not active", async name => {
    const promise = vi[name](1);
    expect(promise).toBeInstanceOf(Promise);
    await expect(promise).rejects.toThrow("Fake timers are not active. Call useFakeTimers() first.");
  });

  // As in Vitest and in Jest.
  test.each(controls)("%s() resolves with vi on vi, and with undefined on jest", async name => {
    vi.useFakeTimers();
    expect(await vi[name](1)).toBe(vi);
    expect(await jest[name](1)).toBeUndefined();
    const other = { [name]: vi[name] };
    expect(await other[name](1)).toBeUndefined();
  });

  // The runner calls the first test of a file from outside an event loop
  // task, and every later test from inside one. The async controls take the
  // same turns in both places.
  test("each control in the first test of a file", async () => {
    const fixture = (control: string) => `
      import { jest, test } from "bun:test";
      test("${control}", async () => {
        jest.useFakeTimers();
        const wokeAt = [];
        void (async () => {
          for (let i = 0; i < 3; i++) {
            await new Promise(resolve => setTimeout(resolve, 100));
            wokeAt.push(performance.now());
          }
        })();
        const control = "${control}";
        if (control === "advanceTimersByTimeAsync") await jest[control](300);
        else if (control === "advanceTimersToNextTimerAsync") await jest[control](3);
        else if (control === "runOnlyPendingTimersAsync") for (let i = 0; i < 3; i++) await jest[control]();
        else await jest[control]();
        console.log(JSON.stringify({ control, wokeAt, now: performance.now(), pending: jest.getTimerCount() }));
        jest.useRealTimers();
      });
    `;
    using dir = tempDir(
      "fake-timers-async-first-test",
      Object.fromEntries(controls.map(control => [`${control}.test.ts`, fixture(control)])),
    );
    await using proc = Bun.spawn({
      cmd: [bunExe(), "test"],
      env: bunEnv,
      cwd: String(dir),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    const results = stdout
      .split("\n")
      .filter(line => line.startsWith("{"))
      .map(line => JSON.parse(line))
      .sort((a, b) => a.control.localeCompare(b.control));
    expect({ results, exitCode }, stderr).toEqual({
      results: [...controls].sort().map(control => ({ control, wokeAt: [100, 200, 300], now: 300, pending: 0 })),
      exitCode: 0,
    });
  });

  describe("advanceTimersByTimeAsync", () => {
    test("runs what awaits a timer before the next timer, also from a promise callback", async () => {
      await turn();
      vi.useFakeTimers();
      const wokeAt: number[] = [];
      const loop = (async () => {
        for (let i = 0; i < 3; i++) {
          await new Promise(resolve => setTimeout(resolve, 100));
          wokeAt.push(performance.now());
        }
      })();
      await vi.advanceTimersByTimeAsync(350);
      expect({ wokeAt, now: performance.now(), pending: vi.getTimerCount() }).toEqual({
        wokeAt: [100, 200, 300],
        now: 350,
        pending: 0,
      });
      await loop;
    });

    test("fires the timers of the range in order, and moves the clock to its end", async () => {
      vi.useFakeTimers({ now: 1000 });
      const fired: [string, number][] = [];
      const at = (name: string) => () => void fired.push([name, Date.now()]);
      setTimeout(at("13"), 13);
      setTimeout(at("11"), 11);
      setTimeout(at("100, first"), 100);
      setTimeout(at("100, second"), 100);
      setTimeout(at("101"), 101);
      await vi.advanceTimersByTimeAsync(100);
      expect(fired).toEqual([
        ["11", 1011],
        ["13", 1013],
        ["100, first", 1100],
        ["100, second", 1100],
      ]);
      expect({ now: Date.now(), pending: vi.getTimerCount() }).toEqual({ now: 1100, pending: 1 });
    });

    // sinon: "fires promise timers in correct order"
    test("a promise callback of an interval sees the time of its own tick", async () => {
      vi.useFakeTimers({ now: 0 });
      const every13: number[] = [];
      const every10: number[] = [];
      setInterval(() => void Promise.resolve().then(() => every13.push(Date.now())), 13);
      setInterval(() => void Promise.resolve().then(() => every10.push(Date.now())), 10);
      await vi.advanceTimersByTimeAsync(500);
      expect({ every13, every10 }).toEqual({
        every13: Array.from({ length: 38 }, (_, i) => (i + 1) * 13),
        every10: Array.from({ length: 50 }, (_, i) => (i + 1) * 10),
      });
    });

    // sinon: "does not fire intervals canceled in a promise"
    test("does not fire an interval that a promise callback cleared", async () => {
      vi.useFakeTimers();
      let calls = 0;
      const interval = setInterval(() => {
        if (++calls === 3) void Promise.resolve().then(() => clearInterval(interval));
      }, 10);
      await vi.advanceTimersByTimeAsync(100);
      expect({ calls, pending: vi.getTimerCount() }).toEqual({ calls: 3, pending: 0 });
    });

    // sinon: "triggers multiple simultaneous timers with zero callAt created in promises"
    test("fires a timer that a promise callback schedules inside the range", async () => {
      vi.useFakeTimers();
      const fired: [string, number][] = [];
      const at = (name: string) => () => void fired.push([name, performance.now()]);
      setTimeout(() => {
        at("first")();
        void Promise.resolve().then(() => setTimeout(at("from a promise"), 5));
      }, 10);
      setTimeout(at("last"), 20);
      await vi.advanceTimersByTimeAsync(20);
      expect(fired).toEqual([
        ["first", 10],
        ["from a promise", 15],
        ["last", 20],
      ]);
    });

    // sinon: "mini integration test"
    test("one advance starts where the last one ended", async () => {
      vi.useFakeTimers();
      const fired: string[] = [];
      setTimeout(() => fired.push("100"), 100);
      setTimeout(() => fired.push("120"), 120);
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(89);
      expect(fired).toEqual([]);
      setTimeout(() => fired.push("99 + 20"), 20);
      await vi.advanceTimersByTimeAsync(1);
      expect(fired).toEqual(["100"]);
      await vi.advanceTimersByTimeAsync(19);
      expect(fired).toEqual(["100", "99 + 20"]);
      await vi.advanceTimersByTimeAsync(1);
      expect(fired).toEqual(["100", "99 + 20", "120"]);
    });

    test("advanceTimersByTimeAsync(0) fires setTimeout(fn, 0), as advanceTimersByTime(0) does", async () => {
      vi.useFakeTimers();
      let fired = false;
      setTimeout(() => (fired = true), 0);
      await vi.advanceTimersByTimeAsync(0);
      expect(fired).toBe(true);
    });

    test.each([NaN, -1, Infinity, 2 ** 32])(
      "advanceTimersByTimeAsync(%p) rejects and does not move the clock",
      async ms => {
        vi.useFakeTimers({ now: 1000 });
        let fired = false;
        setTimeout(() => (fired = true), 1);
        await expect(vi.advanceTimersByTimeAsync(ms)).rejects.toThrow(
          "advanceTimersByTimeAsync() ms is out of range. It must be >= 0 and <= 4294967295",
        );
        expect({ fired, now: Date.now(), pending: vi.getTimerCount() }).toEqual({
          fired: false,
          now: 1000,
          pending: 1,
        });
      },
    );

    test("rejects a value that is not a number", async () => {
      vi.useFakeTimers();
      // @ts-expect-error
      await expect(vi.advanceTimersByTimeAsync("100")).rejects.toThrow(
        "advanceTimersByTimeAsync() expects a number of milliseconds",
      );
      // @ts-expect-error
      await expect(vi.advanceTimersByTimeAsync()).rejects.toThrow(
        "advanceTimersByTimeAsync() expects a number of milliseconds",
      );
    });

    // While an advance is in flight a zero-delay timer is due 1ms later, as it
    // is in a timer callback. A loop that re-arms one from its continuation
    // moves the clock on, and ends.
    test("a `while (..) await Bun.sleep(0)` loop ends when its condition does", async () => {
      vi.useFakeTimers();
      let done = false;
      const polledAt: number[] = [];
      setTimeout(() => (done = true), 3);
      const loop = (async () => {
        while (!done && polledAt.length < 50) {
          polledAt.push(performance.now());
          await Bun.sleep(0);
        }
      })();
      await vi.advanceTimersByTimeAsync(5);
      await loop;
      expect({ polledAt, done, now: performance.now(), pending: vi.getTimerCount() }).toEqual({
        polledAt: [0, 0, 1, 2],
        done: true,
        now: 5,
        pending: 0,
      });
    });

    test("useRealTimers() in a timer callback ends the advance", async () => {
      vi.useFakeTimers();
      const fired: number[] = [];
      setTimeout(() => {
        fired.push(10);
        vi.useRealTimers();
      }, 10);
      setTimeout(() => fired.push(20), 20);
      await vi.advanceTimersByTimeAsync(100);
      expect({ fired, fake: vi.isFakeTimers() }).toEqual({ fired: [10], fake: false });
    });

    test("an advance that useRealTimers() cuts short leaves the next fake clock alone", async () => {
      vi.useFakeTimers();
      const fired = Promise.withResolvers<void>();
      setTimeout(fired.resolve, 10);
      const advance = vi.advanceTimersByTimeAsync(100);
      // The advance has fired the timer, and has the rest of its window to go.
      await fired.promise;
      expect(performance.now()).toBe(10);
      vi.useRealTimers();
      vi.useFakeTimers();
      // No advance is in flight on this clock: a zero-delay timer is due now.
      expect(zeroDelayIsDueIn()).toBe(0);
      await advance;
      expect(performance.now()).toBe(0);
    });

    // The window of an advance is a span of time, not an instant to reach. An
    // advance moves the clock, and with it the windows of the others in flight.
    test("two advances in flight add up", async () => {
      vi.useFakeTimers();
      const fired: number[] = [];
      for (const ms of [10, 20, 30, 40]) setTimeout(() => fired.push(performance.now()), ms);
      await Promise.all([vi.advanceTimersByTimeAsync(30), vi.advanceTimersByTimeAsync(10)]);
      expect({ fired, now: performance.now(), pending: vi.getTimerCount() }).toEqual({
        fired: [10, 20, 30, 40],
        now: 40,
        pending: 0,
      });
    });

    test("a sync advance in a timer callback moves the window with the clock", async () => {
      vi.useFakeTimers();
      setTimeout(() => vi.advanceTimersByTime(100), 10);
      await vi.advanceTimersByTimeAsync(20);
      expect(performance.now()).toBe(120);
    });

    test("a timer that is overdue takes nothing from the window", async () => {
      vi.useFakeTimers();
      const firedAt: number[] = [];
      const interval = setInterval(() => {
        firedAt.push(performance.now());
        // The clock moves to 110. The interval is armed again for 20, which is then overdue.
        if (firedAt.length === 1) vi.advanceTimersByTime(100);
      }, 10);
      await vi.advanceTimersByTimeAsync(20);
      clearInterval(interval);
      expect({ firedAt, now: performance.now() }).toEqual({ firedAt: [10, 110, 120], now: 120 });
    });

    test("the window starts at the clock of the first turn", async () => {
      vi.useFakeTimers();
      const advance = vi.advanceTimersByTimeAsync(10);
      vi.advanceTimersByTime(5);
      await advance;
      expect(performance.now()).toBe(15);
    });

    test("takes a turn of the event loop before the first timer and after each one", async () => {
      vi.useFakeTimers();
      for (const ms of [10, 20, 30]) setTimeout(() => {}, ms);
      const turns = countTurns();
      await vi.advanceTimersByTimeAsync(100);
      expect(turns()).toBe(4);
    });

    // The two orders below are what @sinonjs/fake-timers gives on Node.js,
    // where Jest and Vitest get their async controls from.
    test("an immediate queued after the call runs after the first timer", async () => {
      vi.useFakeTimers();
      const order: string[] = [];
      setTimeout(() => order.push("timer 1"), 10);
      setTimeout(() => order.push("timer 2"), 20);
      const advance = vi.advanceTimersByTimeAsync(100);
      setImmediate(() => order.push("immediate"));
      await advance;
      expect(order).toEqual(["timer 1", "immediate", "timer 2"]);
    });

    test("what a timer callback queues runs before the next timer", async () => {
      vi.useFakeTimers();
      const order: string[] = [];
      setTimeout(() => {
        order.push("timer 1");
        setImmediate(() => order.push("immediate of timer 1"));
        void Promise.resolve().then(() => {
          order.push("promise");
          setImmediate(() => order.push("immediate of the promise"));
        });
        process.nextTick(() => order.push("nextTick"));
      }, 10);
      setTimeout(() => order.push("timer 2"), 20);
      setTimeout(() => order.push("timer 3"), 30);
      await vi.advanceTimersByTimeAsync(100);
      expect(order).toEqual([
        "timer 1",
        "nextTick",
        "promise",
        "immediate of timer 1",
        "timer 2",
        "immediate of the promise",
        "timer 3",
      ]);
    });

    test("fires AbortSignal.timeout()", async () => {
      vi.useFakeTimers();
      const signal = AbortSignal.timeout(50);
      const aborted = new Promise<number>(resolve =>
        signal.addEventListener("abort", () => resolve(performance.now())),
      );
      await vi.advanceTimersByTimeAsync(49);
      expect(signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await aborted).toBe(50);
    });

    // A job with an async callback is scheduled again when the promise of its
    // run settles, so a control that cannot run promise callbacks runs it once.
    test("runs a Bun.cron() job with an async callback every time it is due", async () => {
      await turn();
      vi.useFakeTimers({ now: new Date("2026-01-01T00:00:30Z") });
      const ranAt: string[] = [];
      using job = Bun.cron("* * * * *", async () => {
        await null;
        ranAt.push(new Date().toISOString().slice(11, 19));
      });
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      expect({ ranAt, now: new Date().toISOString().slice(11, 19) }).toEqual({
        ranAt: ["00:01:00", "00:02:00", "00:03:00"],
        now: "00:03:30",
      });
      job.stop();
    });

    test("clearAllTimers() in a timer callback leaves the advance its window", async () => {
      vi.useFakeTimers();
      const fired: number[] = [];
      setTimeout(() => {
        fired.push(10);
        vi.clearAllTimers();
      }, 10);
      setTimeout(() => fired.push(20), 20);
      await vi.advanceTimersByTimeAsync(100);
      expect({ fired, now: performance.now(), fake: vi.isFakeTimers() }).toEqual({ fired: [10], now: 100, fake: true });
    });

    test("useFakeTimers() in a timer callback ends the advance", async () => {
      vi.useFakeTimers();
      const fired: number[] = [];
      setTimeout(() => {
        fired.push(10);
        vi.useFakeTimers();
      }, 10);
      setTimeout(() => fired.push(20), 20);
      await vi.advanceTimersByTimeAsync(100);
      expect({ fired, now: performance.now() }).toEqual({ fired: [10], now: 0 });
    });

    // @testing-library/user-event takes it as `advanceTimers`.
    test("can be called without a receiver", async () => {
      vi.useFakeTimers();
      let fired = false;
      setTimeout(() => (fired = true), 10);
      const { advanceTimersByTimeAsync } = vi;
      expect(await advanceTimersByTimeAsync(10)).toBeUndefined();
      expect(fired).toBe(true);
    });

    test("drives the iterator of timers/promises setInterval()", async () => {
      vi.useFakeTimers();
      const seenAt: number[] = [];
      const loop = (async () => {
        for await (const _ of setIntervalIterator(100)) {
          seenAt.push(performance.now());
          if (seenAt.length === 3) break;
        }
      })();
      await vi.advanceTimersByTimeAsync(350);
      expect(seenAt).toEqual([100, 200, 300]);
      await loop;
    });

    // An advance waits one turn of the event loop for each timer. Code that
    // needs more real turns than that between two timers has not scheduled
    // its next timer when the advance looks for it, and the advance ends.
    test("code that takes real turns between its timers needs one advance for each timer", async () => {
      vi.useFakeTimers();
      const wokeAt: number[] = [];
      let done = false;
      const loop = (async () => {
        for (let i = 0; i < 3; i++) {
          await Bun.sleep(100);
          wokeAt.push(performance.now());
          for (let turns = 0; turns < 3; turns++) await turn();
        }
        done = true;
      })();
      await vi.advanceTimersByTimeAsync(300);
      expect({ wokeAt, now: performance.now() }).toEqual({ wokeAt: [100], now: 300 });
      while (!done) await vi.advanceTimersToNextTimerAsync();
      expect(wokeAt).toEqual([100, 400, 500]);
      await loop;
    });
  });

  test.each(["advanceTimersByTimeAsync", "advanceTimersToNextTimerAsync", "runOnlyPendingTimersAsync"] as const)(
    "after %s() settles, a zero-delay timer is due at once",
    async name => {
      vi.useFakeTimers();
      setTimeout(() => {}, 10);
      await vi[name](10);
      expect(performance.now()).toBe(10);
      expect(zeroDelayIsDueIn()).toBe(0);
    },
  );

  // What keeps the promise and the state of a control alive between two turns is the pending
  // immediate of the next turn.
  describe("garbage collection between the turns", () => {
    const collectEveryTurn = () => {
      let collecting = true;
      let collections = 0;
      const collect = () => {
        if (!collecting) return;
        Bun.gc(true);
        collections++;
        // Garbage of the size of what a control keeps, to take the place of anything that was freed.
        for (let i = 0; i < 2000; i++) void [i, vi, false, undefined, {}];
        setImmediate(collect);
      };
      setImmediate(collect);
      return () => {
        collecting = false;
        return collections;
      };
    };

    test.each(controls)("%s() settles with its value", async name => {
      vi.useFakeTimers();
      let fired = 0;
      for (const ms of [10, 20, 30]) setTimeout(() => fired++, ms);
      const collections = collectEveryTurn();
      const value = await vi[name](name === "advanceTimersToNextTimerAsync" ? 3 : 30);
      expect({ value: value === vi, fired }).toEqual({ value: true, fired: 3 });
      expect(collections()).toBeGreaterThanOrEqual(3);
    });

    test("an advance that nothing holds rejects with what its timer threw", async () => {
      vi.useFakeTimers();
      let outcome = "pending";
      setTimeout(() => {
        throw new Error(["thrown", "at", "10"].join(" "));
      }, 10);
      setTimeout(() => {}, 20);
      const collections = collectEveryTurn();
      void vi.advanceTimersByTimeAsync(30).then(
        () => (outcome = "resolved"),
        (error: Error) => (outcome = `rejected: ${error.message}`),
      );
      while (outcome === "pending") await turn();
      collections();
      expect(outcome).toBe("rejected: thrown at 10");
    });
  });

  // `Bun.ModuleGraph.dispose()` cancels the immediates of the graph, and with them the next turn
  // of an advance that code of the graph started.
  describe("an advance of a Bun.ModuleGraph that is disposed", () => {
    test.each([
      ["advanceTimersByTimeAsync", 1],
      ["runOnlyPendingTimersAsync", 2],
    ] as const)("%s() after %d turns: it stops, and leaves no tick behind", async (name, turns) => {
      vi.useFakeTimers();
      const fired: number[] = [];
      for (const ms of [10, 20, 30, 40, 50]) setTimeout(() => fired.push(ms), ms);
      const graph = new Bun.ModuleGraph();
      let settled = false;
      void graph.run(() => vi[name](100)).finally(() => (settled = true));
      for (let i = 0; i < turns; i++) await turn();
      graph.dispose();
      for (let i = 0; i < 10; i++) await turn();
      expect({ fired, settled, now: performance.now() }).toEqual({ fired: [10], settled: false, now: 10 });
      expect(zeroDelayIsDueIn()).toBe(0);
    });

    test("a timer that the advance fires can dispose the graph", async () => {
      vi.useFakeTimers();
      const fired: number[] = [];
      const graph = new Bun.ModuleGraph();
      setTimeout(() => {
        fired.push(10);
        graph.dispose();
      }, 10);
      setTimeout(() => fired.push(20), 20);
      void graph.run(() => vi.advanceTimersByTimeAsync(100));
      for (let i = 0; i < 10; i++) await turn();
      expect({ fired, now: performance.now() }).toEqual({ fired: [10], now: 10 });
      expect(zeroDelayIsDueIn()).toBe(0);
    });
  });

  // Without `--isolate` the next test file runs on the clock that this one
  // left. An advance that is still in flight must not fire timers there, and
  // the code that awaits it must not go on there.
  test("an advance in flight ends with its test file", async () => {
    using dir = tempDir("fake-timers-async-file-end", {
      "a.test.ts": `
        import { jest, test } from "bun:test";
        test("leaves an advance in flight", () => {
          jest.useFakeTimers();
          setInterval(() => console.log("a: the interval fired"), 10);
          void jest.advanceTimersByTimeAsync(1e7).then(() => console.log("a: the advance settled"));
        });
      `,
      "b.test.ts": `
        import { jest, test } from "bun:test";
        test("sees no timer fire", async () => {
          console.log("b: starts");
          const before = performance.now();
          for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
          console.log(JSON.stringify({ fake: jest.isFakeTimers(), movedBy: performance.now() - before }));
          jest.useRealTimers();
        });
      `,
    });
    await using proc = Bun.spawn({
      cmd: [bunExe(), "test", "./a.test.ts", "./b.test.ts"],
      env: bunEnv,
      cwd: String(dir),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    const lines = stdout.trim().split("\n");
    expect({ inB: lines.slice(lines.indexOf("b: starts")), exitCode }, stderr).toEqual({
      inB: ["b: starts", JSON.stringify({ fake: true, movedBy: 0 })],
      exitCode: 0,
    });
  });

  // The promise of a control rejects with the first thing that the callback of
  // a setTimeout or a setInterval throws. Nothing reports that error a second
  // time. What a later callback of the same control throws is dropped, as in
  // @sinonjs/fake-timers.
  describe("a timer callback that throws", () => {
    const boom = () => {
      throw new Error("boom");
    };

    test("advanceTimersByTimeAsync() fires the rest of its window, then rejects", async () => {
      vi.useFakeTimers();
      const fired: number[] = [];
      setTimeout(boom, 100);
      setTimeout(() => fired.push(performance.now()), 120);
      expect(await rejection(vi.advanceTimersByTimeAsync(150))).toBe("boom");
      expect({ fired, now: performance.now(), pending: vi.getTimerCount() }).toEqual({
        fired: [120],
        now: 150,
        pending: 0,
      });
    });

    test("runOnlyPendingTimersAsync() fires the rest of its window, then rejects", async () => {
      vi.useFakeTimers();
      const fired: number[] = [];
      setTimeout(boom, 100);
      setTimeout(() => fired.push(performance.now()), 120);
      expect(await rejection(vi.runOnlyPendingTimersAsync())).toBe("boom");
      expect({ fired, now: performance.now() }).toEqual({ fired: [120], now: 120 });
    });

    test("runAllTimersAsync() rejects and leaves the other timers", async () => {
      vi.useFakeTimers();
      const fired: number[] = [];
      setTimeout(boom, 100);
      setTimeout(() => fired.push(performance.now()), 120);
      expect(await rejection(vi.runAllTimersAsync())).toBe("boom");
      expect({ fired, now: performance.now(), pending: vi.getTimerCount() }).toEqual({
        fired: [],
        now: 100,
        pending: 1,
      });
    });

    test("advanceTimersToNextTimerAsync() rejects and takes no more steps", async () => {
      vi.useFakeTimers();
      const fired: number[] = [];
      setTimeout(boom, 100);
      setTimeout(() => fired.push(performance.now()), 120);
      expect(await rejection(vi.advanceTimersToNextTimerAsync(2))).toBe("boom");
      expect({ fired, now: performance.now(), pending: vi.getTimerCount() }).toEqual({
        fired: [],
        now: 100,
        pending: 1,
      });
    });

    test("advanceTimersToNextTimerAsync() leaves the other timers of the instant of the throw", async () => {
      vi.useFakeTimers();
      const fired: string[] = [];
      setTimeout(boom, 10);
      setTimeout(() => fired.push("same instant"), 10);
      expect(await rejection(vi.advanceTimersToNextTimerAsync())).toBe("boom");
      expect({ fired, now: performance.now(), pending: vi.getTimerCount() }).toEqual({
        fired: [],
        now: 10,
        pending: 1,
      });
    });

    test("a throw among the other timers of the instant ends the steps", async () => {
      vi.useFakeTimers();
      const fired: string[] = [];
      setTimeout(() => fired.push("10, first"), 10);
      setTimeout(boom, 10);
      setTimeout(() => fired.push("20"), 20);
      expect(await rejection(vi.advanceTimersToNextTimerAsync(2))).toBe("boom");
      expect({ fired, now: performance.now(), pending: vi.getTimerCount() }).toEqual({
        fired: ["10, first"],
        now: 10,
        pending: 1,
      });
    });

    test("rejects with a thrown value that is not an Error", async () => {
      vi.useFakeTimers();
      setTimeout(() => {
        throw undefined;
      }, 10);
      let thrown: unknown = "did not reject";
      await vi.advanceTimersByTimeAsync(10).catch(error => (thrown = error));
      expect(thrown).toBeUndefined();
    });

    test("an interval that throws keeps its period", async () => {
      vi.useFakeTimers();
      const firedAt: number[] = [];
      const interval = setInterval(() => {
        firedAt.push(performance.now());
        if (firedAt.length === 1) boom();
      }, 10);
      expect(await rejection(vi.advanceTimersByTimeAsync(30))).toBe("boom");
      clearInterval(interval);
      expect(firedAt).toEqual([10, 20, 30]);
    });

    // A reported error would fail these tests.
    test.each(["advanceTimersByTimeAsync", "runOnlyPendingTimersAsync"] as const)(
      "%s() rejects with the first error, and drops what later timers throw",
      async name => {
        vi.useFakeTimers();
        const fired: number[] = [];
        const throws = (n: number) => () => {
          fired.push(n);
          throw new Error(`boom ${n}`);
        };
        setTimeout(throws(1), 10);
        setTimeout(throws(2), 20);
        setTimeout(() => fired.push(3), 30);
        expect(await rejection(vi[name](30))).toBe("boom 1");
        expect({ fired, now: performance.now() }).toEqual({ fired: [1, 2, 3], now: 30 });
      },
    );

    test("an interval that throws on every tick rejects with its first error", async () => {
      vi.useFakeTimers();
      let ticks = 0;
      const interval = setInterval(() => {
        throw new Error(`tick ${++ticks}`);
      }, 10);
      expect(await rejection(vi.advanceTimersByTimeAsync(30))).toBe("tick 1");
      clearInterval(interval);
      expect(ticks).toBe(3);
    });

    test("keeps the first error alive while the later timers run", async () => {
      vi.useFakeTimers();
      setTimeout(() => {
        throw { thrownBy: ["the", "first", "timer"].join(" ") };
      }, 1);
      for (let ms = 2; ms < 6; ms++) setTimeout(() => Bun.gc(true), ms);
      let thrown: unknown;
      await vi.advanceTimersByTimeAsync(10).catch(error => (thrown = error));
      expect(thrown).toEqual({ thrownBy: "the first timer" });
    });

    test("after an advance rejects, a zero-delay timer is due at once", async () => {
      vi.useFakeTimers();
      setTimeout(boom, 10);
      expect(await rejection(vi.advanceTimersByTimeAsync(10))).toBe("boom");
      expect(zeroDelayIsDueIn()).toBe(0);
    });

    // A control started in a timer callback, with `expect().rejects` running
    // the event loop for it there: its turns run while the outer control is
    // firing its timer. Each control takes the throw of its own timer.
    test("a control inside the timer callback of another takes its own throw", async () => {
      vi.useFakeTimers();
      const order: string[] = [];
      setTimeout(() => {
        setTimeout(() => {
          order.push(`inner timer at ${performance.now()}`);
          throw new Error("inner");
        }, 5);
        expect(vi.advanceTimersByTimeAsync(5)).rejects.toThrow("inner");
        order.push(`outer callback goes on at ${performance.now()}`);
        throw new Error("outer");
      }, 10);
      expect(await rejection(vi.advanceTimersByTimeAsync(20))).toBe("outer");
      expect(order).toEqual(["inner timer at 15", "outer callback goes on at 15"]);
    });

    // In Jest and Vitest a sync control throws what its timer throws, so the
    // async control that fired the callback rejects with it. In Bun a sync
    // control reports the error as uncaught and returns.
    test.todo("a sync control in a timer callback throws what its timer throws", async () => {
      vi.useFakeTimers();
      let wentOn = false;
      setTimeout(() => {
        vi.advanceTimersByTime(5);
        wentOn = true;
      }, 10);
      setTimeout(boom, 12);
      expect(await rejection(vi.advanceTimersByTimeAsync(20))).toBe("boom");
      expect(wentOn).toBe(false);
    });

    // An AbortSignal.timeout() listener and a Bun.cron() callback are not the
    // callback of a setTimeout or a setInterval. What they throw is reported
    // as an uncaught error, and the promise of the control resolves.
    test("what a listener or a cron callback throws is reported", async () => {
      using dir = tempDir("fake-timers-async-reported", {
        "reported.test.ts": `
          import { jest, test } from "bun:test";
          test("a listener", async () => {
            jest.useFakeTimers();
            AbortSignal.timeout(10).addEventListener("abort", () => { throw new Error("listener throw"); });
            await jest.advanceTimersByTimeAsync(10);
            console.log("resolved after the listener");
          });
          test("a cron callback", async () => {
            jest.useFakeTimers({ now: new Date("2026-01-01T00:00:30Z") });
            using job = Bun.cron("* * * * *", () => { throw new Error("cron throw"); });
            await jest.advanceTimersByTimeAsync(60_000);
            console.log("resolved after the cron callback");
          });
        `,
      });
      await using proc = Bun.spawn({
        cmd: [bunExe(), "test", "reported.test.ts"],
        env: bunEnv,
        cwd: String(dir),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      const output = stdout + stderr;
      expect(
        {
          reported: output.match(/^error: .* throw$/gm),
          resolved: output.match(/^resolved after .*$/gm),
          exitCode,
        },
        stderr,
      ).toEqual({
        reported: ["error: listener throw", "error: cron throw"],
        resolved: ["resolved after the listener", "resolved after the cron callback"],
        exitCode: 1,
      });
    });

    // A control takes the throw of the timer it is firing, and nothing else
    // that is thrown while that callback runs. Here the callback runs the
    // event loop with `expect().resolves`, and an immediate throws in it.
    test("does not take what another callback throws while its timer fires", async () => {
      const script = `
        const { expect, jest } = Bun.jest(import.meta.path);
        const reported = [];
        process.on("uncaughtException", error => reported.push(error.message));
        jest.useFakeTimers();
        setTimeout(() => {
          setImmediate(() => {
            throw new Error("immediate throw");
          });
          expect(new Promise(resolve => setImmediate(resolve))).resolves.toBeUndefined();
        }, 10);
        const settled = await jest.advanceTimersByTimeAsync(20).then(
          () => "resolved",
          error => "rejected with " + error.message,
        );
        console.log(JSON.stringify({ settled, reported }));
      `;
      await using proc = Bun.spawn({
        cmd: [bunExe(), "-e", script],
        env: bunEnv,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      expect({ stdout: stdout.trim(), exitCode }, stderr).toEqual({
        stdout: JSON.stringify({ settled: "resolved", reported: ["immediate throw"] }),
        exitCode: 0,
      });
    });
  });

  // `expect(promise).rejects` and `.resolves` run the event loop inside the
  // call until the promise settles.
  describe("expect().rejects and expect().resolves", () => {
    // The turn that settles a control wakes that loop. Nothing else does
    // here: a fake timer is still pending, so the loop waits for I/O, and the
    // garbage collection timer of the process is off.
    test("on the promise of a control they return when it settles", async () => {
      using dir = tempDir("fake-timers-async-matchers", {
        "matchers.test.ts": `
          import { expect, jest, test } from "bun:test";
          test("rejects and resolves", async () => {
            jest.useFakeTimers();
            setTimeout(() => { throw new Error("boom"); }, 10);
            setTimeout(() => {}, 20);
            setTimeout(() => {}, 1000);
            await expect(jest.runAllTimersAsync()).rejects.toThrow("boom");
            await expect(jest.advanceTimersByTimeAsync(10)).resolves.toBeUndefined();
            await expect(jest.advanceTimersToNextTimerAsync()).resolves.toBeUndefined();
            console.log(JSON.stringify({ now: performance.now(), pending: jest.getTimerCount() }));
          });
        `,
      });
      await using proc = Bun.spawn({
        cmd: [bunExe(), "test", "matchers.test.ts"],
        env: { ...bunEnv, BUN_GC_TIMER_DISABLE: "1" },
        cwd: String(dir),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      expect({ stdout: stdout.replace(/^bun test .*\n/, "").trim(), exitCode }, stderr).toEqual({
        stdout: JSON.stringify({ now: 1000, pending: 0 }),
        exitCode: 0,
      });
    });

    // A promise that rejects after timers. The matcher waits inside the
    // call, so the advance is in flight before it, or the rejection is taken
    // before the advance.
    const givesUp = async () => {
      for (let attempt = 0; attempt < 3; attempt++) await Bun.sleep(100);
      throw new Error("gave up");
    };

    test("start the advance, then assert on the promise", async () => {
      vi.useFakeTimers();
      const result = givesUp();
      const advance = vi.advanceTimersByTimeAsync(300);
      await expect(result).rejects.toThrow("gave up");
      await advance;
      expect(performance.now()).toBe(300);
    });

    test("take the rejection, advance, then assert on it", async () => {
      vi.useFakeTimers();
      const error = givesUp().catch((error: Error) => error);
      await vi.advanceTimersByTimeAsync(300);
      expect(await error).toEqual(new Error("gave up"));
    });
  });

  describe("advanceTimersToNextTimerAsync", () => {
    test("fires the timers of the next instant", async () => {
      vi.useFakeTimers();
      const fired: string[] = [];
      setTimeout(() => fired.push("10, first"), 10);
      setTimeout(() => fired.push("10, second"), 10);
      setTimeout(() => fired.push("20"), 20);
      await vi.advanceTimersToNextTimerAsync();
      expect({ fired, now: performance.now() }).toEqual({ fired: ["10, first", "10, second"], now: 10 });
      await vi.advanceTimersToNextTimerAsync();
      expect({ fired, now: performance.now() }).toEqual({ fired: ["10, first", "10, second", "20"], now: 20 });
      await vi.advanceTimersToNextTimerAsync();
      expect({ fired, now: performance.now() }).toEqual({ fired: ["10, first", "10, second", "20"], now: 20 });
    });

    test("takes `steps` steps, and stops when no timer is left", async () => {
      vi.useFakeTimers();
      const wokeAt: number[] = [];
      const loop = (async () => {
        for (let i = 0; i < 4; i++) {
          await Bun.sleep(10);
          wokeAt.push(performance.now());
        }
      })();
      await vi.advanceTimersToNextTimerAsync(3);
      expect(wokeAt).toEqual([10, 20, 30]);
      await vi.advanceTimersToNextTimerAsync(100);
      expect({ wokeAt, now: performance.now(), pending: vi.getTimerCount() }).toEqual({
        wokeAt: [10, 20, 30, 40],
        now: 40,
        pending: 0,
      });
      await loop;
    });

    test("after steps that leave a timer, a zero-delay timer is due at once", async () => {
      vi.useFakeTimers();
      for (const ms of [10, 20, 30]) setTimeout(() => {}, ms);
      await vi.advanceTimersToNextTimerAsync(2);
      expect({ now: performance.now(), pending: vi.getTimerCount() }).toEqual({ now: 20, pending: 1 });
      vi.clearAllTimers();
      expect(zeroDelayIsDueIn()).toBe(0);
    });

    test("takes no more turns once no timer is left", async () => {
      const turnsOf = async (steps: number) => {
        vi.useFakeTimers();
        setTimeout(() => {}, 10);
        const turns = countTurns();
        await vi.advanceTimersToNextTimerAsync(steps);
        return turns();
      };
      const one = await turnsOf(1);
      expect({ thousand: await turnsOf(1000), infinity: await turnsOf(Infinity) }).toEqual({
        thousand: one,
        infinity: one,
      });
    });

    // Jest: `for (let i = steps; i > 0; i--)`.
    test("1.5 steps are two steps", async () => {
      vi.useFakeTimers();
      for (const ms of [10, 20, 30]) setTimeout(() => {}, ms);
      await vi.advanceTimersToNextTimerAsync(1.5);
      expect({ now: performance.now(), pending: vi.getTimerCount() }).toEqual({ now: 20, pending: 1 });
    });

    test.each([0, -1, NaN])("with %p steps it resolves at once", async steps => {
      vi.useFakeTimers();
      let fired = false;
      setTimeout(() => (fired = true), 10);
      expect(await vi.advanceTimersToNextTimerAsync(steps)).toBe(vi);
      expect({ fired, now: performance.now() }).toEqual({ fired: false, now: 0 });
    });

    test("rejects steps that are not a number", async () => {
      vi.useFakeTimers();
      // @ts-expect-error
      await expect(vi.advanceTimersToNextTimerAsync("2")).rejects.toThrow(
        "advanceTimersToNextTimerAsync() expects a number of steps",
      );
    });
  });

  describe("runAllTimersAsync", () => {
    test("rejects after `timerLimit` timers when more are pending", async () => {
      vi.useFakeTimers({ timerLimit: 50 });
      let fired = 0;
      setInterval(() => fired++, 10);
      expect(await rejection(vi.runAllTimersAsync())).toBe(
        "Aborting after running 50 timers, assuming an infinite loop!",
      );
      expect({ fired, now: performance.now(), pending: vi.getTimerCount() }).toEqual({
        fired: 50,
        now: 500,
        pending: 1,
      });
    });

    test("resolves when the last timer is the one the limit allows", async () => {
      vi.useFakeTimers({ timerLimit: 50 });
      let fired = 0;
      const rearm = () => {
        if (++fired < 50) setTimeout(rearm, 10);
      };
      setTimeout(rearm, 10);
      await vi.runAllTimersAsync();
      expect({ fired, now: performance.now(), pending: vi.getTimerCount() }).toEqual({
        fired: 50,
        now: 500,
        pending: 0,
      });
    });

    test("each useFakeTimers() call starts from the default timerLimit", async () => {
      vi.useFakeTimers({ timerLimit: 2 });
      vi.useFakeTimers();
      let fired = 0;
      const rearm = () => {
        if (++fired < 10) setTimeout(rearm, 10);
      };
      setTimeout(rearm, 10);
      await vi.runAllTimersAsync();
      expect(fired).toBe(10);
    });

    test("loopLimit is the same limit", async () => {
      vi.useFakeTimers({ loopLimit: 3 });
      let fired = 0;
      setInterval(() => fired++, 10);
      expect(await rejection(vi.runAllTimersAsync())).toBe(
        "Aborting after running 3 timers, assuming an infinite loop!",
      );
      expect(fired).toBe(3);
    });

    // A job schedules its next run after every one, so only a job that stops lets it resolve.
    test("rejects at the limit while a Bun.cron() job is not stopped", async () => {
      vi.useFakeTimers({ now: new Date("2026-01-01T00:00:30Z"), timerLimit: 5 });
      let runs = 0;
      using job = Bun.cron("* * * * *", () => void runs++);
      expect(await rejection(vi.runAllTimersAsync())).toBe(
        "Aborting after running 5 timers, assuming an infinite loop!",
      );
      expect({ runs, now: new Date().toISOString() }).toEqual({ runs: 5, now: "2026-01-01T00:05:00.000Z" });
      job.stop();
    });

    test("resolves once a Bun.cron() job stops itself", async () => {
      vi.useFakeTimers({ now: new Date("2026-01-01T00:00:30Z") });
      let runs = 0;
      const job = Bun.cron("* * * * *", async () => {
        await null;
        if (++runs === 3) job.stop();
      });
      await vi.runAllTimersAsync();
      expect({ runs, now: new Date().toISOString(), pending: vi.getTimerCount() }).toEqual({
        runs: 3,
        now: "2026-01-01T00:03:00.000Z",
        pending: 0,
      });
    });

    test("runs the timers that promise callbacks keep scheduling", async () => {
      await turn();
      vi.useFakeTimers();
      const wokeAt: number[] = [];
      const loop = (async () => {
        for (const ms of [100, 1_000, 60_000]) {
          await new Promise(resolve => setTimeout(resolve, ms));
          wokeAt.push(performance.now());
        }
      })();
      await vi.runAllTimersAsync();
      expect({ wokeAt, now: performance.now(), pending: vi.getTimerCount() }).toEqual({
        wokeAt: [100, 1_100, 61_100],
        now: 61_100,
        pending: 0,
      });
      await loop;
    });

    test("without timers it resolves and leaves the clock", async () => {
      vi.useFakeTimers();
      vi.advanceTimersByTime(7);
      await vi.runAllTimersAsync();
      expect(performance.now()).toBe(7);
    });

    // In Jest and Vitest on Node.js the timers of a built-in module stay on
    // the real clock. In Bun the interval that a `node:http` server arms to
    // check its connections is a fake timer, and never lets this resolve.
    test.todo("a listening node:http server does not keep it from resolving", async () => {
      vi.useFakeTimers({ timerLimit: 10 });
      const server = createServer(() => {}).listen(0);
      await once(server, "listening");
      try {
        expect(vi.getTimerCount()).toBe(0);
        await vi.runAllTimersAsync();
      } finally {
        server.close();
      }
    });
  });

  describe("runOnlyPendingTimersAsync", () => {
    // sinon's runToLastAsync: the range ends at the last timer that is pending when it is called.
    test("runs to the last pending timer, with what is scheduled before it", async () => {
      await turn();
      vi.useFakeTimers();
      const fired: [string, number][] = [];
      const at = (name: string) => () => void fired.push([name, performance.now()]);
      setTimeout(async () => {
        at("10")();
        await null;
        setTimeout(at("10 + 20"), 20);
        setTimeout(at("10 + 100"), 100);
      }, 10);
      setTimeout(at("50"), 50);
      await vi.runOnlyPendingTimersAsync();
      expect(fired).toEqual([
        ["10", 10],
        ["10 + 20", 30],
        ["50", 50],
      ]);
      expect({ now: performance.now(), pending: vi.getTimerCount() }).toEqual({ now: 50, pending: 1 });
    });

    // sinon's runToLastAsync looks for the last timer in a turn of its own.
    test("an immediate queued after the call runs before the first timer", async () => {
      vi.useFakeTimers();
      const order: string[] = [];
      setTimeout(() => order.push("timer 1"), 10);
      setTimeout(() => order.push("timer 2"), 20);
      const run = vi.runOnlyPendingTimersAsync();
      setImmediate(() => order.push("immediate"));
      await run;
      expect(order).toEqual(["immediate", "timer 1", "timer 2"]);
    });

    test("takes a turn to find the last timer, one before the first timer and one after each", async () => {
      vi.useFakeTimers();
      for (const ms of [10, 20, 30]) setTimeout(() => {}, ms);
      const turns = countTurns();
      await vi.runOnlyPendingTimersAsync();
      expect(turns()).toBe(5);
    });

    test("fires an interval until the last pending timer", async () => {
      vi.useFakeTimers();
      const fired: number[] = [];
      const interval = setInterval(() => fired.push(performance.now()), 10);
      setTimeout(() => fired.push(performance.now()), 35);
      await vi.runOnlyPendingTimersAsync();
      clearInterval(interval);
      expect({ fired, now: performance.now() }).toEqual({ fired: [10, 20, 30, 35], now: 35 });
    });

    test("without timers it resolves and leaves the clock", async () => {
      vi.useFakeTimers();
      vi.advanceTimersByTime(7);
      await vi.runOnlyPendingTimersAsync();
      expect(performance.now()).toBe(7);
    });
  });
});
