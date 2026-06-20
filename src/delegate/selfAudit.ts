/**
 * Phase 9G — Self-audit parser.
 *
 * Parses and validates a worker's final self-audit JSON. Never throws;
 * returns null on any malformed, oversized, or invalid input.
 *
 * The harness never trusts the self-audit blindly — it cross-checks
 * declared evidence against the patch/worktree independently.
 */

import { isWorkerSelfAudit, type WorkerSelfAudit } from "./types.js";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/** Default maximum byte size for the raw audit JSON. */
const DEFAULT_MAX_BYTES = 16_000;

/* ------------------------------------------------------------------ */
/*  parseSelfAudit                                                     */
/* ------------------------------------------------------------------ */

/**
 * Parse a raw JSON string into a validated WorkerSelfAudit.
 *
 * Returns null (never throws) if:
 * - raw exceeds `maxBytes` (default ~16_000)
 * - raw is not valid JSON
 * - the parsed value fails `isWorkerSelfAudit` shape validation
 *
 * @param raw  The raw JSON string from the worker's self-audit file.
 * @param opts Optional settings (maxBytes cap).
 */
export function parseSelfAudit(
  raw: string,
  opts?: { maxBytes?: number },
): WorkerSelfAudit | null {
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;

  // Reject oversized input before parsing.
  if (Buffer.byteLength(raw, "utf8") > maxBytes) {
    return null;
  }

  // Attempt JSON parse.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  // Validate shape via the defensive type guard.
  if (!isWorkerSelfAudit(parsed)) {
    return null;
  }

  return parsed;
}
