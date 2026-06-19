from src.auth.store import TokenStore
from src.auth.refresh import refresh
from src.http.session import Session
from src.http.client import Client


class Api:
    def __init__(self, token):
        self.store = TokenStore(token)
        self.session = Session(self.store)
        self.client = Client(self.session)

    def refresh_token(self):
        return refresh(self.store)

    def request(self):
        return self.client.request()
