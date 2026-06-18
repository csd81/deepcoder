totalCents is off by rounding. The bug is in the cents() helper in helpers.mjs — fix the helper, do not duplicate logic in solution.mjs.
