def get(mapping, key):
    if key not in mapping:
        raise KeyError(key)
    return mapping[key]
