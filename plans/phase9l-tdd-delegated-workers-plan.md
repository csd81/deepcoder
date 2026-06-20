# Phase 9L — TDD Delegated Workers

## Context

Deepcoder already has most of the pieces for test-driven delegated work:

- delegated workers run in isolated worktrees and produce patch artifacts;
- `--solve --check` gives edit → check → retry loops;
- `--repro auto` can generate a failing repro and validate red/green behavior;
- local-bench has `repro_invalid`, oracle overlays, and quality gates;
- Phase 9G completeness gates can require expected tests/deliverables;
- Phase 9C/9J apply gates can block unsafe or low-quality patches.

What is missing is an explicit delegated-worker lifecycle that enforces TDD:

1. write or update a repro test first;
2. prove it fails on the baseline;
3. fix the code;
4. prove the repro and configured checks pass;
5. store auditable red/green artifacts;
6. refuse apply when the red/green proof is missing.

This phase makes TDD a first-class delegated-worker mode. It is opt-in at first, then can become the preferred mode for bug-fix workers where a repro is expected.

## Goals

- Add a TDD lifecycle for delegated workers: `repro -> red -> fix -> green`.
- Persist red/green check artifacts per worker.
- Split test-only and fix patches for review.
- Extend apply gates so TDD-required workers cannot apply without valid red/green proof.
- Keep worker edits isolated; live repo changes only through existing `/delegate apply`.
- Avoid trusting agent-written tests blindly: a repro must fail on baseline before it can grade a fix.

## Non-goals

- No automatic hidden-test inference.
- No requirement that every worker use TDD.
- No auto-apply.
- No second apply path.
- No model-generated arbitrary check commands.
- No live benchmark run required for this phase.

## Worker Model

Extend `WorkerTask`:

```ts
export interface WorkerTask {
  // existing fields...
  tdd?: WorkerTddRequirement;
}

export interface WorkerTddRequirement {
  required: boolean;
  reproPathHints?: string[];
  allowedTestPaths?: string[];
  baselineCheckName?: string;
  finalCheckName?: string;
  allowNoReproJustification?: boolean;
}
```

Defaults:

- existing workers: `tdd` absent means no behavior change;
- planner may set `tdd.required:true` for bug-fix tasks later;
- user can request TDD explicitly via `/delegate plan --tdd <task>`.

## Run Artifact Model

Extend `WorkerRun`:

```ts
export interface WorkerTddRun {
  required: boolean;
  status:
    | "not_required"
    | "repro_missing"
    | "red_failed"
    | "red_confirmed"
    | "green_failed"
    | "green_confirmed"
    | "waived";
  reproPaths: string[];
  redRunId?: string;
  greenRunId?: string;
  redPatchPath?: string;
  fixPatchPath?: string;
  noReproJustification?: string;
  warnings: string[];
}

export interface WorkerRun {
  // existing fields...
  tdd?: WorkerTddRun;
}
```

Artifacts under `.deepcoder/delegations/<plan>/runs/<worker>/`:

- `repro.patch` — test-only patch after repro phase.
- `fix.patch` — code/final patch after fix phase.
- `red-run.json` — check run metadata for baseline+repro failure.
- `green-run.json` — final check run metadata.
- `tdd.json` — summary record.

## Lifecycle

### Step 1 — Repro Phase

Worker prompt is constrained:

- write or update only regression tests/repro files;
- do not fix production code yet;
- use allowed test paths from task packet;
- explain if no repro is possible only when allowed.

Parent validates the repro patch:

- changed paths must be under `allowedTestPaths` / `reproPathHints`;
- no production files may change during repro phase;
- patch must be non-empty unless waiver is allowed;
- generated/sensitive files are blocked by existing patch validation.

### Step 2 — Red Proof

Parent applies the repro patch to a fresh baseline worktree, then runs the baseline check:

- use `tdd.baselineCheckName` if set;
- else use worker `checkName`;
- else use existing repro validation helpers when available.

Red proof passes only if:

- check exits non-zero;
- command did not timeout;
- output is bounded/redacted and stored;
- when possible, failure is attributable to the repro path.

If the repro test passes on baseline, set `tdd.status = "red_failed"` and do not proceed to the fix phase unless an explicit non-blocking policy is configured.

### Step 3 — Fix Phase

After red is confirmed, worker gets a second prompt:

- the repro is confirmed failing;
- fix production code;
- preserve the repro test;
- do not weaken/delete the repro;
- stay within allowed paths.

The normal `--solve --check` loop can run here using the final check.

### Step 4 — Green Proof

Run final verification:

- repro check must pass;
- worker configured check must pass;
- if they are different, both run;
- global checks remain apply-time safety.

Green proof passes only if:

- final check exits 0;
- repro file still exists/changed;
- simple non-tautology/skip checks do not flag the repro;
- patch validation/completeness gates pass.

### Step 5 — Review and Apply

Apply gate extension:

- If `worker.tdd.required === true`, `applyWorker` refuses unless `run.tdd.status === "green_confirmed"` or explicit waiver exists and policy allows it.
- Missing `tdd.json`, missing red run, or missing green run is an apply blocker.
- Existing deterministic, quality, and `git apply --check` gates still run.

## Commands

Planner:

```text
/delegate plan --tdd <task>
```

Runner:

```text
/delegate run --tdd <plan-id> [worker-id]
```

Review:

