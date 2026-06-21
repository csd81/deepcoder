# Deepcoder Phase 8D - Context Planner and Explorer Subagent

## Goal

Add a bounded preflight workflow that gathers useful context before implementation without polluting the main conversation with raw search output.

Shape:

```text
task -> context plan -> read-only exploration -> cited brief -> main solve/implementation
```

This phase uses the instruction graph, memory store, and repo index from 8A-8C.

## Source Learnings

Claude and Codex both use subagents to keep high-volume exploration out of the main thread. Claude's docs explicitly recommend subagents for side tasks that would flood the main conversation with logs or file contents. Codex uses explorer/worker-style subagents and notes that subagents cost more tokens, so they should be explicit and bounded. Gemini emphasizes inspectable context via `/memory` and file context rather than opaque background state.

Deepcoder already has read-only subagents. Phase 8D turns that into a context-planning pipeline.

## Scope

In scope:

- explicit `/context-plan`,
- explicit `/explore`,
- optional `--preflight` for `--solve`,
- read-only explorer profile,
- cited context brief,
- telemetry for context usage,
- bounded context injection.

Out of scope:

- autonomous model-callable subagent spawning,
- parallel nested subagents,
- mutating explorer,
- MCP access in explorer v1,
- semantic search requirement,
- automatically editing based on explorer output without main-agent confirmation.

## Context Planner

The planner is a deterministic + optional model-assisted phase.

Inputs:

- user task,
- current instruction graph summary,
- memory summary,
- repo index summary,
- changed files,
- configured checks.

Output:

```ts
type ContextPlan = {
  taskSummary: string;
  likelyAreas: string[];
  initialQueries: string[];
  mustRead: string[];
  likelySymbols: string[];
  likelyChecks: string[];
  riskNotes: string[];
  stopConditions: string[];
};
```

The model-assisted planner should run with tools disabled and produce JSON. If parsing fails, fall back to deterministic repo-index heuristics.

## Explorer Subagent

Profile:

```text
name: explorer
mode: readonly
tools: read_file, list_dir, grep, glob, repo_index, find_references, impact_graph, target_tests, list_recent_context
model: DEEPCODER_EXPLORER_MODEL or subagent model or main model
maxTurns: 8
```

Explorer task:

```text
Given this ContextPlan, gather enough evidence to orient the main agent.
Return a compact cited brief.
Do not propose edits unless directly supported by file citations.
Do not dump file contents.
```

Explorer result:

```ts
type ExplorerBrief = {
  summary: string;
  relevantFiles: { path: string; reason: string; citations: string[] }[];
  likelyFixLocations: { path: string; confidence: "low" | "medium" | "high"; reason: string }[];
  relevantTests: { pathOrCommand: string; reason: string }[];
  risks: string[];
  openQuestions: string[];
  trace: SubagentTrace[];
};
```

Only the brief is injected into the parent. Raw tool results stay in subagent/session metadata.

## Commands

```text
/context-plan <task>
/explore <question>
/solve --preflight --check <name> <task>
```

`/context-plan`:

- prints the plan,
- does not read files beyond index/memory summaries unless asked.

`/explore`:

- runs the explorer and prints a cited brief,
- saves brief to session metadata,
- does not add raw trace to main conversation.

`--preflight`:

- runs context-plan + explorer before solve attempt 1,
- injects the compact brief as an ephemeral system/context message,
- records telemetry fields:
  - preflight enabled,
  - files cited,
  - explorer turns,
  - context bytes injected.

## Context Injection

Injected preflight message:

```text
Context preflight brief:
- Task summary: ...
- Likely fix locations:
  - src/foo.ts: reason
- Relevant tests:
  - npm run test:unit -- foo
- Risks:
  - permissions path touched

This is advisory. Verify by reading files before editing.
```

Rules:

- max bytes default `6000`,
- citations required for file claims,
- no raw logs,
- no secrets,
- not persisted as a permanent memory,
- included in session history only as compact brief, not raw exploration.

## Config

```json
{
  "context": {
    "preflight": false,
    "preflightMaxBytes": 6000,
    "explorerMaxTurns": 8,
    "explorerAllowBash": false,
    "explorerAllowMcp": false
  }
}
```

Env:

```text
DEEPCODER_CONTEXT_PREFLIGHT=1
DEEPCODER_EXPLORER_MODEL=...
```

## Files

New:

- `src/context/contextPlan.ts`
- `src/context/contextPlanner.ts`
- `src/context/explorerBrief.ts`
- `src/subagents/profiles/explorer.ts`
- `src/subagents/contextExplorer.ts`

Edited:

- `src/subagents/profiles.ts`
- `src/subagents/runner.ts`
- `src/solve/solver.ts`
- `src/cli/main.ts`
- `src/cli/repl.ts`
- `src/cli/slashCommands.ts`
- `src/solve/telemetry.ts`

Tests:

- `test/contextPlanner.test.ts`
- `test/adversarial/context-preflight.test.ts`

## Adversarial Tests

1. Explorer cannot mutate files.
2. Explorer cannot run bash by default.
3. Explorer cannot use MCP by default.
4. Explorer output with prompt injection is framed as advisory.
5. Raw subagent tool output is not inserted into parent history.
6. Preflight brief is bounded.
7. File claims without citations are dropped or flagged.
8. Preflight parse failure falls back to deterministic plan.
9. `--preflight` does not run if disabled.
10. Secrets in explorer output are redacted.
11. Explorer max-turn loop returns partial brief, not crash.
12. Context telemetry is written without raw file contents.

## Acceptance

No-model:

```bash
npm run typecheck
npm run test:phase
```

Fake-provider:

- context planner JSON success,
- malformed JSON fallback,
- explorer returns cited brief,
- solve receives compact preflight message.

Live smoke:

1. Run `/context-plan "fix checkpoint rollback conflict behavior"`.
2. Run `/explore "where is command policy enforced?"`.
3. Run one local-bench `repo-hard-*` case with and without `--preflight`.
4. Compare:
   - turns,
   - tool calls,
   - file reads,
   - attempts,
   - solved result.

Benchmark rule:

Preflight is useful only if it improves at least one of:

- fewer wasted reads/searches,
- fewer attempts,
- better solve rate on harder cases,
- better first edit location.

If it only adds latency, keep it opt-in.

## Rollout

Start as explicit commands only. Add `--preflight` for `--solve` after commands work. Do not default it on until local-bench shows benefit.

