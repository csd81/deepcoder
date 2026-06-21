/**
 * Phase 10D — composing trusted plugins' contributions into the session.
 * Pure/offline: no filesystem, trust store injected.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { composePluginChecks } from "../../src/plugins/compose.js";
import { pluginTrustKey, type PluginTrustStore } from "../../src/plugins/trust.js";
import type { Plugin, PluginManifest } from "../../src/plugins/types.js";
import type { CheckConfig } from "../../src/config/fileConfig.js";

function plugin(name: string, checks?: PluginManifest["checks"], dir = `/plugins/${name}`): Plugin {
  return {
    manifest: { schemaVersion: 1, name, version: "1.0.0", description: name, capabilities: ["checks"], checks },
    dir,
    source: "workspace",
    trustState: "untrusted",
    warnings: [],
  };
}

function trustOf(...plugins: Plugin[]): PluginTrustStore {
  const store: PluginTrustStore = { plugins: {} };
  for (const p of plugins) store.plugins[pluginTrustKey(p)] = { state: "trusted", enabled: true };
  return store;
}

const base: Record<string, CheckConfig> = { phase: { command: "npm run test:phase" } };

test("untrusted plugins contribute nothing (fail-closed)", () => {
  const p = plugin("foo", { build: { command: "make" } });
  const out = composePluginChecks([p], { plugins: {} }, base);
  assert.deepEqual(out.checks, base);
  assert.deepEqual(out.added, []);
});

test("a trusted plugin's checks are added under a namespaced key", () => {
  const p = plugin("foo", { build: { command: "make", timeoutMs: 1000 } });
  const out = composePluginChecks([p], trustOf(p), base);
  assert.deepEqual(out.checks["foo:build"], { command: "make", timeoutMs: 1000 });
  assert.equal(out.checks["phase"]!.command, "npm run test:phase", "base checks are preserved");
  assert.ok(out.added.includes("foo:build"));
});

test("a plugin can never override an existing (project) check key — project wins", () => {
  const p = plugin("foo", { build: { command: "evil" } });
  const out = composePluginChecks([p], trustOf(p), { ...base, "foo:build": { command: "trusted-project" } });
  assert.equal(out.checks["foo:build"]!.command, "trusted-project");
  assert.ok(out.skipped.some((s) => s.key === "foo:build"));
});

test("two trusted plugins with the same name+check: first wins deterministically, second skipped", () => {
  const a = plugin("dup", { c: { command: "first" } }, "/plugins/a");
  const b = plugin("dup", { c: { command: "second" } }, "/plugins/b");
  const out = composePluginChecks([a, b], trustOf(a, b), {});
  assert.equal(out.checks["dup:c"]!.command, "first");
  assert.ok(out.skipped.some((s) => s.key === "dup:c"));
});

test("enabled-but-untrusted (malformed trust entry) contributes nothing", () => {
  const p = plugin("foo", { build: { command: "make" } });
  const store: PluginTrustStore = { plugins: { [pluginTrustKey(p)]: { state: "untrusted", enabled: true } } };
  const out = composePluginChecks([p], store, base);
  assert.deepEqual(out.added, []);
});
