/**
 * Sandbox fallback "ask" must NOT silently run commands locally. Since we can't
 * synchronously prompt from resolveBackend, "ask" fails closed (like "fail") when
 * a requested isolation backend can't be satisfied. Only an unspecified fallback
 * degrades (best-effort). Uses a deferred mode (docker) so the fallback branch is
 * exercised independent of whether bwrap is installed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveBackend } from "../../src/sandbox/index.js";

test('fallback "ask" fails closed when a strict/deferred mode cannot be sandboxed', () => {
  assert.throws(() => resolveBackend("docker", "ask"), /not yet implemented|cannot sandbox/i);
});

test('fallback "fail" still throws; an unspecified fallback degrades to local (best-effort)', () => {
  assert.throws(() => resolveBackend("docker", "fail"));
  assert.equal(resolveBackend("docker"), "local"); // no fallback -> best-effort degrade
  assert.equal(resolveBackend("docker", undefined), "local");
});
