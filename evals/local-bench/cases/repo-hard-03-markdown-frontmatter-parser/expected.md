`split_document` (in `src/parser/frontmatter.py`) treats *any* two `---` lines as
frontmatter fences, so a document with no real header but a fenced code block
containing `---` gets its code mistaken for metadata. The fix only treats `---`
as a frontmatter delimiter when the file *starts* with one (top-of-file), leaving
fenced content in the body. `tokenize.py` and `fences.py` are decoys — plausible
fix sites, but `split_document` is what `render.py` actually calls. A naive
`split("---")` is forbidden. The agent must add a regression test under `tests/`.
