# AGENTS.md

Guidance for AI agents (Codex, Claude, etc.) working in this repo.

## Delegating work to a model worker (DeepSeek)

When you delegate a slice of work to a DeepSeek worker (deepcoder-as-subagent),
use the headless `deepcoder delegate` CLI: **[docs/delegation-workflow.md](docs/delegation-workflow.md)**.
(The legacy `delegate.sh` shell launcher has been removed — the pipeline is in-tree.)

The non-negotiable highlights:

1. **Override ALL provider env vars inline** when launching `delegate run`/`validate` —
   `DEEPCODER_PROVIDER`, `DEEPCODER_MODEL`, `DEEPCODER_BASE_URL`, **and `DEEPCODER_API_KEY`** —
   so a stray generic `DEEPCODER_*` var can't send the wrong key to DeepSeek (→ 401).
2. **`--acceptance-first`** is the forcing function — it stamps the worker TDD + production-change
   required, so it self-seeds a test the gates validate red→green. A worker no-ops on a green check,
   so this is what forces real implementation.
3. **The pipeline enforces wiring** — `validate`/`apply` auto-derive reachability from the patch;
   a new `src/**` module with no non-test importer fails `orphaned_deliverable` (inert ≠ done).
4. **Verify-then-force in-house** — a green check is necessary, not sufficient (it trusts the
   recorded `checkPassed`). Apply the patch to a clean baseline and prove it yourself: scope +
   red-on-baseline (not vacuous) + green-on-full `test:phase`. Adversarial spot-check for
   security-sensitive slices.
5. **Land + clean worktrees separately** — never chain `pkill` with the commit (exit 144).

## Repo invariants

- The verification gate is `npm run test:phase` (typecheck + unit + adversarial).
- Never weaken the permission model (command classifier, sensitive-path guards, TTY gating,
  trust gate). Acceptance must not require a live model — use fakes / injected seams.
- Provider API keys: live smoke tests only; never commit/print/log; rotate if exposed.
- Push only when the human asks. Save accepted plans under `plans/`.
