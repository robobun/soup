# Vendored WPT Web Storage suite

Vendored byte-for-byte from `web-platform-tests/wpt`:

- **Commit:** `1d2c5fb36a6e477c8f915bde7eca027be6abe792` (the revision Node.js vendors in
  `test/fixtures/wpt/webstorage`)
- **Fetched:** 2026-10-01
- **Source directory:** `webstorage/`

To re-vendor, pin the same (or a newer, reviewed) commit before copying any files:

```sh
git -c advice.detachedHead=false clone --depth=1 --filter=blob:none --sparse \
    https://github.com/web-platform-tests/wpt /tmp/wpt
git -C /tmp/wpt sparse-checkout set webstorage
git -C /tmp/wpt checkout 1d2c5fb36a6e477c8f915bde7eca027be6abe792
```

## What is vendored

`webstorage/*.window.js` (21 files): every test of the `Storage` interface that needs no
document, no second window and no `StorageEvent`.

Vendored file contents must never be modified. All adaptation lives in
`wpt-webstorage-fixture.ts`, which has the `test()` of testharness.js, in
`../wpt-testharness-shim.ts`, which has the assertions, and in `wpt-webstorage.test.ts`.

## What is excluded (and why)

| Path                                                                                                                   | Reason                                                                    |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `event_constructor.window.js`, `event_initstorageevent.window.js`, `event_*.html`, `event_*.js`, `eventTestHarness.js` | `StorageEvent` is for other documents of the same origin; Bun has neither |
| `storage_local_window_open.window.js`, `storage_session_window_*.window.js`                                            | Require `window.open()`                                                   |
| `localstorage-cross-origin-iframe.https.window.js`, `*partitioned*.html`                                               | Require iframes                                                           |
| `document-domain.html`, `storage_local-manual.html`, `storage_session-manual.html`                                     | Require a document, or a person                                           |
| `META.yml`, `README.md`, `resources/`                                                                                  | WPT metadata and the pages the HTML tests load                            |
