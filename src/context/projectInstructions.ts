import { readFileSync, statSync, lstatSync } from "node:fs";
import path from "node:path";
import { resolveReadPathInWorkspace } from "../workspace/paths.js";
import { isSensitivePath } from "../workspace/sensitive.js";

/** First-match-wins precedence: most specific (deepcoder) first. */
const CANDIDATES = [".deepcoder/instructions.md", "AGENTS.md", "CLAUDE.md"];

/** Cap instruction bytes — a symlink to a huge/special file is a startup-DoS vector. */
const MAX_INSTRUCTION_BYTES = 256 * 1024;

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
      // Symlink-safe: realpath + confine to the workspace (throws if a symlink
      // escapes it). Defeats `AGENTS.md -> ~/.ssh/id_ed25519`.
      const real = resolveReadPathInWorkspace(workspaceRoot, rel);
      // The candidate NAMES are trusted by design (`.deepcoder/instructions.md`
      // is itself "sensitive" by path but is a legitimate instructions file).
      // Only reject when the candidate is a SYMLINK redirecting to a sensitive
      // real target (e.g. `AGENTS.md -> ./.env`).
      if (lstatSync(path.join(workspaceRoot, rel)).isSymbolicLink() && isSensitivePath(real)) continue;
      // Cap bytes before reading (huge/special-file guard).
      if (statSync(real).size > MAX_INSTRUCTION_BYTES) continue;
      const text = readFileSync(real, "utf8").trim();
      if (text) return { source: rel, text };
    } catch {
      // Escaping symlink / not found / unreadable — try the next candidate.
    }
  }
  return { source: null, text: "" };
}
