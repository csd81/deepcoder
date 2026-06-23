# Feature — Autonomous delegate-to-PR (`deepcoder delegate auto`)

## Context

Delegating a slice today still takes a human stitching steps by hand:
`git worktree add` a branch → provision deps → run `scripts/delegate.sh` → wait on a
sentinel → run **verify-then-force manually** (scope, non-vacuous, wiring, conflict) →
`scripts/delegate-finish.sh` to open a PR → review. Every delegation in this repo's
recent history was driven that way.

But **the pieces to do this autonomously already exist** — they're just not chained:

| Manual step I do by hand | Already-built primitive |
|---|---|
| create branch + isolated worktree, provision, run worker | `runWorker` (`src/delegate/workerRunner.ts:226`) — owns an isolated worktree, builds env via `buildWorkerEnv`, runs `--solve --check` |
| build a plan from a task (no model) | `buildPlan` (`src/delegate/planner.ts:51`) + `savePlan` (`store.ts`) — wrapped by `runDelegatePlan` (`src/cli/delegateCli.ts`) |
| run the workers | `runRunnable`/`runRunnableConcurrent` (`src/delegate/orchestrator.ts`) — wrapped by `runDelegateRun` |
| **verify-then-force** (scope / non-vacuous / wiring / green) | the **9 validation gates** already encode exactly this — see the mapping below |
| open a PR, gated on the result, never auto-merge | `scripts/delegate-finish.sh` (commit → push → `gh pr create`) |

**Key insight — the 9 gates ARE verify-then-force.** My manual checks map 1:1 onto
`loadAndValidateWorker` (`src/delegate/validation.ts:558`):

| Manual check | Gate |
|---|---|
| only allowed files changed (scope) | `validatePatch` → `out_of_scope`/`forbidden_path` |
| hide impl → tests fail (non-vacuous) | `verifyManifestCoverage` red proof (`verify.ts:140`) / `evaluateVerify` |
| new symbol has a real caller (wiring) | `evaluateCompleteness` → `orphaned_deliverable` (`completeness.ts`, `findImporters`) |
| `test:phase` green | check gate + green proof |

So `WorkerValidation.applyable === true` already means "passed verify-then-force." The
autonomous loop doesn't need new verification logic — it needs to **run the gates and
gate the PR on `applyable`**.

**Goal:** one capability — `deepcoder delegate auto "<task>"` — that takes a task and
returns a **reviewed-ready PR**, doing branch/worktree, implement, validate, and PR
entirely on its own, with **zero** manual git or shell glue. Then retire
`scripts/delegate.sh` + `delegate-finish.sh`.

### Two human crutches this MUST remove (explicit requirements)

Today, even with `delegate.sh`, a human still does two things by hand:

1. **The human authors the red seed.** Wrong — **the worker (DeepSeek) must write its
   own adversarial/red test.** This is the existing **TDD / acceptance-first** path:
   `buildPlan(task, { tdd: true })` stamps `tdd.required`; `runWorkerTdd` makes the
   worker author a failing test per deliverable FIRST, and the `green_confirmed` gate
   (`validation.ts` Gate 9 + `verifyManifestCoverage` red proof) proves the test was
   genuinely red on baseline and green after — i.e. the worker self-seeds, and the gate
   proves the seed wasn't vacuous. No human-written seed anywhere.
2. **The seed must never touch the main checkout — worktree-first.** The worktree is
   created FIRST; the worker authors its test **inside that worktree on its branch**.
   The main checkout is never written to (no `?? test/...`, no `DELEGATE_SEED` copy from
   the main tree). `runWorker` already owns the isolated worktree, so this falls out for
   free once seeding moves from "human copies a file in" to "worker writes its test in
   the worktree."

Net: `delegate auto "<task>"` → worktree-first, worker-authored red test, worker
implements, gates verify (incl. red→green proof), PR opened iff applyable. The human
writes neither a seed nor any git.

## Design — the chain

`deepcoder delegate auto "<task>" [--concurrent] [--no-pr] [--json]`:

1. **Plan** — `runDelegatePlan(root, task, { tdd: true })` → a TDD-required plan
   (`buildPlan` stamps `tdd.required`). TDD mode is what makes the worker **red-seed
   itself**: it must author a failing test per deliverable before implementing
   (`runWorkerTdd` + the `green_confirmed` gate), so we no longer hand-write seeds.
2. **Run** — `runDelegateRun(root, planId, { concurrent })` → each worker runs in its
   own runner-owned worktree (`runWorker`), nothing applied.
