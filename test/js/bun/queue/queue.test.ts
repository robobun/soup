import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { bunEnv, bunExe, tempDir } from "harness";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Queues without a path are kept in memory and shared by name inside the process, for as long as
// the process lives. So every test takes a name of its own, which a second run of this file in
// the same process (--rerun-each) does not get again.
const evaluation = Bun.randomUUIDv7();
let counter = 0;
function uniqueName(prefix = "queue") {
  return `${prefix}-${evaluation}-${++counter}`;
}

/** Opens `gates` when its block ends, however it ends: a handler that waits for one would keep close() waiting. */
function openAtEnd(...gates: { resolve(): void }[]) {
  return {
    [Symbol.dispose]() {
      for (const gate of gates) gate.resolve();
    },
  };
}

/** Resolves with the bodies once `count` messages were handed to the returned handler. */
function collect<T>(count: number) {
  const bodies: T[] = [];
  const sizes: number[] = [];
  const { promise, resolve } = Promise.withResolvers<T[]>();
  const handler = (batch: Bun.Queue.MessageBatch<T>) => {
    sizes.push(batch.messages.length);
    for (const message of batch.messages) bodies.push(message.body);
    if (bodies.length >= count) resolve(bodies);
  };
  return { promise, handler, bodies, sizes };
}

async function backlog(queue: Bun.Queue<any>) {
  return (await queue.metrics()).backlogCount;
}

