# feat: Explicit messagesForQuery projection for context shapers

## Problem

deepcoder currently carries one mutable `messages` array as both:

- the durable/session conversation state, and
- the model-call input after in-place compaction and ephemeral additions.

Before each model call, `runAgentLoop()` mutates or extends this state:

- `compactIfNeeded(messages, ...)` may splice old history into a summary.
- `reconcileContext()` may append `[context-update]` messages.
- `withEphemeralContext()` returns a temporary array with todos, JIT
  instructions, and delegation hints.

This works, but it makes Claude-style pre-model shapers harder:

- Some shapers should be read-time projections, not durable mutations.
- Some reductions should apply only to `messagesForQuery`.
- Stage stats and token savings are hard to reason about when every stage can
  mutate session history directly.
- Append-oriented session storage and context collapse need a clean split
  between canonical history and provider input.

Claude Code's reported pipeline operates on a `messagesForQuery` array before the
model call. DeepCoder should introduce the same concept.

## Goal

Separate canonical session history from provider input:

```text
session.messages       canonical mutable session state
messagesForQuery       per-call projection sent to provider
```

Pre-model context shapers operate on `messagesForQuery` first. Only stages that
intentionally change durable state write back to `session.messages`.

## Design

Add:

```ts
// src/context/queryProjection.ts
export interface QueryProjectionInput {
  messages: AgentMessage[];
  ctx: ToolContext;
  deps: AgentDeps;
}

export interface QueryProjection {
  messagesForQuery: AgentMessage[];
  durableMessagesChanged: boolean;
  stageStats: ContextStageStats[];
}

export function buildMessagesForQuery(input: QueryProjectionInput): QueryProjection
```

`runAgentLoop()` becomes:

```ts
const projection = buildMessagesForQuery({ messages, ctx, deps });
if (projection.durableMessagesChanged) await deps.onPersist?.();
const response = await getResponseWithRetry(turnDeps, projection.messagesForQuery);
```

## Projection order

1. Start with canonical `messages`.
2. Apply durable context reconciliation if needed.
3. Build a shallow copied `messagesForQuery`.
4. Run five-stage context pipeline on the copy:
   - budget reduce,
   - Trident,
   - snip,
   - context collapse,
   - auto compact.
5. Append ephemeral context:
   - todos,
   - JIT path-local instructions,
   - delegation hint.
6. Sanitize for provider inside `getResponse()` as today.

Initial phase can keep current durable compaction behavior, but the API should be
projection-ready from the start.

## Durable vs projection-only stages

Durable stages:

- context reconciliation,
- current `compactIfNeeded()` until read-time collapse exists,
- context epoch reset after durable compaction.

Projection-only stages:

- snip,
- context collapse,
- deferred tool catalog injections,
- ephemeral todos/JIT/delegation hints,
- future cache-aware microcompact.

Hybrid stages:

- budget reduction may write managed-output blobs and then replace provider input
  with content references. Whether it also mutates canonical history should be a
  config choice during rollout.

## Integration with five-stage pipeline

`plans/new/feat-five-stage-context-pipeline-plan.md` defines the stages. This plan
defines where they run.

Short-term:

- `shapeContextBeforeModel(messages, opts)` may still mutate `messages`.

Target:

- `shapeContextBeforeModel(messagesForQuery, opts)` returns projected input and
  explicit durable patches/events.

This avoids long-term summary-of-summary decay and aligns with the append-log
plan, where model input can be reconstructed as a projection over an event log.

## Interaction with flight recorder

The flight recorder should capture after projection and provider sanitization:

```text
canonical messages
  -> buildMessagesForQuery
  -> sanitizeForProvider
  -> flight recorder snapshot
  -> provider
```

This records what the model actually saw, including projection-only shapers.

## Safety invariants

1. Projection-only shapers never delete canonical history.
2. Durable shapers must report exactly what they changed.
3. `messagesForQuery` must satisfy provider tool-call/result pairing.
4. Ephemeral context is never persisted unless explicitly intended.
5. System prompt/context-update messages are not mutated by projection-only
   stages.
6. Feature flag off preserves current behavior.
7. Append-oriented event storage can reconstruct canonical state without needing
   projection-only artifacts.

## Tests

Unit:

- `buildMessagesForQuery()` returns a new array when projection-only stages run.
- Ephemeral todos/JIT/delegation hints appear in `messagesForQuery` but not in
  canonical `messages`.
- Durable compaction still persists when enabled.
- Projection-only snip/collapse does not mutate canonical history.
- Provider sanitization remains valid after projection.

Adversarial:

- Prompt-injected tool output cannot mark canonical messages as droppable.
- Malformed tool-call sequences do not become worse after projection.
- System messages remain byte-identical.
- Feature flag off is current legacy path.

Integration:

- Long session uses projection-only snip/collapse for provider call while session
  history remains available for `/share`, resume, fork, and future event-log
  reconstruction.
- Flight recorder captures projected payload, not raw canonical history.

Gate:

- `npm run test:phase` green.

## Phasing

1. ✅ **DONE** — Add `buildMessagesForQuery()` as the single pre-model chokepoint;
   no behavior change.
2. ✅ **DONE** — Move `reconcileContext()` and compaction orchestration into the
   projection builder while preserving durable behavior + persistence ordering.
3. Wire the five-stage pipeline into the projection builder.
   *(depends on `feat-trident-compaction` + `feat-five-stage-context-pipeline`)*
4. Make snip projection-only.
5. After append-oriented session storage lands, make context collapse
   projection-only over event ranges.
6. Update flight recorder to record projected/sanitized input.
   *(already satisfied: the recorder fires in `getResponse()` downstream of the
   projection + `sanitizeForProvider`, so it already captures the projected
   payload. No change was needed.)*

## Effort / risk

Medium. This is mostly architectural plumbing, but it becomes the foundation for
safe context collapse and deferred tool catalogs. Keep the first phase no-op and
move shapers one at a time.

## Status

**Phase 1+2 IMPLEMENTED** (the `messagesForQuery` seam). Phases 3–6 remain
proposed and depend on their own plans (`feat-trident-compaction`,
`feat-five-stage-context-pipeline`, `feat-append-oriented-session-storage`).

Implementation notes:

- **Decision: single path, no feature flag.** The legacy inline
  compaction/reconcile/ephemeral block in `runAgentLoop()` was replaced outright
  rather than kept behind a toggle — the refactor is behavior-identical and a
  dead second path adds no value. Byte-identity is guaranteed by unit tests.
- New `src/context/queryProjection.ts` exports `buildMessagesForQuery(input):
  QueryProjection` plus the moved `withEphemeralContext()` and a new
  `ContextStageStats` type (additive per-stage token observability — `compact`
  and `reconcile` stages today; future shapers append more).
- `buildMessagesForQuery()` is **sync** (every stage it calls is sync). The async
  durable side-effects (`onContextEpochReset`, `onPersist`) stay in
  `runAgentLoop()`, driven by the returned `compaction` / `contextUpdatesAppended`
  flags — so persistence ordering is byte-for-byte unchanged.
- `runAgentLoop()` (`src/agent/agentLoop.ts`) now calls
  `buildMessagesForQuery({ messages, ctx, deps })` once per turn and sends
  `projection.messagesForQuery` to the provider.
- Tests: `test/queryProjection.test.ts` (6 unit — byte-identity, ephemeral
  isolation, reconcile append, threshold no-op, compaction durable, stageStats) +
  `test/adversarial/query-projection.test.ts` (4 — injection cannot mutate
  canonical history, system-prompt byte-identity, no pairing regression, ephemeral
  never leaks into the persisted array). `npm run test:phase` green (2076).
