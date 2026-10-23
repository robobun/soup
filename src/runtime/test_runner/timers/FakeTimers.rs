use core::cell::Cell;
use core::ptr::NonNull;

use bun_core::Timespec;
use bun_jsc::bindgen::{JsHeap, JsLocal, JsScope};
use bun_jsc::{JSFunction, JSGlobalObject, JSHostFn, JSPromise, JSValue, JsResult};
use crate::api::cron::CronJob;
use crate::generated_bindgen::fake_timers::{
    Bun__FakeTimers__advanceTimersByTime, Bun__FakeTimers__advanceTimersByTimeAsync,
    Bun__FakeTimers__advanceTimersToNextTimer, Bun__FakeTimers__advanceTimersToNextTimerAsync,
    Bun__FakeTimers__clearAllTimers, Bun__FakeTimers__getTimerCount, Bun__FakeTimers__isFakeTimers,
    Bun__FakeTimers__runAllTimers, Bun__FakeTimers__runAllTimersAsync,
    Bun__FakeTimers__runOnlyPendingTimers, Bun__FakeTimers__runOnlyPendingTimersAsync,
    Bun__FakeTimers__useFakeTimers, Bun__FakeTimers__useRealTimers,
    FakeTimersImplementationOrOptions,
};
use crate::generated_bindgen::fake_timers_internals::Bun__FakeTimers__asyncControlTurn;
use crate::jsc::virtual_machine::VirtualMachine;
use crate::timer::{
    AbortSignalTimeout, ElTimespec, EventLoopTimer, EventLoopTimerState, EventLoopTimerTag,
    InHeap, TimerObjectInternals, TimeoutObject, TimerHeap,
};

// JSMock C++ bindings (fake timers are only used by bun:test, so these stay local).
unsafe extern "C" {
    safe fn JSMock__setOverridenDateNow(global: &JSGlobalObject, value: f64);
    safe fn JSMock__getCurrentUnixTimeMs() -> f64;
}

#[derive(Default)]
pub(crate) struct FakeTimers {
    /// Fake monotonic clock. `useFakeTimers()` starts it at 0. `None` means the real clock is in use.
    now: Option<Timespec>,
    /// `Date.now()` minus `now.ms()`.
    date_now_offset: f64,
    /// Depth of [`FakeTimers::fire`] calls on the stack; each covers the callback and its microtask drain.
    firing: u32,
    /// Jest's `timerLimit`, which is Vitest's `loopLimit`: the most timers one `runAllTimers()` or
    /// `runAllTimersAsync()` fires before it gives up. `useFakeTimers()` sets it on every activation.
    timer_limit: u32,
    /// The async controls in flight. They end with the clock they started on.
    drives: Vec<Drive>,
    /// The id of the last async control. 0 is none.
    last_drive: u64,
    /// The `last_drive` of when the last test file ended. The turns of the async controls up to it
    /// do nothing, so their promises stay pending.
    abandoned_drive: u64,
    /// Where the timer callback that an async control is firing leaves what it throws.
    throw_capture: Option<NonNull<ThrowCapture>>,
    /// The sorted fake timers. TimerHeap is not optimal here because we need these operations:
    /// - peek/takeFirst (provided by TimerHeap)
    /// - peekLast (cannot be implemented efficiently with TimerHeap)
    /// - count (cannot be implemented efficiently with TimerHeap)
    pub(crate) timers: TimerHeap,
}

impl FakeTimers {
    fn set_now(&mut self, global: &JSGlobalObject, now: &Timespec, js: Option<f64>) {
        let vm = global.bun_vm().as_mut();
        self.now = Some(*now);
        // Mirror into T0 storage so `Timespec::now(AllowMockedTime)` sees
        // the fake clock.
        bun_core::mock_time::set(now.ns() as i64);
        let timespec_ms: f64 = now.ms() as f64;
        if let Some(js) = js {
            self.date_now_offset = js.floor() - timespec_ms;
        }
        let date_now = self.date_now_offset + timespec_ms;
        JSMock__setOverridenDateNow(global, date_now);
        bun_core::mock_time::set_wall_ms(date_now);

        vm.overridden_performance_now = Some(now.ns());
        // `Date.now() == date_now_offset + performance.now()`, so the offset is
        // the fake clock's `performance.timeOrigin`.
        vm.overridden_time_origin = Some(self.date_now_offset);
    }

    fn clear_now(&mut self, global: &JSGlobalObject) {
        let vm = global.bun_vm().as_mut();
        self.now = None;
        bun_core::mock_time::clear();
        bun_core::mock_time::clear_wall();
        // NaN is JSGlobalObject::overridenDateNow's "no override" sentinel; a
        // real -1 would pin Date.now() at 1969-12-31T23:59:59.999Z.
        JSMock__setOverridenDateNow(global, f64::NAN);
        vm.overridden_performance_now = None;
        vm.overridden_time_origin = None;
    }
}

/// `jest.setSystemTime` (C++ `JSMock__jsSetSystemTime`) writes
/// `globalObject->overridenDateNow` directly; rebase `date_now_offset` here so
/// the next `advanceTimersByTime` recomputes `Date.now` from the set time
/// instead of the stale activation-time offset. `performance.now()` does not
/// move, so `performance.timeOrigin` follows the rebased offset. No-op when
/// fake timers are inactive. A NaN `ms` is the "clear override" sentinel:
/// `Date.now()` is real again until the next tick, so the mocked wall clock
/// and `performance.timeOrigin` go back to real as well.
#[unsafe(no_mangle)]
extern "C" fn Bun__FakeTimers__setSystemTime(global: &JSGlobalObject, ms: f64) {
    // SAFETY: `timer::All` is per-thread and lives as long as the VM. Nothing here re-enters it.
    let fake_timers = unsafe { &mut (*timer_all()).fake_timers };
    let Some(current) = fake_timers.now else {
        return;
    };
    let vm = global.bun_vm().as_mut();
    if ms.is_nan() {
        bun_core::mock_time::clear_wall();
        vm.overridden_time_origin = None;
        return;
    }
    fake_timers.date_now_offset = ms - current.ms() as f64;
    bun_core::mock_time::set_wall_ms(ms);
    vm.overridden_time_origin = Some(fake_timers.date_now_offset);
}

