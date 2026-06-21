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
import { assertPluginRelativePath } from "./discovery.js";
import { parseFrontmatter } from "../skills/frontmatter.js";
import type { SkillSummary } from "../skills/types.js";
import path from "node:path";
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

export interface ComposeSkillsResult {
  /** baseSkills plus any trusted plugin skills (existing names always win). */
  skills: SkillSummary[];
  /** Skill names that were added. */
  added: string[];
  /** Contributions that were not added, with a reason. */
  skipped: { plugin: string; path: string; reason: string }[];
}

/**
 * Compose TRUSTED plugins' skills (referenced SKILL.md files) into the catalog.
 * I/O is injected (`readFile`) so the policy is testable offline. Fail-closed on
 * trust; every referenced path is gated by `assertPluginRelativePath` (an
 * absolute or escaping path is refused without reading). A plugin skill NEVER
 * overrides an existing catalog name — discovered (project/user) skills win.
 */
export async function composePluginSkills(
  plugins: Plugin[],
  trust: PluginTrustStore,
  baseSkills: SkillSummary[],
  deps: { readFile: (absPath: string) => Promise<string | null> },
): Promise<ComposeSkillsResult> {
  const skills: SkillSummary[] = [...baseSkills];
  const byName = new Set(skills.map((s) => s.name));
  const added: string[] = [];
  const skipped: { plugin: string; path: string; reason: string }[] = [];

  for (const p of sortedPlugins(plugins)) {
    if (!resolvePluginTrust(p, trust).enabled) continue; // fail-closed
    for (const entry of p.manifest.skills ?? []) {
      let abs: string;
      try {
        abs = await assertPluginRelativePath(p.dir, entry.path);
      } catch (err) {
        skipped.push({ plugin: p.manifest.name, path: entry.path, reason: `unsafe path: ${(err as Error).message}` });
        continue;
      }
      const content = await deps.readFile(abs);
      if (content == null) {
        skipped.push({ plugin: p.manifest.name, path: entry.path, reason: "unreadable SKILL.md" });
        continue;
      }
      const { frontmatter: fm } = parseFrontmatter(content);
      if (!fm.description || !fm.description.trim()) {
        skipped.push({ plugin: p.manifest.name, path: entry.path, reason: 'missing required "description"' });
        continue;
      }
      const name = (fm.name && fm.name.trim()) || path.basename(path.dirname(abs));
      if (byName.has(name)) {
        skipped.push({ plugin: p.manifest.name, path: entry.path, reason: `skill "${name}" already defined (catalog wins)` });
        continue;
      }
      byName.add(name);
      skills.push({
        name,
        description: fm.description.trim(),
        source: p.source,
        path: abs,
        enabled: true,
        disableModelInvocation: fm.disableModelInvocation ?? false,
        userInvocable: fm.userInvocable ?? true,
      });
      added.push(name);
    }
  }

  return { skills, added, skipped };
}
