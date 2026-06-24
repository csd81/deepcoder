# Capabilities gap-analysis — "AI CLI workflows" vs what deepcoder already has

## Context

A listicle of ~13 "things AI coding CLIs can do" was proposed as candidate features.
Rather than write 13 plans, this maps each to existing deepcoder infrastructure and
isolates the **genuine gaps**. The headline: **~70% already ships** — the real backlog
is ~5 small, focused features.

## The map

| Requested workflow | Already in deepcoder | Status |
|---|---|---|
| Complex refactoring & multi-file edits | `/refactor` (`cli/refactor.ts`) over the solve loop + `src/index/` (find-usages) + `grep`/`glob` + `formatOnEdit` | **BUILT** |
| Coding a feature (execution) | the agent loop + `read/edit/write` tools + `run_bash` (gated) + `formatOnEdit` + post-write diagnostics | **BUILT** |
| Planning a feature ("measure twice") | `/architect` + `/plan` (`subagents/architectPlanner.ts`, `planBrief.ts`) | **BUILT** |
| Debugging (find & fix) | `/triage` + agent loop + solve loop | **BUILT** |
| **TDD loop** ("make the tests pass") | **the solve loop** (`src/solve/`, `--solve --check`) — the core of every delegation this session | **BUILT** |
| Autonomous bug-fixing & committing | `delegate auto` (task→branch→fix→PR) + solve; commit is correctly **gated** (classifier) | **BUILT** (commit stays gated by design) |
| Parallel agent loops / subagents | `coordinator.ts`, `batchPlan`/`runRunnableConcurrent`, background `&research`/`&review`, the model-callable `delegate` tool (+ `auto` mode) | **BUILT** (homogeneous/disjoint) |
| Explain-my-error | `/triage` (diagnoses a failure/log) | **BUILT** |
| Auto-commit / commit messages | `git.ts` + git slash commands; `git diff` is read-only/auto-allowed | **PARTIAL** → gap below |
| Code reviewer (pre-push) | `/review` + `multiAngleReview` + the hooks system (`src/hooks/`) | **PARTIAL** → gap below |
| Boilerplate scaffolder | `/skillify`, user-defined slash commands, the write tool | **PARTIAL** → gap below |
| Documentation generation | `src/index/` (enumerate symbols) + read/edit tools | **GAP** (no dedicated feature) |
| Manager spawning *heterogeneous* role agents (research→dev) | `coordinator` exists but runs **homogeneous** workers | **GAP** (role-specialized pipeline) |

## The genuine gaps (the only things worth building)

1. **`/commit-msg`** — a **pure** generator: `git diff [--cached]` → a Conventional Commits
   message; print it, optionally run the gated commit. Tiny; the generator is unit-testable.
2. **Doc generation** — `/document <glob>`: enumerate symbols (`src/index/`), insert doc
   blocks above each (read-before-write, **comments-only**, idempotent), optionally update a
   README section. Hard invariant: never touch executable code; `test:phase` stays green.
3. **Pre-push review hook** — wire `multiAngleReview` as a `git pre-push` hook: review
   `git diff origin/main`, print issues or "LGTM", abort the push on findings. Read-only;
   reuses the existing reviewer.
4. **Boilerplate scaffolder** — `/scaffold <kind> <name>`: read a sample/style-guide as
   context, generate a new file to match. Pure new-file write (no edit-matching).
5. **Heterogeneous parallel agents** — extend `coordinator` so a **research** agent's
   output feeds a **developer** agent's context (role-specialized pipeline), respecting the
   existing trust-boundary isolation. Largest of the five.

Plans #1–4 already have draft plan PRs from the planning flood (commit-messages #24✅,
doc-generation #26, refactoring #23✅, parallel-agents #22, bugfix #25✅); fold the
*genuine-gap* portions of those and **close the redundant remainder**.

## Recommendation
Build gaps **1–4** (small, high-value, mostly disjoint files) via `delegate auto`; treat
**5** as its own larger plan. Everything else in the listicle is **already shipped** — no
new work. This doc replaces the ~13 individual plan requests.
