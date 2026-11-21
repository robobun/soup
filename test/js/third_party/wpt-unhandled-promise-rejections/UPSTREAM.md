# Vendored WPT unhandled-promise-rejections suite

Vendored byte-for-byte from `web-platform-tests/wpt`:

- **Commit:** `9986bb32c9e97707eff870ab284ebc5cc7ae8d21`
- **Fetched:** 2026-11-21
- **Source directory:** `html/webappapis/scripting/processing-model-2/unhandled-promise-rejections/`

To re-vendor, pin the same (or a newer, reviewed) commit before copying any files:

```sh
git -c advice.detachedHead=false clone --depth=1 --filter=blob:none --sparse \
    https://github.com/web-platform-tests/wpt /tmp/wpt
git -C /tmp/wpt sparse-checkout set html/webappapis/scripting/processing-model-2/unhandled-promise-rejections
git -C /tmp/wpt checkout 9986bb32c9e97707eff870ab284ebc5cc7ae8d21
```

## What is vendored

Every file of the directory that needs no document:

- `support/promise-rejection-events.js`: what upstream runs in a window, a dedicated worker, a
  shared worker and a service worker. Here it runs on the main thread and in a `Worker`.
- `support/promise-rejection-events-many-promises.js`: the same two places.
- `promise-rejection-event-constructor.html` and `promise-rejection-events-attached-in-event.html`:
  the one inline script of each.

Vendored file contents must never be modified. All adaptation lives in
`wpt-unhandled-promise-rejections-fixture.ts`, which evaluates the files in a process that is
not `bun test`, in `../wpt-testharness-shim.ts`, which has `async_test()`, `promise_test()` and
the assertions, and in `wpt-unhandled-promise-rejections.test.ts`.

The subtests of `support/promise-rejection-events.js` that are inside `if ('document' in self)`
are about the order of tasks in a window. The file does not define them anywhere else, so they
do not run here. Bun reports a rejection at the end of the turn of the event loop in which the
promise was rejected, and not from a task that it queues.

## What is excluded (and why)

| Path                                                                                          | Reason                                                                                                         |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `promise-rejection-events-onerror.html`                                                       | Queues its tasks with a `<details>` element, and expects `window.onerror` to be told of what a listener throws |
| `promise-resolution-order.html`                                                               | Needs `requestAnimationFrame` and `<script>` elements                                                          |
| `promise-rejection-event-during-parse.html`, `promise-rejection-during-parsing-crash.html`    | Need an HTML parser                                                                                            |
| `promise-rejection-events-iframe.html`, `allow-crossorigin.html`, `disallow-crossorigin.html` | Need iframes and origins                                                                                       |
| `promise-rejection-events*.html` (the pages that load the two `support/` files)               | Only load the files above, which are run directly                                                              |
| `support/promise-access-control.py`                                                           | The server side of the cross-origin pages                                                                      |
