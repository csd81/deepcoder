# Delegating work to a model worker (DeepSeek)

The verified workflow for delegating a bounded slice to a DeepSeek worker
(deepcoder-as-subagent), then verifying and landing the result in-house. It runs
through the **headless `deepcoder delegate` CLI** — the in-tree pipeline that
drives the real 9-gate validator + red/green proof (`src/delegate/`). The legacy
`delegate.sh`/`delegate-finish.sh` shell launchers have been **removed**.

> TL;DR: bound the slice → `delegate plan --acceptance-first` → `delegate run`
> (isolated worktree, nothing applied) → `delegate validate --json` (exit 0 iff
> applyable) → **verify the patch yourself** (scope + red-on-baseline + green-on-full)
> → `delegate apply` / `delegate pr`. Push only when the human asks.

---

## 0. Provider env overrides (READ FIRST — the #1 failure cause)

The shell profile exports generic `DEEPCODER_*` vars (often an OpenAI key + base
URL). Those **generic vars win** in config resolution, so setting only
`DEEPCODER_PROVIDER`/`MODEL` sends the wrong key to DeepSeek → `401`. **Override
ALL of these inline** when launching `delegate run`/`validate`:

| Provider | DEEPCODER_PROVIDER | DEEPCODER_MODEL | DEEPCODER_BASE_URL | DEEPCODER_API_KEY |
|---|---|---|---|---|
| DeepSeek (Flash) | `deepseek` | `deepseek-v4-flash` | `https://api.deepseek.com` | `$DEEPSEEK_API_KEY` |
| DeepSeek (Pro)   | `deepseek` | `deepseek-v4-pro`   | `https://api.deepseek.com` | `$DEEPSEEK_API_KEY` |

The DeepSeek key lives in `$DEEPSEEK_API_KEY`. Inject it as an env var; never
print, log, commit, or interpolate it into a string.

## 0b. Local setup (env-specific, not in the repo)

- **`.deepcoder/config.json` must define the `phase` check**, or the worker
  no-ops with `Unknown check "phase"`:
  `{ "checks": { "phase": { "command": "npm run test:phase", "timeoutMs": 600000 } } }`
  (`timeoutMs` is capped at 600000). The runner copies this into each worktree.
- **On kernels without nested user namespaces, pass `DEEPCODER_SANDBOX=off
  DEEPCODER_CONTAIN=0`.** The gate command (`npm run test:phase`) itself runs
  bwrap; a contained worker would be bwrap-inside-bwrap and could never pass.
  The runner-owned worktree + `resolveInWorkspace` still confine file edits;
  only `run_bash` runs uncontained — acceptable for a trusted, bounded slice.

## 1. Bound the slice

Carve out a pure or seam-injected core (one new file + its wiring + tests, no
model/network/TTY needed to test). Prefer **one worker** for interdependent
files (`--max-workers 1`) — the heuristic planner's text split would put
interdependent areas in separate worktrees that can't see each other's new files.

## 2. Plan + run + validate

```bash
# Plan (heuristic, no model). --acceptance-first stamps TDD + production-change
# required: the worker self-seeds a test the gates validate red→green, which is
# what forces real implementation (a worker no-ops on a green check).
deepcoder delegate plan "<task contract>" --max-workers 1 --acceptance-first
# → prints a plan id, e.g. plan-2026-…

# Run the worker(s) in isolated worktrees (nothing applied). LIVE model — needs
# the §0 env overrides (+ §0b sandbox-off on this kernel).
DEEPCODER_PROVIDER=deepseek DEEPCODER_MODEL=deepseek-v4-flash \
DEEPCODER_BASE_URL=https://api.deepseek.com DEEPCODER_API_KEY="$DEEPSEEK_API_KEY" \
DEEPCODER_SANDBOX=off DEEPCODER_CONTAIN=0 \
  deepcoder delegate run <plan-id> --json

# Validate: the 9 gates + auto-derived wiring (orphaned_deliverable) gate.
# exit 0 iff applyable. (No model; reads run.json + scans src/ — no bwrap.)
deepcoder delegate validate <plan-id> <worker-id> --json
```

The **task contract** passed to `plan` is also the worker's prompt — make it
strict: exact signatures, one tagged deliverable per behavior, the **wiring**
call-sites (registry/dispatch/config/CLI) in the allowed-files set, reuse
instructions, hard "touch ONLY these files" constraints, and "no vacuous tests".

## 3. The pipeline enforces wiring (so green ≠ inert)

`validate`/`apply` auto-derive reachability rules from the patch
(`deriveReachabilityFromPatch`): every **NEW non-test `src/**` module must have a
non-test importer**, else `orphaned_deliverable` → not applyable. A green check
on a module nothing calls is rejected, not blessed. This is automatic — you don't
declare `expectedReachable` for it to fire.

## 4. Verify-then-force IN-HOUSE (the default — never trust the green)

A green check is necessary, not sufficient: it trusts the worker's **recorded**
`checkPassed`, which can mask a bug or a gutted test. Apply to a clean baseline
and prove it yourself:

```bash
git apply --whitespace=nowarn .deepcoder/delegations/<plan>/runs/<worker>/patch.diff
git status --short                 # scope: only the allowed files changed
npm run typecheck
# red-on-baseline: hide the impl, the slice's tests must FAIL (not vacuous)
mv src/<area>/<impl>.ts /tmp/impl.bak
node --import tsx --test test/<slice>.test.ts >/dev/null 2>&1 \
  && echo "VACUOUS!" || echo "red ✓"; mv /tmp/impl.bak src/<area>/<impl>.ts
npm run test:phase                 # green-on-full (THE gate)
```

For security-sensitive slices, add an adversarial spot-check. For a small,
well-pinned gap, finish in-house rather than re-delegating a whole phase.

## 5. Land

```bash
deepcoder delegate apply <plan-id> <worker-id>   # re-validates; refuses if not applyable
# or, to review as a PR (never auto-merges — the PR is the gate):
deepcoder delegate pr <plan-id> <worker-id> --base master
```

Or commit by hand from the verified working tree. **Push only when the human
asks.** Clean up worktrees with `git worktree remove <path>` (never blanket-`rm`
`/tmp/deepcoder-ws-*` — it can delete another agent's in-flight tree); never
chain `pkill` with a commit (exit 144).

## Model choice

- **`deepseek-v4-flash`** — bounded, well-seeded slices (cheap, one-passes most). Default.
- **`deepseek-v4-pro`** — ambiguous refactors / security-sensitive / cross-cutting work.
- Verification is model-agnostic: a weaker model never risks correctness — a
  shortfall just shows up as a failed verify and you escalate.

## Hard invariants (do not weaken)

- The gate is `npm run test:phase` ("solved" = tests + quality pass).
- Never weaken the permission model (classifier, sensitive-path guards, TTY
  gating, trust gate). Acceptance must not require a live model — use fakes / seams.
- Provider API keys: live smoke tests only; never commit/print/log; rotate if exposed.
- Push only when the human asks. Save accepted plans under `plans/`.
