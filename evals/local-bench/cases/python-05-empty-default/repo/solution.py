from functools import reduce

def total(xs):
    return reduce(lambda a, b: a + b, xs)
