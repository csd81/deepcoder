# feat: Streaming tool executor with concurrent read / serial write dispatch

## Problem

deepcoder currently waits for a complete provider response before executing any
tool call:

```ts
const response = await getResponseWithRetry(...)
...
for (const call of response.toolCalls) {
  // validate -> permission -> hooks -> execute -> persist
}
```

Even when the provider streams tool-call deltas, `consumeStream()` buffers them
until the response is complete and returns a single `ChatResponse`. This makes
multi-tool responses slower than necessary:

- A first `read_file` call cannot begin while the model is still streaming later
  calls.
- Independent read-only calls run serially.
- Long-running `run_bash` calls block later safe reads even when ordering would
  allow parallelism.
- The loop has no executor-level sibling abort: if one execute tool fails, other
  in-flight work is not coordinated because no work is currently in flight.

Claude Code's reported architecture uses a `StreamingToolExecutor` that begins
running tools as soon as complete streamed tool-use blocks arrive, while
preserving result order for the next model call.

## Goal

Add a streaming tool execution path that can:

- start executing complete streamed tool calls before the full assistant response
  finishes,
- run concurrent-safe read-only/session tools in parallel,
- serialize mutating/executing tools,
- preserve the provider-visible result order,
- keep all existing permission, hook, sandbox, copy-on-write, persistence, and
  rendering behavior,
- fall back to the current serial path when streaming is unavailable or disabled.

## Non-goals

- No speculative tool execution before the model emits a complete tool call.
- No parallel writes.
- No permission bypass.
- No change to provider wire format.
- No attempt to execute partial/incomplete tool-call arguments.

## Architecture

Introduce:

```ts
// src/agent/streamingToolExecutor.ts
export interface ToolExecutionUpdate {
  index: number;
  call: ToolCall;
  kind: "started" | "progress" | "result" | "blocked";
  result?: ToolResult;
  messageContent?: string;
}

export class StreamingToolExecutor {
  accept(call: ToolCall): void;
  finishAssistant(): void;
  updates(): AsyncIterable<ToolExecutionUpdate>;
}
```

The executor owns only tool execution coordination. It does not decide model
control flow. `runAgentLoop()` still appends one assistant message and then one
tool result per call before continuing to the next model call.

## Provider stream changes

Today `consumeStream()` returns a completed `ChatResponse`. Add a second
streaming mode:

```ts
export async function consumeStreamWithToolExecution(
  stream: AsyncIterable<ModelEvent>,
  executor: StreamingToolExecutor,
  onDelta?: (chunk: string) => void,
): Promise<{ text: string; toolCalls: ToolCall[]; usage?: TokenUsage }>
```

Behavior:

- `assistant_text_delta`: append/render as today.
- `tool_call_complete`: append to `toolCalls` and immediately call
  `executor.accept(call)`.
- `done`: mark assistant stream complete and return final text/calls/usage after
  executor has enough data to flush ordered results.

Fallback:

- If stream fails before content, use current non-streaming fallback.
- If stream fails after content/tool calls, abort in-flight executor work and
  propagate the stream error, matching today's no-duplicate policy.

## Execution classification

Classify built invocations into lanes:

- **Concurrent-safe:** `kind === "read-only"` or `kind === "session"` and the
  tool is marked `concurrentSafe !== false`.
- **Exclusive:** `kind === "mutate"` or `kind === "execute"`.
- **Unknown/invalid/denied:** produce synthetic results without entering a lane.

Add optional tool metadata:

```ts
interface Tool {
  ...
  concurrency?: "read" | "exclusive";
}
```

Default from `ToolInvocation.kind` so existing tools need no initial edits.

## Dispatch rules

1. Build and validate each call as soon as it arrives.
2. Run `checkPermission()` before scheduling.
3. For `ask`, defer scheduling until user approval resolves.
4. Run `PreToolUse` hooks before scheduling.
5. Run `ensureWritableRoot()` immediately before the first write/exclusive tool.
6. Start read-lane tools up to a configurable concurrency limit.
7. Exclusive tools run one at a time and wait for earlier exclusive tools.
8. Do not start tools that appear after an exclusive tool until ordering safety is
   known. Conservative phase 1: an exclusive call creates a barrier; later calls
   wait until it completes.
9. Results are buffered by original call index and emitted to history in order.

This yields a safe middle ground:

```text
read/read/read -> parallel
read/read/bash -> reads can run, bash waits for prior ordered gate
bash/read      -> read waits behind bash in phase 1
edit/write     -> serial
```

Phase 2 can relax `bash/read` if the read is proven unaffected by the execute
tool, but phase 1 should be conservative.

## Sibling abort

Add an executor-level child `AbortController`:

- Each scheduled invocation receives a signal linked to the parent session signal.
- If any execute-kind tool returns `isError`, abort sibling in-flight execute
  tools and optionally read tools.
- User abort aborts all in-flight tools.
- A blocked/denied/invalid synthetic result does not abort siblings.

For phase 1, abort only if an execute-kind tool fails. Do not abort on read
failures.

## Result order and persistence

Provider APIs expect tool results to correspond to assistant tool calls. Preserve
order:

- Assistant text/tool call list is persisted once the assistant stream ends.
- Tool result messages are appended in call index order.
- If call 2 finishes before call 1, hold call 2 result in memory until call 1 is
  ready.