3. **Validate** — `loadAndValidateWorker(root, planId, workerId)` per worker → the 9
   gates + (via `tdd.required`) the red/green manifest proof. Emits `validation.json`.
4. **PR (only if `applyable`)** — for each `applyable` worker, commit its branch, push,
   and `gh pr create` with the findings + the gate verdict embedded in the body.
   A **non-applyable** worker opens **no PR** (or a draft labeled `needs-work` with the
   failing gates listed) — the human is never handed an unverified green.
5. **Never merge.** The PR is the review gate; `auto` stops at "PR opened."

## New surface
- `deepcoder delegate pr <plan-id> [worker-id]` — port `delegate-finish.sh` into the
  CLI: commit + push + open PR, **gated on `validation.json.applyable`** (refuses if not
  applyable). Reusable standalone and from `auto`.
- `deepcoder delegate auto "<task>"` — the orchestrator that chains plan → run →
  validate → pr. Thin: it composes the four existing `runDelegate*` functions.
- The model-callable `delegate` tool (`src/tools/delegateTool.ts`) gains an `auto` mode
  so the **agent itself** can fire a full delegate-to-PR from inside a session
  (depth-guarded — a worker can't recurse).

## Files to change
- **New:** `src/cli/delegateCli.ts` → add `runDelegateAuto()` + `runDelegatePr()` and
  register `delegate auto` / `delegate pr` subcommands (file already exists from the
  headless-CLI work).
- **New:** `src/delegate/openPr.ts` — the commit/push/`gh pr create` logic ported from
  `scripts/delegate-finish.sh`, **gated on `WorkerValidation.applyable`**, body carries
  the gate verdict. (Pure-ish; inject a `runGh` seam for tests.)
- **Edit:** `src/tools/delegateTool.ts` — add the `auto` mode (depth-guarded).
- **Edit:** `docs/delegation-workflow.md` + `CLAUDE.md` — make `delegate auto` the
  documented path; mark `scripts/delegate.sh`/`delegate-finish.sh` deprecated → deleted
  after a live end-to-end run.
- **New tests:** `test/delegate-auto.test.ts`, `test/adversarial/delegate-pr-gate.test.ts`.

## Slices (each red-seed → impl, independently landable)
1. **`delegate pr`** — the applyable-gated PR opener (port `delegate-finish.sh`; seam over `gh`). Smallest, highest leverage: it makes "open a PR only if it passed the gates" a primitive.
2. **`delegate auto`** — chain plan → run → validate → pr; `--no-pr` stops after validate.
3. **`delegate` tool `auto` mode** — agent-callable, depth-guarded.
4. **Retire** `scripts/delegate.sh` + `delegate-finish.sh` (shim or delete) after a live e2e.

## Tests (RED first, no live model — use the existing seams)
- `runDelegatePr`: injected `validate` returns `applyable:false` → **no `gh` call**, non-zero exit; `applyable:true` → exactly one `gh pr create` with the verdict in the body.
- `runDelegateAuto`: injected plan/run/validate seams → on all-applyable, calls `pr` per worker; on a failing gate, opens **no** PR and surfaces the failing gate codes.
- Adversarial: a worker whose patch touches a forbidden path → `out_of_scope` → `auto` refuses the PR (proves the scope gate blocks autonomy, not just advises).
- Tool `auto` at `delegateDepth > 0` → refused (no nested autonomous delegation).

## Verification
- `npm run typecheck` clean; `npm run test:phase` green with the new tests.
- **Live e2e (the acceptance):** `deepcoder delegate auto "<small bounded task>"` →
  observe it create a branch/worktree, drive a worker to green, run the gates, and open
  a PR **iff** applyable — with no human git/shell steps. Then a deliberately-broken task
  (worker can't go green) → **no PR**, failing gates reported.

## Safety / invariants (do not weaken)
- **Never auto-merge** — `auto` stops at "PR opened"; merge stays human.
- **PR is gated on the real gates** — `validation.json.applyable`, not a bare `--check`
  exit. A green check that fails scope/non-vacuous/wiring opens no PR.
- **Branch-first** — the worktree is the boundary; master is never touched until merge.
- **Depth-guarded** — a delegated worker cannot launch `auto` (`delegateDepthFromEnv > 0`
  refuses; `runWorker` already refuses isolation-off at depth > 0).
- **Provider creds** via `buildWorkerEnv` allowlist; never on argv; never logged.
- Acceptance must not need a live model — every step has an injectable seam.
