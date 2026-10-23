# SinonJS Fake Timers Test Migration Notes

This document tracks tests that could not be accurately translated from @sinonjs/fake-timers to Bun's `vi` fake timers API due to missing features or API differences.

## Tests Marked as TODO (Missing Features)

### issue-73.test.ts
- **Test**: "should install with date object"
- **Issue**: Bun's fake timers don't support setting initial time via the `now` option
- **Original**: `FakeTimers.install({ now: date })`
- **Needed**: Support for `vi.useFakeTimers({ now: dateOrTimestamp })` to set initial time

### issue-207.test.ts (10 tests)
All tests in this file require features not yet implemented:

1. **"should not round off nanosecond arithmetic on hrtime - case 1"**
   - **Issue**: No hrtime mocking support
   - **Needed**: Mock `process.hrtime()` to work with fake timers

2. **"should not round off nanosecond arithmetic on hrtime - case 2"**
   - **Issue**: No hrtime mocking + no initial time setting
   - **Needed**: Both hrtime mocking and `now` option support

3. **"should truncate sub-nanosecond ticks"**
   - **Issue**: No hrtime mocking support
   - **Needed**: Mock `process.hrtime()` with sub-millisecond precision

4. **"should always set 'now' to an integer value when ticking with sub-millisecond precision"**
   - **Issue**: No access to internal clock state (`clock.now`)
   - **Needed**: API to inspect current fake time value

5. **"should adjust the 'now' value when the nano-remainder overflows"**
   - **Issue**: No access to internal clock state
   - **Needed**: API to inspect current fake time value

6. **"should floor negative now values"**
   - **Issue**: No support for negative initial time
   - **Needed**: Support for `vi.useFakeTimers({ now: -1.2 })`

7. **"should floor start times"**
   - **Issue**: No initial time setting support
   - **Needed**: Support for `vi.useFakeTimers({ now: 1.2 })`

8. **"should floor negative start times"**
   - **Issue**: No support for negative initial time
   - **Needed**: Support for `vi.useFakeTimers({ now: -1.2 })`

9. **"should handle ticks on the negative side of the Epoch"**
   - **Issue**: No support for negative initial time
   - **Needed**: Support for negative timestamps in `now` option

10. **"should handle multiple non-integer ticks"**
    - **Issue**: No support for negative initial time + access to clock state
    - **Needed**: Negative timestamp support and clock state inspection

### issue-2449.test.ts (1 test)

- **Test**: "should not fake faked timers"
- **Issues**:
  1. `vi.useFakeTimers()` doesn't throw when called twice (unlike `FakeTimers.install()`)
  2. No support for `now` option to set initial time
  3. No access to `clock.now` property
- **Needed**:
  - Error on double installation
  - `now` option support
  - API to inspect current fake time

## Tests Skipped (API Differences)

### issue-276.test.ts
- **Test**: "should throw on using `config.target`"
- **Reason**: Test is specific to `FakeTimers.install({ target: {} })` API
- **Note**: `vi.useFakeTimers()` has a different API design

### issue-1852.test.ts
- **Test**: "throws when creating a clock and global has no Date"
- **Reason**: Uses `FakeTimers.withGlobal()` for custom target contexts
- **Note**: `vi.useFakeTimers()` only works with global scope

### issue-2086.test.ts
- **Test**: "should not install setImmediate"
- **Reason**: Bun always has `setImmediate` available
- **Note**: This is a platform-specific test that may not be relevant to Bun

### issue-2449.test.ts (3 additional tests)
1. **"should not fake faked timers on a custom target"**
2. **"should not allow a fake on a custom target if the global is faked and the context inherited from the global"**
3. **"should allow a fake on the global if a fake on a customer target is already defined"**
- **Reason**: All use `FakeTimers.withGlobal()` for custom target contexts
- **Note**: `vi` doesn't support custom target contexts

## Summary

### Missing Features Required:
1. **Initial time setting**: `vi.useFakeTimers({ now: timestamp })`
2. **hrtime mocking**: Mock `process.hrtime()` with fake timers
3. **Clock state inspection**: Access to current fake time value
4. **Negative timestamp support**: Allow negative values in `now` option
5. **Double install protection**: Throw error when calling `vi.useFakeTimers()` twice

### Async advancement

`tickAsync`, `nextAsync`, `runAllAsync` and `runToLastAsync` of the helper call `vi.advanceTimersByTimeAsync()`, `vi.advanceTimersToNextTimerAsync()`, `vi.runAllTimersAsync()` and `vi.runOnlyPendingTimersAsync()`.

The four blocks with those names in fake-timers.test.ts run: 90 tests, and 77 of them pass as @sinonjs/fake-timers wrote them. The other blocks of `describe("FakeTimers")` are `describe.todo`. The helper gives the tests what they use of sinon and mocha: `sinon.spy()`, `sinon.stub()` and `sinon.fake()` over `jest.fn()`, `createClock()` as `install()`, `loopLimit`, and one `this` for a test and its hooks.

13 of the 90 are `it.failing`, each with its reason in a comment above it:

- 4 expect the promise to resolve with the time of the clock. Jest and Vitest drop that value.
- 3 pass a time string such as `"01:00"` to `tickAsync()`. `advanceTimersByTimeAsync()` takes a number of milliseconds.
- 1 calls `tickAsync()` without an argument. `advanceTimersByTimeAsync()` rejects without one.
- 3 expect `nextAsync()` to fire one timer. `advanceTimersToNextTimerAsync()` is Jest's function, which also fires the other timers that are due at the same time.
- 2 expect a timer callback to get the global object or `null` as `this`. Bun calls it with its Timeout object, as Node.js does.

The 8 tests of `setTickMode > nextAsync` need `vi.setTimerTickMode()` and are still todo.

With `createClock()` and the spies of the helper, "should successfully install the timer" of issue-516.test.ts and the two overflow tests of issue-67.test.ts pass and are no longer `it.failing`.

### API Differences (Expected):
- No `withGlobal()` for custom contexts (architectural difference)
- No `createClock()` for standalone clocks (architectural difference)
- No `config.target` option (architectural difference)

## Test Coverage
- **Total tests migrated**: 31
- **Passing**: 13 (42%)
- **Skipped**: 6 (19%)
- **TODO**: 12 (39%)
