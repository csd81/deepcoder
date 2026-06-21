# Deepcoder Phase 2 Plan — Correctness & Ergonomics (APPROVED)

## Context

Phase 1 shipped a safe, non-streaming, single-provider agent loop. It works but doesn't yet *feel* usable in real terminal work: responses arrive in one blocking chunk, the agent has no task discipline, project conventions aren't picked up, and nothing survives between runs.

Phase 2 makes Deepcoder trustworthy to watch and resume, **without** the post-MVP items (no MCP, repo map, subagents, auto-commit, or OS sandboxing). The Phase 1 provider/tool boundaries stay intact — streaming and new state slot in behind them.

## Key design decisions

- **`session` tool kind.** `ToolKind` becomes `"read-only" | "session" | "mutate" | "execute"`. `session` tools mutate in-memory session state (not the filesystem) and are **always allowed** by the policy — kept distinct from filesystem `read-only`. `todo_write` is a `session` tool.
- **Streaming assembles back into the existing loop.** The DeepSeek adapter owns all OpenAI-compatible delta accumulation and emits normalized `ModelEvent`s ending in a fully-formed tool-call list. A loop-side helper consumes the stream into the *same* `ChatResponse` shape `chat()` returns, firing a text-delta hook. The loop's validate → permission → preview → execute logic is unchanged.
- **Todo + readTracker state live on a session object**, passed into `ToolContext`. Tools mutate it; the loop reads it; the session store serializes it.
- **Todos injected per-turn as an ephemeral system message** appended at send time and *not* persisted in history (regenerated each turn from the live todo store). Persist the todo *data*, not duplicated prompt text.
- **Project instructions = first-match-wins** by precedence (`.deepcoder/instructions.md` > `AGENTS.md` > `CLAUDE.md`). `/instructions` shows source + text.
- **Autosave-first sessions.** Save after each user message and after every tool result, so state is never lost mid-loop.

## Changes

### 1. Docs (this file + ROADMAP)
- `ROADMAP.md`: mark Phase 1 tests done; add the Phase 2 checklist.

### 2. Diff upgrade — `src/tools/diff.ts`
Emit `@@ -a,b +c,d @@` hunk headers grouped by change region (still LCS-based, no new dependency). `edit_file`/`write_file` previews show path + create/edit/overwrite + diff. `/diff` stays git-backed.

### 3. Project instructions — new `src/context/projectInstructions.ts`; edit `agent/systemPrompt.ts`
- `loadInstructions(workspaceRoot): { source: string | null; text: string }` (first-match-wins).
- `buildSystemPrompt` takes optional `instructions` and appends it.
- `/instructions` slash command shows loaded source + text.

### 4. Todo tool — new `src/tools/todoWrite.ts`; edit `tools/types.ts`, `tools/registry.ts`, `permissions/policy.ts`
- Add `session` to `ToolKind`; policy always allows `session`.
- Schema: `{ todos: Array<{ id, content, status: pending|in_progress|completed }> }`; validate **at most one** `in_progress`.
- Store on the session object (`session.todos`), surfaced via `ToolContext`. Loop appends an ephemeral todo system message when non-empty.
- `/todos` slash command renders current state.

### 5. Session persistence & resume — new `src/session/sessionStore.ts`; edit `cli/main.ts`, `cli/repl.ts`, `agent/agentLoop.ts`
- Persist JSON under `.deepcoder/sessions/<id>.json`: `messages`, `mode`, `model`, `todos`, `readTracker` (array), `createdAt`, `updatedAt`.
- CLI flags: `--resume [id]` (most-recent if omitted), `--list-sessions`.
- `/save` slash command; autosave after each user turn and each tool result via a loop `onPersist?()` hook.
- Resume rehydrates `messages`, `todos`, and `readTracker` (read-before-write survives resume).

### 6. Streaming provider boundary — `src/providers/types.ts`, `providers/deepseek.ts`
- `ModelEvent`: `assistant_text_delta | tool_call_complete | done | error` (tool-call deltas accumulated inside the adapter).
- `ModelProvider` gains optional `streamChat?(input): AsyncIterable<ModelEvent>`; `chat()` stays required.
- `DeepSeekProvider.streamChat`: `stream: true`, accumulate `tool_calls` fragments by index, parse args at finish, emit text deltas + `tool_call_complete` + `done`. Reuse `mapProviderError`.

### 7. Loop + CLI streaming — `src/agent/agentLoop.ts`, `src/cli/repl.ts`
- `getResponse()`: use `streamChat` if present (firing `onAssistantTextDelta`), else `chat()`. Add `onAssistantTextDelta?` to `AgentDeps`.
- REPL renders streamed text incrementally; consistent labels: `assistant>`, `tool <name>: <describe>`, `approve <tool>? [y/N]`. No Ink yet.

### 8. Tests
**Unit/integration (`node --test`, fake providers only — never the live key):**
- Fake **streaming** provider: loop consumes `streamChat`, fires text deltas, assembles tool calls; falls back to `chat()` when absent.
- Instruction precedence: `.deepcoder/instructions.md` > `AGENTS.md` > `CLAUDE.md`; none → empty.
- `todo_write`: rejects >1 `in_progress`; stores/reads back; policy always allows `session` kind.
- Session store: save then resume restores messages, todos, readTracker (resumed session edits a previously-read file without re-reading).
- Diff snapshots for create / edit / overwrite.

## Implementation order
1. Docs. 2. Diff. 3. Instructions. 4. Todo (+ `session` kind). 5. Sessions. 6. Streaming provider. 7. Loop + CLI streaming. 8. Tests.

## Verification / acceptance
- `npm run typecheck` and `npm test` pass.
- `npm run dev -- "list files in src"` still works.
- Streaming text appears incrementally with real DeepSeek (live smoke test, `readonly` mode first).
- `AGENTS.md`/`.deepcoder/instructions.md` changes the system prompt (via `/instructions`).
- Agent calls `todo_write`; `/todos` shows state.
- A resumed session remembers read-before-write state.
- No MCP / repo map / subagents / auto-commit / sandboxing added.

## Credential guardrails (live testing)
- The DeepSeek key in `.env` is for **live smoke tests only**, run in `readonly` mode first. Automated tests use fake providers.
- Never print the key, commit `.env`, or let it reach docs/tests/logs/snapshots/errors.
- The key was pasted into chat earlier → treat as exposed; rotate in DeepSeek and update `.env` before heavier use.

## Progress
- [x] 1. Docs  - [x] 2. Diff  - [x] 3. Instructions  - [x] 4. Todo (+session kind)  - [x] 5. Sessions  - [x] 6. Streaming provider  - [x] 7. Loop+CLI streaming  - [x] 8. Tests (32 passing; typecheck clean; live readonly smoke test verified)

Also fixed during live testing: tool JSON-schemas now use draft-07 (`zodToJsonSchema` default target) instead of `openApi3` — DeepSeek rejected the OpenAPI boolean `exclusiveMinimum`.
