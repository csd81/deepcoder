class Client:
    def __init__(self, session):
        self._session = session

    def request(self):
        # Returns the headers that would be sent with the request.
        return {"Authorization": self._session.auth_header()}
