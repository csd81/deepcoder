# Deepcoder Phase 9I - Concurrent Subagent Orchestration

## Context

Phase 9 gives Deepcoder a delegated-worker model:

- `src/delegate/planner.ts` creates bounded worker tasks.
- `src/delegate/workerRunner.ts` runs one worker in a runner-owned isolated
  worktree and produces a patch artifact.
- `src/delegate/patchValidator.ts` and `src/delegate/apply.ts` gate patch apply.
- `src/delegate/orchestrator.ts` currently provides pure graph helpers and
  `runRunnable(...)`, which runs runnable workers sequentially.

That sequential model is safe and easy to reason about, but slow for large
refactors where independent workers could run at the same time.

Phase 9I adds concurrent orchestration: run multiple independent delegated
workers simultaneously while preserving the existing safety model:

```text
plan graph
  -> dependency-ready workers
  -> disjoint-path batches
  -> parallel runner-owned isolated worktrees
  -> patch artifacts
  -> conflict detection
  -> review/apply remains explicit
```

## ROI

Medium-low.

Why it helps:

- large refactors with independent slices finish much faster,
- slow model calls/checks overlap,
- the parent can collect several patches before review.

Why it is not first-priority:

- multi-process lifecycle is harder than sequential workers,
- race conditions move from file edits to patch/apply scheduling,
- branch/path locks must be correct,
- debugging concurrent logs is more complex,
- most current benchmark tasks are still small enough that sequential is fine.

## Goal

Enhance `src/delegate/orchestrator.ts` so it can run independent workers in
parallel batches, with bounded concurrency and explicit path/branch locking.

The live repo must still never be edited by worker execution. Parallelism only
spawns multiple isolated worker runs; patch apply remains a separate reviewed
step.

## Non-Goals

- Do not auto-apply worker patches.
- Do not run dependent workers before dependencies are applied.
- Do not allow two workers with overlapping expected write scopes to run in the
  same batch.
- Do not implement distributed workers or remote machines.
- Do not add nested delegation.
- Do not require live model tests for acceptance.

## Current Sequential Behavior

`runRunnable(plan, opts)`:

- topo-sorts workers,
- finds workers with status `planned|failed` and all deps `applied`,
- runs them one by one,
- updates worker status after each run,
- skips transitive dependents after failures,
- reports changed-file conflicts after the fact.

This is the right baseline. Phase 9I adds a new parallel path while keeping
sequential behavior as the default fallback.

## Design Principles

1. **Batch by dependency frontier**: only workers whose dependencies are already
   `applied` can enter the same wave.
2. **Pre-run scope locks**: workers with overlapping expected write scopes do not
   run concurrently.
3. **Post-run conflict detection**: actual changed files can still surprise us;
   detect and mark conflicts after each batch.
4. **Bounded concurrency**: default low, configurable, never unbounded.
5. **Independent worktrees**: each worker gets its own runner-owned isolated
   worktree.
6. **Patch-only result**: running a worker never mutates the live repo.
7. **Deterministic scheduling**: same plan + same statuses -> same batches.
8. **Readable trace**: every worker's lifecycle is recorded with timestamps and
   log paths.

## New Concepts

### Worker Lock Set

Before running a worker, derive a conservative lock set:

```ts
interface WorkerLockSet {
  workerId: string;
  paths: string[];
  reasonByPath: Record<string, string>;
}
```

Inputs:

- `worker.allowedPaths`,
- `worker.expectedFiles` from Phase 9G,
- explicit future `worker.lockPaths` if added later,
- fallback: if no path scope exists, lock `"."` (serializes the worker).

Rules:

- exact same path conflicts,
- prefix relation conflicts (`src/foo` conflicts with `src/foo/bar.ts`),
- `"."` conflicts with everything,
- `forbiddenPaths` do not create locks; they are validation constraints.

### Batch

```ts
interface WorkerBatch {
  id: string;
  workerIds: string[];
  locks: WorkerLockSet[];
}
```

Workers in one batch:

- have all dependencies already `applied`,
- are runnable (`planned|failed`),
- have disjoint lock sets,
- are ordered deterministically by topo order / id.

