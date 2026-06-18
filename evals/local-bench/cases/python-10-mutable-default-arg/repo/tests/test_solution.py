from solution import append_item

def test_no_shared_state():
    assert append_item(1) == [1]
    assert append_item(2) == [2]
