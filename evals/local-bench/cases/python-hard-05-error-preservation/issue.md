When a backend call fails, our error handler is making debugging impossible. All
we ever see is a generic "backend call failed" — the original error's status code
is gone and there's no chained cause, so we can't tell what actually went wrong or
where.

A failure should still surface the original error: keep its status code and chain
the underlying exception as the cause.
