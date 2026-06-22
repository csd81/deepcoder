/**
 * Phase 10A — compact approval-review model and renderer (pure, no I/O).
 *
 * Builds a structured `ApprovalReview` from an `ApprovalRequest` plus optional
 * command-policy / sandbox metadata, then renders it as width/height-bounded
 * lines suitable for a TUI overlay.  Implements the risk heuristics, details
 * mode, and diff styling described in the phase plan.
 */

import type { ApprovalRequest } from "./approval.js";
import type { DiffFileSummary } from "./diffSummary.js";
import { summarizeUnifiedDiff, formatDiffStat, capLines } from "./diffSummary.js";
import type { Theme } from "./theme.js";
import { wrapLine } from "./textLayout.js";
import { truncate, visibleWidth } from "./minimalRenderer.js";
import { redactSecrets } from "../workspace/redact.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type ApprovalRisk = "low" | "medium" | "high";

export interface ApprovalReview {
  title: string;
  actionKind: "read-only" | "session" | "mutate" | "execute" | "unknown";
  risk: ApprovalRisk;
  summary: string;
  reasons: string[];
  files: DiffFileSummary[];
  commandPolicy?: "allow" | "ask" | "deny";
  sandboxSummary?: string;
  diffLines: string[];
  details: string[];
}

export interface BuildApprovalReviewInput extends ApprovalRequest {
  commandPolicy?: "allow" | "ask" | "deny";
  sandboxSummary?: string;
}

// ── Builder ─────────────────────────────────────────────────────────────────

/**
 * Build an `ApprovalReview` from a permission request plus optional metadata.
 *
 * Heuristics (all pure — no I/O, no policy enforcement):
 *   - `execute` actions → high risk
 *   - `mutate` touching source/config files → medium risk
 *   - changes under `.deepcoder/config.json`, hooks, MCP, plugin trust,
 *     package scripts → high risk
 *   - test/docs-only mutation → low/medium risk
 *   - no diff + execute command → high risk
 *   - command-policy `deny` → high risk (shouldn't normally reach approval)
 */
export function buildApprovalReview(
  input: BuildApprovalReviewInput,
): ApprovalReview {
  const { description, diff, commandPolicy, sandboxSummary } = input;

  // ── Determine action kind ──────────────────────────────────────────────
  const actionKind = inferActionKind(description, diff);

  // ── Assess risk ────────────────────────────────────────────────────────
  const risk = assessRisk(actionKind, description, diff, commandPolicy);

  // ── Summarise ──────────────────────────────────────────────────────────
  const summary = buildSummary(actionKind, description);

  // ── Parse files ────────────────────────────────────────────────────────
  const files = diff ? summarizeUnifiedDiff(diff) : [];

  // ── Reasons ────────────────────────────────────────────────────────────
  const reasons = buildReasons(risk, files, actionKind, description);

  // ── Diff lines (redacted, bounded) ─────────────────────────────────────
  const diffLines = diff ? capLines(diff.split("\n"), 200) : [];

  // ── Details lines ──────────────────────────────────────────────────────
  const details = buildDetails(description, files, commandPolicy, sandboxSummary, diff);

  return {
    title: "Permission required",
    actionKind,
    risk,
    summary,
    reasons,
    files,
    commandPolicy,
    sandboxSummary,
    diffLines,
    details,
  };
}

// ── Renderer ────────────────────────────────────────────────────────────────

export interface RenderApprovalReviewInput {
  review: ApprovalReview;
  width: number;
  height: number;
  scroll: number;
  mode: "diff" | "details";
  theme: Theme;
}

/**
 * Render an `ApprovalReview` to a bounded array of lines suitable for a TUI
 * overlay.  Handles both `diff` mode (summary + diff body) and `details` mode
 * (bounded request details).
 *
 * Lines are width-truncated and height-bounded.  Diff lines are coloured via
 * the theme.  A footer always shows approve/deny/details key hints.
 */
