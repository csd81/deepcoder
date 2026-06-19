from cache import Cache


def test_update_is_visible_to_next_read():
    c = Cache()
    c.set("a", 1)
    assert c.get("a") == 1
    c.set("a", 2)
    assert c.get("a") == 2  # stale read on the buggy code returns 1
