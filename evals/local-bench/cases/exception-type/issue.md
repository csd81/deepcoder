`get(mapping, key)` raises a bare `Exception` when the key is missing, which forces
callers to catch everything. A missing key should raise `KeyError`.

Fix it to raise `KeyError` (not a generic `Exception`).