describe("Bun.Queue", () => {
  test("delivers messages in the order they were sent, in batches of up to maxBatchSize", async () => {
    await using queue = new Bun.Queue<number>(uniqueName());
    for (let i = 0; i < 25; i++) await queue.send(i);
    expect(await backlog(queue)).toBe(25);

    const { promise, handler, sizes } = collect<number>(25);
    const consumer = queue.consume(handler);
    expect(await promise).toEqual(Array.from({ length: 25 }, (_, i) => i));
    expect(sizes).toEqual([10, 10, 5]);

    // stop() resolves when the outcome of the last batch is written.
    await consumer.stop();
    expect(await backlog(queue)).toBe(0);
  });

  test("a message has an id, the time it was sent, a body and an attempt count", async () => {
    const name = uniqueName();
    await using queue = new Bun.Queue<{ to: string }>(name);
    const before = Date.now();
    expect(await queue.send({ to: "a@example.com" })).toBeUndefined();
    await queue.send({ to: "b@example.com" });
    const after = Date.now();

    const { promise, resolve } = Promise.withResolvers<Bun.Queue.MessageBatch<{ to: string }>>();
    queue.consume(resolve);
    const batch = await promise;
    expect(batch.queue).toBe(name);
    expect(Object.isFrozen(batch.messages)).toBe(true);
    const [first, second] = batch.messages;
    expect(first.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(second.id).not.toBe(first.id);
    expect(first.timestamp).toBeInstanceOf(Date);
    expect(first.timestamp.getTime()).toBeWithin(before, after + 1);
    expect({ body: first.body, attempts: first.attempts }).toEqual({ body: { to: "a@example.com" }, attempts: 1 });
    expect(second.body).toEqual({ to: "b@example.com" });
  });

  test("send() does not run the handler before it returns", async () => {
    await using queue = new Bun.Queue<string>(uniqueName());
    const { promise, handler, bodies } = collect<string>(1);
    queue.consume(handler);
    const sent = queue.send("x");
    expect(bodies).toEqual([]);
    await sent;
    expect(await promise).toEqual(["x"]);
  });

  test("content types", async () => {
    await using queue = new Bun.Queue<unknown>(uniqueName());
    await queue.send({ at: new Date(0), list: [1, "two", null] });
    await queue.send("plain", { contentType: "text" });
    await queue.send(new Uint8Array([1, 2, 3]), { contentType: "bytes" });
    await queue.send(new Uint8Array([1, 2, 3, 4]).buffer, { contentType: "bytes" });
    await queue.send(new DataView(new Uint8Array([9, 8, 7, 6]).buffer, 1, 2), { contentType: "bytes" });
    await queue.send(
      new Map<unknown, unknown>([
        ["when", new Date(5)],
        [1n, new Set([new Uint16Array([7])])],
      ]),
      {
        contentType: "v8",
      },
    );
    await queue.send(undefined, { contentType: "v8" });

    const { promise, handler } = collect<unknown>(7);
    queue.consume(handler);
    expect(await promise).toEqual([
      // JSON is the default, and a Date is a string in JSON.
      { at: "1970-01-01T00:00:00.000Z", list: [1, "two", null] },
      "plain",
      new Uint8Array([1, 2, 3]),
      new Uint8Array([1, 2, 3, 4]),
      new Uint8Array([8, 7]),
      new Map<unknown, unknown>([
        ["when", new Date(5)],
        [1n, new Set([new Uint16Array([7])])],
      ]),
      undefined,
    ]);
  });

  test("a body that does not fit its content type is not sent", async () => {
    await using queue = new Bun.Queue<unknown>(uniqueName());
    const rejections = await Promise.allSettled([
      queue.send(undefined),
      queue.send(() => {}),
      queue.send(1n),
      queue.send(1, { contentType: "text" }),
      queue.send("text", { contentType: "bytes" }),
      queue.send(() => {}, { contentType: "v8" }),
      // @ts-expect-error
      queue.send("x", { contentType: "xml" }),
      // @ts-expect-error
      queue.send("x", "json"),
    ]);
    const reasons = rejections.map(r => {
      if (r.status !== "rejected") return "sent";
      return typeof r.reason.code === "string" ? r.reason.code : r.reason.name;
    });
    expect(reasons).toEqual([
      "ERR_INVALID_ARG_VALUE",
      "ERR_INVALID_ARG_VALUE",
      "TypeError", // JSON.stringify() of a BigInt
      "ERR_INVALID_ARG_TYPE",
      "ERR_INVALID_ARG_TYPE",
      "DataCloneError",
      "ERR_INVALID_ARG_VALUE",
      "ERR_INVALID_ARG_TYPE",
    ]);
    expect(await backlog(queue)).toBe(0);
  });

  test("delaySeconds holds a message back", async () => {
    using dir = tempDir("queue-delay", {});
    const path = join(String(dir), "queue.sqlite");
    await using queue = new Bun.Queue<string>("jobs", { path });
    const start = Date.now();
    await queue.send("late", { delaySeconds: 0.25 });
    await queue.send("now");
    await queue.sendBatch([{ body: "batch default" }, { body: "batch own", delaySeconds: 0 }], { delaySeconds: 0.1 });
    {
      // What the table says about when each of them may be delivered.
      using db = new Database(path, { readonly: true });
      expect(db.query("SELECT body, visible_at - sent_at AS delay FROM bun_queue ORDER BY seq").all()).toEqual([
        { body: '"late"', delay: 250 },
        { body: '"now"', delay: 0 },
        { body: '"batch default"', delay: 100 },
        { body: '"batch own"', delay: 0 },
      ]);
    }

    const arrived = new Map<string, number>();
    const { promise, resolve } = Promise.withResolvers<void>();
    queue.consume(batch => {
      for (const message of batch.messages) arrived.set(message.body, Date.now() - start);
      if (arrived.size === 4) resolve();
    });
    await promise;
    expect([...arrived.keys()].sort()).toEqual(["batch default", "batch own", "late", "now"]);
    expect(arrived.get("late")).toBeGreaterThanOrEqual(250);
    expect(arrived.get("batch default")).toBeGreaterThanOrEqual(100);
  });

  test("a handler that throws gets the batch again, maxRetries times, and then the messages are dropped", async () => {
    await using queue = new Bun.Queue<string>(uniqueName());
    await queue.sendBatch([{ body: "a" }, { body: "b" }]);

    const deliveries: string[] = [];
    const errors: [unknown, string[]][] = [];
    const { promise, resolve } = Promise.withResolvers<void>();
    const consumer = queue.consume(
      batch => {
        deliveries.push(batch.messages.map(message => `${message.body}:${message.attempts}`).join(" "));
        throw new Error(`failed ${deliveries.length}`);
      },
      {
        maxRetries: 2,
        onError(error, batch) {
          errors.push([error, batch!.messages.map(message => message.body)]);
          if (errors.length === 3) resolve();
        },
      },
    );
    await promise;
    await consumer.stop();
    expect(deliveries).toEqual(["a:1 b:1", "a:2 b:2", "a:3 b:3"]);
    expect(errors).toEqual([
      [new Error("failed 1"), ["a", "b"]],
      [new Error("failed 2"), ["a", "b"]],
      [new Error("failed 3"), ["a", "b"]],
    ]);
    expect(await backlog(queue)).toBe(0);
  });

  test("a rejected promise and a synchronous throw are the same failure", async () => {
    for (const kind of ["rejected", "thrown"] as const) {
      await using queue = new Bun.Queue<string>(uniqueName());
      await queue.send("x");
      const attempts: number[] = [];
      const errors: string[] = [];
      const { promise, resolve } = Promise.withResolvers<void>();
      /** Whether this delivery is to fail. */
      const delivered = (batch: Bun.Queue.MessageBatch<string>) => {
        attempts.push(batch.messages[0].attempts);
        if (attempts.length === 3) resolve();
        return attempts.length < 3;
      };
      queue.consume(
        kind === "rejected"
          ? async batch => {
              const fail = delivered(batch);
              await Promise.resolve();
              if (fail) throw new Error("rejected");
            }
          : batch => {
              if (delivered(batch)) throw new Error("thrown");
            },
        { onError: error => void errors.push((error as Error).message) },
      );
      await promise;
      expect({ attempts, errors }).toEqual({ attempts: [1, 2, 3], errors: [kind, kind] });
    }
  });

  test("deadLetterQueue gets a message that used up its retries", async () => {
    const name = uniqueName();
    await using queue = new Bun.Queue<string>(name);
    await using dead = new Bun.Queue<string>(`${name}-dead`);
    await queue.send("poison");
    await queue.send("fine");

    const seen: { id: string; timestamp: number; attempts: number }[] = [];
    queue.consume(
      batch => {
        for (const message of batch.messages) {
          if (message.body === "fine") {
            message.ack();
          } else {
            seen.push({ id: message.id, timestamp: message.timestamp.getTime(), attempts: message.attempts });
            message.retry();
          }
        }
      },
      { maxRetries: 1, deadLetterQueue: `${name}-dead` },
    );

    const { promise, resolve } = Promise.withResolvers<Bun.Queue.Message<string>>();
    dead.consume(batch => resolve(batch.messages[0]));
    const message = await promise;
    expect(seen.map(s => s.attempts)).toEqual([1, 2]);
    // The same message, counted from one again.
    expect({
      body: message.body,
      id: message.id,
      timestamp: message.timestamp.getTime(),
      attempts: message.attempts,
    }).toEqual({
      body: "poison",
      id: seen[0].id,
      timestamp: seen[0].timestamp,
      attempts: 1,
    });
    expect(await backlog(queue)).toBe(0);
  });

  test("ack() holds when the handler throws, retry() holds when it returns", async () => {
    await using queue = new Bun.Queue<string>(uniqueName());
    await queue.sendBatch([{ body: "acked" }, { body: "left" }, { body: "retried" }]);

    const deliveries: string[] = [];
    const { promise, resolve } = Promise.withResolvers<void>();
    queue.consume(
      batch => {
        deliveries.push(batch.messages.map(message => `${message.body}:${message.attempts}`).join(" "));
        if (deliveries.length === 1) {
          batch.messages[0].ack();
          throw new Error("after the ack");
        }
        if (deliveries.length === 2) {
          for (const message of batch.messages) if (message.body === "retried") message.retry();
          return;
        }
        resolve();
      },
      { onError() {} },
    );
    await promise;
    expect(deliveries).toEqual(["acked:1 left:1 retried:1", "left:2 retried:2", "retried:3"]);
  });

  test("the first of ack(), retry(), ackAll() and retryAll() decides a message", async () => {
    await using queue = new Bun.Queue<string>(uniqueName());
    await queue.sendBatch([{ body: "a" }, { body: "b" }, { body: "c" }, { body: "d" }]);

    const deliveries: string[] = [];
    const { promise, resolve } = Promise.withResolvers<void>();
    queue.consume(batch => {
      deliveries.push(batch.messages.map(message => `${message.body}:${message.attempts}`).join(" "));
      if (deliveries.length === 1) {
        const [a, b, c] = batch.messages;
        a.ack();
        a.retry(); // too late
        b.retry();
        b.ack(); // too late
        batch.ackAll(); // c and d
        c.retry(); // too late
        batch.retryAll(); // too late
        return;
      }
      if (deliveries.length === 2) {
        batch.retryAll();
        batch.ackAll(); // too late
        batch.messages[0].ack(); // too late
        return;
      }
      resolve();
    });
    await promise;
    expect(deliveries).toEqual(["a:1 b:1 c:1 d:1", "b:2", "b:3"]);
  });

  test("retry delays: retry({ delaySeconds }), retryAll({ delaySeconds }), retryDelay", async () => {
    const fixed = new Bun.Queue<string>(uniqueName());
    const computed = new Bun.Queue<string>(uniqueName());
    const explicit = new Bun.Queue<string>(uniqueName());
    await using _ = {
      async [Symbol.asyncDispose]() {
        await Promise.all([fixed.close(), computed.close(), explicit.close()]);
      },
    };

    function run(queue: Bun.Queue<string>, options: Bun.Queue.ConsumerOptions<string>, retry?: Bun.Queue.RetryOptions) {
      const times: number[] = [];
      const { promise, resolve } = Promise.withResolvers<number[]>();
      queue.consume(
        batch => {
          times.push(Date.now());
          if (times.length === 3) return resolve(times);
          if (retry) batch.retryAll(retry);
          else throw new Error("again");
        },
        { onError() {}, ...options },
      );
      return promise;
    }

    await Promise.all([fixed.send("x"), computed.send("x"), explicit.send("x")]);
    const calls: number[] = [];
    const [fixedTimes, computedTimes, explicitTimes] = await Promise.all([
      run(fixed, { retryDelay: 0.1 }),
      run(computed, {
        retryDelay(attempts) {
          calls.push(attempts);
          return attempts * 0.1;
        },
      }),
      // The delay of the call wins over the delay of the consumer.
      run(explicit, { retryDelay: 3600 }, { delaySeconds: 0.1 }),
    ]);
    expect(fixedTimes[1] - fixedTimes[0]).toBeGreaterThanOrEqual(100);
    expect(fixedTimes[2] - fixedTimes[1]).toBeGreaterThanOrEqual(100);
    expect(calls).toEqual([1, 2]);
    expect(computedTimes[1] - computedTimes[0]).toBeGreaterThanOrEqual(100);
    expect(computedTimes[2] - computedTimes[1]).toBeGreaterThanOrEqual(200);
    expect(explicitTimes[1] - explicitTimes[0]).toBeGreaterThanOrEqual(100);
    expect(explicitTimes[2] - explicitTimes[1]).toBeGreaterThanOrEqual(100);
  });

  test("maxRetries: 0 delivers once", async () => {
    await using queue = new Bun.Queue<string>(uniqueName());
    await queue.send("once");
    let deliveries = 0;
    const { promise, resolve } = Promise.withResolvers<void>();
    const consumer = queue.consume(
      () => {
        deliveries++;
        throw new Error("no");
      },
      { maxRetries: 0, onError: () => resolve() },
    );
    await promise;
    await consumer.stop();
    expect(deliveries).toBe(1);
    expect(await backlog(queue)).toBe(0);
  });

  test("ack() and retry() are written before they return", async () => {
    await using queue = new Bun.Queue<string>(uniqueName());
    await queue.sendBatch([{ body: "a" }, { body: "b" }, { body: "c" }]);
    const counts: number[] = [];
    const { promise, resolve } = Promise.withResolvers<void>();
    const consumer = queue.consume(
      async batch => {
        // No await between the calls and the look at the queue: nothing is left for later.
        const before = (await queue.metrics()).backlogCount;
        batch.messages[0].ack();
        const afterAck = queue.metrics();
        batch.messages[1].retry({ delaySeconds: 3600 });
        batch.ackAll();
        const afterAll = queue.metrics();
        counts.push(before, (await afterAck).backlogCount, (await afterAll).backlogCount);
        resolve();
        // Too late to matter: the three are decided and written.
        throw new Error("after the decisions");
      },
      { onError() {} },
    );
    await promise;
    await consumer.stop();
    // "b" waits for its retry.
    expect(counts).toEqual([3, 2, 1]);
    expect(await backlog(queue)).toBe(1);
  });

  test("a handler can stop its consumer, and the messages behind stay where they are", async () => {
    using dir = tempDir("queue-stop-inside", {});
    const path = join(String(dir), "queue.sqlite");
    await using queue = new Bun.Queue<number>("jobs", { path });
    await queue.sendBatch([{ body: 1 }, { body: 2 }, { body: 3 }, { body: 4 }, { body: 5 }]);

    const seen: number[] = [];
    let stopped!: Promise<void>;
    const { promise, resolve } = Promise.withResolvers<void>();
    const consumer = queue.consume(
      batch => {
        seen.push(batch.messages[0].body);
        // With no await in the handler, the consumer is in the middle of its round of deliveries.
        stopped = consumer.stop();
        resolve();
      },
      { maxBatchSize: 1 },
    );
    await promise;
    await stopped;
    expect(seen).toEqual([1]);
    // The queue object is as usable as before, and so is its file.
    await queue.send(6);
    expect(await backlog(queue)).toBe(5);

    // The same from onError, which is called while the consumer settles a batch.
    const failures: number[] = [];
    const failed = Promise.withResolvers<void>();
    const failing = queue.consume(
      batch => {
        failures.push(batch.messages[0].body);
        throw new Error("fails");
      },
      {
        maxBatchSize: 1,
        retryDelay: 3600,
        onError() {
          failing.stop();
          failed.resolve();
        },
      },
    );
    await failed.promise;
    await failing.stop();
    expect(failures).toEqual([2]);
    await queue.send(7);
    expect(await backlog(queue)).toBe(6);
  });

  test("a handler that held up the thread for longer than its lease does not get its own messages again", async () => {
    await using queue = new Bun.Queue<string>(uniqueName());
    await queue.send("slow");
    const deliveries: string[] = [];
    const { promise, resolve } = Promise.withResolvers<void>();
    queue.consume(
      async batch => {
        for (const message of batch.messages) deliveries.push(`${message.body}:${message.attempts}`);
        if (batch.messages[0].body === "slow") {
          // Twice the lease, with the event loop standing still: no timer could extend it.
          Bun.sleepSync(400);
          // The second slot of the consumer looks at the queue now, while "slow" is still at work.
          await queue.send("wake");
        } else {
          resolve();
        }
      },
      { maxConcurrency: 2, visibilityTimeout: 0.2 },
    );
    await promise;
    expect(deliveries).toEqual(["slow:1", "wake:1"]);
  });

  test("a consumer lets the event loop run while it works through a backlog", async () => {
    await using queue = new Bun.Queue<number>(uniqueName());
    const count = 60;
    await queue.sendBatch(Array.from({ length: count }, (_, body) => ({ body })));
    let turns = 0;
    const interval = setInterval(() => turns++, 0);
    using _ = {
      [Symbol.dispose]() {
        clearInterval(interval);
      },
    };
    // A handler that waits for nothing: each delivery that ends starts the next one from a
    // microtask, and microtasks alone would not let a timer run before the queue is empty.
    let seen = 0;
    const { promise, resolve } = Promise.withResolvers<number>();
    queue.consume(
      () => {
        // Sixty of these are several times what a consumer delivers in one go.
        Bun.sleepSync(1);
        if (++seen === count) resolve(turns);
      },
      { maxBatchSize: 1 },
    );
    expect(await promise).toBeGreaterThan(0);
  });

  test("maxConcurrency runs that many batches at the same time", async () => {
    await using queue = new Bun.Queue<number>(uniqueName());
    await queue.sendBatch(Array.from({ length: 9 }, (_, body) => ({ body })));

    let running = 0;
    let peak = 0;
    let finished = 0;
    const gates: PromiseWithResolvers<void>[] = [];
    const threeRunning = Promise.withResolvers<void>();
    const allDone = Promise.withResolvers<void>();
    let open = false;
    using _ = {
      [Symbol.dispose]() {
        open = true;
        for (const gate of gates) gate.resolve();
      },
    };
    queue.consume(
      async batch => {
        expect(batch.messages.length).toBe(1);
        peak = Math.max(peak, ++running);
        const gate = Promise.withResolvers<void>();
        gates.push(gate);
        if (running === 3) threeRunning.resolve();
        if (!open) await gate.promise;
        running--;
        if (++finished === 9) allDone.resolve();
      },
      { maxBatchSize: 1, maxConcurrency: 3 },
    );
    await threeRunning.promise;
    // A fourth batch does not start while three are waiting.
    await Bun.sleep(20);
    expect(gates.length).toBe(3);
    // Let every batch go as soon as it has started.
    let opened = 0;
    while (finished < 9) {
      for (; opened < gates.length; opened++) gates[opened].resolve();
      await Promise.race([allDone.promise, Bun.sleep(1)]);
    }
    expect(peak).toBe(3);
  });

  test("maxBatchTimeout waits for a batch to fill, and no longer once it is full", async () => {
    await using queue = new Bun.Queue<number>(uniqueName());
    const sizes: [number, number][] = [];
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    let start = Date.now();
    const consumer = queue.consume(
      batch => {
        sizes.push([batch.messages.length, Date.now() - start]);
        (sizes.length === 1 ? first : second).resolve();
      },
      { maxBatchSize: 3, maxBatchTimeout: 0.2 },
    );
    // Two of three: the batch waits for a third message until the timeout is over.
    await queue.sendBatch([{ body: 1 }, { body: 2 }]);
    await first.promise;
    expect(sizes[0][0]).toBe(2);
    expect(sizes[0][1]).toBeGreaterThanOrEqual(200);
    await consumer.stop();

    // With a timeout far beyond that of the test, only a full batch can arrive.
    queue.consume(
      batch => {
        sizes.push([batch.messages.length, 0]);
        second.resolve();
      },
      { maxBatchSize: 3, maxBatchTimeout: 3600 },
    );
    start = Date.now();
    await queue.send(3);
    await queue.send(4);
    await queue.send(5);
    await second.promise;
    expect(sizes[1][0]).toBe(3);
  });

  test("a batch that waits to fill counts the messages whose delay ends in the meantime", async () => {
    await using queue = new Bun.Queue<number>(uniqueName());
    const { promise, resolve } = Promise.withResolvers<number[]>();
    // With a timeout far beyond that of the test, only a full batch can arrive.
    queue.consume(batch => resolve(batch.messages.map(message => message.body)), {
      maxBatchSize: 3,
      maxBatchTimeout: 3600,
    });
    await queue.send(1);
    await queue.sendBatch([{ body: 2 }, { body: 3 }], { delaySeconds: 0.2 });
    expect(await promise).toEqual([1, 2, 3]);
  });

  test("a handler does not run in the AsyncLocalStorage context of whoever sent the message", async () => {
    const storage = new AsyncLocalStorage<string>();
    await using queue = new Bun.Queue<string>(uniqueName());
    const seen: [string, string | undefined][] = [];
    const { promise, resolve } = Promise.withResolvers<void>();
    storage.run("the consumer's", () => {
      queue.consume(
        batch => {
          for (const message of batch.messages) seen.push([message.body, storage.getStore()]);
          if (seen.length === 2) resolve();
        },
        { maxBatchSize: 1 },
      );
    });
    // One is delivered from the microtask that send() queues, the other from a timer.
    await storage.run("request 1", () => queue.send("now"));
    await storage.run("request 2", () => queue.send("later", { delaySeconds: 0.05 }));
    await promise;
    expect(seen).toEqual([
      ["now", undefined],
      ["later", undefined],
    ]);
  });

  test("a thenable that the handler returns is waited for", async () => {
    await using queue = new Bun.Queue<string>(uniqueName());
    await queue.send("x");
    const attempts: number[] = [];
    const { promise, resolve } = Promise.withResolvers<void>();
    queue.consume(
      batch => {
        attempts.push(batch.messages[0].attempts);
        return {
          then(onFulfilled: () => void, onRejected: (error: Error) => void) {
            if (attempts.length === 1) onRejected(new Error("thenable rejected"));
            else {
              onFulfilled();
              resolve();
            }
          },
        };
      },
      { onError() {} },
    );
    await promise;
    expect(attempts).toEqual([1, 2]);
  });

  test("sendBatch() sends everything or nothing, and takes any iterable", async () => {
    await using queue = new Bun.Queue<unknown>(uniqueName());
    await expect(queue.sendBatch([{ body: 1 }, { body: undefined }, { body: 3 }])).rejects.toMatchObject({
      code: "ERR_INVALID_ARG_VALUE",
    });
    // @ts-expect-error
    await expect(queue.sendBatch([{ body: 1 }, "not a message"])).rejects.toMatchObject({
      code: "ERR_INVALID_ARG_TYPE",
    });
    // @ts-expect-error
    await expect(queue.sendBatch(5)).rejects.toMatchObject({ code: "ERR_INVALID_ARG_TYPE" });
    await expect(queue.sendBatch([{ body: 1, delaySeconds: -1 }])).rejects.toMatchObject({ code: "ERR_OUT_OF_RANGE" });
    await queue.sendBatch([]);
    expect(await backlog(queue)).toBe(0);

    await queue.sendBatch(
      (function* () {
        yield { body: "a" };
        yield { body: "b", contentType: "text" as const };
      })(),
    );
    await queue.sendBatch(new Set([{ body: "c" }]));
    const { promise, handler } = collect<unknown>(3);
    queue.consume(handler);
    expect(await promise).toEqual(["a", "b", "c"]);
  });

  test("metrics() counts what is waiting, delayed and being handled", async () => {
    await using queue = new Bun.Queue<unknown>(uniqueName());
    expect(await queue.metrics()).toEqual({ backlogCount: 0, backlogBytes: 0, oldestMessageTimestamp: 0 });
    const before = Date.now();
    await queue.send("héllo", { contentType: "text" }); // 6 bytes
    await queue.send("later", { delaySeconds: 3600 }); // "later" in JSON, 7 bytes
    await queue.send(new Uint8Array(10), { contentType: "bytes" });
    const after = Date.now();
    const metrics = await queue.metrics();
    expect(metrics).toEqual({ backlogCount: 3, backlogBytes: 23, oldestMessageTimestamp: expect.any(Number) });
    expect(metrics.oldestMessageTimestamp).toBeWithin(before, after + 1);

    // A message that a handler is working on is still in the queue.
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    using _ = openAtEnd(gate);
    const consumer = queue.consume(async () => {
      started.resolve();
      await gate.promise;
    });
    await started.promise;
    expect(await backlog(queue)).toBe(3);
    gate.resolve();
    await consumer.stop();
    expect(await backlog(queue)).toBe(1);
  });

  test("queues are separate by name, and two objects of one name are the same queue", async () => {
    const name = uniqueName();
    await using a1 = new Bun.Queue<string>(name);
    await using a2 = new Bun.Queue<string>(name);
    await using b = new Bun.Queue<string>(`${name}-other`);
    expect(a1.name).toBe(name);
    await a1.send("for a");
    await b.send("for b");
    expect([await backlog(a2), await backlog(b)]).toEqual([1, 1]);

    const fromA = collect<string>(1);
    a2.consume(fromA.handler);
    expect(await fromA.promise).toEqual(["for a"]);
    const fromB = collect<string>(1);
    b.consume(fromB.handler);
    expect(await fromB.promise).toEqual(["for b"]);
  });

  test("stop() waits for the batch in flight and delivers nothing after it", async () => {
    await using queue = new Bun.Queue<number>(uniqueName());
    await queue.send(1);
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    using _ = openAtEnd(gate);
    const seen: number[] = [];
    const consumer = queue.consume(
      async batch => {
        for (const message of batch.messages) seen.push(message.body);
        started.resolve();
        await gate.promise;
      },
      { maxBatchSize: 1 },
    );
    await started.promise;
    await queue.send(2);

    let stopped = false;
    const stopping = consumer.stop().then(() => {
      stopped = true;
    });
    expect(consumer.stop()).toBe(consumer.stop());
    await Bun.sleep(10);
    expect(stopped).toBe(false);
    gate.resolve();
    await stopping;
    expect(seen).toEqual([1]);
    expect(await backlog(queue)).toBe(1);

    // Another consumer picks up where the first one stopped.
    const rest = collect<number>(1);
    queue.consume(rest.handler);
    expect(await rest.promise).toEqual([2]);
  });

  test("close() stops the consumers and ends the object", async () => {
    const name = uniqueName();
    const queue = new Bun.Queue<number>(name);
    const gate = Promise.withResolvers<void>();
    using _ = openAtEnd(gate);
    const started = Promise.withResolvers<void>();
    await queue.send(1);
    const consumer = queue.consume(async () => {
      started.resolve();
      await gate.promise;
    });
    await started.promise;

    // A consumer that is stopping already is waited for like one that is running.
    const stopping = consumer.stop();
    let closed = false;
    const closing = queue.close();
    expect(queue.close()).toBe(closing);
    closing.then(() => {
      closed = true;
    });
    await expect(queue.send(2)).rejects.toMatchObject({ code: "ERR_INVALID_STATE" });
    await expect(queue.sendBatch([{ body: 2 }])).rejects.toMatchObject({ code: "ERR_INVALID_STATE" });
    await expect(queue.metrics()).rejects.toMatchObject({ code: "ERR_INVALID_STATE" });
    expect(() => queue.consume(() => {})).toThrow(expect.objectContaining({ code: "ERR_INVALID_STATE" }));
    // close() does not resolve before the batch in flight is done.
    await Bun.sleep(10);
    expect(closed).toBe(false);
    gate.resolve();
    await closing;
    await stopping;
    await queue.close();

    // The message was acknowledged although the queue was closed while it was handled.
    await using again = new Bun.Queue<number>(name);
    expect(await backlog(again)).toBe(0);
  });

  test("using and await using", async () => {
    const name = uniqueName();
    let closedQueue: Bun.Queue<number>;
    {
      using queue = new Bun.Queue<number>(name);
      closedQueue = queue;
      await queue.send(1);
      const seen = Promise.withResolvers<number>();
      {
        await using consumer = queue.consume(batch => seen.resolve(batch.messages[0].body));
        expect(await seen.promise).toBe(1);
        expect(consumer[Symbol.dispose]).toBeFunction();
      }
      // The consumer was stopped at the end of its block: nothing takes this one.
      await queue.send(2);
    }
    await expect(closedQueue.send(3)).rejects.toMatchObject({ code: "ERR_INVALID_STATE" });
    // The queue of the process is still there, with the message that nobody took.
    await using queue = new Bun.Queue<number>(name);
    expect(await backlog(queue)).toBe(1);
  });

  test("arguments are validated", async () => {
    // @ts-expect-error
    expect(() => new Bun.Queue()).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }));
    // @ts-expect-error
    expect(() => new Bun.Queue(5)).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }));
    expect(() => new Bun.Queue("")).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_VALUE" }));
    // @ts-expect-error
    expect(() => new Bun.Queue("q", "file.sqlite")).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }));
    // @ts-expect-error
    expect(() => new Bun.Queue("q", { path: 5 })).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }));

    const name = uniqueName();
    await using queue = new Bun.Queue<number>(name);
    // @ts-expect-error
    expect(() => queue.consume()).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }));
    // @ts-expect-error
    expect(() => queue.consume(() => {}, 5)).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }));
    const invalid: [Record<string, unknown>, string][] = [
      [{ maxBatchSize: 0 }, "ERR_OUT_OF_RANGE"],
      [{ maxBatchSize: 1.5 }, "ERR_OUT_OF_RANGE"],
      [{ maxBatchSize: 2 ** 53 }, "ERR_OUT_OF_RANGE"],
      [{ maxBatchSize: Number.MAX_VALUE }, "ERR_OUT_OF_RANGE"],
      [{ maxBatchSize: "10" }, "ERR_INVALID_ARG_TYPE"],
      [{ maxBatchTimeout: -1 }, "ERR_OUT_OF_RANGE"],
      [{ maxBatchTimeout: Infinity }, "ERR_OUT_OF_RANGE"],
      [{ maxRetries: -1 }, "ERR_OUT_OF_RANGE"],
      [{ maxRetries: NaN }, "ERR_OUT_OF_RANGE"],
      [{ retryDelay: -1 }, "ERR_OUT_OF_RANGE"],
      [{ retryDelay: "1" }, "ERR_INVALID_ARG_TYPE"],
      [{ maxConcurrency: 0 }, "ERR_OUT_OF_RANGE"],
      [{ deadLetterQueue: 5 }, "ERR_INVALID_ARG_TYPE"],
      [{ deadLetterQueue: "" }, "ERR_INVALID_ARG_VALUE"],
      [{ deadLetterQueue: name }, "ERR_INVALID_ARG_VALUE"],
      [{ visibilityTimeout: 0 }, "ERR_OUT_OF_RANGE"],
      [{ visibilityTimeout: -5 }, "ERR_OUT_OF_RANGE"],
      [{ onError: "log" }, "ERR_INVALID_ARG_TYPE"],
    ];
    for (const [options, code] of invalid) {
      expect(() => queue.consume(() => {}, options), JSON.stringify(options)).toThrow(
        expect.objectContaining({ code }),
      );
    }
    await expect(queue.send(1, { delaySeconds: -1 })).rejects.toMatchObject({ code: "ERR_OUT_OF_RANGE" });
    // @ts-expect-error
    await expect(queue.send(1, { delaySeconds: "1" })).rejects.toMatchObject({ code: "ERR_INVALID_ARG_TYPE" });
    await expect(queue.send(1, { delaySeconds: NaN })).rejects.toMatchObject({ code: "ERR_OUT_OF_RANGE" });
    // A consumer that was refused is not running.
    await queue.send(1);
    expect(await backlog(queue)).toBe(1);
  });

  test("retry() validates its delay and a bad retryDelay result is reported", async () => {
    await using queue = new Bun.Queue<string>(uniqueName());
    await queue.send("x");
    const errors: unknown[] = [];
    const thrown: unknown[] = [];
    const { promise, resolve } = Promise.withResolvers<void>();
    queue.consume(
      batch => {
        const [message] = batch.messages;
        if (message.attempts === 1) {
          for (const delaySeconds of [-1, "1", NaN] as number[]) {
            try {
              message.retry({ delaySeconds });
            } catch (error) {
              thrown.push((error as { code: string }).code);
            }
          }
          // Undecided still: the throw decides.
          throw new Error("first");
        }
        resolve();
      },
      {
        // @ts-expect-error
        retryDelay: () => "soon",
        onError: error => errors.push((error as { code?: string }).code ?? (error as Error).message),
      },
    );
    await promise;
    expect(thrown).toEqual(["ERR_OUT_OF_RANGE", "ERR_INVALID_ARG_TYPE", "ERR_OUT_OF_RANGE"]);
    // The message was retried without a delay, and both the bad delay and the handler's error were reported.
    expect(errors.sort()).toEqual(["ERR_INVALID_ARG_TYPE", "first"]);
  });

  test("Bun.inspect() shows what matters", async () => {
    const name = uniqueName();
    await using queue = new Bun.Queue<string>(name);
    // (On one line or on several, depending on the length of the name.)
    const oneLine = (value: unknown) => Bun.inspect(value).replace(/\s+/g, " ");
    expect(oneLine(queue)).toBe(`Queue { name: '${name}' }`);
    await queue.send("x");
    const { promise, resolve } = Promise.withResolvers<string>();
    const consumer = queue.consume(batch => resolve(Bun.inspect(batch)));
    expect(oneLine(consumer)).toBe(`QueueConsumer { queue: '${name}', stopped: false }`);
    const text = await promise;
    expect(text.replace(/id: '[^']+'/, "id: '<id>'").replace(/timestamp: [^,]+,/, "timestamp: <date>,")).toBe(
      `MessageBatch {
  queue: '${name}',
  messages: [
    Message {
      id: '<id>',
      timestamp: <date>,
      body: 'x',
      attempts: 1
    }
  ]
}`,
    );
  });
});

