The fix raises `KeyError(key)` (a specific, expected exception type) instead of a
generic `Exception`, and only changes `lookup.py`.
