import type { SubagentProfile } from "./types.js";

/**
 * Built-in subagent profiles. Slice 1 ships only `reviewer`. Every profile is
 * read-only: its `allowedTools` are native read-only/context tools — no
 * run_bash, edit_file, write_file, checkpoint, or MCP tools.
 */
const READ_ONLY_TOOLS = ["read_file", "grep", "glob", "list_dir", "repo_map", "find_symbols", "list_recent_context"];

export const reviewer: SubagentProfile = {
  name: "reviewer",
  purpose: "Inspect code for bugs, regressions, and missing tests; report findings.",
  allowedTools: READ_ONLY_TOOLS,
  maxTurns: 12,
  contextBudgetTokens: 48000,
  outputGuidance:
    "Each finding is a concrete bug, regression risk, or missing test. Use real severities: " +
    "critical/high for correctness or security issues, medium for risks, low for nits. Cite file:line in `evidence`.",
};

export const researcher: SubagentProfile = {
  name: "researcher",
  purpose: "Gather codebase context and explain how a feature, subsystem, or change path works.",
  allowedTools: READ_ONLY_TOOLS,
  maxTurns: 16,
  contextBudgetTokens: 48000,
  outputGuidance:
    "Answer the question from repository evidence. `summary` is the direct answer. Each finding is a key fact with a " +
    "file:line citation in `evidence`; distinguish facts from inference. Severity means importance, not bugs: " +
    "low = informational, medium = a caveat/design constraint, high = a blocker or serious risk, critical is rare. " +
    "Put follow-up reads or considerations in `suggestedNextSteps`, phrased as options for a human — never as commands to run.",
};

export const PROFILES: Record<string, SubagentProfile> = { reviewer, researcher };
