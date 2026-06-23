# Audit: Delegation system

## Scope
`src/delegate/` — worker orchestration, verify-then-force, concurrent execution, validation gates.

## What to verify

### Worker isolation
- Every worker runs in its own git worktree (Phase 9H). Is this ALWAYS enforced? (code must refuse `isolation: off` for delegation)
- Worker subprocess is launched with `shell: false` and a strict env allowlist. Are there any paths where env vars could leak?
- The worker's API key is passed as an env var, never on argv. Verify no logging of env vars.

### Dependency DAG
- The planner produces a dependency graph. Cycle detection — does it catch all cycles? Self-referential dependencies?
- When a worker fails, are dependents correctly skipped? (transitive failure isolation)
- `PlanSaveQueue` serializes plan writes. Is there a race between concurrent workers writing to the same plan?

### Verification gates
- The 8-gate validation pipeline (Run Artifact → Check → Patch Validation → Completeness → Self-Audit → Quality → Conflict → Audit Artifact). Are all 8 gates actually enforced? (9G notes that Self-Audit was removed — is the pipeline still claiming to run it?)
- `verify-then-force` (9N): the default path. When a worker passes, the patch is verified in-house. Is the verification ACTUALLY run, or is the worker's green check trusted? (code says it splits the patch and re-runs tests — verify this is real, not just a comment)

### Concurrent execution (9I)
- Lock set conflict detection: determines which workers can run in parallel. Does it correctly detect file conflicts?
- `Promise.allSettled` for parallel workers. If one fails, are others correctly handled? (transitive failure isolation for dependents)
- The concurrency saver (`PlanSaveQueue`) — does it deadlock if two workers finish at the exact same time?

### Completeness gate (9G)
- After a worker passes its check, the completeness gate verifies that ALL deliverables are present in the patch.
- Does it correctly detect missing deliverables? (e.g., worker implemented the feature but didn't write the test)
- What about extra deliverables? (worker added something not requested — should that be flagged?)

## Deliverables
- Gate pipeline flow diagram (which gates run, in what order, when does each fail)
- Worker env isolation audit (confirm no secrets in argv, logs, or error messages)
- Cycle detection test (complex DAG with transitive dependencies)
- Concurrency deadlock test (two workers finishing simultaneously)
- Completeness gate false-positive/negative analysis
