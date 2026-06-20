/**
 * Gemini 3.x thought_signature round-trip.
 *
 * Gemini 3.x returns an opaque `thought_signature` with each function call (in
 * the OpenAI-compat response at tool_calls[].extra_content.google.*) and 400s on
 * the next turn unless it is echoed back. We capture it onto ToolCall.providerMeta
 * and replay it in the wire message. Other providers never produce it, so the
 * field stays absent for them.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseWireToolCall,
  toWireMessage,
  createToolCallAccumulator,
} from "../../src/providers/openaiCompatible.js";
import type { AgentMessage } from "../../src/providers/types.js";

const SIG = "EqoECqcEAQw51thought-signature-blob";

test("parseWireToolCall captures extra_content into providerMeta", () => {
  const tc = parseWireToolCall({
    id: "c1", type: "function",
    function: { name: "glob", arguments: '{"pattern":"*.ts"}' },
    extra_content: { google: { thought_signature: SIG } },
  });
  assert.equal(tc.id, "c1");
  assert.equal(tc.name, "glob");
  assert.deepEqual(tc.arguments, { pattern: "*.ts" });
  assert.equal((tc.providerMeta?.extra_content as any)?.google?.thought_signature, SIG);
});

test("parseWireToolCall leaves providerMeta undefined when there is no extra_content", () => {
  const tc = parseWireToolCall({ id: "c2", type: "function", function: { name: "x", arguments: "{}" } });
  assert.equal(tc.providerMeta, undefined);
});

test("toWireMessage replays extra_content from providerMeta on assistant tool calls", () => {
  const msg: AgentMessage = {
    role: "assistant", content: "",
    toolCalls: [{ id: "c1", name: "glob", arguments: { pattern: "*.ts" }, providerMeta: { extra_content: { google: { thought_signature: SIG } } } }],
  };
  const wire = toWireMessage(msg) as any;
  assert.equal(wire.tool_calls[0].extra_content.google.thought_signature, SIG);
  assert.equal(wire.tool_calls[0].id, "c1");
  assert.equal(wire.tool_calls[0].function.name, "glob");
});

test("toWireMessage omits extra_content for tool calls without providerMeta (other providers safe)", () => {
  const msg: AgentMessage = {
    role: "assistant", content: "",
    toolCalls: [{ id: "c2", name: "x", arguments: {} }],
  };
  const wire = toWireMessage(msg) as any;
  assert.equal("extra_content" in wire.tool_calls[0], false);
});

test("full round-trip: parse a wire tool call then re-serialize preserves the signature", () => {
  const tc = parseWireToolCall({
    id: "c3", type: "function",
    function: { name: "read", arguments: '{"path":"a.ts"}' },
    extra_content: { google: { thought_signature: SIG } },
  });
  const wire = toWireMessage({ role: "assistant", content: "", toolCalls: [tc] }) as any;
  assert.equal(wire.tool_calls[0].extra_content.google.thought_signature, SIG);
});

test("streaming accumulator captures extra_content from a tool-call delta", () => {
  const acc = createToolCallAccumulator();
  acc.push({ index: 0, id: "c1", function: { name: "glob", arguments: '{"pattern":"*.ts"}' }, extra_content: { google: { thought_signature: SIG } } });
  const calls = acc.finalize();
  assert.equal(calls.length, 1);
  assert.equal((calls[0]!.providerMeta?.extra_content as any)?.google?.thought_signature, SIG);
});