### Parallel Orchestration Trace

Add run-level trace data:

```ts
interface OrchestrationTrace {
  planId: string;
  startedAt: string;
  finishedAt?: string;
  mode: "sequential" | "parallel";
  maxConcurrency: number;
  batches: {
    id: string;
    workerIds: string[];
    startedAt: string;
    finishedAt?: string;
  }[];
}
```

Persist under:

```text
.deepcoder/delegations/<plan-id>/orchestration.json
```

## API Changes

Add new pure helpers in `src/delegate/orchestrator.ts`:

```ts
export function workerLockSet(worker: WorkerTask): WorkerLockSet;

export function locksConflict(a: WorkerLockSet, b: WorkerLockSet): boolean;

export function buildRunnableBatches(
  plan: DelegationPlan,
  opts?: { maxConcurrency?: number },
): WorkerBatch[];
```

Add a new driver:

```ts
export interface RunConcurrentOptions extends RunRunnableOptions {
  maxConcurrency?: number;
  stopOnFirstFailure?: boolean;
}

export async function runRunnableConcurrent(
  plan: DelegationPlan,
  opts: RunConcurrentOptions,
): Promise<OrchestrationResult>;
```

Keep `runRunnable` unchanged as the sequential path.

## Scheduling Algorithm

1. Build topo order.
2. Compute runnable frontier:
   - status `planned|failed`,
   - all dependencies `applied`.
3. Deterministically pack frontier into batches:
   - iterate workers in topo/id order,
   - place a worker into the first batch where its locks do not conflict,
   - cap each batch at `maxConcurrency`,
   - if no batch fits, create a new batch.
4. Run each batch:
   - all workers in the batch start concurrently,
   - use `Promise.allSettled`,
   - each worker gets its own isolated worktree via `runWorker`,
   - save plan updates after each worker completion through a small serialized
     save queue to avoid concurrent writes corrupting the plan file.
5. After batch completes:
   - detect actual changed-file conflicts among the batch and previously passed
     unapplied workers,
   - mark conflicting workers `conflict`,
   - do not apply anything,
   - skip dependents of failed/conflict workers.
6. Continue to next batch only if there are still runnable workers and
   `stopOnFirstFailure` did not trigger.

## Plan Save Lock

Concurrent workers can finish at the same time. They must not call `savePlan`
against shared mutable plan state without coordination.

Add a tiny in-process save queue:

```ts
class PlanSaveQueue {
  private pending = Promise.resolve();
  enqueue(fn: () => Promise<void>): Promise<void>;
}
```

Use it inside `runRunnableConcurrent` so status updates and trace writes are
serialized.

This is not a cross-process lock; it only protects one orchestrator process. That
is enough for Phase 9I because one `/delegate run` owns the plan execution.

## Conflict Policy

### Pre-run conflicts

Workers with conflicting lock sets do not run in the same batch. They can still
run sequentially in later batches if their dependencies/status allow.

### Post-run conflicts

If actual changed files overlap:

- mark both workers `conflict`,
- keep their patch artifacts,
- do not apply either automatically,
- `/delegate review` surfaces the conflict,
- user can discard one and rerun the other.

### Already passed, unapplied workers

A newly passed worker conflicts with an existing passed-but-unapplied worker if
changed files overlap. The new worker should be marked `conflict` unless a later
policy explicitly lets the user choose a winner.

## CLI / UX

Extend `/delegate run`:

```text
/delegate run <plan-id> --parallel
/delegate run <plan-id> --parallel --max-concurrency 3
/delegate run <plan-id> <worker-id>   # still runs one worker
```

Default:

- keep sequential mode unless `--parallel` is provided,
- or config-gated default later after proving safety.

Status output:

```text
delegate run: parallel
max concurrency: 3
batch 1: worker-1, worker-3
batch 2: worker-2

worker-1 passed  changed: 2
worker-3 failed  changed: 0
worker-2 skipped depends on failed worker-3
```

## Config

Optional config block:

```json
{
  "delegate": {
    "parallel": false,
    "maxConcurrency": 2,
    "stopOnFirstFailure": false
  }
}
```

