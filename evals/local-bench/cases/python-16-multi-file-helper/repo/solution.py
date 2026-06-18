from helpers import cents

def total_cents(prices):
    return sum(cents(p) for p in prices)
