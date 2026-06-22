# AGENTS.md

Guidance for AI agents (Codex, Claude, etc.) working in this repo.

## Delegating work to a model worker (DeepSeek)

When you delegate a slice of work to a DeepSeek worker (deepcoder-as-subagent),
follow the verified playbook: **[docs/delegation-workflow.md](docs/delegation-workflow.md)**.

The non-negotiable highlights:

1. **Override ALL provider env vars inline** — `DEEPCODER_PROVIDER`, `DEEPCODER_MODEL`,
   `DEEPCODER_BASE_URL`, **and `DEEPCODER_API_KEY`** — so a stray generic `DEEPCODER_*`
   var can't send the wrong key to DeepSeek (→ 401). `scripts/delegate.sh` does this for you.
2. **Red-seed first** — commit a tagged failing test that's red on baseline. DeepSeek no-ops
   on a green check, so the red anchor is what forces real implementation.
3. **Cap `--solve-attempts 3`** — more chokes the worker on re-dumped check output.
4. **Verify-then-force in-house** — a green `--check phase` is necessary, not sufficient.
   Apply the patch to a clean baseline and prove it yourself: scope + anchors preserved +
   red-on-baseline (not vacuous) + green-on-full `test:phase`. Add an adversarial spot-check
   for security-sensitive slices.
5. **Land + clean worktrees separately** — never chain `pkill` with the commit (exit 144).

## Repo invariants

- The verification gate is `npm run test:phase` (typecheck + unit + adversarial).
- Never weaken the permission model (command classifier, sensitive-path guards, TTY gating,
  trust gate). Acceptance must not require a live model — use fakes / injected seams.
- Provider API keys: live smoke tests only; never commit/print/log; rotate if exposed.
- Push only when the human asks. Save accepted plans under `plans/`.
