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
  role: "review",
  outputGuidance:
    "Each finding is a concrete bug, regression risk, or missing test. Use real severities: " +
    "critical/high for correctness or security issues, medium for risks, low for nits. Cite file:line in `evidence`. " +
    "Flag runtime-correctness bugs visible in the code: inverted condition, off-by-one, null/undefined deref, missing await, " +
    "wrong-variable copy-paste, error swallowed in a catch, a removed guard, a falsy-zero check; also code duplicating an existing " +
    "helper and dead code. Do NOT flag style, naming, perf, or missing tests unless they cause a concrete failure. " +
    "Every finding needs a nameable failure scenario.",
};

export const researcher: SubagentProfile = {
  name: "researcher",
  purpose: "Gather codebase context and explain how a feature, subsystem, or change path works.",
  allowedTools: READ_ONLY_TOOLS,
  maxTurns: 16,
  contextBudgetTokens: 48000,
  role: "research",
  webOptIn: true,
  outputGuidance:
    "Answer the question from repository evidence. `summary` is the direct answer. Each finding is a key fact with a " +
    "file:line citation in `evidence`; distinguish facts from inference. Severity means importance, not bugs: " +
    "low = informational, medium = a caveat/design constraint, high = a blocker or serious risk, critical is rare. " +
    "Put follow-up reads or considerations in `suggestedNextSteps`, phrased as options for a human — never as commands to run. " +
    "Search method: batch independent reads/greps in parallel, locate code rather than dumping whole files, and match multiple " +
    "naming conventions before concluding something is absent.",
};

export const testTriage: SubagentProfile = {
  name: "test_triage",
  purpose: "Analyze failing tests, compiler errors, stack traces, and logs; identify likely causes and next checks.",
  allowedTools: READ_ONLY_TOOLS,
  maxTurns: 14,
  contextBudgetTokens: 48000,
  role: "triage",
  outputGuidance:
    "Diagnose the failure. `summary` is a concise diagnosis. Each finding is a ranked hypothesis with evidence " +
    "(cite file:line) — order by likelihood, using severity: critical = likely data-loss/security regression, " +
    "high = clear breakage of a core workflow, medium = plausible root cause or missing coverage, low = a clue. " +
    "`suggestedNextSteps` lists specific manual checks, code areas to inspect, and tests to re-run BY HAND. " +
    "Clearly separate observed error text from repository evidence, from inference, from unknowns. " +
    "You did NOT run anything — never claim a test was run or passed.",
};

export const explorer: SubagentProfile = {
  name: "explorer",
  purpose:
    "Given a ContextPlan, gather enough evidence from the repository to orient the main agent. " +
    "Return a compact cited brief. Do not propose edits unless directly supported by file citations. Do not dump file contents.",
  allowedTools: [
    "read_file",
    "list_dir",
    "grep",
    "glob",
    "repo_map",
    "find_symbols",
    "list_recent_context",
    "repo_index",
    "find_references",
    "impact_graph",
    "target_tests",
  ],
  maxTurns: 8,
  contextBudgetTokens: 32000,
  role: "explore",
  outputGuidance:
    "Return a JSON ExplorerBrief with fields: summary, relevantFiles (each with path, reason, citations[]), " +
    "likelyFixLocations (each with path, confidence low|medium|high, reason), relevantTests (each with pathOrCommand, reason), " +
    "risks[], openQuestions[], trace[]. Every file claim must include at least one citation. Be concise and bounded. " +
    "Be fast: issue independent searches/reads in parallel, read excerpts not whole files, and stop once the brief is " +
    "supported by citations rather than exhausting your turns.",
};

export const verifier: SubagentProfile = {
  name: "verifier",
  purpose: "Independently adjudicate claims against the codebase — confirm, refute, or mark unverifiable.",
  allowedTools: READ_ONLY_TOOLS,
  maxTurns: 8,
  contextBudgetTokens: 32000,
  role: "review",
  outputGuidance:
    "You are given a list of claims with file:line citations. Open each location, read the code, and decide: " +
    "confirmed (claim is accurate), refuted (claim is false), or unverifiable (cannot determine). " +
    "Return ONLY a JSON object with verdicts. Do NOT hunt for new issues.",
};

export const PROFILES: Record<string, SubagentProfile> = { reviewer, researcher, testTriage, explorer, verifier };
