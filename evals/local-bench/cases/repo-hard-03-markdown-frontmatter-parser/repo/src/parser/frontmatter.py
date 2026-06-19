def split_document(text):
    """Return (frontmatter, body). Frontmatter is the block between a pair of
    '---' delimiter lines."""
    lines = text.split("\n")
    delims = [i for i, ln in enumerate(lines) if ln.strip() == "---"]
    # BUG: treats ANY two '---' lines as the frontmatter fences — even when they
    # sit inside a fenced code block and the document has no real top-of-file
    # frontmatter header.
    if len(delims) >= 2:
        start, end = delims[0], delims[1]
        fm = "\n".join(lines[start + 1:end])
        body = "\n".join(lines[:start] + lines[end + 1:])
        return fm, body
    return "", text
