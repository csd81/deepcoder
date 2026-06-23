import { promises as fs } from "node:fs";
import path from "node:path";
import { redactSecrets } from "../workspace/redact.js";
import type { PersistedSession } from "./sessionStore.js";

export interface SessionHit {
  id: string;
  title?: string;
  updatedAt: string;
  score: number;
  snippet: string;
  matchedRoles: string[];
}

function countMatches(content: string, lowerQuery: string): number {
  const lower = content.toLowerCase();
  let count = 0;
  let pos = 0;
  while ((pos = lower.indexOf(lowerQuery, pos)) !== -1) {
    count++;
    pos += lowerQuery.length;
  }
  return count;
}

function extractSnippet(content: string, matchStart: number, queryLen: number): string {
  const windowSize = 120;
  const half = Math.floor(windowSize / 2);
  let start = Math.max(0, matchStart - half);
  let end = Math.min(content.length, matchStart + queryLen + half);
  if (end - start < windowSize) {
    if (start === 0) {
      end = Math.min(content.length, start + windowSize);
    } else {
      start = Math.max(0, end - windowSize);
    }
  }
  let snippet = content.slice(start, end);
  if (start > 0) snippet = "…" + snippet;
  if (end < content.length) snippet = snippet + "…";
  return snippet;
}

export function scoreSession(
  s: Pick<PersistedSession, "id" | "title" | "updatedAt" | "messages">,
  query: string,
): SessionHit | null {
  if (!query || query.trim().length === 0) return null;

  const lowerQuery = query.toLowerCase();
  const queryLen = query.length;
  let score = 0;
  const matchedRoles: string[] = [];
  let firstMatchLocalIdx = -1;
  let firstMatchContent = "";

  for (const msg of s.messages) {
    const content = msg.content ?? "";
    const count = countMatches(content, lowerQuery);
    if (count > 0) {
      if (!matchedRoles.includes(msg.role)) matchedRoles.push(msg.role);
      // Track the first match across all messages (first message wins on tie)
      if (firstMatchLocalIdx === -1) {
        firstMatchLocalIdx = content.toLowerCase().indexOf(lowerQuery);
        firstMatchContent = content;
      }
    }
    score += count;
  }

  if (score === 0) return null;

  const raw = extractSnippet(firstMatchContent, firstMatchLocalIdx, queryLen);
  const snippet = redactSecrets(raw);

  return {
    id: s.id,
    title: s.title,
    updatedAt: s.updatedAt,
    score,
    snippet,
    matchedRoles,
  };
}

export async function searchSessions(
  workspaceRoot: string,
  query: string,
  opts?: { limit?: number; includeArchived?: boolean },
): Promise<SessionHit[]> {
  if (!query || query.trim().length === 0) return [];

  const dir = path.join(workspaceRoot, ".deepcoder", "sessions");
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }

  const limit = opts?.limit ?? 20;
  const hits: SessionHit[] = [];

  for (const f of files) {
    let s: PersistedSession;
    try {
      s = JSON.parse(await fs.readFile(path.join(dir, f), "utf8")) as PersistedSession;
    } catch {
      continue; // skip corrupt files
    }

    if (s.archived && !opts?.includeArchived) continue;

    const hit = scoreSession(s, query);
    if (hit) hits.push(hit);
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}
