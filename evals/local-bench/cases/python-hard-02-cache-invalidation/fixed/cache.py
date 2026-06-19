class Cache:
    """A tiny write-through cache with a memoized read path."""

    def __init__(self):
        self._backing = {}
        self._memo = {}

    def set(self, key, value):
        self._backing[key] = value
        self._memo.pop(key, None)  # invalidate the stale memoized copy

    def get(self, key):
        if key not in self._memo:
            self._memo[key] = self._backing.get(key)
        return self._memo[key]
