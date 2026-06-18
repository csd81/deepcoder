import pytest

from lookup import get


def test_missing_raises_keyerror():
    with pytest.raises(KeyError):
        get({}, "x")


def test_present_value():
    assert get({"a": 1}, "a") == 1
