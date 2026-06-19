from cache import Cache


def test_get_returns_stored_value():
    c = Cache()
    c.set("a", 1)
    assert c.get("a") == 1
