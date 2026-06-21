/**
 * Phase 10B slice 1 (10B.1) — runtime extraction.
 *
 * Moves the reusable session-construction helpers OUT of src/cli/main.ts into a
 * UI-independent src/runtime/sessionFactory.ts so the SDK (slice 2) and servers
 * (slices 3/4) can build sessions the same way the CLI does — no CLI/server drift.
 *
 * This is a MOVE (refactor): behavior must be byte-for-byte identical; the full
 * test:phase suite is the no-regression gate, and main.ts must still boot.
 *
 * Deliverables:
 *   [10B1R-export] buildSession, setupIsolation, finalizeIsolation, initMcp are
 *                  exported from src/runtime/sessionFactory.ts
 *   [10B1R-wired]  buildSession(loadConfig()) constructs a correctly-wired Session
 *                  offline (no network — provider construction is lazy)
 *
 * RED ANCHOR: imports from src/runtime/sessionFactory.ts which does not exist yet.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildSession } from "../../src/runtime/sessionFactory.js";
import { loadConfig } from "../../src/config/config.js";

test("[10B1R-wired] buildSession constructs a wired session offline", async () => {
  const session = await buildSession(loadConfig());
  // Tools wired
  assert.ok(session.registry.get("read_file"), "registry has the read_file tool");
  // Provider constructed (no network call at construction time)
  assert.ok(session.provider, "a provider is set");
  // Session store + mode wired
  assert.ok(session.store, "a session store is set");
  assert.equal(typeof session.mode, "string");
  assert.ok(Array.isArray(session.messages) && session.messages.length >= 1, "has a system message");
});
