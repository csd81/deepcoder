import pytest

from safe_div import safe_div


def test_normal_division():
    assert safe_div(6, 2) == 3


def test_zero_raises_valueerror():
    with pytest.raises(ValueError):
        safe_div(1, 0)