use crate::jsc_hooks::timer_all;

#[inline]
fn from_el_timespec(t: &ElTimespec) -> Timespec {
    Timespec { sec: t.sec, nsec: t.nsec }
}

/// Owners of the nodes [`FakeTimers::clear`] popped, still to be told their
/// timer is gone. Released only once the `FakeTimers` borrow has ended: these
/// paths re-enter `timer::All` (`TimerObjectInternals::cancel` → `All::remove`,
/// `Timeout` deinit → `timer_remove`).
#[derive(Default)]
#[must_use]
struct ClearedTimers {
    /// Marking `state = CANCELLED` alone strands the `Box<TimeoutObject>`: its
    /// refcount sticks at 2 (wrapper +1 from `init_with`, heap +1 from
    /// `reschedule`) and `internals.this_value` still GC-roots the wrapper, so
    /// neither side ever frees.
    pinned: Vec<core::ptr::NonNull<TimerObjectInternals>>,
    /// Likewise, an unlinked `AbortSignal.timeout()` timer is still its
    /// signal's `m_timeout`, and `JSAbortSignalOwner::isReachableFromOpaqueRoots`
    /// pins an observed signal's wrapper for as long as that is set. Only the
    /// signal's `cancelTimer()` clears it (and frees the box).
    signal_timeouts: Vec<*mut AbortSignalTimeout>,
    /// A `Bun.cron()` job keeps the event loop alive until it is stopped.
    cron_jobs: Vec<*mut CronJob>,
}

impl ClearedTimers {
    fn release(self, vm: *mut VirtualMachine) {
        for p in self.pinned {
            TimerObjectInternals::release_heap_pin(p, vm);
        }
        for t in self.signal_timeouts {
            // SAFETY: `clear` popped `t` from the fake heap, so its box is
            // still owned by a live signal; JS thread; the `FakeTimers` borrow
            // ended before this call. `t` is freed by the call.
            unsafe { AbortSignalTimeout::discard(t) };
        }
        for job in self.cron_jobs {
            // SAFETY: `clear` popped `job`'s node from the fake heap, so the
            // job was scheduled and its JS wrapper (strong while scheduled)
            // keeps it alive; no JS has run since; the `FakeTimers` borrow
            // ended before this call.
            CronJob::stop_dropped_from_fake_heap(unsafe { bun_ptr::ThisPtr::new(job) });
        }
    }
}

impl FakeTimers {
    pub(crate) fn is_active(&self) -> bool {
        self.now.is_some()
    }

    /// 1 while a fake timer's callback runs (sinon's `duringTick` rule): a zero-delay re-arm is due again in the drain that runs it.
    /// The tick of an async control runs the continuations of its timers between its turns, so the rule holds for all of it.
    pub(crate) fn min_delay_ms(&self) -> u32 {
        let during_tick = self.is_active()
            && (self.firing > 0
                || self
                    .drives
                    .iter()
                    .any(|drive| drive.phase == DrivePhase::Tick));
        u32::from(during_tick)
    }

    fn activate(&mut self, js_now: f64, timer_limit: u32, global: &JSGlobalObject) {
        self.drop_drives();
        self.timer_limit = timer_limit;
        self.set_now(global, &Timespec::EPOCH, Some(js_now));
    }

    fn deactivate(&mut self, global: &JSGlobalObject) -> ClearedTimers {
        self.drop_drives();
        let cleared = self.clear();
        self.clear_now(global);
        cleared
    }

    /// Restore real timers without draining the fake heap. Used by the
    /// `--isolate` file boundary so `swap_global_for_test_isolation`'s
    /// `cancel_all_timeout_objects` (which runs after the outgoing global's
    /// JS has stopped) can walk the still-populated fake heap and release
    /// `TimeoutObject` pins and discard `AbortSignalTimeout` timers.
    pub(crate) fn reset_for_isolation(&mut self, global: &JSGlobalObject) {
        self.drop_drives();
        self.clear_now(global);
    }

    /// Pop every fake timer. Popping only unlinks the nodes; the owners that
    /// need to hear about it are returned for the caller to release.
    fn clear(&mut self) -> ClearedTimers {
        let mut cleared = ClearedTimers::default();
        while let Some(timer) = self.timers.delete_min() {
            // SAFETY: `delete_min` returned a live node; the owner it belongs
            // to stays live until the caller's release pass.
            unsafe {
                (*timer).in_heap = InHeap::None;
                (*timer).state = EventLoopTimerState::CANCELLED;
                match (*timer).tag {
                    EventLoopTimerTag::TimeoutObject => {
                        let parent = TimeoutObject::from_timer_ptr(timer);
                        cleared.pinned.push(core::ptr::NonNull::new_unchecked(
                            core::ptr::addr_of_mut!((*parent).internals),
                        ));
                    }
                    EventLoopTimerTag::AbortSignalTimeout => {
                        cleared
                            .signal_timeouts
                            .push(AbortSignalTimeout::from_timer_ptr(timer));
                    }
                    EventLoopTimerTag::CronJob => {
                        cleared.cron_jobs.push(CronJob::from_timer_ptr(timer));
                    }
                    tag => debug_assert!(
                        false,
                        "{} timer in the fake heap has no release path",
                        <&'static str>::from(tag),
                    ),
                }
            }
        }

        cleared
    }

    fn execute_next(global: &JSGlobalObject) -> JsResult<bool> {
        // SAFETY: `timer_all()` is the live per-thread `All`; the borrow ends
        // at this statement, before `fire` re-enters `All::insert`.
        let next = match unsafe { (*timer_all()).fake_timers.timers.delete_min() } {
            Some(n) => n,
            None => return Ok(false),
        };

        Self::fire(global, next)?;
        Ok(true)
    }

