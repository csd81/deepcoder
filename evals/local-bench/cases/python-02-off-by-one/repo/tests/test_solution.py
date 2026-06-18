from solution import inclusive_range

def test_range():
    assert inclusive_range(1, 3) == [1, 2, 3]
    assert inclusive_range(5, 5) == [5]
