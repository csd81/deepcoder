/**
 * Phase 10C — session telemetry state.
 *
 * Tracks cumulative usage, model/tool/check counts, and warnings for a session.
 * Pure update helpers return/mutate deterministically.
 */

import type { TokenUsage } from "../providers/types.js";
import type { CostEstimate } from "../providers/pricing.js";
import { EMPTY_USAGE, addUsage } from "../providers/usage.js";

export interface TelemetryWarning {
  message: string;
  at: string;
}

export interface SessionTelemetry {
  startedAt: string;
  updatedAt: string;
  provider: string;
  model: string;
  usage: TokenUsage;
  estimatedCost?: CostEstimate;
  modelCalls: number;
  toolCalls: number;
  checkRuns: number;
  warnings: TelemetryWarning[];
}

/**
 * Create a new SessionTelemetry with zero/default state.
 */
export function createSessionTelemetry(provider: string, model: string): SessionTelemetry {
  const now = new Date().toISOString();
  return {
    startedAt: now,
    updatedAt: now,
    provider,
    model,
    usage: { ...EMPTY_USAGE },
    estimatedCost: undefined,
    modelCalls: 0,
    toolCalls: 0,
    checkRuns: 0,
    warnings: [],
  };
}

/**
 * Record token usage into telemetry (mutates and returns the telemetry object).
 */
export function recordUsage(
  telemetry: SessionTelemetry,
  usage: TokenUsage | undefined,
): SessionTelemetry {
  if (usage) {
    addUsage(telemetry.usage, usage);
  }
  telemetry.updatedAt = new Date().toISOString();
  return telemetry;
}

/**
 * Record a model call (increments counter, mutates and returns telemetry).
 */
export function recordModelCall(telemetry: SessionTelemetry): SessionTelemetry {
  telemetry.modelCalls += 1;
  telemetry.updatedAt = new Date().toISOString();
  return telemetry;
}

/**
 * Record a tool call (increments counter, mutates and returns telemetry).
 */
export function recordToolCall(telemetry: SessionTelemetry): SessionTelemetry {
  telemetry.toolCalls += 1;
  telemetry.updatedAt = new Date().toISOString();
  return telemetry;
}

/**
 * Record a check run (increments counter, mutates and returns telemetry).
 */
export function recordCheckRun(telemetry: SessionTelemetry): SessionTelemetry {
  telemetry.checkRuns += 1;
  telemetry.updatedAt = new Date().toISOString();
  return telemetry;
}

/**
 * Record a warning (appends to warnings array, mutates and returns telemetry).
 */
export function recordWarning(
  telemetry: SessionTelemetry,
  message: string,
): SessionTelemetry {
  telemetry.warnings.push({ message, at: new Date().toISOString() });
  telemetry.updatedAt = new Date().toISOString();
  return telemetry;
}

/**
 * Update the estimated cost on telemetry (mutates and returns telemetry).
 */
export function updateEstimatedCost(
  telemetry: SessionTelemetry,
  cost: CostEstimate,
): SessionTelemetry {
  telemetry.estimatedCost = cost;
  telemetry.updatedAt = new Date().toISOString();
  return telemetry;
}
