/**
 * The system prompt must make the model aware that mutating/dangerous shell
 * commands are gated by the command classifier (and may be denied), so the model
 * proposes a safe alternative instead of blindly retrying.
 *
 * It must ALSO no longer carry the dead web-aware research block: DeepSeek-only
 * means provider-side web knowledge is never trusted, so buildWebAwarePrompt()'s
 * text must not leak into the built prompt and `webAware` is no longer an option.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt } from "../../src/agent/systemPrompt.js";

test("system prompt warns that dangerous commands are classifier-gated", () => {
  const p = buildSystemPrompt({ workspaceRoot: "/tmp/x", mode: "ask" });
  assert.match(p, /command classifier/i);
  assert.match(p, /propose a safe alternative/i);
});

test("system prompt no longer injects the web-aware research block", () => {
  const p = buildSystemPrompt({ workspaceRoot: "/tmp/x", mode: "ask" });
  // Distinctive phrases emitted by buildWebAwarePrompt() in searchCapableRouting.ts.
  assert.doesNotMatch(p, /Web-Aware Research Instructions/i);
  assert.doesNotMatch(p, /only local web_search and web_fetch create auditable/i);
});
