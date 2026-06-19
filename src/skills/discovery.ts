import { readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseFrontmatter } from "./frontmatter.js";
import type { SkillSummary } from "./types.js";

/**
 * Discover skills from the supported roots, lowest → highest precedence:
 *   ~/.deepcoder/skills, ~/.agents/skills, <ws>/.deepcoder/skills, <ws>/.agents/skills
 * A skill is `<root>/<name>/SKILL.md`. `description` is required; a skill missing
 * it (or unreadable) is skipped with a warning. Duplicate names resolve by
 * precedence (a later root wins). Supporting files are NOT read here.
 */
export async function discoverSkills(workspaceRoot: string, home: string = os.homedir()): Promise<SkillSummary[]> {
  const roots: { dir: string; source: SkillSummary["source"] }[] = [
    { dir: path.join(home, ".deepcoder", "skills"), source: "user" },
    { dir: path.join(home, ".agents", "skills"), source: "user" },
    { dir: path.join(workspaceRoot, ".deepcoder", "skills"), source: "workspace" },
    { dir: path.join(workspaceRoot, ".agents", "skills"), source: "workspace" },
  ];

  const byName = new Map<string, SkillSummary>();
  for (const { dir, source } of roots) {
    let entries: string[];
    try {
      entries = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      continue; // root absent — fine
    }
    for (const sub of entries) {
      const file = path.join(dir, sub, "SKILL.md");
      let content: string;
      try {
        if (!(await stat(file)).isFile()) continue;
        content = await readFile(file, "utf8");
      } catch {
        continue;
      }
      const { frontmatter: fm } = parseFrontmatter(content);
      if (!fm.description || !fm.description.trim()) {
        warn(`skipping skill "${sub}" (${file}): missing required "description"`);
        continue;
      }
      const name = (fm.name && fm.name.trim()) || sub;
      byName.set(name, {
        name,
        description: fm.description.trim(),
        source,
        path: file,
        enabled: true, // config-driven disabling is deferred to a 7C follow-up
        disableModelInvocation: fm.disableModelInvocation ?? false,
        userInvocable: fm.userInvocable ?? true,
      });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function warn(msg: string): void {
  process.stderr.write(`Warning: skills — ${msg}\n`);
}
