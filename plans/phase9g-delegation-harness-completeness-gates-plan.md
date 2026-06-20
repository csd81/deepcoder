# Deepcoder Phase 9G - Delegation Harness Completeness Gates

## Context

Deepcoder can now work as an implementation worker when launched in an isolated
workspace with `--solve --check <name>`. The Phase 8D delegation experiment proved the
pattern:

```text
parent scopes task -> worker edits isolated worktree -> worker check loop verifies
-> parent reviews -> parent applies/commits
```

The weak point is not just model quality. It is the harness: a green check currently means
"the configured command passed", not "the worker completed every requested deliverable".
Phase 8D showed this clearly:

- a worker can pass tests while skipping README/docs deliverables,
- a worker can write a weak test that does not prove the intended behavior,
- a worker can omit telemetry/report fields that were part of the task,
- a worker can satisfy the visible oracle while missing checklist intent.

Phase 9G hardens the delegation harness so worker output is judged against an explicit
task packet, not only an exit code.

## Goal

Add a deterministic completeness layer between "worker check passed" and "patch can be
applied".

The parent should be able to say:

```text
check passed, but this worker is still incomplete because:
- required file missing: evals/local-bench/README.md
- expected telemetry field not present: preflightContextBytes
- required test file not changed
- final self-audit did not mark deliverable D3 complete
```

This is not autonomous merge. The output remains advisory until reviewed/applied.

## Design Principles

- Green tests are necessary but not sufficient.
- Task scope must be machine-checkable where possible.
- Deterministic gates run before any reviewer model.
- Reviewer/subagent judgment is additive, not the only defense.
- Missing deliverables fail closed.
- Workers must produce a final self-audit, but the harness verifies it independently.
- Non-TTY never applies.
- Existing Phase 9 patch safety gates remain in force.

## New Task Packet

Extend `WorkerTask` from the Phase 9 plan with a richer task packet:

```ts
type WorkerTask = {
  id: string;
  title: string;
  prompt: string;
  allowedPaths: string[];
  forbiddenPaths: string[];
  checkName: string;
  maxAttempts: number;
  dependsOn: string[];

  deliverables: Deliverable[];
  expectedFiles: ExpectedFileRule[];
  expectedSymbols?: ExpectedSymbolRule[];
  expectedTests?: ExpectedTestRule[];
  qualityRules?: QualityRule[];
};

type Deliverable = {
  id: string;
  description: string;
  required: boolean;
  evidence:
    | { kind: "file_exists"; path: string }
    | { kind: "file_changed"; path: string }
    | { kind: "path_prefix_changed"; prefix: string }
    | { kind: "test_added"; pathPrefix?: string }
    | { kind: "text_in_diff"; pattern: string }
    | { kind: "json_field"; path: string; jsonPath: string }
    | { kind: "manual_review" };
};

type ExpectedFileRule = {
  path: string;
  mode: "must_change" | "may_change" | "must_not_change" | "must_exist";
};

type ExpectedSymbolRule = {
  file: string;
  symbol: string;
  mode: "must_add_or_change";
};

type ExpectedTestRule = {
  pathPrefix: string;
  mustGoRedOnBaseline?: boolean;
  description: string;
};
```

All fields are bounded and validated. Bad task packets are rejected before launching a
worker.

## Worker Final Self-Audit

At the end of each worker run, the worker must write a bounded JSON self-audit into the
isolated workspace:

```text
.deepcoder/delegation/self-audit.json
```

Shape:

```ts
type WorkerSelfAudit = {
  taskId: string;
  completedDeliverables: { id: string; evidence: string }[];
  skippedDeliverables: { id: string; reason: string }[];
  changedFiles: string[];
  testsRun: string[];
  knownLimitations: string[];
};
```

The harness never trusts this blindly. It uses it to improve review UX, then independently
checks the declared evidence against the patch/worktree.

If the file is missing, malformed, too large, or mentions an unknown deliverable, the run is
marked `incomplete`.

## Deterministic Completeness Gates

Add `src/delegate/completeness.ts`.

Inputs:

- `WorkerTask`
- `WorkerRun`
- patch text
- changed file list
- optional worktree path
- optional self-audit

Output:

```ts
type CompletenessResult = {
  complete: boolean;
  failures: CompletenessFailure[];
  warnings: string[];
  evidence: CompletenessEvidence[];
};

type CompletenessFailure = {
  code:
    | "missing_required_deliverable"
    | "missing_expected_file_change"
    | "forbidden_file_changed"
    | "missing_required_test"
    | "weak_regression_test"
    | "missing_self_audit"
    | "malformed_self_audit"
    | "manual_review_required";
  message: string;
  deliverableId?: string;
  path?: string;
};
```

Rules:

1. Every required deliverable must have matching deterministic evidence, unless it is
   explicitly `manual_review`.
