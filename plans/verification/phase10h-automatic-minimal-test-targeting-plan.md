# Phase 10H — Automatic Minimal Test Targeting

## Context

Deepcoder already has useful repo-index primitives:

- `src/index/impact.ts` computes reverse-import impact.
- `src/index/testTargeting.ts` suggests relevant tests for changed files.
- `target_tests` exposes suggestions to the model as a read-only tool.
- checks are configured by name and executed through `runCheck` with classifier, sandbox, timeout,
  logging, and dependency-healing support.

The missing piece is automation. Today the solver/delegated workers usually run a broad configured
check like `test:phase`, which is reliable but slow. The model can ask for target suggestions, but
the harness does not turn a patch's changed files into a minimal deterministic check plan.

This phase adds automatic minimal test targeting: after a patch/edit, Deepcoder derives a small
verification plan from changed files, runs the narrowest high-confidence checks first, and falls
back to broader checks when confidence is low or targeted checks pass but broader safety is needed.

## Goals

- Automatically choose focused tests/checks from changed files.
- Reduce iteration time for solve loops and delegated workers.
- Preserve correctness by falling back to full checks when targeting is uncertain.
- Keep targeting deterministic and auditable.
- Reuse existing check runner, sandbox, dependency healing, and run logs.
- Make targeting visible in telemetry/status/delegation artifacts.

## Non-goals

- No hidden-test inference.
- No language-server integration in this phase.
- No flaky-test reranker.
- No automatic package installation beyond existing dependency healing.
- No replacement for full CI/global checks before apply/merge.

## Config

Extend `.deepcoder/config.json`:

```json
{
  "testTargeting": {
    "enabled": false,
    "mode": "suggest",
    "fallbackCheck": "phase",
    "maxTargets": 8,
    "minConfidence": "medium",
    "runFullAfterTargetedPass": false,
    "languageCommands": {
      "typescript": "node --import tsx --test {files}",
      "javascript": "node --test {files}",
      "python": "python -m pytest -q {files}"
    },
    "pathRules": [
      { "changed": "src/**", "tests": ["test/**/*.test.ts"] }
    ]
  }
}
```

Modes:

- `off` — disabled.
- `suggest` — show suggested tests but do not run them automatically.
- `targeted-first` — run targeted check first, fallback on uncertainty/failure policy.
- `targeted-only` — run targeted check only; intended for local dev, not delegation apply.

Default: disabled/off.

Environment:

- `DEEPCODER_TEST_TARGETING=off|suggest|targeted-first|targeted-only`

## Targeting Model

New module:

`src/checks/testTargetPlanner.ts`

```ts
export type TargetConfidence = "high" | "medium" | "low" | "none";

export interface TestTargetPlan {
  changedFiles: string[];
  targetFiles: string[];
  commands: TargetedCheckCommand[];
  confidence: TargetConfidence;
  reasons: string[];
  fallbackCheck?: string;
  fallbackRequired: boolean;
}

export interface TargetedCheckCommand {
  label: string;
  command: string;
  files: string[];
  language: string;
  confidence: TargetConfidence;
}
```

Signals, strongest to weakest:

1. changed test files themselves
2. reverse-import impacted test files from repo index
3. naming convention from `relevantTests`
4. configured path rules
5. package/script fallback
6. full fallback check

Confidence rules:

- `high`: changed test file or direct reverse-import test target.
- `medium`: naming convention match or path rule.
- `low`: only broad package-level inference.
- `none`: no target; fallback required.

## Check Composition

Targeted commands must still flow through `runCheck`.

Approach:

- Build ephemeral `CheckConfig` objects from a target plan.
- Commands use configured templates with `{files}` placeholder.
- File paths are shell-escaped safely using a local quoting helper.
- Command is still classifier-gated by `runCheck`.
- Sandbox/dependency-healing behavior is unchanged.

Example:

```ts
const check: CheckConfig = {
  command: `node --import tsx --test ${quotedFiles}`,
  timeoutMs: 180000,
};
await runCheck("targeted:unit", check, opts);
```

If the composed command is denied by the classifier, targeting is refused and fallback check is used.

## Solve Loop Integration

After each agent attempt:

1. Determine changed files:
   - prefer `writeTracker` for live session changes
   - fallback to git diff when available
2. Build `TestTargetPlan`.
3. If mode is `suggest`, include suggestions in the retry prompt/telemetry but run the configured check.
4. If mode is `targeted-first`:
   - run targeted commands when confidence >= threshold
   - if targeted fails, feed targeted failure summary back immediately
   - if targeted passes and `runFullAfterTargetedPass` is true, run fallback full check
   - if confidence below threshold, skip targeted and run fallback check
