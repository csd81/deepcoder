/**
 * Phase 10N — adversarial tests for ActivityRegistry + /ps /stop slash handlers.
 *
 * Pure registry tests (1-9):
 *   1. start creates stable unique IDs.
 *   2. list returns running records sorted by start time.
 *   3. stop(id) aborts the associated controller.
 *   4. stop(id) returns false for unknown IDs.
 *   5. stopAll aborts only cancellable running records.
 *   6. finish marks status and keeps a bounded record.
 *   7. pruneDone removes old finished records only.
 *   8. Labels/details are bounded/redacted.
 *   9. Metadata rejects non-primitive data.
 *
 * Slash handler tests (10-14):
 *  10. /ps prints "No active activities" when empty.
 *  11. /ps --json parses and contains no secrets.
 *  12. /stop all reports count and aborts all cancellable records.
 *  13. /stop <id> refuses non-cancellable records.
 *  14. Unknown ID does not throw.
 *
 * Integration tests (15-17):
 *  15. A fake long-running check registered with the activity registry appears in /ps.
 *  16. Cancelling it through /stop <id> aborts the check.
 *  17. A fake worker through delegate path appears as kind worker.
 *
 * RED ANCHOR: imports from src/runtime/activityRegistry.ts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ActivityRegistry, runPsSlash, runStopSlash } from "../../src/runtime/activityRegistry.js";

// ── Helpers ────────────────────────────────────────────────────────────

/** Create a fresh registry for each test (isolated, no shared state). */
function freshReg(): ActivityRegistry {
  return new ActivityRegistry();
}

/** Capture output lines written via writeLn callback. */
function capture(): { lines: string[]; writeLn: (s: string) => void } {
  const lines: string[] = [];
  return {
    lines,
    writeLn: (s: string) => lines.push(s),
  };
}

// ── 1. start creates stable unique IDs ─────────────────────────────────

test("[10n-start-ids] start creates stable deterministic IDs (a1, a2, a3)", () => {
  const reg = freshReg();
  const h1 = reg.start({ kind: "check", label: "first" });
  const h2 = reg.start({ kind: "worker", label: "second" });
  const h3 = reg.start({ kind: "subagent", label: "third" });
  assert.equal(h1.record.id, "a1");
  assert.equal(h2.record.id, "a2");
  assert.equal(h3.record.id, "a3");
});

test("[10n-start-ids] concurrent registries each start from a1", () => {
  const r1 = freshReg();
  const r2 = freshReg();
  assert.equal(r1.start({ kind: "check", label: "x" }).record.id, "a1");
  assert.equal(r2.start({ kind: "check", label: "y" }).record.id, "a1");
});

// ── 2. list returns running records sorted by start time ───────────────

test("[10n-list-running] list() returns only running/stopping records", () => {
  const reg = freshReg();
  const h1 = reg.start({ kind: "check", label: "c1" });
  const h2 = reg.start({ kind: "worker", label: "w1" });
  h2.finish("done", "completed");

  const list = reg.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "a1");
  assert.equal(list[0].kind, "check");
});

test("[10n-list-order] list() returns records sorted by start time (oldest first)", () => {
  const reg = freshReg();
  const h1 = reg.start({ kind: "check", label: "first" });
  // tiny delay to ensure different timestamps
  const h2 = reg.start({ kind: "worker", label: "second" });
  const h3 = reg.start({ kind: "subagent", label: "third" });

  const list = reg.list();
  assert.equal(list.length, 3);
  assert.equal(list[0].id, "a1");
  assert.equal(list[1].id, "a2");
  assert.equal(list[2].id, "a3");
});

test("[10n-list-includeDone] list({includeDone:true}) includes finished records", () => {
  const reg = freshReg();
  reg.start({ kind: "check", label: "c1" });
  reg.start({ kind: "worker", label: "w1" }).finish("done");

  const running = reg.list();
  assert.equal(running.length, 1);

  const all = reg.list({ includeDone: true });
  assert.equal(all.length, 2);
});

// ── 3. stop(id) aborts the associated controller ───────────────────────

