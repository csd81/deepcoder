# Deepcoder Phase 9J - In-Loop Read-Only LLM Quality Gates

## Context

Deepcoder already has several layers that evaluate worker output:

- deterministic patch validation (`src/delegate/patchValidator.ts`),
- deterministic completeness gates (`src/delegate/completeness.ts`),
- read-only reviewer subagent profile (`src/subagents/profiles.ts`),
- explicit apply gate (`src/delegate/apply.ts`),
- local-bench quality flags.

The current gap is timing. Today a generated patch can reach expensive checks
before any model-based peer review sees it. If a patch is obviously empty,
syntactically malformed, imports a non-existent symbol, edits the wrong file, or
misses the requested deliverable, the sandbox/check loop may waste API and CPU
trying to repair something that should have been rejected earlier.

Phase 9J adds an in-loop read-only quality gate: after a worker produces a patch
but before expensive test execution or apply eligibility, a deterministic
reviewer subagent inspects the patch and relevant files, then can only downgrade
the patch to "needs revision" or "blocked". It cannot approve unsafe output over
deterministic failures.

## Goal

Add a mandatory, read-only LLM peer-review gate for generated patches in
delegated-worker flows.

```text
worker produces patch
  -> deterministic patch/completeness checks
  -> read-only reviewer subagent quality gate
  -> only then expensive tests / apply eligibility
```

Primary purpose:

- catch obvious bad patches before test/check execution,
- prevent infinite repair loops on empty or nonsensical changes,
- surface high-signal reviewer findings in `/delegate review`.

## ROI

Medium-high.

Why it helps:

- saves expensive check/runtime cycles,
- catches "green but bad" and "can't possibly compile" issues early,
- reuses existing read-only reviewer infrastructure,
- improves delegated-worker reliability without giving reviewers write/execute
  power.

Why it is not purely deterministic:

- LLM reviewers can be wrong,
- they must never override deterministic safety gates,
- their output must be bounded, parsed, and treated as advisory/downgrade-only.

## Non-Goals

- Do not let the reviewer edit files.
- Do not let the reviewer run shell commands.
- Do not let the reviewer apply patches.
- Do not use reviewer output as trusted assistant history.
- Do not make the reviewer a general autonomous worker.
- Do not block ordinary one-shot non-delegated runs in v1.

## Gate Semantics

The reviewer can only downgrade.

```text
deterministic fail -> fail, reviewer not needed
deterministic pass + reviewer pass -> quality_passed
deterministic pass + reviewer finding high/critical -> quality_blocked
deterministic pass + reviewer error/timeout -> configurable: block by default
```

The reviewer cannot convert a deterministic failure into a pass.

## Where It Runs

Initial scope: delegated workers only.

Integration point:

```text
src/delegate/workerRunner.ts
```

After patch extraction and before the run is recorded as `passed`, call the
quality gate if enabled.

Later integrations:

- local-bench quality review,
- solve loop before running expensive checks,
- pre-apply reviewer pass.

## Config

Add config:

```json
{
  "delegate": {
    "qualityGate": {
      "enabled": true,
      "mode": "mandatory",
      "blockOnReviewerError": true,
      "minimumBlockingSeverity": "high",
      "maxPatchBytes": 80000,
      "maxContextBytes": 24000
    }
  }
}
```

V1 may use env-only gates if delegate config plumbing is not ready:

```bash
DEEPCODER_DELEGATE_QUALITY_GATE=1
DEEPCODER_DELEGATE_QUALITY_GATE_BLOCK_ON_ERROR=1
```

Default recommendation:

- off for ordinary CLI,
- on for `/delegate run` once tests are stable,
- mandatory before auto-apply if auto-apply is ever enabled.

## Data Model

Extend `WorkerRun`:

```ts
interface WorkerQualityGate {
  enabled: boolean;
  passed: boolean;
  blocked: boolean;
  reviewerProfile: "reviewer";
  model: string;
  startedAt: string;
  finishedAt?: string;
  findings: QualityFinding[];
  errors: string[];
  trace: {
    toolsCalled: string[];
    turns: number;
  };
  artifactPath?: string;
}

interface QualityFinding {
  severity: "critical" | "high" | "medium" | "low";
  claim: string;
  evidence?: string;
  path?: string;
}
```

