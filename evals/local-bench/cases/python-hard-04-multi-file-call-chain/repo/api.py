from service import process


def handle(record):
    """Public entry point: normalize an incoming record."""
    return process(record)
