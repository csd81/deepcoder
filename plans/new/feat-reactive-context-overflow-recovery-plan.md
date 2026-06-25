# feat: Reactive context-overflow recovery

## Problem

deepcoder compacts before model calls, but provider context limits can still be
hit:

- token estimation is approximate,
- provider-specific overhead varies,
- tool schemas and provider metadata add hidden cost,
- context updates and ephemeral injections are appended after compaction,
- future projection-only shapers may change the sent payload without mutating
  session history.

Today, `getResponseWithRetry()` retries transient provider failures and handles
stream fallback, auth errors, and bad-model errors, but it does not have a
structured recovery path for context overflow / prompt-too-long failures. If the
provider rejects the request for length, the turn fails instead of forcing a more
aggressive context reduction and retrying once.

Claude Code's reported loop handles this by attempting context-collapse overflow
recovery and reactive compaction before terminating with `prompt_too_long`.

## Goal

Detect provider context-overflow errors, run a one-shot aggressive context
reduction, and retry the same model call with a smaller `messagesForQuery`.

If recovery fails, terminate the turn with a clear structured notice instead of
silently retrying or pretending success.

## Non-goals

- Do not weaken permission checks.
- Do not execute tools during recovery.
- Do not require a live model for automatic recovery.
- Do not loop indefinitely on overflow.
- Do not hide provider errors unrelated to context length.

## Design

Add a context-overflow classifier:

```ts
// src/agent/retry.ts
export function isContextOverflowError(err: unknown): boolean
```

Recognize common provider signals:

- `prompt_too_long`
- `context_length_exceeded`
- `maximum context length`
- `tokens exceed`
- OpenAI-compatible 400 payloads with context-length messages
- DeepSeek/OpenAI-compatible API errors with length-specific codes/messages

The matcher must be conservative: false positives cause unnecessary compaction,
but false negatives only preserve current behavior.

## Loop integration

Move context-overflow handling out of generic retry and into `runAgentLoop()`,
where the loop has access to `messages`, compaction options, context epoch reset,
and persistence.

Current shape:

```ts
const response = await getResponseWithRetry(turnDeps, withEphemeralContext(messages, ctx, deps));
```

Target shape after `messagesForQuery` exists:

```ts
let projection = buildMessagesForQuery(...);
try {
  response = await getResponseWithRetry(turnDeps, projection.messagesForQuery);
} catch (err) {
  if (!isContextOverflowError(err) || attemptedOverflowRecovery) throw err;
  attemptedOverflowRecovery = true;
  projection = recoverContextOverflow(...);
  response = await getResponseWithRetry(turnDeps, projection.messagesForQuery);
}
```

Before `messagesForQuery` lands, phase 1 can call a forced durable compaction on
`messages`, reset the context epoch, persist, then retry with
`withEphemeralContext(messages, ctx, deps)`.

## Recovery strategy

Implement:

```ts
// src/context/overflowRecovery.ts
export interface OverflowRecoveryResult {
  recovered: boolean;
  before: number;
  after: number;
  reason: string;
}

export function recoverContextOverflow(
  messages: AgentMessage[],
  opts: CompactOptions & { aggressive?: boolean },
): OverflowRecoveryResult
```

Phase 1:

- Force `compactIfNeeded(..., { force: true })`.
- If already compacted and still too large, reduce tail target more aggressively
  through a new `aggressive` option.
- Preserve existing protected fields: original task, files touched, pending
  todos, last error.
- Return `recovered: false` if the message array cannot shrink further.

Phase 2 after five-stage pipeline:

- Run all stages with aggressive settings:
  - budget reducer at lower per-message caps,
  - Trident enabled,
  - snip enabled,
  - context collapse enabled if available,
  - auto-compact forced.

Phase 3 after append-oriented storage:

- Prefer projection-only collapse/snip over durable mutation.
- Persist a recovery boundary event instead of rewriting the canonical log.

## Retry limits

Per model turn:

- at most one reactive overflow recovery attempt by default,
- configurable max `2`, but never unbounded,
- if retry still overflows, stop the turn and surface:

```text
Context overflow after recovery. I compacted the conversation but the provider
still rejected the prompt as too large. Start a new session or narrow the task.
```

Do not proceed to tool execution after an unrecovered overflow.

## Interaction with retry/backoff

`getResponseWithRetry()` should not retry context-overflow errors as transient
API failures. It should throw them immediately so `runAgentLoop()` can recover.

Order:

1. auth/model errors: fatal as today,
2. context-overflow error: throw immediately to loop recovery,
3. stream error with content: fatal as today,
4. rate/transient errors: retry/backoff as today.

## Interaction with context epoch

If recovery mutates durable messages:

- call `deps.onContextEpochReset?.()` after compaction,
- call `deps.onPersist?.()`,
- rebuild `messagesForQuery` after reset,
- avoid duplicating stale `[context-update]` messages.

If recovery is projection-only:

- do not reset the durable epoch,
- record recovery stats for notices/telemetry,
- flight recorder captures the recovered projected payload.

## Configuration

