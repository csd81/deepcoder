import type { SkillSummary } from "./types.js";

const DEFAULT_CATALOG_CHARS = 4000;

/**
 * Build a compact, token-bounded skill catalog (progressive disclosure: name +
 * description only; the full SKILL.md body is loaded on activation). Highest-
 * precedence skills are listed first; descriptions are truncated, and trailing
 * skills are dropped (with a note) if the budget is exceeded. Returns "" when
 * there are no enabled skills.
 */
export function buildSkillCatalog(skills: SkillSummary[], maxChars: number = DEFAULT_CATALOG_CHARS): string {
  const enabled = skills.filter((s) => s.enabled);
  if (enabled.length === 0) return "";

  const header = "Available skills (activate before use):\n";
  const lines: string[] = [];
  let used = header.length;
  let dropped = 0;

  for (const s of enabled) {
    let desc = s.description.replace(/\s+/g, " ").trim();
    let line = `- ${s.name}: ${desc}\n`;
    if (line.length > 200) {
      desc = desc.slice(0, 200 - s.name.length - 6) + "…";
      line = `- ${s.name}: ${desc}\n`;
    }
    if (used + line.length > maxChars) {
      dropped = enabled.length - lines.length;
      break;
    }
    lines.push(line);
    used += line.length;
  }

  let out = header + lines.join("");
  if (dropped > 0) out += `… (+${dropped} more; raise DEEPCODER_SKILLS_CATALOG_CHARS)\n`;
  return out;
}
