/**
 * Phase 10S — glob pattern hardening (always-on, defense-in-depth).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateGlobPattern } from "../../src/workspace/paths.js";

test("rejects absolute and parent-escaping patterns", () => {
  for (const p of ["/etc/passwd", "/abs", "..", "../x", "../../y", "a/../b", "src/..", "a/b/../../../../etc"]) {
    assert.throws(() => validateGlobPattern(p), /workspace|escape|\.\./i, `should reject ${p}`);
  }
});

test("allows ordinary workspace-relative patterns", () => {
  for (const p of ["**/*.ts", "src/**/*.ts", "a/b.ts", "*.md", "?.ts", "src/foo.bar", "**/test/*.test.ts"]) {
    assert.doesNotThrow(() => validateGlobPattern(p), `should allow ${p}`);
  }
});
