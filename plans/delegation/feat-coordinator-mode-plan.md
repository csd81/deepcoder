<!-- adapted-from: system-prompts/agent-prompt-batch-slash-command.md -->
# Feature — Coordinator mode (multi-round coordinator/worker orchestration)

## Context

Today delegation is **one round, no re-plan**. `/delegate plan` builds a worker
graph (`src/delegate/planner.ts`); `runRunnable` / `runRunnableConcurrent`
(`src/delegate/orchestrator.ts:158,450`) run runnable workers once each in
runner-owned isolated worktrees and **never apply** (`workerRunner.ts:226` —
"NEVER applies the patch"); apply is human-gated through `applyWorker`
(`src/delegate/apply.ts:116`, 8 fail-closed gates). `/delegate autopilot`
(`src/delegate/autopilot.ts:328`) already loops `maxRounds` times — but each
round only re-runs workers that were already in the static plan
(`autopilot.ts:332` recomputes *runnable*, not *new*), defaults `autoApply=false`
and stops (`feat-master-delegation-workflow.md`: "a delegation never integrates
itself"). There is no path where a **coordinator agent** inspects collected
diffs/check output and *decides the next round's tasks*.

Workers ARE write-capable — they mutate files inside a runner-owned git worktree
(`workerRunner.ts:264` → `createIsolatedWorkspace`; `gitWorktree.ts:34`) and the
runner extracts a patch. (In-process subagent `profiles.ts:8` are read-only;
that is a different mechanism and unchanged here.) Nested delegation is refused
(`workerRunner.ts:228`, depth>0) — the coordinator must be the top-level process.

Coordinator mode = a sustained **plan → assign → collect → integrate → re-plan**
loop on top of the existing orchestrator + autopilot, where the coordinator is a
model turn between rounds that proposes the next batch from what the last round
produced. This **extends** `[[phase9i-concurrent-subagent-orchestration-plan]]`
(batching/conflict detection) and `[[feat-master-delegation-workflow]]` (the
router + "no auto-merge" invariant); it does **not** duplicate them.

## Model

- A `CoordinatorRound` = `{ round, plannedWorkerIds, ran, integrated, deferred,
  coordinatorNote }`. A `CoordinatorSession` accumulates rounds + the live plan.
- Between rounds the **coordinator turn** receives a compact digest (per-worker
  pass/fail, changed files, conflicts, check summaries — NOT raw diffs) and emits
  a `CoordinatorDecision`: `nextWorkers: WorkerTask[]` (added to the plan) and
  `integrate: workerId[]` (passed workers it wants merged this round).
- Integration is **review-before-merge**: each `integrate` id flows through the
  unchanged `applyWorker` gate chain (`apply.ts:116`). The coordinator can
  *propose* a merge; it can never bypass a gate. `autoApply` stays default-off.
- Termination: no new/runnable workers, `maxRounds` hit, or coordinator emits
  `done`. Stop-on-conflict honored via existing `OrchestrationResult.conflicts`.

## Design

A new pure loop `src/delegate/coordinator.ts`, modeled on `autopilot.ts`
(injected seams, no live model in tests):

```ts
export interface CoordinatorSeams {
  runWorkers: typeof runRunnableConcurrent;     // orchestrator.ts:450 (reused)
  validateWorker: typeof loadAndValidateWorker; // validation.ts (reused)
  applyWorker: typeof applyWorker;              // apply.ts:116 (reused, gated)
  coordinatorTurn(digest: RoundDigest): Promise<CoordinatorDecision>; // model seam
}
export async function runCoordinator(input: CoordinatorInput): Promise<CoordinatorResult>;
```

Loop body (per round, extends `autopilot.ts:328`):
1. `runRunnableConcurrent(plan, {maxConcurrency, stopOnFirstFailure})` — workers
   run in isolated worktrees, produce patches (orchestrator unchanged).
2. Build `RoundDigest` from `OrchestrationResult` + per-worker `run.json`
   (`orchestrator.ts:424` `getWorkerChangedFiles`) — bounded, redacted via
   `redactSecrets` (as autopilot does, `autopilot.ts:27`).
3. For each `decision.integrate` id: call `applyWorker(...)` with the plan's
   `globalChecks`/`requireQualityGate` (review-before-merge; failures reported,
   not reverted — same as autopilot).
4. Append `decision.nextWorkers` to `plan.workers` (validate ids via
   `assertSafeId`, reject dup ids, reject cycles via `topoOrder`), `savePlan`.
5. Persist `coordinator.json` next to `autopilot.json`
   (`.deepcoder/delegations/<plan-id>/coordinator.json`).

The coordinator turn reuses the model router/pool (NOT a hardcoded model — see
`feat-master-delegation-workflow.md` "Fictional APIs"). Each worker keeps its own
worktree, so write-capable workers stay isolated; the coordinator only ever sees
patches/digests, never a shared mutable tree.

### CLI surface
`/delegate coordinate <task>` (alias `/coordinate`) in `slashCommands.ts` near the
`"delegate"` case (`slashCommands.ts:1494`): build the seed plan, then
`runCoordinator`, rendering a per-round status table (reuse `reviewRender.ts`).
Flags mirror autopilot: `--max-rounds`, `--max-concurrency`, `--auto-apply`
(default off, prints a warning), `--dry-run`.

## Files to change
- **New:** `src/delegate/coordinator.ts`, `test/delegate-coordinator.test.ts`.
- **Edit:** `src/cli/slashCommands.ts` (add the `coordinate` subcommand under
  `delegate`); `src/delegate/types.ts` (add `CoordinatorRound`,
  `CoordinatorDecision`, `CoordinatorSession`, `RoundDigest`).
- **Reuse, do not modify:** `orchestrator.ts`, `workerRunner.ts`, `apply.ts`,
  `validation.ts`, `gitWorktree.ts`.

## Tests (RED first — injected seams, no live model, no real subprocess)
`test/delegate-coordinator.test.ts` (mirror `autopilot` tests):
- Multi-round: round 1 runs seed workers; `coordinatorTurn` returns
  `nextWorkers`; round 2 runs ONLY the newly added workers. (the new capability)
- `integrate` flows through `applyWorker` — a worker with `checkPassed=false` is
  refused at the gate, status never becomes `applied`. (review-before-merge)
- `auto-apply` default off: nothing is applied unless `integrate` is emitted AND
  the gate passes; assert the real repo is untouched on the default path.
- A `nextWorkers` entry that introduces a cycle (`topoOrder` throws) → round
  aborts with a clear message, plan not corrupted.
- Termination: coordinator `done` / no runnable workers / `maxRounds` each stop
  the loop and write `coordinator.json`.
- Conflict from `OrchestrationResult.conflicts` is surfaced in the digest and the
  conflicting workers are NOT auto-integrated.
- Nested-delegation guard: with `DEEPCODER_DELEGATE_DEPTH>0`, `runCoordinator`
  refuses (reuse `delegateDepthFromEnv`, `workerRunner.ts:62`).

## Verification
1. `npm run typecheck` clean; `npm run test:phase` green WITH the new tests
   (zero new tests = vacuous pass).
2. Manual (TUI): `/delegate coordinate "<small multi-file task>"` runs ≥2 rounds,
   shows the round table, and lands nothing without an explicit integrate +
   gate pass; `git status` clean afterward unless a gated apply ran.

## Safety
- **Isolated workers:** every worker mutates only its own runner-owned worktree
  (`workerRunner.ts:264`); the coordinator sees patches/digests, never a shared
  tree. No worker can touch another's files or the real repo.
- **Review-before-merge:** integration is the unchanged `applyWorker` chain
  (`apply.ts:116`) — patch re-validation, `git apply --check`, TTY gate, confirm,
  global checks. The coordinator *proposes*; it cannot bypass a gate. `auto-apply`
  is opt-in and warns. This preserves the `[[feat-master-delegation-workflow]]`
  "a delegation never integrates itself" invariant by default.
- **No nested delegation:** coordinator refuses to run as a delegated child
  (depth>0). Conflicting workers are never auto-integrated.

## Worker contract notes
- **TDD:** write the failing `test/delegate-coordinator.test.ts` cases (esp. the
  round-2-only-runs-new-workers and the gated-integrate refusal) BEFORE
  `coordinator.ts`. A green `--check phase` with zero new tests is a vacuous pass.
- **Reuse isolation + orchestrator:** call `runRunnableConcurrent` and
  `applyWorker` verbatim through seams — do NOT re-implement worktree creation,
  patch extraction, or the apply gates. Do NOT add a `merge` that skips the gate
  chain (see `[[feat-master-delegation-workflow]]` "Auto-merge is unsafe").
- Position relative to `[[phase9i-concurrent-subagent-orchestration-plan]]`
  (batching/conflict reused as-is) and `[[feat-batch-command-plan]]` (the
  user-facing background-agent batch UX; coordinator is the in-process loop). The
  coordinator turn must go through the model router/pool, never a hardcoded model.
