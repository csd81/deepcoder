import pytest

from blueprints import Blueprint


def test_dotted_name_is_rejected():
    with pytest.raises(ValueError):
        Blueprint("admin.users")
