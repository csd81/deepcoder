def safe_div(a, b):
    if b == 0:
        raise ValueError("cannot divide by zero")
    return a / b
