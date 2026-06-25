// Lifecycle hooks (Phase 7B). Two families share one config shape:
//  - PreToolUse is a *blocking* pre-event: a hook may DENY a tool (exit 2 or
//    {"decision":"deny"}). It can never override a policy/headless deny — those
//    tools never reach a hook. (Engine: runPreToolUseHooks; types kept stable.)
//  - All other V1 events are *advisory* post-events: a hook may WARN (any
//    message / nonzero exit) and, for a fixed allowlist of events, inject
//    CONTEXT for the model. They can never deny. (Engine: runAdvisoryHooks.)

export type HookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolFailure"
  | "SessionStart"
  | "UserPromptSubmit"
  | "PostCheck"
  | "SolveAttemptEnd"
  | "SessionEnd"
  | "PreCompact"
  | "PostCompact";

/** Events whose hooks may return injected `context` for the model. */
export const CONTEXT_EVENTS: readonly HookEvent[] = [
  "SessionStart",
  "UserPromptSubmit",
  "PostCheck",
  "SolveAttemptEnd",
  // PostCompact may inject a bounded advisory guidance note after compaction.
  "PostCompact",
];

export interface HookConfig {
  name: string;
  /** Regex/exact/`*` matched against the event's match keys (e.g. tool name, command). */
  matcher?: string;
  command: string;
  timeoutMs?: number;
}

export interface HooksConfig {
  enabled: boolean;
  events: Partial<Record<HookEvent, HookConfig[]>>;
}

// --- PreToolUse (blocking) — kept stable for the existing engine/tests --------

export interface PreToolUseInput {
  tool: string;
  command?: string;
  affectedPaths?: string[];
}

export type HookDecision = "deny" | "none";

export interface HookOutcome {
  decision: HookDecision;
  reason?: string;
}

// --- Compaction lifecycle (advisory) ------------------------------------------

/** Fired before the context pipeline reduces history. Advisory; cannot block. */
export interface PreCompactInput {
  beforeTokens: number;
  triggerTokens: number;
  force: boolean;
  stage: "auto" | "manual" | "overflow-recovery";
}

/** Fired after a reduction occurred. PostCompact may inject a bounded note. */
export interface PostCompactInput {
  beforeTokens: number;
  afterTokens: number;
  /** Per-stage token accounting from the pipeline. */
  stages: { stage: string; before: number; after: number; changed: boolean }[];
  summaryPreview?: string;
}

// --- Advisory events ----------------------------------------------------------

/** What an advisory hook run produced: redacted warnings + (allowlisted) context. */
export interface AdvisoryOutcome {
  warnings: string[];
  context: string[];
}

export const EMPTY_ADVISORY: AdvisoryOutcome = { warnings: [], context: [] };

export const DEFAULT_HOOKS: HooksConfig = { enabled: false, events: {} };
