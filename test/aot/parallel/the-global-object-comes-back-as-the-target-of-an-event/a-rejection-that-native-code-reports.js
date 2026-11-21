// Native code dispatches both events on the global object. Nothing here calls dispatchEvent().
addEventListener("unhandledrejection", event => {
  event.preventDefault();
  console.log(typeof event.target.process.finalization, event.type, event.reason);
});
onrejectionhandled = event => {
  console.log(typeof event.target.process.finalization, event.type, event.reason);
};
const promise = Promise.reject("no");
setTimeout(() => promise.catch(() => {}), 0);
