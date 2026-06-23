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

export function planFromImport(s: PlanHandoffSession): string | undefined {
  return s.plan?.text;
}
