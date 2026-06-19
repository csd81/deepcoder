class TokenStore:
    """Holds the current access token."""

    def __init__(self, token):
        self._token = token

    def get(self):
        return self._token

    def set(self, token):
        self._token = token
