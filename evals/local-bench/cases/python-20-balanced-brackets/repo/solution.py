def balanced(s):
    n = 0
    for c in s:
        if c == "(":
            n += 1
        elif c == ")":
            n -= 1
    return n == 0
