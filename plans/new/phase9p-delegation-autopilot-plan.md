# Phase 9P — Delegation Autopilot

## Context

Deepcoder can already perform most of the individual pieces needed for delegated implementation:

- split work into workers (`/delegate plan`, model-driven decomposition),
- run worker subprocesses in isolated worktrees,
- run independent workers concurrently,
- validate worker output with patch, completeness, TDD, and acceptance-first gates,
- apply a worker patch through the existing guarded apply path.

However, the user still coordinates the full loop manually:

1. create or refine a plan,
2. run workers,
3. inspect status,
4. apply passing workers,
5. retry failed workers,
6. run final checks,
7. stop on conflicts.

Nested delegation is intentionally blocked (`DEEPCODER_DELEGATE_DEPTH`) and should remain
blocked. The safe design is a single top-level orchestrator that owns the whole task and never
lets child workers recursively spawn their own worker trees.

## Goal

Add a top-level delegation autopilot mode:

```text
/delegate autopilot <task>
```

It should autonomously run the parent-side loop:

1. decompose the task,
2. launch safe workers,
3. validate each result,
4. apply only gate-passing patches,
5. retry or replan bounded failures,
6. run final checks,
7. stop and ask on ambiguity, conflicts, or unsafe states.

## Non-Goals

- No nested worker delegation.
- No bypassing `/delegate apply` gates.
- No applying patches with failed validation.
- No resolving merge conflicts automatically.
- No infinite retry loop.
- No default-on autopilot.
- No hidden model calls outside the normal provider/router path.

## Command Surface

### Slash Command

```text
/delegate autopilot <task>
/delegate autopilot --dry-run <task>
/delegate autopilot --max-workers 4 --max-rounds 3 <task>
/delegate autopilot --acceptance-first <task>
```

### CLI Follow-Up

Optional later:

```text
deepcoder --delegate-autopilot "<task>"
```

## Configuration

Default off:

```json
{
  "delegate": {
    "autopilot": {
      "enabled": false,
      "maxRounds": 3,
      "maxWorkers": 5,
      "maxConcurrency": 2,
      "acceptanceFirst": true,
      "autoApply": false,
      "stopOnConflict": true,
      "stopOnQualityWarning": false
    }
  }
}
```

Environment overrides:

```text
DEEPCODER_DELEGATE_AUTOPILOT=1
DEEPCODER_DELEGATE_AUTOPILOT_MAX_ROUNDS=3
DEEPCODER_DELEGATE_AUTOPILOT_MAX_WORKERS=5
DEEPCODER_DELEGATE_AUTOPILOT_MAX_CONCURRENCY=2
```

Default behavior:

- command refuses unless enabled or explicitly invoked interactively,
- non-TTY refuses unless `--dry-run`,
- `autoApply` remains false unless explicitly configured and all gates pass.

## Architecture

New module:

```text
src/delegate/autopilot.ts
```

Main entry:

```ts
export interface AutopilotInput {
  realRoot: string;
  task: string;
  checks: Record<string, CheckConfig>;
  config: DelegateAutopilotConfig;
  signal: AbortSignal;
  confirm?: (prompt: string) => Promise<boolean>;
  seams?: AutopilotSeams;
}

export interface AutopilotResult {
  planId: string;
  status: "completed" | "blocked" | "failed" | "dry_run";
  rounds: AutopilotRound[];
  appliedWorkers: string[];
  blockedWorkers: string[];
  finalCheckPassed: boolean | null;
  summary: string;
}
```

Seams for tests:

```ts
export interface AutopilotSeams {
  buildPlan?: typeof buildPlan;
  decompose?: typeof proposeDecomposition;
  runWorkers?: typeof runRunnableConcurrent;
  validateWorker?: typeof loadAndValidateWorker;
  applyWorker?: typeof applyWorker;
  runCheck?: typeof runCheck;
}
```

## Loop

### Round 0 — Plan

1. Build a bounded worker plan.
2. Prefer model-driven decomposition when requested.
3. Validate worker count, allowed paths, dependencies, and checks.
4. Save the plan before any worker runs.

Dry run stops here and prints:

- plan id,
- workers,
- dependency graph,
- expected files,
- checks,
- acceptance-first status.

### Round N — Run Runnable Workers

1. Compute runnable workers.
2. Batch independent workers with existing lock/conflict logic.
3. Run with `runRunnableConcurrent` up to configured concurrency.
4. Workers always run with `DEEPCODER_DELEGATE_DEPTH > 0`; nested delegation remains refused.
5. Persist run artifacts after each worker.

