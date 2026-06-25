import { test } from "node:test";
import assert from "node:assert/strict";

import {
  consumeStreamWithToolExecution,
  type ToolCallSink,
} from "../../src/agent/streamingConsume.js";
import type { ModelEvent, ToolCall } from "../../src/providers/types.js";

function tc(id: string): ToolCall {
  return { id, name: "do_thing", arguments: {} };
}

function makeSink(): ToolCallSink & { accepted: ToolCall[]; finishCount: number } {
  const accepted: ToolCall[] = [];
  let finishCount = 0;
  return {
    accepted,
    get finishCount() {
      return finishCount;
    },
    accept(call: ToolCall) {
      accepted.push(call);
    },
    finishAssistant() {
      finishCount += 1;
    },
  };
}

test("[SECURITY] stream error AFTER content → throws hadContent=true, finishAssistant once", async () => {
  const sink = makeSink();

  async function* stream(): AsyncGenerator<ModelEvent> {
    yield { type: "assistant_text_delta", text: "partial answer" };
    yield { type: "error", message: "upstream exploded" };
  }

  await assert.rejects(
    () => consumeStreamWithToolExecution(stream(), sink),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal((err as Error & { hadContent?: boolean }).hadContent, true);
      assert.match((err as Error).message, /upstream exploded/);
      return true;
    },
  );

  assert.equal(sink.finishCount, 1);
});

test("[SECURITY] stream throws mid-iteration before any content → hadContent=false, finish once", async () => {
  const sink = makeSink();

  async function* stream(): AsyncGenerator<ModelEvent> {
    if (Date.now() >= 0) throw new Error("connection dropped");
    yield { type: "done" };
  }

  await assert.rejects(
    () => consumeStreamWithToolExecution(stream(), sink),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal((err as Error & { hadContent?: boolean }).hadContent, false);
      assert.match((err as Error).message, /connection dropped/);
      return true;
    },
  );

  assert.equal(sink.finishCount, 1);
});

test("[SECURITY] finishAssistant never called more than once on error-after-tool-calls", async () => {
  const sink = makeSink();

  async function* stream(): AsyncGenerator<ModelEvent> {
    yield { type: "tool_call_complete", toolCall: tc("a") };
    yield { type: "tool_call_complete", toolCall: tc("b") };
    yield { type: "error", message: "boom" };
  }

  await assert.rejects(
    () => consumeStreamWithToolExecution(stream(), sink),
    (err: unknown) => {
      assert.equal((err as Error & { hadContent?: boolean }).hadContent, true);
      return true;
    },
  );

  // Both tool calls were dispatched before the error...
  assert.deepEqual(
    sink.accepted.map((c) => c.id),
    ["a", "b"],
  );
  // ...and the sink was closed exactly once.
  assert.equal(sink.finishCount, 1);
});

test("[SECURITY] error with no prior content → hadContent=false", async () => {
  const sink = makeSink();

  async function* stream(): AsyncGenerator<ModelEvent> {
    yield { type: "error", message: "immediate failure" };
  }

  await assert.rejects(
    () => consumeStreamWithToolExecution(stream(), sink),
    (err: unknown) => {
      assert.equal((err as Error & { hadContent?: boolean }).hadContent, false);
      return true;
    },
  );
  assert.equal(sink.finishCount, 1);
});

test("[SECURITY] malformed/unknown event type is ignored — no throw, accumulation intact", async () => {
  const sink = makeSink();

  // A malformed event that isn't part of the ModelEvent union; the consumer
  // must ignore it rather than crash or mangle the assistant message.
  const bogus = { type: "totally_unknown", junk: true } as unknown as ModelEvent;

  const result = await consumeStreamWithToolExecution(
    (async function* (): AsyncGenerator<ModelEvent> {
      yield { type: "assistant_text_delta", text: "before " };
      yield bogus;
      yield { type: "assistant_text_delta", text: "after" };
      yield { type: "tool_call_complete", toolCall: tc("z") };
      yield { type: "done" };
    })(),
    sink,
  );

  assert.equal(result.text, "before after");
  assert.deepEqual(
    result.toolCalls.map((c) => c.id),
    ["z"],
  );
  assert.equal(sink.finishCount, 1);
  assert.deepEqual(
    sink.accepted.map((c) => c.id),
    ["z"],
  );
});
