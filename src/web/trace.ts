/**
 * Phase 10E slice 4 — web trace core.
 *
 * Pure, auditable per-session web trace: a bounded, append-only record list plus
 * a compact, redacted citation summary used for the quarantine path. No session
 * wiring, no slash commands, no config edits.
 */

import { redactSecrets } from "../workspace/redact.js";

export interface WebTraceRecord {
  id: string;
  kind: "search" | "fetch";
  query?: string;
  url?: string;
  finalUrl?: string;
  title?: string;
  fetchedAt: string;     // ISO timestamp, passed IN by the caller
  bytesRead?: number;
  charsReturned?: number;
  resultCount?: number;
  blocked?: boolean;
  reason?: string;
}

/** Default maximum number of records kept in a web trace. */
export const WEB_TRACE_CAP: number = 100;

/**
 * Append `record` to `trace`, returning a NEW array bounded to `cap` records.
 * When the cap is exceeded the OLDEST records are dropped (newest last).
 * The input array is never mutated.
 */
export function appendWebTrace(
  trace: WebTraceRecord[],
  record: WebTraceRecord,
  cap: number = WEB_TRACE_CAP,
): WebTraceRecord[] {
  const next = [...trace, record];
  if (next.length > cap) {
    return next.slice(next.length - cap);
  }
  return next;
}

/**
 * Build a compact, multi-line summary string from a web trace — one line per
 * record — suitable for `/web trace` display and quarantine citation summaries.
 *
 * Every user-supplied field (url, finalUrl, query, title, reason) is passed
 * through `redactSecrets` before rendering. An empty trace returns a short
 * empty-state string.
 */
export function summarizeWebTrace(trace: WebTraceRecord[]): string {
  if (trace.length === 0) {
    return "(no web activity recorded)";
  }

  const lines = trace.map((r) => {
    // Determine the best locator for this record kind.
    let locator: string;
    if (r.kind === "search" && r.query) {
      locator = `query="${redactSecrets(r.query)}"`;
    } else {
      locator = redactSecrets(r.finalUrl ?? r.url ?? "(no url)");
    }

    // Build the line: id kind locator [title] [blocked]
    let line = `${r.id} ${r.kind} ${locator}`;

    if (r.title) {
      line += ` ${redactSecrets(r.title)}`;
    }

    if (r.blocked) {
      line += ` [blocked: ${r.reason ? redactSecrets(r.reason) : "yes"}]`;
    }

    return line;
  });

  return lines.join("\n");
}
