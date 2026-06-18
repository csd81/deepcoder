total_cents is off by a cent. The bug is in the cents() helper in helpers.py (it truncates with int) — fix the helper, do not duplicate logic in solution.py.
