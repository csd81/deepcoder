export type HookEvent = "PreToolUse";

export interface HookConfig {
  name: string;
  matcher?: string;
  command: string;
  timeoutMs?: number;
}

export interface HooksConfig {
  enabled: boolean;
  events: Partial<Record<HookEvent, HookConfig[]>>;
}

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

export const DEFAULT_HOOKS: HooksConfig = { enabled: false, events: {} };
