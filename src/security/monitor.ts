import type { PreToolUseInput } from "../hooks/types.js";
import { evaluateRules } from "./rules.js";

export interface SecurityVerdict {
  decision: "deny" | "none";
  reason?: string;
  warnings: string[];
}

export interface MonitorConfig {
  enabled: boolean;
  mode: "block" | "warn";
}

export function evaluateAction(input: PreToolUseInput, cfg: MonitorConfig): SecurityVerdict {
  if (!cfg.enabled) {
    return { decision: "none", warnings: [] };
  }

  try {
    const res = evaluateRules(input);
    if (res.hardBlock) {
      return { decision: "deny", reason: res.reason, warnings: [] };
    }
    if (res.softBlock) {
      return { decision: "none", warnings: [res.reason] };
    }
    return { decision: "none", warnings: [] };
  } catch (e) {
    // Fail-safe direction: internal error -> none + warning
    return { decision: "none", warnings: ["security monitor error: " + (e as Error).message] };
  }
}
