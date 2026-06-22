/**
 * Phase 10A.19 — Transcript Presenter
 *
 * Pure presentation layer that converts TranscriptBlock[] into PresentedBlock[]
 * with role headers, spacing, compact card rendering, expansion preview, and
 * selected-card styling.
 *
 * Keeps minimalRenderer.ts clean by hosting all visual formatting logic here.
 * Pure module: no I/O, no terminal interaction, no side effects.
 */

import type { TranscriptBlock } from "./transcript.js";
import { buildBlockPreview } from "./blockPreview.js";
import { truncate } from "./minimalRenderer.js";
import type { StyleTokens } from "./styleTokens.js";
import { renderEmptyState } from "./emptyState.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface PresentedBlock {
  id: string;
  lines: string[];
  focusable: boolean;
}

export interface PresentTranscriptInput {
  blocks: readonly TranscriptBlock[];
  width: number;
  selectedId?: string;
  tokens: StyleTokens;
  /** When true and blocks is empty, render an empty-state greeting instead. */
  emptyState?: boolean;
}

// ── Block kind helpers ───────────────────────────────────────────────────────

const MAJOR_KINDS = new Set(["user", "assistant"]);
function isMajorKind(kind: TranscriptBlock["kind"]): boolean {
  return MAJOR_KINDS.has(kind);
}

// ── presentTranscript ────────────────────────────────────────────────────────

/**
 * Convert transcript blocks into PresentedBlock lines ready for frame rendering.
 *
 * Rules:
 *  - user / assistant blocks get role headers ("You" / "Deepcoder") in bold.
 *  - system / notice / approval blocks get dimmed headers.
 *  - tool / check / worker blocks render as compact one-line cards.
 *  - Expanded cards (block.expanded === true) include bounded preview lines.
 *  - A blank-line spacer is inserted between consecutive major (user/assistant)
 *    blocks.
 *  - The selected block (matching selectedId) gets inverted styling.
 *  - When emptyState is true and there are no blocks, a single PresentedBlock
 *    with the empty-state greeting is returned.
 */
export function presentTranscript(input: PresentTranscriptInput): PresentedBlock[] {
  const { blocks, width, selectedId, tokens } = input;

  // ── Empty state ────────────────────────────────────────────────────────
  if (input.emptyState && blocks.length === 0) {
    const emptyLines = renderEmptyState({
      width,
      height: 20, // generous default; the frame renderer will clip
      tokens,
    });
    if (emptyLines.length > 0) {
      return [{ id: "__empty__", lines: emptyLines, focusable: false }];
    }
    return [];
  }

  const result: PresentedBlock[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const isSelected = block.id === selectedId;
    const prev = i > 0 ? blocks[i - 1] : null;

    // Spacer between consecutive major blocks
    if (prev && isMajorKind(block.kind) && isMajorKind(prev.kind)) {
      result.push({ id: `${block.id}-spacer`, lines: [""], focusable: false });
    }

    result.push(presentBlock(block, width, tokens, isSelected));
  }

  return result;
}

// ── Block presentation ───────────────────────────────────────────────────────

function presentBlock(
  block: TranscriptBlock,
  width: number,
  tokens: StyleTokens,
  isSelected: boolean,
): PresentedBlock {
  switch (block.kind) {
    case "user":
      return presentUserBlock(block, width, tokens, isSelected);
    case "assistant":
      return presentAssistantBlock(block, width, tokens, isSelected);
    case "system":
    case "notice":
    case "approval":
      return presentSecondaryBlock(block, width, tokens, isSelected);
    case "tool":
    case "check":
    case "worker":
      return presentCardBlock(block, width, tokens, isSelected);
    default:
      return {
        id: block.id,
        lines: [truncate(`[${block.kind}] ${block.body}`, width)],
        focusable: false,
      };
  }
}

// ── User block ───────────────────────────────────────────────────────────────

