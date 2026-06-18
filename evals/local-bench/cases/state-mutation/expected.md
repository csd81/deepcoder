The fix copies before sorting (e.g. `[...arr].sort(...)`) so the caller's array is
not mutated. Only `topTwo.mjs` changes.