Add to `WorkerRun`:

```ts
qualityGate?: WorkerQualityGate;
```

Persist raw parsed gate output under:

```text
.deepcoder/delegations/<plan>/runs/<worker>/quality-gate.json
```

Do not add reviewer output to model-visible session history.

## Reviewer Prompt

Create a specialized quality-review prompt, not a generic `/review`.

Inputs:

- worker task title/prompt,
- allowed/forbidden paths,
- changed file list,
- patch summary,
- bounded patch text,
- deterministic validation/completeness results,
- relevant file snippets only if needed and read through read-only tools.

Output contract:

```json
{
  "summary": "short verdict",
  "verdict": "pass | needs_revision | block",
  "findings": [
    {
      "severity": "critical | high | medium | low",
      "claim": "specific issue",
      "evidence": "file:line or patch hunk",
      "path": "optional/path.ts"
    }
  ],
  "suggestedNextSteps": ["bounded suggestions"]
}
```

Blocking rules:

- `verdict === "block"` blocks,
- any finding at or above `minimumBlockingSeverity` blocks,
- malformed output blocks if `blockOnReviewerError` is true,
- max turns / abort blocks if `blockOnReviewerError` is true.

## Reviewer Capabilities

Use the existing `reviewer` profile with the current restricted read-only tools:

```text
read_file, grep, glob, list_dir, repo_map, find_symbols, list_recent_context
```

No:

- `run_bash`,
- `edit_file`,
- `write_file`,
- `todo_write`,
- MCP,
- checkpoints,
- config changes.

The reviewer runs under `mode: "readonly"` and `approve: () => false`, matching
existing subagent hardening.

## Fast Pre-LLM Deterministic Guards

Before calling the reviewer, run cheap deterministic guards. These prevent API
spend on patches that are obviously invalid:

- empty patch,
- patch too large,
- generated-artifact path,
- sensitive path,
- out-of-scope path,
- forbidden path,
- missing required deliverable,
- malformed self-audit.

If any deterministic guard fails, skip reviewer and record:

```text
qualityGate: skipped_deterministic_failure
```

## Integration With Checks

Two possible modes:

### Mode A - Before Expensive Check

Order:

```text
worker edits
extract patch
deterministic guards
LLM quality gate
configured check
record passed/failed
```

Benefit: saves test/sandbox runtime.

Risk: reviewer may block a patch that tests would have passed.

### Mode B - Before Apply Only

Order:

```text
worker edits
configured check
deterministic guards
LLM quality gate
apply eligibility
```

Benefit: less likely to block useful patches before test signal.

Risk: does not save check runtime.

Chosen v1: **Mode B for first implementation**, then optional Mode A once stable.

Reason: existing `workerRunner` currently treats child `--solve --check` exit
code as the check signal. Reordering the child check would require deeper solve
loop changes. Before-apply reviewer gating gives most safety value without
changing the solver loop.

Follow-up: a solver-native pre-check reviewer can run before expensive checks.

## Files

New:

```text
src/delegate/qualityGate.ts
test/adversarial/delegate-quality-gate.test.ts
```

Edit:

```text
src/delegate/types.ts
src/delegate/workerRunner.ts
src/delegate/apply.ts
src/cli/slashCommands.ts
src/subagents/profiles.ts     (optional prompt/profile tweak only)
src/config/config.ts          (if config-gated in v1)
src/config/fileConfig.ts      (if config-gated in v1)
```

## `qualityGate.ts`

Core API:

```ts
export interface RunQualityGateInput {
  workspaceRoot: string;
  provider: ModelProvider;
  parentModel: string;
  subagentModel?: string;
  compactAt: number;
  signal: AbortSignal;
  task: WorkerTask;
  patchText: string;
  changedFiles: string[];
  deterministicSummary: string;
  options: QualityGateOptions;
}

export async function runQualityGate(
  input: RunQualityGateInput,
): Promise<WorkerQualityGate>;
```

Test seam:

```ts
reviewerRunner?: typeof runSubagent
```

so no live model is needed for acceptance.

## Apply Gate

`applyWorker` must refuse if:

- `worker.status !== "passed"`,
- run check did not pass,
- deterministic patch validation fails,
- completeness fails,
- quality gate exists and `blocked === true`,
- quality gate required but missing.

