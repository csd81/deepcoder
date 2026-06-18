import pytest
from solution import make_user

def test_empty_rejected():
    with pytest.raises(ValueError):
        make_user("")

def test_ok():
    assert make_user("a")["name"] == "a"
