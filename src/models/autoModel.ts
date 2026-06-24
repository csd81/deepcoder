import { scoreComplexity, type ComplexitySignals } from "./complexityScore.js";

export interface AutoModelArgs {
  signals: ComplexitySignals;
  explicitModel?: string; // from DEEPCODER_MODEL / --model — ALWAYS wins when truthy
  modelAuto: boolean; // config.modelAuto
  flashModel: string; // e.g. "deepseek-v4-flash"
  proModel: string; // e.g. "deepseek-v4-pro"
  threshold?: number; // passed through to scoreComplexity
}

export interface AutoModelResult {
  model: string;
  source: "explicit" | "auto" | "default";
  reasons: string[];
}

/**
 * Pure precedence layer: turn a complexity verdict into a concrete model id.
 *
 * Invariant: an explicit model ALWAYS wins; the scorer only applies when auto
 * is on. No I/O, no env reads, no model calls.
 */
export function resolveAutoModel(args: AutoModelArgs): AutoModelResult {
  const { signals, explicitModel, modelAuto, flashModel, proModel, threshold } =
    args;

  if (typeof explicitModel === "string" && explicitModel.length > 0) {
    return {
      model: explicitModel,
      source: "explicit",
      reasons: ["explicit model override"],
    };
  }

  if (modelAuto) {
    const verdict = scoreComplexity(signals, { threshold });
    return {
      model: verdict.model === "pro" ? proModel : flashModel,
      source: "auto",
      reasons: verdict.reasons,
    };
  }

  return {
    model: flashModel,
    source: "default",
    reasons: ["auto off: default to flash"],
  };
}
