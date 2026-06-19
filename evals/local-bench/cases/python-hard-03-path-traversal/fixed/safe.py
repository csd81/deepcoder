import os


def safe_join(base, name):
    """Join `name` onto `base`, refusing paths that escape `base`."""
    base_abs = os.path.realpath(base)
    target = os.path.realpath(os.path.join(base_abs, name))
    if target != base_abs and not target.startswith(base_abs + os.sep):
        raise ValueError("invalid path")
    return target
