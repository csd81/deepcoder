/**
 * Regression: history compaction must not break the Gemini 3.x replay. The
 * summary is a USER message (not a second inline `system` message, which the
 * Gemini OpenAI-compatible endpoint rejects post-compaction), thought_signature
 * (providerMeta) on kept tail tool calls survives, and the kept tail does not
 * orphan a tool message. Also: a 400 surfaces its real reason.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { compactIfNeeded, isSummary } from "../../src/context/compaction.js";
import { mapProviderError } from "../../src/providers/openaiCompatible.js";
import type { AgentMessage } from "../../src/providers/types.js";

function bigText(tag: string): string {
  return tag + " " + "x".repeat(2000);
}

/** A long conversation with Gemini-style tool calls carrying a thought_signature. */
function conversation(): AgentMessage[] {
  const msgs: AgentMessage[] = [
    { role: "system", content: "system prompt" },
    { role: "user", content: bigText("task: do the thing") },
  ];
  for (let i = 0; i < 8; i++) {
    msgs.push({
      role: "assistant", content: bigText(`step ${i}`),
      toolCalls: [{
        id: `c${i}`, name: "read_file", arguments: { path: `f${i}.ts` },
        providerMeta: { extra_content: { google: { thought_signature: `SIG_${i}` } } },
      }],
    });
    msgs.push({ role: "tool", toolCallId: `c${i}`, content: bigText(`result ${i}`) });
  }
  return msgs;
}

test("compaction summary is a USER message (not a second inline system message)", () => {
  const msgs = conversation();
  const res = compactIfNeeded(msgs, { budgetTokens: 4000, compactAt: 0.8, todos: [] });
  assert.equal(res.compacted, true);
  const summary = msgs.find(isSummary);
  assert.ok(summary, "a summary was inserted");
  assert.equal(summary!.role, "user", "summary must be a user message for Gemini-compat");
  // Exactly one system message (the original prompt) — no second system message.
  assert.equal(msgs.filter((m) => m.role === "system").length, 1);
});

test("compaction preserves thought_signature on kept tail tool calls", () => {
  const msgs = conversation();
  compactIfNeeded(msgs, { budgetTokens: 4000, compactAt: 0.8, todos: [] });
  const withSig = msgs.filter((m) => m.role === "assistant" && m.toolCalls?.length);
  assert.ok(withSig.length > 0, "tail keeps assistant tool-call turns");
  for (const m of withSig) {
    const meta = m.toolCalls![0].providerMeta as { extra_content?: { google?: { thought_signature?: string } } };
    assert.ok(meta?.extra_content?.google?.thought_signature, "thought_signature survives compaction");
  }
});

test("compaction does not leave the summary directly followed by an orphaned tool message", () => {
  const msgs = conversation();
  compactIfNeeded(msgs, { budgetTokens: 4000, compactAt: 0.8, todos: [] });
  const sumIdx = msgs.findIndex(isSummary);
  assert.notEqual(msgs[sumIdx + 1]?.role, "tool", "first kept turn must not be an orphaned tool result");
});

test("a 400 surfaces its real reason (e.g. thought_signature), not 'check the model name'", () => {
  const err = { status: 400, error: { message: "Function call must include a thought_signature." } };
  const pe = mapProviderError(err, { label: "Gemini", model: "gemini-3.1-pro-preview" });
  assert.match(pe.message, /thought_signature/);
  assert.doesNotMatch(pe.message, /Check the model name/);
});

test("a 404 still reads as a model-name problem", () => {
  const pe = mapProviderError({ status: 404 }, { label: "Gemini", model: "bogus" });
  assert.match(pe.message, /Check the model name/);
});
