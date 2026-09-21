// The Web Locks API: `navigator.locks`, and `locks` of node:worker_threads.
// https://w3c.github.io/web-locks/
//
// The held locks and the queues of pending requests live in native code (WebLocks.cpp), in one
// registry for the whole process, so a lock excludes the main thread and every Worker alike.
// What is here is per global: the two classes, the argument checks, and what happens to a
// request once the registry has decided about it. It tells `dispatch()` from an event-loop
// task, so the callback of request() never runs inside request().

const AsyncContextFrame = require("internal/async_context_frame");
const { resistStopPropagation } = require("internal/shared");

type LockMode = "exclusive" | "shared";
type LockGrantedCallback = (lock: Lock | null) => unknown;

/** Rooted by the native side from request() until the request ends, or its context stops. */
interface LockRequest {
  /** The registry's id of the request and, once granted, of the lock. */
  id: number;
  name: string;
  mode: LockMode;
  ifAvailable: boolean;
  steal: boolean;
  callback: LockGrantedCallback;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  /** The async context request() was called in. */
  frame: unknown;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
  /** The promise of request() is settled. */
  settled: boolean;
  /** dispatch() was told the lock is granted, and nothing has given it back or taken it since. */
  held: boolean;
}

/**
 * The id of the request. 0 once the context of the running script has stopped, -1 when that is
 * a disposed Bun.ModuleGraph, where what is started stays pending.
 */
const nativeRequest: (
  request: LockRequest,
  dispatcher: typeof dispatch,
  name: string,
  shared: boolean,
  ifAvailable: boolean,
  steal: boolean,
) => number = $newCppFunction("WebLocks.cpp", "jsWebLocksRequest", 6);
/** False when the lock is not held anymore: a request with `steal` took it. */
const nativeRelease: (name: string, id: number) => boolean = $newCppFunction("WebLocks.cpp", "jsWebLocksRelease", 2);
/** False when the request was granted before it could be aborted. */
const nativeAbort: (name: string, id: number) => boolean = $newCppFunction("WebLocks.cpp", "jsWebLocksAbort", 2);
const nativeQuery: () => { held: object[]; pending: object[] } = $newCppFunction("WebLocks.cpp", "jsWebLocksQuery", 0);

// WebLockEvent in WebLocks.cpp.
const kGranted = 0;
const kBroken = 2;

const kConstruct = Symbol("kConstruct");
const kInspect = Symbol.for("nodejs.util.inspect.custom");

// The channels Node.js publishes to. Looked up by the first request, so that reading
// `navigator.locks` does not load node:diagnostics_channel.
let channels:
  | Record<"start" | "grant" | "miss" | "end", { hasSubscribers: boolean; publish(message: object): void }>
  | undefined;

function publish(which: "start" | "grant" | "miss" | "end", request: LockRequest, error?: unknown) {
  const channel = channels![which];
  if (!channel.hasSubscribers) return;
  const { name, mode } = request;
  if (which === "end") {
    channel.publish({ name, mode, ifAvailable: request.ifAvailable, steal: request.steal, error });
  } else {
    channel.publish({ name, mode });
  }
}

class Lock {
  #name: string;
  #mode: LockMode;

  constructor(token: symbol | undefined = undefined, name: string, mode: LockMode) {
    if (token !== kConstruct) throw $ERR_ILLEGAL_CONSTRUCTOR();
    this.#name = name;
    this.#mode = mode;
  }

