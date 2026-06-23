<!-- adapted-from: tool-description-artifact.md -->
Renders HTML/Markdown to a private web page (Artifact). Content is file-first: write via Write/Edit, then call Artifact with the file path.
- No DOCTYPE/html/head/body tags — the skeleton is added at publish time
- Edit the file and call Artifact again with the same path to redeploy to the same URL
- Self-contained only: strict CSP blocks external requests. Inline all CSS/JS, embed assets as data: URIs
- Responsive: relative units, flexbox/grid, overflow-x: auto for wide content
- Favicon (required): pass 1-2 emoji, keep stable across redeploys
- Load design skill before writing for guidance
