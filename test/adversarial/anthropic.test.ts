import { test } from "node:test";
import assert from "node:assert/strict";
import { toAnthropicMessages, toAnthropicTools, parseAnthropicContent } from "../../src/providers/anthropic.js";
import type { AgentMessage } from "../../src/providers/types.js";

test("system messages are hoisted to the top-level system field", () => {
  const { system, messages } = toAnthropicMessages([
    { role: "system", content: "you are X" },
    { role: "user", content: "hi" },
  ]);
  assert.equal(system, "you are X");
  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.role, "user");
});

test("assistant tool calls become tool_use blocks", () => {
  const msgs: AgentMessage[] = [
    { role: "user", content: "go" },
    { role: "assistant", content: "let me look", toolCalls: [{ id: "t1", name: "read_file", arguments: { path: "a" } }] },
    { role: "tool", toolCallId: "t1", name: "read_file", content: "data" },
  ];
  const { messages } = toAnthropicMessages(msgs);
  const assistant = messages.find((m) => m.role === "assistant")!;
  const blocks = assistant.content as Array<{ type: string; name?: string }>;
  assert.ok(blocks.some((b) => b.type === "text"));
  assert.ok(blocks.some((b) => b.type === "tool_use" && b.name === "read_file"));
});

test("consecutive tool results merge into ONE user message (Anthropic requires alternating roles)", () => {
  const msgs: AgentMessage[] = [
    { role: "assistant", content: "", toolCalls: [
      { id: "t1", name: "read_file", arguments: {} },
      { id: "t2", name: "grep", arguments: {} },
    ] },
    { role: "tool", toolCallId: "t1", name: "read_file", content: "r1" },
    { role: "tool", toolCallId: "t2", name: "grep", content: "r2" },
    { role: "assistant", content: "done" },
  ];
  const { messages } = toAnthropicMessages(msgs);
  // assistant(tool_use) , user(2 tool_result) , assistant(text)
  assert.equal(messages.length, 3);
  const toolMsg = messages[1]!;
  assert.equal(toolMsg.role, "user");
  const blocks = toolMsg.content as Array<{ type: string; tool_use_id?: string }>;
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map((b) => b.tool_use_id), ["t1", "t2"]);
  assert.ok(blocks.every((b) => b.type === "tool_result"));
});

test("an assistant message with no content and no tool calls is dropped", () => {
  const { messages } = toAnthropicMessages([
    { role: "user", content: "hi" },
    { role: "assistant", content: "" },
  ]);
  assert.equal(messages.length, 1);
});

test("toAnthropicTools maps to name/description/input_schema", () => {
  const tools = toAnthropicTools([{ name: "read_file", description: "read", parameters: { type: "object" } }]);
  assert.deepEqual(tools, [{ name: "read_file", description: "read", input_schema: { type: "object" } }]);
});

test("parseAnthropicContent extracts text and tool_use blocks", () => {
  const res = parseAnthropicContent([
    { type: "text", text: "hello " },
    { type: "text", text: "world" },
    { type: "tool_use", id: "t1", name: "grep", input: { pattern: "x" } },
  ]);
  assert.equal(res.text, "hello world");
  assert.equal(res.toolCalls.length, 1);
  assert.deepEqual(res.toolCalls[0], { id: "t1", name: "grep", arguments: { pattern: "x" } });
});

test("parseAnthropicContent tolerates empty/malformed content", () => {
  assert.deepEqual(parseAnthropicContent([]), { text: "", toolCalls: [] });
});
