import type { PersistedSession } from "./sessionStore.js";
import { serializeSession, type SessionExport } from "./sessionExport.js";

export type PlanHandoffSession = PersistedSession & {
  plan?: { text: string; approvedAt: string };
};

export function serializePlanHandoff(s: PlanHandoffSession): SessionExport {
  if (!s.plan) {
    throw new Error("no approved plan to hand off");
  }
  return serializeSession(s, /* sanitize */ true);
}

const MAX_PLAN_TEXT_BYTES = 1_048_576;

export function planFromImport(s: PlanHandoffSession): string | undefined {
  const text = s.plan?.text;
  if (typeof text !== "string" || text.length === 0) return undefined;
  if (new TextEncoder().encode(text).length > MAX_PLAN_TEXT_BYTES) return undefined;
  return text;
}
