from solution import apply_discount

def test_discount():
    assert apply_discount(100, 10) == 90
    assert apply_discount(50, 0) == 50