test("[10n-stop-aborts] stop(id) aborts the AbortController", () => {
  const reg = freshReg();
  const ac = new AbortController();
  const h = reg.start({ kind: "check", label: "ctl-test", controller: ac });

  assert.equal(ac.signal.aborted, false);
  const ok = reg.stop(h.record.id);
  assert.equal(ok, true);
  assert.equal(ac.signal.aborted, true);
  assert.equal(ac.signal.reason, `stopped by user (/stop ${h.record.id})`);
});

test("[10n-stop-marked] stop(id) marks record as stopping", () => {
  const reg = freshReg();
  const h = reg.start({ kind: "check", label: "mark-test" });
  reg.stop(h.record.id);
  const r = reg.get(h.record.id)!;
  assert.equal(r.status, "stopping");
});

// ── 4. stop(id) returns false for unknown IDs ──────────────────────────

test("[10n-stop-unknown] stop() returns false for unknown id", () => {
  const reg = freshReg();
  assert.equal(reg.stop("unknown"), false);
  assert.equal(reg.stop("a999"), false);
});

// ── 5. stopAll aborts only cancellable running records ─────────────────

test("[10n-stopAll] stopAll aborts only cancellable running records", () => {
  const reg = freshReg();
  const ac1 = new AbortController();
  const ac2 = new AbortController();
  const ac3 = new AbortController();
  const ac4 = new AbortController();

  // cancellable + running
  reg.start({ kind: "check", label: "c1", controller: ac1, cancellable: true });
  // non-cancellable + running
  reg.start({ kind: "check", label: "c2", controller: ac2, cancellable: false });
  // cancellable + already done
  reg.start({ kind: "worker", label: "w1", controller: ac3 }).finish("done");
  // cancellable + running (no controller)
  reg.start({ kind: "other", label: "o1", controller: ac4, cancellable: true });

  const count = reg.stopAll();
  // Should stop a1 (cancellable+running) and a4 (cancellable+running)
  assert.equal(count, 2);

  assert.equal(ac1.signal.aborted, true, "a1 should be aborted");
  assert.equal(ac2.signal.aborted, false, "a2 should NOT be aborted (non-cancellable)");
  assert.equal(ac3.signal.aborted, false, "a3 should NOT be aborted (already done)");
  assert.equal(ac4.signal.aborted, true, "a4 should be aborted");

  // Verify statuses
  assert.equal(reg.get("a1")!.status, "stopping");
  assert.equal(reg.get("a2")!.status, "running");
  assert.equal(reg.get("a3")!.status, "done");
  assert.equal(reg.get("a4")!.status, "stopping");
});

// ── 6. finish marks status and keeps a bounded record ──────────────────

test("[10n-finish] finish marks status and sets updatedAt", () => {
  const reg = freshReg();
  const h = reg.start({ kind: "check", label: "finish-test" });
  const startedAt = h.record.startedAt;
  h.finish("done", "completed successfully");

  const r = reg.get("a1")!;
  assert.equal(r.status, "done");
  assert.equal(r.detail, "completed successfully");
  assert.equal(r.startedAt, startedAt);
  assert.ok(new Date(r.updatedAt).getTime() >= new Date(startedAt).getTime());
});

test("[10n-finish] finish removes controller reference", () => {
  const reg = freshReg();
  const ac = new AbortController();
  const h = reg.start({ kind: "check", label: "ctl-finish", controller: ac });
  h.finish("done");
  // After finish, stop should fail because the controller was removed
  // (stop checks for running/stopping status, and finish set it to done)
  assert.equal(reg.stop("a1"), false, "cannot stop a finished activity");
});

// ── 7. pruneDone removes old finished records only ─────────────────────