    /// Fired from inside the `jest` timer-control host functions. The fake
    /// clock is a timer drain of its own: like `All::drain_timers`, a
    /// timer whose callback threw is reported and the drain goes on; only the
    /// VM's termination stops it, thrown to the `jest` host function driving it.
    fn fire(global: &JSGlobalObject, next: *mut EventLoopTimer) -> JsResult<()> {
        let _vm = global.bun_vm();

        // SAFETY: `next` was just popped from our heap; live until callback completes.
        let deadline = from_el_timespec(unsafe { &(*next).next });
        let all = timer_all();
        let now = {
            // SAFETY: `all` is the live per-thread `All`. The borrow ends with
            // this block, before `EventLoopTimer::fire` re-enters `All::insert`.
            let this = unsafe { &mut (*all).fake_timers };
            debug_assert!(this.is_active());
            // An earlier callback in this drain can advance the clock past `deadline` with a
            // `jest` timer call. The timer then fires late, like an overdue real timer.
            let now = match this.now {
                Some(current) if current.greater(&deadline) => current,
                _ => deadline,
            };
            this.set_now(global, &now, None);
            this.firing += 1;
            now
        };
        // SAFETY: `next` is live; `fire` takes `*mut Self` (noalias re-entrancy)
        // and an erased `*mut ()` for the VM.
        let fired = unsafe { EventLoopTimer::fire(next, &now, bun_jsc::virtual_machine::VirtualMachine::get_mut_ptr().cast()) };
        // SAFETY: as above; the callback has returned.
        unsafe { (*all).fake_timers.firing -= 1 };
        match fired {
            Ok(()) => Ok(()),
            Err(err) => bun_jsc::task::report_error_or_terminate(global, err)
                .map_err(|stopped| stopped.throw(global)),
        }
    }

    fn execute_until(global: &JSGlobalObject, until: Timespec) -> JsResult<()> {
        let all = timer_all();
        'outer: loop {
            let next = 'blk: {
                // SAFETY: `all` is the live per-thread `All`; each borrow
                // lasts one statement and none spans `fire`.
                let Some(peek) = (unsafe { (*all).fake_timers.timers.peek() }) else {
                    break 'outer;
                };
                // SAFETY: `peek` is the heap root; live while linked.
                if from_el_timespec(unsafe { &(*peek).next }).greater(&until) {
                    break 'outer;
                }
                // bun.assert always evaluates its arg; debug_assert! does NOT in release.
                // Hoist the side-effecting delete_min() out so the timer is removed in all builds.
                // SAFETY: as above.
                let min = unsafe { (*all).fake_timers.timers.delete_min() }.expect("unreachable");
                debug_assert!(core::ptr::eq(min, peek));
                break 'blk min;
            };
            Self::fire(global, next)?;
        }
        Ok(())
    }

    fn execute_only_pending_timers(global: &JSGlobalObject) -> JsResult<()> {
        // SAFETY: `timer_all()` is the live per-thread `All`.
        let until = match unsafe { (*timer_all()).fake_timers.timers.find_max() } {
            // SAFETY: `t` is reachable in the heap and live while linked.
            Some(t) => from_el_timespec(unsafe { &(*t).next }),
            None => return Ok(()),
        };
        Self::execute_until(global, until)
    }

    /// A timer that re-arms itself on every fire never empties the heap: a `setInterval`, a
    /// recursive `setTimeout`, a `Bun.cron()` job, or an interval that a built-in module arms for
    /// itself (the connections sweep of `node:http`). No test timeout can interrupt this drain.
    /// Like Jest, fire at most `timer_limit` timers, then throw if any remain.
    fn execute_all_timers(global: &JSGlobalObject) -> JsResult<()> {
        // SAFETY: per-thread `timer::All`; the borrow ends at this statement, before a timer fires.
        let limit = unsafe { (*timer_all()).fake_timers.timer_limit };
        for _ in 0..limit {
            if !Self::execute_next(global)? {
                return Ok(());
            }
        }
        // SAFETY: as above; no borrow of `fake_timers` is live.
        if unsafe { (*timer_all()).fake_timers.timers.peek() }.is_none() {
            return Ok(());
        }
        Err(global.throw_value(over_limit_error(global, limit)))
    }
}

/// What `runAllTimers()` throws and `runAllTimersAsync()` rejects with after `limit` timers, when
/// more are pending. The message is Jest's.
fn over_limit_error(global: &JSGlobalObject, limit: u32) -> JSValue {
    global.create_error_instance(format_args!(
        "Aborting after running {limit} timers, assuming an infinite loop!"
    ))
}

// ===
// JS Functions
// ===

fn error_unless_fake_timers(global: &JSGlobalObject) -> JsResult<()> {
    // SAFETY: per-thread `timer::All`, live for the VM lifetime.
    if unsafe { (*timer_all()).fake_timers.is_active() } {
        return Ok(());
    }
    Err(global.throw(format_args!(
        "Fake timers are not active. Call useFakeTimers() first."
    )))
}

/// Set or remove the "clock" property on setTimeout to indicate that fake timers are active.
/// This is used by testing-library/react's jestFakeTimersAreEnabled() function to detect
/// if jest.advanceTimersByTime() should be called when draining the microtask queue.
fn set_fake_timer_marker(global: &JSGlobalObject, enabled: bool) -> JsResult<()> {
    let global_this = global.to_js_value();
    // `get()` (vs `get_own_truthy`) so the LUT-registered `setTimeout` is
    // resolved even before first reification — semantically equivalent on
    // the global since `setTimeout` is always an own property.
    let Some(set_timeout_fn) = global_this.get(global, "setTimeout")? else {
        return Ok(());
    };
    if !set_timeout_fn.is_object() {
        return Ok(());
    }
    // testing-library/react checks Object.hasOwnProperty.call(setTimeout, 'clock')
    // to detect if fake timers are enabled.
    if enabled {
        bun_jsc::cpp::JSMock__defineFakeTimersMarker(global, set_timeout_fn)?;
    } else {
        set_timeout_fn.delete_property(global, "clock")?;
    }
    Ok(())
}

