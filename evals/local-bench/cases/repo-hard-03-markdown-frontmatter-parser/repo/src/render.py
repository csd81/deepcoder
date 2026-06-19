from src.parser.frontmatter import split_document


def render(text):
    frontmatter, body = split_document(text)
    return {"frontmatter": frontmatter, "body": body}
