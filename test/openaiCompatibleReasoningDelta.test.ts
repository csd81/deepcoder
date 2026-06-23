import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAICompatibleProvider } from "../src/providers/openaiCompatible.js";
import type { ModelEvent } from "../src/providers/types.js";

/**
 * Build a fake OpenAI-compatible streaming response from a list of chunks.
 * Each chunk mirrors the wire shape consumed by streamChat's delta loop.
 */
function fakeStream(chunks: unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

/**
 * A DeepSeek-Pro stream interleaves `reasoning_content` deltas (chain-of-thought)
 * with normal `content` deltas. The reasoning deltas MUST NOT leak into the
 * assistant text — they are deliberately discarded by the provider.
 */
test("streamChat discards reasoning_content deltas and never leaks them into assistant text", async () => {
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    baseUrl: "http://example.invalid",
    label: "Fake",
  });

  // Replace the real client with a fake that yields a reasoning-bearing stream.
  const chunks = [
    { choices: [{ delta: { reasoning_content: "let me think... " } }] },
    { choices: [{ delta: { reasoning_content: "more private thoughts " } }] },
    { choices: [{ delta: { content: "Hello" } }] },
    { choices: [{ delta: { content: " world" } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
  ];
  (provider as unknown as { client: unknown }).client = {
    chat: { completions: { create: async () => fakeStream(chunks) } },
  };

  const events: ModelEvent[] = [];
  for await (const ev of provider.streamChat({ messages: [], tools: [], model: "deepseek-v4-pro" })) {
    events.push(ev);
  }

  const text = events
    .filter((e): e is Extract<ModelEvent, { type: "assistant_text_delta" }> => e.type === "assistant_text_delta")
    .map((e) => e.text)
    .join("");

  assert.equal(text, "Hello world", "assistant text must contain only `content`, not `reasoning_content`");
  assert.ok(!text.includes("think"), "reasoning_content must not leak into assistant text");
  assert.ok(!text.includes("private"), "reasoning_content must not leak into assistant text");
  assert.ok(events.some((e) => e.type === "done"), "stream should terminate with a done event");
});