test("[10n-prune] pruneDone removes finished records older than maxAgeMs", () => {
  const reg = freshReg();
  reg.start({ kind: "check", label: "running" });
  const h2 = reg.start({ kind: "worker", label: "done-old" });
  const h3 = reg.start({ kind: "subagent", label: "done-fresh" });
  h2.finish("done");
  h3.finish("failed");

  // Manually set updatedAt to be old for a2
  const oldDate = new Date(Date.now() - 10_000).toISOString();
  const r2 = reg.get("a2")!;
  (r2 as { updatedAt: string }).updatedAt = oldDate;

  // Prune with 5 second threshold
  const pruned = reg.pruneDone(5000);
  assert.equal(pruned, 1, "should prune a2 (old finished record)");
  assert.equal(reg.get("a1")?.status, "running", "a1 still running, not pruned");
  assert.equal(reg.get("a2"), undefined, "a2 was pruned");
  assert.equal(reg.get("a3")?.status, "failed", "a3 still recent, not pruned");
});

test("[10n-prune] pruneDone does not remove running records", () => {
  const reg = freshReg();
  reg.start({ kind: "check", label: "keep-me" });
  const pruned = reg.pruneDone(0); // prune everything older than now (0ms)
  assert.equal(pruned, 0, "running records are never pruned");
  assert.equal(reg.size, 1);
});

// ── 8. Labels/details are bounded/redacted ─────────────────────────────

test("[10n-redact-secret] label with API-key shape is redacted", () => {
  const reg = freshReg();
  const h = reg.start({
    kind: "check",
    label: "processing sk-abc123def456ghi789jkl012mno345pqr678stu",
  });
  assert.ok(!h.record.label.includes("sk-abc123def456"), "API key pattern should be redacted");
  assert.ok(h.record.label.includes("***REDACTED***"), "should contain redaction marker");
});

test("[10n-redact-secret] detail with api_key= shape is redacted", () => {
  const reg = freshReg();
  const h = reg.start({
    kind: "check",
    label: "test",
    detail: "config api_key=super-secret-key-12345 for provider",
  });
  assert.ok(h.record.detail!.includes("***REDACTED***"), "should redact api_key value");
  assert.ok(!h.record.detail!.includes("super-secret-key-12345"), "secret should be gone");
});

test("[10n-redact-secret] DEEPCODER_API_KEY env var pattern is redacted", () => {
  const reg = freshReg();
  const h = reg.start({
    kind: "worker",
    label: "r1",
    detail: "DEEPCODER_API_KEY=sk-test1234567890abcdef",
  });
  assert.ok(h.record.detail!.includes("***REDACTED***"));
  assert.ok(!h.record.detail!.includes("sk-test1234567890abcdef"));
});

test("[10n-bounded-label] label is truncated to MAX_LABEL_LENGTH", () => {
  const reg = freshReg();
  const longLabel = "x".repeat(500);
  const h = reg.start({ kind: "check", label: longLabel });
  assert.ok(h.record.label.length <= 200, "label should be bounded to 200 chars");
});

test("[10n-bounded-detail] detail is truncated to MAX_DETAIL_LENGTH", () => {
  const reg = freshReg();
  const longDetail = "y".repeat(1000);
  const h = reg.start({ kind: "check", label: "t", detail: longDetail });
  assert.ok(h.record.detail!.length <= 500, "detail should be bounded to 500 chars");
});

// ── 9. Metadata rejects non-primitive data ─────────────────────────────

test("[10n-metadata-safe] metadata strings/numbers/booleans are preserved, objects dropped", () => {
  const reg = freshReg();
  const h = reg.start({
    kind: "check",
    label: "meta-test",
    metadata: {
      attempt: 3,
      passed: true,
      name: "phase10n",
      nested: { foo: 1 }, // non-primitive → dropped
      nullVal: null, // null → dropped
      undefVal: undefined, // undefined → dropped
    },
  });
  const m = h.record.metadata!;
  assert.equal(m.attempt, 3);
  assert.equal(m.passed, true);
  assert.equal(m.name, "phase10n");
  assert.equal(m.nested, undefined, "nested object should be dropped");
  assert.equal(m.nullVal, undefined, "null should be dropped");
  assert.equal(m.undefVal, undefined, "undefined should be dropped");
});