function presentUserBlock(
  block: TranscriptBlock,
  width: number,
  tokens: StyleTokens,
  isSelected: boolean,
): PresentedBlock {
  const lines: string[] = [];

  const header = isSelected
    ? tokens.state.selected(tokens.role.user("You"))
    : tokens.role.user("You");
  lines.push(truncate(header, width));

  for (const bodyLine of block.body.split("\n")) {
    const styled = isSelected
      ? tokens.state.selected(`  ${bodyLine}`)
      : `  ${bodyLine}`;
    lines.push(truncate(styled, width));
  }

  return { id: block.id, lines, focusable: false };
}

// ── Assistant block ──────────────────────────────────────────────────────────

function presentAssistantBlock(
  block: TranscriptBlock,
  width: number,
  tokens: StyleTokens,
  isSelected: boolean,
): PresentedBlock {
  const lines: string[] = [];

  const header = isSelected
    ? tokens.state.selected(tokens.role.assistant("Deepcoder"))
    : tokens.role.assistant("Deepcoder");
  lines.push(truncate(header, width));

  for (const bodyLine of block.body.split("\n")) {
    const styled = isSelected
      ? tokens.state.selected(`  ${bodyLine}`)
      : `  ${bodyLine}`;
    lines.push(truncate(styled, width));
  }

  return { id: block.id, lines, focusable: false };
}

// ── Secondary/System block ───────────────────────────────────────────────────

function presentSecondaryBlock(
  block: TranscriptBlock,
  width: number,
  tokens: StyleTokens,
  isSelected: boolean,
): PresentedBlock {
  const label = block.kind === "system"
    ? "System"
    : block.kind === "notice"
      ? "Notice"
      : "Approval";
  const lines: string[] = [];

  const header = isSelected
    ? tokens.state.selected(tokens.role.system(label))
    : tokens.role.system(label);
  lines.push(truncate(header, width));

  for (const bodyLine of block.body.split("\n")) {
    const styled = isSelected
      ? tokens.state.selected(tokens.role.system(`  ${bodyLine}`))
      : tokens.role.system(`  ${bodyLine}`);
    lines.push(truncate(styled, width));
  }

  return { id: block.id, lines, focusable: false };
}

// ── Card block (tool / check / worker) ───────────────────────────────────────

function presentCardBlock(
  block: TranscriptBlock,
  width: number,
  tokens: StyleTokens,
  isSelected: boolean,
): PresentedBlock {
  const preview = buildBlockPreview(block);
  const lines: string[] = [];

  // ── Compact card header line ──────────────────────────────────────────
  let cardLine = "";

  // Prefix icon
  if (block.kind === "check") {
    if (preview.status === "success") {
      cardLine += tokens.state.success(tokens.chrome.checkPass);
    } else if (preview.status === "error") {
      cardLine += tokens.state.error(tokens.chrome.checkFail);
    } else {
      cardLine += tokens.chrome.bulletCollapsed;
    }
  } else {
    cardLine += block.expanded
      ? tokens.chrome.bulletExpanded
      : tokens.chrome.bulletCollapsed;
  }

  cardLine += " ";

  // Title — block.kind is tool|check|worker at this call site
  const roleKind = block.kind as "tool" | "check" | "worker";
  cardLine += tokens.role[roleKind](preview.title);

  // Summary
  if (preview.summary) {
    cardLine += ` · ${preview.summary}`;
  }

  // Apply state styling to the whole card line
  let styledCard: string;
  if (isSelected) {
    styledCard = tokens.state.selected(cardLine);
  } else if (preview.status === "running") {
    styledCard = tokens.state.running(cardLine);
  } else if (preview.status === "error") {
    styledCard = tokens.state.error(cardLine);
  } else if (preview.status === "success") {
    styledCard = tokens.state.success(cardLine);
  } else {
    styledCard = tokens.state.muted(cardLine);
  }

  lines.push(truncate(styledCard, width));

  // ── Expanded preview lines ───────────────────────────────────────────
  if (block.expanded && preview.previewLines.length > 0) {
    for (const pl of preview.previewLines) {
      lines.push(truncate(`  ${pl}`, width));
    }

    // Truncated hint for large error output
    if (preview.truncated && preview.status === "error") {
      lines.push(
        truncate(
          tokens.state.muted("  ... full log available · y copy · s save"),
          width,
        ),
      );
    }
  }

  return { id: block.id, lines, focusable: true };
}