```ts
context: {
  reactiveOverflowRecovery: boolean;     // default true after rollout
  overflowRecoveryMaxAttempts: number;   // default 1, max 2
  overflowAggressiveTailRatio: number;   // default 0.15
}
```

Environment:

- `DEEPCODER_REACTIVE_COMPACT=1|0`
- `DEEPCODER_OVERFLOW_RECOVERY_ATTEMPTS=1`

Phase 1 default: on, because it only activates after an otherwise-failing
provider context error.

## Telemetry / notices

Emit notices:

- before recovery:
  `Provider rejected context as too large; compacting aggressively and retrying once.`
- after success:
  `Recovered from context overflow (~before -> ~after tokens).`
- after failure:
  `Context overflow persisted after recovery.`

Record in session telemetry when available:

- number of overflow recoveries,
- success/failure,
- before/after estimated tokens,
- stage stats after the five-stage pipeline exists.

## Safety invariants

1. Recovery never executes tools.
2. Recovery never widens permissions or approval mode.
3. Recovery attempts are bounded.
4. Forced compaction preserves original task, pending todos, last write per file,
   and last error.
5. Provider-visible output remains valid under `sanitizeForProvider()`.
6. If recovery fails, the turn stops clearly; no fake assistant success.
7. Feature flag off preserves current behavior.

## Tests

Unit:

- `isContextOverflowError()` detects representative provider errors.
- Non-overflow 400s are not classified as overflow.
- `getResponseWithRetry()` does not transient-retry overflow errors.
- `recoverContextOverflow()` force-compacts a large message array.
- Recovery returns false when no shrink is possible.
- Epoch reset callback is called when durable recovery compacts.

Adversarial:

- Malicious provider/tool text saying `prompt_too_long` inside normal output does
  not trigger recovery.
- Repeated overflow cannot loop forever.
- Forced compaction preserves protected task/todos/last error.
- Provider-safe pairing remains valid after recovery.
- Feature flag off surfaces the original provider error path.

Integration:

- Faux provider throws context overflow on first call and succeeds after
  recovery; loop continues normally.
- Faux provider throws overflow twice; loop stops with clear notice and no tool
  execution.
- Recovery after ephemeral context injection rebuilds without duplicate
  `[context-update]` messages.

Gate:

- `npm run test:phase` green.

## Phasing

1. Add `isContextOverflowError()` and tests.
2. Teach `getResponseWithRetry()` to throw overflow immediately.
3. Add `recoverContextOverflow()` using forced current compaction.
4. Wire one-shot recovery in `runAgentLoop()`.
5. Add notices and telemetry.
6. After `messagesForQuery` lands, move recovery to projection-aware rebuilds.
7. After five-stage context pipeline lands, use aggressive staged recovery.
8. After append-oriented storage lands, prefer projection-only recovery and log
   recovery events.

## Effort / risk

Medium, low-medium risk. The path only activates on an otherwise failing
provider call, and phase 1 can reuse existing compaction. The main risk is
misclassifying provider errors; keep the classifier conservative and well tested.

## Status

**IMPLEMENTED** (Phases 1–6: classifier, throw-immediately, recovery, one-shot loop
wiring, notices, projection-aware rebuild). Phases 7–8 (aggressive *staged* recovery
via the pipeline, projection-only recovery + recovery-boundary events) remain
proposed.

Implementation notes:
- `isContextOverflowError(err)` (`src/agent/retry.ts`) — conservative phrase matcher
  (`prompt_too_long`, `maximum context length`, `context_length_exceeded`, `tokens
  exceed`, …). `getResponseWithRetry` throws it **immediately** (before the
  `isModelError` 400 match) so it isn't treated as transient.
- `recoverContextOverflow(messages, opts)` (`src/context/overflowRecovery.ts`) —
  forces an *aggressive* `compactIfNeeded` against a fraction of the budget
  (`overflowAggressiveTailRatio`, default 0.15); returns `recovered:false` when the
  array can't shrink (loop then stops cleanly).
- `runAgentLoop` wraps the model call in a **bounded** recovery loop: on overflow it
  recovers, resets the epoch, persists, rebuilds the `messagesForQuery` projection
  (no duplicate `[context-update]`s), and retries — at most
  `overflowRecoveryMaxAttempts` (default 1, capped 2). No tools run during recovery;
  an unrecovered overflow stops the turn with a clear notice (no fake success).
- Config `context.{reactiveOverflowRecovery, overflowRecoveryMaxAttempts,
  overflowAggressiveTailRatio}` (defaults on/1/0.15) + env
  `DEEPCODER_REACTIVE_COMPACT`, `DEEPCODER_OVERFLOW_RECOVERY_ATTEMPTS`. Threaded
  through `AgentDeps` and set in `repl.ts`.
- Tests: `test/overflow-recovery.test.ts` (6 — classifier, no-transient-retry,
  aggressive shrink preserves task/todos/last-error, no-shrink→false, one-shot
  recover-then-continue with epoch reset, persists-after-recovery stop) +
  `test/adversarial/overflow-recovery.test.ts` (4 — overflow-shaped *content* doesn't
  trigger recovery, bounded/no-infinite-loop, flag-off surfaces original error,
  pairing valid after recovery).
