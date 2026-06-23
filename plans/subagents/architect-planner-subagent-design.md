# Design: `architect` planner subagent

**Date:** 2026-06-23
**Status:** Approved design (pre-implementation)
**Author:** brainstorming session

## Problem

Deepcoder has five read-only subagent profiles (`reviewer`, `researcher`,
`testTriage`, `explorer`, `verifier`) but **no dedicated planning/architect
subagent**. Implementation plans are produced inline by the main agent rather
than by a bounded, read-only architect profile. This is the most notable gap
versus Claude Code's `Plan` agent: there is no first-class way to turn a task
into a structured, dependency-aware implementation plan that the main agent can
then execute against.

## Goals

- Add a read-only `architect` subagent that turns a task into a structured plan.
- Expose it as a `/plan <task>` slash command (mirrors `/explore`).
- Compose it with the existing explorer: explorer gathers evidence, planner
  consumes that `ExplorerBrief` and produces a `PlanBrief`.
- Emit a **dependency DAG** of steps (each step lists `dependsOn[]`).
- Persist the resulting plan to `plans/`.
- Phase 2: wire the same flow into the `/solve` loop so the agent executes
  against a generated plan.

## Non-goals

- The planner does NOT edit, write, run commands, or call MCP tools. It is
  strictly read-only, consistent with every existing profile and the project's
  safety-first convention.
- No automatic parallel execution of the DAG in Phase 1/2 — the `dependsOn[]`
  edges are produced and validated, but execution remains sequential for now.
- No new model role: `"plan"` already exists in the `ModelRole` union.

## Key decisions (from brainstorming)

1. **Integration:** Both — ship `/plan` command first (Phase 1), then wire into
   the `/solve` loop (Phase 2).
2. **Context source:** Compose — run the explorer first, feed its
   `ExplorerBrief` into the planner.
3. **Output shape:** `PlanBrief` with ordered steps, each carrying explicit
   `dependsOn[]` (a DAG).
4. **Persistence:** Strictly read-only planner; `/plan` persists the rendered
   `PlanBrief` to `plans/`. Solve-loop usage also persists.

## Architecture

All pieces mirror the explorer (`profiles.ts` / `contextExplorer.ts` /
`explorerBrief.ts` / `/explore` command).

| Piece | File | Role |
|---|---|---|
| Profile | `src/subagents/profiles.ts` | `architect` profile, `role: "plan"`, read-only tools; add to `PROFILES` |
| Schema + parse/render + DAG validation | `src/context/planBrief.ts` *(new)* | `PlanBrief`/`PlanStep` types, `parsePlanBrief` (never throws), `renderPlanBrief` (bounded) |
| Runner | `src/subagents/contextPlanner.ts` *(new)* | `runPlanner(task, explorerBrief, opts)` → `{ plan, trace }`; safe empty plan on any failure |
| Flow + persistence | `src/subagents/planFlow.ts` *(new)* | orchestrate explorer→planner, write `PlanBrief` to `plans/` |
| CLI surface | `src/cli/slashCommands.ts`, `src/cli/slashCatalog.ts`, `src/cli/tuiSlashRouting.ts` | `/plan <task>` command, catalog entry, TUI suspend |

### Profile (`src/subagents/profiles.ts`)

```ts
export const architect: SubagentProfile = {
  name: "architect",
  purpose:
    "Given a task and an explorer brief, produce a concrete, dependency-aware " +
    "implementation plan. Read-only: do not edit, run, or propose unverifiable steps.",
  allowedTools: [
    "read_file", "list_dir", "grep", "glob", "repo_map",
    "find_symbols", "list_recent_context", "repo_index",
    "find_references", "impact_graph", "target_tests",
  ], // same read-only set as explorer
  maxTurns: 10,
  contextBudgetTokens: 48000,
  role: "plan",
  outputGuidance:
    "Return a single JSON PlanBrief: summary, orderedSteps[] (each with id, " +
    "description, filesToTouch[], testsToAddOrRun[], rationale, dependsOn[]), " +
    "risks[], assumptions[], openQuestions[]. dependsOn must reference earlier step ids. " +
    "No cycles. Be concrete and bounded.",
};
```

Add `architect` to `PROFILES`.

### Schema (`src/context/planBrief.ts`)

```ts
export interface PlanStep {
  id: string;                 // stable, e.g. "s1"
  description: string;
  filesToTouch: string[];
  testsToAddOrRun: string[];
  rationale: string;
  dependsOn: string[];        // ids of prerequisite steps (DAG edges)
}
export interface PlanBrief {
  summary: string;
  orderedSteps: PlanStep[];   // topologically sorted after validation
  risks: string[];
  assumptions: string[];
  openQuestions: string[];
  trace: SubagentTrace[];
}

export function parsePlanBrief(raw: string): PlanBrief; // NEVER throws
export function renderPlanBrief(brief: PlanBrief, maxBytes?: number): string;
```

