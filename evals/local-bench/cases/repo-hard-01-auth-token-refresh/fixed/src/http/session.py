class Session:
    def __init__(self, store):
        self._store = store

    def auth_header(self):
        # Build the header from the store on each call so a refreshed token is
        # picked up immediately.
        return f"Bearer {self._store.get()}"
