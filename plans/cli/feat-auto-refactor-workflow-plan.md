# feat: auto-refactor workflow — `deepcoder refactor`

## Context

deepcoder can already delegate a *task* across isolated git worktrees and open
PRs (`deepcoder delegate plan|run|validate|apply|pr|auto`). What was missing is a
**refactor-shaped** front door: the user shouldn't hand-write a task or file list —
the tool should auto-discover repo structure, draft a per-area refactor plan, fan
each area out into its own worktree, and open a PR only when the change is provably
behavior-preserving and the suite is green. The PR is the review gate; nothing
auto-merges.

The key realization: this is **not new enforcement** — it's a specialization of the
delegate pipeline. The 9-gate validator (`validateWorkerResult`,
`src/delegate/validation.ts`) already enforces scope, forbidden-paths, test-only
change, and a green check. The feature's job is to (a) add a deterministic
discovery→plan front-end, and (b) stamp WorkerTasks so those existing gates prove
behavior-preservation.

## Goal

A headless `deepcoder refactor plan|run|validate|pr|auto` that mirrors `delegate`,
fans out per area, and gates each PR on **behavior-preserving + `npm run test:phase`
green + the 9-gate validator**, never auto-merging.

## Design

**Compose delegate leaves; do NOT reuse `runDelegateAuto`** — `auto` forces
`plan({tdd:true})` (workers self-seed NEW red tests), the opposite of a
behavior-preserving refactor. Refactor composes `run → validate → pr` itself.

**Behavior-preserving = a structural stamp** (`src/refactor/toRefactorWorkers.ts`),
enforced by the existing gates:
- `forbiddenPaths += test/, tests/` → Gate 3 `forbidden_path` on any test edit.
- `requireProductionChange: true` → Gate 4 `test_only_change` on a no-op patch.
- `expectedFiles: [{path: <covering test>, mode:"must_not_change"}]` → Gate 4 freezes
  each covering test (from `relevantTests`).
- `checkName` = the green-suite check (`phase`) → Gate 2 proves the unchanged tests
  still pass in the isolated worktree.
- NO `tdd` / NO `requireValidatedTest` — never seed new tests.

Built the DelegationPlan **directly** rather than via `buildPlan`, whose text-based
area inference drops words < 4 chars (so `git`/`cli`/`lsp`/`web` would be lost);
discovery yields concrete `src/<area>` paths mapped 1:1, serialized to avoid
cross-area patch conflicts.

### Files

- **New** `src/refactor/discovery.ts` — `discoverStructure(root, deps?)` → groups
  `src/` code by area, attaching covering tests (`relevantTests`), fan-in
  (`impactedBy`), large files + duplicate symbols. Defaults to a fresh
  `buildRepoIndex(root,{symbols:true,imports:true})` (ensureIndex omits symbols);
  builder injectable. Never throws.
- **New** `src/refactor/refactorPlan.ts` — `buildRefactorPlan(structure)` →
  deterministic `RefactorPlan` (areas × candidates × risk). Candidate kinds derived
  structurally: `dedupe`/`extract-helper`/`split-module`. Zero-test area → high risk.
- **New** `src/refactor/toRefactorWorkers.ts` — `refactorPlanToDelegationPlan(plan,
  opts)` → behavior-preserving-stamped `DelegationPlan`.
- **New** `src/cli/refactorCli.ts` — `runRefactorPlan/Auto` (+ re-exported
  `runRefactorRun/Validate/Pr` = the delegate leaves) + `registerRefactorCommand`.
  (Named `refactorCli.ts` — `src/cli/refactor.ts` is the interactive `/refactor`.)
- **Edit** `src/cli/main.ts` — one line: `registerRefactorCommand(program)` beside
  the delegate/audit registrations.

Reuses: `runDelegateRun/Validate/Pr` (`src/cli/delegateCli.ts`), `savePlan`/`loadPlan`
(`src/delegate/store.ts`), `loadAndValidateWorker` (`src/delegate/validation.ts`),
`runWorker`/`buildWorkerEnv` (`src/delegate/workerRunner.ts`).

## Tests / Verification

All with fakes — no model, no real worktree, no `gh`.

- Unit: `test/refactor-discovery.test.ts`, `refactor-plan.test.ts` (determinism),
  `refactor-to-workers.test.ts` (the stamp), `refactor-cli.test.ts` (DI + exit codes
  + `registerRefactorCommand` registers `plan|run|validate|pr|auto`).
- Adversarial: `test/adversarial/refactor-behavior-preserving.test.ts` (real
  `validateWorkerResult`: test edit → `forbidden_path`, red suite → `check_failed`,
  empty → `empty_patch`, production-only → applyable), `refactor-never-merge.test.ts`
  (no merge seam; PR body carries "never auto-merge"), `refactor-worktree-isolation.test.ts`
  (disjoint allowedPaths, serialized chain, no apply step),
  `refactor-env-isolation.test.ts` (no secret forwarded; forced posture),
  `refactor-nested-refusal.test.ts` (`delegateDepth>0` → `WorkerRunError`, no spawn).

Gate: `npm run test:phase` green (904 unit + 2038 adversarial at landing).

## Edge cases

Dirty tree → worktree off committed HEAD (`includeDirty`); non-git repo → friendly
`git rev-parse` pre-flight (exit 2); no remote → `openPr` push fails (branch still
prepared; `--no-pr` stops at validated branches); 1-area inference → one worker, one
PR; cross-area conflict → validator overlap gate makes the loser non-applyable;
zero-test area → high-risk note surfaced; `phase` not configured → falls back to first
check with a riskNote.

## Out of scope

Auto-merge (the PR is the gate); model-driven refactor *planning* (the plan is
deterministic from the index — only the worker's edits use the model); cross-area
aggregate single-PR mode (currently one PR per area).
