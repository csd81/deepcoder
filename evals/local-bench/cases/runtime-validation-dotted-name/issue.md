Constructing a `Blueprint` with a name containing `"."` must be rejected, because
dotted names break nested-blueprint routing.

Requirements:
- Raise a `ValueError` when the name contains `"."`.
- Do NOT use `assert` for this runtime validation — assertions are stripped when
  Python runs with `-O`, so they are not a safe way to enforce invariants.
