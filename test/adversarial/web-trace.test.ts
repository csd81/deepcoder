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

test("[10E4-summary] summarizeWebTrace yields compact one-line citations", () => {
  const empty = summarizeWebTrace([]);
  assert.ok(empty.length > 0, "empty trace returns non-empty string");
  assert.equal(empty, "(no web activity recorded)", "empty trace message");

  const r1: WebTraceRecord = {
    id: "srch-1", kind: "search", query: "deep learning transformers",
    fetchedAt: "2026-06-21T00:00:00Z", resultCount: 10,
  };
  const r2: WebTraceRecord = {
    id: "fetch-2", kind: "fetch", url: "https://example.com/doc",
    finalUrl: "https://example.com/doc-final", title: "Example Doc",
    fetchedAt: "2026-06-21T00:00:01Z", bytesRead: 4096,
  };
  const r3: WebTraceRecord = {
    id: "fetch-3", kind: "fetch", url: "https://blocked.example.com",
    blocked: true, reason: "domain blocked by policy",
    fetchedAt: "2026-06-21T00:00:02Z",
  };

  const summary = summarizeWebTrace([r1, r2, r3]);
  const lines = summary.split("\n");
  assert.equal(lines.length, 3, "one line per record");

  // Line 1: search record contains its id and query
  assert.ok(lines[0].includes("srch-1"), "line 0 contains id srch-1");
  assert.ok(lines[0].includes('query="deep learning transformers"'), "line 0 contains query");

  // Line 2: fetch record contains its id and finalUrl
  assert.ok(lines[1].includes("fetch-2"), "line 1 contains id fetch-2");
  assert.ok(lines[1].includes("https://example.com/doc-final"), "line 1 contains finalUrl");
  assert.ok(lines[1].includes("Example Doc"), "line 1 contains title");

  // Line 3: blocked record contains [blocked: ...]
  assert.ok(lines[2].includes("fetch-3"), "line 2 contains id fetch-3");
  assert.ok(lines[2].includes("[blocked:"), "line 2 has blocked marker");
  assert.ok(lines[2].includes("domain blocked by policy"), "line 2 has reason");
});

test("[10E4-redact] secrets in url/query/reason are redacted in the summary", () => {
  const r: WebTraceRecord = {
    id: "leak-1", kind: "search", query: "my key is sk-ABCDEF0123456789",
    url: "https://example.com/?token=sk-ABCDEF0123456789",
    blocked: true, reason: "sk-ABCDEF0123456789 triggered block",
    fetchedAt: "2026-06-21T00:00:00Z",
  };

  const summary = summarizeWebTrace([r]);
  // Redacted — key-like patterns replaced
  assert.ok(!summary.includes("sk-ABCDEF0123456789"), "raw key must not appear");
  assert.ok(summary.includes("sk-***"), "redacted marker appears in query");
  assert.ok(summary.includes("sk-***"), "redacted marker appears somewhere");
  assert.ok(!summary.includes("ABCDEF0123456789"), "no key fragment leaks");
});
