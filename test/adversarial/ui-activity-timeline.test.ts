/**
 * Phase 10A.11 — Live Activity Timeline: adversarial pure-module tests.
 *
 * These tests cover every event-to-item mapping, the item-bound cap, detail
 * redaction, and width-bound rendering.  No I/O, no terminal.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  createActivityTimeline,
  applyActivityEvent,
  renderActivityTimeline,
  _resetItemIds,
  type ActivityTimelineState,
} from "../../src/ui/activityTimeline.js";
import { createTheme } from "../../src/ui/theme.js";

const plain = createTheme(false);

function fresh(): ActivityTimelineState {
  _resetItemIds();
  return createActivityTimeline(20);
}

// ── tool_start creates running item ────────────────────────────────────────

test("tool_start creates a running item", () => {
  let s = fresh();
  s = applyActivityEvent(s, { type: "tool_start", name: "read_file", description: "src/foo.ts" });
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0].kind, "tool");
  assert.equal(s.items[0].label, "read_file src/foo.ts");
  assert.equal(s.items[0].status, "running");
  assert.equal(s.items[0].startedAt, 0);
});

// ── tool_result marks item done ────────────────────────────────────────────

test("tool_result marks a running tool item as done", () => {
  let s = fresh();
  s = applyActivityEvent(s, { type: "tool_start", name: "read_file", description: "x" });
  s = applyActivityEvent(s, { type: "tool_result", name: "read_file", output: "content", isError: false });
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0].status, "done");
  assert.ok(s.items[0].finishedAt !== undefined);
});

// ── tool error marks failed ────────────────────────────────────────────────

test("tool_result with isError true marks failed", () => {
  let s = fresh();
  s = applyActivityEvent(s, { type: "tool_start", name: "run_bash", description: "rm /" });
  s = applyActivityEvent(s, { type: "tool_result", name: "run_bash", output: "permission denied", isError: true });
  assert.equal(s.items[0].status, "failed");
});

// ── check_start / check_done passed:true marks passed ──────────────────────

test("check_start + check_done passed:true marks passed", () => {
  let s = fresh();
  s = applyActivityEvent(s, { type: "check_start", name: "phase", command: "npm test" });
  assert.equal(s.items[0].kind, "check");
  assert.equal(s.items[0].status, "running");
  s = applyActivityEvent(s, { type: "check_done", name: "phase", exitCode: 0, passed: true });
  assert.equal(s.items[0].status, "passed");
  assert.ok(s.items[0].finishedAt !== undefined);
});

// ── check_done passed:false marks failed ───────────────────────────────────

test("check_done passed:false marks failed", () => {
  let s = fresh();
  s = applyActivityEvent(s, { type: "check_start", name: "lint", command: "eslint ." });
  s = applyActivityEvent(s, { type: "check_done", name: "lint", exitCode: 1, passed: false });
  assert.equal(s.items[0].status, "failed");
});

// ── worker update changes detail ───────────────────────────────────────────

test("worker_update changes detail on a running worker", () => {
  let s = fresh();
  s = applyActivityEvent(s, { type: "worker_start", id: "w1", label: "worker A" });
  assert.equal(s.items[0].status, "running");
  assert.equal(s.items[0].label, "worker:w1");
  s = applyActivityEvent(s, { type: "worker_update", id: "w1", status: "attempt 2/3" });
  assert.equal(s.items[0].detail, "attempt 2/3");
});

// ── worker done marks done and records summary ─────────────────────────────

test("worker_done marks done and records summary", () => {
  let s = fresh();
  s = applyActivityEvent(s, { type: "worker_start", id: "w2", label: "worker B" });
  s = applyActivityEvent(s, { type: "worker_done", id: "w2", summary: "all green" });
  assert.equal(s.items[0].status, "done");
  assert.equal(s.items[0].detail, "all green");
  assert.ok(s.items[0].finishedAt !== undefined);
});

// ── approval request/result maps to waiting/passed ─────────────────────────

test("approval_request creates a waiting item; approval_result approved marks passed", () => {
  let s = fresh();
  s = applyActivityEvent(s, { type: "approval_request", id: "a1", description: "Run: rm -rf /" });
  assert.equal(s.items[0].kind, "approval");
  assert.equal(s.items[0].status, "waiting");
  assert.equal(s.items[0].label, "Run: rm -rf /");
  s = applyActivityEvent(s, { type: "approval_result", id: "a1", approved: true });
  assert.equal(s.items[0].status, "passed");
});

test("approval_result denied marks failed", () => {
  let s = fresh();
  s = applyActivityEvent(s, { type: "approval_request", id: "a2", description: "write file" });
  s = applyActivityEvent(s, { type: "approval_result", id: "a2", approved: false });
  assert.equal(s.items[0].status, "failed");
});

// ── notices map severity ───────────────────────────────────────────────────

test("notice with info severity becomes info status", () => {
  let s = fresh();
  s = applyActivityEvent(s, { type: "notice", message: "context window at 80%", severity: "info" });
  assert.equal(s.items[0].kind, "notice");
  assert.equal(s.items[0].status, "info");
  assert.equal(s.items[0].label, "context window at 80%");
});

test("notice with warn severity becomes warn status", () => {
  let s = fresh();
  s = applyActivityEvent(s, { type: "notice", message: "high memory", severity: "warn" });
  assert.equal(s.items[0].status, "warn");
});

test("notice with error severity becomes error status", () => {
  let s = fresh();
  s = applyActivityEvent(s, { type: "notice", message: "disk full", severity: "error" });
  assert.equal(s.items[0].status, "error");
});

test("notice without severity defaults to info", () => {
  let s = fresh();
  s = applyActivityEvent(s, { type: "notice", message: "something happened" });
  assert.equal(s.items[0].status, "info");
});

// ── assistant events ───────────────────────────────────────────────────────

test("assistant_delta creates / keeps a running item; assistant_done marks done", () => {
  let s = fresh();
  s = applyActivityEvent(s, { type: "assistant_delta", text: "thinking" });
  assert.equal(s.items[0].kind, "assistant");
  assert.equal(s.items[0].status, "running");
  assert.equal(s.items[0].label, "thinking…");
  // Subsequent delta keeps it running
  s = applyActivityEvent(s, { type: "assistant_delta", text: " more" });
  assert.equal(s.items[0].status, "running");
  assert.equal(s.items.length, 1, "coalesces into same item");
  // Done marks done
  s = applyActivityEvent(s, { type: "assistant_done" });
  assert.equal(s.items[0].status, "done");
});

// ── item list bounded ──────────────────────────────────────────────────────

test("item list does not exceed maxItems", () => {
  _resetItemIds();
  let s = createActivityTimeline(3);
  for (let i = 0; i < 10; i++) {
    s = applyActivityEvent(s, { type: "notice", message: `event ${i}`, severity: "info" }, i * 1000);
  }
  assert.equal(s.items.length, 3, "bounded to 3 items");
  // The 3 newest items are kept (items are unshifted, so first 3)
  assert.ok(s.items[0].label.includes("event 9"), "newest kept");
  assert.ok(s.items[2].label.includes("event 7"), "oldest kept among bound");
});

// ── detail redacted ────────────────────────────────────────────────────────

test("render output redacts secret-shaped detail text", () => {
  let s = fresh();
  s = applyActivityEvent(s, { type: "worker_start", id: "w3", label: "secret worker" });
  s = applyActivityEvent(s, { type: "worker_update", id: "w3", status: "using sk-abc123secret" });
  const lines = renderActivityTimeline(s, { width: 80, theme: plain });
  assert.ok(lines.length > 0);
  const joined = lines.join("\n");
  assert.ok(!joined.includes("sk-abc123secret"), "raw secret not in output");
  assert.ok(joined.includes("sk-***"), "redacted form present");
});

// ── render output is width-bounded ─────────────────────────────────────────

test("render output is width-bounded", () => {
  let s = fresh();
  s = applyActivityEvent(s, { type: "tool_start", name: "very_long_tool_name_that_exceeds_width", description: "x".repeat(100) });
  const lines = renderActivityTimeline(s, { width: 30, theme: plain });
  for (const line of lines) {
    // Strip ANSI for length check — plain theme so none anyway
    const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
    assert.ok(plain.length <= 30, `line "${plain}" exceeds width ${30} (length ${plain.length})`);
  }
});

// ── empty timeline returns empty array ─────────────────────────────────────

test("render on empty timeline returns empty array", () => {
  const s = fresh();
  const lines = renderActivityTimeline(s, { width: 80 });
  assert.deepEqual(lines, []);
});

// ── status event is ignored ────────────────────────────────────────────────

test("status event does not add timeline items", () => {
  const s = fresh();
  const next = applyActivityEvent(s, { type: "status", patch: { mode: "auto" } });
  assert.equal(next.items.length, 0);
});

// ── tool_result without prior tool_start creates a done/failed item ────────

test("tool_result without tool_start creates a done item", () => {
  let s = fresh();
  s = applyActivityEvent(s, { type: "tool_result", name: "run_bash", output: "ok", isError: false });
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0].kind, "tool");
  assert.equal(s.items[0].status, "done");
});

test("tool_result error without tool_start creates failed item", () => {
  let s = fresh();
  s = applyActivityEvent(s, { type: "tool_result", name: "run_bash", output: "err", isError: true });
  assert.equal(s.items[0].status, "failed");
});

// ── check_done without matching start creates item ─────────────────────────

test("check_done without check_start creates an item", () => {
  let s = fresh();
  s = applyActivityEvent(s, { type: "check_done", name: "lint", exitCode: 0, passed: true });
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0].status, "passed");
});

// ── worker_done without matching start creates item ────────────────────────

test("worker_done without worker_start creates a done item", () => {
  let s = fresh();
  s = applyActivityEvent(s, { type: "worker_done", id: "orphan", summary: "finished" });
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0].status, "done");
  assert.equal(s.items[0].detail, "finished");
});

// ── multiple tools tracked independently ───────────────────────────────────

test("multiple tool items tracked independently by name", () => {
  let s = fresh();
  s = applyActivityEvent(s, { type: "tool_start", name: "read_file", description: "a.ts" });
  s = applyActivityEvent(s, { type: "tool_start", name: "write_file", description: "b.ts" });
  assert.equal(s.items.length, 2);
  const readItem = s.items.find((it) => it.label.startsWith("read_file"));
  const writeItem = s.items.find((it) => it.label.startsWith("write_file"));
  assert.ok(readItem && readItem.status === "running");
  assert.ok(writeItem && writeItem.status === "running");
  // Finish one
  s = applyActivityEvent(s, { type: "tool_result", name: "read_file", output: "ok", isError: false });
  assert.equal(s.items.find((it) => it.label.startsWith("read_file"))!.status, "done");
  assert.equal(s.items.find((it) => it.label.startsWith("write_file"))!.status, "running", "other tool unaffected");
});

// ── check_output updates detail ────────────────────────────────────────────

test("check_output updates detail with bounded last line", () => {
  let s = fresh();
  s = applyActivityEvent(s, { type: "check_start", name: "lint", command: "eslint ." });
  s = applyActivityEvent(s, { type: "check_output", name: "lint", chunk: "line1\nline2\nfinal summary" });
  assert.equal(s.items[0].detail, "final summary");
});

// ── rendering uses status symbols ──────────────────────────────────────────

test("render shows correct symbols for each status", () => {
  let s = fresh();
  s = applyActivityEvent(s, { type: "assistant_delta", text: "hmm" });
  const runningLines = renderActivityTimeline(s, { width: 80, theme: plain });
  assert.ok(runningLines[0].startsWith("●"), "running shows ●");

  s = applyActivityEvent(s, { type: "assistant_done" });
  const doneLines = renderActivityTimeline(s, { width: 80, theme: plain });
  assert.ok(doneLines[0].startsWith("✓"), "done shows ✓");
});

// ── maxRows limits render output ───────────────────────────────────────────

test("maxRows limits render output rows", () => {
  let s = fresh();
  for (let i = 0; i < 10; i++) {
    s = applyActivityEvent(s, { type: "notice", message: `event ${i}`, severity: "info" }, i * 1000);
  }
  const lines = renderActivityTimeline(s, { width: 80, maxRows: 3, theme: plain });
  assert.ok(lines.length <= 3, "at most 3 rows rendered");
});

// ── injected now is recorded as startedAt / finishedAt ─────────────────────

test("injected now is recorded on item", () => {
  let s = fresh();
  s = applyActivityEvent(s, { type: "tool_start", name: "test", description: "" }, 42_000);
  assert.equal(s.items[0].startedAt, 42_000);
  s = applyActivityEvent(s, { type: "tool_result", name: "test", output: "ok", isError: false }, 99_000);
  assert.equal(s.items[0].finishedAt, 99_000);
});

// ── render does not throw on unknown or incomplete events ──────────────────

test("applyActivityEvent does not throw on any event type", () => {
  const s = fresh();
  for (const event of [
    { type: "assistant_delta" as const, text: "hi" },
    { type: "assistant_done" as const },
    { type: "tool_start" as const, name: "x", description: "y" },
    { type: "tool_result" as const, name: "x", output: "o", isError: false },
    { type: "check_start" as const, name: "c", command: "cmd" },
    { type: "check_output" as const, name: "c", chunk: "out" },
    { type: "check_done" as const, name: "c", exitCode: 0, passed: true },
    { type: "worker_start" as const, id: "w", label: "l" },
    { type: "worker_update" as const, id: "w", status: "s" },
    { type: "worker_done" as const, id: "w", summary: "s" },
    { type: "approval_request" as const, id: "a", description: "d" },
    { type: "approval_result" as const, id: "a", approved: true },
    { type: "notice" as const, message: "m", severity: "info" as const },
    { type: "status" as const, patch: {} },
  ]) {
    assert.doesNotThrow(() => applyActivityEvent(s, event), `event ${event.type} should not throw`);
  }
});

// ── renderActivityTimeline handles edge widths ─────────────────────────────

test("renderActivityTimeline handles narrow widths gracefully", () => {
  let s = fresh();
  s = applyActivityEvent(s, { type: "notice", message: "x".repeat(200), severity: "info" });
  const lines = renderActivityTimeline(s, { width: 5, theme: plain });
  for (const line of lines) {
    const plainText = line.replace(/\x1b\[[0-9;]*m/g, "");
    assert.ok(plainText.length <= 5, `line length ${plainText.length} > ${5}`);
  }
});
