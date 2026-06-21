/**
 * Phase 10B slice 4 — local HTTP/SSE server POLICY CORE (pure, no real socket).
 *
 * The security-critical decisions are pure functions so they're testable without
 * binding a flaky port: auth token requirement, localhost-only host resolution,
 * request-body size limit, concurrent-run cap, and SSE framing + bounded replay.
 * The thin http.createServer wiring is a separate concern (later slice).
 *
 * Deliverables (each tagged [10B4-*]):
 *   [10B4-token]    requireServerToken: TCP without a token throws; stdio or token-present is ok
 *   [10B4-host]     resolveBindHost: defaults to 127.0.0.1; non-loopback needs explicit unsafe opt-in
 *   [10B4-auth]     checkAuth: correct Bearer token -> ok; missing/wrong -> 401
 *   [10B4-bodylimit] withinBodyLimit: rejects an over-cap body
 *   [10B4-cap]      RunRegistry caps concurrent runs; finishing frees a slot
 *   [10B4-sse]      formatSse frames `data: <json>\n\n`; replay is bounded
 *
 * RED ANCHOR: imports from src/server/httpCore.ts which does not exist yet.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  requireServerToken,
  resolveBindHost,
  checkAuth,
  withinBodyLimit,
  DEFAULT_MAX_BODY_BYTES,
  RunRegistry,
  formatSse,
  SseReplayBuffer,
} from "../../src/server/httpCore.js";
import type { SdkEvent } from "../../src/sdk/events.js";

// ─── [10B4-token] Token requirement ──────────────────────────────────────────

test("[10B4-token] TCP mode without a token is refused", () => {
  // TCP mode with no token → throw
  assert.throws(() => requireServerToken({ stdio: false, token: undefined }), /token/i);
  assert.throws(() => requireServerToken({ stdio: false, token: "" }), /token/i);

  // TCP mode with a token → ok
  assert.doesNotThrow(() => requireServerToken({ stdio: false, token: "t0ken-abc" }));

  // stdio mode → always ok (parent owns the pipe)
  assert.doesNotThrow(() => requireServerToken({ stdio: true, token: undefined }));
  assert.doesNotThrow(() => requireServerToken({ stdio: true, token: "" }));
  assert.doesNotThrow(() => requireServerToken({ stdio: true, token: "t0ken-abc" }));
});

// ─── [10B4-host] Bind-host resolution ────────────────────────────────────────

test("[10B4-host] default bind host is loopback; 0.0.0.0 needs explicit unsafe opt-in", () => {
  // No host → defaults to 127.0.0.1
  assert.equal(resolveBindHost({}), "127.0.0.1");
  assert.equal(resolveBindHost({ host: undefined }), "127.0.0.1");
  assert.equal(resolveBindHost({ host: "" }), "127.0.0.1");

  // Loopback hosts returned as-is
  assert.equal(resolveBindHost({ host: "127.0.0.1" }), "127.0.0.1");
  assert.equal(resolveBindHost({ host: "localhost" }), "localhost");
  assert.equal(resolveBindHost({ host: "::1" }), "::1");

  // Non-loopback without unsafeHost → throw
  assert.throws(() => resolveBindHost({ host: "0.0.0.0" }), /unsafe/i);
  assert.throws(() => resolveBindHost({ host: "192.168.1.5" }), /unsafe/i);

  // Non-loopback WITH matching unsafeHost → ok
  assert.equal(resolveBindHost({ host: "0.0.0.0", unsafeHost: "0.0.0.0" }), "0.0.0.0");
  assert.equal(resolveBindHost({ host: "192.168.1.5", unsafeHost: "192.168.1.5" }), "192.168.1.5");

  // Non-loopback WITH non-matching unsafeHost → still throws
  assert.throws(() => resolveBindHost({ host: "0.0.0.0", unsafeHost: "192.168.1.5" }), /unsafe/i);
});

// ─── [10B4-auth] Auth check ──────────────────────────────────────────────────

test("[10B4-auth] checkAuth validates Bearer token correctly", () => {
  const token = "t0ken-abc";

  // No token configured → auth not enforced
  assert.deepEqual(checkAuth({ authorizationHeader: undefined, token: undefined }), { ok: true });
  assert.deepEqual(checkAuth({ authorizationHeader: "malicious", token: undefined }), { ok: true });
  assert.deepEqual(checkAuth({ authorizationHeader: undefined, token: "" }), { ok: true });

  // Token configured, correct header → ok
  assert.deepEqual(checkAuth({ authorizationHeader: `Bearer ${token}`, token }), { ok: true });

  // Token configured, missing header → 401
  assert.deepEqual(checkAuth({ authorizationHeader: undefined, token }), { ok: false, status: 401 });

  // Token configured, wrong token → 401
  assert.deepEqual(checkAuth({ authorizationHeader: "Bearer wrong-token", token }), {
    ok: false,
    status: 401,
  });

  // Token configured, malformed (not Bearer prefix) → 401
  assert.deepEqual(checkAuth({ authorizationHeader: "Basic abc123", token }), {
    ok: false,
    status: 401,
  });

  // Token configured, empty header → 401
  assert.deepEqual(checkAuth({ authorizationHeader: "", token }), { ok: false, status: 401 });
});

// ─── [10B4-bodylimit] Body size limit ────────────────────────────────────────

test("[10B4-bodylimit] withinBodyLimit enforces the max body size", () => {
  // Within limit
  assert.equal(withinBodyLimit(100, DEFAULT_MAX_BODY_BYTES), true);
  assert.equal(withinBodyLimit(DEFAULT_MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES), true);

  // Exceeds limit
  assert.equal(withinBodyLimit(DEFAULT_MAX_BODY_BYTES + 1, DEFAULT_MAX_BODY_BYTES), false);
  assert.equal(withinBodyLimit(2_000_000, 1_000_000), false);
});

test("[10B4-bodylimit] DEFAULT_MAX_BODY_BYTES is 1 MiB", () => {
  assert.equal(DEFAULT_MAX_BODY_BYTES, 1_048_576);
});

// ─── [10B4-cap] Concurrent-run registry ──────────────────────────────────────

test("[10B4-cap] RunRegistry enforces the concurrent-run cap", () => {
  const reg = new RunRegistry(1);
  assert.equal(reg.tryStart("a"), true);
  assert.equal(reg.tryStart("b"), false, "second run blocked at cap 1");
  reg.finish("a");
  assert.equal(reg.tryStart("b"), true, "slot freed after finish");
});

test("[10B4-cap] RunRegistry rejects duplicate id even when under cap", () => {
  const reg = new RunRegistry(5);
  assert.equal(reg.tryStart("a"), true);
  // Same id again → false (already active)
  assert.equal(reg.tryStart("a"), false);
  // Other ids still work
  assert.equal(reg.tryStart("b"), true);
  assert.equal(reg.tryStart("c"), true);
});

test("[10B4-cap] RunRegistry tracks active count correctly", () => {
  const reg = new RunRegistry(3);
  assert.equal(reg.activeCount, 0);

  assert.equal(reg.tryStart("x"), true);
  assert.equal(reg.activeCount, 1);

  assert.equal(reg.tryStart("y"), true);
  assert.equal(reg.activeCount, 2);

  reg.finish("x");
  assert.equal(reg.activeCount, 1);

  reg.finish("y");
  assert.equal(reg.activeCount, 0);
});

test("[10B4-cap] RunRegistry constructor throws on invalid maxConcurrent", () => {
  assert.throws(() => new RunRegistry(0), />= 1/i);
  assert.throws(() => new RunRegistry(-1), />= 1/i);
  assert.doesNotThrow(() => new RunRegistry(1));
  assert.doesNotThrow(() => new RunRegistry(100));
});

// ─── [10B4-sse] SSE framing + bounded replay ─────────────────────────────────

test("[10B4-sse] formatSse produces correct SSE frame", () => {
  const event: SdkEvent = { type: "notice", message: "hello" };
  const frame = formatSse(event);
  assert.equal(frame, `data: ${JSON.stringify(event)}\n\n`);
});

test("[10B4-sse] formatSse handles complex events", () => {
  const event: SdkEvent = {
    type: "tool.result",
    name: "read_file",
    output: "file content",
  };
  const frame = formatSse(event);
  assert.equal(frame, `data: ${JSON.stringify(event)}\n\n`);
});

test("[10B4-sse] SseReplayBuffer replay returns events oldest-first", () => {
  const buf = new SseReplayBuffer(10);

  const e1: SdkEvent = { type: "notice", message: "first" };
  const e2: SdkEvent = { type: "notice", message: "second" };

  buf.push(e1);
  buf.push(e2);

  const expected = formatSse(e1) + formatSse(e2);
  assert.equal(buf.replay(), expected);
});

test("[10B4-sse] SseReplayBuffer is bounded — oldest events are dropped", () => {
  const maxEvents = 3;
  const buf = new SseReplayBuffer(maxEvents);

  const events: SdkEvent[] = [];
  for (let i = 0; i < maxEvents + 2; i++) {
    const ev: SdkEvent = { type: "notice", message: `ev-${i}` };
    events.push(ev);
    buf.push(ev);
  }

  // Replay should only contain the most recent maxEvents frames.
  const replay = buf.replay();
  const expected = events.slice(-maxEvents).map(formatSse).join("");
  assert.equal(replay, expected);

  // Dropped count should be correct
  assert.equal(buf.droppedCount, 2);
  assert.equal(buf.size, maxEvents);
});