  get name(): string {
    if (!(#name in this)) throw $ERR_INVALID_THIS("Lock");
    return this.#name;
  }

  get mode(): LockMode {
    if (!(#name in this)) throw $ERR_INVALID_THIS("Lock");
    return this.#mode;
  }

  [kInspect](_depth: number, options: object, inspect: (value: unknown, options: object) => string) {
    // Bun's formatter also asks the prototype.
    if (!(#name in this)) return this;
    return `Lock ${inspect({ name: this.#name, mode: this.#mode }, options)}`;
  }
}

function stolen() {
  return new DOMException("The operation was aborted", "AbortError");
}

// The end of a request: its lock goes back, if it has one, and its promise is settled, if it is not.
function settle(request: LockRequest, settleWith: (value: unknown) => void, value: unknown, error?: unknown) {
  // Released first: whoever awaits the result may ask for the same lock right away.
  if (request.held) {
    request.held = false;
    if (!nativeRelease(request.name, request.id)) {
      // Stolen, and the callback was done before dispatch() heard of it.
      settleWith = request.reject;
      value = error = stolen();
    }
  }
  if (request.settled) return;
  request.settled = true;
  publish("end", request, error);
  settleWith(value);
}

function dispatch(request: LockRequest, event: number) {
  if (event === kBroken) {
    // A request with `steal` took the lock. The callback keeps running; what it returns is dropped.
    request.held = false;
    const error = stolen();
    settle(request, request.reject, error, error);
    return;
  }

  const granted = (request.held = event === kGranted);
  const { signal } = request;
  if (signal) signal.removeEventListener("abort", request.onAbort!);
  if (request.settled) {
    // Aborted after the registry granted the lock and before this task ran. onAbort() has
    // rejected the promise; the callback is not called and the lock goes back.
    settle(request, request.reject, undefined);
    return;
  }

  publish(granted ? "grant" : "miss", request);

  try {
    const result = AsyncContextFrame.run(
      request.frame,
      request.callback,
      undefined,
      granted ? new Lock(kConstruct, request.name, request.mode) : null,
    );
    // The lock is held until what the callback returned settles. Resolving a new promise with
    // it, unlike Promise.resolve(), does not read its `constructor`, and a `then` that throws,
    // as a getter or when called, is a rejection.
    new Promise(resolve => resolve(result)).$then(
      value => settle(request, request.resolve, value),
      error => settle(request, request.reject, error, error),
    );
  } catch (error) {
    settle(request, request.reject, error, error);
  }
}

class LockManager {
  constructor(token: symbol | undefined = undefined) {
    if (token !== kConstruct) throw $ERR_ILLEGAL_CONSTRUCTOR();
  }

  // https://w3c.github.io/web-locks/#api-lock-manager-request
  async request(name: string, options: unknown, callback: unknown = undefined): Promise<unknown> {
    if (this !== locks) throw $ERR_INVALID_THIS("LockManager");
    if (arguments.length < 2) throw $ERR_MISSING_ARGS("name", "callback");

    if (callback === undefined) {
      callback = options;
      options = undefined;
    }

    name = `${name}`;
    if (!$isCallable(callback)) throw $ERR_INVALID_ARG_TYPE("callback", "function", callback);

    let mode: LockMode = "exclusive";
    let ifAvailable = false;
    let steal = false;
    let signal: AbortSignal | undefined;
    if (options != null) {
      if (!$isObject(options)) throw $ERR_INVALID_ARG_TYPE("options", "object", options);
      const o = options as { mode?: unknown; ifAvailable?: unknown; steal?: unknown; signal?: unknown };
      ifAvailable = !!o.ifAvailable;
      const requestedMode = o.mode;
      if (requestedMode !== undefined) {
        mode = `${requestedMode}` as LockMode;
        if (mode !== "exclusive" && mode !== "shared") {
          throw $ERR_INVALID_ARG_VALUE("options.mode", requestedMode, 'must be "exclusive" or "shared"');
        }
      }
      const requestedSignal = o.signal;
      if (requestedSignal !== undefined) {
        if (!$isAbortSignal(requestedSignal)) {
          throw $ERR_INVALID_ARG_TYPE("options.signal", "AbortSignal", requestedSignal);
        }
        signal = requestedSignal;
      }
      steal = !!o.steal;
    }

    if (name[0] === "-") {
      throw new DOMException("Lock names that start with '-' are reserved", "NotSupportedError");
    }
    if (steal && ifAvailable) {
      throw new DOMException("The 'steal' and 'ifAvailable' options cannot be used together", "NotSupportedError");
    }
    if (steal && mode !== "exclusive") {
      throw new DOMException("The 'steal' option may only be used with 'exclusive' locks", "NotSupportedError");
    }
    if (signal && (steal || ifAvailable)) {
      throw new DOMException(
        "The 'signal' option cannot be used with the 'steal' or 'ifAvailable' options",
        "NotSupportedError",
      );
    }
    if (signal && signal.aborted) throw signal.reason;

    if (!channels) {
      const { channel } = require("node:diagnostics_channel");
      channels = {
        start: channel("locks.request.start"),
        grant: channel("locks.request.grant"),
        miss: channel("locks.request.miss"),
        end: channel("locks.request.end"),
      };
    }

    return new Promise((resolve, reject) => {
      const request: LockRequest = {
        id: 0,
        name,
        mode,
        ifAvailable,
        steal,
        callback: callback as LockGrantedCallback,
        resolve,
        reject,
        frame: AsyncContextFrame.current(),
        signal,
        onAbort: undefined,
        settled: false,
        held: false,
      };

      const id = (request.id = nativeRequest(request, dispatch, name, mode === "shared", ifAvailable, steal));
      if (id <= 0) {
        if (id === 0) reject(new DOMException("The context of this LockManager was shut down", "InvalidStateError"));
        return;
      }
      publish("start", request);

      if (signal) {
        request.onAbort = () => {
          // Anyone can dispatch an "abort" event, and once dispatch() ran an abort has no say.
          if (!signal.aborted || request.settled || request.held) return;
          signal.removeEventListener("abort", request.onAbort!);
          // When the registry has granted the lock already, dispatch() is on its way and gives it back.
          nativeAbort(name, id);
          const reason = signal.reason;
          settle(request, reject, reason, reason);
        };
        // Not `once`, which an "abort" event that is not an abort would use up. The options
        // have no prototype, so that a polluted Object.prototype.capture cannot keep
        // removeEventListener() from finding the listener.
        signal.addEventListener("abort", request.onAbort, resistStopPropagation({ __proto__: null }));
      }
    });
  }

  // https://w3c.github.io/web-locks/#api-lock-manager-query
  async query(): Promise<{ held: object[]; pending: object[] }> {
    if (this !== locks) throw $ERR_INVALID_THIS("LockManager");
    return nativeQuery();
  }

  [kInspect]() {
    return this === locks ? "LockManager {}" : this;
  }
}

for (const [constructor, attributes] of [
  [Lock, ["name", "mode"]],
  [LockManager, ["request", "query"]],
] as const) {
  const { prototype } = constructor;
  for (const attribute of attributes) {
    Object.defineProperty(prototype, attribute, { enumerable: true });
  }
  Object.defineProperty(prototype, Symbol.toStringTag, {
    value: constructor.name,
    writable: false,
    enumerable: false,
    configurable: true,
  });
}

// The constructor is illegal: this is the only LockManager of the global, and the only valid receiver.
const locks = new LockManager(kConstruct);

export default {
  Lock,
  LockManager,
  locks,
};
