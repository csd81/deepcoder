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
- [x] Tests (unit + fake-provider integration; 21 passing)

## Phase 2 — Correctness & ergonomics

See `plans/phase2-plan.md`.

- [x] Streaming responses behind the same provider boundary (`streamChat`)
- [x] `session` tool kind + `todo_write` tool for multi-step task tracking
- [x] Project instructions: auto-load `.deepcoder/instructions.md` / `AGENTS.md` / `CLAUDE.md`
- [x] Better diffs (git-style `@@` hunks)
- [x] Session persistence and `--resume` / `--list-sessions`

## Phase 3 — Hardening, context & scale

See `plans/phase3-plan.md`.

- [x] Hardening: segmenting command classifier, atomic session saves, fresh-on-resume system prompt, realpath write confinement
- [x] Token-aware history compaction (`/compact`, `/context`)
- [x] Repo map / file scanner + context tools (`repo_map`, `find_symbols`, `list_recent_context`)
- [x] `deepseek-reasoner` planning mode (`/plan`, `--planning-model`)

## Phase 4 — Extensibility with trust boundaries (in progress)

See `plans/phase4-plan.md`.

- [x] **4A** — MCP client (read-only), `.deepcoder/config.json`, `/mcp`; MCP tools/output untrusted, execute-mode MCP denied for now
- [x] **4B** — provider factory + backends (`DEEPCODER_PROVIDER`): DeepSeek (default), OpenAI-compatible, Ollama, Qwen (DashScope), Gemini (OpenAI-compat), and a **native Anthropic** adapter; `DEEPSEEK_*` env still works
- [x] **4C** — checkpoints: local undo for agent edits (`/checkpoint`, `/rollback`; pre-image based, **not git**, off by default)
- [~] **4D** — subagents (design `plans/phase4d-subagents-design.md`): slices 1–3 shipped — read-only `reviewer` (`/review`), `researcher` (`/research`), `test_triage` (`/triage`); restricted-registry + readonly by construction, output quarantined out of model history; model-callable/parallel deferred

## Phase 5 — Controlled verification workflows (planned)

See `plans/phase5-verification-workflows-plan.md`.

- [x] **5A** — user-invoked named checks (`/checks`, `/check <name>`); classifier-gated, streamed live but bounded/redacted/quarantined under `.deepcoder/runs/`; not model-callable
- [ ] **5B** — explicit `/triage --run <id>` integration for stored check output

## Non-goals (for now)

- IDE/GUI integration — this is a terminal-first tool
- Full OS sandboxing — the command classifier is a guardrail, not a jail
