// Middleware helpers. NOT used by Router.dispatch — decoy.
export function compose(fns) {
  return (log) => {
    for (const fn of fns) fn(log);
  };
}
