import type { SkillFrontmatter } from "./types.js";

/**
 * Parse a SKILL.md's leading YAML frontmatter block without a YAML dependency.
 * Supports scalar `key: value` lines (strings + booleans) and a simple block
 * list for `allowedTools` (`  - item`). A document with no `---` frontmatter
 * returns empty metadata and the whole content as the body. Malformed lines are
 * ignored — parsing never throws.
 */
export function parseFrontmatter(content: string): { frontmatter: SkillFrontmatter; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (!m) return { frontmatter: {}, body: content };

  const fm: SkillFrontmatter = {};
  const lines = m[1]!.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!;
    const raw = kv[2]!.trim();

    if (raw === "") {
      // possible block list (e.g. allowedTools:\n  - read_file)
      const items: string[] = [];
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1]!)) {
        items.push(lines[++i]!.replace(/^\s*-\s+/, "").trim().replace(/^["']|["']$/g, ""));
      }
      if (key === "allowedTools") fm.allowedTools = items;
      continue;
    }

    const val = raw.replace(/^["']|["']$/g, "");
    switch (key) {
      case "name":
        fm.name = val;
        break;
      case "description":
        fm.description = val;
        break;
      case "disableModelInvocation":
        fm.disableModelInvocation = val === "true";
        break;
      case "userInvocable":
        fm.userInvocable = val !== "false";
        break;
      case "allowedTools":
        // inline form: allowedTools: [a, b]
        fm.allowedTools = val
          .replace(/^\[|\]$/g, "")
          .split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean);
        break;
    }
  }
  return { frontmatter: fm, body: m[2] ?? "" };
}
