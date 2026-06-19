class ApiError(Exception):
    def __init__(self, message, code=None):
        super().__init__(message)
        self.code = code


def call(backend):
    try:
        return backend()
    except ApiError as e:
        raise ApiError(f"backend call failed: {e}", code=e.code) from e
