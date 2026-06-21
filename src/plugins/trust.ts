import type { Plugin, PluginTrustState } from "./types.js";

export interface PluginTrustStore {
  plugins: Record<string, { state: PluginTrustState; enabled: boolean }>;
}

/**
 * Generate a stable trust key for a plugin, incorporating source, name, and dir.
 */
export function pluginTrustKey(plugin: Plugin): string {
  return `${plugin.source}:${plugin.manifest.name}:${plugin.dir}`;
}

/**
 * Resolve the trust status for a plugin from the given trust store.
 * Missing or malformed entries fail closed (untrusted, disabled).
 */
export function resolvePluginTrust(
  plugin: Plugin,
  state: PluginTrustStore,
): { key: string; trusted: boolean; enabled: boolean; state: PluginTrustState } {
  const key = pluginTrustKey(plugin);
  const entry = state.plugins[key];

  if (!entry || entry.state !== "trusted") {
    return { key, trusted: false, enabled: false, state: "untrusted" };
  }

  return { key, trusted: true, enabled: true, state: "trusted" };
}

/**
 * Check whether a plugin is enabled in the given trust store.
 * Missing or malformed entries return false (fail closed).
 */
export function isPluginEnabled(plugin: Plugin, state: PluginTrustStore): boolean {
  return resolvePluginTrust(plugin, state).enabled;
}

/**
 * Immutably update the trust state for a plugin key in the store.
 * Returns a new PluginTrustStore; the original is not mutated.
 * "trusted" → enabled=true, "untrusted" → enabled=false.
 */
export function applyTrust(
  state: PluginTrustStore,
  key: string,
  trust: PluginTrustState,
): PluginTrustStore {
  return {
    plugins: {
      ...state.plugins,
      [key]: { state: trust, enabled: trust === "trusted" },
    },
  };
}
