import type { PersistedSession } from "./sessionStore.js";
import { redactSecrets } from "../workspace/redact.js";

export interface SessionExport {
  version: 1;
  exportedAt: string;
  session: PersistedSession;
}

export interface ImportValidation {
  ok: boolean;
  session?: PersistedSession;
  error?: string;
}

/**
 * Serialize a session to a portable JSON blob.
 * When `sanitize` is true, redact secrets from message content.
 */
export function serializeSession(
  session: PersistedSession,
  sanitize?: boolean,
): SessionExport {
  const copy: PersistedSession = sanitize
    ? sanitizeSession(structuredClone(session))
    : session;
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    session: copy,
  };
}

/**
 * Validate an imported session blob.
 * Returns the parsed session or a validation error.
 */
export function validateImport(raw: unknown): ImportValidation {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "not an object" };
  }
  const blob = raw as Record<string, unknown>;
  if (blob.version !== 1) {
    return { ok: false, error: `unsupported version: ${blob.version}` };
  }
  if (typeof blob.session !== "object" || blob.session === null) {
    return { ok: false, error: "missing session field" };
  }
  const s = blob.session as Record<string, unknown>;
  if (typeof s.id !== "string" || !s.id) {
    return { ok: false, error: "session.id is required" };
  }
  if (!Array.isArray(s.messages)) {
    return { ok: false, error: "session.messages must be an array" };
  }
  // Accept the blob as-is; the SessionStore.loadSession path validates
  // individual fields at use time.
  return { ok: true, session: s as unknown as PersistedSession };
}

function sanitizeSession(s: PersistedSession): PersistedSession {
  // Redact message content
  s.messages = s.messages.map((m) => ({
    ...m,
    content: redactSecrets(m.content ?? ""),
  }));
  // Redact known secret-hosting metadata
  if (s.telemetry) {
    s.telemetry = { ...s.telemetry, costs: undefined } as typeof s.telemetry;
  }
  return s;
}
