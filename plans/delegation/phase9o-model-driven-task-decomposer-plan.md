# Phase 9O — Model-Driven Task Decomposer

## Context

Deepcoder already has delegation primitives:

- `buildPlan` (`src/delegate/planner.ts`) — a **heuristic, deterministic, no-model** splitter that
  infers file boundaries from the task *text* and produces 1–5 sequential workers. It is
  deliberately conservative: when it cannot infer safe boundaries it collapses to **one** worker.
- The orchestrator (`src/delegate/orchestrator.ts`) runs runnable workers in dependency order and
  detects file conflicts.
- `runWorker` + the **9N verify-then-force** gate (`src/delegate/verify.ts`) accept a finished
  one-pass patch by proving tests-red-on-baseline → green-on-full + scope; **9M** can force a
  red-test-per-deliverable when a worker under-delivers.
- The **explorer** subagent (Phase 9E) produces a bounded `contextBrief`.

What is missing was exposed by Phase 10F: a single *cohesive* feature that touches ~10 files does
**not** one-pass (gemini and DeepSeek both ran out of attempts at partial), and the heuristic
`buildPlan` cannot decompose it — it has no semantic understanding, so it produces one giant worker
(exactly the one-pass that fails). The plan's own `10F.1…10F.5` rollout was written **by a human**.

This phase adds a **model-driven decomposer**: a reasoning model proposes a dependency DAG of
**bounded, individually verifiable** sub-tasks; each sub-task runs through verify-then-force; the
sub-task patches assemble in dependency order with a final no-regression gate. The model only
*proposes structure* — it never executes, never gains tools, and every sub-task still passes the
existing scope/classifier/apply gates.

## Goals

- Turn one large task into a validated DAG of bounded sub-tasks (`DecompositionPlan`).
- Each sub-task is **independently verifiable**: declared `deliverables` + a test target so the 9N
  verify gate (and 9M forcing on failure) applies per sub-task.
- Run sub-tasks in dependency order, assembling onto a cumulative base; final full-check gate.
- The model proposes structure only; all safety/scope/permission gates are unchanged.
- Deterministic, no-model acceptance (injected model + worker seams).

## Non-goals

- No automatic model/cost-based routing of sub-tasks (use the `plan` role for generation, `delegate`
  for execution — see Phase 10F).
- No parallel speculative execution of conflicting sub-tasks (respect file-conflict detection).
- No editing of a sub-task's patch in place; a failed sub-task escalates (9M) or surfaces, it is not
  silently rewritten.
- No new permissions; routing/decomposition never changes tool gating.

## Design

### 1. Decomposition model (`src/delegate/decompose.ts`)

```ts
export interface SubTaskSpec {
  id: string;                 // safe id (assertSafeId)
  title: string;
  goal: string;               // what this sub-task must achieve
  deliverables: WorkerDeliverableSpec[];  // reuse 9M — drives per-sub-task verify/force
  allowedPaths: string[];     // bounded scope (validated ⊂ repo, non-sensitive)
  testCommand?: string;       // focused test target for the 9N/9M gate
  dependsOn: string[];        // ids of sub-tasks that must land first
  checkName: string;          // configured check (must exist)
}

export interface DecompositionPlan {
  task: string;
  subtasks: SubTaskSpec[];
  source: "model" | "heuristic";
  warnings: string[];
}
```

### 2. Generation — `proposeDecomposition(task, ctx, deps)` (model seam)

- Inputs: the task, an optional `contextBrief` (reuse the 9E explorer), the configured check names.
- Calls the **`plan` role** model (reasoner; `config.reasonerModel`, or via the Phase 10F router when
  present) with **no tools** to emit a *structured* `DecompositionPlan` (JSON, schema-validated).
- `deps.generate` is an **injected seam** so tests drive a fixed decomposition with no live model.
- The model's output is **data, never code**; it is parsed + validated, never executed.

### 3. Validation + repair — `validateDecomposition(plan, config)` (PURE)

Reject/repair model output that is unsafe or unverifiable:
- bounded sub-task count (e.g. ≤ 12); each `id` via `assertSafeId`, unique.
- `allowedPaths` non-empty, each within the repo and **not** sensitive/generated (reuse
  `isSensitivePath` / the generated-path rules); paths bounded.
- `checkName` exists in `config.checks`.
- **Every sub-task is verifiable**: ≥1 `deliverable` AND a `testCommand` (else it cannot be 9N/9M
  gated) — a non-verifiable sub-task is rejected (no "trust me" sub-tasks).
- dependency ids resolve; **no cycles** (reuse `detectCycle`); topological order exists.
- file-scope overlap across *independent* (non-dependent) sub-tasks is flagged (reuse
  `detectFileConflicts`) — overlapping scopes must be serialized via `dependsOn`.
- On unrecoverable invalidity → fall back to the heuristic `buildPlan` (never block).

### 4. Execution + assembly — `runDecomposition(...)` (orchestration)

