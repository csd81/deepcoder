`Session` (in `src/http/session.py`) builds the Authorization header once in
`__init__` and caches it, so after `refresh` rotates the token in the store the
session keeps sending the old header. The fix builds the header from the store on
each call (`auth_header` reads `self._store.get()`). `legacy_store.py` and
`transport.py` are decoys — not on the runtime path (`Api → Session → Client`).
The agent must also add a regression test under `tests/` that refreshes then
requests; it must go red on the buggy code. Hardcoding the refreshed token in the
session breaks the public initial-request test, so the oracle + public test
together pin the real fix.
