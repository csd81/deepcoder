import type { SubagentProfile } from "./types.js";

/**
 * Built-in subagent profiles. Slice 1 ships only `reviewer`. Every profile is
 * read-only: its `allowedTools` are native read-only/context tools — no
 * run_bash, edit_file, write_file, checkpoint, or MCP tools.
 */
export const reviewer: SubagentProfile = {
  name: "reviewer",
  purpose: "Inspect code for bugs, regressions, and missing tests; report findings.",
  allowedTools: ["read_file", "grep", "glob", "list_dir", "repo_map", "find_symbols", "list_recent_context"],
  maxTurns: 12,
  contextBudgetTokens: 48000,
};

export const PROFILES: Record<string, SubagentProfile> = { reviewer };
