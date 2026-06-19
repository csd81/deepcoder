`Router.dispatch` (in `src/router/router.mjs`) dispatches child routers *before*
running its own middleware, so nested middleware executes inner-first (child,
parent, app) — the reverse of what's wanted. The fix runs this router's own
middleware first, then dispatches children, giving app → parent → child →
handler. `layer.mjs`, `middleware.mjs`, and `mount.mjs` are decoys (route
matching / helpers not on the dispatch path). The public test only checks that
each step ran (set membership), so it passes on the bug; the hidden oracle
asserts the exact order.
