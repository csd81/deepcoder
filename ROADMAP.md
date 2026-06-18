# Roadmap

## Phase 1 — MVP (current)

Safe, single-provider agent loop. See `plans/phase1-plan.md`.

- [x] Vendor-neutral `ModelProvider` + DeepSeek adapter
- [x] Tool layer (`Tool -> build() -> ToolInvocation -> execute()`)
- [x] MVP tools: read_file, list_dir, grep, glob, edit_file, write_file, run_bash
- [x] Workspace path confinement
- [x] Permissions: command classifier, policy (readonly/ask/auto), approval prompt
- [x] Read-before-write + diff previews for mutating tools
- [x] Provider error mapping
- [x] Git status/diff helpers
- [x] Agent loop (max-turns, abort, repeated-invalid-args guard)
- [x] CLI / REPL + slash commands
- [ ] Tests (unit + fake-provider integration)

## Phase 2 — Correctness & ergonomics

- Streaming responses (token + tool-call streaming) behind the same provider boundary
- `todo_write` tool for multi-step task tracking
- Project instructions: auto-load `AGENTS.md` / `CLAUDE.md` into the system prompt
- Better diffs (real `git diff`-style hunks) and richer terminal rendering (Ink)
- Session persistence and `--resume`

## Phase 3 — Context & scale

- Context-window management / history compaction
- Repo map / file scanner for large codebases
- `deepseek-reasoner` planning mode for hard tasks

## Phase 4 — Extensibility

- MCP client support (external tools/resources)
- Additional providers (OpenAI, Anthropic, local via Ollama) as adapters
- Subagents / parallel task delegation
- Optional git checkpoint/auto-commit workflow

## Non-goals (for now)

- IDE/GUI integration — this is a terminal-first tool
- Full OS sandboxing — the command classifier is a guardrail, not a jail
