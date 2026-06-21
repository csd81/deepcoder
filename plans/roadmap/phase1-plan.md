# Deepcoder MVP Architecture Plan (Phase 1) — APPROVED

## Context

`/0/deepcode/deepcoder` is a fresh git repo (pushed to `github.com/csd81/deepcoder`, private) containing a partial scaffold: config, a vendor-neutral `ModelProvider` boundary with a `DeepSeekProvider` adapter, the qwen-code-style `Tool -> build() -> ToolInvocation -> execute()` layer, seven MVP tools, and the `resolveInWorkspace()` path-confinement primitive. **There is no agent loop, no permissions layer, and no CLI yet.**

The scaffold is deliberately incomplete in a way that matters for safety: `edit_file`, `write_file`, and `run_bash` currently execute with no permission gate. Wiring them into an agent loop as-is would let the model mutate files and run shell commands unsupervised. The required ordering is therefore: **harden the safety boundary first, then connect the loop.** This plan keeps the existing scaffold and builds the remaining layers on top of it.

## Scope / non-goals

Keep: Node/TS, non-streaming `ModelProvider.chat()`, DeepSeek as the only provider, the current tool interface. Post-MVP (not in this plan): streaming UI, MCP, subagents, session resume, context compaction, auto-commit.

## Changes

### 1. Permissions layer (before the loop) — new files
- `src/permissions/commandClassifier.ts` — classify a bash command string into `allow | ask | deny`:
  - **allow**: `pwd`, `ls`, `cat`, `rg`, `grep`, `find`, `git status`, `git diff`, `git log`.
  - **ask**: tests/builds/package scripts (`npm`, `pnpm`, `node`, `tsc`, `make`, etc.).
  - **deny**: `rm`, `sudo`, `chmod`, `chown`, `mkfs`, `:(){`, background daemons, command substitution (`$(...)`/backticks), redirections outside the workspace.
- `src/permissions/policy.ts` — `check(invocation, mode): "allow" | "ask" | "deny"` combining tool `kind` with approval mode:
  - `readonly`: allow read-only; deny mutate/execute.
  - `ask`: allow read-only; ask for mutate; for execute, defer to classifier (deny stays deny, else ask).
  - `auto`: allow read-only and mutate; for execute, classifier `allow` -> allow, classifier `deny` -> deny, else ask.
- `src/permissions/prompt.ts` — terminal y/n approval rendering `invocation.describe()` and any preview/diff.

### 2. Tool layer additions — edit existing files
- `src/tools/types.ts`: extend `ToolInvocation` with `affectedPaths?: string[]` and `preview?(ctx): Promise<ToolPreview>`; add `ToolPreview = { description: string; diff?: string }`. Extend `ToolContext` with a `readTracker: Set<string>` (absolute paths read this session) — the context is created once per session and passed to every `execute`, so it is the right home for prior-read state.
- `src/tools/readFile.ts`: on success add the resolved absolute path to `ctx.readTracker`.
- `src/tools/editFile.ts`: implement `preview()` computing a unified diff; require the target be in `ctx.readTracker` (else a model-readable "read it first" error). Keep exact-match + unique-unless-`replace_all`.
- `src/tools/writeFile.ts`: distinguish create vs overwrite; `preview()` shows a diff for overwrite and requires prior read for overwrite (not for create).

### 3. Provider error mapping — edit `src/providers/deepseek.ts`
Map 401 invalid key, 429 rate limit, 404/400 model-not-found, and empty `choices` to clean readable errors instead of raw SDK stack traces.

### 4. Git helpers — new file `src/workspace/git.ts`
`status()`, `diff(paths?)`, dirty-tree summary. Read-only; no auto-commit in MVP.

### 5. Agent loop — new files `src/agent/agentLoop.ts`, `src/agent/systemPrompt.ts`
Per turn: send system prompt + conversation + `registry.schemas()`. For each tool call: `get(name)` -> `build(args)` (validation errors become a retryable tool-result) -> `policy.check` -> if `ask`, `preview()` + prompt -> execute -> append `tool` message. Terminate on: final assistant text, `maxTurns`, denied critical action, repeated identical invalid-args, or user abort (`AbortSignal`).

### 6. CLI / REPL — new files `src/cli/main.ts`, `src/cli/repl.ts`, `src/cli/slashCommands.ts`
- `commander` entry: one-shot `deepcoder "fix failing tests"`, else interactive REPL.
- Slash commands: `/exit`, `/clear`, `/status`, `/diff`, `/mode`.
- Loads `.env` + config, resolves workspace root, constructs registry, provider, policy, and a single session `ToolContext` (with the `readTracker`).

### 7. Docs — `README.md`, `ROADMAP.md`
README: setup, safety/permission model, MVP limitations. ROADMAP: post-MVP items above.

## Implementation order
1. Permissions (`commandClassifier`, `policy`, `prompt`).
2. Tool-layer additions (`ToolPreview`, `readTracker`, previews, prior-read enforcement).
3. Provider error mapping.
4. Git helpers.
5. Agent loop + system prompt.
6. CLI / REPL.
7. README + ROADMAP.
8. Tests.

## Test plan
**Unit (`node --test`)**: `resolveInWorkspace()` escapes; `parseArgs` readable errors; `edit_file` missing/duplicate/unread; `write_file` create vs overwrite; `commandClassifier` allow/ask/deny; `policy` modes.
**Integration (fake provider)**: read_file loop; edit_file approval loop; denied run_bash returns tool error; maxTurns cap.
**Manual**: `npm run typecheck`; `deepcoder "list files"`; `deepcoder "make a small edit"` shows diff in `ask`; `run_bash` never runs without approval.

## Notes
- Each layer committed separately and pushed to `origin/master`.
- DeepSeek default `deepseek-chat`; `deepseek-reasoner` reserved for later planning mode.

## Progress
- [x] 1. Permissions layer
- [x] 2. Tool-layer additions
- [x] 3. Provider error mapping
- [x] 4. Git helpers
- [x] 5. Agent loop + system prompt
- [x] 6. CLI / REPL
- [x] 7. README + ROADMAP
- [x] 8. Tests (21 passing; typecheck clean)