test("[10n-metadata-empty] all-non-primitive metadata results in undefined", () => {
  const reg = freshReg();
  const h = reg.start({
    kind: "check",
    label: "meta-empty",
    metadata: { obj: { deep: true }, arr: [1, 2, 3] },
  });
  assert.equal(h.record.metadata, undefined, "all non-primitive → no metadata");
});

test("[10n-metadata-no-meta] no metadata passed means metadata is undefined", () => {
  const reg = freshReg();
  const h = reg.start({ kind: "check", label: "no-meta" });
  assert.equal(h.record.metadata, undefined);
});

// ── 10. /ps prints "No active activities" when empty ───────────────────

test("[10n-ps-empty] /ps prints 'No active activities.' when registry is empty", () => {
  const reg = freshReg();
  const { lines, writeLn } = capture();
  runPsSlash(reg, "", writeLn);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /No active activities/);
});

test("[10n-ps-empty2] /ps on registry with only finished records prints 'No active activities'", () => {
  const reg = freshReg();
  reg.start({ kind: "check", label: "done-check" }).finish("done");
  const { lines, writeLn } = capture();
  runPsSlash(reg, "", writeLn);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /No active activities/);
});

// ── 11. /ps --json parses and contains no secrets ──────────────────────

test("[10n-ps-json] /ps --json emits valid JSON with no secrets", () => {
  const reg = freshReg();
  reg.start({
    kind: "check",
    label: "json-test",
    detail: "key=sk-abcdefghijklmnopqrstuvwxyz0123456789",
  });

  const { lines, writeLn } = capture();
  runPsSlash(reg, "--json", writeLn);

  const json = lines.join("\n");
  let parsed: unknown;
  assert.doesNotThrow(() => { parsed = JSON.parse(json); });
  const obj = parsed as { activities: unknown[] };
  assert.ok(Array.isArray(obj.activities));
  assert.equal(obj.activities.length, 1);
  const act = obj.activities[0] as Record<string, unknown>;
  assert.equal(act.kind, "check");
  // No raw API key in the output
  assert.ok(!json.includes("sk-abcdefghijklmnopqrstuvwxyz0123456789"), "no raw secret in JSON");
  // The detail should be redacted in the record
  const redactedDetail = act.detail as string;
  assert.ok(redactedDetail.includes("***REDACTED***"), "detail contains redaction marker");
});

test("[10n-ps-json-all] /ps --all --json includes done records", () => {
  const reg = freshReg();
  reg.start({ kind: "check", label: "c1" });
  reg.start({ kind: "worker", label: "w1" }).finish("done");

  const { lines, writeLn } = capture();
  runPsSlash(reg, "--all --json", writeLn);

  const obj = JSON.parse(lines.join("\n"));
  assert.equal(obj.activities.length, 2);
});

// ── 12. /stop all reports count and aborts all cancellable records ─────

test("[10n-stop-all] /stop all stops cancellable running records and reports count", () => {
  const reg = freshReg();
  const ac1 = new AbortController();
  const ac2 = new AbortController();
  reg.start({ kind: "check", label: "c1", controller: ac1 });
  reg.start({ kind: "worker", label: "w1", controller: ac2, cancellable: false });

  const { lines, writeLn } = capture();
  runStopSlash(reg, "all", writeLn);

  assert.match(lines[0], /Stopping 1 cancellable activity/);
  assert.equal(ac1.signal.aborted, true);
  assert.equal(ac2.signal.aborted, false);
});

test("[10n-stop-all-empty] /stop all when nothing cancellable says so", () => {
  const reg = freshReg();
  reg.start({ kind: "check", label: "c1", cancellable: false });

  const { lines, writeLn } = capture();
  runStopSlash(reg, "all", writeLn);

  assert.match(lines[0], /No cancellable activities/);
});

// ── 13. /stop <id> refuses non-cancellable records ─────────────────────

test("[10n-stop-noncancellable] /stop <id> refuses non-cancellable record", () => {
  const reg = freshReg();
  reg.start({ kind: "check", label: "non-cancel", cancellable: false });

  const { lines, writeLn } = capture();
  runStopSlash(reg, "a1", writeLn);

  assert.match(lines[0], /not cancellable/);
  assert.equal(reg.get("a1")!.status, "running"); // still running
});

