import pytest
from solution import get

def test_missing():
    with pytest.raises(KeyError):
        get({}, "x")

def test_present():
    assert get({"a": 1}, "a") == 1
