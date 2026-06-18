def get(mapping, key):
    if key not in mapping:
        raise Exception("missing key")
    return mapping[key]
