# feat: Append-oriented session storage with read-time reconstruction

## Problem

deepcoder persists sessions as whole JSON snapshots in
`.deepcoder/sessions/<sessionId>.json` via `SessionStore.save()`
(`src/session/sessionStore.ts`). This is simple and atomic, but it loses the
event-history properties that matter for long-running agent sessions:

- A save rewrites the current state instead of preserving the exact sequence of
  state transitions.
- Debugging, audits, and security review must infer what happened from the final
  `messages` array plus side metadata.
- Resume/fork cannot distinguish "this event happened" from "this is the latest
  projection after compaction or cleanup".
- Compaction mutates the live `messages` array, so the pre-compaction history is
  not durably represented as a first-class event stream.
- Subagent/review/brief/plan records are quarantined from model context, which is
  good, but they are still persisted as snapshot fields rather than chronological
  events.

The Claude Code architecture report calls out mostly append-only JSONL transcripts
with read-time reconstruction as a high-leverage design: the live conversation can
compact, resume, fork, and recover while the durable record remains chronological
and auditable.

## Goal

Introduce an append-oriented event log for sessions and reconstruct the current
`PersistedSession` projection at read time.

The first implementation should preserve today's public behavior: existing
commands continue to load/save sessions through `SessionStore`, but the backing
storage becomes an append log plus a reconstructed projection. Snapshot JSON can
remain as a migration/fallback layer during rollout.

## Non-goals

- Do not change the model loop, permission policy, command classifier, sandbox,
  or trust gates.
- Do not make `.deepcoder/sessions/**` model-readable.
- Do not require a live model for migration or tests.
- Do not implement full deterministic replay of provider calls here. That belongs
  with the flight recorder plan.

## Design

### Storage layout

Use one event log per session:

```text
.deepcoder/sessions/<sessionId>.jsonl
.deepcoder/sessions/<sessionId>.projection.json   # optional cache, rebuildable
.deepcoder/sessions/<sessionId>.json              # legacy snapshot during migration
```

Each JSONL row is one append-only `SessionEvent`:

```ts
interface SessionEventBase {
  version: 1;
  eventId: string;
  sessionId: string;
  createdAt: string;
  seq: number;
}
```

`seq` is monotonic per session. Append writes must be serialized per session in
the current process. The reader rejects or quarantines duplicate/out-of-order
events rather than silently accepting corruption.

### Event vocabulary

Start with the smallest vocabulary that can reconstruct today's
`PersistedSession`:

- `session_started`: provider/baseUrl/model/mode/title/contextSnapshot/createdAt.
- `system_context_reset`: replaces or inserts the leading system message after
  resume/compaction epoch reset.
- `message_appended`: one `AgentMessage`.
- `messages_replaced_by_compaction`: compact boundary event with the removed range
  metadata plus the replacement summary message.
- `todos_set`: full todo array. Later this can become per-todo deltas.
- `read_tracker_added`: one or more absolute paths.
- `write_tracker_added`: one or more absolute paths.
- `pending_checkpoint_set`: current pending checkpoint window.
- `review_recorded`: one `SubagentRunRecord`.
- `brief_recorded`: one `BriefRunRecord`.
- `plan_recorded`: one `PlanRunRecord`.
- `skill_activated`: one activated skill record.
- `telemetry_updated`: current telemetry projection.
- `web_trace_appended`: one bounded web trace record.
- `goal_updated`: current session goal or cleared goal.
- `handoff_plan_saved`: approved plan text + timestamp.
- `mode_changed`: approval mode changes, including plan-mode effective handoff
  when relevant.
- `title_changed`.
- `session_archived`.

Prefer full-field replacement events for low-frequency fields. Use append events
for chronological artifacts like messages, web trace, and subagent records.

### Read-time reconstruction

Add a pure projector:

```ts
export function projectSession(events: SessionEvent[]): PersistedSession
```

Rules:

- Apply events in `seq` order.
- Build the current `messages` array by appending messages and applying explicit
  compaction replacement events.
- Keep quarantined metadata (`reviews`, `briefs`, `plans`) outside model-visible
  messages, preserving the existing invariant.
- Rebuild Sets (`readTracker`, `writeTracker`) from add events.
- Treat projection cache as an optimization only. If the cache is missing,
  stale, or invalid, rebuild from JSONL.

`loadSession()` should prefer JSONL when present. If only the legacy `.json`
snapshot exists, load it and optionally emit a migration event log.

### Write path

Refactor `SessionStore.save(snapshot)` into two layers:

1. A compatibility method still accepting `SessionSnapshot`.
2. An internal diff-to-events writer that compares the last projected state to
   the new snapshot and appends only the required events.

This keeps call sites stable during phase 1. Later phases can replace broad
`save(snapshot)` calls with explicit event appends at the actual mutation points
(`message_appended`, `mode_changed`, `review_recorded`, etc.).

Append protocol:

- Write one complete JSON object plus `\n` with `O_APPEND` semantics where
  practical.
