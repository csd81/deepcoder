import { readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { READ_ONLY_TOOLS } from "./profiles.js";
import { parseFrontmatter } from "../skills/frontmatter.js";
import type { SubagentProfile } from "./types.js";
import { ALL_ROLES, type ModelRole } from "../models/types.js";

/** Sanitize a disk-loaded def into a safe, read-only, non-recursive profile. */
export function sanitizeProfile(fm: any, body: string, fallbackName: string): SubagentProfile | null {
  const name = (fm.name?.trim()) || fallbackName;
  if (!fm.description?.trim()) return null; // required, like skills
  const ro = new Set(READ_ONLY_TOOLS);
  
  // INTERSECT with READ_ONLY_TOOLS — strips edit_file/run_bash/delegate/MCP/etc.
  const fmAllowed = Array.isArray(fm.allowedTools) ? fm.allowedTools : READ_ONLY_TOOLS;
  const allowedTools = fmAllowed.filter((t: string) => ro.has(t));
  
  return {
    name,
    purpose: fm.description.trim(),
    allowedTools: allowedTools.length ? allowedTools : [...READ_ONLY_TOOLS],
    maxTurns: clampInt(fm.maxTurns, 1, 24, 12),
    contextBudgetTokens: clampInt(fm.contextBudgetTokens, 4000, 64000, 48000),
    role: ALL_ROLES.includes(fm.role as any) ? (fm.role as ModelRole) : "review",
    outputGuidance: body.trim() || undefined,
    webOptIn: fm.webOptIn === true,
  };
}

function clampInt(val: any, min: number, max: number, fallback: number): number {
  if (typeof val !== "number" || isNaN(val)) return fallback;
  if (val < min) return min;
  if (val > max) return max;
  return val;
}

/** Discover + sanitize disk profiles, lowest→highest precedence (skills roots). */
export async function discoverCustomProfiles(workspaceRoot: string, home: string = os.homedir()): Promise<Record<string, SubagentProfile>> {
  const roots = [
    path.join(home, ".deepcoder", "agents"),
    path.join(home, ".agents", "agents"),
    path.join(workspaceRoot, ".deepcoder", "agents"),
    path.join(workspaceRoot, ".agents", "agents"),
  ];

  const byName: Record<string, SubagentProfile> = {};
  
  for (const dir of roots) {
    let entries: string[];
    try {
      entries = (await readdir(dir, { withFileTypes: true }))
        .filter((e) => e.isFile() && e.name.endsWith(".md"))
        .map((e) => e.name);
    } catch {
      continue; // root absent — fine
    }
    
    for (const sub of entries) {
      const file = path.join(dir, sub);
      let content: string;
      try {
        content = await readFile(file, "utf8");
      } catch {
        continue;
      }
      
      const fallbackName = sub.replace(/\.md$/, "");
      const { frontmatter, body } = parseFrontmatter(content);
      
      const profile = sanitizeProfile(frontmatter, body, fallbackName);
      if (!profile) {
        process.stderr.write(`Warning: custom profile — skipping "${fallbackName}" (${file}): missing required "description"\n`);
        continue;
      }
      
      byName[profile.name] = profile;
    }
  }
  
  return byName;
}

/** Built-ins as base; disk defs override by name. Built-in NAMES are protected
 *  (a disk file named "reviewer" cannot shadow the built-in reviewer). */
export function mergeProfiles(builtins: Record<string, SubagentProfile>, custom: Record<string, SubagentProfile>): Record<string, SubagentProfile> {
  const merged = { ...builtins };
  const builtinNames = new Set(Object.values(builtins).map(p => p.name));
  
  for (const [name, prof] of Object.entries(custom)) {
    if (builtinNames.has(name)) {
      process.stderr.write(`Warning: custom profile — skipping "${name}": cannot shadow built-in profile\n`);
      continue;
    }
    merged[name] = prof;
  }
  return merged;
}
