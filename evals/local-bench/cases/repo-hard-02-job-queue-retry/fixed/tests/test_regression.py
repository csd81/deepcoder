import pytest

from src.worker import process
from src.jobs.errors import TransientError, ValidationError


def test_transient_is_retried_then_succeeds():
    def fn(attempt):
        if attempt < 2:
            raise TransientError("connection reset")
        return "done"

    res = process(fn, max_attempts=3)
    assert res["value"] == "done"
    assert res["attempts"] == 2


def test_validation_is_not_retried():
    calls = {"n": 0}

    def fn(attempt):
        calls["n"] += 1
        raise ValidationError("bad input")

    with pytest.raises(ValidationError):
        process(fn, max_attempts=3)
    assert calls["n"] == 1
