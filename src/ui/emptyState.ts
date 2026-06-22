/**
 * Phase 10A.19 — Empty State Renderer
 *
 * Renders a compact, useful empty state when the transcript has no meaningful
 * conversation yet. Shows suggested slash commands — no marketing, no ASCII art,
 * no provider-specific text.
 *
 * Pure module: no I/O, no terminal interaction.
 */

import type { StyleTokens } from "./styleTokens.js";
import { truncate } from "./minimalRenderer.js";

// ── Default commands ─────────────────────────────────────────────────────────

const SUGGESTED_COMMANDS: { command: string; description: string }[] = [
  { command: "/doctor", description: "check local setup" },
  { command: "/model", description: "inspect model routing" },
  { command: "/permissions", description: "inspect safety posture" },
  { command: "/delegate", description: "split work into workers" },
  { command: "/help", description: "show all commands" },
];

// ── renderEmptyState ─────────────────────────────────────────────────────────

/**
 * Render a bounded empty state for the TUI transcript.
 *
 * Returns a string array with:
 *  - A "Deepcoder" header (styled via tokens.role.assistant)
 *  - A short instructional line
 *  - A "Common:" section with suggested slash commands
 *
 * The output is bounded to `opts.height` rows; if height is insufficient the
 * output is trimmed from the bottom.  Every line is width-truncated to
 * `opts.width` using the same `truncate` helper as the frame renderer.
 *
 * No marketing copy, no large hero layout, no ASCII art.
 */
export function renderEmptyState(opts: {
  width: number;
  height: number;
  tokens: StyleTokens;
}): string[] {
  const { width, height, tokens } = opts;

  // Minimum height guard — at least the header + one command
  if (height < 2) return [];

  const lines: string[] = [];

  // ── Header ──────────────────────────────────────────────────────────────
  const header = tokens.role.assistant("Deepcoder");
  lines.push(header);
  lines.push("");

  // ── Instructional text ──────────────────────────────────────────────────
  lines.push("  Start with a task, or type / for commands.");
  lines.push("");

  // ── Command suggestions ─────────────────────────────────────────────────
  lines.push("  Common:");
  for (const { command, description } of SUGGESTED_COMMANDS) {
    const padded = `${command.padEnd(16)}${description}`;
    lines.push(`  ${tokens.state.muted(padded)}`);
  }

  // Bounded to height — trim from the bottom (keep the header)
  const bounded = lines.slice(0, Math.max(height, 2));

  // Width-truncate every line
  return bounded.map((line) => truncate(line, width));
}
