// The native half of the Web Locks API (navigator.locks, https://w3c.github.io/web-locks/).
//
// Held locks and the queues of pending requests live in one process-global registry, so a lock
// excludes every thread of the process: the main thread and all of its Workers. The LockManager
// and Lock classes themselves are JavaScript (src/js/internal/web_locks.ts), built on the four
// functions below.
//
// A request belongs to the context whose script made it. When that context stops (a Worker that
// exits or is terminated, a disposed Bun.ModuleGraph, a test file's global that
// `bun test --isolate` retires), what it holds is released and what it waits for is dropped.

#pragma once

#include "root.h"

namespace WebCore {

// request(record, dispatch, name, shared, ifAvailable, steal): the id of the request. 0 when the
// context has stopped, -1 when it is that of a disposed Bun.ModuleGraph, whose requests stay
// pending. `record` is what `dispatch(record, event)` is later called with; it is kept alive
// until the request ends.
JSC_DECLARE_HOST_FUNCTION(jsWebLocksRequest);
// release(name, id): whether the lock was still held. It is not after it was stolen.
JSC_DECLARE_HOST_FUNCTION(jsWebLocksRelease);
// abort(name, id): whether the request was still pending, and so is gone now.
JSC_DECLARE_HOST_FUNCTION(jsWebLocksAbort);
// query(): { held, pending }
JSC_DECLARE_HOST_FUNCTION(jsWebLocksQuery);

} // namespace WebCore
