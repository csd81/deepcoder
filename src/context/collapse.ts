import type { AgentMessage } from "../providers/types.js";
import { isExploreTool, isReadTool, pathArg, type Region, type StageStats } from "./tridentUtil.js";

interface ExploreGroup {
  calls: { name: string; args: Record<string, unknown> }[];
  /** All messages (assistant + its tool results) the group occupies. */
  span: AgentMessage[];
  chars: number;
}

const isBlank = (s: string | undefined): boolean => !s || s.trim() === "";

function boundedList(items: string[], max: number): string {
  if (items.length <= max) return items.join(", ");
  return `${items.slice(0, max).join(", ")}, …(+${items.length - max} more)`;
}

function note(groups: ExploreGroup[]): string {
  const reads: string[] = [];
  const searches: string[] = [];
  let n = 0;
  for (const g of groups) {
    for (const c of g.calls) {
      n++;
      if (isReadTool(c.name)) {
        const p = pathArg(c.args);
        if (p) reads.push(p);
      } else {
        const q = String(c.args.query ?? c.args.pattern ?? c.args.q ?? "");
        searches.push(`${c.name}${q ? ` "${q}"` : ""}`);
      }
    }
  }
  const parts: string[] = [];
  if (reads.length) parts.push(`read ${boundedList(reads, 6)}`);
  if (searches.length) parts.push(boundedList(searches, 4));
  return `[collapsed ${n} exploration calls: ${parts.join("; ")}]`;
}

/**
 * Trident Stage 2 — Collapse. Fold a **contiguous run** of *pure tool-I/O*
 * assistant+tool groups (read_file / list_dir / glob / grep, with no substantive
 * assistant prose and no write/execute effect) into one synthetic `user` note.
 * Removes the assistant turns AND their tool results together — a structurally
 * valid deletion with no orphans. Only collapses runs of ≥2 groups, and only
 * when the note is strictly shorter than what it replaces (monotonic).
 *
 * Mutates `messages` in place via a single splice of the region.
 */
export function collapse(messages: AgentMessage[], region: Region): StageStats {
  const out: AgentMessage[] = [];
  let changed = false;
  let saved = 0;
  let i = region.start;

  while (i < region.end) {
    // Parse a maximal run of consecutive qualifying explore groups from i.
    const groups: ExploreGroup[] = [];
    let j = i;
    while (j < region.end) {
      const a = messages[j];
      if (
        !(
          a &&
          a.role === "assistant" &&
          a.toolCalls?.length &&
          isBlank(a.content) &&
          a.toolCalls.every((c) => isExploreTool(c.name))
        )
      ) {
        break;
      }
      const ids = new Set(a.toolCalls!.map((c) => c.id));
      const span: AgentMessage[] = [a];
      let chars = a.content?.length ?? 0;
      let k = j + 1;
      while (k < region.end) {
        const r = messages[k];
        if (r?.role === "tool" && r.toolCallId && ids.has(r.toolCallId)) {
          span.push(r);
          chars += typeof r.content === "string" ? r.content.length : 0;
          k++;
        } else break;
      }
      // Require every call to have a result — otherwise removing the group would
      // orphan a call. If not clean, stop the run here (don't consume this group).
      if (span.length - 1 !== a.toolCalls!.length) break;
      groups.push({ calls: a.toolCalls!.map((c) => ({ name: c.name, args: c.arguments ?? {} })), span, chars });
      j = k;
    }

    if (groups.length >= 2) {
      const text = note(groups);
      const totalChars = groups.reduce((s, g) => s + g.chars, 0);
      if (text.length < totalChars) {
        out.push({ role: "user", content: text });
        changed = true;
        saved += totalChars - text.length;
        i = j;
        continue;
      }
    }
    out.push(messages[i]!);
    i++;
  }

  const removed = region.end - region.start - out.length;
  messages.splice(region.start, region.end - region.start, ...out);
  return { changed, saved, removed };
}
