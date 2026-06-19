def is_retryable(err):
    # BUG: classifies by message text instead of the exception type. Transient
    # errors whose message doesn't contain "retry" are wrongly treated as
    # permanent, and anything whose message mentions "retry" would be retried.
    return "retry" in str(err).lower()
