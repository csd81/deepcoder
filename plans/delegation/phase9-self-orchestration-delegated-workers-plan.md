# Deepcoder Phase 9 - Self-Orchestration and Delegated Workers

## Goal

Let Deepcoder orchestrate bounded coding work by splitting a larger task into smaller worker tasks, running each worker in an isolated workspace, verifying each patch, and presenting an auditable merge plan.

Shape:

```text
user task
  -> parent planner creates worker task graph
  -> worker deepcoder runs in isolated worktree
  -> worker solve/check loop verifies its own patch
  -> parent collects patches + telemetry
  -> parent detects conflicts/scope violations
  -> parent applies approved patches only
  -> full gate verifies merged result
```

The first version is **not** autonomous auto-merge. It is a verified patch orchestration workflow with explicit apply/reject decisions. Auto-apply can come later for narrow low-risk cases.

## Why Now

Manual Claude-as-orchestrator worked for Phase 8D:

- parent split the work into small tasks,
- each worker ran Deepcoder in workspace isolation,
- `--solve --check phase` let the harness verify outside the model approval path,
- parent reviewed and merged.

Phase 9 internalizes that workflow so Deepcoder can coordinate its own workers while keeping the same safety boundary.

## Principles

- Workers never edit the live repo directly.
- Every worker runs in `workspaceIsolation: keep|patch`.
- Every worker has a named check or explicit no-check refusal.
- Parent controls apply/merge.
- Worker output is advisory until the parent verifies it.
- No raw worker transcripts are injected into the main task by default.
- All artifacts are inspectable: task spec, worktree path, diff hash, telemetry, check result.
- Non-TTY never auto-applies.
- Conflicts fail closed.

## User-Facing Commands

```text
/delegate plan <task>
/delegate run <plan-id>
/delegate status <plan-id>
/delegate review <plan-id>
/delegate apply <plan-id> [task-id]
/delegate discard <plan-id> [task-id]
```

Optional one-shot later:

```bash
deepcoder --delegate plan "..."
deepcoder --delegate run <plan-id>
```

Deferred until proven:

```bash
deepcoder --delegate auto "..."
```

## Data Model

```ts
type DelegationPlan = {
  id: string;
  task: string;
  createdAt: string;
  status: "planned" | "running" | "needs_review" | "applied" | "failed" | "discarded";
  workers: WorkerTask[];
  dependencies: { before: string; after: string; reason: string }[];
  globalChecks: string[];
  riskNotes: string[];
};

type WorkerTask = {
  id: string;
  title: string;
  prompt: string;
  allowedPaths: string[];
  forbiddenPaths: string[];
  checkName: string;
  maxAttempts: number;
  dependsOn: string[];
  expectedOutputs: string[];
  status: "planned" | "running" | "passed" | "failed" | "conflict" | "applied" | "discarded";
};

type WorkerRun = {
  planId: string;
  workerId: string;
  sessionId: string;
  worktreePath: string;
  startedAt: string;
  finishedAt?: string;
  exitCode: number | null;
  checkPassed: boolean;
  changedFiles: string[];
  patchPath: string;
  patchSha256: string;
  telemetryPath?: string;
  summary: string;
  warnings: string[];
};
```

Storage:

```text
.deepcoder/delegations/<plan-id>/plan.json
.deepcoder/delegations/<plan-id>/workers/<worker-id>.json
.deepcoder/delegations/<plan-id>/patches/<worker-id>.patch
.deepcoder/delegations/<plan-id>/logs/<worker-id>.log
```

Never store secrets. Redact every log/summary before writing.

## Phase 9A - Plan and Review Only

Implement deterministic planning and storage, no worker execution yet.

Scope:

- `src/delegate/types.ts`
- `src/delegate/store.ts`
- `src/delegate/planner.ts`
- slash commands:
  - `/delegate plan <task>`
  - `/delegate status <plan-id>`
  - `/delegate review <plan-id>`

Planner behavior:

- Use current 8D context planner output when available.
- Split into 1-5 worker tasks.
- Prefer sequential tasks unless files are clearly disjoint.
- Each worker must have allowedPaths, forbiddenPaths, checkName, maxAttempts.
- If the planner cannot infer safe boundaries, produce one worker task instead of over-splitting.

Acceptance:

- `npm run typecheck`
- `npm run test:phase`
- unit tests for plan validation, storage, rendering, malformed plan fallback.

## Phase 9B - Single Worker Runner

Run exactly one worker task through Deepcoder as a subprocess.

Scope:

- `src/delegate/workerRunner.ts`
- create isolated worker run with:

```bash
deepcoder --workspace-isolation keep --sandbox off --solve --check <check> "<worker prompt>"
```

Notes:

- `--sandbox off` is allowed only when the named check is the trusted full gate and nested bwrap breaks tests. Otherwise use configured sandbox.
- Worker process gets a clean env allowlist plus provider env vars.
- Worker must run from the real repo root but edit only its isolated worktree.
- Capture stdout/stderr bounded and redacted.
- Extract patch from worker worktree after completion.

Commands:

