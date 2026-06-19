def safe_join(base, name):
    """Join `name` onto `base`, refusing paths that escape `base`."""
    # BUG: a literal ".." blacklist only. Absolute paths and normalized
    # traversals are not caught.
    if ".." in name:
        raise ValueError("invalid path")
    return base + "/" + name
