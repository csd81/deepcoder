from blueprints import Blueprint


def test_plain_name_is_stored():
    assert Blueprint("admin").name == "admin"