`parsePlanBrief` contract (mirrors `parseExplorerBrief`):
- Never throws; returns an empty `PlanBrief` on any parse failure.
- Bounds and dedupes all list sizes.
- Assigns/normalizes step ids; drops steps without a description.
- **DAG validation:**
  - Drop `dependsOn` ids that reference a non-existent step (record as an
    `openQuestion`).
  - Detect cycles via topological sort; on a cycle, drop the offending
    back-edge and record it in `openQuestions`.
  - `orderedSteps` is returned in topological order.

`renderPlanBrief` returns bounded text (default ~6000 bytes, matching the
explorer renderer) for TUI display and for persistence.

### Runner (`src/subagents/contextPlanner.ts`)

`runPlanner(task, explorerBrief, opts)` mirrors `runExplorer`:
- Resolve model via `opts.modelRouter.resolve(architect.role ?? "plan")` with
  the existing provider-pool fallback.
- Build a task prompt embedding `renderExplorerBrief(explorerBrief)` plus the
  JSON output spec.
- `restrictedRegistry(architect.allowedTools)`, `runAgentLoop` in `readonly`
  mode, `mcpExecuteEnabled: false`, `approve: async () => false`.
- Parse output with `parsePlanBrief`. On any error → safe empty `PlanBrief`.
- Attach max-turns/abort notices to `openQuestions`. NEVER throws.

### Flow + persistence (`src/subagents/planFlow.ts`)

`runPlanFlow(task, opts)`:
1. `runExplorer(task, opts)` → `ExplorerBrief` (reused; failure yields an empty
   brief, planner still runs from the task alone).
2. `runPlanner(task, brief, opts)` → `PlanBrief`.
3. Persist `renderPlanBrief(plan)` to
   `plans/YYYYMMDD-HHMMSS-<slug>.md` using the `atomicWrite` pattern from
   `src/delegate/store.ts`. `<slug>` is a sanitized, length-capped slug of the
   task (path-escape-safe, `assertSafeId`-style).
4. Return `{ plan, explorerBrief, planPath, traces }`.

### CLI surface

- `src/cli/slashCommands.ts`: add a `case "plan":` mirroring `case "explore":`
  — abort/SIGINT handling, call `runPlanFlow`, render with `renderPlanBrief`,
  push to `session.plans` (new array, mirroring `session.briefs`), `save()`.
- `src/cli/slashCatalog.ts`: add
  `{ name: "plan", args: "<task>", description: "Run a read-only architect subagent and produce a dependency-aware implementation plan", category: "context" }`.
- `src/cli/tuiSlashRouting.ts`: add `"plan"` to `TUI_SUSPEND_SLASH`.
- Add `session.plans: { createdAt, plan, planPath, trace }[]` to the session
  type, mirroring `session.briefs`.

## Data flow

### `/plan <task>` (Phase 1)
```
task ──▶ runExplorer ──▶ ExplorerBrief
                            │
task + ExplorerBrief ───────▶ runPlanner ──▶ raw JSON ──▶ parsePlanBrief (DAG-validated)
                                                            │
                                                            ├─▶ renderPlanBrief ──▶ TUI
                                                            ├─▶ atomicWrite ──▶ plans/<ts>-<slug>.md
                                                            └─▶ session.plans.push(...)
```

### Solve loop (Phase 2)
Before the first `deps.runAgent()` attempt in `runSolveLoop`
(`src/solve/solver.ts:84`), after the repro phase:
1. `runPlanFlow(task, opts)` → persist plan.
2. Inject `renderPlanBrief(plan)` into `session.messages` as a context/system
   message so the agent executes against the plan.

Injection happens once, before attempt 1; retries reuse the same plan.

## Error handling & safety

- Planner is **strictly read-only** (no edit/write/run_bash/MCP). Same tool set
  as the explorer.
- Runner never throws → safe empty `PlanBrief`. Explorer failure still yields a
  (thin) plan from the task alone.
- DAG validation is enforced **in the parser**, never trusted from the model.
- Persistence writes only under `plans/` with a sanitized slug — no path escape.

## Testing

- `planBrief.test.ts`: parse happy path; malformed JSON → empty; dangling
  `dependsOn` dropped + noted; **cycle broken + noted**; topological order;
  render byte-bounds.
- `contextPlanner.test.ts`: runner returns safe empty plan on loop error;
  explorer brief is embedded in the prompt; uses `role: "plan"` routing.
- `planFlow.test.ts`: explorer→planner composition; persists to `plans/`;
  explorer failure still produces a plan; slug is path-safe.
- Phase 2: `solver` test that a plan is generated and injected before the first
  attempt, using a fake/no-op model path (infra acceptance must not require a
  live model).

## Phasing

- **Phase 1:** profile + `planBrief.ts` + `contextPlanner.ts` + `planFlow.ts` +
  `/plan` command + session wiring + tests.
- **Phase 2:** `/solve` loop injection + tests.

## Open questions

- Persistence format: rendered markdown (chosen) vs raw JSON sidecar. Markdown
  is human-reviewable and matches the `plans/` convention; a `.json` sidecar
  could be added later if the solve loop needs to re-parse a persisted plan
  rather than the in-memory `PlanBrief`.
- Whether `resolveDefault()` in `src/models/router.ts` already returns a usable
  mapping for `"plan"` or needs an explicit subagent-style case (verify during
  implementation).