pub(crate) fn use_fake_timers(
    cx: &mut JsScope<'_>,
    this_value: JsLocal<'_>,
    options: Option<FakeTimersImplementationOrOptions>,
) -> JsResult<JSValue> {
    let global = cx.global();
    // SAFETY: FFI call into C++ JSMock
    let mut js_now = JSMock__getCurrentUnixTimeMs();
    let mut timer_limit = DEFAULT_TIMER_LIMIT;

    // Jest 26 compat: useFakeTimers("modern" | "legacy") is a no-op.
    if let Some(FakeTimersImplementationOrOptions::Options(options)) = options {
        if let Some(now) = options.now {
            // NaN is `JSGlobalObject::overridenDateNow`'s "no override" sentinel.
            if !now.is_finite() {
                return Err(global.throw_invalid_arguments(format_args!(
                    "'now' must be a finite number or a valid Date"
                )));
            }
            js_now = now;
        }
        // Vitest's name, then Jest's.
        for (option, limit) in [
            ("loopLimit", options.loop_limit),
            ("timerLimit", options.timer_limit),
        ] {
            let Some(limit) = limit else {
                continue;
            };
            if !(0.0..=f64::from(u32::MAX)).contains(&limit) {
                return Err(global.throw_invalid_arguments(format_args!(
                    "'{option}' is out of range. It must be >= 0 and <= {}. Received {limit}",
                    u32::MAX
                )));
            }
            // 0 is the default, as in Jest (`timerLimit || 100_000`) and @sinonjs/fake-timers.
            if limit as u32 != 0 {
                timer_limit = limit as u32;
            }
        }
    }

    // Set setTimeout.clock = true to signal that fake timers are enabled.
    // This is used by testing-library/react to detect if jest.advanceTimersByTime should be called.
    // This can run user code and throw, so do it before turning on the fake clock.
    set_fake_timer_marker(global, true)?;

    // SAFETY: `timer::All` is per-thread, and `activate` doesn't re-enter it.
    unsafe {
        (*timer_all())
            .fake_timers
            .activate(js_now, timer_limit, global)
    };

    Ok(bun_jsc::cpp::JSMock__toThisStrict(
        global,
        this_value.to_js(),
    ))
}

pub(crate) fn use_real_timers(cx: &mut JsScope<'_>, this_value: JsLocal<'_>) -> JsResult<JSValue> {
    let global = cx.global();
    // SAFETY: per-thread `timer::All`; the borrow ends before `release`.
    let cleared = unsafe { (*timer_all()).fake_timers.deactivate(global) };
    cleared.release(global.bun_vm_ptr());

    // Remove the setTimeout.clock marker when switching back to real timers.
    set_fake_timer_marker(global, false)?;

    Ok(bun_jsc::cpp::JSMock__toThisStrict(
        global,
        this_value.to_js(),
    ))
}

pub(crate) fn advance_timers_to_next_timer(
    cx: &mut JsScope<'_>,
    this_value: JsLocal<'_>,
) -> JsResult<JSValue> {
    let global = cx.global();
    error_unless_fake_timers(global)?;

    FakeTimers::execute_next(global)?;

    Ok(bun_jsc::cpp::JSMock__toThisStrict(
        global,
        this_value.to_js(),
    ))
}

/// The `ms` of `advanceTimersByTime(ms)` and of its async twin, as the milliseconds to advance by.
/// `name` is the control, for what it throws.
fn advance_ms(global: &JSGlobalObject, milliseconds: f64, name: &str) -> JsResult<f64> {
    let max_advance = u32::MAX;
    if milliseconds.is_nan() || milliseconds < 0.0 || milliseconds > max_advance as f64 {
        return Err(global.throw_invalid_arguments(format_args!(
            "{name}() ms is out of range. It must be >= 0 and <= {}. Received {:.0}",
            max_advance, milliseconds
        )));
    }
    // When advanceTimersByTime(0) is called, advance by 1ms to fire setTimeout(fn, 0) timers.
    // This is because setTimeout(fn, 0) is internally scheduled with a 1ms delay per HTML spec,
    // and Jest/testing-library expect advanceTimersByTime(0) to fire such "immediate" timers.
    Ok(if milliseconds == 0.0 { 1.0 } else { milliseconds })
}

pub(crate) fn advance_timers_by_time(
    cx: &mut JsScope<'_>,
    this_value: JsLocal<'_>,
    milliseconds: f64,
) -> JsResult<JSValue> {
    let global = cx.global();
    error_unless_fake_timers(global)?;

    let effective_advance = advance_ms(global, milliseconds, "advanceTimersByTime")?;
    // SAFETY: per-thread `timer::All`, live for the VM lifetime.
    let Some(current) = (unsafe { (*timer_all()).fake_timers.now }) else {
        return Err(global.throw_invalid_arguments(format_args!(
            "Fake timers not initialized. Initialize with useFakeTimers() first."
        )));
    };
    let target = current.add_ms_float(effective_advance);

    let advanced = FakeTimers::execute_until(global, target);
    // SAFETY: `timer::All` is per-thread, and `set_now` doesn't re-enter it.
    let fake_timers = unsafe { &mut (*timer_all()).fake_timers };
    // A fired callback can call `useRealTimers()` or move the clock past `target`.
    if fake_timers.now.is_some_and(|now| !now.greater(&target)) {
        fake_timers.set_now(global, &target, None);
    }
    advanced?;

    Ok(bun_jsc::cpp::JSMock__toThisStrict(
        global,
        this_value.to_js(),
    ))
}