5. Record target plan and results in solve telemetry.

Important: targeted pass does not mean final solved unless the configured policy says it is enough.
Delegated worker apply should still rely on its configured check/global checks unless explicitly allowed.

## Delegation Integration

For delegated workers:

- Worker `checkName` remains authoritative.
- Optional worker field later: `targetingMode`.
- The runner can use targeted checks as a pre-check to fail fast, then run the worker's normal check.
- Run artifacts include the target plan.

Never mark a worker `passed` solely from a low-confidence targeted check.

Suggested policy:

- `targeted-first` may speed retries inside `--solve`.
- final worker status still requires `worker.checkName` unless the worker explicitly declares a high-confidence targeted check as its check.

## CLI and Slash Commands

Add:

```text
/tests target [changed-file...]
/tests plan [changed-file...]
/tests run-targeted [changed-file...]
```

Behavior:

- no args -> use current session `writeTracker` / git diff changed files
- `target` -> print candidate tests only
- `plan` -> print confidence, command(s), fallback decision
- `run-targeted` -> execute targeted commands through `runCheck`

Existing `/index tests <file>` remains as a low-level query.

## Telemetry

Extend solve/delegation telemetry:

```ts
targeting?: {
  enabled: boolean;
  mode: string;
  confidence: TargetConfidence;
  changedFiles: string[];
  targetFiles: string[];
  commands: string[];
  fallbackRequired: boolean;
  fallbackCheck?: string;
  targetedRunIds: string[];
  fallbackRunId?: string;
}
```

Statusline/SDK can later surface:

```text
tests targeted 3 files · confidence high · fallback phase skipped
```

## Safety Rules

- Targeting is advisory unless configured as final oracle.
- Full fallback remains available and should be default for delegation apply.
- Low/no confidence always falls back.
- Generated/vendor/sensitive files do not produce targeted commands; they force fallback.
- File paths are quoted; no shell interpolation from model text.
- Target templates come from config, not the model.
- The model cannot choose arbitrary check commands through this feature.

## Files

New:

- `src/checks/testTargetPlanner.ts`
- `src/checks/targetedCheck.ts`
- `test/adversarial/test-targeting-runner.test.ts`

Edit:

- `src/config/config.ts`
- `src/config/fileConfig.ts`
- `src/cli/slashCommands.ts`
- `src/cli/solveRunner.ts`
- `src/solve/solver.ts` if planner needs core-loop awareness
- `src/delegate/workerRunner.ts` for run artifacts / pre-check integration later
- `src/session/checkRuns.ts` if targeted metadata belongs in check records

## Tests

No live model required.

1. Changed test file produces high-confidence target.
2. Reverse-import impacted test produces high-confidence target.
3. Naming convention produces medium-confidence target.
4. Path rule produces medium-confidence target.
5. No targets produces `fallbackRequired:true`.
6. Sensitive/generated changed file forces fallback.
7. Command template quotes file paths safely.
8. Classifier-denied targeted command falls back, does not run.
9. Target count is capped.
10. `/tests plan` output is bounded and deterministic.
11. Solve telemetry records target plan and run ids.
12. Delegated worker is not marked passed from low-confidence targeted-only result.

## Rollout

### 10H.1 — Pure Planner

- Build target plans from changed files and repo index.
- Add confidence/reason reporting.

### 10H.2 — Slash Commands

- Add `/tests target|plan` read-only commands.
- No automatic execution yet.

### 10H.3 — Targeted Check Runner

- Compose ephemeral checks and run through `runCheck`.
- Add `/tests run-targeted`.

### 10H.4 — Solve Loop Targeted-First

- Add opt-in targeted-first mode for solve attempts.
- Persist telemetry.

### 10H.5 — Delegation Pre-checks

- Add targeted pre-check for worker retries.
- Keep authoritative final check unchanged by default.

## Acceptance Criteria

- With targeting disabled, behavior is unchanged.
- `/tests plan` gives deterministic suggestions for changed files.
- Targeted checks run through existing sandbox/classifier/check logging.
- Low-confidence or unsafe targeting falls back to configured full check.
- Solve telemetry records targeting decisions.
- No model-provided command string is executed.
- `npm run typecheck` and `npm run test:phase` pass.

## Open Questions

- Should `targeted-first` become default for local interactive solve after enough bench data?
- Should language command templates be built-in per package manager or config-only?
- Should targeted pass plus quality gate be enough for delegated worker `passed` in small pure tasks?
- Should semantic search contribute test targeting signals later?
