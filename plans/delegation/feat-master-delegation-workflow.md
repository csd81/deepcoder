# Feature — Task-routing front-end for delegation (`/delegate full`)

## ASSESSMENT (2026-06-23) — original plan rewritten

The original plan proposed a full master orchestrator (`taskClassifier` →
`workAssigner` → `dispatchWorkers` → `superagentReview` → `mergeCoordinator`).
Verified against the code, most of it is **redundant** and one part is **unsafe**:

- **`/delegate autopilot` already is the master workflow.** `src/delegate/autopilot.ts`
  `runAutopilot()` does `buildPlan`/`decompose` → `runWorkers` → `validateWorker`
  (incl. the embedded quality gate) → `applyWorker` → `runCheck`, across rounds,
  configured by `DelegateAutopilotConfig` (maxRounds/maxWorkers/maxConcurrency/
  acceptanceFirst/autoApply/stopOnConflict).
- **3 of the 4 proposed modules duplicate existing code:** `workAssigner` ≈
  `decompose.ts`+`planner.ts`; `superagentReview` ≈ the existing `WorkerQualityGate`
  (reviewer-profile subagent, `validation.ts` Gate 6); `mergeCoordinator` ≈
  `apply.ts`/`autoApply.ts`.
- **Auto-merge is unsafe.** autopilot defaults `autoApply=false` and *stops and
  reports*; `delegate.sh` documents "a delegation never integrates itself — landing
  is human-gated (verify-then-force, then commit/merge by hand)." The proposed
  `mergeCoordinator.git.merge(...)` regresses that invariant. **Dropped.**
- **Fictional APIs:** `runWorker({provider,taskFile,branch,attempts})` is not the
  real signature (`runWorker(RunWorkerInput)` runs a stored plan/worker-id);
  hardcoded `provider.chat({model:"deepseek-v4-pro"})` bypasses the model router/pool.

**Empirical justification for the one kept idea (the classifier):** running deepcoder
(flash) on the wiring audit with a NEUTRAL prompt produced **0** `delegate` calls,
169 messages of single-threaded grinding, and a thin final report; the SAME task with
an explicit "use subagents" nudge produced 6 `delegate` calls, 94 messages, and a full
report. The model does NOT self-route to delegation — so a built-in router that picks
the right strategy is genuinely valuable. Everything else already exists.

## Revised scope — a thin router over existing machinery

`/delegate full <task>` (alias `/orchestrate`) = classify the task, then hand off to
the EXISTING command best suited to it. No new orchestration, no new review, no merge.

### 1. Task classifier (`src/delegate/taskClassifier.ts`) — the only new module

```ts
export type TaskCategory = "research" | "simple-edit" | "multi-file";
export interface ClassifiedTask {
  category: TaskCategory;
  reason: string;            // one line, shown to the user
  suggestedFiles?: string[]; // best-effort, advisory
}
export async function classifyTask(
  task: string,
  deps: { provider: ModelProvider; model: string; index: RepoIndex },
): Promise<ClassifiedTask>;
```

- One fast (flash) model call → strict JSON, parsed defensively (fail-safe to
  `research` so the safest path is the default on parse failure).
- Pure-ish: the model call is injected so the classifier is unit-testable with a
  fake provider (no live model in tests — matches the eval-design rule).

### 2. Router (in the `/delegate full` slash handler) — reuse, don't reinvent

| Category | Hands off to (EXISTING) | Mutates? |
|---|---|---|
| `research` | `runSubagentCommand(session, save, researcher, task)` | no |
| `simple-edit` | `runSolveCommand(session, { task, checkName: "phase", … })` | yes, single-threaded, gated |
| `multi-file` | `runAutopilot({ task, config: session.config.delegate.autopilot, … })` | yes, **autoApply=false → stops & reports** |

The handler just prints the classification, confirms with the user for the mutating
paths, and delegates. It does NOT apply or merge anything — autopilot already ends at
"validated, ready for human apply" by default.

### 3. Files

- **New:** `src/delegate/taskClassifier.ts`, `test/delegate-task-classifier.test.ts`.
- **Edit:** `src/cli/slashCommands.ts` — add the `full` subcommand to the existing
  `delegate` handler (next to `autopilot`); `src/cli/slashCatalog.ts` — catalog entry.

### 4. Tests (TDD, fake provider — no live model)

- classifier: "explain the auth module" → `research`; "fix the typo in main.ts" →
  `simple-edit`; "add logging to every HTTP handler" → `multi-file`.
- classifier fail-safe: malformed model JSON → defaults to `research` (safest).
- router (with seams): each category invokes the correct existing function exactly
  once with the task threaded through; `multi-file` never calls any apply/merge.

## Safety

- **No auto-merge / no auto-apply.** The mutating paths terminate at autopilot's
  default `autoApply=false` (stop & report) or a single gated `/solve` — landing stays
  human-gated, preserving "a delegation never integrates itself."
- Mutating categories prompt for confirmation before dispatch (skipped under an
  explicit non-interactive/yolo posture, same as today's commands).
- Classifier output is advisory; the user can override the chosen route
  (e.g. `/delegate full --as research <task>`).
- Reuses the existing permission model, quality gate, and validation pipeline
  unchanged — this feature adds routing, not new trust.

## Out of scope (deliberately dropped from the original)

- `workAssigner`, `superagentReview`, `mergeCoordinator` — duplicate `decompose`/
  `planner`, the existing quality gate, and `apply`/`autoApply` respectively.
- Auto-merge of worker branches — violates the human-gated-landing invariant.
- "Shared worktree" parallel mutation — the real model is one isolated worktree per
  worker (workerRunner); shared mutation reintroduces the write-conflict it avoids.
- A bespoke superagent on `deepseek-v4-pro` via raw `provider.chat` — model selection
  goes through the existing router/pool; review goes through the existing quality gate.