2. `manual_review` deliverables block auto-apply and appear prominently in `/delegate review`.
3. `expectedFiles[].must_change` must appear in the patch.
4. `expectedFiles[].must_not_change` must not appear in the patch.
5. `expectedTests` must be added or changed.
6. When `mustGoRedOnBaseline` is true, the parent validates the agent-authored test by
   applying only that test to the baseline and confirming the named check fails.
7. The self-audit must not claim deliverables the deterministic evidence does not support.

## Reviewer Subagent Pass

After deterministic gates, optionally run a read-only reviewer profile on the patch:

```text
/delegate review <plan-id> --reviewer
```

Reviewer prompt receives:

- task packet,
- patch summary,
- completeness result,
- bounded diff,
- check result.

It must answer:

```json
{
  "decision": "approve" | "needs_changes" | "manual_review",
  "missingDeliverables": [],
  "testQualityConcerns": [],
  "securityConcerns": [],
  "notes": []
}
```

The reviewer can only downgrade a patch. It cannot override deterministic failures.

Default for v1: reviewer pass is available but not required by `/delegate apply`.

## Commands

Extend existing Phase 9 commands:

```text
/delegate review <plan-id> [worker-id]
/delegate audit <plan-id> [worker-id]
/delegate apply <plan-id> <worker-id>
```

Behavior:

- `review` shows patch safety + check result + completeness table.
- `audit` prints only deliverables, expected files/tests, and pass/fail evidence.
- `apply` refuses if completeness has failures.
- `apply --force-incomplete` is interactive-only and records an audit warning.

No non-TTY force apply.

## Planner Changes

The parent planner must produce task packets with explicit deliverables.

For each worker:

- list required files or path prefixes when known,
- list documentation/test deliverables separately from code deliverables,
- mark ambiguous outcomes as `manual_review`,
- avoid vague deliverables like "make it good".

Example:

```json
{
  "deliverables": [
    {
      "id": "D1",
      "description": "Add --preflight flag to CLI options",
      "required": true,
      "evidence": { "kind": "file_changed", "path": "src/cli/main.ts" }
    },
    {
      "id": "D2",
      "description": "Add adversarial coverage for prompt injection isolation",
      "required": true,
      "evidence": { "kind": "path_prefix_changed", "prefix": "test/adversarial/" }
    },
    {
      "id": "D3",
      "description": "Document usage in local-bench README",
      "required": true,
      "evidence": { "kind": "file_changed", "path": "evals/local-bench/README.md" }
    }
  ]
}
```

## Files

- New `src/delegate/completeness.ts`
- New `src/delegate/selfAudit.ts`
- Edit `src/delegate/types.ts`
- Edit `src/delegate/planner.ts`
- Edit `src/delegate/workerRunner.ts`
- Edit `src/cli/slashCommands.ts`
- New `test/adversarial/delegate-completeness.test.ts`
- Edit `plans/phase9-self-orchestration-delegated-workers-plan.md` to reference this hardening phase

## Adversarial Tests

1. A worker with passing check but missing required README deliverable is incomplete.
2. A worker with passing check but missing required test change is incomplete.
3. A self-audit claiming a deliverable without matching patch evidence is rejected.
4. Malformed self-audit marks the worker incomplete but does not crash review.
5. A forbidden file change fails completeness even when patch safety also catches it.
6. A `manual_review` deliverable blocks auto-apply and appears in review output.
7. An agent-authored regression test that stays green on baseline is flagged weak.
8. A valid red-on-baseline regression test satisfies `expectedTests`.
9. `apply --force-incomplete` refuses in non-TTY.
10. Reviewer subagent can downgrade an otherwise complete patch, but cannot upgrade a deterministic failure.

## Verification

Required:

```bash
npm run typecheck
npm run test:phase
```

No live model required for acceptance. Use fake worker outputs and fake reviewer providers.

Manual smoke:

1. Create a delegation plan with one worker requiring code + test + README deliverables.
2. Feed a fake worker patch that changes only code and passes check.
3. Confirm `/delegate review` says "check passed, incomplete".
4. Add test + README changes.
5. Confirm completeness passes.

## Out of Scope

- Autonomous merge without review.
- General semantic proof that code is correct.
- LLM-only completeness judging.
- Parallel worker scheduling.
- GitHub PR creation.
- Full task decomposition UI.

## Implementation Order

1. Pure task packet schema + validation.
2. Pure completeness evaluator.
3. Self-audit parser and bounds/redaction.
4. Wire completeness into `/delegate review`.
5. Make `/delegate apply` refuse incomplete workers.
6. Add optional reviewer-subagent downgrade pass.
7. Update Phase 9 docs and examples.

## Success Criteria

Deepcoder can still implement as a worker, but the parent harness catches the class of
failure Phase 8D exposed:

```text
worker check passed
but README deliverable missing
therefore patch is not applyable
```

That moves Deepcoder from "test-green worker" toward "audited delegated worker".