// ── 14. Unknown ID does not throw ──────────────────────────────────────

test("[10n-stop-unknown-id] /stop <unknown-id> prints message without throwing", () => {
  const reg = freshReg();

  const { lines, writeLn } = capture();
  assert.doesNotThrow(() => runStopSlash(reg, "nonexistent", writeLn));
  assert.match(lines[0], /Unknown activity/);
});

test("[10n-stop-no-arg] /stop with no argument prints usage", () => {
  const reg = freshReg();

  const { lines, writeLn } = capture();
  runStopSlash(reg, "", writeLn);
  assert.match(lines[0], /usage/);
});

// ── 15. A fake long-running check appears in /ps ───────────────────────

test("[10n-ps-registered-check] a registered check appears in /ps output", () => {
  const reg = freshReg();
  const ac = new AbortController();
  reg.start({
    kind: "check",
    label: "npm run test:phase",
    detail: "phase 10n check",
    controller: ac,
  });

  const { lines, writeLn } = capture();
  runPsSlash(reg, "", writeLn);

  assert.ok(lines.some((l) => l.includes("a1") && l.includes("check") && l.includes("npm run test:phase")),
    "check activity should appear in /ps output");
  assert.ok(lines.some((l) => l.includes("/stop")), "should show hint about /stop");
});

// ── 16. Cancelling a check through /stop <id> aborts it ────────────────

test("[10n-stop-aborts-check] /stop <id> aborts the associated AbortController", () => {
  const reg = freshReg();
  const ac = new AbortController();
  const h = reg.start({
    kind: "check",
    label: "long-running-check",
    detail: "running npm run test:phase",
    controller: ac,
  });

  assert.equal(ac.signal.aborted, false);

  const { writeLn } = capture();
  runStopSlash(reg, h.record.id, writeLn);

  assert.equal(ac.signal.aborted, true, "AbortController should be aborted");
  assert.equal(reg.get(h.record.id)!.status, "stopping");
});

test("[10n-stop-finished-check] cannot stop an already-finished check", () => {
  const reg = freshReg();
  const ac = new AbortController();
  const h = reg.start({ kind: "check", label: "fast-check", controller: ac });
  h.finish("done", "completed");

  const { lines, writeLn } = capture();
  runStopSlash(reg, "a1", writeLn);

  assert.match(lines[0], /already done/);
  assert.equal(ac.signal.aborted, false, "should not abort a finished check");
});

// ── 17. A fake worker through delegate path appears as kind worker ─────

test("[10n-worker-kind] a worker registered through delegate path appears as kind worker", () => {
  const reg = freshReg();
  const ac = new AbortController();
  reg.start({
    kind: "worker",
    label: "plan phase9 worker-3",
    detail: "implement fix for edge case",
    controller: ac,
    metadata: { check: "phase", attempt: 1 },
  });

  const { lines, writeLn } = capture();
  runPsSlash(reg, "", writeLn);

  assert.ok(lines.some((l) => l.includes("a1") && l.includes("worker")),
    "worker activity should appear with kind 'worker'");
});

test("[10n-worker-kind-json] worker through delegate path appears in --json output", () => {
  const reg = freshReg();
  reg.start({
    kind: "worker",
    label: "phase9 worker-3",
    metadata: { attempt: 2 },
  });

  const { lines, writeLn } = capture();
  runPsSlash(reg, "--json", writeLn);

  const obj = JSON.parse(lines.join("\n"));
  assert.equal(obj.activities.length, 1);
  assert.equal(obj.activities[0].kind, "worker");
  assert.equal(obj.activities[0].metadata.attempt, 2);
});

// ── Edge cases ─────────────────────────────────────────────────────────

test("[10n-update] handle.update patches status and detail", () => {
  const reg = freshReg();
  const h = reg.start({ kind: "check", label: "update-test" });
  h.update({ status: "stopping", detail: "user requested stop" });

  const r = reg.get("a1")!;
  assert.equal(r.status, "stopping");
  assert.equal(r.detail, "user requested stop");
});

