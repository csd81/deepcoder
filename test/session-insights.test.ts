import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeSession, type SessionData } from "../src/cli/sessionInsights.js";
import type { AgentMessage, ToolCall } from "../src/providers/types.js";

// Red-seed anchor: deterministic analysis — no I/O, no model.

const EMPTY_TOKEN_USAGE = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

function fakeSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    messages: [],
    tokenUsage: { ...EMPTY_TOKEN_USAGE },
    ...overrides,
  };
}

function toolCall(name: string): ToolCall {
  return { id: "tc-1", name, arguments: {} };
}

function assistantMsg(content: string, tcs?: ToolCall[]): AgentMessage {
  return { role: "assistant", content, toolCalls: tcs };
}

function userMsg(content: string): AgentMessage {
  return { role: "user", content };
}

function toolMsg(content: string): AgentMessage {
  return { role: "tool", content, toolCallId: "tc-1", name: "read_file" };
}

test("analyzeSession returns default insights for an empty session", () => {
  const i = analyzeSession(fakeSession());
  assert.equal(i.summary, "general — 0 tool calls, 0 messages");
  assert.deepEqual(i.goalCategories, []);
  assert.equal(i.satisfaction, "high");
  assert.deepEqual(i.frictionPoints, []);
  assert.deepEqual(i.toolsUsed, []);
  assert.equal(i.tokensUsed, 0);
  assert.equal(i.turnsUsed, 0);
});

test("analyzeSession counts tool calls per tool", () => {
  const session = fakeSession({
    messages: [
      assistantMsg("Let me read the file", [toolCall("read_file"), toolCall("grep")]),
      assistantMsg("More reading", [toolCall("read_file")]),
    ],
  });
  const i = analyzeSession(session);
  assert.equal(i.toolsUsed.length, 2);
  const read = i.toolsUsed.find((t) => t.name === "read_file");
  const grep = i.toolsUsed.find((t) => t.name === "grep");
  assert.equal(read?.count, 2);
  assert.equal(grep?.count, 1);
  assert.equal(i.turnsUsed, 2);
});

test("analyzeSession detects goal categories from first user message", () => {
  const session = fakeSession({
    messages: [
      userMsg("Fix the bug in the crash handler — it fails on incorrect input"),
    ],
  });
  const i = analyzeSession(session);
  assert.ok(i.goalCategories.includes("bug fix"));
});

test("analyzeSession calculates satisfaction based on tool errors", () => {
  const noErrors = fakeSession({ messages: [assistantMsg("ok")] });
  assert.equal(analyzeSession(noErrors).satisfaction, "high");

  const someErrors = fakeSession({
    messages: [
      assistantMsg("ok"),
      toolMsg("Error: file not found"),
      toolMsg("Error: timeout"),
      toolMsg("Error: permission denied"),
      toolMsg("Error: disk full"),
    ],
  });
  assert.equal(analyzeSession(someErrors).satisfaction, "medium");

  const manyErrors = fakeSession({
    messages: Array.from({ length: 7 }, () => toolMsg("Error: something broke")),
  });
  assert.equal(analyzeSession(manyErrors).satisfaction, "low");
});

test("analyzeSession reports friction for tool errors over threshold", () => {
  const session = fakeSession({
    messages: [
      assistantMsg("ok"),
      toolMsg("Error: file not found"),
      toolMsg("Error: timeout"),
      toolMsg("Error: permission denied"),
      toolMsg("Error: disk full"),
    ],
  });
  const i = analyzeSession(session);
  assert.ok(i.frictionPoints.length > 0);
  assert.ok(i.frictionPoints[0]!.includes("tool errors"));
});

test("analyzeSession token usage falls back to session.tokenUsage", () => {
  const session = fakeSession({
    tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
  });
  assert.equal(analyzeSession(session).tokensUsed, 150);
});

test("analyzeSession prefers telemetry token usage", () => {
  const session = fakeSession({
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    telemetry: { usage: { totalTokens: 999 } },
  });
  assert.equal(analyzeSession(session).tokensUsed, 999);
});

test("analyzeSession detects multiple goal categories", () => {
  const session = fakeSession({
    messages: [
      userMsg("Add a new feature to fix the error handling bug"),
    ],
  });
  const i = analyzeSession(session);
  assert.ok(i.goalCategories.includes("bug fix"));
  assert.ok(i.goalCategories.includes("feature"));
});
