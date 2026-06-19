# Legacy token store from before the refresh flow existed. Kept for reference;
# NOT used by the runtime path (api.py wires TokenStore from store.py).
class LegacyTokenStore:
    def __init__(self, token):
        self.token = token

    def header(self):
        return f"Bearer {self.token}"
