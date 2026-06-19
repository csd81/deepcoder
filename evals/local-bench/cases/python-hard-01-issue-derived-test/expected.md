The `Blueprint` constructor (in `blueprints.py`) should reject names containing a
`.` by raising `ValueError`. A bare `assert` is not acceptable (it is stripped
under `python -O`). The agent must also add a regression test under
`tests/test_regression.py` that asserts a dotted name raises `ValueError` — and
that test must genuinely fail against the buggy code (red→green).
