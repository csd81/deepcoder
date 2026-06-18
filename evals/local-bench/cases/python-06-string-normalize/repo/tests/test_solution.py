from solution import norm_user

def test_norm():
    assert norm_user("  Bob ") == "bob"
    assert norm_user("Al") == "al"
