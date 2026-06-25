# feat: Subagent sidechain transcripts

## Problem

deepcoder subagents currently return parsed summaries/findings and persist
`SubagentRunRecord` metadata in the parent session. The full subagent
conversation is not durably stored as its own transcript.

This preserves parent-context hygiene, but loses important audit/debug data:

- Which exact prompt did the subagent receive?
- Which model/tool calls did it make?
- Which tool results did it inspect before producing a finding?
- Did parsing discard useful context from a malformed final response?
- How can a user or evaluator replay or inspect a subagent run without inflating
  the parent session history?

Claude Code's reported architecture writes each subagent conversation to a
separate `.jsonl` sidechain plus metadata file. Only the summary returns to the
parent context, while the full subagent transcript remains available for
debugging and audit.

## Goal

Persist every subagent run as a separate sidechain transcript:

```text
.deepcoder/sessions/<parentSessionId>.subagents/<subagentRunId>.jsonl
.deepcoder/sessions/<parentSessionId>.subagents/<subagentRunId>.meta.json
```

The parent session continues to store only bounded metadata and the parsed
summary/findings. The full sidechain is never injected into the parent model
context automatically.

## Non-goals

- Do not make subagents write-capable.
- Do not share full parent history with subagents.
- Do not inject sidechain contents into the parent prompt.
- Do not require append-oriented parent session storage to land first.
- Do not add live-provider replay in this feature.

## Design

### Sidechain event log

Each sidechain `.jsonl` is append-oriented:

```ts
interface SubagentTranscriptEvent {
  version: 1;
  eventId: string;
  runId: string;
  parentSessionId: string;
  seq: number;
  createdAt: string;
  type:
    | "subagent_started"
    | "message_appended"
    | "tool_started"
    | "tool_result"
    | "notice"
    | "subagent_completed"
    | "subagent_failed";
  data: unknown;
}
```

Minimum viable event set:

- `subagent_started`: profile, task, model, workspace root, allowed tools,
  context budget, parent session id.
- `message_appended`: system/user/assistant/tool message as seen by the subagent.
- `tool_started`: tool name and description.
- `tool_result`: bounded/redacted output and `isError`.
- `notice`: max-turns/abort/diagnostic notices.
- `subagent_completed`: parsed result, final text hash/preview, turns, tools.
- `subagent_failed`: error message.

### Metadata file

`meta.json` is a compact index for listing:

```ts
interface SubagentSidechainMeta {
  version: 1;
  runId: string;
  parentSessionId: string;
  parentMessageId?: string;
  createdAt: string;
  completedAt?: string;
  profile: string;
  model: string;
  taskPreview: string;
  status: "running" | "completed" | "failed" | "aborted";
  turns: number;
  toolsCalled: string[];
  transcriptPath: string;
  resultSummary?: string;
  error?: string;
}
```

The parent `SubagentRunRecord` should store `sidechainRunId` and maybe
`sidechainPath`, not the full transcript.

### Writer integration

Add:

```ts
// src/subagents/sidechain.ts
export class SubagentSidechainWriter {
  start(meta): Promise<void>;
  append(event): Promise<void>;
  updateMeta(patch): Promise<void>;
  close(result): Promise<void>;
}
```

Wire it into `runSubagent()`:

- create a run id before building messages,
- write `subagent_started`,
- write initial system/user messages,
- pass callbacks to `runAgentLoop()`:
  - `onToolCall` -> `tool_started`,
  - `onToolResult` -> `tool_result`,
  - `onNotice` -> `notice`,
  - `onPersist` or a new subagent-local callback -> append new messages.
- on completion, write final assistant text and parsed result.

Phase 1 can snapshot the final `messages` array to sidechain after the subagent
finishes if callback-level capture is too invasive. Phase 2 should append events
as they happen.

### Parent linkage

Extend:

```ts
interface SubagentRunRecord {
  ...
  sidechainRunId?: string;
  sidechainPath?: string;
}
```

Parent model context still receives only:

- `summary`
- rendered findings

The sidechain link is for UI, `/subagents`, `/session share`, audit, and future
flight/replay tooling.

## CLI / UI

Add or extend commands:

- `/subagents` lists sidechain runs for the session.
- `/subagents show <runId>` prints metadata and transcript summary.
- `/subagents export <runId>` emits redacted markdown/json for sharing.

Keep default display compact. Full transcript output should be explicit.

## Storage and retention

Initial layout:

```text
.deepcoder/sessions/<sessionId>.subagents/
  <runId>.jsonl
  <runId>.meta.json
```

Retention:

- retain sidechains while parent session exists,
- archive/delete parent session should archive/delete sidechains consistently,
- optional future cap by count/bytes.

Because `.deepcoder/**` is protected, subagents and parent agents should not be
able to read sidechain files through model tools.

## Safety invariants

1. Sidechain transcripts are never injected into parent context automatically.
2. `.deepcoder/sessions/**` remains unreadable by model file/search tools.
3. Tool outputs are redacted before writing if they pass through existing
   redaction paths; do not introduce a new unredacted export surface.
4. Sidechain write failures must not crash the subagent run by default; surface a
   warning and continue.
5. Path construction uses safe generated run IDs, never model-provided strings.
6. Parent summaries/findings remain bounded.
7. A malicious subagent final response cannot choose its sidechain path.

## Tests

Unit:

- sidechain writer appends valid JSONL events with monotonic seq.
- meta file updates atomically.
- generated run IDs are path-safe.
- parent `SubagentRunRecord` includes sidechain ID/path.
- sidechain transcript can be read back and summarized.

Adversarial:

- malicious task/profile text cannot escape the sidechain directory.
- `.deepcoder/sessions/*.subagents/**` cannot be read by `read_file`/`grep`.
- prompt-injected final response cannot alter meta status/path.
- sidechain write failure does not inject raw transcript into parent context.
- export path redacts secret-shaped content.

Integration:

- run a read-only subagent; sidechain contains started, initial messages, tool
  events, completion, and parsed summary.
- malformed subagent final response is preserved in sidechain while parent record
  stores degraded summary.
- parent session resume can list previous sidechain runs.
- deleting/archiving a session handles sidechains consistently.

Gate:

- `npm run test:phase` green.

## Phasing

1. Add sidechain writer and meta types.
2. Add final-snapshot sidechain writing at the end of `runSubagent()`.
3. Link sidechain run IDs from parent `SubagentRunRecord`.
4. Add `/subagents list/show` read-only commands.
5. Move from final-snapshot writing to event-time appends via callbacks.
6. Integrate with append-oriented parent session storage when available.
7. Add export/share support.

## Effort / risk

Medium, low-medium risk. The feature is additive and can start by writing
sidechains after subagent completion. Event-time appends touch more of the loop
but can be phased later.

The main risk is accidental context contamination: tests must prove full
sidechain content never enters parent model-visible history.

## Status

Proposed.

Recommended before write-capable/worktree subagents, because richer subagent
power needs better auditability first.
