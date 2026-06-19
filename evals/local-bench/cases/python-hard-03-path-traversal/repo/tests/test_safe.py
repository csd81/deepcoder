import pytest

from safe import safe_join


def test_literal_dotdot_is_rejected():
    with pytest.raises(ValueError):
        safe_join("/srv/data", "../etc/passwd")


def test_simple_join_stays_inside():
    assert safe_join("/srv/data", "file.txt").startswith("/srv/data/")
