# Feature — Adopt opencode tool description patterns as baseline

## Context

Opencode's tool descriptions follow a distinct style that deepcoder's don't: they're instructional bullet-lists with behavioral guardrails, cross-references to alternatives, and explicit failure-mode explanations. Deepcoder's descriptions are functional — they describe parameters and return values but don't shape model behavior.

Before adding DeepSeek-specific tuning, adopt opencode's proven patterns as the baseline. Then tune for DeepSeek on top.

## Pattern comparison

| Aspect | Opencode style | Deepcoder style | Impact |
|---|---|---|---|
| Format | Bullet-list HOWTO | Prose paragraph | Lists are scannable, models parse them better |
| Cross-references | "Use grep for content, glob for paths" | None | Model picks the right tool |
| Failure modes | "edit FAILS if oldString not found" | "Returns error" | Model adjusts before calling |
| Behavioral rules | "ALWAYS prefer editing, NEVER write new files" | None | Model follows conventions |
| When-NOT-to-use | Explicit in task.txt | None | Prevents misuse |
| Examples | Concrete file paths, line numbers | Abstract | Model understands faster |

## Description rewrites

### read_file (current)
```
Read a UTF-8 text file from the workspace and return its contents with 1-indexed line numbers.
```

### read_file (opencode style)
```
Read a file from the workspace. If the path does not exist, an error is returned.

Usage:
- The path parameter is relative to the workspace root.
- Returns up to 2000 lines by default. Use offset+limit to read specific ranges.
- Lines are prefixed with `<line>: <content>` (e.g., "1: import fs from 'fs'").
- Use grep to find specific content in large files.
- If unsure of the path, use glob to find files by pattern.
- Call this tool in parallel when you need multiple files.
- Avoid tiny 30-line slices — read a larger window in one call.
- This tool cannot read binary files or files over 1 MB.
```

### edit_file (current)
```
Replace an exact string in a file. The match must be unique unless replace_all is true. old_string must match the file byte-for-byte (including whitespace). The file must have been read first.
```

### edit_file (opencode style)
```
Replace an exact string in a file. For single-file changes. For multi-file atomic changes, use apply_patch.

Usage:
- The file must have been read first — edit will fail otherwise.
- old_string must match the file byte-for-byte, including whitespace. Use read_file first and copy the exact text.
- edit FAILS if old_string is not found. Copy the exact text from the read output.
- edit FAILS if old_string matches multiple times. Either provide more context to make it unique, or use replace_all: true.
- old_string must match the ACTUAL file content, not the read_file line-numbered output (strip line prefixes).
- Use replace_all for renaming a symbol across the file.
```

### grep (current)
```
Search file contents for a regex. Uses ripgrep (rg) when available, otherwise a built-in scan. Returns matching lines with file:line prefixes.
```

### grep (opencode style)
```
Search file contents for a regex pattern. For finding files by name, use glob instead.

Usage:
- Supports full regex syntax (e.g., "log.*Error", "function\s+\w+").
- Filter by file pattern using the include parameter (e.g., "*.ts", "*.{ts,js}").
- Returns matching lines with file:line prefixes.
- Use before reading to locate the right file.
- For open-ended searches, prefer this over reading every file.
```

### run_bash (current)
```
Run a bash command from the workspace root and return combined stdout/stderr. Subject to the permission policy.
```

### run_bash (opencode style)
```
Run a bash command from the workspace root. Do NOT use for file operations (read, write, edit) — use the dedicated tools instead.

Usage:
- Use the workdir parameter instead of `cd <dir> && <cmd>`.
- The command runs from the workspace root unless workdir is set.
- Dangerous commands (rm, sudo, chmod, redirects outside workspace) may be blocked by the permission policy.
- For git operations: stage explicit paths, never `git add -A`. Review changes before committing.
- Prefer read_file/grep over cat/grep in bash — the tool versions are more reliable.
```

## New description files

Extract all descriptions to `src/tools/descriptions/*.txt` (opencode pattern) so they can be iterated without touching code:

```
src/tools/descriptions/read_file.txt
src/tools/descriptions/edit_file.txt
src/tools/descriptions/write_file.txt
src/tools/descriptions/run_bash.txt
src/tools/descriptions/grep.txt
src/tools/descriptions/glob.txt
src/tools/descriptions/list_dir.txt
src/tools/descriptions/delete_file.txt
src/tools/descriptions/rename_file.txt
src/tools/descriptions/apply_patch.txt
src/tools/descriptions/todo_write.txt
```

Each `.txt` file is loaded at startup and assigned to the tool's `description` field. If the file is missing, fall back to the hardcoded default.

## DeepSeek-specific additions

After adopting the opencode baseline, add these lines to each description where relevant:

- "Call tools directly — do NOT describe what you will do" (run_bash, edit_file)
- "Be concise. No preamble about what you changed." (all tools)
- "If a tool errors, change your approach — do NOT retry the same call." (all tools)

These become part of the description text, not separate system prompt sections. The model sees them at the point of use, not at the start of the session.

## Files

- **Edit:** All `src/tools/*.ts` files — rewrite descriptions in opencode style.
- **New (SHOULD):** `src/tools/descriptions/*.txt` — extracted description files.
- **Follow-up:** Add DeepSeek-specific lines to each description.

## Verification

1. `npm run typecheck` clean; `npm run test:phase` green.
2. Manual: inspect any tool's description in the API call log — reads as a bullet-list HOWTO with behavioral guardrails.
3. Model behavior: after the change, the model should:
   - Read larger chunks (not 30-line slices)
   - Use grep before reading large files
   - Prefer apply_patch for multi-file changes
   - Not retry identical failing calls
