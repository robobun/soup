use bun_jsc::{CallFrame, JSGlobalObject, JSValue, JsResult};

const NS_PER_MS: f64 = 1e6;

/// `[counted, idle]` in milliseconds: how long the event loop of this thread has counted, and how
/// much of that it was parked in its event provider. The first call asks the loop to count, which
/// it does from its next iteration on. `undefined` until then.
#[bun_jsc::host_fn]
pub(crate) fn event_loop_idle_time(
    global: &JSGlobalObject,
    _frame: &CallFrame,
) -> JsResult<JSValue> {
    let Some((counted_ns, idle_ns)) = global.bun_vm().uws_loop_mut().idle_time() else {
        return Ok(JSValue::UNDEFINED);
    };
    JSValue::create_array_from_iter(global, [counted_ns, idle_ns].into_iter(), |ns| {
        Ok(JSValue::js_number(ns as f64 / NS_PER_MS))
    })
}
