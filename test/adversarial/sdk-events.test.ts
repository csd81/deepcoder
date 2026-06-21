/**
 * Phase 10B slice 1 — SDK event layer (pure, no model, no server).
 *
 * Deliverables under test (each tagged [10B1-*]):
 *   [10B1-types]    SdkEvent union + event factory helpers
 *   [10B1-redact]   redactEvent() runs every string payload through redactSecrets
 *   [10B1-buffer]   EventBuffer is bounded (drops oldest, tracks droppedCount)
 *   [10B1-replay]   EventBuffer.snapshot() replays buffered events in order
 *
 * RED ANCHOR: this file imports from src/sdk/events.ts which does not exist yet,
 * so the suite is red on baseline until the slice is implemented.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  type SdkEvent,
  EventBuffer,
  redactEvent,
} from "../../src/sdk/events.js";

test("[10B1-types] SdkEvent union can be instantiated with all variants", () => {
  const events: SdkEvent[] = [
    { type: "run.started", runId: "r1", sessionId: "s1", mode: "auto" },
    { type: "assistant.delta", text: "hello" },
    { type: "assistant.message", text: "world" },
    { type: "tool.call", name: "bash", description: "run bash" },
    { type: "tool.result", name: "bash", output: "ok", isError: false },
    { type: "approval.requested", tool: "bash", preview: "rm -rf /" },
    { type: "approval.resolved", approved: true },
    { type: "check.started", name: "test", command: "npm test" },
    { type: "check.finished", name: "test", exitCode: 0, timedOut: false },
    { type: "solve.attempt", attempt: 1, maxAttempts: 3 },
    { type: "usage", usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 } },
    { type: "notice", message: "info" },
    { type: "run.finished", runId: "r1", status: "ok" },
  ];
  const redacted = events.map(e => redactEvent(e));
  assert.equal(redacted.length, 13);
});

test("[10B1-redact] redactEvent strips key-shaped strings from tool.result output", () => {
  const ev: SdkEvent = {
    type: "tool.result",
    name: "bash",
    output: "exported DEEPSEEK_API_KEY=sk-abcdef0123456789 to env",
  };
  const red = redactEvent(ev);
  assert.equal(red.type, "tool.result");
  if (red.type !== "tool.result") return;
  assert.ok(!red.output.includes("sk-abcdef0123456789"), "raw key must not survive");
  // redactSecrets collapses `API_KEY=sk-…` all the way to `API_KEY=***`, so the
  // surviving marker is `***` (not `sk-***`). The security property is: no raw key.
  assert.ok(red.output.includes("***"), "a redaction marker is present");
});

test("[10B1-redact] redactEvent redacts other string fields but leaves non-string preview untouched", () => {
  const ev1: SdkEvent = { type: "assistant.delta", text: "key: sk-abcdef0123456789" };
  const red1 = redactEvent(ev1);
  assert.equal(red1.type, "assistant.delta");
  if (red1.type !== "assistant.delta") return;
  assert.ok(!red1.text.includes("sk-abcdef0123456789"));

  const ev2: SdkEvent = { type: "approval.requested", tool: "bash", preview: { key: "sk-abcdef0123456789" } };
  const red2 = redactEvent(ev2);
  assert.equal(red2.type, "approval.requested");
  if (red2.type !== "approval.requested") return;
  assert.ok(typeof red2.preview === "object");
  assert.equal((red2.preview as any).key, "sk-abcdef0123456789", "non-string preview is untouched");

  const ev3: SdkEvent = { type: "approval.requested", tool: "bash", preview: "key: sk-abcdef0123456789" };
  const red3 = redactEvent(ev3);
  assert.equal(red3.type, "approval.requested");
  if (red3.type !== "approval.requested") return;
  assert.ok(typeof red3.preview === "string" && !red3.preview.includes("sk-abcdef0123456789"));
});

test("[10B1-buffer] EventBuffer drops oldest when over capacity and tracks droppedCount", () => {
  const buf = new EventBuffer(2);
  buf.push({ type: "notice", message: "a" });
  buf.push({ type: "notice", message: "b" });
  buf.push({ type: "notice", message: "c" });
  const snap = buf.snapshot();
  assert.equal(snap.length, 2, "capacity enforced");
  assert.equal(buf.droppedCount, 1, "one event dropped");
  assert.equal(buf.size, 2, "size is 2");
});

test("[10B1-buffer] EventBuffer throws on maxEvents < 1", () => {
  assert.throws(() => new EventBuffer(0), /maxEvents must be >= 1/);
});

test("[10B1-replay] EventBuffer.snapshot() returns events in insertion order across eviction", () => {
  const buf = new EventBuffer(2);
  buf.push({ type: "notice", message: "a" });
  buf.push({ type: "notice", message: "b" });
  buf.push({ type: "notice", message: "c" });
  buf.push({ type: "notice", message: "d" });
  
  const snap = buf.snapshot();
  assert.equal(snap.length, 2);
  assert.equal((snap[0] as any).message, "c");
  assert.equal((snap[1] as any).message, "d");
});
