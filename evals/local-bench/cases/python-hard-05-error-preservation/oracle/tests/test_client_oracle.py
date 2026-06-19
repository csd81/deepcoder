import pytest

from client import call, ApiError


def _failing():
    raise ApiError("boom", code=503)


def test_preserves_cause_and_code():
    with pytest.raises(Exception) as ei:
        call(_failing)
    err = ei.value
    assert err.__cause__ is not None, "the original exception must be chained as the cause"
    assert isinstance(err.__cause__, ApiError)
    assert getattr(err, "code", None) == 503, "the original status code must be preserved"
