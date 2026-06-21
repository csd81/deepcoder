import test from "node:test";
import assert from "node:assert/strict";

import {
  applyTrust,
  isPluginEnabled,
  pluginTrustKey,
  resolvePluginTrust,
  type PluginTrustStore,
} from "../../src/plugins/trust.js";
import type { Plugin } from "../../src/plugins/types.js";

function plugin(overrides: Partial<Plugin> = {}): Plugin {
  return {
    manifest: {
      schemaVersion: 1,
      name: "example",
      version: "1.0.0",
      description: "Example plugin",
      capabilities: ["skills"],
    },
    dir: "/workspace/.deepcoder/plugins/example",
    source: "workspace",
    trustState: "untrusted",
    warnings: [],
    ...overrides,
  };
}

test("[10d-trust-1] pluginTrustKey is stable and includes source/name/dir", () => {
  const a = plugin();
  const b = plugin();
  const c = plugin({ dir: "/other/.deepcoder/plugins/example" });

  assert.equal(pluginTrustKey(a), pluginTrustKey(b));
  assert.notEqual(pluginTrustKey(a), pluginTrustKey(c));
  assert.match(pluginTrustKey(a), /^workspace:example:/);
});

test("[10d-trust-2] resolvePluginTrust defaults fail-closed: untrusted and disabled", () => {
  const state: PluginTrustStore = { plugins: {} };
  const resolved = resolvePluginTrust(plugin(), state);

  assert.equal(resolved.trusted, false);
  assert.equal(resolved.enabled, false);
  assert.equal(resolved.state, "untrusted");
});

test("[10d-trust-3] applyTrust can trust+enable then untrust+disable a plugin", () => {
  const p = plugin();
  let state: PluginTrustStore = { plugins: {} };

  state = applyTrust(state, pluginTrustKey(p), "trusted");
  assert.equal(resolvePluginTrust(p, state).trusted, true);
  assert.equal(isPluginEnabled(p, state), true);

  state = applyTrust(state, pluginTrustKey(p), "untrusted");
  assert.equal(resolvePluginTrust(p, state).trusted, false);
  assert.equal(isPluginEnabled(p, state), false);
});

test("[10d-trust-4] applyTrust is immutable and preserves unrelated plugin entries", () => {
  const a = pluginTrustKey(plugin({ manifest: { ...plugin().manifest, name: "a" } }));
  const b = pluginTrustKey(plugin({ manifest: { ...plugin().manifest, name: "b" } }));
  const state: PluginTrustStore = {
    plugins: {
      [a]: { state: "trusted", enabled: true },
    },
  };

  const next = applyTrust(state, b, "untrusted");

  assert.notEqual(next, state);
  assert.deepEqual(state.plugins[a], { state: "trusted", enabled: true });
  assert.deepEqual(next.plugins[a], { state: "trusted", enabled: true });
  assert.deepEqual(next.plugins[b], { state: "untrusted", enabled: false });
});

test("[10d-trust-5] malformed or missing trust store entries fail closed", () => {
  const p = plugin();
  const key = pluginTrustKey(p);
  const malformed = {
    plugins: {
      [key]: { state: "maybe", enabled: true },
    },
  } as unknown as PluginTrustStore;

  assert.equal(resolvePluginTrust(p, malformed).trusted, false);
  assert.equal(resolvePluginTrust(p, { plugins: {} }).enabled, false);
});
