from api import handle


def test_lowercases_tag():
    assert handle({"tag": "FOO"})["tag"] == "foo"
