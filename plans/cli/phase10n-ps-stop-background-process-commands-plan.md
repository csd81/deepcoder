# Phase 10N — `/ps` and `/stop` Background Activity Commands

## Context

Deepcoder now runs more long-lived operations:

- delegated workers
- concurrent worker batches
- configured checks
- solve loops
- explorer/reviewer subagents
- future persistent shell sessions
- future web/search tasks

Today the user mostly sees streaming output while the command is in the foreground. If something hangs, runs slowly, or was launched from another UI path, the user has no unified way to inspect or stop active work. They must rely on terminal interrupts, external `ps`, `pkill`, or logs.

The next highest-ROI missing slash commands are:

- `/ps` — list active Deepcoder activities in this session/process.
- `/stop` — cancel one active activity or all cancellable activities.

This gives Deepcoder a mature operational control plane similar to Codex/Claude task/background process controls, without adding new model capabilities.

## Goal

Add a session-local activity registry and two slash commands:

```text
/ps
/ps --json
/ps --all

/stop <activity-id>
/stop all
```

The commands should cover activities launched inside the current Deepcoder process:

- checks launched by `/check`, `/tests run-targeted`, solve loops, and worker gates
- delegated worker runs
- subagent runs
- long-running solve loops
- future shell/web tasks through the same registry

## Non-Goals

- No OS-wide process manager.
- No killing arbitrary PIDs.
- No listing other terminal sessions.
- No cross-process daemon.
- No persistence of completed activities beyond existing check/worker artifacts.
- No automatic restart.
- No TUI task manager in v1.
- No shell-session lifecycle changes in v1.

## UX

List active activities:

```text
/ps

Active activities:
  a1  worker     running  02:14  plan phase9 worker-3  check=phase
  a2  check      running  00:31  phase                npm run test:phase
  a3  subagent   running  00:08  explorer             context preflight

Use /stop <id> to cancel, or /stop all.
```

No active activities:

```text
No active activities.
```

Stop one:

```text
/stop a2
Stopping a2 (check phase)…
```

Stop all:

```text
/stop all
Stopping 3 cancellable activities…
```

JSON:

```json
{
  "activities": [
    {
      "id": "a1",
      "kind": "worker",
      "status": "running",
      "label": "plan phase9 worker-3",
      "startedAt": "2026-06-22T20:30:00.000Z",
      "durationMs": 134000,
      "cancellable": true
    }
  ]
}
```

## Design

### 1. Activity Registry

New file: `src/runtime/activityRegistry.ts`

```ts
export type ActivityKind =
  | "check"
  | "worker"
  | "delegate"
  | "solve"
  | "subagent"
  | "shell"
  | "web"
  | "other";

export type ActivityStatus = "running" | "stopping" | "done" | "failed" | "cancelled";

export interface ActivityRecord {
  id: string;
  kind: ActivityKind;
  label: string;
  detail?: string;
  startedAt: string;
  updatedAt: string;
  status: ActivityStatus;
  cancellable: boolean;
  metadata?: Record<string, string | number | boolean>;
}

export interface ActivityHandle {
  record: ActivityRecord;
  update(patch: Partial<Pick<ActivityRecord, "status" | "detail" | "metadata">>): void;
  stop(reason?: string): void;
  finish(status: Exclude<ActivityStatus, "running" | "stopping">, detail?: string): void;
}
```

Core functions:

```ts
export class ActivityRegistry {
  start(input: {
    kind: ActivityKind;
    label: string;
    detail?: string;
    cancellable?: boolean;
    controller?: AbortController;
    metadata?: ActivityRecord["metadata"];
  }): ActivityHandle;

  list(opts?: { includeDone?: boolean }): ActivityRecord[];
  get(id: string): ActivityRecord | undefined;
  stop(id: string, reason?: string): boolean;
  stopAll(reason?: string): number;
  pruneDone(maxAgeMs?: number): number;
}
```

Properties:

- deterministic IDs: `a1`, `a2`, ... within one process
- never stores secrets
- metadata values are primitive and bounded
- finished records are retained briefly for `/ps --all`, then pruned
- stop calls `AbortController.abort(reason)` when present

### 2. Session Wiring

Edit: `src/cli/repl.ts`

Add to `Session`:

```ts
activities: ActivityRegistry;
```

Initialize once per REPL/session process.

The registry is runtime-only and not persisted to `.deepcoder/sessions/*.json`.

### 3. Process Runner Integration

