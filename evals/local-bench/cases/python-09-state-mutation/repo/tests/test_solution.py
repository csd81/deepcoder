from solution import top_two

def test_no_mutate():
    inp = [3, 1, 2]
    assert top_two(inp) == [3, 2]
    assert inp == [3, 1, 2]
