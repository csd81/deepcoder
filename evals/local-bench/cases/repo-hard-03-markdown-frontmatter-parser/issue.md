Some of our Markdown documents render with garbled content: text that lives
inside a fenced code block is being pulled out and treated as document metadata.
It happens with notes that have no metadata header at all but contain a code
block with `---` lines in it.

Only a real metadata header at the very top of the file should be treated as
frontmatter; `---` lines inside fenced code blocks must be left in the body.
Please add a regression test.
