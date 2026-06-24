<!-- adapted-from: tool-description-edit.md -->
Performs exact string replacements in files. Must read the file first before editing.
- Preserve the exact indentation from Read output (after the line number prefix)
- Prefer editing existing files — only write new files when explicitly required
- Use replaceAll to rename/replace the same string across the whole file
- Edit fails if oldString is not found or matches multiple times (add more context in that case)