- `/delegate run <plan-id> <worker-id>`

Acceptance:

- fake worker runner tests,
- no live model required,
- one local dry-run using a scripted/fake worker command,
- no auto-apply.

## Phase 9C - Patch Validation and Apply

Validate worker patch before applying to the real repo.

Validation gates:

- worker check passed,
- patch exists and is non-empty unless task allows no-op,
- changed files are within allowedPaths,
- changed files do not touch forbiddenPaths,
- changed files do not touch sensitive paths,
- patch does not include generated artifacts (`node_modules`, `.deepcoder/runs`, bundles, caches),
- `git apply --check` passes on real repo,
- no overlap with already-applied worker patches.

Commands:

- `/delegate review <plan-id> [worker-id]`
- `/delegate apply <plan-id> <worker-id>`
- `/delegate discard <plan-id> <worker-id>`

Apply behavior:

- interactive TTY asks confirmation,
- non-TTY refuses and prints patch path,
- after apply, run configured global checks if present.

Acceptance:

- adversarial tests for forbidden path, sensitive path, generated artifact, overlapping patch, failed check, bad patch.

## Phase 9D - Multi-Worker Orchestration

Run multiple workers in dependency order.

Behavior:

- Topologically sort worker tasks.
- Run independent workers sequentially in v1. Parallel execution deferred.
- After each passed worker, parent can apply or hold.
- If worker B depends on worker A, B runs only after A is applied or explicitly rebased later.
- If a worker fails, mark blocked and continue only with independent workers.

Commands:

- `/delegate run <plan-id>` runs all runnable workers.
- `/delegate status <plan-id>` shows table: task, check, changed files, status, conflicts.

Acceptance:

- tests for dependency ordering, failed worker isolation, conflict detection.

## Phase 9E - Context-Aware Delegation

Use 8D context planner/explorer to improve worker task quality.

Scope:

- `/delegate plan` optionally runs context preflight.
- Worker prompts include compact context brief scoped to that worker.
- Planner uses repo index/test targeting to suggest focused checks.
- Store context brief with the plan, not in global memory.

Acceptance:

- no raw explorer tool output in worker prompts,
- brief bounded and redacted,
- planner falls back to deterministic split on explorer failure.

## Phase 9F - Optional Auto-Apply for Low-Risk Workers

Deferred until 9A-9E are reliable.

Auto-apply allowed only when all are true:

- one worker,
- check passed,
- full gate passed,
- patch touches only allowed source/test files,
- no sensitive/generated files,
- no conflicts,
- diff size below configured threshold,
- config explicitly enables `delegate.autoApply`.

Default remains manual apply.

## Config

```json
{
  "delegate": {
    "enabled": false,
    "maxWorkers": 5,
    "defaultCheck": "phase",
    "workerSandbox": "off",
    "workerIsolation": "keep",
    "maxPatchBytes": 200000,
    "autoApply": false,
    "preflight": true
  }
}
```

Env:

```text
DEEPCODER_DELEGATE=1
DEEPCODER_DELEGATE_MAX_WORKERS=5
DEEPCODER_DELEGATE_CHECK=phase
```

## Adversarial Tests

1. Worker patch touching outside allowedPaths is refused.
2. Worker patch touching sensitive path is refused.
3. Worker patch adding generated artifacts is refused.
4. Worker failed check cannot be applied.
5. Two workers editing the same file create a conflict.
6. Non-TTY never applies a patch.
7. Worker stdout with secrets is redacted before storage.
8. Malformed worker telemetry does not crash review.
9. Planner over-splitting fallback creates one conservative worker.
10. Dependency cycle in plan is rejected.
11. Worker subprocess timeout leaves no running child process.
12. Global check failure after apply reports failure and preserves audit trail.

## Out of Scope

- Autonomous model-callable delegation.
- Parallel workers.
- Nested workers.
- Merging without a user-visible patch review.
- Remote GitHub PR creation.
- Whole-session container sandboxing.

## Recommended Implementation Order

1. 9A plan/store/review.
2. 9C patch validator as pure functions.
3. 9B single worker runner.
4. 9C apply command.
5. 9D multi-worker sequencing.
6. 9E context-aware planning.
7. 9F optional auto-apply only after repeated successful manual use.

## Harness Hardening Follow-Up

Phase 9G adds task-packet completeness gates on top of this plan. The key lesson from the
Phase 8D delegated-worker experiment is that a worker can pass its configured check while
still skipping required deliverables. See
`plans/delegation/phase9g-delegation-harness-completeness-gates-plan.md` for the follow-up design:
explicit deliverables, expected files/tests, worker self-audits, deterministic completeness
evaluation, and reviewer-subagent downgrade checks before apply.

## Success Criteria

A successful v1 can reproduce the Phase 8D workflow internally:

1. Parent creates a plan with 3 bounded worker tasks.
2. One worker runs in an isolated worktree with `--solve --check phase`.
3. Parent collects its patch and check result.
4. Parent refuses any out-of-scope or conflicting patch.
5. Parent applies an approved patch.
6. Full gate passes on the real repo.
