import { describe, expect, test } from "bun:test";
import { bunEnv, bunExe, tempDir } from "harness";
import { AsyncLocalStorage } from "node:async_hooks";
import diagnostics_channel from "node:diagnostics_channel";
import { join } from "node:path";
import { inspect } from "node:util";
import { Worker as NodeWorker, locks as workerThreadsLocks } from "node:worker_threads";

type LockMode = "exclusive" | "shared";
type Lock = { readonly name: string; readonly mode: LockMode };
type LockInfo = { name: string; mode: LockMode; clientId: string };
type LockOptions = { mode?: LockMode; ifAvailable?: boolean; steal?: boolean; signal?: AbortSignal };
type LockManager = {
  request<T>(name: string, callback: (lock: Lock | null) => T): Promise<Awaited<T>>;
  request<T>(name: string, options: LockOptions, callback: (lock: Lock | null) => T): Promise<Awaited<T>>;
  query(): Promise<{ held: LockInfo[]; pending: LockInfo[] }>;
};

const locks = (navigator as unknown as { locks: LockManager }).locks;

let counter = 0;
/** A lock name no other test uses: the registry is shared by the whole process. */
function unique(label: string) {
  return `${label}-${++counter}`;
}

/** A lock on `name` that is held until `release()` is called. */
async function hold(name: string, options: LockOptions = {}) {
  const granted = Promise.withResolvers<Lock | null>();
  const done = Promise.withResolvers<void>();
  const released = locks.request(name, options, lock => {
    granted.resolve(lock);
    return done.promise;
  });
  const lock = await granted.promise;
  return { lock, released, release: () => (done.resolve(), released) };
}

async function state(name: string) {
  const { held, pending } = await locks.query();
  return {
    held: held.filter(l => l.name === name).map(l => l.mode),
    pending: pending.filter(l => l.name === name).map(l => l.mode),
  };
}

/** Polls until `count` requests wait for `name`. Gives up a little before the test would time out. */
async function untilPending(name: string, count: number) {
  const deadline = Date.now() + 4500;
  for (;;) {
    const current = await state(name);
    if (current.pending.length === count) return;
    if (Date.now() > deadline) {
      throw new Error(
        `expected ${count} pending request(s) for "${name}", the registry has ${JSON.stringify(current)}`,
      );
    }
    await Bun.sleep(1);
  }
}

