from solution import is_adult

def test_adult():
    assert is_adult(18) is True
    assert is_adult(17) is False
