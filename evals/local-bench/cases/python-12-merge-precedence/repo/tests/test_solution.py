from solution import with_defaults

def test_precedence():
    assert with_defaults({"timeout": 5})["timeout"] == 5
    assert with_defaults({})["timeout"] == 30
