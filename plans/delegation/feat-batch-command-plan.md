# Feature — `/batch` slash command (decompose → fan out → status)

## Context

The internal worker-batching engine already exists end-to-end. The model-driven
decomposer turns a goal into a validated, acyclic sub-task DAG
(`proposeDecomposition` in `src/delegate/decompose.ts:195`, validated by
`validateDecomposition` at `:45`). The orchestrator already schedules workers
into conflict-free parallel batches (`buildRunnableBatches`,
`src/delegate/orchestrator.ts:364`) and runs them concurrently with status
persistence, conflict detection, and dependent-skipping
(`runRunnableConcurrent`, `:450`). A single worker runs in an isolated worktree
via `runWorker` (`src/delegate/workerRunner.ts:226`).

What's missing is a **user-facing front door**. Today decomposition and
fan-out are split across `/delegate plan --smart` (decompose only, prints a
plan — `src/cli/slashCommands.ts:1536`) and `/delegate run --parallel`
(orchestrate an already-built `DelegationPlan` — `:2059`). `/batch <goal>`
unifies them: one command that decomposes, fans out through the **existing**
orchestrator, renders a live status table, and aggregates. This is the
single-session sibling of coordinator mode — see [[feat-coordinator-mode-plan]]
(coordinator is the always-on multi-agent loop; `/batch` is a one-shot,
human-invoked fan-out reusing the same engine).

## Model

`/batch <goal>` — one positional goal plus the run-all flags `/delegate run`
already parses (`--parallel` default ON for batch, `--max-concurrency <n>`,
`--tdd`). It performs four steps, no new scheduler:

1. **Decompose** the goal with `proposeDecomposition` (model, heuristic
   fallback).
2. **Convert** the `DecompositionPlan` to a `DelegationPlan` and `savePlan`.
3. **Fan out** runnable workers via `runRunnableConcurrent` (the existing batch
   engine), streaming `onUiEvent` into a live status table.
4. **Aggregate**: print final ran/skipped/conflict summary as "N/M sub-tasks
   passed", echoing the source prompt's Phase-3 contract.

## Design

A thin layer over real code. Reused, unchanged: `proposeDecomposition`,
`runRunnableConcurrent`, `buildRunnableBatches`, `runWorker`. New glue is one
pure converter plus a `case "batch"` in the command switch.

### New: `src/delegate/batchPlan.ts` — `SubTaskSpec[] → DelegationPlan`
The orchestrator operates on `DelegationPlan`/`WorkerTask`
(`src/delegate/types.ts:26,93`), but the decomposer emits `SubTaskSpec`
(`decompose.ts:16`). One pure, tested converter bridges them:
```ts
export function planFromDecomposition(d: DecompositionPlan): DelegationPlan {
  const workers: WorkerTask[] = d.subtasks.map((st) => ({
    id: st.id, title: st.title, prompt: st.goal,
    allowedPaths: st.allowedPaths, forbiddenPaths: ["node_modules", ".deepcoder"],
    checkName: st.checkName, maxAttempts: 3, dependsOn: st.dependsOn,
    expectedOutputs: [], status: "planned",
    deliverables: st.deliverables, tdd: st.testCommand ? { required: true, testCommand: st.testCommand } : undefined,
  }));
  return { id: newPlanId(), task: d.task, createdAt: new Date().toISOString(),
    status: "planned", workers, dependencies: depsFrom(d.subtasks),
    globalChecks: [], riskNotes: d.warnings };
}
```
`allowedPaths` carries straight through, so `workerLockSet`
(`orchestrator.ts:302`) gives the batcher real path scopes to dedupe on —
independent sub-tasks run in the same batch, dependents serialize. Reuse
`newPlanId` from `src/delegate/planner.ts`.

### New: `case "batch"` in `src/cli/slashCommands.ts`
Modeled on `/delegate plan --smart` (`:1536`, for the decomposer `deps.generate`
+ `DECOMPOSE_PROMPT` wiring) and `/delegate run --parallel` (`:2049`, for
`mainEntry`, `resolveDelegateOverride`, `AbortController`, the nested-depth +
non-interactive guards at `:1888`/`:1895`, and the `runRunnableConcurrent`
call). Sketch:
```ts
case "batch": {
  if (!arg.trim()) { console.log(chalk.dim("usage: /batch <goal>")); return { consumed: true }; }
  const depth = delegateDepthFromEnv(process.env);
  if (depth > 0) { /* refuse nested — same guard as :1888 */ return { consumed: true }; }
  if (!isInteractive) { /* refuse — same guard as :1895 */ return { consumed: true }; }
  const decomp = await proposeDecomposition(goal, {}, deps, { checks: Object.keys(config.checks), maxSubTasks: 12 });
  const plan = planFromDecomposition(decomp);
  await savePlan(root, plan);
  // render initial table; then fan out, updating rows on onUiEvent
  const res = await runRunnableConcurrent(plan, {
    realRoot: root, signal: ac.signal, mainEntry, provider: config.provider,
    modelOverride: resolveDelegateOverride(session), delegateDepth: depth,
    maxConcurrency, onUiEvent: (e) => renderRow(e),
  });
  // aggregate: ran/skipped/conflicts → "N/M sub-tasks passed"
}
```
The status table reuses the column/coloring style of `/delegate status`
(`:1678`): `id | status | check | title`, capped/truncated. Rows flip on
`worker_start` (→ running, yellow) and `worker_done` (→ passed/failed) events
emitted by `runRunnableConcurrent` (`orchestrator.ts:222,232`).

