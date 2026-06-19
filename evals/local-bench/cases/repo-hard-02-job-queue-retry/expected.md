`is_retryable` (in `src/jobs/retry.py`) classifies errors by grepping the message
text instead of using the exception type, so it misjudges both transient and
validation failures. A proper exception hierarchy already exists in
`src/jobs/errors.py` (`TransientError`, `ValidationError`). The fix classifies by
type: retry `TransientError`, never retry `ValidationError`. `job.py` and
`scheduler.py` are decoys. The agent must add a regression test under `tests/`
exercising both paths, and must not paper over it with a broad `except Exception`.