- Also support an atomic temp+rename fallback for platforms where append locking
  is unreliable.
- Never truncate the log as part of normal save.
- On append success, update the optional projection cache atomically.

### Compaction semantics

DeepCoder's current compaction mutates `messages` in place
(`src/context/compaction.ts`). Preserve the original raw event history by logging
compaction as an event instead of pretending the old messages never existed.

For phase 1, the compatibility diff can detect that a contiguous older message
range was replaced by a `[compacted-summary]` user message and emit
`messages_replaced_by_compaction`.

For phase 2, make `compactIfNeeded()` return enough metadata for the store to log
the compaction boundary directly:

```ts
{
  compacted: true,
  before,
  after,
  replaced: { startIndex, count },
  replacement: AgentMessage
}
```

The projector applies the replacement to the live projection while the underlying
log still contains the earlier `message_appended` events.

### Fork/resume/archive

- Resume: load projected session from JSONL, then keep existing behavior of
  rebuilding the leading system message from current instructions.
- Fork: create a new session log with `session_started` plus a
  `forked_from { sourceSessionId, sourceSeq }` event, then append the projected
  messages/todos/trackers needed for the child. Continue clearing reviews,
  briefs, telemetry, and web trace as today unless the command explicitly asks
  for a full forensic fork.
- Archive: append `session_archived`, do not rewrite the log.
- Delete: existing destructive delete behavior can remove log/cache/snapshot
  together.

## Migration

1. **Dual-read:** `loadSession()` reads JSONL if present, otherwise legacy JSON.
2. **Dual-write shadow:** `SessionStore.save()` continues writing legacy JSON and
   also appends JSONL. Tests assert projections match snapshots.
3. **JSONL primary:** once stable, read JSONL first and write legacy JSON only as
   a projection cache or compatibility artifact.
4. **Legacy cleanup:** optionally add a maintenance command to convert old
   `.json` sessions to `.jsonl`.

Do not delete existing session JSON automatically in the first release.

## Safety / adversarial coverage

- **Path confinement:** session IDs must continue through `assertSafeId`; log,
  cache, and legacy paths must stay under `.deepcoder/sessions`.
  Adversarial test: `../../x` cannot read/write outside the sessions directory.
- **Corruption tolerance:** a torn final JSONL line is ignored or quarantined with
  a warning; earlier complete events remain loadable.
- **No re-ingestion:** `.deepcoder/**` remains protected from model tools.
  Adversarial test: `read_file`/`grep` cannot read session logs.
- **No permission widening:** reconstructing a session must not bypass the live
  permission policy. Approval mode may be restored because that is current
  DeepCoder behavior, but every tool call still flows through `checkPermission`.
- **Sensitive data:** do not add new model-visible surfaces. Session logs are
  local control-plane artifacts. Redaction is not required for parity with
  current snapshots, but any CLI export/share command must continue to use the
  existing redaction paths.
- **Bounded projection cache:** cache corruption must not corrupt the source log.
  Rebuild from JSONL on cache parse/hash failure.

## Tests

- Unit: event projector reconstructs a `PersistedSession` from ordered events.
- Unit: duplicate/out-of-order events are rejected or quarantined deterministically.
- Unit: legacy JSON load still works.
- Unit: dual-write projection equals the legacy snapshot for representative
  sessions with messages, todos, trackers, reviews, skills, web trace, goals,
  and context snapshots.
- Unit: compaction replacement projects to the same `messages` array as current
  snapshot compaction while preserving earlier message events in the log.
- Adversarial: path escape, torn final line, corrupted projection cache,
  `.deepcoder/sessions` read-blocking, permission policy still gates resumed
  tool calls.
- Integration: create session, append messages/tool results, compact, resume,
  fork, archive, and list sessions.
- `npm run test:phase` green.

## Phasing

1. **Projector + event types:** pure types and reconstruction tests, no write-path
   change.
2. **Dual-write shadow:** append events while preserving existing snapshot writes.
3. **Read JSONL primary:** switch `loadSession`, `listSessions`, `forkSession`,
   and `archiveSession` to use projected logs when available.
4. **Compaction boundary event:** replace heuristic diff detection with explicit
   compaction metadata from `compactIfNeeded`.
5. **Event-native call sites:** gradually replace broad `save(snapshot)` calls
   with explicit append calls at mutation points.
6. **Migration tooling:** add a command or internal helper to convert legacy
   sessions.

## Effort / risk

Medium-large, medium risk. The storage layer is central, but the safest route is
additive: build a pure projector, dual-write, compare projections against current
snapshots, then switch reads once the invariant is well tested.

The main risk is accidental projection mismatch during compaction/resume. Keep
the legacy snapshot writer during rollout so failures can fall back without data
loss.

## Status

Proposed.

Recommended before larger long-horizon agent work. It creates the durable event
substrate needed for better audit, replay, fork, and future evaluation tooling,
while leaving the model loop and permission surface unchanged.
