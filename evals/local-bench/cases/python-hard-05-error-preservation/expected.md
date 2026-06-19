`call` (in `client.py`) catches `ApiError` and raises a bare `RuntimeError`,
which drops the original `.code` and sets no `__cause__` (no `from`). The fix
re-raises an error that preserves the code and chains the cause, e.g.
`raise ApiError(f"backend call failed: {e}", code=e.code) from e`. The shipped
public test only checks that *some* exception is raised, so it passes on the bug;
the hidden oracle asserts `__cause__` is the original `ApiError` and `code` is
preserved.