Initial implementation may keep config out and use CLI-only flags if config
plumbing would expand scope. The orchestration core should accept
`maxConcurrency` either way.

## Tests

No live model required. Use injected `runOne` seams.

### Pure helper tests

1. `workerLockSet` uses expected files / allowed paths.
2. empty scope locks `"."`.
3. exact path conflict detected.
4. prefix conflict detected.
5. disjoint paths do not conflict.
6. batch builder respects dependencies.
7. batch builder respects max concurrency.
8. batch builder is deterministic.

### Concurrent driver tests

1. two independent workers run concurrently (prove overlap with deferred
   promises and timestamps),
2. dependent worker waits until dependency is applied; if not applied, it is
   skipped,
3. failed worker blocks transitive dependents,
4. batch continues independent workers after one failure,
5. stop-on-first-failure stops later batches,
6. concurrent completions serialize plan saves,
7. post-run changed-file overlap marks conflict,
8. no live repo mutation; patches remain artifacts only,
9. abort signal cancels in-flight workers and marks unfinished workers failed or
   skipped,
10. trace file records batches, start/end, and worker IDs.

### CLI tests

If slash-command parsing is touched:

1. `/delegate run <plan> --parallel` calls concurrent path,
2. `/delegate run <plan>` keeps sequential path,
3. invalid `--max-concurrency` clamps/refuses,
4. non-TTY live worker spawning still refuses unless existing confirmation path
   is satisfied.

## Acceptance

Required:

```bash
npm run typecheck
npm run test:phase
```

No live model is required for merge.

Manual no-model smoke:

1. Create a plan with three fake workers:
   - two independent disjoint workers,
   - one dependent worker.
2. Inject fake `runOne` that sleeps and returns changed files.
3. Confirm independent workers overlap in time.
4. Confirm dependent worker is skipped until dependency is applied.
5. Confirm conflicts are reported, not applied.

Optional live smoke:

Run two very small independent workers with `--parallel --max-concurrency 2` and
verify:

- two isolated worktrees are created,
- two patch artifacts are produced,
- live repo remains unchanged,
- review/apply remains manual.

## Risks

### Race Conditions in Plan Persistence

Multiple workers finish at once and try to save the plan.

Mitigation:

- one orchestrator-owned save queue,
- no worker writes plan directly in concurrent mode except through the queue,
- tests with intentionally racing fake workers.

### Path-Lock False Negatives

A worker may change files outside its expected/allowed scope.

Mitigation:

- post-run changed-file conflict detection,
- existing patch validator on apply,
- future: mark out-of-scope changes as conflict immediately.

### Resource Contention

Multiple workers running checks can saturate CPU/disk/API budget.

Mitigation:

- default max concurrency 2,
- explicit CLI flag for higher,
- bounded worker timeouts already enforced by runner.

### Debuggability

Parallel logs are harder to read.

Mitigation:

- per-worker logs remain separate,
- live output should prefix chunks by worker ID,
- orchestration trace records batch boundaries.

### Apply Order

Parallel run order is not apply order.

Mitigation:

- apply remains explicit and one worker at a time,
- dependencies still require applied status,
- conflicts block apply until resolved.

## Implementation Order

1. Add pure lock-set and batch-building helpers.
2. Add tests for locks, conflicts, deterministic batching.
3. Add `PlanSaveQueue`.
4. Implement `runRunnableConcurrent` using injected `runOne`.
5. Add concurrent driver tests with fake workers.
6. Add orchestration trace persistence.
7. Wire `/delegate run --parallel --max-concurrency`.
8. Update `/delegate status` / `/delegate review` to surface conflicts and trace.
9. Document the feature in Phase 9 plan.
10. Run full gate.

## Definition of Done

- Independent workers can run concurrently in separate isolated worktrees.
- Workers with dependency or lock conflicts do not run concurrently.
- Concurrent plan updates cannot corrupt the saved plan.
- Post-run file conflicts are detected and marked.
- No patch is applied by the concurrent runner.
- Sequential behavior remains available and unchanged by default.
