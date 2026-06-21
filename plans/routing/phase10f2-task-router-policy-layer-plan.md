# Phase 10F2 — Task Router Policy Layer

## Context

Phase 10F shipped a role-based model router:

- `edit`, `plan`, `review`, `research`, `triage`, `explore`, `delegate`, `qualityGate`,
  `summarize`, and `fallback` resolve to provider/model routes.
- Subagents and delegated workers can use role-specific routes.
- Provider instances are cached by `(provider, baseUrl)`.
- Default behavior preserves the old single-model path.

That is useful, but it is not yet an efficiency optimizer. Routes are static and manually
configured. There is no policy layer that chooses cheaper or stronger models based on task
complexity, risk, expected tool use, or budget.

## Goal

Add a deterministic task-router policy layer that maps an invocation to the cheapest safe
model route before the provider call.

The router should answer:

- What role is this call?
- Is the task simple, normal, or hard?
- Is it read-only or mutating?
- Is it safety-sensitive?
- Is a cheap model acceptable?
- Which configured route should run, and why?

## Non-Goals

- No autonomous model benchmarking.
- No hidden provider calls just to classify complexity.
- No automatic retry/fallback for mutating edit calls in this phase.
- No weakening of permission, sandbox, or workspace-isolation policy.
- No routing decisions based on secrets or raw provider keys.

## Design

### 1. Add Task Routing Types

New module:

```text
src/models/taskRouter.ts
```

Core types:

```ts
export type TaskComplexity = "simple" | "normal" | "hard";
export type TaskRisk = "low" | "medium" | "high";

export interface TaskRouteRequest {
  role: ModelRole;
  prompt?: string;
  toolCount?: number;
  mutating?: boolean;
  readonly?: boolean;
  safetySensitive?: boolean;
  expectedFiles?: string[];
  estimatedInputTokens?: number;
}

export interface TaskRouteDecision {
  requestedRole: ModelRole;
  selectedRole: ModelRole;
  complexity: TaskComplexity;
  risk: TaskRisk;
  route: ResolvedModelRoute;
  reason: string[];
}
```

### 2. Deterministic Complexity Heuristic

No model call. Pure function.

Inputs:

- prompt length,
- number of expected files,
- role,
- mutating vs read-only,
- safety-sensitive flag,
- keywords such as `refactor`, `security`, `architecture`, `race`, `migration`,
  `multi-file`, `SWE-bench`, `benchmark`, `sandbox`, `permission`.

Rules:

- short read-only summaries → `simple`
- normal edit / one-file task → `normal`
- security, sandbox, delegation, concurrent orchestration, migrations, or many files → `hard`
- mutating tasks are never downgraded below `normal`
- safety-sensitive tasks are always `hard`

### 3. Policy Mapping

New optional config block:

```json
{
  "models": {
    "policy": {
      "enabled": false,
      "simpleRole": "summarize",
      "normalRole": "edit",
      "hardRole": "plan",
      "readOnlySimpleRole": "summarize",
      "safetyRole": "review"
    }
  }
}
```

Default:

- disabled,
- current role-based routing remains byte-identical.

When enabled:

- read-only simple calls can route to `summarize`,
- normal mutating calls route to `edit`,
- hard planning/decomposition calls route to `plan`,
- safety-sensitive review calls route to `review`,
- delegate workers route through `delegate` unless explicit policy says otherwise.

### 4. Explainability

Add slash command:

```text
/models explain
/models why <role> [prompt]
```

Behavior:

- `/models explain` shows current static routes plus policy status.
- `/models why edit "fix bug"` shows:
  - requested role,
  - selected role,
  - provider/model,
  - complexity,
  - risk,
  - reason bullets.

Bounded output, no secrets.

### 5. Integration Points

Wire policy decisions into:

- one-shot edit turn,
- subagent runner,
- context explorer,
- model-driven decomposer,
- delegated worker model override,
- compaction/summarization once that path has an explicit route seam.

Do not change:

- permission policy,
- tool availability,
- sandbox settings,
- workspace isolation,
- apply gates.

### 6. Telemetry

Record route decisions in session telemetry:

```ts
{
  requestedRole,
  selectedRole,
  provider,
  model,
  source,
  complexity,
  risk,
  reason,
  timestamp
}
```

Do not record:

- API keys,
- full prompt text,
- unbounded user content.

## Safety Rules

- Default off.
- Routing can only change model/provider, never tool permissions.
- Mutating roles cannot silently fall back to weaker read-only roles.
- Read-only roles may downgrade to cheaper models.
- Safety-sensitive tasks may upgrade to stricter models.
- Unknown config values fail closed to current static role behavior.

## Tests

Pure tests:

- short read-only prompt → simple,
- large/multi-file/security prompt → hard,
- mutating prompt never simple,
- safety-sensitive prompt always hard,
- disabled policy returns original role route,
- enabled policy maps simple read-only to summarize,
- enabled policy maps hard safety task to review/plan,
- decision output contains no API key.

Integration tests:

- `DEEPCODER_MODEL_SUMMARIZE` is used for simple read-only route when policy enabled,
- `DEEPCODER_MODEL_EDIT` remains used for normal edit route,
- delegate route override still pins worker subprocess env,
- `/models why` renders bounded explainable output,
- malformed policy config is ignored with a warning.

## Acceptance

- `npm run typecheck`
- `npm run test:phase`
- Existing model-router tests remain green.
- With policy disabled, route behavior is unchanged.
- With policy enabled, route decisions are explainable and covered by tests.

## Follow-Ups

- Cost-aware routing using live provider pricing.
- Per-project routing profiles such as `cheap`, `balanced`, `quality`.
- Dynamic fallback for read-only roles only.
- Route telemetry rollups: model spend by role.
- TUI status line showing current route/model for active calls.
