# Deepcoder Phase 9K - Delegated Worker End-to-End Validation

## Context

Phase 9 has grown the delegated-worker system in slices:

- 9A: plan/status/review data model,
- 9B: single worker runner,
- 9C: patch validation/apply/discard,
- 9D: multi-worker orchestration,
- 9G: completeness/self-audit gates,
- 9H: mandatory workspace isolation for delegated workers,
- 9J: read-only LLM quality gate.

Each slice defines part of the safety story, but there is not yet one
authoritative contract for what it means for a worker result to be "done",
"passed", "reviewable", or "applyable".

That gap matters. We have already seen workers pass a configured check while
skipping part of the requested scope. A green check alone is not enough.

Phase 9K consolidates all delegated-worker gates into a single end-to-end
validation pipeline and makes that pipeline the only source of truth for apply
eligibility.

## Goal

Define and implement one authoritative validation contract:

```text
worker is applyable iff:
  isolated run is proven
  check passed
  patch validation passed
  completeness passed
  self-audit is valid
  quality gate did not block
  no unresolved conflicts
  required audit artifacts exist
```

Every surface must agree:

- `/delegate status`,
- `/delegate review`,
- `/delegate apply`,
- auto-apply eligibility,
- orchestration conflict handling,
- test/local-bench reporting.

## Non-Goals

- Do not add new worker execution behavior.
- Do not add auto-apply.
- Do not replace deterministic gates with LLM judgment.
- Do not require live model calls for acceptance.
- Do not broaden worker permissions.

## Authoritative States

Current `WorkerTaskStatus` is useful but too coarse for validation. Keep it for
high-level lifecycle, but add a separate validation result.

```ts
export type WorkerValidationStatus =
  | "not_run"
  | "pending"
  | "valid"
  | "invalid"
  | "blocked"
  | "conflict";
```

Add:

```ts
export interface WorkerValidation {
  status: WorkerValidationStatus;
  applyable: boolean;
  evaluatedAt: string;
  failures: WorkerValidationFailure[];
  warnings: string[];
  evidence: WorkerValidationEvidence[];
}

export interface WorkerValidationFailure {
  code:
    | "missing_run"
    | "not_isolated"
    | "check_failed"
    | "empty_patch"
    | "patch_validation_failed"
    | "completeness_failed"
    | "missing_self_audit"
    | "malformed_self_audit"
    | "quality_gate_blocked"
    | "quality_gate_missing"
    | "conflict"
    | "missing_artifact"
    | "run_timed_out"
    | "run_truncated";
  message: string;
  path?: string;
  source?: "run" | "patch" | "completeness" | "quality" | "conflict" | "artifact";
}

export interface WorkerValidationEvidence {
  source: string;
  note: string;
  path?: string;
}
```

Add to `WorkerRun` or store beside it:

```ts
validation?: WorkerValidation;
```

Preferred: store as a sidecar for recomputation:

```text
.deepcoder/delegations/<plan>/runs/<worker>/validation.json
```

## Validation Pipeline

New module:

```text
src/delegate/validation.ts
```

Core API:

```ts
export interface ValidateWorkerInput {
  root: string;
  plan: DelegationPlan;
  worker: WorkerTask;
  run: WorkerRun | null;
  patchText: string | null;
  alreadyChangedPaths: string[];
  qualityGateRequired: boolean;
  fileExists?: (relPath: string) => boolean;
}

export function validateWorkerResult(input: ValidateWorkerInput): WorkerValidation;
```

This function is pure except for injected `fileExists`. It should not spawn
processes, call models, or mutate files.

## Gate Order

### 1. Run Artifact Gate

Fail if:

- no `WorkerRun`,
- no run directory,
- missing `run.json`,
- missing patch when patch is required,
- worker did not run in an isolated workspace (from Phase 9H metadata),
- run timed out,
- run has no changed files.

Empty patch is invalid by default.

### 2. Check Gate

Fail if:

- `run.checkPassed !== true`,
- `worker.status` is not compatible with a completed worker,
- configured check name in run does not match the worker task.

### 3. Patch Validation Gate

Call existing `validatePatch` with:

- patch text,
- worker allowed paths,
- worker forbidden paths,
- already-changed paths from applied/passed workers.

Fail on any:

- out-of-scope path,
- forbidden path,
- sensitive path,
- generated artifact,
- overlap,
- patch too large.

### 4. Completeness Gate

Call existing `evaluateCompleteness` with:

- task deliverables,
- expected files,
- expected tests,
- self-audit,
- changed paths,
- patch text.

Fail if completeness has failures.

Warnings can remain warnings unless explicitly configured as blocking later.

### 5. Self-Audit Gate

A missing or malformed self-audit is invalid for delegated workers once 9G is
enabled.

Cross-check:

- every claimed completed deliverable must have deterministic evidence,
- every changed file in self-audit must appear in the patch,
- every skipped required deliverable is a failure,
- `testsRun` must include the configured check name or a recognized full gate.

### 6. Quality Gate

If 9J is enabled/mandatory:

- missing quality gate -> failure,
- quality gate error -> failure if configured fail-closed,
- high/critical findings above threshold -> failure,
- reviewer result cannot override deterministic failures.

If 9J is disabled:

- add evidence `quality gate not required`.

### 7. Conflict Gate

Fail if:

- this worker conflicts with already-passed or already-applied workers,
- orchestrator recorded unresolved path conflicts,
- worker status is `conflict`.

### 8. Audit Artifact Gate

Fail if required audit artifacts are missing:

- worker log,
- patch diff,
- run JSON,
- validation JSON after first evaluation.

Do not require quality-gate artifact when quality gate is disabled.

## Apply Contract

`applyWorker` must call the authoritative validator immediately before any
`git apply --check`.

Apply is allowed only if:

```ts
validation.applyable === true
```

`applyWorker` should not duplicate gate logic beyond loading inputs and invoking
`validateWorkerResult`.

Error message format:

```text
Worker "worker-2" is not applyable:
  [completeness_failed] required deliverable "tests" not satisfied
  [quality_gate_blocked] high: src/foo.ts imports missing symbol parseConfig
```

## Status / Review Contract

`/delegate status` should show:

```text
worker   run     check   patch   complete   quality   conflicts   applyable
w1       done    pass    pass    pass       pass      none        yes
w2       done    pass    pass    fail       skipped   none        no
```

`/delegate review` should show detailed validation failures before raw patch
details.

The user should not need to mentally combine several sections to know whether a
worker is safe to apply.

## Worker Status Updates

Do not overload `WorkerTask.status = "passed"` to mean fully applyable.

Recommended interpretation:

- `passed`: worker's own configured check passed,
- `conflict`: validation found unresolved conflicts,
- `applied`: patch applied to real repo,
- `failed`: worker process/check failed,
- `discarded`: user discarded it.

Applyability lives in `WorkerValidation.applyable`.

## Auto-Apply Contract

If auto-apply exists or is added later, it must require:

```ts
validation.applyable === true
```

No separate shortcut.

## Revalidation

Validation must be recomputable.

Why:

- the real repo may move,
- another worker may apply first,
- alreadyChangedPaths can change,
- quality gate policy can change.

Add:

```ts
export async function loadAndValidateWorker(...): Promise<WorkerValidation>
```

It loads:

- plan,
- worker,
- run JSON,
- patch diff,
- self-audit,
- quality gate result,
- applied path state.

Then writes `validation.json`.

## Tests

No live model required.

### Pure validation tests

1. missing run -> not applyable.
2. no isolation metadata -> not applyable.
3. check failed -> not applyable.
4. empty patch -> not applyable.
5. patch validation failure -> not applyable.
6. completeness failure -> not applyable.
7. missing self-audit -> not applyable when required.
8. malformed self-audit -> not applyable.
9. self-audit claims changed file not in patch -> not applyable.
10. quality gate blocked -> not applyable.
11. quality gate missing while mandatory -> not applyable.
12. conflict path -> not applyable.
13. all gates pass -> applyable.

### Apply tests

1. `applyWorker` calls validation and refuses invalid worker.
2. `applyWorker` error message includes all validation failure codes.
3. valid worker still passes `git apply --check` and applies.
4. validation is recomputed at apply time, not trusted from stale JSON.
5. worker that became overlapping after another apply is refused.

### Status/review tests

1. `/delegate status` renders applyable yes/no.
2. `/delegate review` lists validation failures before patch details.
3. output is bounded with many failures.

### Regression tests from real failures

1. worker passes check but misses a deliverable -> not applyable.
2. worker produces correct code but weak/missing test -> not applyable if required.
3. worker changes forbidden generated artifact while tests pass -> not applyable.
4. worker times out but leaves patch -> not applyable.

## Acceptance

Required:

```bash
npm run typecheck
npm run test:phase
```

No live model required.

Manual smoke:

1. Create a fake plan + worker run with a valid patch.
2. Run validation -> applyable.
3. Remove self-audit -> not applyable.
4. Add forbidden path to patch -> not applyable.
5. Restore valid state and apply -> succeeds.

## Migration

Existing worker runs may lack validation metadata.

Behavior:

- old runs are treated as needing revalidation,
- if required artifacts are absent, old runs are not applyable,
- `/delegate review` explains: "old run lacks validation artifacts; rerun worker
  or validate manually".

## Risks

### Too Strict Initially

Existing useful patches may become blocked because self-audit/quality artifacts
are missing.

Mitigation:

- ship with explicit config for mandatory self-audit/quality,
- but keep apply gate strict once enabled.

### Logic Duplication

Validation rules can drift if duplicated in apply/status/review.

Mitigation:

- one `validateWorkerResult` function,
- all surfaces call it.

### False Confidence

Validation can prove process completeness, not semantic correctness.

Mitigation:

- still require tests/checks,
- quality gate is downgrade-only,
- final human/parent review remains part of workflow.

## Implementation Order

1. Add validation types.
2. Implement pure `validateWorkerResult`.
3. Add pure validation tests.
4. Add loader/writer for `validation.json`.
5. Wire `applyWorker` to validation.
6. Wire `/delegate status` and `/delegate review` to validation.
7. Wire auto-apply to validation if present.
8. Add regression tests for "check passed but incomplete".
9. Update Phase 9 docs.
10. Run full gate.

## Definition of Done

- There is exactly one authoritative worker applyability function.
- A green check alone does not make a worker applyable.
- `applyWorker`, status, review, and auto-apply all agree.
- Missing deliverables/self-audit/quality/conflict artifacts block apply.
- Full gate passes without live model calls.
