/**
 * Pure session-sharing formatter.
 *
 * Renders the current session as a self-contained Markdown document with
 * metadata, role-labelled messages, tool calls/results, and a summary
 * footer. Secrets may be redacted via the existing `redactSecrets` utility.
 *
 * No I/O, no terminal access — pure string transformation.
 */

import type { AgentMessage } from "../providers/types.js";
import { redactSecrets } from "../workspace/redact.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ShareSession {
  id: string;
  title?: string;
  model: string;
  provider?: string;
  createdAt: string;
  messages: AgentMessage[];
  telemetry?: { totalTokens?: number; costUsd?: number };
}

export interface ShareOptions {
  title?: string;
  sanitize?: boolean;
  maxContentBytes?: number; // per-message cap, default 50_000
}

// ── Formatter ───────────────────────────────────────────────────────────────────

/**
 * Format a session as a portable, human-readable Markdown document.
 *
 * The output is self-contained (no deepcoder-specific formatting) and renders
 * cleanly on GitHub, in a Markdown viewer, or in a terminal.
 *
 * @param session - The session data to format.
 * @param opts    - Optional formatting controls (sanitize, truncation limit).
 * @returns The formatted Markdown string.
 */
export function formatSessionShare(
  session: ShareSession,
  opts?: ShareOptions,
): string {
  const lines: string[] = [];
  const maxBytes = opts?.maxContentBytes ?? 50_000;

  // ── Header ──────────────────────────────────────────────────────────────
  lines.push(`# Session: ${session.title ?? session.id}`);
  lines.push(``);
  lines.push(`- **Model:** ${session.provider ?? "unknown"}/${session.model}`);
  lines.push(`- **Date:** ${session.createdAt.slice(0, 10)}`);
  lines.push(`- **Messages:** ${session.messages.length}`);
  if (opts?.sanitize) lines.push(`- **Sanitized:** secrets redacted`);
  lines.push(``);
  lines.push(`---`);
  lines.push(``);

  // ── Messages ────────────────────────────────────────────────────────────
  for (const msg of session.messages) {
    const role =
      msg.role === "user"
        ? "**User**"
        : msg.role === "assistant"
          ? "**Assistant**"
          : msg.role === "tool"
            ? `**Tool (${msg.name ?? "unknown"})**`
            : `**${msg.role}**`;

    let content = msg.content ?? "";

    if (opts?.sanitize) content = redactSecrets(content);

    if (content.length > maxBytes) {
      content = content.slice(0, maxBytes) + "\n\n*…message truncated*";
    }

    // Tool messages (results) are rendered as collapsed details
    if (msg.role === "tool") {
      lines.push(`<details><summary>Tool result: ${msg.name ?? "tool"}</summary>`);
      lines.push(``);
      lines.push("```");
      lines.push(content);
      lines.push("```");
      lines.push(`</details>`);
      lines.push(``);
      lines.push(`---`);
      lines.push(``);
      continue;
    }

    lines.push(`### ${role}`);
    lines.push(``);

    // List tool calls on assistant messages
    if (msg.toolCalls?.length) {
      lines.push(
        `**Tools called:** ${msg.toolCalls.map((t) => `\`${t.name}\``).join(", ")}`,
      );
      lines.push(``);
    }

    if (content) {
      lines.push(content);
      lines.push(``);
    }

    lines.push(`---`);
    lines.push(``);
  }

  // ── Footer ──────────────────────────────────────────────────────────────
  const tele = session.telemetry;
  if (tele?.totalTokens) lines.push(`**Total tokens:** ${tele.totalTokens}`);
  if (tele?.costUsd) lines.push(`**Estimated cost:** $${tele.costUsd.toFixed(2)}`);
  lines.push(`*Shared from deepcoder · ${new Date().toISOString()}*`);
  lines.push(``);

  return lines.join("\n");
}
