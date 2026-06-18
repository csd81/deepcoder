import pytest
from solution import safe_div

def test_normal():
    assert safe_div(6, 2) == 3

def test_zero():
    with pytest.raises(ValueError):
        safe_div(1, 0)
