from src.jobs.retry import is_retryable


def run_job(fn, max_attempts=3):
    """Call fn(attempt) until it succeeds or a non-retryable error is raised."""
    attempts = 0
    last = None
    while attempts < max_attempts:
        attempts += 1
        try:
            return {"ok": True, "value": fn(attempts), "attempts": attempts}
        except Exception as e:
            last = e
            if not is_retryable(e):
                break
    raise last
