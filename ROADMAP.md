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
- [x] **5B** — closed-loop solver (`/solve <check> <task>`, `--solve --check`): edit → run the named check → feed a deterministic, bounded, redacted, untrusted-framed failure summary back → retry to budget. No auto-rollback; check stays user-configured/classifier-gated; SWE-bench thin `--solve-cmd` hook
- [ ] explicit `/triage --run <id>` integration for stored check output (follow-up); LLM/triage-subagent failure summarizer (5B uses a deterministic one)
- [ ] **solve telemetry shipped** (`--telemetry` JSON sink + `evals/swebench/report.py`: per-attempt patch hash, repeated/empty-patch, failure-signature change, check-vs-hidden-resolved). Open follow-ups: per-instance API/token cost (needs a `usage` field on `ChatResponse` through every provider adapter); an **in-container** SWE solve loop (host verify env can't pin per-instance deps/Python — old flask fails to import on a modern interpreter)

## Phase 6 — Benchmarking & solve-quality (in progress)

- [~] **6 in-container SWE-bench solve** (branch `phase6-incontainer`): run `--solve` inside the
  official instance container (pinned env), authored public-test map, baseline-diff oracle,
  telemetry → `report.py`. 3-instance live smoke: check 3/3, resolved 0/3, 1 empty patch.
- [x] **6B local bugfix benchmark** (`evals/local-bench/`, `plans/phase6b-local-bench-plan.md`):
  fast, no-Docker, Node/TS runner with a **real red→green oracle** + deterministic patch-quality
  gate. **solved = tests_passed && quality_passed** (a green-but-bad patch is not solved). 10 cases
  of increasing complexity; `--selftest` / `--fake-solve fixed|noop` give a full no-model acceptance
  path. Documents a tiered iteration loop (Tier 0 unit → Tier 5 SWE smoke).
- [ ] follow-ups: wire the read-only `reviewer` subagent as an LLM quality gate; consider a
  non-empty-patch hard requirement in the core solver (flask-5063 empty-patch finding).

## Non-goals (for now)

- IDE/GUI integration — this is a terminal-first tool
- Full OS sandboxing — the command classifier is a guardrail, not a jail