```text
/delegate tdd <plan-id> <worker-id>
```

Example output:

```text
TDD worker-2
  repro: tests/parser-regression.test.ts
  red:   confirmed · run chk_123 · failed as expected
  green: confirmed · run chk_124 · passed
  patches: repro.patch 1.2KB · fix.patch 3.8KB
```

The normal `/delegate review` and future patch browser should include TDD status.

## Prompting

Add deterministic prompt builders:

`src/delegate/tddPrompts.ts`

- `buildReproPhasePrompt(worker, plan)`
- `buildFixPhasePrompt(worker, plan, redSummary)`

Prompt rules:

- tell worker it is isolated;
- forbid production edits in repro phase;
- forbid deleting/weakening repro in fix phase;
- remind worker that parent harness verifies red/green;
- do not expose hidden/oracle tests.

## Implementation Design

New modules:

- `src/delegate/tdd.ts` — orchestration helpers and status computation.
- `src/delegate/tddPrompts.ts` — prompt builders.
- `src/delegate/tddArtifacts.ts` — read/write `tdd.json`, red/green run metadata.
- `test/adversarial/delegate-tdd.test.ts`.

Recommended v1: implement TDD orchestration as a sibling function, not by heavily mutating the existing runner:

```ts
export async function runWorkerTdd(input: RunWorkerInput): Promise<WorkerRun>;
```

It can reuse:

- isolated worktree creation;
- bounded process runner;
- patch capture;
- `runCheck`;
- patch validation;
- completeness gates;
- quality gate.

## Baseline Worktree Strategy

Red validation must prove the repro fails on baseline code, not after accidental code edits.

Preferred approach: create a fresh baseline worktree, apply `repro.patch`, run red proof there, then clean it by default. This is clearer and more auditable than resetting the worker's fix worktree in place.

## Completeness and Quality Gates

TDD integrates with existing gates:

- `missing_required_test` is satisfied by repro paths;
- `repro_invalid` maps to `red_failed`;
- self-audit must mention repro and fix files when required;
- quality gate can review both repro and fix patch.

Quality reviewer prompt should see:

- `repro.patch`;
- `fix.patch`;
- red/green summaries;
- changed files;
- worker task packet.

Reviewer must not be able to override deterministic red/green failure.

## Safety Rules

- TDD mode never applies patches automatically.
- Red/green checks run through existing `runCheck` classifier/sandbox path.
- The model never chooses check commands.
- Repro phase cannot modify production code.
- Fix phase cannot delete or weaken repro files without flagging.
- Non-TTY apply is still refused by existing apply path.
- All artifacts are redacted and bounded.
- No hidden tests are surfaced to worker.

## Files

New:

- `src/delegate/tdd.ts`
- `src/delegate/tddPrompts.ts`
- `src/delegate/tddArtifacts.ts`
- `test/adversarial/delegate-tdd.test.ts`

Edit:

- `src/delegate/types.ts`
- `src/delegate/workerRunner.ts`
- `src/delegate/apply.ts`
- `src/delegate/completeness.ts`
- `src/cli/slashCommands.ts`
- `ROADMAP.md`

## Tests

No live model required. Use fake worker scripts / injected spawn seams.

1. Non-TDD worker behavior unchanged.
2. TDD repro phase changing production file is blocked.
3. Empty repro patch is blocked when TDD is required.
4. Repro patch applied to baseline and passing baseline check results in `red_failed`.
5. Repro patch applied to baseline and failing check results in `red_confirmed`.
6. After red confirmed, fix phase can change production code.
7. Green check passing results in `green_confirmed`.
8. Green check failing results in `green_failed`, worker not passed.
9. Apply refuses TDD-required worker without `green_confirmed`.
10. Apply accepts TDD worker with `green_confirmed` and other gates passing.
11. Red/green artifacts are redacted and bounded.
12. Baseline worktree is cleaned after red proof.
13. Waiver requires explicit config and is recorded.
14. Worker cannot self-grade by adding a test that already passes on baseline.

## Rollout

### 9L.1 — Types and Artifact Helpers

- Add TDD requirement/run types.
- Add read/write helpers for `tdd.json` and red/green metadata.

### 9L.2 — Repro Phase + Red Proof

- Implement repro-only prompt and validation.
- Implement baseline worktree red check.

### 9L.3 — Fix Phase + Green Proof

- Run fix phase after red confirmation.
- Verify final check(s).

### 9L.4 — Apply Gate Integration

- Refuse apply when required TDD proof is missing.
- Add `/delegate tdd` review output.

### 9L.5 — Planner and UX

- Add `/delegate plan --tdd`.
- Add TDD status to `/delegate status` and patch browser.

## Acceptance Criteria

- Existing delegated workers still work unchanged.
- A TDD-required worker cannot be applied without red and green artifacts.
- Agent-written repro tests are validated against baseline and cannot self-grade.
- Red/green check runs are auditable from `.deepcoder/delegations/.../runs/...`.
- All TDD checks run through existing sandbox/classifier/check runner.
- `npm run typecheck` and `npm run test:phase` pass.

## Open Questions

- Should planner infer `tdd.required` automatically for all bug-fix workers, or only on `--tdd` initially?
- Should red proof require matching failure text to the new repro file, or is non-zero exit enough in v1?
- Should TDD mode support multi-worker shared repro tests, or keep repro per worker?
- Should no-repro waivers be allowed at all for high-risk workers?
