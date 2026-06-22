/**
 * DeepSeek-specific behavioral guidance appended to the system prompt for every
 * run (deepcoder is now DeepSeek-only). The guidance steers the model toward
 * direct tool calling, conciseness, minimal code, and staying on task — avoiding
 * the over-explaining / retry-hesitation / scope-creep quirks of DeepSeek V4.
 *
 * These phrases are UNIQUE to the new section and won't appear in the prompt
 * until the section is added.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt } from "../../src/agent/systemPrompt.js";

test("deepcoder guidance tells the model to call tools directly without narration", () => {
  const p = buildSystemPrompt({ workspaceRoot: "/tmp/x", mode: "ask" });
  assert.match(p, /Call tools directly/i);
  assert.match(p, /Do NOT describe what you would do/i);
});

test("deepcoder guidance demands conciseness and no diff preambles", () => {
  const p = buildSystemPrompt({ workspaceRoot: "/tmp/x", mode: "ask" });
  assert.match(p, /Be extremely concise/i);
  assert.match(p, /No summary of changes already visible in a diff/i);
});

test("deepcoder guidance warns against retrying the exact same failed call", () => {
  const p = buildSystemPrompt({ workspaceRoot: "/tmp/x", mode: "ask" });
  assert.match(p, /Do NOT retry the exact same call/i);
});

test("deepcoder guidance insists on strict scope (no extra features)", () => {
  const p = buildSystemPrompt({ workspaceRoot: "/tmp/x", mode: "ask" });
  assert.match(p, /Do exactly what was asked, nothing more/i);
});

test("deepcoder guidance reminds the model about long context (1M tokens)", () => {
  const p = buildSystemPrompt({ workspaceRoot: "/tmp/x", mode: "ask" });
  assert.match(p, /full conversation history/i);
  assert.match(p, /1M tokens/i);
});

test("deepcoder guidance tells the model to write minimal code", () => {
  const p = buildSystemPrompt({ workspaceRoot: "/tmp/x", mode: "ask" });
  assert.match(p, /Write minimal code/i);
  assert.match(p, /no unnecessary comments/i);
});
