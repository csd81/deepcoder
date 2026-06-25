import { test } from "node:test";
import assert from "node:assert/strict";

import {
  consumeStreamWithToolExecution,
  type ToolCallSink,
} from "../src/agent/streamingConsume.js";
import type { ModelEvent, ToolCall } from "../src/providers/types.js";

function tc(id: string, name = "do_thing"): ToolCall {
  return { id, name, arguments: { k: id } };
}

/** Async generator yielding scripted events. */
async function* script(events: ModelEvent[]): AsyncGenerator<ModelEvent> {
  for (const ev of events) yield ev;
}

/** Fake sink recording an ordered log of calls. */
function makeSink(log: string[]): ToolCallSink & { accepted: ToolCall[]; finishCount: number } {
  const accepted: ToolCall[] = [];
  let finishCount = 0;
  return {
    accepted,
    get finishCount() {
      return finishCount;
    },
    accept(call: ToolCall) {
      accepted.push(call);
      log.push(`accept:${call.id}`);
    },
    finishAssistant() {
      finishCount += 1;
      log.push("finish");
    },
  };
}

test("text deltas accumulate and onDelta is called per chunk", async () => {
  const log: string[] = [];
  const sink = makeSink(log);
  const chunks: string[] = [];

  const result = await consumeStreamWithToolExecution(
    script([
      { type: "assistant_text_delta", text: "Hello " },
      { type: "assistant_text_delta", text: "world" },
      { type: "done" },
    ]),
    sink,
    (c) => chunks.push(c),
  );

  assert.equal(result.text, "Hello world");
  assert.deepEqual(chunks, ["Hello ", "world"]);
  assert.deepEqual(result.toolCalls, []);
  assert.equal(sink.finishCount, 1);
});

test("each tool_call_complete triggers sink.accept immediately (before done/finish)", async () => {
  const log: string[] = [];
  const sink = makeSink(log);

  await consumeStreamWithToolExecution(
    script([
      { type: "tool_call_complete", toolCall: tc("a") },
      { type: "done" },
    ]),
    sink,
  );

  // accept must precede finish in the recorded order.
  assert.deepEqual(log, ["accept:a", "finish"]);
  assert.ok(log.indexOf("accept:a") < log.indexOf("finish"));
});

test("on done: returns full {text, toolCalls, usage}; finishAssistant called exactly once", async () => {
  const log: string[] = [];
  const sink = makeSink(log);

  const result = await consumeStreamWithToolExecution(
    script([
      { type: "assistant_text_delta", text: "hi" },
      { type: "tool_call_complete", toolCall: tc("x") },
      {
        type: "done",
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      },
    ]),
    sink,
  );

  assert.equal(result.text, "hi");
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0]!.id, "x");
  assert.deepEqual(result.usage, {
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
  });
  assert.equal(sink.finishCount, 1);
});

test("two tool calls → both accepted in stream order; both in returned toolCalls", async () => {
  const log: string[] = [];
  const sink = makeSink(log);

  const result = await consumeStreamWithToolExecution(
    script([
      { type: "tool_call_complete", toolCall: tc("first") },
      { type: "tool_call_complete", toolCall: tc("second") },
      { type: "done" },
    ]),
    sink,
  );

  assert.deepEqual(
    sink.accepted.map((c) => c.id),
    ["first", "second"],
  );
  assert.deepEqual(
    result.toolCalls.map((c) => c.id),
    ["first", "second"],
  );
  assert.deepEqual(log, ["accept:first", "accept:second", "finish"]);
});

test("usage is captured when the stream provides it", async () => {
  const log: string[] = [];
  const sink = makeSink(log);

  const result = await consumeStreamWithToolExecution(
    script([
      {
        type: "done",
        usage: {
          promptTokens: 100,
          completionTokens: 20,
          totalTokens: 120,
          cachedPromptTokens: 80,
        },
      },
    ]),
    sink,
  );

  assert.deepEqual(result.usage, {
    promptTokens: 100,
    completionTokens: 20,
    totalTokens: 120,
    cachedPromptTokens: 80,
  });
});

test("no usage event → usage is undefined", async () => {
  const log: string[] = [];
  const sink = makeSink(log);

  const result = await consumeStreamWithToolExecution(
    script([{ type: "assistant_text_delta", text: "no usage" }, { type: "done" }]),
    sink,
  );

  assert.equal(result.usage, undefined);
});
