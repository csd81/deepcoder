from api import handle


def test_strips_and_lowercases():
    assert handle({"tag": "  Urgent  "})["tag"] == "urgent"


def test_spaced_and_plain_collapse_to_same_tag():
    assert handle({"tag": "  Foo  "})["tag"] == handle({"tag": "foo"})["tag"]
