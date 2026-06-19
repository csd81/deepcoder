from src.render import render


def test_fenced_dashes_are_not_frontmatter():
    doc = "# Notes\n\n```\nconfig:\n---\nvalue: 1\n---\n```\ndone\n"
    result = render(doc)
    assert result["frontmatter"] == ""
    assert result["body"] == doc
