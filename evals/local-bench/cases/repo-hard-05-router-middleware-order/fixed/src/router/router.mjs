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
    // Run this router's own middleware first (outermost), then descend into
    // children so nested middleware runs parent-before-child.
    for (const mw of this.middleware) mw(log);
    for (const child of this.children) child.dispatch(log);
  }
}
