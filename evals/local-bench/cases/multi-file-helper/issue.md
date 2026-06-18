`totalCents([0.1, 0.2])` returns `30.000000000000004` instead of `30`, and other
prices are off by a cent. The symptom shows up in `api.mjs`, but the root cause is
the `cents()` helper in `helpers.mjs`, which multiplies by 100 without rounding.

Fix the helper so cents are correctly rounded. Do not duplicate the conversion
logic into `api.mjs`.
