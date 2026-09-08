import { describe, expect, jest, mock, test } from "bun:test";
import { bunEnv, bunExe, tempDir } from "harness";

async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the poll to fail");
}

describe("expect.poll()", () => {
  test("retries the callback until the matcher passes", async () => {
    let n = 0;
    await expect.poll(() => ++n, { interval: 0 }).toBe(3);
    expect(n).toBe(3);
  });

  test("passes on the first attempt without waiting", async () => {
    let n = 0;
    await expect.poll(() => ++n, { interval: 60_000 }).toBe(1);
    expect(n).toBe(1);
  });

  test("awaits a promise returned by the callback", async () => {
    let n = 0;
    await expect
      .poll(
        async () => {
          await Bun.sleep(0);
          return { n: ++n };
        },
        { interval: 0 },
      )
      .toEqual({ n: 4 });
    expect(n).toBe(4);
    await expect.poll(() => Promise.resolve([1, 2, 3])).toContain(2);
  });

  test("retries while the callback throws or rejects", async () => {
    let n = 0;
    await expect
      .poll(
        () => {
          if (++n < 3) throw new Error("not yet");
          return "ready";
        },
        { interval: 0 },
      )
      .toBe("ready");
    expect(n).toBe(3);

    let m = 0;
    await expect
      .poll(async () => (++m < 3 ? Promise.reject(new Error("not yet")) : "ready"), { interval: 0 })
      .toBe("ready");
    expect(m).toBe(3);
  });

  test(".not passes once the matcher fails", async () => {
    const pending = ["a", "b", "c"];
    await expect
      .poll(
        () => {
          pending.shift();
          return pending;
        },
        { interval: 0 },
      )
      .not.toContain("b");
    expect(pending).toEqual(["c"]);
    await expect.poll(() => 1).not.not.toBe(1);
  });

  test("works with asymmetric, mock and custom matchers", async () => {
    expect.extend({
      _toBeDivisibleBy(actual: number, divisor: number) {
        return { pass: actual % divisor === 0, message: () => `expected ${actual} to be divisible by ${divisor}` };
      },
    });
    let n = 0;
    // @ts-expect-error custom matcher without a type declaration
    await expect.poll(() => ++n, { interval: 0 })._toBeDivisibleBy(4);
    expect(n).toBe(4);

    const fn = mock(() => {});
    await expect
      .poll(
        () => {
          fn();
          return fn;
        },
        { interval: 0 },
      )
      .toHaveBeenCalledTimes(3);

    await expect
      .poll(() => ({ id: ++n, tags: ["x"] }))
      .toEqual({ id: expect.any(Number), tags: expect.arrayContaining(["x"]) });
  });

  test("fails with the last matcher error once the timeout has passed", async () => {
    let n = 0;
    const error = await rejectionOf(expect.poll(() => ++n, { interval: 5, timeout: 50 }).toBe(-1));
    expect(n).toBeGreaterThanOrEqual(2);
    expect(error).toBeInstanceOf(Error);
    const message = Bun.stripANSI(error.message);
    expect(message).toStartWith(`expect.poll() timed out: the value did not pass within 50ms (${n} attempts)\n\n`);
    expect(message).toContain("expect(received).toBe(expected)");
    expect(message).toContain("Expected: -1");
    expect(message).toContain(`Received: ${n}`);
  });

  test("the message option replaces the matcher signature", async () => {
    const error = await rejectionOf(expect.poll(() => 1, { timeout: 0, message: "queue never drained" }).toBe(2));
    const message = Bun.stripANSI(error.message);
    expect(message).toStartWith(
      "expect.poll() timed out: the value did not pass within 0ms (1 attempt)\n\nqueue never drained",
    );
    expect(message).not.toContain("expect(received)");
  });

  test("reports the last error of a callback that keeps throwing", async () => {
    let n = 0;
    const error = await rejectionOf(
      expect
        .poll(
          () => {
            throw new Error(`attempt ${++n}`);
          },
          { interval: 0, timeout: 20 },
        )
        .toBe(1),
    );
    expect(error.message).toBe(`expect.poll() timed out: the callback still threw after 20ms (${n} attempts)`);
    expect(error.cause).toBeInstanceOf(Error);
    expect((error.cause as Error).message).toBe(`attempt ${n}`);
  });

  test("gives up on a promise that does not settle before the timeout", async () => {
    const started = performance.now();
    const error = await rejectionOf(expect.poll(() => new Promise(() => {}), { timeout: 30 }).toBe(1));
    expect(error.message).toBe(
      "expect.poll() timed out: the promise returned by the callback did not settle within 30ms (1 attempt)",
    );
    // Bounded by the poll timeout, not by the test timeout.
    expect(performance.now() - started).toBeLessThan(4000);
  });

  test("makes one attempt when the timeout is 0", async () => {
    let n = 0;
    await expect.poll(() => ++n, { timeout: 0 }).toBe(1);
    const error = await rejectionOf(expect.poll(() => ++n, { timeout: 0 }).toBe(0));
    expect(n).toBe(2);
    expect(error.message).toContain("(1 attempt)");
  });

  test("waits between attempts, but not past the timeout", async () => {
    let n = 0;
    const started = performance.now();
    const error = await rejectionOf(expect.poll(() => ++n, { interval: 60_000, timeout: 100 }).toBe(0));
    // One attempt right away, one more when the timeout runs out instead of after 60 s.
    expect(n).toBe(2);
    expect(error.message).toContain("(2 attempts)");
    expect(performance.now() - started).toBeLessThan(30_000);
  });

  test("matchers that need a promise, a throwing function or a snapshot are not available", () => {
    const poll = expect.poll(() => 1);
    // @ts-expect-error
    expect(() => poll.resolves).toThrow("expect.poll() does not support .resolves");
    // @ts-expect-error
    expect(() => poll.rejects).toThrow("expect.poll() does not support .rejects");
    // @ts-expect-error
    expect(() => poll.toThrow()).toThrow("expect.poll() does not support .toThrow()");
    // @ts-expect-error
    expect(() => poll.toMatchSnapshot()).toThrow("expect.poll() does not support snapshot matchers");
    // @ts-expect-error
    expect(() => poll.toMatchInlineSnapshot()).toThrow("expect.poll() does not support snapshot matchers");
    // @ts-expect-error not a matcher
    expect(poll.toBeSomethingElse).toBeUndefined();
    // Not a thenable, so `await expect.poll(fn)` does not start polling by accident.
    expect((poll as unknown as { then: unknown }).then).toBeUndefined();
    expect(poll.toBe).toBeTypeOf("function");
  });

  test("validates its arguments", () => {
    // @ts-expect-error
    expect(() => expect.poll(1)).toThrow('The "fn" argument must be of type function');
    // @ts-expect-error
    expect(() => expect.poll(() => 1, 5)).toThrow('The "options" argument must be of type object');
    expect(() => expect.poll(() => 1, { interval: -1 })).toThrow("options.interval");
    expect(() => expect.poll(() => 1, { timeout: NaN })).toThrow("options.timeout");
    // @ts-expect-error
    expect(() => expect.poll(() => 1, { message: 1 })).toThrow("options.message");
    const { poll } = expect;
    expect(() => poll(() => 1)).toThrow("expect.poll() must be called on the expect function");
  });

  test("refuses to run while fake timers are in use", async () => {
    jest.useFakeTimers();
    try {
      const error = await rejectionOf(expect.poll(() => 1).toBe(1));
      expect(error.message).toBe(
        "expect.poll() needs real timers, but fake timers are in use. Call jest.useRealTimers() first",
      );
    } finally {
      jest.useRealTimers();
    }
    await expect.poll(() => 1).toBe(1);
  });

  test("counts once for expect.assertions() and points failures at the call site", async () => {
    using dir = tempDir("expect-poll", {
      "poll.test.ts": /* ts */ `
        import { test, expect } from "bun:test";

        test("counted once", async () => {
          expect.assertions(2);
          let n = 0;
          await expect.poll(() => ++n, { interval: 0 }).toBe(5);
          expect(n).toBe(5);
        });

        test("failure", async () => {
          await expect.poll(() => "starting", { interval: 1, timeout: 20 }).toBe("ready");
        });
      `,
    });
    await using proc = Bun.spawn({
      cmd: [bunExe(), "test", "poll.test.ts"],
      cwd: String(dir),
      env: bunEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    const output = Bun.stripANSI(stdout + stderr);
    expect(output).toContain("(pass) counted once");
    expect(output).toContain("(fail) failure");
    expect(output).toMatch(/error: expect\.poll\(\) timed out: the value did not pass within 20ms \(\d+ attempts?\)/);
    expect(output).toContain('Expected: "ready"');
    expect(output).toContain('Received: "starting"');
    // The code frame and the trace point at the expect.poll() line of the test file.
    expect(output).toMatch(/^\s*12 \|\s+await expect\.poll\(\(\) => "starting"/m);
    expect(output).toMatch(/at <anonymous> \(.*poll\.test\.ts:12:\d+\)/);
    expect(output).toContain(" 1 pass");
    expect(output).toContain(" 1 fail");
    expect(exitCode).toBe(1);
  });
});