pub(crate) fn run_only_pending_timers(
    cx: &mut JsScope<'_>,
    this_value: JsLocal<'_>,
) -> JsResult<JSValue> {
    let global = cx.global();
    error_unless_fake_timers(global)?;

    FakeTimers::execute_only_pending_timers(global)?;

    Ok(bun_jsc::cpp::JSMock__toThisStrict(
        global,
        this_value.to_js(),
    ))
}

pub(crate) fn run_all_timers(cx: &mut JsScope<'_>, this_value: JsLocal<'_>) -> JsResult<JSValue> {
    let global = cx.global();
    error_unless_fake_timers(global)?;

    FakeTimers::execute_all_timers(global)?;

    Ok(bun_jsc::cpp::JSMock__toThisStrict(
        global,
        this_value.to_js(),
    ))
}

pub(crate) fn get_timer_count(heap: &JsHeap<'_>) -> JsResult<usize> {
    // SAFETY: throws, and the body returns.
    error_unless_fake_timers(unsafe { heap.global() })?;

    // SAFETY: per-thread `timer::All`, live for the VM lifetime.
    Ok(unsafe { (*timer_all()).fake_timers.timers.count() })
}

pub(crate) fn clear_all_timers(cx: &mut JsScope<'_>, this_value: JsLocal<'_>) -> JsResult<JSValue> {
    let global = cx.global();
    error_unless_fake_timers(global)?;

    // SAFETY: per-thread `timer::All`; the borrow ends before `release`.
    let cleared = unsafe { (*timer_all()).fake_timers.clear() };
    cleared.release(global.bun_vm_ptr());

    Ok(bun_jsc::cpp::JSMock__toThisStrict(
        global,
        this_value.to_js(),
    ))
}

pub(crate) fn is_fake_timers() -> bool {
    // SAFETY: per-thread `timer::All`, live for the VM lifetime.
    unsafe { (*timer_all()).fake_timers.is_active() }
}

// ===
// Async controls
// ===
//
// `advanceTimersByTimeAsync()`, `advanceTimersToNextTimerAsync()`, `runAllTimersAsync()` and
// `runOnlyPendingTimersAsync()` fire one fake timer per turn of the real event loop, so the
// promise callbacks of a timer run before the next timer fires. A turn is a real `setImmediate`,
// which `useFakeTimers()` does not fake. The turns are those of `tickAsync`, `nextAsync`,
// `runAllAsync` and `runToLastAsync` in @sinonjs/fake-timers, which Jest and Vitest call.

/// Jest's default `timerLimit`.
const DEFAULT_TIMER_LIMIT: u32 = 100_000;

