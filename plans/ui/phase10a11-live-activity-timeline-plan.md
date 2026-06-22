# Phase 10A.11 — Live Activity Timeline

## Context

Deepcoder already emits structured UI events while work is running:

- `tool_start`
- `tool_result`
- `check_start`
- `check_output`
- `check_done`
- `worker_start`
- `worker_update`
- `worker_done`
- `approval_request`
- `approval_result`
- `assistant_delta`
- `assistant_done`
- `notice`

The TUI currently renders these as transcript blocks. That is useful for detail, but it does
not give the user a compact "what is happening right now" view during long turns, solve loops,
checks, or delegated-worker runs.

This phase adds a small live activity timeline above the composer.

## Goal

Show the latest active/completed work in a compact timeline:

```text
● thinking…
● read_file src/parser.ts
● edited 2 files
● check phase running…
✓ check phase passed 18.2s
● worker 2/5 running
```

The transcript remains the source of detailed logs. The timeline is just the current status
summary.

## Non-Goals

- No changes to model/tool/check execution.
- No new telemetry provider.
- No progress percentages unless the underlying event provides enough information.
- No persistent activity history.
- No complex animation in v1.

## Design

### 1. Activity Timeline State

New file:

```text
src/ui/activityTimeline.ts
```

Types:

```ts
export type ActivityKind =
  | "assistant"
  | "tool"
  | "check"
  | "worker"
  | "approval"
  | "notice";

export type ActivityStatus =
  | "running"
  | "passed"
  | "failed"
  | "done"
  | "waiting"
  | "info"
  | "warn"
  | "error";

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  label: string;
  status: ActivityStatus;
  detail?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface ActivityTimelineState {
  items: ActivityItem[];
  maxItems: number;
}
```

Functions:

```ts
export function createActivityTimeline(maxItems?: number): ActivityTimelineState;
export function applyActivityEvent(
  state: ActivityTimelineState,
  event: UiEvent,
  now?: number,
): ActivityTimelineState;
export function renderActivityTimeline(
  state: ActivityTimelineState,
  opts: { width: number; maxRows?: number; theme?: Theme; now?: number },
): string[];
```

Properties:

- pure/deterministic with injected `now`
- bounded item list
- no throwing on unknown/incomplete events
- compact labels
- redacts secret-shaped detail text before rendering

### 2. Event Mapping

Mapping rules:

Assistant:

- `assistant_delta` starts/keeps a `thinking/responding` item
- `assistant_done` marks it done

Tools:

- `tool_start` adds/updates `tool:<name>` as running
- `tool_result` marks latest matching tool done or failed

Checks:

- `check_start` adds/updates `check:<name>` as running
- `check_output` can update detail, but only with a bounded last-line summary if useful
- `check_done` marks passed/failed

Workers:

- `worker_start` adds `worker:<id>` running
- `worker_update` updates detail/status text
- `worker_done` marks done

Approvals:

- `approval_request` adds waiting item
- `approval_result` marks approved/denied

Notices:

- `notice` adds info/warn/error item

### 3. Rendering

Render newest relevant items, max 3-5 rows:

```text
… thinking
● tool read_file src/foo.ts
● check phase running
✓ check phase passed
```

Suggested symbols:

- running: `●`
- passed: `✓`
- failed/error: `✗`
- waiting: `?`
- info: `i`

If terminal is ASCII-only later, symbols can degrade to:

- running: `*`
- passed: `ok`
- failed: `x`

Width rules:

- every line is truncated to terminal width
- detail is truncated before label if needed
- no multiline detail in MVP

Color:

- running: warning or normal
- passed: success
- failed/error: error
- waiting: warning
- detail: dim

### 4. TUI Layout Integration

Current TUI layout:

```text
status
transcript
indicator
composer
```

New layout:

```text
status
transcript
indicator
activity timeline
composer
```

Timeline should be hidden when empty.

Transcript height shrinks by `timelineRows.length`, just like the slash dropdown plan.

If approval modal is open:

- approval modal remains the main content window
- timeline may still show `waiting for approval`
- do not overlap modal/composer

### 5. Relationship to Transcript

The transcript remains the durable detail. The activity timeline is derived state:

- not stored in session history
- not persisted
- can be rebuilt from events during a run only

Do not duplicate large tool/check output into the timeline.

### 6. Status Bar Integration

Add a compact summary suffix if useful:

```text
 · 2 active
```

or:

```text
 · check phase
```

This is optional for MVP if the timeline rows are visible.

## Files

New:

- `src/ui/activityTimeline.ts`
- `test/adversarial/ui-activity-timeline.test.ts`

Edited:

- `src/cli/repl.ts`
- `src/ui/minimalRenderer.ts`
- `src/ui/theme.ts`
- `test/adversarial/ui-minimal-renderer.test.ts`

## Tests

Pure activity tests:

- `tool_start` creates running item
- `tool_result` marks item done
- tool error marks failed
- `check_start` / `check_done passed:true` marks passed
- `check_done passed:false` marks failed
- worker update changes detail
- worker done marks done
- approval request/result maps to waiting/done
- notices map severity
- item list bounded
- detail redacted
- render output is width-bounded

Renderer/layout tests:

- timeline rows appear above composer
- transcript viewport height shrinks by timeline row count
- empty timeline does not reserve rows
- narrow terminal output remains bounded

## Acceptance

- `npm run typecheck`
- `npm run test:phase`
- manual smoke:

```bash
npm run dev -- --tui
```

Smoke checklist:

- during model response, timeline shows assistant activity
- during tool call, timeline shows running tool
- after tool result, timeline marks done/error
- during `/solve`, check activity appears
- after check pass/fail, timeline shows result
- delegated worker events show compact worker progress
- timeline does not cover composer
- timeline disappears or shrinks when idle/empty
- terminal restore remains clean

## Safety

- UI-only derived state.
- No command/model/tool execution changes.
- No session mutation beyond existing transcript behavior.
- Output redacted and bounded.
- Non-TTY/plain mode unaffected.

## Implementation Order

1. Add `activityTimeline.ts` and pure tests.
2. Add theme styles if needed.
3. Extend `renderFrame` to accept optional `activityLines`.
4. Wire timeline state into `runTuiRepl` event sink.
5. Manual TUI smoke.

## Delegation Notes

Good split:

- Slice A: `activityTimeline.ts` + pure tests.
- Slice B: renderer support for `activityLines`.
- Slice C: `runTuiRepl` wiring, reviewed in-house because it touches terminal I/O.