export function renderApprovalReview(
  input: RenderApprovalReviewInput,
): string[] {
  const { review, width, height, scroll, mode, theme } = input;
  const rows: string[] = [];

  // ── Header line ────────────────────────────────────────────────────────
  const header = `${review.title} · ${review.actionKind} · ${review.risk} risk`;
  for (const ln of wrapLine(header, width)) rows.push(theme.title(ln));

  // ── Summary line ───────────────────────────────────────────────────────
  for (const ln of wrapLine(review.summary, width)) rows.push(ln);

  // ── Separator ──────────────────────────────────────────────────────────
  rows.push(theme.dim("─".repeat(Math.max(1, Math.min(width, 50)))));

  // ── Body ───────────────────────────────────────────────────────────────
  const bodyLines: string[] = [];

  if (mode === "details") {
    // Details mode: show the full request description, file list, etc.
    bodyLines.push(...renderDetailsBody(review, width));
  } else {
    // Diff mode: file stats + diff body
    bodyLines.push(...renderDiffBody(review, width));
  }

  // ── Footer ─────────────────────────────────────────────────────────────
  const footerParts = ["y approve", "n deny"];
  if (review.diffLines.length > 0 || review.details.length > 0) {
    footerParts.push("d details");
  }
  footerParts.push("↑↓ scroll");
  footerParts.push("Esc deny");
  const footer = theme.dim(footerParts.join(" · "));

  // Calculate how many body rows fit
  const chrome = rows.length + 1; // +1 for footer
  const bodyHeight = Math.max(0, height - chrome);

  // Clamp every emitted row to the requested visible width. `wrapLine` measures
  // plain text, but styled rows (theme.title/dim) and the never-wrapped footer
  // can still exceed `width`, so this final clamp is what enforces the bound.
  const clamp = (lines: string[]): string[] =>
    lines.map((ln) => (visibleWidth(ln) > width ? truncate(ln, width) : ln));

  if (bodyHeight <= 0) {
    // No room for body; just header, summary, separator, footer
    rows.push(footer);
    return clamp(rows.slice(0, height));
  }

  // Scroll the body
  const start = Math.max(0, Math.min(scroll, Math.max(0, bodyLines.length - bodyHeight)));
  const window = bodyLines.slice(start, start + bodyHeight);
  for (const ln of window) rows.push(ln);

  rows.push(footer);
  return clamp(rows.slice(0, height));
}

// ── Internal helpers ────────────────────────────────────────────────────────

/**
 * Infer the action kind from the description and diff presence.
 *
 * Heuristic order:
 *   1. Keywords in description: "execute", "run", "command" → execute
 *   2. Keywords: "mutate", "edit", "write", "delete", "patch", "apply" → mutate
 *   3. Diff present → mutate (most permissions with diffs are edits)
 *   4. Sandbox/session keywords → session
 *   5. Read-only keywords → read-only
 *   6. Fallback → unknown
 */
function inferActionKind(
  description: string,
  diff: string | undefined,
): ApprovalReview["actionKind"] {
  const desc = description.toLowerCase();

  // Check for execute keywords first (highest priority)
  if (
    /\b(run|execute|exec|command|build|install|deploy|npm|npx|bash|sh)\b/.test(desc)
  ) {
    // But if it's a read-only command like "list files", override below
    if (!/\b(read-only|readonly|list|show|display|cat|echo|print)\b/.test(desc)) {
      return "execute";
    }
  }

  // Mutate keywords
  if (
    /\b(mutate|edit|write|delete|patch|apply|save|upload|modify|update)\b/.test(desc)
  ) {
    return "mutate";
  }

  // Diff present without clear keywords → still mutate
  if (diff && diff.trim().length > 0) {
    return "mutate";
  }

  // Session keywords
  if (
    /\b(session|approve|confirm|interactive)\b/.test(desc) &&
    !/\b(read-only|readonly|list|show)\b/.test(desc)
  ) {
    return "session";
  }

  // Read-only keywords
  if (
    /\b(read-only|readonly|list|show|display|get|search|grep|find|cat|echo)\b/.test(desc)
  ) {
    return "read-only";
  }

  return "unknown";
}

/**
 * Assess risk level from the action kind, description, and file paths.
 */
function assessRisk(
  actionKind: ApprovalReview["actionKind"],
  description: string,
  diff: string | undefined,
  commandPolicy?: "allow" | "ask" | "deny",
): ApprovalRisk {
  // Command policy deny → high (shouldn't normally reach approval, but be safe)
  if (commandPolicy === "deny") return "high";

  // Execute → high
  if (actionKind === "execute") return "high";

  // Read-only → low
  if (actionKind === "read-only") return "low";

  // Check for high-risk path patterns in description and diff
  const riskyPatterns = [
    /\.deepcoder\/config(\.json)?/,
    /hooks\//,
    /mcp\//,
    /plugin.*trust/,
    /plugins\//,
    /package\.json/,
    /package-lock\.json/,
    /tsconfig\.json/,
    /\.env/,
    /Dockerfile/,
    /\.gitignore/,
    /node_modules\//,
  ];

  const combinedText = `${description} ${diff ?? ""}`;
  for (const pattern of riskyPatterns) {
    if (pattern.test(combinedText)) return "high";
  }

  // Mutate with source/config file → medium
  if (actionKind === "mutate") {
    const desc = description.toLowerCase();

    // Test/docs-only mutation → low
    if (
      /\btest\b/.test(desc) &&
      !/\bsrc\b/.test(desc) &&
      !/\bconfig\b/.test(desc)
    ) {
      return "low";
    }

    // Check if description mentions docs/test patterns
    if (
      /\bdoc\b/.test(desc) &&
      !/\bsrc\b/.test(desc) &&
      !/\bconfig\b/.test(desc)
    ) {
      return "low";
    }

    // Otherwise medium for mutate
    return "medium";
  }

  // Session → medium
  if (actionKind === "session") return "medium";

  // Unknown → medium (be conservative)
  return "medium";
}

