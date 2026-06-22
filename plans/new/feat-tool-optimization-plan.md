# Feature — Tool API optimization

## Context

Deepcoder has 20 always-registered tools with decent descriptions, but they lack the polish found in opencode, codex, and gemini-cli. After a comprehensive comparison of tool APIs across all major coding agent CLIs, several gaps and improvement patterns emerge:

| Area | Deepcoder weakness | Leader | Their approach |
|---|---|---|---|
| Descriptions | Tell what, not when | Opencode | Bullet-list HOWTOs, behavioral guardrails, when-to-use-vs-alternatives |
| File reading | No `read_many` | Gemini CLI | `read_many_files` with glob patterns, batch reads |
| Planning tools | No `update_plan` | Codex | Built-in plan tracking tool, `request_permissions` |
| File editing | No `instruction` field | Gemini CLI | Semantic change description alongside old/new strings |
| Completion signal | No `complete_task` | Gemini CLI | Explicit task-termination tool |
| Deferred tools | No `tool_search` | Codex | Model can discover tools not in the primary set |
| Descriptions storage | Hardcoded in code | Opencode | Separate `.txt` files loaded at runtime, easier to iterate |

## Design

### 1. Rewrite all tool descriptions

Goal: every description answers "when to use this vs the alternatives". Follow opencode's style — bullet list, behavioral guardrails, specific examples of what to avoid.

Current style:
```
edit_file: "Replace an exact string in a file. The match must be unique unless replace_all is true."
```

Improved style:
```
edit_file: Replace an exact string in a file.
- Use for SINGLE-FILE, SINGLE-REPLACE edits.
- For atomic multi-file changes, use apply_patch instead.
- old_string must match byte-for-byte (including whitespace). Use grep to find exact text first.
- The file must have been read first (or the edit will fail).
- If old_string appears more than once, set replace_all: true.
```

### 2. Add missing tools

**`read_many_files(paths: string[])`** — read multiple files in one call. Model currently calls `read_file` N times, which is N round-trips. Gemini CLI has this as `read_many_files` with glob support. Shallow implementation: concat file contents with headers. Saves multiple rounds for "read these 5 files and compare them."

**`update_plan(steps: [{description, status}])`** — Codex has this. Lets the model maintain a visible plan that the user can see. Not a todo list — a structured plan with completed/in-progress/pending steps. The `todo_write` tool exists but `update_plan` is lighter (no CRUD, just set the full plan each time).

**`complete_task()`** — Gemini CLI has this. Signals that the task is done, allows the model to summarize what was accomplished. Currently the model just stops talking. This gives it an explicit "I'm done" signal.

**`read_lines(path, start_line, end_line)`** — Shallow rename of the existing offset/limit pattern on `read_file`. Gemini uses `start_line`/`end_line` which is more intuitive than `offset`/`limit`. Add as a separate tool or alias.

### 3. Extract descriptions to `.txt` files

Move long-form descriptions out of code and into `.txt` files (opencode pattern). Each tool gets a `.txt` file in `src/tools/descriptions/`. Loaded at startup. Makes iterating on descriptions a documentation change, not a code change.

### 4. Improve tool error messages

Every error should tell the model what to do next. Current pattern: `"File not found"`. Improved: `"File not found at src/foo.ts. Did you mean src/foo.tsx? Available .ts files in src/: a.ts, b.ts, c.ts"`.

### 5. Normalize read_file parameters

Replace `offset`/`limit` with `startLine`/`endLine` (1-indexed, inclusive) to match Gemini CLI's more intuitive approach. Keep `offset`/`limit` as deprecated aliases for backward compatibility.

## Files

- **Edit:** All tool definition files (`src/tools/*.ts`) — rewrite descriptions.
- **New:** `src/tools/descriptions/*.txt` — extracted descriptions (optional, incremental).
- **New:** `src/tools/readManyFiles.ts`, `src/tools/updatePlan.ts`, `src/tools/completeTask.ts`.
- **Edit:** `src/tools/registry.ts` (register new tools), `src/tools/readFile.ts` (rename offset/limit → startLine/endLine).

## Verification

1. `npm run typecheck` clean; `npm run test:phase` green.
2. Manual: inspect any tool description in the provider call log — reads naturally, tells the model when to use alternatives.
3. Model selects `read_many_files` when asked to "read all files in src/utils/" instead of calling `read_file` 5 times.

## Safety

- Description changes are zero-risk — they only affect model behavior, not execution.
- New tools follow the same permission model as existing ones.
- `complete_task` is idempotent — calling it multiple times is safe.
- `update_plan` is a `"session"` kind tool — no execute or mutate permission needed.
