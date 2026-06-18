`inclusiveRange(a, b)` should return every integer from `a` to `b` **inclusive**,
but it currently omits the upper bound: `inclusiveRange(1, 3)` returns `[1, 2]`
instead of `[1, 2, 3]`. Fix the boundary so the range includes `b`.
