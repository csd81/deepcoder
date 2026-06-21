/**
 * Phase 10D — compose trusted plugins' contributions into the session.
 *
 * Pure and deterministic — no filesystem, no model. Only TRUSTED + enabled
 * plugins contribute (fail-closed: an untrusted or malformed trust entry adds
 * nothing). Plugin checks are namespaced `<pluginName>:<checkName>` and NEVER
 * override an existing key — project/base checks always win, and the first
 * trusted plugin to claim a namespaced key wins over later duplicates. A
 * contributed check is still just a command: it runs through the same
 * classifier + runCheck gate as any other check, so this grants no new
 * execution authority beyond the explicit `/plugins trust` the user gave.
 */

import type { Plugin } from "./types.js";
import { resolvePluginTrust, type PluginTrustStore } from "./trust.js";
import type { CheckConfig } from "../config/fileConfig.js";

export interface ComposeChecksResult {
  /** baseChecks plus any namespaced, trusted plugin checks. */
  checks: Record<string, CheckConfig>;
  /** Namespaced keys that were added. */
  added: string[];
  /** Contributions that were not added, with a reason (collision / untrusted). */
  skipped: { key: string; reason: string }[];
}

/** Stable order so "first wins" on duplicate keys is deterministic. */
function sortedPlugins(plugins: Plugin[]): Plugin[] {
  return [...plugins].sort((a, b) =>
    a.manifest.name === b.manifest.name
      ? a.dir.localeCompare(b.dir)
      : a.manifest.name.localeCompare(b.manifest.name),
  );
}

export function composePluginChecks(
  plugins: Plugin[],
  trust: PluginTrustStore,
  baseChecks: Record<string, CheckConfig>,
): ComposeChecksResult {
  const checks: Record<string, CheckConfig> = { ...baseChecks };
  const added: string[] = [];
  const skipped: { key: string; reason: string }[] = [];

  for (const p of sortedPlugins(plugins)) {
    if (!resolvePluginTrust(p, trust).enabled) continue; // fail-closed: untrusted contributes nothing
    for (const [rawName, cfg] of Object.entries(p.manifest.checks ?? {})) {
      const key = `${p.manifest.name}:${rawName}`;
      if (key in checks) {
        skipped.push({ key, reason: "key already defined (project/base or an earlier plugin wins)" });
        continue;
      }
      checks[key] = { command: cfg.command, ...(cfg.timeoutMs !== undefined ? { timeoutMs: cfg.timeoutMs } : {}) };
      added.push(key);
    }
  }

  return { checks, added, skipped };
}