describe("navigator.locks", () => {
  test("is a LockManager, the one node:worker_threads exports", () => {
    expect((navigator as any).locks).toBe(locks);
    expect(workerThreadsLocks as unknown).toBe(locks);
    expect(Object.prototype.toString.call(locks)).toBe("[object LockManager]");
    expect(locks.request.length).toBe(2);
    expect(locks.query.length).toBe(0);
    expect(locks.constructor.length).toBe(0);
    expect(Bun.inspect(locks)).toBe("LockManager {}");
    expect(inspect(locks)).toBe("LockManager {}");
    // The formatter asks the prototype for its custom inspector too.
    expect(Bun.inspect(Object.getPrototypeOf(locks))).toContain("request");
    expect(Object.keys(Object.getPrototypeOf(locks)).sort()).toEqual(["query", "request"]);
    expect(() => new (locks.constructor as any)()).toThrow(
      expect.objectContaining({ code: "ERR_ILLEGAL_CONSTRUCTOR" }),
    );
    expect(Object.keys(navigator)).toContain("locks");
  });

  test("request() calls back with a Lock, later, and resolves with what the callback returns", async () => {
    const name = unique("basic");
    let called = false;
    const promise = locks.request(name, lock => {
      called = true;
      expect(Object.prototype.toString.call(lock)).toBe("[object Lock]");
      expect({ name: lock!.name, mode: lock!.mode }).toEqual({ name, mode: "exclusive" });
      expect(Object.keys(Object.getPrototypeOf(lock)).sort()).toEqual(["mode", "name"]);
      expect(() => new (lock!.constructor as any)()).toThrow(
        expect.objectContaining({ code: "ERR_ILLEGAL_CONSTRUCTOR" }),
      );
      expect(lock!.constructor.length).toBe(0);
      expect(Bun.inspect(lock)).toBe(`Lock { name: '${name}', mode: 'exclusive' }`);
      expect(inspect(lock)).toBe(`Lock { name: '${name}', mode: 'exclusive' }`);
      expect(Bun.inspect(Object.getPrototypeOf(lock))).toContain("name");
      return 42;
    });
    expect(promise).toBeInstanceOf(Promise);
    expect(called).toBe(false);
    expect(await promise).toBe(42);
    expect(await state(name)).toEqual({ held: [], pending: [] });
  });

  test("the lock is held until the promise the callback returns settles", async () => {
    const name = unique("until-settled");
    const order: string[] = [];
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<string>();
    const first = locks.request(name, async () => {
      order.push("first in");
      entered.resolve();
      const value = await gate.promise;
      order.push("first out");
      return value;
    });
    const second = locks.request(name, () => {
      order.push("second");
    });
    await entered.promise;
    await untilPending(name, 1);
    expect(await state(name)).toEqual({ held: ["exclusive"], pending: ["exclusive"] });
    expect(order).toEqual(["first in"]);

    gate.resolve("done");
    expect(await first).toBe("done");
    await second;
    expect(order).toEqual(["first in", "first out", "second"]);
  });

  test("a thenable the callback returns is waited for too", async () => {
    const name = unique("thenable");
    const thenCalled = Promise.withResolvers<(value: string) => void>();
    const first = locks.request(name, () => ({
      then(resolve: (value: string) => void) {
        thenCalled.resolve(resolve);
      },
    }));
    // The callback has returned, and the lock is still held.
    const resolveThenable = await thenCalled.promise;
    expect(await state(name)).toEqual({ held: ["exclusive"], pending: [] });
    expect(await locks.request(name, { ifAvailable: true }, lock => lock)).toBeNull();
    resolveThenable("from thenable");
    expect(await first).toBe("from thenable");
    expect(await state(name)).toEqual({ held: [], pending: [] });
  });

  test("what the callback returns cannot break out of the request", async () => {
    const name = unique("hostile-result");
    const poisoned = Promise.resolve("unreachable");
    Object.defineProperty(poisoned, "constructor", {
      get() {
        throw new Error("constructor getter");
      },
    });
    const results = await Promise.allSettled([
      locks.request(name, () => poisoned),
      locks.request(name, () => ({
        get then() {
          throw new Error("then getter");
        },
      })),
      locks.request(name, { ifAvailable: true }, () => Promise.reject(new Error("rejected miss"))),
    ]);
    expect(results.map(result => (result.status === "rejected" ? result.reason.message : result.value))).toEqual([
      "constructor getter",
      "then getter",
      "rejected miss",
    ]);
    expect(await state(name)).toEqual({ held: [], pending: [] });
  });

  test("a callback that throws or rejects releases the lock and rejects the request", async () => {
    const name = unique("throws");
    const thrown = locks.request(name, () => {
      throw new Error("sync");
    });
    const rejected = locks.request(name, async () => {
      throw new Error("async");
    });
    const results = await Promise.allSettled([thrown, rejected]);
    expect(results.map(result => result.status === "rejected" && result.reason.message)).toEqual(["sync", "async"]);
    expect(await locks.request(name, { ifAvailable: true }, lock => lock !== null)).toBe(true);
  });

  test("exclusive requests for one name run one at a time, in order", async () => {
    const name = unique("exclusive");
    const order: number[] = [];
    let running = 0;
    const requests = Array.from({ length: 5 }, (_, i) =>
      locks.request(name, async () => {
        expect(++running).toBe(1);
        await Bun.sleep(0);
        order.push(i);
        running--;
      }),
    );
    await Promise.all(requests);
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  test("locks with different names do not wait for each other", async () => {
    const a = await hold(unique("independent"));
    const b = await hold(unique("independent"));
    await a.release();
    await b.release();
  });

  test("shared locks are held together, and an exclusive request waits for all of them", async () => {
    const name = unique("shared");
    const a = await hold(name, { mode: "shared" });
    const b = await hold(name, { mode: "shared" });
    expect(a.lock!.mode).toBe("shared");
    expect(await state(name)).toEqual({ held: ["shared", "shared"], pending: [] });

    let exclusiveRan = false;
    const exclusive = locks.request(name, () => {
      exclusiveRan = true;
    });
    // A shared request behind a pending exclusive one queues up: readers cannot starve a writer.
    let lateSharedRan = false;
    const lateShared = locks.request(name, { mode: "shared" }, () => {
      expect(exclusiveRan).toBe(true);
      lateSharedRan = true;
    });
    await untilPending(name, 2);
    expect(await state(name)).toEqual({ held: ["shared", "shared"], pending: ["exclusive", "shared"] });
    expect(await locks.request(name, { mode: "shared", ifAvailable: true }, lock => lock)).toBeNull();

    await a.release();
    expect(await state(name)).toEqual({ held: ["shared"], pending: ["exclusive", "shared"] });
    expect(exclusiveRan).toBe(false);
    await b.release();
    await Promise.all([exclusive, lateShared]);
    expect(lateSharedRan).toBe(true);
  });

  test("ifAvailable calls back with null instead of waiting", async () => {
    const name = unique("if-available");
    expect(await locks.request(name, { ifAvailable: true }, lock => lock?.name)).toBe(name);

    const holder = await hold(name);
    let called = false;
    const result = locks.request(name, { ifAvailable: true }, lock => {
      called = true;
      return lock;
    });
    expect(called).toBe(false);
    expect(await result).toBeNull();
    expect(await state(name)).toEqual({ held: ["exclusive"], pending: [] });
    await holder.release();
  });

  test("steal takes the lock from its holder and goes ahead of the queue", async () => {
    const name = unique("steal");
    const victim = await hold(name);
    const order: string[] = [];
    const waiting = locks.request(name, () => {
      order.push("waiting");
    });
    await untilPending(name, 1);

    const thief = locks.request(name, { steal: true }, async lock => {
      order.push("thief");
      expect(lock!.mode).toBe("exclusive");
      expect(await state(name)).toEqual({ held: ["exclusive"], pending: ["exclusive"] });
      return "stolen";
    });
    const error = await victim.released.then(
      () => null,
      e => e,
    );
    expect(error).toBeInstanceOf(DOMException);
    expect({ name: error.name, message: error.message }).toEqual({
      name: "AbortError",
      message: "The operation was aborted",
    });
    expect(await thief).toBe("stolen");
    await waiting;
    expect(order).toEqual(["thief", "waiting"]);

    // The callback that lost the lock finishes whenever it likes; nothing is released twice.
    const next = await hold(name);
    await victim.release().catch(() => {});
    expect(await state(name)).toEqual({ held: ["exclusive"], pending: [] });
    await next.release();
  });

  test("a lock that is stolen before its callback ran still calls back, and the request rejects", async () => {
    const name = unique("steal-early");
    let victimCalled = false;
    // Granted inside request(), stolen by the next line, and only then is the callback's task run.
    const victim = locks.request(name, () => {
      victimCalled = true;
      return "finished";
    });
    const thief = locks.request(name, { steal: true }, () => "stolen");
    const [victimResult, thiefResult] = await Promise.allSettled([victim, thief]);
    expect(victimCalled).toBe(true);
    expect(victimResult).toEqual({ status: "rejected", reason: expect.objectContaining({ name: "AbortError" }) });
    expect(thiefResult).toEqual({ status: "fulfilled", value: "stolen" });
    expect(await state(name)).toEqual({ held: [], pending: [] });
  });

  describe("signal", () => {
    test("already aborted: rejects with the reason and never calls back", async () => {
      const name = unique("signal-aborted");
      let called = false;
      const reason = new Error("too late");
      await expect(
        locks.request(name, { signal: AbortSignal.abort(reason) }, () => {
          called = true;
        }),
      ).rejects.toBe(reason);
      await expect(locks.request(name, { signal: AbortSignal.abort() }, () => {})).rejects.toThrow(
        expect.objectContaining({ name: "AbortError" }),
      );
      expect(await state(name)).toEqual({ held: [], pending: [] });
      expect(called).toBe(false);
    });

    test("aborted while waiting: leaves the queue and rejects with the reason", async () => {
      const name = unique("signal-pending");
      const holder = await hold(name);
      const controller = new AbortController();
      let called = false;
      const aborted = locks.request(name, { signal: controller.signal }, () => {
        called = true;
      });
      const behind = locks.request(name, { mode: "shared" }, () => "behind");
      await untilPending(name, 2);

      controller.abort(new Error("changed my mind"));
      await expect(aborted).rejects.toThrow("changed my mind");
      expect(await state(name)).toEqual({ held: ["exclusive"], pending: ["shared"] });

      await holder.release();
      expect(await behind).toBe("behind");
      expect(called).toBe(false);
    });

    test("aborted once the lock is held: nothing happens", async () => {
      const name = unique("signal-held");
      const controller = new AbortController();
      const result = locks.request(name, { signal: controller.signal }, async () => {
        controller.abort();
        expect(await state(name)).toEqual({ held: ["exclusive"], pending: [] });
        return "kept";
      });
      expect(await result).toBe("kept");
    });

    test("an earlier listener that stops the abort event does not keep the request from hearing it", async () => {
      const name = unique("signal-stopped");
      const holder = await hold(name);
      const controller = new AbortController();
      controller.signal.addEventListener("abort", event => event.stopImmediatePropagation());
      const aborted = locks.request(name, { signal: controller.signal }, () => "unreachable");
      await untilPending(name, 1);
      controller.abort(new Error("stopped"));
      await expect(aborted).rejects.toThrow("stopped");
      expect(await state(name)).toEqual({ held: ["exclusive"], pending: [] });
      await holder.release();
    });

    test("an abort event on a signal that is not aborted changes nothing", async () => {
      const name = unique("signal-synthetic");
      const controller = new AbortController();
      // Granted inside request(); the event arrives before the callback's task.
      const granted = locks.request(name, { signal: controller.signal }, () => "granted");
      controller.signal.dispatchEvent(new Event("abort"));
      expect(await granted).toBe("granted");
      expect(await state(name)).toEqual({ held: [], pending: [] });

      // It did not use up the listener either: a real abort still gets through.
      const holder = await hold(name);
      const aborted = locks.request(name, { signal: controller.signal }, () => "unreachable");
      await untilPending(name, 1);
      controller.signal.dispatchEvent(new Event("abort"));
      controller.abort(new Error("for real"));
      await expect(aborted).rejects.toThrow("for real");
      await holder.release();
    });

    test("aborted between the grant and the callback: the callback does not run and the lock is free", async () => {
      const name = unique("signal-race");
      const controller = new AbortController();
      let called = false;
      // Nothing holds the lock, so it is granted inside request(); the callback is one task away.
      const result = locks.request(name, { signal: controller.signal }, () => {
        called = true;
      });
      controller.abort(new Error("raced"));
      await expect(result).rejects.toThrow("raced");
      expect(await locks.request(name, () => "next")).toBe("next");
      expect(called).toBe(false);
    });
  });

  test("rejects what the specification rejects", async () => {
    const name = unique("invalid");
    const never = () => {
      throw new Error("unreachable");
    };
    const notSupported = expect.objectContaining({ name: "NotSupportedError" });
    const signal = new AbortController().signal;

    await expect(locks.request("-reserved", never)).rejects.toThrow(notSupported);
    await expect(locks.request(name, { steal: true, ifAvailable: true }, never)).rejects.toThrow(notSupported);
    await expect(locks.request(name, { steal: true, mode: "shared" }, never)).rejects.toThrow(notSupported);
    await expect(locks.request(name, { steal: true, signal }, never)).rejects.toThrow(notSupported);
    await expect(locks.request(name, { ifAvailable: true, signal }, never)).rejects.toThrow(notSupported);

    await expect(locks.request(name, { mode: "both" as any }, never)).rejects.toThrow(TypeError);
    await expect(locks.request(name, { signal: {} as any }, never)).rejects.toThrow(TypeError);
    await expect(locks.request(name, "options" as any, never)).rejects.toThrow(TypeError);
    await expect(locks.request(name, {}, "callback" as any)).rejects.toThrow(TypeError);
    await expect((locks.request as any)(name)).rejects.toThrow(TypeError);
    await expect(locks.request(Symbol("name") as any, never)).rejects.toThrow(TypeError);
    await expect(locks.request.call({} as any, name, never)).rejects.toThrow(
      expect.objectContaining({ code: "ERR_INVALID_THIS" }),
    );
    await expect(locks.query.call({} as any)).rejects.toThrow(expect.objectContaining({ code: "ERR_INVALID_THIS" }));

    // None of them left anything behind, and null or undefined options are no options.
    expect(await state(name)).toEqual({ held: [], pending: [] });
    expect(await locks.request(name, null as any, lock => lock!.mode)).toBe("exclusive");
    expect(await locks.request(name, undefined as any, lock => lock!.mode)).toBe("exclusive");
    // A name is converted to a string.
    expect(await locks.request(123 as any, lock => lock!.name)).toBe("123");
  });

  test("query() reports held locks and pending requests with their client", async () => {
    const name = unique("query");
    const holder = await hold(name, { mode: "shared" });
    const waiting = locks.request(name, () => {});
    await untilPending(name, 1);

    const { held, pending } = await locks.query();
    const mine = { clientId: held.find(l => l.name === name)!.clientId };
    expect(mine.clientId).toBeString();
    expect(mine.clientId).not.toBe("");
    expect(held.filter(l => l.name === name)).toEqual([{ name, mode: "shared", ...mine }]);
    expect(pending.filter(l => l.name === name)).toEqual([{ name, mode: "exclusive", ...mine }]);

    await holder.release();
    await waiting;
    expect(await state(name)).toEqual({ held: [], pending: [] });
  });

  test("a pending request whose promise nobody kept still gets its turn", async () => {
    const name = unique("gc");
    const holder = await hold(name);
    const ran = Promise.withResolvers<string>();
    (() => {
      locks.request(name, lock => ran.resolve(lock!.name));
    })();
    await untilPending(name, 1);
    Bun.gc(true);
    await holder.release();
    expect(await ran.promise).toBe(name);
  });

  test("the callback runs in the async context of request()", async () => {
    const name = unique("als");
    const storage = new AsyncLocalStorage<string>();
    const holder = await hold(name);
    // Granted later, from the task that follows the release, not from anything this context started.
    const contended = storage.run("contended", () => locks.request(name, () => storage.getStore()));
    const free = storage.run("free", () => locks.request(unique("als"), () => storage.getStore()));
    const missed = storage.run("missed", () => locks.request(name, { ifAvailable: true }, () => storage.getStore()));
    await untilPending(name, 1);
    await holder.release();
    expect(await Promise.all([contended, free, missed])).toEqual(["contended", "free", "missed"]);
  });

  test("publishes to the diagnostics channels Node.js has", async () => {
    const name = unique("diagnostics");
    const events: unknown[] = [];
    const channels = ["start", "grant", "miss", "end"].map(kind => `locks.request.${kind}`);
    const listeners = channels.map(channel => {
      const listener = (message: any) => {
        if (message.name === name) events.push([channel.slice("locks.request.".length), message]);
      };
      diagnostics_channel.subscribe(channel, listener);
      return listener;
    });
    try {
      const missError = new Error("rejected miss");
      await locks.request(name, { mode: "shared" }, async () => {
        await locks.request(name, { ifAvailable: true }, () => {});
        await locks.request(name, { ifAvailable: true }, () => Promise.reject(missError)).catch(() => {});
      });
      const error = new Error("failed");
      await locks
        .request(name, () => {
          throw error;
        })
        .catch(() => {});

      const shared = { name, mode: "shared" };
      const exclusive = { name, mode: "exclusive" };
      expect(events).toEqual([
        ["start", shared],
        ["grant", shared],
        ["start", exclusive],
        ["miss", exclusive],
        ["end", { ...exclusive, ifAvailable: true, steal: false, error: undefined }],
        ["start", exclusive],
        ["miss", exclusive],
        ["end", { ...exclusive, ifAvailable: true, steal: false, error: missError }],
        ["end", { ...shared, ifAvailable: false, steal: false, error: undefined }],
        ["start", exclusive],
        ["grant", exclusive],
        ["end", { ...exclusive, ifAvailable: false, steal: false, error }],
      ]);
    } finally {
      channels.forEach((channel, i) => diagnostics_channel.unsubscribe(channel, listeners[i]));
    }
  });
});

describe("navigator.locks across threads", () => {
  function workerURL(source: string) {
    return URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  }

  function nextMessage(worker: Worker) {
    return new Promise<any>((resolve, reject) => {
      worker.addEventListener("message", event => resolve(event.data), { once: true });
      worker.addEventListener("error", event => reject(event.error ?? new Error(event.message)), { once: true });
    });
  }

  test("a lock held on the main thread makes a Worker wait, and keeps that Worker alive", async () => {
    const name = unique("worker-waits");
    const holder = await hold(name);
    // Nothing else keeps this worker running: no listener, no timer, no port.
    const worker = new Worker(
      workerURL(`
        await navigator.locks.request(${JSON.stringify(name)}, async lock => {
          const { held } = await navigator.locks.query();
          postMessage({ mode: lock.mode, clientId: held.find(l => l.name === lock.name).clientId });
        });
      `),
    );
    try {
      const closed = new Promise<void>(resolve => worker.addEventListener("close", () => resolve(), { once: true }));
      const message = nextMessage(worker);

      await untilPending(name, 1);
      const { held, pending } = await locks.query();
      const mine = held.find(l => l.name === name)!.clientId;
      const theirs = pending.find(l => l.name === name)!.clientId;
      expect(theirs).not.toBe(mine);

      await holder.release();
      expect(await message).toEqual({ mode: "exclusive", clientId: theirs });
      // With the lock released and nothing left to wait for, the worker exits by itself.
      await closed;
      expect(await state(name)).toEqual({ held: [], pending: [] });
    } finally {
      worker.terminate();
    }
  });

  test("a Worker that waits for the main thread's lock again and again gets it every time", async () => {
    // The hand-over is a grant and the end of the Worker's keep-alive, posted by this thread
    // while the Worker sleeps. In the wrong order the Worker wakes up to nothing and exits.
    const name = unique("hand-over");
    const rounds = 50;
    let holder = await hold(name);
    const worker = new Worker(
      workerURL(`
        for (let round = 1; round <= ${rounds}; round++) {
          await navigator.locks.request(${JSON.stringify(name)}, () => postMessage(round));
        }
      `),
    );
    try {
      const closed = new Promise<void>(resolve => worker.addEventListener("close", () => resolve(), { once: true }));
      for (let round = 1; round <= rounds; round++) {
        await untilPending(name, 1);
        const granted = nextMessage(worker);
        // Queue up behind the Worker before letting it have the lock.
        const next = hold(name);
        await untilPending(name, 2);
        await holder.release();
        expect(await granted).toBe(round);
        holder = await next;
      }
      await holder.release();
      await closed;
    } finally {
      worker.terminate();
    }
  });

  test("a Worker that exits by itself gives back what it held", async () => {
    const name = unique("worker-exits");
    // The promise never settles and nothing else keeps the worker running, so it exits.
    const worker = new Worker(
      workerURL(`
        navigator.locks.request(${JSON.stringify(name)}, () => {
          postMessage("held");
          return new Promise(() => {});
        });
      `),
    );
    try {
      const closed = new Promise<void>(resolve => worker.addEventListener("close", () => resolve(), { once: true }));
      expect(await nextMessage(worker)).toBe("held");
      expect(await locks.request(name, () => "granted after exit")).toBe("granted after exit");
      await closed;
      expect(await state(name)).toEqual({ held: [], pending: [] });
    } finally {
      worker.terminate();
    }
  });

  test("steal takes a lock from another thread", async () => {
    const name = unique("steal-threads");
    const worker = new Worker(
      workerURL(`
        navigator.locks.request(${JSON.stringify(name)}, () => {
          postMessage("held");
          return new Promise(() => {});
        }).catch(error => postMessage({ name: error.name, isDOMException: error instanceof DOMException }));
        // Still there to hear that it lost the lock.
        addEventListener("message", () => {});
      `),
    );
    try {
      expect(await nextMessage(worker)).toBe("held");
      const broken = nextMessage(worker);
      expect(await locks.request(name, { steal: true }, lock => lock!.name)).toBe(name);
      expect(await broken).toEqual({ name: "AbortError", isDOMException: true });
    } finally {
      worker.terminate();
    }
  });

  test("a lock held by a Worker makes the main thread wait", async () => {
    const name = unique("main-waits");
    const worker = new Worker(
      workerURL(`
        navigator.locks.request(${JSON.stringify(name)}, { mode: "shared" }, () => {
          postMessage("held");
          return new Promise(resolve => addEventListener("message", resolve, { once: true }));
        }).then(() => postMessage("released"));
      `),
    );
    try {
      expect(await nextMessage(worker)).toBe("held");
      expect(await locks.request(name, { ifAvailable: true }, lock => lock)).toBeNull();
      // Shared locks are shared between threads too.
      expect(await locks.request(name, { mode: "shared", ifAvailable: true }, lock => lock?.mode)).toBe("shared");

      const mine = locks.request(name, () => state(name));
      await untilPending(name, 1);
      expect(await state(name)).toEqual({ held: ["shared"], pending: ["exclusive"] });
      const released = nextMessage(worker);
      worker.postMessage("release");
      expect(await mine).toEqual({ held: ["exclusive"], pending: [] });
      expect(await released).toBe("released");
    } finally {
      worker.terminate();
    }
  });

  test("query() sees every thread: pending requests in the order they were made, the caller's held locks first", async () => {
    const name = unique("query-threads");
    const source = `
      addEventListener("message", ({ data }) => {
        navigator.locks.request(data.name, { mode: data.mode }, async lock => {
          const { held } = await navigator.locks.query();
          postMessage(held.filter(l => l.name === data.name).map(l => l.clientId));
          return new Promise(() => {});
        });
      });
    `;
    const workers = [new Worker(workerURL(source)), new Worker(workerURL(source))];
    try {
      // Shared locks: the first worker's, then mine, then the second worker's.
      let message = nextMessage(workers[0]);
      workers[0].postMessage({ name, mode: "shared" });
      const [first] = await message;
      const mine = await hold(name, { mode: "shared" });
      message = nextMessage(workers[1]);
      workers[1].postMessage({ name, mode: "shared" });
      const fromSecond = await message;
      const second = fromSecond[0];
      expect(new Set([first, second]).size).toBe(2);

      const { held } = await locks.query();
      const me = held.find(l => l.name === name)!.clientId;
      expect(held.filter(l => l.name === name).map(l => l.clientId)).toEqual([me, first, second]);
      expect(fromSecond).toEqual([second, first, me]);

      // Exclusive requests queue up behind them in the order they were made, whoever made them.
      workers[1].postMessage({ name, mode: "exclusive" });
      await untilPending(name, 1);
      const ignored = locks.request(name, () => {});
      await untilPending(name, 2);
      workers[0].postMessage({ name, mode: "exclusive" });
      await untilPending(name, 3);
      const { pending } = await locks.query();
      expect(pending.filter(l => l.name === name).map(l => l.clientId)).toEqual([second, me, first]);

      // Held forever by the workers: terminating them is what lets the rest through.
      workers.forEach(worker => worker.terminate());
      await mine.release();
      await ignored;
    } finally {
      workers.forEach(worker => worker.terminate());
    }
  });

  test("terminating a Worker releases what it held and forgets what it waited for", async () => {
    const heldByWorker = unique("terminated-held");
    const heldByMain = unique("terminated-pending");
    const holder = await hold(heldByMain);
    await using worker = new NodeWorker(
      `
        const { parentPort } = require("node:worker_threads");
        navigator.locks.request(${JSON.stringify(heldByWorker)}, () => {
          parentPort.postMessage("held");
          return new Promise(() => {});
        });
        navigator.locks.request(${JSON.stringify(heldByMain)}, () => {});
      `,
      { eval: true },
    );
    await new Promise(resolve => worker.once("message", resolve));
    const waiting = locks.request(heldByWorker, () => "granted after terminate");
    await untilPending(heldByWorker, 1);
    await untilPending(heldByMain, 1);

    await worker.terminate();
    expect(await waiting).toBe("granted after terminate");
    expect(await state(heldByMain)).toEqual({ held: ["exclusive"], pending: [] });
    await holder.release();
  });
});

test("disposing a Bun.ModuleGraph releases the locks its code held and drops its requests", async () => {
  const heldByGraph = unique("graph-held");
  const heldByHost = unique("graph-pending");
  using dir = tempDir("web-locks-graph", {
    "tenant.mjs": `
      export const held = new Promise(resolve => {
        navigator.locks.request(${JSON.stringify(heldByGraph)}, () => {
          resolve();
          return new Promise(() => {});
        });
      });
      navigator.locks.request(${JSON.stringify(heldByHost)}, () => {});
    `,
  });
  const holder = await hold(heldByHost);
  const graph = new Bun.ModuleGraph();
  const tenant = await graph.import(join(String(dir), "tenant.mjs"));
  await tenant.held;
  await untilPending(heldByHost, 1);
  const waiting = locks.request(heldByGraph, () => "granted after dispose");
  await untilPending(heldByGraph, 1);

  graph.dispose();
  expect(await waiting).toBe("granted after dispose");
  expect(await state(heldByHost)).toEqual({ held: ["exclusive"], pending: [] });
  await holder.release();
});

describe("navigator.locks and the event loop", () => {
  async function run(source: string) {
    await using proc = Bun.spawn({
      cmd: [bunExe(), "-e", source],
      env: bunEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    return { stdout, stderr, exitCode };
  }

  test.concurrent("a request is served before the process exits", async () => {
    expect(
      await run(`
        navigator.locks.request("a", async lock => {
          console.log("first", lock.name);
          await Bun.sleep(1);
        });
        navigator.locks.request("a", lock => console.log("second", lock.name));
      `),
    ).toEqual({ stdout: "first a\nsecond a\n", stderr: "", exitCode: 0 });
  });

  test.concurrent("bun test --isolate releases the locks a test file leaves behind", async () => {
    using dir = tempDir("web-locks-isolate", {
      "a.test.ts": `
        import { test } from "bun:test";
        test("never releases", () =>
          new Promise<void>(resolve => {
            navigator.locks.request("left-behind", () => {
              resolve();
              return new Promise(() => {});
            });
          }));
      `,
      "b.test.ts": `
        import { expect, test } from "bun:test";
        test("finds it free", async () => {
          expect(await navigator.locks.request("left-behind", { ifAvailable: true }, lock => lock !== null)).toBe(true);
        });
      `,
    });
    await using proc = Bun.spawn({
      cmd: [bunExe(), "test", "--isolate", "./a.test.ts", "./b.test.ts"],
      env: bunEnv,
      cwd: String(dir),
      stdout: "ignore",
      stderr: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([proc.stderr.text(), proc.exited]);
    expect(stderr).toContain(" 2 pass");
    expect(stderr).toContain(" 0 fail");
    expect(exitCode).toBe(0);
  });

  // In both, the Worker that holds the lock is unref'd: the only thing that can keep the
  // process running is the main thread's own request.
  const unrefdHolder = `
    const { Worker } = require("node:worker_threads");
    const worker = new Worker(\`
      const { parentPort } = require("node:worker_threads");
      navigator.locks.request("a", () => {
        parentPort.postMessage("held");
        return new Promise(resolve => parentPort.once("message", resolve));
      });
    \`, { eval: true });
    worker.unref();
    await new Promise(resolve => worker.once("message", resolve));
  `;

  test.concurrent("a request that waits for another thread's lock keeps the process alive", async () => {
    expect(
      await run(`
        ${unrefdHolder}
        navigator.locks.request("a", () => console.log("granted"));
        worker.postMessage("release");
      `),
    ).toEqual({ stdout: "granted\n", stderr: "", exitCode: 0 });
  });

  test.concurrent("a request that is aborted stops keeping the process alive", async () => {
    expect(
      await run(`
        ${unrefdHolder}
        const controller = new AbortController();
        navigator.locks.request("a", { signal: controller.signal }, () => console.log("unreachable")).catch(error => {
          console.log("rejected", error.name);
        });
        while ((await navigator.locks.query()).pending.length === 0) await Bun.sleep(1);
        controller.abort();
      `),
    ).toEqual({ stdout: "rejected AbortError\n", stderr: "", exitCode: 0 });
  });

  test.concurrent("a request that waits for a lock of its own thread does not keep the process alive", async () => {
    expect(
      await run(`
        navigator.locks.request("a", () => new Promise(() => {}));
        navigator.locks.request("a", () => console.log("unreachable"));
        process.on("exit", code => console.log("exit", code));
      `),
    ).toEqual({ stdout: "exit 0\n", stderr: "", exitCode: 0 });
  });
});
