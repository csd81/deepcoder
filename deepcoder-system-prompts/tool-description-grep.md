<!-- adapted-from: tool-description-grep.md -->
Content search built on ripgrep.
- ALWAYS use this tool for searching — never use `grep` or `rg` via Bash
- Supports full regex syntax, glob filtering, and type filtering
- Output modes: "content" (matching lines), "files_with_matches" (default), "count" (match counts)
- Use Task tool for open-ended searches needing multiple rounds
- Multiline matching: enable with `multiline: true` for cross-line patterns
- Go: escape braces — use `interface\{\}` to find `interface{}`
