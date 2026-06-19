from src.render import render


def test_real_frontmatter_is_extracted():
    doc = "---\ntitle: Hi\n---\n# Body\n"
    result = render(doc)
    assert result["frontmatter"] == "title: Hi"
    assert result["body"] == "# Body\n"
