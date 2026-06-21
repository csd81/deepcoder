# Phase 10C — Status Line and Cost Telemetry

## Context

Deepcoder already normalizes provider token usage (`src/providers/usage.ts`) and accumulates it
per session (`Session.tokenUsage`, `/usage`). The solve loop, checks, delegation, sandbox, MCP,
workspace isolation, and preflight systems also expose useful runtime state, but it is scattered
across slash commands and logs.

This phase adds a compact status line and richer cost/token telemetry so long-running sessions,
delegated worker runs, and future TUI/server integrations can show the important state at a
glance: model/provider, mode, sandbox, workspace isolation, git dirtiness, current check/solve
attempt, token usage, estimated cost, and warnings.

The feature should be useful in today's plain CLI and directly reusable by Phase 10A's scrollable
TUI and Phase 10B's SDK/server event stream.

## Goals

- Show a concise, continuously available status line in interactive mode.
- Add provider-aware cost estimation from normalized token usage.
- Persist session usage/cost totals so resumed sessions retain accurate accounting.
- Emit structured telemetry events for SDK/server/TUI consumers.
- Add slash commands for detailed usage/cost/status inspection.
- Keep secrets out of status, logs, telemetry, and persisted session files.

## Non-goals

- No billing API integration.
- No exact invoice reconciliation. Costs are estimates from configured/static rates.
- No remote telemetry upload.
- No live dashboard or web UI.
- No dependency on the Phase 10A TUI implementation.

## Display Scope

The status line should include only high-value, bounded fields:

```text
model deepseek-chat · ask · sandbox fast/offline · iso off · git +3/-1 · tok 42.1k · ~$0.03 · check unit:pass · ctx 38%
```

Suggested fields:

- `provider/model`
- approval mode: `ask | auto | readonly`
- sandbox mode + network state
- workspace isolation mode/path hint
- git dirty summary when cheap to compute
- active check / solve attempt state
- MCP warning count
- active skills count
- token total and context budget percentage
- estimated session cost
- last warning marker, when present

The line must degrade gracefully when a field is unavailable.

## Cost Model

New module:

`src/providers/pricing.ts`

Static rate table keyed by provider + model pattern:

```ts
export interface ModelPricing {
  provider: string;
  modelPattern: string;
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  effectiveDate: string;
  source?: string;
}

export interface CostEstimate {
  inputUsd: number;
  outputUsd: number;
  totalUsd: number;
  pricingKnown: boolean;
  rateLabel: string;
}
```

Rules:

- Unknown model/provider returns `pricingKnown:false` and never throws.
- Pricing can be overridden locally in `.deepcoder/config.json`.
- Never fetch pricing from the web at runtime.
- Include an explicit `effectiveDate` so stale rates are visible.

Config extension:

```json
{
  "telemetry": {
    "statusline": true,
    "costs": true,
    "pricing": [
      {
        "provider": "deepseek",
        "modelPattern": "deepseek-chat",
        "inputPerMillionUsd": 0.27,
        "outputPerMillionUsd": 1.10,
        "effectiveDate": "2026-06-20"
      }
    ]
  }
}
```

Default rates should be conservative and clearly labeled as estimates. If rates are not known,
show tokens only.

## Session Telemetry State

New module:

`src/telemetry/sessionTelemetry.ts`

```ts
export interface SessionTelemetry {
  startedAt: string;
  updatedAt: string;
  provider: string;
  model: string;
  usage: TokenUsage;
  estimatedCost?: CostEstimate;
  modelCalls: number;
  toolCalls: number;
  checkRuns: number;
  warnings: TelemetryWarning[];
}
```

`Session` gains:

```ts
telemetry: SessionTelemetry;
```

The existing `tokenUsage` can either remain for compatibility or become a view into
`session.telemetry.usage`. Avoid duplicating mutation paths long-term.

Persist telemetry in session snapshots:

- `usage`
- `modelCalls`
- `toolCalls`
- `estimatedCost` metadata
- warning summaries

Back-compat: old sessions without telemetry load with zero/default state.

## Status Snapshot

New module:

`src/telemetry/statusSnapshot.ts`

```ts
export interface StatusSnapshot {
  provider: string;
  model: string;
  mode: string;
  sandbox: string;
  sandboxNetwork: "on" | "off" | "unknown";
  workspaceIsolation: string;
  git?: { branch?: string; dirtyFiles?: number; ahead?: number; behind?: number };
  usage: TokenUsage;
  cost?: CostEstimate;
  contextPercent?: number;
  activeCheck?: string;
  activeSolveAttempt?: { index: number; max: number };
  mcpWarnings: number;
  activeSkills: number;
  warnings: string[];
}
```

Snapshot generation must be cheap and never throw. Git status should be cached/throttled in the
interactive loop so a prompt redraw does not run `git status` repeatedly.

## Plain CLI Integration

