`Cache.set` (in `cache.py`) writes to the backing store but never invalidates the
memoized copy in `_memo`, so `get` keeps serving the stale value. The fix is to
invalidate (or refresh) the memoized entry on `set` — e.g. `self._memo.pop(key,
None)`. The shipped public test only does a single `get`, so it passes on the
buggy code; the hidden oracle does update→read and is what actually grades this.
