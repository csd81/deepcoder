from src.render import render


def test_no_header_with_fenced_dashes_keeps_body_intact():
    doc = "# Notes\n\n```\nconfig:\n---\nvalue: 1\n---\n```\ndone\n"
    result = render(doc)
    assert result["frontmatter"] == ""
    assert result["body"] == doc


def test_real_frontmatter_still_extracted():
    doc = "---\ntitle: T\n---\nbody\n```\n---\n```\n"
    result = render(doc)
    assert result["frontmatter"] == "title: T"
    assert result["body"] == "body\n```\n---\n```\n"
