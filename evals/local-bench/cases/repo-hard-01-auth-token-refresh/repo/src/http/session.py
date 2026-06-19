class Session:
    def __init__(self, store):
        self._store = store
        # BUG: the Authorization header is computed once and cached here. After a
        # token refresh the store holds a new token, but this cached header is
        # never rebuilt, so requests keep using the stale token.
        self._auth_header = f"Bearer {store.get()}"

    def auth_header(self):
        return self._auth_header
