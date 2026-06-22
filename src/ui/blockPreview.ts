/**
 * Phase 10A.16 — Block Preview Core
 *
 * Pure, deterministic preview builder for collapsible transcript blocks (tool,
 * check, worker).  Converts a TranscriptBlock into a compact BlockPreview that
 * rendering code can display as a card with a status icon, summary line, and a
 * bounded set of preview lines.
 *
 * Rules:
 *  - Never throws on empty/malformed block data.
 *  - Redacts secrets before returning any text from the body.
 *  - Line-count based summary.
 *  - Caps preview lines and chars.
 *  - Preserves original block body in transcript; preview is render-only.
 */
import type { TranscriptBlock } from "./transcript.js";
import { redactSecrets } from "../workspace/redact.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface BlockPreview {
  title: string;
  status?: "running" | "success" | "error" | "neutral";
  summary: string;
  previewLines: string[];
  lineCount: number;
  truncated: boolean;
}

export interface BlockPreviewOptions {
  maxPreviewLines?: number;
  maxPreviewChars?: number;
}

// ── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_OPTIONS: Required<BlockPreviewOptions> = {
  maxPreviewLines: 3,
  maxPreviewChars: 200,
};

// ── Failure-line patterns ───────────────────────────────────────────────────

const FAILURE_PATTERNS = [
  /FAILED/,
  /Error:/,
  /Traceback/,
  /not ok/,
  /AssertionError/,
];

function isFailureLine(line: string): boolean {
  return FAILURE_PATTERNS.some((p) => p.test(line));
}

function isBlankOrBoilerplate(line: string): boolean {
  const t = line.trim();
  return t === "" || t === "---" || t === "...";
}

function countLines(body: string): number {
  if (body === "") return 0;
  return body.split("\n").length;
}

function getLastNonEmptyLine(body: string): string {
  const lines = body.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== "") return lines[i];
  }
  return "";
}

// ── Summary heuristics ─────────────────────────────────────────────────────

/**
 * For tool blocks: "<N> lines", or "<N> matches" if the output looks like
 * search/grep results, or the first error prefix line on error.
 */
function buildToolSummary(block: TranscriptBlock): string {
  const n = countLines(block.body);
  if (n === 0) return "0 lines";

  if (block.isError) {
    // Try to surface the first failure-looking line
    for (const line of block.body.split("\n")) {
      const trimmed = line.trim();
      if (isFailureLine(trimmed)) {
        return redactSecrets(trimmed).slice(0, 120);
      }
    }
    return "error";
  }

  // Heuristic: output that looks like grep/rg results with file:line matches
  if (
    block.title &&
    /grep|rg|search/i.test(block.title) &&
    block.body.split("\n").some((l) => /^[^:]+:\d+:/.test(l))
  ) {
    const matchCount = block.body
      .split("\n")
      .filter((l) => /^[^:]+:\d+:/.test(l)).length;
    return `${matchCount} matches`;
  }

  return `${n} lines`;
}

/**
 * For check blocks: try to extract test pass/fail info from the body,
 * otherwise fall back to line count.  On error, prefer the first
 * failure-looking line.
 */
function buildCheckSummary(block: TranscriptBlock): string {
  const n = countLines(block.body);
  if (n === 0) return "0 lines";

  const lines = block.body.split("\n");

  // Try to extract test pass/fail counters
  let passed = 0;
  let failed = 0;
  let tests = 0;

  for (const line of lines) {
    const pm = line.match(/(\d+)\s+passed/);
    if (pm) passed = Math.max(passed, parseInt(pm[1], 10));
    const fm = line.match(/(\d+)\s+fail/);
    if (fm) failed = Math.max(failed, parseInt(fm[1], 10));
    const tm = line.match(/tests[:\s]+(\d+)/i);
    if (tm) tests = Math.max(tests, parseInt(tm[1], 10));
  }

  if (tests > 0 || passed > 0 || failed > 0) {
    const parts: string[] = [];
    if (passed > 0) parts.push(`${passed} passed`);
    if (failed > 0) parts.push(`${failed} failed`);
    if (tests > 0 && parts.length === 0) parts.push(`${tests} tests`);
    return parts.join(", ");
  }

  if (block.isError) {
    for (const line of lines) {
      const trimmed = line.trim();
      if (isFailureLine(trimmed)) {
        return redactSecrets(trimmed).slice(0, 120);
      }
    }
  }

  return `${n} lines`;
}