test("[10n-handle-stop] handle.stop calls registry.stop", () => {
  const reg = freshReg();
  const ac = new AbortController();
  const h = reg.start({ kind: "check", label: "handle-stop", controller: ac });

  h.stop("user interrupt");

  assert.equal(ac.signal.aborted, true);
  assert.equal(reg.get("a1")!.status, "stopping");
  assert.match(ac.signal.reason as string, /user interrupt/);
});

test("[10n-finish-with-detail] handle.finish with detail overrides", () => {
  const reg = freshReg();
  const h = reg.start({ kind: "check", label: "finish-detail" });
  h.finish("failed", "timeout after 30s");

  const r = reg.get("a1")!;
  assert.equal(r.status, "failed");
  assert.equal(r.detail, "timeout after 30s");
});

test("[10n-stop-already-stopping] stop already-stopping record is allowed", () => {
  const reg = freshReg();
  const ac = new AbortController();
  reg.start({ kind: "check", label: "already-stopping", controller: ac });
  reg.stop("a1");
  const ok = reg.stop("a1");
  assert.equal(ok, true, "can stop a stopping record again");
  assert.equal(ac.signal.aborted, true);
});

test("[10n-stop-cancelled-record] cannot stop a cancelled record", () => {
  const reg = freshReg();
  const h = reg.start({ kind: "check", label: "cancelled" });
  h.finish("cancelled");
  const ok = reg.stop("a1");
  assert.equal(ok, false, "cannot stop a cancelled record");
});

test("[10n-size] size reflects total records including done", () => {
  const reg = freshReg();
  assert.equal(reg.size, 0);
  reg.start({ kind: "check", label: "c1" });
  reg.start({ kind: "worker", label: "w1" }).finish("done");
  assert.equal(reg.size, 2);
});

test("[10n-list-bounded] list returns at most 50 records", () => {
  const reg = freshReg();
  for (let i = 0; i < 60; i++) {
    reg.start({ kind: "other", label: `item-${i}` });
  }
  assert.equal(reg.list().length, 50);
  assert.equal(reg.list({ includeDone: true }).length, 50);
});

test("[10n-prune-default] pruneDone works with default maxAge", () => {
  const reg = freshReg();
  const h = reg.start({ kind: "check", label: "old" });
  h.finish("done");
  // Set updatedAt far in the past
  const r = reg.get("a1")!;
  (r as { updatedAt: string }).updatedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const count = reg.pruneDone(); // default = 5 min
  assert.equal(count, 1);
  assert.equal(reg.get("a1"), undefined);
});

test("[10n-get-returns-undefined] get returns undefined for missing id", () => {
  const reg = freshReg();
  assert.equal(reg.get("nonexistent"), undefined);
});

test("[10n-stop-false-non-cancellable] stop returns false for non-cancellable", () => {
  const reg = freshReg();
  reg.start({ kind: "check", label: "nc", cancellable: false });
  assert.equal(reg.stop("a1"), false);
});

test("[10n-stop-false-already-done] stop returns false for already done", () => {
  const reg = freshReg();
  const h = reg.start({ kind: "check", label: "d" });
  h.finish("done");
  assert.equal(reg.stop("a1"), false);
});

test("[10n-ps-all] /ps --all includes done/failed records", () => {
  const reg = freshReg();
  reg.start({ kind: "check", label: "running" });
  reg.start({ kind: "worker", label: "done-worker" }).finish("done");
  reg.start({ kind: "subagent", label: "failed-job" }).finish("failed");

  const { lines: allLines, writeLn: allWrite } = capture();
  runPsSlash(reg, "--all", allWrite);
  assert.ok(allLines.some((l) => l.includes("done")), "--all should include done records");
  assert.ok(allLines.some((l) => l.includes("failed")), "--all should include failed records");
});

test("[10n-stopAll-zero] stopAll on empty registry returns 0", () => {
  const reg = freshReg();
  assert.equal(reg.stopAll(), 0);
});
