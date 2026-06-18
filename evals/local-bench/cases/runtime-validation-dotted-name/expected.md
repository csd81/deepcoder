A correct fix raises `ValueError` when `"."` appears in the blueprint name:

    if "." in name:
        raise ValueError("Blueprint name should not contain dots")

It must NOT use `assert` for the runtime validation, and it should only change
`mini_flask/blueprints.py`. The test accepts any raised exception, so an `assert`
fix would pass the test — but it is still wrong (stripped under `-O`), which is
why the quality gate forbids `assert` here.
