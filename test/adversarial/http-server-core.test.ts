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
  RunRegistry,
} from "../../src/server/httpCore.js";

test("[10B4-token] TCP mode without a token is refused", () => {
  assert.throws(() => requireServerToken({ stdio: false, token: undefined }), /token/i);
  assert.doesNotThrow(() => requireServerToken({ stdio: false, token: "secret" }));
  assert.doesNotThrow(() => requireServerToken({ stdio: true, token: undefined }));
});

test("[10B4-host] default bind host is loopback; 0.0.0.0 needs explicit unsafe opt-in", () => {
  assert.equal(resolveBindHost({}), "127.0.0.1");
  assert.throws(() => resolveBindHost({ host: "0.0.0.0" }), /unsafe/i);
  assert.equal(resolveBindHost({ host: "0.0.0.0", unsafeHost: "0.0.0.0" }), "0.0.0.0");
});

test("[10B4-cap] RunRegistry enforces the concurrent-run cap", () => {
  const reg = new RunRegistry(1);
  assert.equal(reg.tryStart("a"), true);
  assert.equal(reg.tryStart("b"), false, "second run blocked at cap 1");
  reg.finish("a");
  assert.equal(reg.tryStart("b"), true, "slot freed after finish");
});
