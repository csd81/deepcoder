import { Router } from "./router/router.mjs";

// Build app → parent → child, each contributing one middleware, plus a handler
// on the child. Returns the execution log.
export function run() {
  const log = [];
  const app = new Router("app");
  const parent = new Router("parent");
  const child = new Router("child");

  app.use(() => log.push("app"));
  parent.use(() => log.push("parent"));
  child.use(() => log.push("child"));
  child.use(() => log.push("handler"));

  parent.mount(child);
  app.mount(parent);

  app.dispatch(log);
  return log;
}