In the current line-oriented REPL:

- Print a status line after each assistant turn and after each check/solve attempt.
- Keep it dim and single-line by default.
- Respect `DEEPCODER_STATUSLINE=off` or config `telemetry.statusline:false`.
- Do not repaint the terminal; the scrollable TUI will handle live redraw later.

Add slash commands:

- `/usage` — keep existing token summary, add cost estimate and model-call count.
- `/cost` — detailed cost breakdown by provider/model and known/unknown pricing state.
- `/statusline [on|off]` — toggle for the current session and write to config only if explicitly requested later.
- `/telemetry` — compact structured summary: model calls, tool calls, checks, warnings.

Existing `/status` remains git-focused.

## TUI Integration

Phase 10A can render `StatusSnapshot` directly:

- fixed bottom status bar
- transient warning badge
- active solve/check spinner
- token/cost view

This phase should not depend on Ink or any TUI library. It only provides the data model and plain
CLI rendering.

## SDK/Server Integration

Phase 10B can emit telemetry events:

```ts
{ type: "telemetry.updated", snapshot: StatusSnapshot }
{ type: "usage", usage: TokenUsage, cost?: CostEstimate }
```

This phase should define these event shapes now if the SDK event module already exists; otherwise
keep them documented and implementable later.

## Provider Requirements

Provider adapters already normalize usage for:

- OpenAI-compatible streaming/non-streaming
- OpenAI Responses
- Gemini 3.x where usage is available

This phase should add tests proving usage propagation is preserved across all supported provider
adapters with fake response objects. Missing provider usage should not break status/cost; it should
show `tok unknown` or omit the token portion.

## Warning Sources

Status warnings should include bounded summaries from:

- MCP connection failures
- sandbox fallback to local
- workspace isolation disabled/failing
- unknown pricing
- check timeout
- provider usage unavailable
- dirty tree when a feature requires clean tree

Warnings are advisory. They should never block execution.

## Files

New:

- `src/telemetry/sessionTelemetry.ts`
- `src/telemetry/statusSnapshot.ts`
- `src/telemetry/statusline.ts`
- `src/providers/pricing.ts`
- `test/adversarial/statusline-telemetry.test.ts`

Edit:

- `src/config/config.ts`
- `src/config/fileConfig.ts`
- `src/cli/repl.ts`
- `src/cli/slashCommands.ts`
- `src/cli/solveRunner.ts`
- `src/agent/agentLoop.ts` only if model-call telemetry cannot be captured through existing `onUsage`
- `src/session/sessionStore.ts`
- provider adapter tests if needed

## Tests

No live model required.

1. `parseUsage` + `addUsage` still accumulate correctly.
2. Cost estimate returns known cost for a configured model.
3. Unknown pricing returns `pricingKnown:false` and never throws.
4. Status snapshot redacts warning text and never includes API keys.
5. Status snapshot generation survives git failures.
6. Statusline renderer stays one line and under a byte cap.
7. `/usage` prints tokens + cost without leaking secrets.
8. `/cost` distinguishes known vs unknown pricing.
9. Session telemetry persists and resumes.
10. Old session snapshots without telemetry load successfully.
11. Solve/check events update active check/attempt status.
12. Statusline can be disabled by env/config.

Manual smoke:

```bash
npm run test:phase
node dist/cli/main.js --mode readonly "summarize src/providers/usage.ts"
node dist/cli/main.js
# run /usage, /cost, /telemetry, /statusline off
```

## Rollout

### 10C.1 — Cost Estimator

- Add provider/model pricing table and config override.
- Add pure tests.

### 10C.2 — Session Telemetry

- Replace ad-hoc token accumulation with `SessionTelemetry`.
- Persist/resume telemetry.

### 10C.3 — Status Snapshot + Plain Renderer

- Build `StatusSnapshot` and one-line renderer.
- Add `/cost` and `/telemetry`.

### 10C.4 — Solve/Check/Delegation Signals

- Feed active check/solve/delegate state into snapshots.
- Add warnings for timeouts/fallbacks.

### 10C.5 — TUI/SDK Readiness

- Export stable snapshot/event types for Phase 10A/10B.
- Document integration points.

## Acceptance Criteria

- Existing `/usage` behavior is preserved and enhanced.
- Statusline is opt-out and bounded.
- Cost is clearly labeled as estimate and omitted when unknown.
- Telemetry persists across session resume.
- No secrets appear in rendered status, slash output, session telemetry, or tests.
- `npm run typecheck` and `npm run test:phase` pass.

## Open Questions

- Should pricing defaults be bundled, or should all cost display require explicit config?
- Should statusline be enabled by default before Phase 10A lands?
- Should delegated worker telemetry roll up into the parent session cost, or stay in worker run artifacts only?
- Should context-percent use approximate local token counting or only provider-reported prompt tokens?
