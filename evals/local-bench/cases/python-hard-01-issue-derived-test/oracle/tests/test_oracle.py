import pytest

from blueprints import Blueprint


def test_oracle_dotted_name_raises_value_error():
    with pytest.raises(ValueError):
        Blueprint("oracle.dotted")


def test_oracle_plain_name_still_works():
    assert Blueprint("plain").name == "plain"