/// An async control in flight. Plain data: what outlives a turn is the record in the arguments of
/// the pending immediate.
#[derive(Clone, Copy)]
struct Drive {
    id: u64,
    /// The context of the script that called the control. When it stops, the pending turn is
    /// cancelled with its other immediates.
    context: bun_jsc::ContextId,
    control: AsyncControl,
    phase: DrivePhase,
    /// What is left of the window of a tick. The window ends at `now + remaining`, so it moves
    /// with a clock that something else moves, as sinon's `compensationCheck` moves `tickTo`.
    remaining: Timespec,
    /// `RunAll`: the timers fired. `ToNextTimer`: the steps left.
    count: u32,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum AsyncControl {
    AdvanceByTime,
    ToNextTimer,
    RunAll,
    RunOnlyPending,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum DrivePhase {
    /// Fire the next timer, whenever it is due.
    Next,
    /// sinon's `nextAsync` settles a turn after its timer.
    AfterNext,
    /// sinon's `runToLastAsync` finds the last pending timer, and ticks to it from the next turn.
    FindLast,
    /// The first turn of a tick.
    TickStart,
    /// Fire the timers of the window, then move the clock to its end.
    Tick,
}

/// What a turn leaves its control with.
enum Turn {
    Again,
    /// Resolve, or reject with what a timer callback threw.
    Settle,
    /// `runAllTimersAsync()` fired this many timers, and more are pending.
    OverLimit(u32),
    /// The test file of the control is over. Its promise stays pending.
    Abandoned,
}

// The record of an async control: a JS array that each turn hands to the next.
const RECORD_PROMISE: u32 = 0;
/// What the promise resolves with.
const RECORD_VALUE: u32 = 1;
const RECORD_DRIVE: u32 = 2;
/// Whether a timer callback threw. `RECORD_ERROR` is the first thing thrown.
const RECORD_FAILED: u32 = 3;
const RECORD_ERROR: u32 = 4;

/// See [`FakeTimers::fire_capturing`].
struct ThrowCapture {
    /// The JS object of the `setTimeout` / `setInterval` that is firing.
    timer: JSValue,
    thrown: Cell<JSValue>,
}

/// `Bun__JSTimeout__call`, with what a timer callback threw. An async control that is firing
/// `timer` takes it, to reject with. The caller reports anything else.
#[unsafe(no_mangle)]
extern "C" fn Bun__FakeTimers__captureThrow(timer: JSValue, thrown: JSValue) -> bool {
    let all = timer_all();
    if all.is_null() {
        return false;
    }
    // SAFETY: `all` is the live per-thread `All`. A capture in the slot is on the stack of the
    // `fire_capturing` that is running this callback.
    let Some(capture) = (unsafe { (*all).fake_timers.throw_capture.map(|slot| slot.as_ref()) })
    else {
        return false;
    };
    if capture.timer != timer || !capture.thrown.get().is_empty() {
        return false;
    }
    capture.thrown.set(thrown);
    true
}

/// `at`, later by the duration `by`.
fn later(at: &Timespec, by: &Timespec) -> Timespec {
    const NS_PER_S: i64 = 1_000_000_000;
    let mut sec = at.sec.wrapping_add(by.sec);
    let mut nsec = at.nsec + by.nsec;
    if nsec >= NS_PER_S {
        sec = sec.wrapping_add(1);
        nsec -= NS_PER_S;
    }
    Timespec { sec, nsec }
}

impl FakeTimers {
    fn start_drive(
        &mut self,
        context: bun_jsc::ContextId,
        control: AsyncControl,
        remaining: Timespec,
        count: u32,
    ) -> u64 {
        self.last_drive += 1;
        self.drives.push(Drive {
            id: self.last_drive,
            context,
            control,
            phase: match control {
                AsyncControl::AdvanceByTime => DrivePhase::TickStart,
                AsyncControl::RunOnlyPending => DrivePhase::FindLast,
                AsyncControl::ToNextTimer | AsyncControl::RunAll => DrivePhase::Next,
            },
            remaining,
            count,
        });
        self.last_drive
    }

    fn end_drive(&mut self, id: u64) {
        if let Some(index) = self.drives.iter().position(|drive| drive.id == id) {
            self.drives.swap_remove(index);
        }
    }

    /// The clock of the async controls in flight is gone. Each settles in its next turn.
    fn drop_drives(&mut self) {
        self.drives.clear();
    }

    /// `context` has stopped, and the pending turns of its async controls went with its immediates.
    pub(crate) fn end_drives_of(&mut self, context: bun_jsc::ContextId) {
        self.drives.retain(|drive| drive.context != context);
    }

    /// The test file of the async controls in flight is over, so nothing is left to await them.
    /// Their turns stop and their promises stay pending. The clock stays as the file left it.
    fn abandon_drives(&mut self) {
        self.drives.clear();
        self.abandoned_drive = self.last_drive;
    }

    /// Takes the first fake timer off the heap if it is due by `until`, and whenever it is due
    /// without one.
    fn pop_due(&mut self, until: Option<&Timespec>) -> Option<*mut EventLoopTimer> {
        let first = self.timers.peek()?;
        // SAFETY: `first` is the heap root; live while linked.
        let deadline = from_el_timespec(unsafe { &(*first).next });
        if until.is_some_and(|until| deadline.greater(until)) {
            return None;
        }
        self.timers.delete_min()
    }

    /// [`FakeTimers::fire`] for an async control. What the callback of a `setTimeout` or a
    /// `setInterval` throws is returned and not reported: the control rejects with the first.
    /// What an `AbortSignal.timeout()` listener or a `Bun.cron()` callback throws is reported as
    /// ever.
    fn fire_capturing(
        global: &JSGlobalObject,
        next: *mut EventLoopTimer,
    ) -> JsResult<Option<JSValue>> {
        // SAFETY: `next` was just popped from the fake heap; its owner is live until it has fired.
        let timer = unsafe {
            if (*next).tag == EventLoopTimerTag::TimeoutObject {
                (*TimeoutObject::from_timer_ptr(next))
                    .internals
                    .this_value
                    .get()
                    .try_get()
            } else {
                None
            }
        };
        let Some(timer) = timer else {
            Self::fire(global, next)?;
            return Ok(None);
        };
        let slot = ThrowCapture {
            timer,
            thrown: Cell::new(JSValue::ZERO),
        };
        let all = timer_all();
        // SAFETY: `all` is the live per-thread `All`; each borrow is one statement. `slot`
        // outlives its stay in `throw_capture`, which ends on every way out of this function.
        let outer = unsafe {
            (*all)
                .fake_timers
                .throw_capture
                .replace(NonNull::from(&slot))
        };
        let fired = {
            let _restore = scopeguard::guard((), |()| {
                // SAFETY: as above.
                unsafe { (*all).fake_timers.throw_capture = outer };
            });
            Self::fire(global, next)
        };
        fired?;
        let thrown = slot.thrown.get();
        Ok((!thrown.is_empty()).then_some(thrown))
    }

    /// One turn of the async control `id`. `failed` is whether one of its timer callbacks has
    /// thrown. Returns what to do next, and what the timer of this turn threw.
    fn turn(global: &JSGlobalObject, id: u64, failed: bool) -> JsResult<(Turn, Option<JSValue>)> {
        let all = timer_all();
        // SAFETY: `all` is the live per-thread `All`. This borrow ends before a timer fires.
        let this = unsafe { &mut (*all).fake_timers };
        if id <= this.abandoned_drive {
            return Ok((Turn::Abandoned, None));
        }
        // Without its drive the control has lost its clock, to `useRealTimers()` or to another
        // `useFakeTimers()`.
        let (Some(index), Some(now)) = (
            this.drives.iter().position(|drive| drive.id == id),
            this.now,
        ) else {
            return Ok((Turn::Settle, None));
        };
        let mut drive = this.drives[index];

        let next = match drive.phase {
            DrivePhase::FindLast => {
                let Some(last) = this.timers.find_max() else {
                    this.end_drive(id);
                    return Ok((Turn::Settle, None));
                };
                // SAFETY: `last` is in the heap; live while linked.
                let deadline = from_el_timespec(unsafe { &(*last).next });
                drive.remaining = if deadline.greater(&now) {
                    deadline.duration(&now)
                } else {
                    Timespec::EPOCH
                };
                drive.phase = DrivePhase::TickStart;
                this.drives[index] = drive;
                return Ok((Turn::Again, None));
            }
            DrivePhase::AfterNext => {
                if failed {
                    this.end_drive(id);
                    return Ok((Turn::Settle, None));
                }
                // Jest: "Fire all timers at this point". A tick with no width does.
                drive.remaining = Timespec::EPOCH;
                drive.phase = DrivePhase::TickStart;
                this.drives[index] = drive;
                return Ok((Turn::Again, None));
            }
            DrivePhase::Next => {
                if drive.control == AsyncControl::RunAll && drive.count >= this.timer_limit {
                    let limit = this.timer_limit;
                    let pending = this.timers.peek().is_some();
                    this.end_drive(id);
                    let turn = if pending {
                        Turn::OverLimit(limit)
                    } else {
                        Turn::Settle
                    };
                    return Ok((turn, None));
                }
                let Some(next) = this.pop_due(None) else {
                    if drive.control == AsyncControl::RunAll {
                        this.end_drive(id);
                        return Ok((Turn::Settle, None));
                    }
                    // sinon's `nextAsync` settles in this turn when there is no timer.
                    drive.remaining = Timespec::EPOCH;
                    drive.phase = DrivePhase::TickStart;
                    this.drives[index] = drive;
                    return Ok((Turn::Again, None));
                };
                if drive.control == AsyncControl::RunAll {
                    drive.count += 1;
                } else {
                    drive.phase = DrivePhase::AfterNext;
                }
                this.drives[index] = drive;
                next
            }
            DrivePhase::TickStart | DrivePhase::Tick => {
                drive.phase = DrivePhase::Tick;
                let until = later(&now, &drive.remaining);
                let Some(next) = this.pop_due(Some(&until)) else {
                    // The window is over, and the clock moves to its end.
                    if until.greater(&now) {
                        this.set_now(global, &until, None);
                    }
                    if drive.control == AsyncControl::ToNextTimer
                        && !failed
                        && drive.count > 1
                        && this.timers.peek().is_some()
                    {
                        drive.count -= 1;
                        drive.phase = DrivePhase::Next;
                        this.drives[index] = drive;
                        return Ok((Turn::Again, None));
                    }
                    this.end_drive(id);
                    return Ok((Turn::Settle, None));
                };
                // SAFETY: `next` was just popped; live until it has fired.
                let deadline = from_el_timespec(unsafe { &(*next).next });
                // The window up to this timer is spent. A timer that is overdue takes nothing.
                if deadline.greater(&now) {
                    drive.remaining = until.duration(&deadline);
                }
                this.drives[index] = drive;
                next
            }
        };

        // The callback can start and end async controls, and turn the fake clock off.
        let thrown = Self::fire_capturing(global, next)?;
        // sinon's `runAllAsync` rejects in the turn of the timer that threw.
        if thrown.is_some() && drive.control == AsyncControl::RunAll {
            end_drive(id);
            return Ok((Turn::Settle, thrown));
        }
        Ok((Turn::Again, thrown))
    }
}

/// Ends the async control `id`, unless its clock already has.
fn end_drive(id: u64) {
    // SAFETY: `timer_all()` is the live per-thread `All`. No borrow of `fake_timers` is held
    // across a call that runs JS, and `FakeTimers::end_drive` doesn't re-enter it.
    unsafe { (*timer_all()).fake_timers.end_drive(id) }
}

/// The runner calls this when a test file is over, in every isolation mode.
pub(crate) fn end_test_file() {
    let all = timer_all();
    if all.is_null() {
        return;
    }
    // SAFETY: `all` is the live per-thread `All`; `abandon_drives` doesn't re-enter it.
    unsafe { (*all).fake_timers.abandon_drives() }
}

/// Queues a turn of an async control as a real `setImmediate`. Through the exported thunk, so that
/// `All::set_immediate` keeps its one call site.
fn queue_turn(global: &JSGlobalObject, turn: JSValue, record: JSValue) -> JsResult<()> {
    bun_jsc::host_fn::from_js_host_call(global, || {
        crate::generated_host_exports::Bun__Timer__setImmediate(global, turn, record)
    })?;
    Ok(())
}

/// A turn of an async control: the callback of its immediate, with its record.
pub(crate) fn async_control_turn(
    cx: &mut JsScope<'_>,
    callee: JsLocal<'_>,
    record: JsLocal<'_>,
) -> JsResult<()> {
    let global = cx.global();
    let record = record.to_js();
    let id = record.get_index(global, RECORD_DRIVE)?.as_number() as u64;
    let ran = run_turn(global, callee.to_js(), record, id);
    if ran.is_err() {
        end_drive(id);
    }
    ran
}

fn run_turn(global: &JSGlobalObject, callee: JSValue, record: JSValue, id: u64) -> JsResult<()> {
    let mut failed = record.get_index(global, RECORD_FAILED)?.to_boolean();
    let (turn, thrown) = FakeTimers::turn(global, id, failed)?;
    // sinon's `firstException = firstException || e`: what a later timer of the control throws
    // is dropped.
    if let Some(thrown) = thrown
        && !failed
    {
        record.put_index(global, RECORD_ERROR, thrown)?;
        record.put_index(global, RECORD_FAILED, JSValue::TRUE)?;
        failed = true;
    }

    let promise = record
        .get_index(global, RECORD_PROMISE)?
        .as_promise()
        .map(JSPromise::opaque_mut)
        .expect("the record of an async control has its promise");
    match turn {
        Turn::Again => return queue_turn(global, callee, record),
        Turn::Abandoned => return Ok(()),
        Turn::Settle if failed => {
            promise.reject(global, record.get_index(global, RECORD_ERROR))?;
        }
        Turn::Settle => {
            promise.resolve(global, record.get_index(global, RECORD_VALUE)?)?;
        }
        Turn::OverLimit(limit) => {
            promise.reject(global, Ok(over_limit_error(global, limit)))?;
        }
    }
    // An `expect(promise).resolves` or `.rejects` that spins the event loop for this promise polls
    // for I/O after this turn, and nothing else is due to end that poll.
    global.bun_vm().as_mut().wakeup();
    Ok(())
}

/// What the promise of an async control resolves with: `vi` when the control was called on `vi`, as
/// in Vitest, and `undefined` when it was called on anything else, as in Jest.
fn async_control_value(global: &JSGlobalObject, this: JSValue) -> JsResult<JSValue> {
    if !this.is_object() {
        return Ok(JSValue::UNDEFINED);
    }
    let module = bun_jsc::host_fn::from_js_host_call(global, || {
        crate::test_runner::jest::Jest::Bun__Jest__testModuleObject(global)
    })?;
    Ok(match module.get(global, "vi")? {
        Some(vi) if vi == this => this,
        _ => JSValue::UNDEFINED,
    })
}

/// Starts an async control. `arg` is its first argument. It does not throw what its sync twin
/// throws: its promise rejects.
fn start_async_control(
    cx: &mut JsScope<'_>,
    this_value: JsLocal<'_>,
    arg: JSValue,
    control: AsyncControl,
) -> JsResult<JSValue> {
    let global = cx.global();
    // What the promise resolves with, the window of a tick, and the steps of
    // `advanceTimersToNextTimerAsync()`.
    let arguments = (|| -> JsResult<(JSValue, Timespec, u32)> {
        error_unless_fake_timers(global)?;
        let value = async_control_value(global, this_value.to_js())?;
        let (remaining, count) = match control {
            AsyncControl::AdvanceByTime => {
                if !arg.is_number() {
                    return Err(global.throw_invalid_arguments(format_args!(
                        "advanceTimersByTimeAsync() expects a number of milliseconds"
                    )));
                }
                let ms = advance_ms(global, arg.as_number(), "advanceTimersByTimeAsync")?;
                (Timespec::EPOCH.add_ms_float(ms), 0)
            }
            AsyncControl::ToNextTimer if arg.is_undefined() => (Timespec::EPOCH, 1),
            AsyncControl::ToNextTimer if arg.is_number() => {
                // Jest: `for (let i = steps; i > 0; i--)`.
                let steps = arg.as_number().ceil().clamp(0.0, u32::MAX as f64) as u32;
                (Timespec::EPOCH, steps)
            }
            AsyncControl::ToNextTimer => {
                return Err(global.throw_invalid_arguments(format_args!(
                    "advanceTimersToNextTimerAsync() expects a number of steps"
                )));
            }
            AsyncControl::RunAll | AsyncControl::RunOnlyPending => (Timespec::EPOCH, 0),
        };
        Ok((value, remaining, count))
    })();
    let (value, remaining, count) = match arguments {
        Ok(arguments) => arguments,
        Err(err) => {
            return Ok(JSPromise::rejected_promise_with_caught_exception(global, err)?.to_js());
        }
    };
    if control == AsyncControl::ToNextTimer && count == 0 {
        return Ok(JSPromise::resolved_promise_value(global, value));
    }

    let promise = JSPromise::create(global).to_js();
    let context = global.bun_vm().context_of_caller().id();
    // SAFETY: per-thread `timer::All`; `start_drive` doesn't re-enter it.
    let id = unsafe {
        (*timer_all())
            .fake_timers
            .start_drive(context, control, remaining, count)
    };
    let queued = (|| {
        let record = JSValue::create_array_from_slice(
            global,
            &[
                promise,
                value,
                JSValue::js_number(id as f64),
                JSValue::FALSE,
                JSValue::UNDEFINED,
            ],
        )?;
        let turn = JSFunction::create(
            global,
            "",
            Bun__FakeTimers__asyncControlTurn,
            1,
            Default::default(),
        );
        queue_turn(global, turn, record)
    })();
    if queued.is_err() {
        end_drive(id);
    }
    queued?;
    Ok(promise)
}

pub(crate) fn advance_timers_by_time_async<'a>(
    cx: &mut JsScope<'a>,
    this_value: JsLocal<'a>,
    milliseconds: JsLocal<'a>,
) -> JsResult<JSValue> {
    start_async_control(
        cx,
        this_value,
        milliseconds.to_js(),
        AsyncControl::AdvanceByTime,
    )
}

pub(crate) fn advance_timers_to_next_timer_async<'a>(
    cx: &mut JsScope<'a>,
    this_value: JsLocal<'a>,
    steps: JsLocal<'a>,
) -> JsResult<JSValue> {
    start_async_control(cx, this_value, steps.to_js(), AsyncControl::ToNextTimer)
}

