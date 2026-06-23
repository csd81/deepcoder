/**
 * Automatic model escalation (Flash → Pro). PURE state + decisions only —
 * actual model resolution stays in ModelRouter. "Escalate" = resolve the
 * stronger "plan" role (defaults to config.reasonerModel = Pro) instead of
 * "edit" (Flash). Sticky per task: once escalated, stay escalated.
 */
import type { ModelRole } from "./types.js";

export type EscalationReason = "high-complexity" | "repeated-error" | null;

export interface EscalationState {
  escalated: boolean;
  reason: EscalationReason;
}

export function initEscalation(): EscalationState {
  return { escalated: false, reason: null };
}

/** Role to resolve for the task: escalated → "plan" (Pro), else "edit" (Flash). */
export function escalationRole(state: EscalationState | undefined): ModelRole {
  return state?.escalated ? "plan" : "edit";
}

/**
 * Task-start decision from the reused complexity classifier. Defers to a manual
 * `/model edit` override (the user's explicit choice always wins) and only
 * escalates a `hard` task.
 */
export function decideStartEscalation(
  complexity: "simple" | "normal" | "hard",
  hasManualEditOverride: boolean,
): EscalationState {
  if (!hasManualEditOverride && complexity === "hard") {
    return { escalated: true, reason: "high-complexity" };
  }
  return initEscalation();
}
