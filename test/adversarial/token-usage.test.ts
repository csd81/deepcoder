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
    promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedPromptTokens: 0,
  });
});

test("parseUsage maps the Responses shape (input_tokens/output_tokens)", () => {
  assert.deepEqual(parseUsage({ input_tokens: 12, output_tokens: 8, total_tokens: 20 }), {
    promptTokens: 12, completionTokens: 8, totalTokens: 20, cachedPromptTokens: 0,
  });
});

test("parseUsage computes total when missing, and ignores garbage", () => {
  assert.deepEqual(parseUsage({ prompt_tokens: 4, completion_tokens: 6 }), {
    promptTokens: 4, completionTokens: 6, totalTokens: 10, cachedPromptTokens: 0,
  });
  assert.equal(parseUsage(undefined), undefined);
  assert.equal(parseUsage({}), undefined);
  assert.equal(parseUsage({ foo: "bar" }), undefined);
});

test("[cache-aware] parseUsage extracts prompt_cache_hit_tokens into cachedPromptTokens, leaving promptTokens as the full total", () => {
  // DeepSeek shape: prompt_tokens = hit + miss; we keep promptTokens as the total.
  assert.deepEqual(
    parseUsage({ prompt_tokens: 1000, prompt_cache_hit_tokens: 900, prompt_cache_miss_tokens: 100, completion_tokens: 50, total_tokens: 1050 }),
    { promptTokens: 1000, completionTokens: 50, totalTokens: 1050, cachedPromptTokens: 900 },
  );
  // Alternate field names also map.
  assert.equal(parseUsage({ prompt_tokens: 10, cached_tokens: 4, completion_tokens: 0 })?.cachedPromptTokens, 4);
  assert.equal(parseUsage({ input_tokens: 10, cache_read_input_tokens: 3, output_tokens: 0 })?.cachedPromptTokens, 3);
});

test("[cache-aware] parseUsage with no cache field reports cachedPromptTokens 0 and leaves other behavior unchanged", () => {
  const u = parseUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  assert.equal(u?.cachedPromptTokens, 0);
  assert.equal(u?.promptTokens, 10);
  // Still returns undefined when there are no counts at all.
  assert.equal(parseUsage({}), undefined);
});

test("addUsage accumulates into the target and ignores undefined", () => {
  const acc = { ...EMPTY_USAGE };
  addUsage(acc, { promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  addUsage(acc, { promptTokens: 1, completionTokens: 2, totalTokens: 3 });
  addUsage(acc, undefined);
  assert.deepEqual(acc, { promptTokens: 11, completionTokens: 7, totalTokens: 18, cachedPromptTokens: 0 });
  assert.deepEqual(EMPTY_USAGE, { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedPromptTokens: 0 });
});

test("[cache-aware] addUsage accumulates cachedPromptTokens (undefined treated as 0)", () => {
  const acc = { ...EMPTY_USAGE };
  addUsage(acc, { promptTokens: 100, completionTokens: 5, totalTokens: 105, cachedPromptTokens: 90 });
  addUsage(acc, { promptTokens: 10, completionTokens: 1, totalTokens: 11 }); // no cache field
  addUsage(acc, { promptTokens: 5, completionTokens: 0, totalTokens: 5, cachedPromptTokens: 5 });
  assert.equal(acc.cachedPromptTokens, 95);
  assert.equal(acc.promptTokens, 115);
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