### Validate

For each completed worker:

1. load artifacts,
2. run `loadAndValidateWorker`,
3. require:
   - run artifact exists,
   - check passed,
   - patch validation passed,
   - completeness passed,
   - acceptance-first proof when enabled,
   - no changed-file conflict,
   - no sensitive/generated path changes.

### Apply

If `autoApply` is false:

- summarize eligible workers,
- stop with `blocked`,
- tell the user which `/delegate apply` commands are safe.

If `autoApply` is true:

1. ask for interactive confirmation unless policy explicitly permits unattended mode,
2. apply workers in dependency order,
3. after each apply, run configured final check or worker check,
4. stop on first apply/check failure.

### Retry / Replan

Bounded retries:

- `maxRounds` controls total orchestration rounds.
- A failed worker may be retried only if:
  - failure is not patch-conflict/safety-sensitive,
  - validation error is actionable,
  - retry budget remains.

Replan:

- If a worker is incomplete or blocked by missing deliverables, optionally create a follow-up worker.
- Replan never deletes or rewrites already-applied patches.
- Replan cannot exceed `maxWorkers`.

### Final Check

After all eligible workers are applied:

1. run final configured check,
2. report status,
3. record audit artifact,
4. never hide failures.

## Safety Rules

- Autopilot is parent-owned only.
- Delegated workers cannot call `/delegate run` or `/delegate autopilot`.
- Every worker runs in an isolated worktree.
- Real repo changes only through the existing `applyWorker` path.
- No failed validation can be overridden by autopilot.
- No conflict resolution without user approval.
- No non-TTY apply unless explicitly configured and deterministic gates pass.
- Secrets are never written to plan/run/summary artifacts.

## Artifacts

Persist under:

```text
.deepcoder/delegations/<plan-id>/autopilot.json
```

Shape:

```ts
interface AutopilotArtifact {
  task: string;
  startedAt: string;
  finishedAt?: string;
  config: RedactedAutopilotConfig;
  rounds: AutopilotRound[];
  appliedWorkers: string[];
  blockedWorkers: string[];
  finalCheck: {
    name: string;
    passed: boolean;
    runId?: string;
  } | null;
}
```

## Slash UI

Add:

```text
/delegate autopilot <task>
/delegate autopilot status <plan-id>
```

Output:

- current round,
- workers running/passed/blocked/applied,
- validation blockers,
- next action,
- safe apply commands when `autoApply=false`.

## Tests

Pure/unit tests:

- dry-run creates plan and runs no workers,
- maxWorkers cap is enforced,
- dependency order is respected,
- independent workers are batched,
- nested delegation stays refused,
- failed validation blocks apply,
- autoApply=false never mutates real repo,
- autoApply=true calls `applyWorker` only for fully valid workers,
- conflict stops autopilot,
- maxRounds prevents infinite retry,
- artifacts are redacted and bounded.

Integration/no-live-model tests:

- fake workers produce two disjoint patches → autopilot applies both in order when enabled,
- one worker fails check → no apply for that worker or dependents,
- patch conflict between workers → blocked, no automatic resolution,
- acceptance-first missing proof → blocked,
- final check failure → reported as failed, not hidden.

## Acceptance

- `npm run typecheck`
- `npm run test:phase`
- no live model required for core tests,
- no subprocess in pure tests,
- existing `/delegate run/apply/discard` behavior unchanged,
- non-TTY apply remains refused by default.

## Implementation Order

1. Add `DelegateAutopilotConfig` to config types and parsing, default off.
2. Add `src/delegate/autopilot.ts` with pure loop + seams.
3. Add artifact writer/reader.
4. Wire `/delegate autopilot --dry-run`.
5. Wire interactive `/delegate autopilot`.
6. Add autoApply=false path first.
7. Add guarded autoApply=true path.
8. Add status command.
9. Add adversarial tests.
10. Update README/ROADMAP.

## Open Questions

- Should final check default to a plan-level check, the union of worker checks, or require explicit config?
- Should autopilot retry failed workers automatically, or only produce follow-up worker suggestions in v1?
- Should unattended auto-apply exist at all, or should v1 always stop before apply?

Recommended v1 answers:

- require explicit final check when applying,
- no automatic replan in v1,
- autoApply=false by default and recommended.
