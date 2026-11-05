// `import.meta.hot` for the modules that `bun --hot` reloads.
//
// A reload evaluates every file again in the same global. So a module has no update to accept or
// to decline: it needs a moment to let go of what its copy holds before the next copy runs
// (`dispose()`), and a place for what the next copy takes over (`data`).
//
// ImportMetaObject.cpp answers `import.meta.hot` with `contextFor()`, and VirtualMachine::reload()
// calls `runDispose()` before it lets go of the modules.

type DisposeCallback = (data: any) => unknown;

const PromiseWithResolvers = Promise.withResolvers.bind(Promise);

/** One context per module, by `import.meta.url`, for the life of the process: `data` outlives every reload. */
const contexts = new Map<string, ImportMetaHot>();
/** The `dispose()` calls since the last reload, in the order they were made. */
let disposers: [context: ImportMetaHot, callback: DisposeCallback][] = [];
/** `data` of a context as it is at the time of the call: a module can assign to it. */
let dataOf: (context: ImportMetaHot) => any;

class ImportMetaHot {
  #data: any = {};

  static {
    dataOf = context => context.#data;
  }

  get [Symbol.toStringTag]() {
    return "ImportMetaHot";
  }

  get data() {
    if (!(#data in this)) throw $ERR_INVALID_THIS("ImportMetaHot");
    return this.#data;
  }

  set data(value: any) {
    if (!(#data in this)) throw $ERR_INVALID_THIS("ImportMetaHot");
    this.#data = value;
  }

  dispose(callback: DisposeCallback) {
    if (!(#data in this)) throw $ERR_INVALID_THIS("ImportMetaHot");
    if (!$isCallable(callback)) throw $ERR_INVALID_ARG_TYPE("callback", "function", callback);
    $arrayPush(disposers, [this, callback]);
  }

  // The other members decide which modules an update replaces, tell of one, or talk to a dev
  // server. A reload replaces every module and there is no server, so code that was written for
  // one of those loads, and these do nothing.

  accept() {
    if (!(#data in this)) throw $ERR_INVALID_THIS("ImportMetaHot");
  }

  decline() {
    if (!(#data in this)) throw $ERR_INVALID_THIS("ImportMetaHot");
  }

  on() {
    if (!(#data in this)) throw $ERR_INVALID_THIS("ImportMetaHot");
  }

  off() {
    if (!(#data in this)) throw $ERR_INVALID_THIS("ImportMetaHot");
  }

  prune() {
    if (!(#data in this)) throw $ERR_INVALID_THIS("ImportMetaHot");
  }

  invalidate() {
    if (!(#data in this)) throw $ERR_INVALID_THIS("ImportMetaHot");
  }

  send() {
    if (!(#data in this)) throw $ERR_INVALID_THIS("ImportMetaHot");
  }
}

// The object has what the type of `import.meta.hot` has, and no way to make another one.
delete (ImportMetaHot.prototype as { constructor?: unknown }).constructor;

function contextFor(url: string): ImportMetaHot {
  let context = contexts.$get(url);
  if (context === undefined) contexts.$set(url, (context = new ImportMetaHot()));
  return context;
}

/**
 * Calls every `dispose()` callback. One that throws does not stop the ones after it: `report` prints
 * the error, the way an error in a module is printed, and does nothing else with it. Returns a
 * promise when a callback returned one: it is fulfilled once each of them has settled.
 */
function runDispose(report: (error: unknown) => void): Promise<void> | undefined {
  // What a callback registers is for the reload after this one.
  const calls = disposers;
  disposers = [];

  let pending = 0;
  let all: PromiseWithResolvers<void> | undefined;
  const settled = () => {
    // A callback can drain the microtasks, so a promise of an earlier one can settle before `all` exists.
    if (--pending === 0) all?.resolve();
  };
  const rejected = (error: unknown) => {
    report(error);
    settled();
  };
  for (let i = 0; i < calls.length; i++) {
    const callback = calls[i][1];
    try {
      const result = callback(dataOf(calls[i][0]));
      // As in the dev server, a promise delays the reload and another thenable does not.
      if ($isPromise(result)) {
        (result as Promise<unknown>).$then(settled, rejected);
        pending++;
      }
    } catch (error) {
      report(error);
    }
  }
  if (pending !== 0) all = PromiseWithResolvers<void>();
  return all?.promise;
}

export default { contextFor, runDispose };