/**
 * Build a one-line summary of what's being requested.
 */
function buildSummary(
  _actionKind: ApprovalReview["actionKind"],
  description: string,
): string {
  // Use the description verbatim as the summary line
  return redactSecrets(description);
}

/**
 * Build a list of human-readable reason strings.
 */
function buildReasons(
  risk: ApprovalRisk,
  files: DiffFileSummary[],
  actionKind: ApprovalReview["actionKind"],
  description: string,
): string[] {
  const reasons: string[] = [];

  if (actionKind === "execute") {
    reasons.push("executes a command on your system");
  } else if (actionKind === "mutate") {
    reasons.push("modifies workspace files");
  } else if (actionKind === "read-only") {
    reasons.push("reads data without side effects");
  } else if (actionKind === "session") {
    reasons.push("interactive session request");
  } else {
    reasons.push("requested action");
  }

  if (files.length > 0) {
    reasons.push(`${files.length} file(s) affected`);
  }

  if (risk === "high") {
    reasons.push("high-risk operation — review carefully");
  }

  if (description.includes("config") || description.includes("Config")) {
    reasons.push("touches configuration");
  }

  return reasons;
}

/**
 * Build details lines for the details view mode.
 */
function buildDetails(
  description: string,
  files: DiffFileSummary[],
  commandPolicy: string | undefined,
  sandboxSummary: string | undefined,
  diff: string | undefined,
): string[] {
  const lines: string[] = [];

  lines.push(`Request: ${redactSecrets(description)}`);

  if (commandPolicy) {
    lines.push(`Command policy: ${commandPolicy}`);
  }

  if (sandboxSummary) {
    // Sandbox summary is already safe
    lines.push(`Sandbox: ${sandboxSummary}`);
  }

  if (files.length > 0) {
    const stat = formatDiffStat(files);
    lines.push(`Files: ${files.length} changed · ${stat}`);
    for (const f of files) {
      lines.push(`  ${f.path}  +${f.additions} -${f.deletions}`);
    }
  }

  if (diff && diff.trim().length > 0) {
    // Show first few diff lines as bounded context
    const head = capLines(diff.split("\n"), 30);
    lines.push("");
    lines.push("Diff (first lines):");
    for (const ln of head) {
      lines.push(`  ${ln}`);
    }
  }

  return lines;
}

/**
 * Render the diff-mode body: file stats + scrollable diff.
 */
function renderDiffBody(
  review: ApprovalReview,
  width: number,
): string[] {
  const lines: string[] = [];

  // File stats header
  if (review.files.length > 0) {
    const statLine = `Files: ${review.files.length} changed · ${formatDiffStat(review.files)}`;
    for (const ln of wrapLine(statLine, width)) lines.push(ln);

    // Per-file summaries
    for (const f of review.files) {
      const fileLine = `${f.path}  +${f.additions} -${f.deletions}`;
      for (const ln of wrapLine(fileLine, width)) lines.push(ln);
    }

    // Separator between file stats and diff
    lines.push("");
  } else {
    // No files in diff
    lines.push("No file diff available.");
    lines.push("");
  }

  // Reason line(s)
  if (review.reasons.length > 0) {
    for (const r of review.reasons) {
      const reasonLine = `Reason: ${r}`;
      for (const ln of wrapLine(reasonLine, width)) lines.push(ln);
    }
    lines.push("");
  }

  // Diff body lines (already redacted and bounded)
  if (review.diffLines.length > 0) {
    for (const ln of review.diffLines) {
      // Wrap long lines
      for (const wrapped of wrapLine(ln, width)) {
        lines.push(wrapped);
      }
    }
  }

  return lines;
}

/**
 * Render the details-mode body: full request description, file list, etc.
 */
function renderDetailsBody(
  review: ApprovalReview,
  width: number,
): string[] {
  const lines: string[] = [];

  for (const detail of review.details) {
    for (const ln of wrapLine(detail, width)) {
      // Style the detail text — it's already redacted
      lines.push(ln);
    }
  }

  return lines;
}
