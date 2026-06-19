export class Router {
  constructor(name) {
    this.name = name;
    this.middleware = [];
    this.children = [];
  }

  use(fn) {
    this.middleware.push(fn);
    return this;
  }

  mount(child) {
    this.children.push(child);
    return this;
  }

  dispatch(log) {
    // BUG: children are dispatched before this router's own middleware, so child
    // middleware runs before parent middleware (inner-first instead of outer-first).
    for (const child of this.children) child.dispatch(log);
    for (const mw of this.middleware) mw(log);
  }
}
