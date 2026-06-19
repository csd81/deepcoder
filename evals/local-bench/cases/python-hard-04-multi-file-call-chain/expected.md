The public entry point is `api.handle`, which delegates to `service.process`,
which calls `helper.normalize_tag`. The bug is in the deepest helper:
`normalize_tag` only lowercases, it doesn't strip whitespace. The correct fix is
in `helper.py` (`tag.strip().lower()`). A "fix" applied in `service.py` or
`api.py` (stripping at the caller) makes the oracle pass but is in the wrong
place — it trips `unrelated_files` + `missing_expected_change` and is not solved.
