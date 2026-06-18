import { readFileSync } from "node:fs";
import path from "node:path";

/** First-match-wins precedence: most specific (deepcoder) first. */
const CANDIDATES = [".deepcoder/instructions.md", "AGENTS.md", "CLAUDE.md"];

export interface ProjectInstructions {
  /** Workspace-relative source file, or null if none found. */
  source: string | null;
  text: string;
}

/**
 * Load project instructions from the workspace root, honouring precedence.
 * Returns the first file that exists and has non-empty content.
 */
export function loadInstructions(workspaceRoot: string): ProjectInstructions {
  for (const rel of CANDIDATES) {
    try {
      const text = readFileSync(path.join(workspaceRoot, rel), "utf8").trim();
      if (text) return { source: rel, text };
    } catch {
      // Not found / unreadable — try the next candidate.
    }
  }
  return { source: null, text: "" };
}
