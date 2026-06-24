<!-- adapted-from: tool-description-edit-single-replacement.md -->
Performs exact string replacement in a file.
- You must Read the file in this conversation before editing, or the call will fail
- `old_string` must match the file exactly (including indentation) and be unique
- Strip the Read line prefix (line number + colon + space) before matching
- `replace_all: true` replaces every occurrence instead
