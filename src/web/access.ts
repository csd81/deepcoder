/**
 * Phase 10E slice 5 — web tool access decision.
 * Pure, default-deny safety gate for subagent web tool access.
 *
 * Default-DENY: tools are granted ONLY when the config enables web
 * AND the profile EXPLICITLY opts in (strict === true).
 */

export const WEB_TOOL_NAMES: readonly string[] = ["web_search", "web_fetch"];

export interface WebToolAccessInput {
  /** config.web.enabled — global web feature toggle */
  webEnabled: boolean;
  /** subagent profile explicitly opts into web access */
  profileWebOptIn: boolean;
}

/**
 * Returns the list of web tool names a profile may use, or [] when denied.
 *
 * Default-deny: both `webEnabled` and `profileWebOptIn` must be strictly
 * `=== true`. A truthy-but-not-true value (e.g. "yes", 1, {}) does NOT
 * grant access — this resists accidental or injected opt-ins.
 *
 * Always returns a fresh copy of WEB_TOOL_NAMES so callers cannot mutate
 * the canonical list.
 */
export function resolveWebTools(input: WebToolAccessInput): string[] {
  if (input.webEnabled !== true || input.profileWebOptIn !== true) {
    return [];
  }
  return [...WEB_TOOL_NAMES];
}
