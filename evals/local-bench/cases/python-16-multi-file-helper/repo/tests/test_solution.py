from solution import total_cents

def test_total_cents():
    assert total_cents([19.99]) == 1999
    assert total_cents([0.1, 0.2]) == 30
