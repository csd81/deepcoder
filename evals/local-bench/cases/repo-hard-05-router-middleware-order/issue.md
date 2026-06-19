Middleware on nested routers runs in the wrong order. With an app that mounts a
parent router which mounts a child router, the child's middleware is running
before the parent's (and before the app's), so things like auth/logging that are
meant to wrap inner routes don't take effect in time.

Middleware should run outermost-first: app, then parent router, then child
router, then the handler.
