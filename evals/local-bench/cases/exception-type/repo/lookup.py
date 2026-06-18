def get(mapping, key):
    if key not in mapping:
        # BUG: a generic Exception forces callers to catch everything; a missing
        # key should raise KeyError.
        raise Exception("missing key")
    return mapping[key]
