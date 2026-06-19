def normalize_tag(tag):
    # BUG: lowercases but does not strip surrounding whitespace, so "  Foo  "
    # and "foo" normalize to different values.
    return tag.lower()