Error message should distinguish:

```text
quality gate blocked: high finding: missing import ./foo
quality gate missing: run /delegate review --quality or rerun worker
```

## CLI UX

### `/delegate review`

Show quality gate status:

```text
quality gate: blocked
reviewer: reviewer · model deepseek-chat · 4 turns
findings:
  high src/foo.ts:12 missing import for parseConfig
```

### `/delegate audit`

If audit command exists or is added later, include:

- deterministic gates,
- reviewer findings,
- whether blocking is due to deterministic or LLM review.

### Manual rerun

Optional command:

```text
/delegate review <plan-id> <worker-id> --quality
```

Runs reviewer gate over an existing patch without rerunning the worker.

## Tests

No live model required. Use fake reviewer runner outputs.

1. reviewer pass -> qualityGate.passed true, not blocked.
2. high finding -> blocked.
3. critical finding -> blocked.
4. medium finding with threshold high -> not blocked.
5. malformed reviewer output -> blocked when `blockOnReviewerError`.
6. reviewer timeout/error -> blocked when `blockOnReviewerError`.
7. reviewer timeout/error -> warning only when configured not to block.
8. deterministic failure skips reviewer.
9. reviewer cannot override deterministic failure.
10. quality gate output is persisted to `quality-gate.json`.
11. `applyWorker` refuses blocked quality gate.
12. `applyWorker` refuses missing quality gate when mandatory.
13. `applyWorker` allows passed quality gate.
14. reviewer registry contains only read-only native tools.
15. hostile reviewer output is displayed as untrusted review, not injected into
    parent model history.
16. large patch is truncated before reviewer prompt.
17. finding evidence/path strings are bounded.
18. `/delegate review` renders bounded findings.

## Acceptance

Required:

```bash
npm run typecheck
npm run test:phase
```

No live model required.

Manual no-model smoke:

1. Create a fake worker run with a patch.
2. Inject fake reviewer pass -> apply gate permits.
3. Inject fake reviewer high finding -> apply gate refuses.
4. Confirm quality-gate artifact is written.

Optional live smoke:

1. Run a small delegated worker.
2. Run quality review on the patch.
3. Confirm reviewer findings are shown in `/delegate review`.
4. Do not auto-apply.

## Safety Rules

- Reviewer is downgrade-only.
- Reviewer is read-only.
- Reviewer output is untrusted.
- Reviewer output is bounded.
- Reviewer cannot run checks.
- Reviewer cannot request apply.
- Reviewer cannot suppress deterministic failures.
- Reviewer failure blocks by default when mandatory.

## Risks

### False Positives

Reviewer may block a valid patch.

Mitigation:

- start as apply-time gate, not pre-check gate,
- severity threshold defaults to high,
- manual override can be considered later, but not v1.

### Extra API Cost

Every worker patch costs one extra model call.

Mitigation:

- skip reviewer on deterministic failures,
- truncate patch/context,
- use cheaper subagent model by config,
- cache quality result by patch SHA.

### Prompt Injection

Patch/file content can tell reviewer to ignore instructions.

Mitigation:

- existing subagent boundary prompt,
- read-only mode,
- no parent-history persistence,
- output parsed and displayed as untrusted metadata.

### Incomplete Coverage

Reviewer may miss syntax/import issues.

Mitigation:

- do not replace tests,
- use as early downgrade filter only,
- keep deterministic and sandbox checks.

## Implementation Order

1. Add `WorkerQualityGate` types.
2. Add pure parser/normalizer for reviewer verdicts.
3. Add `runQualityGate` with fake-runner seam.
4. Persist `quality-gate.json`.
5. Wire `applyWorker` to refuse blocked/missing mandatory quality gate.
6. Render quality status in `/delegate review`.
7. Add adversarial tests.
8. Optional: add manual `/delegate review --quality`.
9. Update Phase 9 docs.
10. Run full gate.

## Definition of Done

- A worker patch can be marked blocked by a read-only reviewer gate.
- Blocked patches cannot be applied.
- Reviewer failures are fail-closed when mandatory.
- Deterministic failures skip reviewer and remain blocking.
- Reviewer output is persisted and rendered, but never trusted as model history.
- The full gate passes without a live model.
