/**
 * streamingConsume — the streaming consume path for the streaming tool executor.
 *
 * Consumes a provider `ModelEvent` stream and feeds each COMPLETE tool call to
 * an executor sink as soon as it arrives, so tool execution can begin before the
 * assistant stream finishes. It returns the assembled assistant response (text +
 * collected tool calls + usage); the tool RESULTS are retrieved separately by the
 * caller from the executor.
 *
 * This module is intentionally self-contained. It mirrors the semantics of
 * `consumeStream` in `agentLoop.ts` (text accumulation, tool-call collection,
 * `usage` capture, and the `hadContent` flag on a stream failure) but does NOT
 * import `StreamError` from the loop — that would create an import cycle once this
 * module is wired in. Instead, on failure it throws a plain `Error` carrying a
 * duck-typed boolean `.hadContent` property.
 *
 * Kept small and pure: no timers, no `Date`/`Math.random`.
 */

import type { ChatResponse, ModelEvent, ToolCall } from "../providers/types.js";

export interface StreamConsumeResult {
  text: string;
  toolCalls: ToolCall[];
  usage?: ChatResponse["usage"];
}

/**
 * Minimal structural interface onto `StreamingToolExecutor`. We depend on this
 * shape rather than importing the class so tests can pass a fake sink.
 */
export interface ToolCallSink {
  accept(call: ToolCall): void;
  finishAssistant(): void;
}

/**
 * Consume a provider ModelEvent stream, feeding each COMPLETE tool call to the
 * executor sink as soon as it arrives (so execution can begin before the
 * assistant stream finishes), and return the assembled assistant response.
 *
 * The tool RESULTS are retrieved separately by the caller from the executor —
 * this function only drives `accept()` + `finishAssistant()` and returns the
 * assistant message.
 *
 * `finishAssistant()` is called exactly once on every terminal path (a `done`
 * event, a stream `error` event, or a mid-iteration exception) and never twice.
 * On a failure it throws an `Error` whose `.hadContent` reflects whether any text
 * or tool call was already emitted before the failure.
 */
export async function consumeStreamWithToolExecution(
  stream: AsyncIterable<ModelEvent>,
  sink: ToolCallSink,
  onDelta?: (chunk: string) => void,
): Promise<StreamConsumeResult> {
  let text = "";
  const toolCalls: ToolCall[] = [];
  let usage: ChatResponse["usage"];
  let hadContent = false;
  let finished = false;

  const finishOnce = (): void => {
    if (finished) return;
    finished = true;
    sink.finishAssistant();
  };

  try {
    for await (const ev of stream) {
      switch (ev.type) {
        case "assistant_text_delta":
          text += ev.text;
          hadContent = true;
          onDelta?.(ev.text);
          break;
        case "tool_call_complete":
          toolCalls.push(ev.toolCall);
          hadContent = true;
          // Feed the executor immediately — this is the whole point: execution
          // starts before `done` arrives.
          sink.accept(ev.toolCall);
          break;
        case "done":
          if (ev.usage !== undefined) usage = ev.usage;
          break;
        case "error":
          throw makeStreamError(ev.message, hadContent);
        default:
          // Unknown/malformed event — ignore it, keep accumulating.
          break;
      }
    }
  } catch (err) {
    // No more events will arrive on either failure path → close the sink once.
    finishOnce();
    if (isStreamFailure(err)) throw err;
    // A mid-iteration drop/exception — wrap with the current content state.
    throw makeStreamError((err as Error)?.message ?? String(err), hadContent);
  }

  finishOnce();
  return { text, toolCalls, usage };
}

/** Marker so a re-thrown stream-error isn't double-wrapped. */
const STREAM_FAILURE = Symbol("streamFailure");

interface StreamFailure extends Error {
  hadContent: boolean;
  [STREAM_FAILURE]: true;
}

function makeStreamError(message: string, hadContent: boolean): StreamFailure {
  const err = new Error(message) as StreamFailure;
  err.hadContent = hadContent;
  err[STREAM_FAILURE] = true;
  return err;
}

function isStreamFailure(err: unknown): err is StreamFailure {
  return (
    err instanceof Error &&
    (err as Partial<StreamFailure>)[STREAM_FAILURE] === true
  );
}
