`safe_div(a, b)` should raise `ValueError("cannot divide by zero")` when `b == 0`,
instead of leaking a `ZeroDivisionError`.

Guard the zero case explicitly. Do NOT wrap the body in a broad `except Exception:`
or bare `except:` to convert the error — that would also swallow unrelated bugs.
