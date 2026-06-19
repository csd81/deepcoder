from src.jobs.errors import TransientError


def is_retryable(err):
    # Classify by type: only transient failures are worth retrying.
    return isinstance(err, TransientError)