## Files to change
- **New:** `src/delegate/batchPlan.ts` (`planFromDecomposition` + `depsFrom`).
- **New:** `test/batch-command.test.ts` (converter + status-render units).
- **Edit:** `src/cli/slashCommands.ts` — add `case "batch"` near the `/delegate`
  case (`:1494`); import `proposeDecomposition`, `planFromDecomposition`,
  `runRunnableConcurrent` (already imported, `:102`).
- **Edit:** help/usage listing wherever slash commands are enumerated (grep the
  switch for the help text block) — add `/batch <goal>`.

## Tests (RED first)
`test/batch-command.test.ts` (pure, no spawned process — mirror the converter
focus of `test/adversarial/delegate-decompose.test.ts`):
- `planFromDecomposition` maps every `SubTaskSpec` field → `WorkerTask`
  (`prompt=goal`, `allowedPaths`, `checkName`, `dependsOn`, `status:"planned"`).
- A `testCommand` sub-task produces `tdd.required:true` + `tdd.testCommand`.
- `dependsOn` round-trips so `topoOrder`/`buildRunnableBatches` (`orchestrator.ts`)
  serialize a dependent after its dep, and place two independent sub-tasks with
  disjoint `allowedPaths` into the SAME batch (assert on `buildRunnableBatches`).
- Two sub-tasks with overlapping `allowedPaths` land in DIFFERENT batches
  (lock conflict) — proves fan-out respects path scopes.
- Status render: a `worker_start`/`worker_done` pair flips a row planned→running
  →passed (extract the row renderer so it's unit-testable).
- Aggregation counts ran-passed / ran-failed / skipped correctly into "N/M".

## Verification
1. `npm run typecheck` clean; `npm run test:phase` green with the NEW tests.
2. Manual (interactive TUI): `/batch add a CHANGELOG and a license header script`
   → prints a decomposition, fans out workers in parallel, renders a live
   status table, ends with "N/M sub-tasks passed" and a conflicts list if any.
   Confirm the live repo is untouched (patches are reviewed via
   `/delegate review`, not auto-applied).

## Safety
- **No new scheduler, no new spawn path.** Fan-out goes through
  `runRunnableConcurrent` → `runWorker`, which keeps every existing gate:
  isolated runner-owned worktrees, the strict env allowlist + forced posture
  (`buildWorkerEnv`, `workerRunner.ts:96`), and **never applies patches**.
- **Nested-delegation refusal**: reuse the `delegateDepthFromEnv > 0` guard
  (`slashCommands.ts:1888`) — a worker cannot run `/batch`. `runWorker` also
  refuses at depth > 0 (`workerRunner.ts:228`) as defense in depth.
- **Interactive-only**: refuse in non-interactive sessions, like `/delegate run`
  (`:1895`), since it spawns live workers.
- `validateDecomposition` (`decompose.ts:45`) already rejects out-of-repo /
  sensitive `allowedPaths`, cycles, and non-verifiable sub-tasks before any
  worker spawns; conflicts between independent sub-tasks surface as warnings and
  the batcher serializes overlapping path scopes.

## Worker contract notes
- TDD: write the failing `test/batch-command.test.ts` cases FIRST, then
  `batchPlan.ts` + the `case`. Green `--check phase` with ZERO new tests is a
  vacuous pass.
- REUSE the orchestrator: do not reimplement batching, topo-sort, conflict
  detection, or spawning. `/batch` is decompose + convert + call
  `runRunnableConcurrent` + render. New code is the converter and the command
  glue only.
- Keep `planFromDecomposition` PURE (no IO) so it's exhaustively unit-testable
  without a model or a worktree — the `case` does the IO (`savePlan`, spawn).
- Relationship to [[feat-coordinator-mode-plan]]: both ride the same engine;
  `/batch` is the one-shot manual entry, coordinator the autonomous loop. Keep
  the converter in `batchPlan.ts` so coordinator mode can reuse it.
