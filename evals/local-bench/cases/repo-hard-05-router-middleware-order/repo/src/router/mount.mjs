// Alternate mount helper. NOT used by app.mjs (which calls Router.mount) — decoy.
export function mountAt(parent, path, child) {
  parent.routes = parent.routes || {};
  parent.routes[path] = child;
  return parent;
}
