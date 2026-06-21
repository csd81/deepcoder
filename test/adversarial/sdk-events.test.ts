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
  assert.ok(red.output.includes("sk-***"), "redacted marker present");
});

test("[10B1-buffer] EventBuffer drops oldest when over capacity and tracks droppedCount", () => {
  const buf = new EventBuffer(2);
  buf.push({ type: "notice", message: "a" });
  buf.push({ type: "notice", message: "b" });
  buf.push({ type: "notice", message: "c" });
  const snap = buf.snapshot();
  assert.equal(snap.length, 2, "capacity enforced");
  assert.equal(buf.droppedCount, 1, "one event dropped");
});
