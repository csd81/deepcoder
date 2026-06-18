import pytest

from mini_flask.blueprints import Blueprint


def test_rejects_dotted_name():
    # A dotted name must be rejected at construction time.
    with pytest.raises(Exception):
        Blueprint("admin.users")


def test_allows_plain_name():
    assert Blueprint("admin").name == "admin"
