//! `node:perf_hooks`: `node_perf_hooks_binding.bind.ts`.

use bun_jsc::virtual_machine::VirtualMachine;

const NS_PER_MS: f64 = 1e6;

/// `[counted, idle]` in milliseconds: how long the event loop of this thread has counted, and how
/// much of that it was parked in its event provider. The first call asks the loop to count, which
/// it does from its next iteration on. `None` until then.
pub(crate) fn event_loop_idle_time() -> Option<[f64; 2]> {
    let (counted_ns, idle_ns) = VirtualMachine::get().uws_loop_mut().idle_time()?;
    Some([counted_ns as f64 / NS_PER_MS, idle_ns as f64 / NS_PER_MS])
}
