def safe_div(a, b):
    # BUG: dividing by zero leaks a ZeroDivisionError; callers expect a ValueError.
    return a / b