/**
 * For worker blocks: use the body's last non-empty line as the summary.
 * Detect common phrases like "solved in N attempt", "changed files",
 * "gate green".
 */
function buildWorkerSummary(block: TranscriptBlock): string {
  if (!block.body) return "";
  const last = getLastNonEmptyLine(block.body);
  const redacted = redactSecrets(last);
  // Keep it short but meaningful — cap at 120 chars
  return redacted.slice(0, 120);
}

// ── Preview lines extraction ───────────────────────────────────────────────

function extractPreviewLines(
  body: string,
  status: BlockPreview["status"],
  maxLines: number,
  maxChars: number,
): { previewLines: string[]; truncated: boolean } {
  if (!body) return { previewLines: [], truncated: false };

  const allLines = body.split("\n");
  const resultLines: string[] = [];

  // For errors, pull failure-looking lines first
  if (status === "error") {
    for (const line of allLines) {
      if (resultLines.length >= maxLines) break;
      const trimmed = line.trim();
      if (!trimmed || isBlankOrBoilerplate(trimmed)) continue;
      if (isFailureLine(trimmed)) {
        resultLines.push(redactSecrets(trimmed).slice(0, maxChars));
      }
    }
  }

  // Fill remaining slots with first non-blank, non-boilerplate lines
  if (resultLines.length < maxLines) {
    for (const line of allLines) {
      if (resultLines.length >= maxLines) break;
      const trimmed = line.trim();
      if (!trimmed || isBlankOrBoilerplate(trimmed)) continue;
      const redacted = redactSecrets(trimmed).slice(0, maxChars);
      if (!resultLines.includes(redacted)) {
        resultLines.push(redacted);
      }
    }
  }

  const truncated = resultLines.length < allLines.length;

  return { previewLines: resultLines, truncated };
}

// ── Status helpers ─────────────────────────────────────────────────────────

function toolStatus(block: TranscriptBlock): BlockPreview["status"] {
  if (block.finishedAt === undefined && block.body === "") return "running";
  if (block.isError) return "error";
  return "neutral";
}

function checkStatus(block: TranscriptBlock): BlockPreview["status"] {
  if (block.finishedAt === undefined) return "running";
  if (block.isError) return "error";
  return "success";
}

function workerStatus(block: TranscriptBlock): BlockPreview["status"] {
  if (block.finishedAt === undefined) return "running";
  if (block.isError) return "error";
  return "success";
}

// ── Title helpers ──────────────────────────────────────────────────────────

function blockTitle(block: TranscriptBlock): string {
  switch (block.kind) {
    case "tool":
      return `tool ${block.title ?? ""}`;
    case "check":
      return `check ${block.title ?? block.refId ?? ""}`;
    case "worker":
      return `worker ${block.title ?? block.refId ?? ""}`;
    default:
      return block.title ?? block.kind;
  }
}

// ── Main export ────────────────────────────────────────────────────────────

export function buildBlockPreview(
  block: TranscriptBlock,
  opts?: BlockPreviewOptions,
): BlockPreview {
  const { maxPreviewLines, maxPreviewChars } = {
    ...DEFAULT_OPTIONS,
    ...opts,
  };

  // Determine status per kind
  let status: BlockPreview["status"] | undefined;
  switch (block.kind) {
    case "tool":
      status = toolStatus(block);
      break;
    case "check":
      status = checkStatus(block);
      break;
    case "worker":
      status = workerStatus(block);
      break;
    // other kinds → neutral (or undefined)
  }

  // Build summary per kind
  let summary: string;
  switch (block.kind) {
    case "tool":
      summary = buildToolSummary(block);
      break;
    case "check":
      summary = buildCheckSummary(block);
      break;
    case "worker":
      summary = buildWorkerSummary(block);
      break;
    default:
      summary = `${countLines(block.body)} lines`;
  }

  // Extract capped preview lines
  const { previewLines, truncated } = extractPreviewLines(
    block.body,
    status,
    maxPreviewLines,
    maxPreviewChars,
  );

  return {
    title: blockTitle(block),
    status,
    summary,
    previewLines,
    lineCount: countLines(block.body),
    truncated,
  };
}