The shared `runBoundedProcess` already supports an `AbortSignal` and process-group kill. This phase should not rewrite that behavior.

Add optional activity metadata at call sites, not inside `runBoundedProcess`:

- `runCheck` call sites register kind `check`
- worker runner call sites register kind `worker`
- solve loop registers kind `solve`
- subagent runner command paths register kind `subagent`

MVP integration targets:

1. `/check` and `/tests run-targeted` checks
2. `/delegate run` workers
3. `/explore`, `/review`, `/research`, `/triage` subagents
4. `--solve` interactive command path

If a call site already owns an `AbortController`, pass that controller into `ActivityRegistry.start`.

If a call site only has an inherited signal, create a child controller and bridge parent abort into it.

### 4. Slash Commands

Edit: `src/cli/slashCommands.ts`

Add:

```ts
case "ps":
  runPsSlash(session, arg);
  return { consumed: true };

case "stop":
  runStopSlash(session, arg);
  return { consumed: true };
```

`/ps`:

- default lists running/stopping only
- `--all` includes recent done/failed/cancelled records
- `--json` emits stable JSON
- output bounded to 50 records

`/stop`:

- requires `<id>` or `all`
- refuses unknown ID
- refuses non-cancellable record
- marks record `stopping`
- calls registry stop
- does not kill arbitrary OS PIDs

### 5. TUI Hooks

Out of scope for full UI, but this phase should expose records in a shape the TUI can reuse.

Future UI:

- bottom status shows `busy: 2`
- activity drawer lists active checks/workers
- clicking a worker opens logs/review
- `Esc` or `Ctrl+C` maps to `/stop <focused>`

## Safety

- `/stop` never accepts raw PIDs.
- `/stop` only cancels registered in-process activities.
- Registry never stores environment values, command secrets, or full prompts.
- Labels/details are bounded and redacted before display.
- Stopping a worker/check uses existing abort/process-group kill path.
- Finished activities cannot be restarted from `/ps`.

## Tests

New file: `test/adversarial/activity-registry.test.ts`

Pure registry tests:

1. `start` creates stable unique IDs.
2. `list` returns running records sorted by start time.
3. `stop(id)` aborts the associated controller.
4. `stop(id)` returns false for unknown IDs.
5. `stopAll` aborts only cancellable running records.
6. `finish` marks status and keeps a bounded record.
7. `pruneDone` removes old finished records only.
8. Labels/details are bounded/redacted.
9. Metadata rejects or stringifies non-primitive data.

Slash tests:

10. `/ps` prints "No active activities" when empty.
11. `/ps --json` parses and contains no secrets.
12. `/stop all` reports count and aborts all cancellable records.
13. `/stop <id>` refuses non-cancellable records.
14. Unknown ID does not throw.

Integration tests:

15. A fake long-running check registered with the activity registry appears in `/ps`.
16. Cancelling it through `/stop <id>` aborts the check and leaves no orphan process.
17. A fake worker registered through delegate run path appears as kind `worker`.

## Acceptance

Required:

```text
npm run typecheck
npm run test:phase
node --import tsx --test test/adversarial/activity-registry.test.ts
```

Manual smoke:

```text
/ps
# start a long check or delegated worker
/ps
/stop <id>
/ps --all
```

Expected:

- `/ps` shows running checks/workers/subagents.
- `/stop` cancels only registered activities.
- process-group cleanup still works for bounded processes.
- no API keys or prompts are printed.
- no persistent session JSON changes except normal session save behavior.

## Delegation Suitability

Recommended split:

1. Worker A: pure `src/runtime/activityRegistry.ts` + tests.
2. Parent/manual: wire `Session.activities`, `/ps`, `/stop`, and call-site registrations.

Reason: the registry is low-risk and pure; call-site wiring touches shared REPL/slash/delegate/check paths and should be reviewed carefully.

Suggested worker scope:

```text
Implement only the pure activity registry.
Touch only:
- src/runtime/activityRegistry.ts
- test/adversarial/activity-registry.test.ts
Do not wire slash commands yet.
Run npm run test:phase.
```

## Implementation Order

1. Add `ActivityRegistry` pure core.
2. Add adversarial registry tests.
3. Add `Session.activities` initialization.
4. Add `/ps` and `/stop` slash command handlers.
5. Register `/check` and targeted checks.
6. Register delegated workers.
7. Register subagent runs.
8. Register solve loop.
9. Add slash/integration tests.
10. Update slash catalog/help.
11. Run full gate.