- Renderer may show live progress out of order, but history order remains stable.

This keeps `sanitizeForProvider()` semantics intact.

## Integration with current loop

Refactor current per-call execution body into reusable helpers:

```ts
buildInvocationOrSynthetic(call)
authorizeInvocation(call, invocation)
executeInvocation(call, invocation)
recordToolResult(call, result)
```

Then both paths use the same implementation:

- current serial path,
- new streaming executor path.

Gate the new path:

```ts
if (deps.streamingToolExecution && deps.provider.streamChat) {
  ...
} else {
  current path
}
```

## Configuration

```ts
execution: {
  streamingTools: boolean;          // default false during rollout
  readConcurrency: number;          // default 4
  abortSiblingExecuteOnError: boolean;
}
```

Environment:

- `DEEPCODER_STREAMING_TOOLS=1|0`
- `DEEPCODER_TOOL_READ_CONCURRENCY=4`

## Safety invariants

1. Every real tool execution passes through `checkPermission()`.
2. A `deny`, rejected `ask`, invalid args, or unknown tool never executes.
3. PreToolUse hooks can still block and cannot override policy denies.
4. Mutating and execute tools are serialized.
5. Copy-on-write worktree provisioning happens before the first write-effect tool
   and remains single-flight.
6. Tool result history order matches assistant tool-call order.
7. Provider sanitization does not drop newly orphaned calls/results.
8. User abort stops all in-flight work.
9. Feature flag off is byte-equivalent to current behavior.

## Tests

Unit:

- Streaming provider emits two read-only calls; executor starts both before
  stream `done`.
- Read-only calls finish out of order but history appends in call order.
- Mutate/execute calls run serially.
- `ask` approval blocks scheduling until approved.
- Denied/invalid calls produce synthetic results and do not execute.
- Execute failure aborts sibling execute work.
- Stream error after content aborts in-flight tools and propagates.
- Feature flag off uses current serial path.

Adversarial:

- Prompt tries to force parallel writes; writes remain serial.
- Tool call after a denied call cannot inherit permission.
- Hook denial races with other in-flight tools and still prevents execution.
- Copy-on-write provisioning runs once under concurrent reads + first write.
- Result-order fuzz preserves provider-safe history.

Integration:

- Faux streaming provider emits `read_file`, `grep`, `glob`; verify lower
  wall-clock with injected delayed tools.
- Mixed `read_file`, `run_bash`, `edit_file` preserves ordering and policy.
- TUI receives progress without corrupting transcript.

Gate:

- `npm run test:phase` green.

## Phasing

1. Extract current serial tool execution body into shared helper functions.
2. Add `StreamingToolExecutor` with no integration; unit-test lanes/order/abort.
3. Add streaming consume path behind `DEEPCODER_STREAMING_TOOLS=1`.
4. Enable parallel read-only tools only; exclusive tools still serial.
5. Add sibling abort for execute tools.
6. Add renderer progress events.
7. Consider default-on after enough adversarial and latency evidence.

## Effort / risk

Large, medium-high risk. The code path touches permission, hooks, execution,
abort, persistence, and UI progress. The safe rollout is feature-flagged and
helper-first: reuse the exact same authorization/execution code for serial and
streaming paths, then add concurrency around it.

## Status

**Phase 2 IMPLEMENTED** (standalone executor + tests; unwired). Phases 1, 3–7
(serial-body helper extraction, streaming consume path, loop integration behind
`DEEPCODER_STREAMING_TOOLS`, sibling abort wiring, renderer events) remain proposed.

Implementation notes:

- New `src/agent/streamingToolExecutor.ts` — `StreamingToolExecutor` with a
  dependency-injected execution surface (`StreamingToolExecutorDeps`:
  `classify`/`authorize`/`execute` + `readConcurrency`/`abortSiblingExecuteOnError`/
  `signal`/`isExecuteError`), plus `ToolExecutionUpdate` / `ExecutionLane`. A single
  sequential scheduler pump (condition-variable + FIFO semaphore, no timers) with a
  child `AbortController` linked to the parent signal. **Not imported anywhere yet**
  — it is a tested unit awaiting the integration phases.
- Lanes are derived purely from the injected `classify()` seam, so the optional
  `concurrency?` field on `Tool` (`src/tools/types.ts`) was **not** needed and not
  added — it belongs to the integration phase.
- Tests: `test/streamingToolExecutor.test.ts` (8 unit — concurrent read start,
  out-of-order→in-order results, exclusive serialization, read-concurrency cap,
  barrier, authorize-before-schedule, sibling abort, zero-calls) +
  `test/adversarial/streaming-tool-executor.test.ts` (6 `[SECURITY]` — execute⊆
  authorized-ok, no inherited approval, parent-abort stops in-flight + no new starts,
  result-order fuzz, serialization-holds, no-leak-past-barrier).

**⚠️ Reconcile at integration:** the standalone executor lets an exclusive call
**start while earlier reads are still in flight** (it only prevents exclusive/exclusive
overlap and barriers *later* calls). This plan's prose (§Dispatch rules: "bash waits
for prior ordered gate") is more conservative — the exclusive should wait for prior
in-flight reads to drain before a real mutate/execute runs, to avoid read↔write races
on the working tree. Harmless today (unwired, injected fake execute), but the loop
integration MUST enforce drain-before-exclusive, with an adversarial test.
