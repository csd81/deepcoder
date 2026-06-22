/**
 * Phase 10A.12 — Transcript Markdown formatter and focused-block lookup.
 *
 * Pure functions: no I/O, no terminal, no process, no network.
 *
 * - formatTranscriptBlockMarkdown converts a single block to Markdown.
 * - formatTranscriptMarkdown converts the full transcript to Markdown.
 * - selectedBlock looks up the focused block from a TranscriptState.
 */

import { redactSecrets } from "../workspace/redact.js";
import type { TranscriptBlock, TranscriptState } from "./transcript.js";

// ── Options ───────────────────────────────────────────────────────────────────

export interface TranscriptExportOptions {
  includeTimestamps?: boolean;
  includeMetadata?: boolean;
  maxBlockChars?: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_MAX_BLOCK_CHARS = 50_000;

// ── Block kinds that render as fenced code blocks ────────────────────────────

const FENCED_KINDS = new Set(["tool", "check", "worker", "approval"]);

// ── formatTranscriptBlockMarkdown ─────────────────────────────────────────────

/**
 * Format a single transcript block as Markdown.
 *
 * - assistant/user bodies are rendered inline (plain Markdown).
 * - tool/check/worker/approval bodies are rendered inside a fenced code block.
 * - All bodies are redacted via redactSecrets.
 * - Bodies exceeding `opts.maxBlockChars` (default 50_000) are truncated and
 *   marked with a "*(truncated)*" notice.
 * - Never throws on malformed/empty block fields.
 */
export function formatTranscriptBlockMarkdown(
  block: TranscriptBlock,
  opts?: TranscriptExportOptions,
): string {
  const maxChars = opts?.maxBlockChars ?? DEFAULT_MAX_BLOCK_CHARS;
  const header = blockHeader(block, opts);
  const body = redactSecrets(block.body ?? "");
  const truncated = body.length > maxChars;
  const displayBody = truncated ? body.slice(0, maxChars) : body;

  if (FENCED_KINDS.has(block.kind)) {
    const lines: string[] = [header, "", "```text", displayBody];
    if (truncated) lines.push("```", "", "*(truncated)*");
    else lines.push("```");
    return lines.join("\n");
  }

  // assistant/user — inline Markdown body
  const lines: string[] = [header, "", displayBody];
  if (truncated) lines.push("", "*(truncated)*");
  return lines.join("\n");
}

// ── formatTranscriptMarkdown ──────────────────────────────────────────────────

/**
 * Format the full transcript as a Markdown document.
 *
 * Each block is rendered in order (oldest first) with a level-2 heading.
 * Empty transcripts return an empty string.
 * Never throws.
 */
export function formatTranscriptMarkdown(
  blocks: readonly TranscriptBlock[],
  opts?: TranscriptExportOptions,
): string {
  if (!blocks || blocks.length === 0) return "";

  return blocks
    .map((b) => formatTranscriptBlockMarkdown(b, opts))
    .join("\n\n");
}

// ── selectedBlock ─────────────────────────────────────────────────────────────

/**
 * Look up the currently focused block in the transcript state by
 * `selectedBlockId`. Returns `null` when no block is focused or the id is
 * stale.
 */
export function selectedBlock(state: TranscriptState): TranscriptBlock | null {
  if (state.selectedBlockId == null) return null;
  return state.blocks.find((b) => b.id === state.selectedBlockId) ?? null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a level-2 heading for a block.
 *
 * Format: `## <kind>` optionally followed by a title.
 *
 * When includeTimestamps is true and startedAt is non-empty, appends
 * ` (started at <startedAt>)`.
 */
function blockHeader(
  block: TranscriptBlock,
  opts?: TranscriptExportOptions,
): string {
  const label = block.title ? `${block.kind}: ${block.title}` : block.kind;
  let header = `## ${label}`;

  if (opts?.includeTimestamps && block.startedAt) {
    header += ` (started at ${block.startedAt})`;
  }

  return header;
}
