import pytest

from client import call, ApiError


def _failing():
    raise ApiError("boom", code=503)


def test_failure_raises_some_error():
    with pytest.raises(Exception):
        call(_failing)
