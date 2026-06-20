/**
 * Per-session token usage: normalize provider usage shapes and accumulate.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUsage, addUsage, EMPTY_USAGE } from "../../src/providers/usage.js";
import { consumeStream } from "../../src/agent/agentLoop.js";
import type { ModelEvent } from "../../src/providers/types.js";

test("parseUsage maps the OpenAI/chat shape", () => {
  assert.deepEqual(parseUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }), {
    promptTokens: 10, completionTokens: 5, totalTokens: 15,
  });
});

test("parseUsage maps the Responses shape (input_tokens/output_tokens)", () => {
  assert.deepEqual(parseUsage({ input_tokens: 12, output_tokens: 8, total_tokens: 20 }), {
    promptTokens: 12, completionTokens: 8, totalTokens: 20,
  });
});

test("parseUsage computes total when missing, and ignores garbage", () => {
  assert.deepEqual(parseUsage({ prompt_tokens: 4, completion_tokens: 6 }), {
    promptTokens: 4, completionTokens: 6, totalTokens: 10,
  });
  assert.equal(parseUsage(undefined), undefined);
  assert.equal(parseUsage({}), undefined);
  assert.equal(parseUsage({ foo: "bar" }), undefined);
});

test("addUsage accumulates into the target and ignores undefined", () => {
  const acc = { ...EMPTY_USAGE };
  addUsage(acc, { promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  addUsage(acc, { promptTokens: 1, completionTokens: 2, totalTokens: 3 });
  addUsage(acc, undefined);
  assert.deepEqual(acc, { promptTokens: 11, completionTokens: 7, totalTokens: 18 });
  assert.deepEqual(EMPTY_USAGE, { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
});

test("consumeStream surfaces usage from the done event", async () => {
  async function* stream(): AsyncIterable<ModelEvent> {
    yield { type: "assistant_text_delta", text: "hi" };
    yield { type: "done", finishReason: "stop", usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 } };
  }
  const r = await consumeStream(stream());
  assert.equal(r.text, "hi");
  assert.deepEqual(r.usage, { promptTokens: 7, completionTokens: 3, totalTokens: 10 });
});
