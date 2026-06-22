import { test } from "node:test";
import assert from "node:assert/strict";
import { formatSessionShare, type ShareSession } from "../src/cli/sessionShare.js";
import type { AgentMessage } from "../src/providers/types.js";

// Red-seed anchor (do NOT weaken). Pure formatter tests — no I/O, no model.

function fakeSession(overrides: Partial<ShareSession> = {}): ShareSession {
  return {
    id: "sess-test-1",
    title: "Test Sharing",
    model: "deepseek-chat",
    provider: "deepseek",
    createdAt: "2026-03-12T10:00:00.000Z",
    messages: [],
    ...overrides,
  };
}

test("formatSessionShare includes metadata header with model, date, and message count", () => {
  const md = formatSessionShare(fakeSession());
  assert.ok(md.includes("Session: Test Sharing"));
  assert.ok(md.includes("**Model:** deepseek/deepseek-chat"));
  assert.ok(md.includes("**Date:** 2026-03-12"));
  assert.ok(md.includes("**Messages:** 0"));
});

test("formatSessionShare renders user and assistant messages with role labels", () => {
  const messages: AgentMessage[] = [
    { role: "user", content: "Hello, can you help?" },
    { role: "assistant", content: "Sure, what do you need?" },
  ];
  const md = formatSessionShare(fakeSession({ messages }));
  assert.ok(md.includes("**User**"));
  assert.ok(md.includes("Hello, can you help?"));
  assert.ok(md.includes("**Assistant**"));
  assert.ok(md.includes("Sure, what do you need?"));
});

test("formatSessionShare renders tool calls with tool names", () => {
  const messages: AgentMessage[] = [
    { role: "assistant", content: "Let me check the files.",
      toolCalls: [
        { id: "call-1", name: "read_file", arguments: { path: "test.txt" } },
        { id: "call-2", name: "grep", arguments: { pattern: "foo" } },
      ],
    },
  ];
  const md = formatSessionShare(fakeSession({ messages }));
  assert.ok(md.includes("**Tools called:**"));
  assert.ok(md.includes("`read_file`"));
  assert.ok(md.includes("`grep`"));
});

test("formatSessionShare renders tool result messages as collapsed details", () => {
  const messages: AgentMessage[] = [
    { role: "assistant", content: "Let me read the file.",
      toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: "test.txt" } }],
    },
    { role: "tool", content: "file contents here", toolCallId: "call-1", name: "read_file" },
  ];
  const md = formatSessionShare(fakeSession({ messages }));
  assert.ok(md.includes("<details><summary>Tool result: read_file</summary>"));
  assert.ok(md.includes("file contents here"));
  assert.ok(md.includes("</details>"));
});

test("formatSessionShare with sanitize redacts secrets in message content", () => {
  const messages: AgentMessage[] = [
    { role: "user", content: "My API key is sk-live-ABC123DEF456" },
  ];
  const md = formatSessionShare(fakeSession({ messages }), { sanitize: true });
  // Header confirms sanitize was active
  assert.ok(md.includes("**Sanitized:** secrets redacted"));
  // Original secret must be gone
  assert.ok(!md.includes("sk-live-ABC123DEF456"));
  // No raw sk- secret pattern should survive (the redacted form sk-*** doesn't match [A-Za-z0-9_])
  assert.ok(!/sk-[A-Za-z0-9_]/.test(md));
});

test("formatSessionShare with sanitize redacts secrets in tool result output", () => {
  const messages: AgentMessage[] = [
    { role: "assistant", content: "Reading config.",
      toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: ".env" } }],
    },
    { role: "tool", content: "API_KEY=sk-secret-1234567890", toolCallId: "call-1", name: "read_file" },
  ];
  const md = formatSessionShare(fakeSession({ messages }), { sanitize: true });
  // Header confirms sanitize was active
  assert.ok(md.includes("**Sanitized:** secrets redacted"));
  assert.ok(!md.includes("sk-secret-1234567890"));
  // No raw sk- secret pattern should survive
  assert.ok(!/sk-[A-Za-z0-9_]/.test(md));
});

test("formatSessionShare truncates messages longer than maxContentBytes", () => {
  const longContent = "A".repeat(60_000);
  const messages: AgentMessage[] = [
    { role: "user", content: longContent },
  ];
  const md = formatSessionShare(fakeSession({ messages }), { maxContentBytes: 100 });
  assert.ok(md.includes("*…message truncated*"));
  assert.ok(md.length < 500); // well under the original 60k, covers header+footer overhead
});

test("formatSessionShare includes telemetry footer when available", () => {
  const md = formatSessionShare(fakeSession({
    telemetry: { totalTokens: 1500, costUsd: 0.042 },
  }));
  assert.ok(md.includes("**Total tokens:** 1500"));
  assert.ok(md.includes("**Estimated cost:** $0.04"));
});

test("formatSessionShare omits telemetry footer when telemetry is absent", () => {
  const md = formatSessionShare(fakeSession());
  assert.ok(!md.includes("**Total tokens:**"));
  assert.ok(!md.includes("**Estimated cost:**"));
});

test("formatSessionShare for empty session renders header and footer only", () => {
  const md = formatSessionShare(fakeSession({ messages: [] }));
  const lines = md.split("\n").filter((l) => l.trim().length > 0);
  // Has header, separator, and a "Shared from deepcoder" footer
  assert.ok(lines.some((l) => l.startsWith("# Session:")));
  assert.ok(lines.some((l) => l.startsWith("*Shared from deepcoder")));
});

test("formatSessionShare defaults to session id as title when no title is given", () => {
  const md = formatSessionShare(fakeSession({ title: undefined, id: "sess-abc" }));
  assert.ok(md.includes("Session: sess-abc"));
});
