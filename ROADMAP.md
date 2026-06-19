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
  gate. **solved = tests_passed && quality_passed** (a green-but-bad patch is not solved). 40 cases
  (20 Node + 20 Python, `--lang` filter) numbered by increasing difficulty; `--selftest` /
  `--fake-solve fixed|noop` give a full no-model acceptance path. Documents a tiered iteration loop
  (Tier 0 unit → Tier 5 SWE smoke).
- [~] **6C hard local-bench cases** (`evals/local-bench/`, branch `phase6c-hard-cases`): the 40
  base cases became too easy (40/40 solved in one attempt), so the harness now *measures* harder
  behavior — `expectedChangedPaths` / `forbiddenChangedPaths` / `requiredTestPaths` / `category` /
  `difficulty` / `issueHintsLevel`, four new quality flags (`missing_expected_change`,
  `forbidden_path_changed`, `missing_required_test`, `repro_invalid`), report grouping by
  difficulty/category, and an independent **`oracle/` overlay** (the local equivalent of SWE-bench's
  hidden FAIL_TO_PASS — an agent-authored repro test is measured but never self-grades). First **5
  hard cases** (issue-derived-test, cache-invalidation, path-traversal, async-race,
  config-precedence) with no-model acceptance (`--selftest` + `--fake-solve fixed|noop`). The live
  5-case run is a separate explicit decision (decision rule: 5/5-in-one-attempt ⇒ still too easy).
  - **6D retune:** the first live run was 4/5 — all bugs fixed first-attempt; the one miss was a
    correct fix blocked by an over-rigid test-placement rule. Loosened the gate (agent tests may live
    under any allowed `tests/` prefix; `repro_invalid` still requires red→green), expanded to **10
    hard cases** (added multi-file-call-chain, error-preservation, red-herring-files, cli-contract,
    parser-quotes — symptom-only issue text, discovery required), and the report now separates
    `bug-fixed by oracle` (correctness) from `quality-blocked` (correct-but-flagged).
  - **6E repo-scale** (`plans/phase6e-repo-scale-local-bench-plan.md`): the live 10-hard run was
    10/10 one-shot, so added 5 **multi-file mini-repo** cases (`repo-hard-*`: auth-token-refresh,
    job-queue-retry, markdown-frontmatter, plugin-config-precedence, router-middleware-order) with
    4–8 files + decoys, requiring call-path tracing and (mostly) a coordinated source-fix + added
    test. New harness fields `minChangedPaths`/`maxChangedPaths`/`requiredChangedPathGroups` (flags
    `too_few_changed_paths`/`too_many_changed_paths`/`missing_required_path_group`). No-model
    acceptance green (55 cases). Live `repo-hard` run is a separate decision.
- [ ] follow-ups: wire the read-only `reviewer` subagent as an LLM quality gate; consider a
  non-empty-patch hard requirement in the core solver (flask-5063 empty-patch finding); expand the
  hard set toward the full "Hard 20" once the first 5 discriminate.

## Phase 7 — Extensibility & isolation

- [x] **7A fast tool-level sandboxing** (`src/sandbox/`, `plans/phase7a-fast-tool-sandboxing-plan.md`):
  only risky executions (`run_bash`, configured checks) run in a sandbox; the deepcoder process +
  file tools stay local. `SandboxConfig` in `.deepcoder/config.json` + `DEEPCODER_SANDBOX` env +
  `--sandbox` flag (precedence CLI > env > file > default `fast`). `fast` → **bubblewrap** when
  available else local; bwrap binds workspace rw, system dirs ro, private `/tmp`, clears env (no
  API-key leak), never mounts home/docker-sock. `/sandbox` status + toggles; `npm run sandbox:smoke`.
  Docker/podman/runsc + sandbox-expansion prompts deferred.
- [ ] **7B lifecycle hooks** (`plans/phase7b-lifecycle-hooks-plan.md`) — reuse the sandbox runner.
- [ ] **7C agent skills** (`plans/phase7c-agent-skills-plan.md`).

## Non-goals (for now)

- IDE/GUI integration — this is a terminal-first tool
- Full per-session OS sandboxing — tool-level sandboxing (Phase 7A) isolates risky commands; the
  command classifier remains a guardrail, and a whole-session jail is still out of scope
