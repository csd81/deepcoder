def split_document(text):
    """Return (frontmatter, body). Only a '---' header at the very top of the
    file counts; '---' lines elsewhere (e.g. inside fenced code) stay in body."""
    lines = text.split("\n")
    if not lines or lines[0].strip() != "---":
        return "", text
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            fm = "\n".join(lines[1:i])
            body = "\n".join(lines[i + 1:])
            return fm, body
    return "", text