describe("Bun.Queue in a file", () => {
  test("keeps messages when the queue is closed, and shows them to other tools", async () => {
    using dir = tempDir("queue-file", {});
    const path = join(String(dir), "queue.sqlite");
    {
      await using queue = new Bun.Queue<{ n: number }>("jobs", { path });
      await queue.send({ n: 1 });
      await queue.send({ n: 2 }, { delaySeconds: 0.05 });
    }
    {
      using db = new Database(path, { readonly: true });
      expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      expect(
        db
          .query(
            `SELECT queue, content_type, visible_at - sent_at AS delay, attempts, lease, bytes, body
             FROM bun_queue ORDER BY seq`,
          )
          .all(),
      ).toEqual([
        { queue: "jobs", content_type: "json", delay: 0, attempts: 0, lease: null, bytes: 7, body: '{"n":1}' },
        { queue: "jobs", content_type: "json", delay: 50, attempts: 0, lease: null, bytes: 7, body: '{"n":2}' },
      ]);
    }
    await using queue = new Bun.Queue<{ n: number }>("jobs", { path });
    const { promise, handler } = collect<{ n: number }>(2);
    queue.consume(handler);
    expect(await promise).toEqual([{ n: 1 }, { n: 2 }]);
  });

  test("a relative path is resolved when the queue is made, and one file holds many queues", async () => {
    using dir = tempDir("queue-relative", {
      "main-fixture.ts": `
        const a = new Bun.Queue("a", { path: "data/../queues.sqlite" });
        process.chdir("..");
        const b = new Bun.Queue("b", { path: ${JSON.stringify("QUEUE_DIR")}.replace("QUEUE_DIR", process.argv[2]) + "/queues.sqlite" });
        await a.send("to a");
        await b.send("to b");
        const seen = [];
        const done = Promise.withResolvers();
        for (const queue of [a, b]) {
          queue.consume(batch => {
            seen.push(queue.name + ": " + batch.messages.map(message => message.body).join());
            if (seen.length === 2) done.resolve();
          });
        }
        await done.promise;
        await Promise.all([a.close(), b.close()]);
        console.log(seen.sort().join("\\n"));
      `,
      "data/.keep": "",
    });
    await using proc = Bun.spawn({
      cmd: [bunExe(), "main-fixture.ts", String(dir)],
      env: bunEnv,
      cwd: String(dir),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect(stderr).toBe("");
    expect(stdout).toBe("a: to a\nb: to b\n");
    expect(exitCode).toBe(0);
    expect(await Bun.file(join(String(dir), "queues.sqlite")).exists()).toBe(true);
  });

  test("a row that another program wrote is delivered, and one that cannot be read fails like a handler", async () => {
    using dir = tempDir("queue-foreign", {});
    const path = join(String(dir), "queue.sqlite");
    await using queue = new Bun.Queue<unknown>("jobs", { path });
    await using dead = new Bun.Queue<unknown>("dead", { path });
    {
      using db = new Database(path);
      const insert = db.query(
        `INSERT INTO bun_queue (queue, id, content_type, sent_at, visible_at, bytes, body)
         VALUES ('jobs', ?1, ?2, 1000, 1000, length(CAST(?3 AS BLOB)), ?3)`,
      );
      insert.run("text-as-blob", "text", new TextEncoder().encode("from a blob"));
      insert.run("json-as-blob", "json", new TextEncoder().encode('{"ok":true}'));
      insert.run("bytes-as-text", "bytes", "abc");
      insert.run("broken", "json", "{not json");
      insert.run("unknown", "xml", "?");
    }

    const errors: string[] = [];
    const bodies: unknown[] = [];
    const ids: string[] = [];
    const good = Promise.withResolvers<void>();
    queue.consume(
      batch => {
        for (const message of batch.messages) {
          bodies.push(message.body);
          ids.push(message.id);
          expect(message.timestamp.getTime()).toBe(1000);
        }
        if (bodies.length === 3) good.resolve();
      },
      {
        maxRetries: 1,
        deadLetterQueue: "dead",
        onError(error, batch) {
          expect(batch).toBeUndefined();
          errors.push((error as { code?: string }).code ?? (error as Error).name);
        },
      },
    );
    await good.promise;
    expect(bodies).toEqual(["from a blob", { ok: true }, new Uint8Array([97, 98, 99])]);
    expect(ids).toEqual(["text-as-blob", "json-as-blob", "bytes-as-text"]);

    // Two attempts each, then they are dead letters. They cannot be read there either, so look at the table.
    const deadline = Date.now() + 10_000;
    while ((await backlog(dead)) < 2 && Date.now() < deadline) await Bun.sleep(5);
    expect(errors.sort()).toEqual(["ERR_INVALID_STATE", "ERR_INVALID_STATE", "SyntaxError", "SyntaxError"]);
    using db = new Database(path, { readonly: true });
    expect(db.query("SELECT queue, id FROM bun_queue ORDER BY seq").all()).toEqual([
      { queue: "dead", id: "broken" },
      { queue: "dead", id: "unknown" },
    ]);
  });

  test("ack() and retry() do nothing to a message that somebody else has taken since", async () => {
    using dir = tempDir("queue-lost-lease", {});
    const path = join(String(dir), "queue.sqlite");
    await using queue = new Bun.Queue<string>("jobs", { path });
    await queue.sendBatch([{ body: "acked" }, { body: "retried" }, { body: "left to the handler's end" }]);

    using db = new Database(path);
    const { promise, resolve } = Promise.withResolvers<void>();
    const consumer = queue.consume(batch => {
      // What another consumer does with messages whose lease has run out: it takes them.
      db.run("UPDATE bun_queue SET lease = 4242, attempts = attempts + 1, visible_at = 32503680000000");
      batch.messages[0].ack();
      batch.messages[1].retry();
      resolve();
    });
    await promise;
    await consumer.stop();
    const theirs = { lease: 4242, attempts: 2, visible_at: 32503680000000 };
    expect(db.query("SELECT body, lease, attempts, visible_at FROM bun_queue ORDER BY seq").all()).toEqual([
      { body: '"acked"', ...theirs },
      { body: '"retried"', ...theirs },
      { body: '"left to the handler\'s end"', ...theirs },
    ]);
  });

  test("sendBatch() leaves nothing behind when the database refuses one of the messages", async () => {
    using dir = tempDir("queue-batch-refused", {});
    const path = join(String(dir), "queue.sqlite");
    await using queue = new Bun.Queue<string>("jobs", { path });
    {
      using db = new Database(path);
      db.run(
        `CREATE TRIGGER refuse BEFORE INSERT ON bun_queue WHEN NEW.body = '"refused"'
         BEGIN SELECT RAISE(ABORT, 'refused by the test'); END`,
      );
    }
    await expect(queue.sendBatch([{ body: "first" }, { body: "refused" }, { body: "third" }])).rejects.toThrow(
      "refused by the test",
    );
    expect(await backlog(queue)).toBe(0);
    // The connection is as usable as before.
    await queue.sendBatch([{ body: "first" }, { body: "third" }]);
    expect(await backlog(queue)).toBe(2);
  });

  test("an outcome that cannot be written is reported once, kept, and written when the database takes it", async () => {
    using dir = tempDir("queue-unwritten", {});
    const path = join(String(dir), "queue.sqlite");
    await using queue = new Bun.Queue<string>("jobs", { path });
    using db = new Database(path);
    db.run("CREATE TRIGGER refuse BEFORE DELETE ON bun_queue BEGIN SELECT RAISE(ABORT, 'no deletes for now'); END");
    await queue.send("x");

    const errors: string[] = [];
    let deliveries = 0;
    const reported = Promise.withResolvers<void>();
    const consumer = queue.consume(() => void deliveries++, {
      onError(error) {
        errors.push((error as Error).message);
        reported.resolve();
      },
    });
    // The acknowledgement failed. The message is still there, and still this consumer's.
    await reported.promise;
    expect(await backlog(queue)).toBe(1);
    // The consumer tries again, a little later each time, until the database takes it.
    db.run("DROP TRIGGER refuse");
    while ((await backlog(queue)) > 0) await Bun.sleep(5);
    await consumer.stop();
    expect({ deliveries, errors }).toEqual({ deliveries: 1, errors: ["no deletes for now"] });
  });

  test("stop() tells onError about an outcome that it could not write either", async () => {
    using dir = tempDir("queue-unwritten-stop", {});
    const path = join(String(dir), "queue.sqlite");
    await using queue = new Bun.Queue<string>("jobs", { path });
    using db = new Database(path);
    db.run("CREATE TRIGGER refuse BEFORE DELETE ON bun_queue BEGIN SELECT RAISE(ABORT, 'no deletes at all'); END");
    await queue.send("x");

    const errors: string[] = [];
    const reported = Promise.withResolvers<void>();
    const consumer = queue.consume(() => {}, {
      onError(error) {
        errors.push((error as { code?: string }).code ?? (error as Error).message);
        reported.resolve();
      },
    });
    await reported.promise;
    await consumer.stop();
    expect(errors).toEqual(["SQLITE_CONSTRAINT_TRIGGER", "ERR_INVALID_STATE"]);
    // The message was not lost: it is delivered again when the lease of the stopped consumer is over.
    expect(db.query("SELECT attempts, lease IS NOT NULL AS held FROM bun_queue").all()).toEqual([
      { attempts: 1, held: 1 },
    ]);
  });

  test("a consumer extends the lease of a batch that takes longer than visibilityTimeout", async () => {
    using dir = tempDir("queue-lease", {});
    const path = join(String(dir), "queue.sqlite");
    await using queue = new Bun.Queue<string>("jobs", { path });
    await queue.send("slow");

    // What another process would see: the message is taken until `visible_at`.
    using db = new Database(path, { readonly: true });
    const row = db.query("SELECT visible_at, attempts, lease IS NOT NULL AS held FROM bun_queue");
    const read = () => row.get() as { visible_at: number; attempts: number; held: number };

    let deliveries = 0;
    const done = Promise.withResolvers<{ first: number; extended: number; afterFirstLease: ReturnType<typeof read> }>();
    const consumer = queue.consume(
      async () => {
        deliveries++;
        const first = read().visible_at;
        // The lease is moved on before it runs out, and the handler is still at work after the
        // time that the first lease ended.
        while (read().visible_at === first) await Bun.sleep(5);
        const extended = read().visible_at;
        while (Date.now() <= first) await Bun.sleep(5);
        done.resolve({ first, extended, afterFirstLease: read() });
      },
      { visibilityTimeout: 0.3 },
    );
    const { first, extended, afterFirstLease } = await done.promise;
    expect(extended).toBeGreaterThan(first);
    expect(afterFirstLease).toEqual({ visible_at: expect.any(Number), attempts: 1, held: 1 });
    expect(afterFirstLease.visible_at).toBeGreaterThan(first);
    await consumer.stop();
    expect(deliveries).toBe(1);
    expect(await backlog(queue)).toBe(0);
  });

  test("a file that cannot be opened is an error of the constructor", async () => {
    using dir = tempDir("queue-bad-path", { "not-a-database.sqlite": Buffer.alloc(4096, "x").toString() });
    const missing = join(String(dir), "missing", "queue.sqlite");
    expect(() => new Bun.Queue("jobs", { path: missing })).toThrow(
      expect.objectContaining({ code: "SQLITE_CANTOPEN" }),
    );
    expect(() => new Bun.Queue("jobs", { path: join(String(dir), "not-a-database.sqlite") })).toThrow(
      expect.objectContaining({ code: "SQLITE_NOTADB" }),
    );
    // A path that failed is tried again the next time, not remembered as broken.
    mkdirSync(join(String(dir), "missing"));
    await using queue = new Bun.Queue<string>("jobs", { path: missing });
    await queue.send("x");
    expect(await backlog(queue)).toBe(1);
  });

  test.concurrent("a consumer of another process gets what this one sends, and the other way round", async () => {
    using dir = tempDir("queue-cross", {
      "echo-fixture.ts": `
        const requests = new Bun.Queue("requests", { path: process.argv[2] });
        const replies = new Bun.Queue("replies", { path: process.argv[2] });
        // Nobody waits for a process that the test forgot.
        setTimeout(() => process.exit(3), 120_000).unref();
        const consumer = requests.consume(async batch => {
          for (const message of batch.messages) await replies.send({ echo: message.body, pid: process.pid });
          if (batch.messages.some(message => message.body === "bye")) consumer.stop();
        });
        console.log("ready");
      `,
    });
    const path = join(String(dir), "queue.sqlite");
    await using requests = new Bun.Queue<string>("requests", { path });
    await using replies = new Bun.Queue<{ echo: string; pid: number }>("replies", { path });
    const { promise, handler } = collect<{ echo: string; pid: number }>(2);
    replies.consume(handler);

    await using proc = Bun.spawn({
      cmd: [bunExe(), "echo-fixture.ts", path],
      env: bunEnv,
      cwd: String(dir),
      stdout: "pipe",
      stderr: "pipe",
    });
    // Sent before and after the other process has its consumer.
    await requests.send("hello");
    const reader = proc.stdout.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe("ready\n");
    await requests.send("bye");

    expect(await promise).toEqual([
      { echo: "hello", pid: proc.pid },
      { echo: "bye", pid: proc.pid },
    ]);
    const [stderr, exitCode] = await Promise.all([proc.stderr.text(), proc.exited]);
    expect(stderr).toBe("");
    // The child stopped its consumer, and nothing else kept it alive.
    expect(exitCode).toBe(0);
  });

  test.concurrent(
    "processes that create and use one file at the same moment lose nothing and deliver nothing twice",
    async () => {
      const producers = 3;
      const consumers = 3;
      const perProducer = 150;
      // Every process says when it is about to open the queue and then waits for the file "go",
      // so that all of them create the database at the same moment, however long each took to start.
      const barrier = `
        const { writeFileSync, existsSync } = require("node:fs");
        const barrier = process.argv[2];
        writeFileSync(barrier + "/ready-" + process.pid, "");
        while (!existsSync(barrier + "/go")) Bun.sleepSync(1);
        // Nobody waits for a process that the test forgot.
        setTimeout(() => process.exit(3), 120_000).unref();
      `;
      using dir = tempDir("queue-processes", {
        "barrier/.keep": "",
        "producer-fixture.ts": `
          ${barrier}
          const [path, id, count] = process.argv.slice(3);
          const queue = new Bun.Queue("jobs", { path });
          for (let i = 0; i < Number(count); i++) {
            if (i % 3 === 0) await queue.sendBatch([{ body: id + ":" + i }]);
            else await queue.send(id + ":" + i);
          }
          await queue.close();
        `,
        "consumer-fixture.ts": `
          ${barrier}
          const [path] = process.argv.slice(3);
          const queue = new Bun.Queue("jobs", { path });
          const control = new Bun.Queue("stop", { path });
          const lines = [];
          const consumer = queue.consume(
            async batch => {
              for (const message of batch.messages) lines.push(message.body + " " + message.attempts);
              await Bun.sleep(1);
            },
            { maxConcurrency: 2, maxBatchSize: 7 },
          );
          // One "stop" message for each consumer process.
          const stopper = control.consume(
            async () => {
              stopper.stop();
              await consumer.stop();
              console.log(lines.join("\\n"));
            },
            { maxBatchSize: 1 },
          );
        `,
      });
      const path = join(String(dir), "queue.sqlite");
      const barrierDir = join(String(dir), "barrier");
      const spawn = (...args: string[]) =>
        Bun.spawn({ cmd: [bunExe(), ...args], env: bunEnv, cwd: String(dir), stdout: "pipe", stderr: "pipe" });
      const consumerProcs = Array.from({ length: consumers }, () => spawn("consumer-fixture.ts", barrierDir, path));
      const producerProcs = Array.from({ length: producers }, (_, id) =>
        spawn("producer-fixture.ts", barrierDir, path, String(id), String(perProducer)),
      );
      const all = [...consumerProcs, ...producerProcs];
      try {
        // ".keep" and one "ready" file for each process.
        while (readdirSync(barrierDir).length <= all.length) {
          const exited = all.find(proc => proc.exitCode !== null);
          if (exited) throw new Error(`a process exited with ${exited.exitCode} before it was ready`);
          await Bun.sleep(5);
        }
        writeFileSync(join(barrierDir, "go"), "");

        const produced = await Promise.all(
          producerProcs.map(async proc => [await proc.stderr.text(), await proc.exited] as const),
        );
        expect(produced).toEqual(Array.from({ length: producers }, () => ["", 0] as const));

        await using queue = new Bun.Queue<string>("jobs", { path });
        await using control = new Bun.Queue<string>("stop", { path });
        while ((await backlog(queue)) > 0) {
          const exited = consumerProcs.find(proc => proc.exitCode !== null);
          if (exited) throw new Error(`a consumer exited with ${exited.exitCode}: ${await exited.stderr.text()}`);
          await Bun.sleep(10);
        }
        await control.sendBatch(Array.from({ length: consumers }, () => ({ body: "stop" })));

        const consumed = await Promise.all(
          consumerProcs.map(
            async proc => [await proc.stdout.text(), await proc.stderr.text(), await proc.exited] as const,
          ),
        );
        // (A consumer that had to wait too long for the write lock on a very busy machine prints
        // that and carries on, so what it printed is shown and not compared.)
        for (const [, stderr, exitCode] of consumed) expect(exitCode, stderr).toBe(0);

        const deliveries = new Map<string, number>();
        let redelivered = 0;
        for (const [stdout] of consumed) {
          for (const line of stdout.split("\n")) {
            if (line === "") continue;
            const [body, attempts] = line.split(" ");
            deliveries.set(body, (deliveries.get(body) ?? 0) + 1);
            if (attempts !== "1") redelivered++;
          }
        }
        const expected = new Map<string, number>();
        for (let id = 0; id < producers; id++) {
          for (let i = 0; i < perProducer; i++) expected.set(`${id}:${i}`, 1);
        }
        expect(redelivered).toBe(0);
        expect(deliveries.size).toBe(producers * perProducer);
        expect(deliveries).toEqual(expected);
      } finally {
        for (const proc of all) proc.kill();
      }
    },
  );

  test.concurrent(
    "a message whose consumer was killed comes back after visibilityTimeout, and becomes a dead letter at the limit",
    async () => {
      using dir = tempDir("queue-crash", {
        "victim-fixture.ts": `
          const queue = new Bun.Queue("jobs", { path: process.argv[2] });
          // Nobody waits for a process that the test forgot.
          setTimeout(() => process.exit(3), 120_000).unref();
          queue.consume(
            async batch => {
              console.log(batch.messages.map(message => message.body + ":" + message.attempts).join());
              await new Promise(() => {}); // the test kills this process
            },
            { visibilityTimeout: 0.5, maxRetries: 1, deadLetterQueue: "dead" },
          );
        `,
      });
      const path = join(String(dir), "queue.sqlite");
      await using queue = new Bun.Queue<string>("jobs", { path });
      await using dead = new Bun.Queue<string>("dead", { path });
      await queue.send("poison");

      async function deliverAndKill() {
        const proc = Bun.spawn({
          cmd: [bunExe(), "victim-fixture.ts", path],
          env: bunEnv,
          cwd: String(dir),
          stdout: "pipe",
          stderr: "inherit",
        });
        try {
          const { value } = await proc.stdout.getReader().read();
          return new TextDecoder().decode(value);
        } finally {
          proc.kill("SIGKILL");
          await proc.exited;
        }
      }

      expect(await deliverAndKill()).toBe("poison:1\n");
      // The lease of the dead process is still running: the message is there and nobody can have it.
      expect(await backlog(queue)).toBe(1);
      expect(await deliverAndKill()).toBe("poison:2\n");

      // Two deliveries were allowed. The next consumer that finds it hands it on without delivering it.
      const { promise, resolve } = Promise.withResolvers<string>();
      dead.consume(batch => resolve(batch.messages.map(message => `${message.body}:${message.attempts}`).join()));
      let delivered = 0;
      queue.consume(() => void delivered++, { maxRetries: 1, deadLetterQueue: "dead" });
      expect(await promise).toBe("poison:1");
      expect(delivered).toBe(0);
      expect(await backlog(queue)).toBe(0);
    },
  );

  test("a Bun.ModuleGraph has queues of its own, and its consumers stop when it is disposed", async () => {
    using dir = tempDir("queue-graph", {
      "tenant-fixture.ts": `
        export const memory = new Bun.Queue(process.env.QUEUE_NAME);
        export const jobs = new Bun.Queue("jobs", { path: process.env.QUEUE_PATH });
        export const seen = [];
        export const errors = [];
        const first = Promise.withResolvers();
        export const gotFirst = first.promise;
        jobs.consume(
          batch => {
            for (const message of batch.messages) seen.push(message.body);
            first.resolve();
          },
          { onError: error => errors.push(String(error)) },
        );
      `,
    });
    const path = join(String(dir), "queue.sqlite");
    const name = uniqueName("same-name");
    await using hostMemory = new Bun.Queue<string>(name);
    await using hostJobs = new Bun.Queue<string>("jobs", { path });

    const graph = new Bun.ModuleGraph({
      globals: {
        process: Object.create(process, { env: { value: { ...process.env, QUEUE_PATH: path, QUEUE_NAME: name } } }),
      },
    });
    let disposed = false;
    using _ = {
      [Symbol.dispose]() {
        if (!disposed) graph.dispose();
      },
    };
    const tenant = await graph.import(join(String(dir), "tenant-fixture.ts"));

    // A queue in memory is the graph's: the host's queue of the same name is another one.
    await graph.run(() => tenant.memory.send("the tenant's"));
    await hostMemory.send("the host's");
    expect([(await tenant.memory.metrics()).backlogCount, await backlog(hostMemory)]).toEqual([1, 1]);

    // A queue in a file is the file: the tenant's consumer gets what the host sends.
    await hostJobs.send("one");
    await tenant.gotFirst;
    expect(tenant.seen).toEqual(["one"]);

    // The tenant sends to itself, which queues a delivery for its consumer, and is disposed before
    // that delivery has run. It runs then, once, and finds its graph gone.
    graph.run(() => void tenant.jobs.send("two"));
    graph.dispose();
    disposed = true;
    // The tenant's consumer is gone with its graph. What is in the queue stays until somebody else
    // takes it, and nothing of the tenant's is called any more, its onError included.
    await hostJobs.send("three");
    await Bun.sleep(300);
    expect({ seen: tenant.seen, errors: tenant.errors }).toEqual({ seen: ["one"], errors: [] });
    const { promise, handler } = collect<string>(2);
    hostJobs.consume(handler);
    expect(await promise).toEqual(["two", "three"]);
  });

  test.concurrent("a Worker can consume what the main thread sends", async () => {
    using dir = tempDir("queue-worker", {
      "worker-fixture.ts": `
        const queue = new Bun.Queue("jobs", { path: process.env.QUEUE_PATH });
        queue.consume(batch => {
          postMessage(batch.messages.map(message => message.body));
        });
      `,
    });
    const path = join(String(dir), "queue.sqlite");
    await using queue = new Bun.Queue<number>("jobs", { path });
    const worker = new Worker(join(String(dir), "worker-fixture.ts"), { env: { ...process.env, QUEUE_PATH: path } });
    try {
      const seen: number[] = [];
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      worker.onerror = event => reject(event.error ?? new Error(event.message));
      worker.onmessage = event => {
        seen.push(...event.data);
        if (seen.length === 3) resolve();
      };
      await queue.sendBatch([{ body: 1 }, { body: 2 }, { body: 3 }]);
      await promise;
      expect(seen).toEqual([1, 2, 3]);
    } finally {
      await worker.terminate();
    }
  });
});

describe("Bun.Queue and the process", () => {
  async function run(script: string) {
    await using proc = Bun.spawn({
      cmd: [bunExe(), "-e", script],
      env: bunEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    return { stdout, stderr, exitCode };
  }

  test.concurrent("a consumer keeps the process alive until it is stopped", async () => {
    const { stdout, stderr, exitCode } = await run(`
      const queue = new Bun.Queue("jobs");
      const consumer = queue.consume(batch => {
        console.log("got", batch.messages[0].body);
        consumer.stop();
      });
      // Nothing but the consumer waits for this message. (send() never runs a handler before it
      // returns, so "sent" is printed first however long the process is held up here.)
      const sent = queue.send("later", { delaySeconds: 0.2 });
      console.log("sent");
      await sent;
    `);
    expect(stderr).toBe("");
    expect(stdout).toBe("sent\ngot later\n");
    expect(exitCode).toBe(0);
  });

  test.concurrent("unref() lets the process exit with a consumer running", async () => {
    const { stdout, stderr, exitCode } = await run(`
      const queue = new Bun.Queue("jobs");
      const consumer = queue.consume(() => console.log("not reached"));
      console.log(consumer.unref() === consumer, consumer.ref() === consumer);
      consumer.unref();
      await queue.send("later", { delaySeconds: 3600 });
      process.on("exit", () => console.log("exit"));
    `);
    expect(stderr).toBe("");
    expect(stdout).toBe("true true\nexit\n");
    expect(exitCode).toBe(0);
  });

  test.concurrent("without onError a failure is printed and the consumer goes on", async () => {
    const { stdout, stderr, exitCode } = await run(`
      const queue = new Bun.Queue("jobs");
      await queue.send("x");
      const consumer = queue.consume(batch => {
        const [message] = batch.messages;
        if (message.attempts === 1) throw new Error("handler failed on purpose");
        console.log("second attempt");
        consumer.stop();
      });
    `);
    expect(stderr).toContain("error: handler failed on purpose");
    expect(stdout).toBe("second attempt\n");
    expect(exitCode).toBe(0);
  });

  test.concurrent("bun --hot stops the consumers of the modules that it evaluates again", async () => {
    // Both versions count what was handled in one global, so the process ends whoever handles it.
    const app = (version: number, bodies: string[]) => `
      // Nobody waits for a process that the test forgot. (The timer of the first version stays.
      // A module that fails leaves a process under --hot alive, with timers that do not fire,
      // so that ends the process at once.)
      globalThis.watchdog ??= setTimeout(() => process.exit(3), 60_000);
      try {
        const queue = new Bun.Queue("jobs");
        queue.consume(
          batch => {
            for (const message of batch.messages) console.log("v${version} got " + message.body);
            globalThis.handled = (globalThis.handled ?? 0) + batch.messages.length;
            if (globalThis.handled === 4) process.exit(0);
          },
          { maxBatchSize: 1 },
        );
        for (const body of ${JSON.stringify(bodies)}) {
          // Sent when every consumer is idle: the one that was made first is woken first.
          await new Promise(resolve => setImmediate(resolve));
          await queue.send(body);
        }
      } catch (error) {
        console.error(error);
        process.exit(1);
      }
    `;
    using dir = tempDir("queue-hot", { "app-fixture.ts": app(1, ["one"]) });
    await using proc = Bun.spawn({
      cmd: [bunExe(), "--hot", "--no-clear-screen", "app-fixture.ts"],
      env: bunEnv,
      cwd: String(dir),
      stdout: "pipe",
      stderr: "inherit",
    });
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let stdout = "";
    const readUntil = async (done: () => boolean) => {
      while (!done()) {
        const chunk = await reader.read();
        if (chunk.done) break;
        stdout += decoder.decode(chunk.value, { stream: true });
      }
    };
    await readUntil(() => stdout.includes("v1 got one\n"));
    // The consumer of the first version would take all of these if it were still running.
    await Bun.write(join(String(dir), "app-fixture.ts"), app(2, ["two", "three", "four"]));
    await readUntil(() => false);
    expect(stdout).toBe("v1 got one\nv2 got two\nv2 got three\nv2 got four\n");
    expect(await proc.exited).toBe(0);
  });

  test.concurrent("an error that onError throws is printed too", async () => {
    const { stdout, stderr, exitCode } = await run(`
      const queue = new Bun.Queue("jobs");
      await queue.send("x");
      const consumer = queue.consume(
        batch => {
          if (batch.messages[0].attempts === 1) throw new Error("from the handler");
          console.log("second attempt");
          consumer.stop();
        },
        {
          onError() {
            throw new Error("from onError");
          },
        },
      );
    `);
    // One error is printed, the one of onError. (The handler's is in the source that is shown with it.)
    expect(stderr.split("\n").filter(line => line.startsWith("error: "))).toEqual(["error: from onError"]);
    expect(stdout).toBe("second attempt\n");
    expect(exitCode).toBe(0);
  });
});
