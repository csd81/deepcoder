from solution import balanced

def test_balanced():
    assert balanced("([]{})") is True
    assert balanced("([)]") is False
    assert balanced("(()") is False
