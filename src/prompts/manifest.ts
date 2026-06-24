import { listCorpusFiles } from "./corpus.js";

/**
 * How each corpus file relates to the running code. This registry is the systematic
 * "linking" layer: every file in `system-prompts/` resolves to exactly one
 * status, so wiring more files later is a deliberate status change, not archaeology.
 *
 * - `surfaced`        — loaded into the live system prompt right now (see SURFACED_SYSTEM_PROMPT_FILES).
 * - `wired-inline`    — the feature/concept is already implemented (and tested) in src; not loaded.
 * - `skills-loadable` — consumable through the skills system if installed as a skill.
 * - `reference-only`  — code is the source of truth (tool descriptions, subagent prompts, data).
 * - `loader-available`— eligible to be surfaced via the loader; not yet wired.
 *
 * NB: verified against the codebase 2026-06-24 — every feature the roadmap once listed as
 * "needs new infrastructure" is in fact shipped (`wired-inline`); none remain unbuilt or
 * partial, so there is no `needs-infra`/`partial` status.
 */
export type CorpusStatus =
  | "surfaced"
  | "wired-inline"
  | "skills-loadable"
  | "reference-only"
  | "loader-available";

/**
 * The corpus files actually pulled into the runtime system prompt today. Adding a file
 * here (and an assertion in test/prompt-corpus.test.ts) is how a reference rule becomes
 * live behavior. These three carry guidance NOT otherwise present in systemPrompt.ts.
 */
export const SURFACED_SYSTEM_PROMPT_FILES = [
  "system-prompt-doing-tasks-ambitious-tasks.md",
  "system-prompt-doing-tasks-security.md",
  "system-prompt-doing-tasks-software-engineering-focus.md",
] as const;

/**
 * Files whose feature/concept is already implemented (and tested) in src — the code is
 * the source, the corpus file is reference. Includes the behavioral rules expressed
 * inline in systemPrompt.ts AND the subagent/tool features the roadmap once tracked as
 * "needs infra" but which have since shipped (verified 2026-06-24).
 */
const WIRED_INLINE: ((f: string) => boolean)[] = [
  // Behavioral rules hardcoded (tuned) in systemPrompt.ts.
  (f) => f === "system-prompt-doing-tasks-no-compatibility-hacks.md",
  (f) => f === "system-prompt-doing-tasks-no-unnecessary-additions.md",
  (f) => f === "system-prompt-doing-tasks-no-unnecessary-error-handling.md",
  // Reminder built + injected in src/agent/{tokenUsageReminder,agentLoop}.ts.
  (f) => f === "system-reminder-token-usage.md",
  // Shipped features (impl + tests in src):
  (f) => f.startsWith("agent-prompt-security-monitor-"), // src/security/{monitor,rules}.ts
  (f) => f.startsWith("agent-prompt-code-review-"), // src/delegate/multiAngleReview.ts, /review --effort high
  (f) => f.startsWith("agent-prompt-background-"), // src/subagents/background.ts, &research/&review/&status
  (f) => f === "agent-prompt-agent-creation-architect.md", // src/subagents/customProfiles.ts, /agent-create
  (f) => f === "agent-prompt-plan-mode-enhanced.md", // src/cli/planMode.ts state machine
  (f) => f === "agent-prompt-simplify-slash-command.md", // simplifier profile, /simplify
  (f) => f === "tool-description-enterworktree.md" || f === "tool-description-exitworktree.md", // src/tools/{enter,exit}Worktree.ts
  (f) => f === "agent-prompt-batch-slash-command.md", // src/delegate/batchPlan.ts + /batch command (slashCommands.ts)
  (f) => f === "agent-prompt-session-search.md", // src/session/sessionSearch.ts + /sessions search (slashCommands.ts)
];

const SURFACED = new Set<string>(SURFACED_SYSTEM_PROMPT_FILES);

/** Classify a single corpus file. Pure name-based; safe for files not on disk. */
export function corpusStatus(filename: string): CorpusStatus {
  if (SURFACED.has(filename)) return "surfaced";
  if (WIRED_INLINE.some((m) => m(filename))) return "wired-inline";
  if (filename.startsWith("skill-")) return "skills-loadable";
  if (filename.startsWith("tool-description-")) return "reference-only";
  if (filename.startsWith("agent-prompt-")) return "reference-only";
  if (filename.startsWith("data-")) return "reference-only";
  if (filename.startsWith("system-prompt-") || filename.startsWith("system-reminder-")) return "loader-available";
  return "reference-only";
}

/** Count every corpus file on disk by status — used for docs/tests and drift detection. */
export function corpusStatusCounts(): Record<CorpusStatus, number> {
  const counts: Record<CorpusStatus, number> = {
    surfaced: 0,
    "wired-inline": 0,
    "skills-loadable": 0,
    "reference-only": 0,
    "loader-available": 0,
  };
  for (const f of listCorpusFiles()) counts[corpusStatus(f)]++;
  return counts;
}
