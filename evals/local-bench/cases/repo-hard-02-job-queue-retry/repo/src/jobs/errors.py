class TransientError(Exception):
    """A transient failure that SHOULD be retried (e.g. a network blip)."""


class ValidationError(Exception):
    """A permanent failure that should NOT be retried."""
