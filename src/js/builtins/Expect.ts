// `this` is the `expect` function that `poll` was read from.
export function poll(this: unknown, fn: unknown, options: unknown) {
  return require("internal/test/poll").poll(this, fn, options);
}
