/**
 * Phase 10S — workspace containment: the pure sandbox transform.
 * applyContainment forces a fail-closed, workspace-only bubblewrap profile.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyContainment, DEFAULT_CONTAINMENT } from "../../src/containment/types.js";
import type { SandboxConfig } from "../../src/sandbox/types.js";

const base = (over: Partial<SandboxConfig> = {}): SandboxConfig => ({
  mode: "off",
  network: "on",
  workspaceWrite: true,
  extraMounts: [],
  timeoutMs: 120_000,
  fallback: "ask",
  ...over,
});

test("default containment is ON (secure by default)", () => {
  assert.equal(DEFAULT_CONTAINMENT.enabled, true);
});

test("forces bubblewrap + fail-closed regardless of input mode/fallback", () => {
  const out = applyContainment(base({ mode: "off", fallback: "local" }));
  assert.equal(out.mode, "bubblewrap");
  assert.equal(out.fallback, "fail");
  const out2 = applyContainment(base({ mode: "fast", fallback: "ask" }));
  assert.equal(out2.mode, "bubblewrap");
  assert.equal(out2.fallback, "fail");
});

test("drops extraMounts (no external holes)", () => {
  const out = applyContainment(base({ extraMounts: [{ path: "/etc", mode: "rw" }, { path: "/home", mode: "ro" }] }));
  assert.deepEqual(out.extraMounts, []);
});

test("preserves network, workspaceWrite, timeoutMs (filesystem-only)", () => {
  const out = applyContainment(base({ network: "off", workspaceWrite: false, timeoutMs: 9_000 }));
  assert.equal(out.network, "off");
  assert.equal(out.workspaceWrite, false);
  assert.equal(out.timeoutMs, 9_000);
});

test("is idempotent", () => {
  const once = applyContainment(base({ mode: "local" }));
  assert.deepEqual(applyContainment(once), once);
});

test("does not mutate the input", () => {
  const input = base({ mode: "off", extraMounts: [{ path: "/x", mode: "ro" }] });
  const frozen = JSON.stringify(input);
  applyContainment(input);
  assert.equal(JSON.stringify(input), frozen);
});