- Topologically order sub-tasks; for each (respecting `dependsOn`):
  - run it through **verify-then-force** against a **cumulative base** = real HEAD + already-landed
    sub-task patches (so a later sub-task sees earlier ones).
  - accept only if the 9N verify gate passes (scope + tests red→green); on shortfall, escalate to the
    9M forcing loop for *that* sub-task; if still failing → stop, surface the sub-task + its gate
    output (do **not** silently continue).
- **Assembly**: concatenate accepted sub-task patches in dependency order; apply to a fresh worktree;
  run the **full configured check** (no-regression gate). Only a green assembly is presentable to the
  existing `applyWorker`/review path. A red assembly is reported, never auto-applied.

### 5. CLI

- `/delegate plan --smart <task>` → `proposeDecomposition` + `validateDecomposition`; prints the DAG
  (bounded, deterministic render) **without executing**.
- `/delegate decompose run <plan-id>` → `runDecomposition` (keeps depth/TTY/confirm gates).
- Plain `/delegate plan` stays the heuristic path.

## Reuse (do not reinvent)

- `WorkerTask`/`DelegationPlan`/`WorkerDeliverableSpec` types; `detectCycle`; the orchestrator's
  dependency ordering + `detectFileConflicts`.
- `runWorker` + `verify.ts` (9N) + `runWorkerTdd`/coverage (9M) for per-sub-task accept/force.
- `assertSafeId`, `validatePatch`, `isSensitivePath`, the explorer `contextBrief` (9E).
- The `plan` role (Phase 10F router) / `config.reasonerModel` for generation.

## Security

- The model proposes **structure only**; it executes nothing and gains no tools.
- Every sub-task still passes scope (`validatePatch`), classifier, sensitive-path, and TTY/apply
  gates — decomposition cannot widen permissions or reach sensitive paths.
- Model-proposed `allowedPaths` are validated ⊂ repo and non-sensitive before any worker runs.
- Generation runs the `plan` role with **no tools** (cannot act during planning).
- Untrusted-workspace config follows existing trust behavior; a decomposition implying a new
  provider/egress is inert until trusted.

## Files

New:
- `src/delegate/decompose.ts` — model (types), `proposeDecomposition` (seam), `validateDecomposition`
  (pure), `runDecomposition` (orchestration), assembly.
- `src/delegate/decomposePrompts.ts` — the generation prompt + output schema.
- `test/adversarial/delegate-decompose.test.ts`.

Edit:
- `src/cli/slashCommands.ts` — `/delegate plan --smart`, `/delegate decompose run`.
- `src/delegate/types.ts` — only if decomposition types should live centrally.
- `ROADMAP.md`.

## Tests (no live model — injected generate + worker/verify seams)

1. `validateDecomposition` rejects a **cycle** in `dependsOn`.
2. rejects an **over-count** decomposition (> bound).
3. rejects a sub-task whose `allowedPaths` escape the repo or hit a sensitive/generated path.
4. rejects a **non-verifiable** sub-task (no deliverable / no testCommand).
5. rejects an unknown `checkName`; rejects duplicate/unsafe ids.
6. flags overlapping scope between independent sub-tasks (must be serialized).
7. a valid model decomposition parses and topologically orders.
8. malformed model JSON → fall back to heuristic `buildPlan` (warning, never throw).
9. `runDecomposition` runs sub-tasks in dependency order against the cumulative base (call order).
10. a sub-task failing 9N verify escalates to 9M forcing; still-failing → stop + surface (no silent continue).
11. assembly applies sub-task patches in order; a **full-check-red** assembly is reported, never auto-applied.
12. `/delegate plan --smart` renders the DAG bounded/deterministic and **executes nothing**.

## Rollout

- **9O.1** — types + `proposeDecomposition` seam + `decomposePrompts` (generation only, no exec).
- **9O.2** — `validateDecomposition` (pure) + heuristic fallback + `/delegate plan --smart` render.
- **9O.3** — `runDecomposition`: per-sub-task verify-then-force on the cumulative base, dependency order.
- **9O.4** — assembly + full no-regression gate; failed-sub-task surfacing/escalation.
- **9O.5** — `/delegate decompose run`, telemetry, ROADMAP.

## Acceptance

- A large task yields a **validated, acyclic, individually-verifiable** sub-task DAG; an invalid model
  output never blocks (falls back to heuristic).
- Sub-tasks run in dependency order through verify-then-force; assembly gates on the full check; a red
  assembly is never auto-applied.
- The model never executes and never widens permissions/scope.
- `npm run typecheck` and `npm run test:phase` pass (no live model in acceptance).

## Open questions

- Should the assembly present **one** combined patch to `applyWorker`, or apply sub-tasks as
  independent reviewable workers under one plan id?
- Should a failed sub-task auto-retry with a refined sub-spec (model repair loop) or always surface?
- How deep should re-decomposition go (a sub-task that itself fails to one-pass → recursive decompose)?
- Should `--smart` reuse the 10F `plan` role explicitly, or fall back to `reasonerModel` until 10F lands?
