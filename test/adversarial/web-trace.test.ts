/**
 * Phase 10E slice 4 — web trace core (pure, no session wiring).
 *
 * The auditable per-session web trace: a bounded, append-only record list plus a
 * compact, redacted citation summary used for the quarantine path (persisted
 * history stores the summary, not full page text). The Session-field + /web
 * slash-command wiring is a separate in-house follow-up; this is the pure core.
 *
 * Deliverables (each tagged [10E4-*]):
 *   [10E4-cap]       appendWebTrace is bounded (drops oldest past the cap)
 *   [10E4-immutable] appendWebTrace returns a NEW array; the input is untouched
 *   [10E4-summary]   summarizeWebTrace yields compact one-line citations
 *   [10E4-redact]    secrets in url/query/reason are redacted in the summary
 *
 * RED ANCHOR: imports from src/web/trace.ts which does not exist yet.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  appendWebTrace,
  summarizeWebTrace,
  WEB_TRACE_CAP,
  type WebTraceRecord,
} from "../../src/web/trace.js";

function rec(id: string, over: Partial<WebTraceRecord> = {}): WebTraceRecord {
  return { id, kind: "fetch", url: `https://example.com/${id}`, fetchedAt: "2026-06-21T00:00:00Z", ...over };
}

test("[10E4-cap] appendWebTrace caps the trace and drops the oldest", () => {
  let trace: WebTraceRecord[] = [];
  for (let i = 0; i < WEB_TRACE_CAP + 5; i++) trace = appendWebTrace(trace, rec(`r${i}`));
  assert.equal(trace.length, WEB_TRACE_CAP, "capped at WEB_TRACE_CAP");
  assert.equal(trace[trace.length - 1].id, `r${WEB_TRACE_CAP + 4}`, "newest kept");
  assert.equal(trace[0].id, "r5", "oldest 5 dropped");
});

test("[10E4-immutable] appendWebTrace does not mutate the input array", () => {
  const before: WebTraceRecord[] = [rec("a")];
  const after = appendWebTrace(before, rec("b"));
  assert.equal(before.length, 1, "input untouched");
  assert.equal(after.length, 2);
  assert.notEqual(before, after, "returns a new array");
});
