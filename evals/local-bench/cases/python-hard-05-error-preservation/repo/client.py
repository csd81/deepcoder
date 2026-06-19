class ApiError(Exception):
    def __init__(self, message, code=None):
        super().__init__(message)
        self.code = code


def call(backend):
    try:
        return backend()
    except ApiError as e:
        # BUG: drops the original code and cause — debugging is impossible.
        raise RuntimeError("backend call failed")
