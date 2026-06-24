/**
 * Pure parser for the machine-readable audit findings convention.
 *
 * A synthesis doc lists findings, one per line, in the documented format:
 *
 *   - `src/security/monitor.ts:142` · **HIGH** · rule-bypass when matcher is empty
 *
 * The severity token is captured RAW (any uppercase word) so that out-of-schema
 * severities (e.g. `CRITICAL`) survive parsing and are rejected downstream by the
 * triage gate rather than silently dropped here.
 *
 * No I/O — input is the markdown string, output is the finding list.
 */
import type { AuditFinding } from "../delegate/selfMaintain.js";

/** A finding as parsed from the doc — severity is raw (validated by triage). */
export interface ParsedFinding {
  filePath: string;
  severity: string;
  claim: string;
}

// `path:line` · **SEVERITY** · claim   (leading list bullet optional)
const LINE_RE =
  /^\s*[-*]?\s*`([^`]+:\d+)`\s*·\s*\*\*([A-Za-z]+)\*\*\s*·\s*(.+?)\s*$/;

/**
 * Extract every finding line from a synthesis doc. Lines that do not match the
 * convention are ignored. Severity is returned uppercased but otherwise raw.
 */
export function parseFindings(markdown: string): ParsedFinding[] {
  const out: ParsedFinding[] = [];
  for (const raw of markdown.split(/\r?\n/)) {
    const m = LINE_RE.exec(raw);
    if (!m) continue;
    out.push({
      filePath: m[1].trim(),
      severity: m[2].toUpperCase(),
      claim: m[3].trim(),
    });
  }
  return out;
}

/**
 * Parse a doc into the `AuditFinding[]` shape consumed by `runSelfMaintain`.
 * The severity is widened to the union type; invalid severities are preserved
 * verbatim and rejected by the triage gate (never silently coerced).
 */
export function parseAuditFindings(markdown: string): AuditFinding[] {
  return parseFindings(markdown).map((f) => ({
    filePath: f.filePath,
    severity: f.severity as AuditFinding["severity"],
    claim: f.claim,
  }));
}
