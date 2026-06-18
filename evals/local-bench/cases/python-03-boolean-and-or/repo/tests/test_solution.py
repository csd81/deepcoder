from solution import can_access

def test_access():
    assert can_access({"admin": True, "active": False}) is False
    assert can_access({"admin": True, "active": True}) is True
