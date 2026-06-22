/**
 * Interactive Plan Mode — pure state machine (no I/O).
 *
 * ┌─────┐  enterPlanMode  ┌───────────────┐  recordPlan  ┌────────────────────┐
 * │ off │ ──────────────→ │ investigating │ ───────────→ │ awaiting-approval  │
 * └─────┘                 └───────────────┘              └─────────┬──────────┘
 *      ↑                       ↑    ↑                    approve  │  │ reject
 *      │                       │    └──────────────────────────────┘  │
 *      │                       └───────────────────────────────────→ ┌┴──────────────┐
 *      └── exitPlanMode                                              │ investigating │
 *                                                                   └───────────────┘
 *                            ┌────────────┐
 *                  approve → │ executing  │ → exitPlanMode → off
 *                            └────────────┘
 *
 * Illegal transitions are no-ops (return the input state unchanged).
 */
import type { ApprovalMode } from "../config/config.js";

export type PlanPhase = "off" | "investigating" | "awaiting-approval" | "executing";

export interface PlanModeState {
  phase: PlanPhase;
  priorMode: ApprovalMode | null;
  plan: string | null;
}

export function initPlanMode(): PlanModeState {
  return { phase: "off", priorMode: null, plan: null };
}

export function enterPlanMode(s: PlanModeState, currentMode: ApprovalMode): PlanModeState {
  if (s.phase !== "off") return s;
  return { phase: "investigating", priorMode: currentMode, plan: null };
}

export function recordPlan(s: PlanModeState, planText: string): PlanModeState {
  if (s.phase !== "investigating") return s;
  return { ...s, phase: "awaiting-approval", plan: planText };
}

export function approvePlan(s: PlanModeState): PlanModeState {
  if (s.phase !== "awaiting-approval") return s;
  return { ...s, phase: "executing" };
}

export function rejectPlan(s: PlanModeState): PlanModeState {
  if (s.phase !== "awaiting-approval") return s;
  return { ...s, phase: "investigating", plan: null };
}

export function exitPlanMode(_s: PlanModeState): PlanModeState {
  return { phase: "off", priorMode: null, plan: null };
}

/** Effective approval mode while plan mode is active. */
export function effectivePlanModeApproval(
  s: PlanModeState,
  baseMode: ApprovalMode,
): ApprovalMode {
  if (s.phase === "investigating" || s.phase === "awaiting-approval") return "readonly";
  return baseMode; // executing or off -> base mode
}