pub(crate) fn run_all_timers_async(
    cx: &mut JsScope<'_>,
    this_value: JsLocal<'_>,
) -> JsResult<JSValue> {
    start_async_control(cx, this_value, JSValue::UNDEFINED, AsyncControl::RunAll)
}

pub(crate) fn run_only_pending_timers_async(
    cx: &mut JsScope<'_>,
    this_value: JsLocal<'_>,
) -> JsResult<JSValue> {
    start_async_control(
        cx,
        this_value,
        JSValue::UNDEFINED,
        AsyncControl::RunOnlyPending,
    )
}

const FAKE_TIMERS_FNS: &[(&str, u32, JSHostFn)] = &[
    ("useFakeTimers", 0, Bun__FakeTimers__useFakeTimers),
    ("useRealTimers", 0, Bun__FakeTimers__useRealTimers),
    ("advanceTimersToNextTimer", 0, Bun__FakeTimers__advanceTimersToNextTimer),
    ("advanceTimersToNextTimerAsync", 0, Bun__FakeTimers__advanceTimersToNextTimerAsync),
    ("advanceTimersByTime", 1, Bun__FakeTimers__advanceTimersByTime),
    ("advanceTimersByTimeAsync", 1, Bun__FakeTimers__advanceTimersByTimeAsync),
    ("runOnlyPendingTimers", 0, Bun__FakeTimers__runOnlyPendingTimers),
    ("runOnlyPendingTimersAsync", 0, Bun__FakeTimers__runOnlyPendingTimersAsync),
    ("runAllTimers", 0, Bun__FakeTimers__runAllTimers),
    ("runAllTimersAsync", 0, Bun__FakeTimers__runAllTimersAsync),
    ("getTimerCount", 0, Bun__FakeTimers__getTimerCount),
    ("clearAllTimers", 0, Bun__FakeTimers__clearAllTimers),
    ("isFakeTimers", 0, Bun__FakeTimers__isFakeTimers),
];

pub(crate) const TIMER_FNS_COUNT: usize = FAKE_TIMERS_FNS.len();

pub(crate) fn put_timers_fns(global: &JSGlobalObject, jest: JSValue, vi: JSValue) {
    for &(name, arity, func) in FAKE_TIMERS_FNS {
        let jsvalue = JSFunction::create(global, name, func, arity, Default::default());
        vi.put(global, name.as_bytes(), jsvalue);
        jest.put(global, name.as_bytes(), jsvalue);
    }
}
