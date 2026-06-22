/**
 * Phase 10O — Copy target types, parsing, and extraction.
 *
 * Pure functions for parsing /copy arguments and extracting text from
 * session messages. Never throws. All extracted text is bounded and
 * redacted before being returned (callers must still apply redactSecrets
 * before copy/print to ensure defence in depth).
 */

import type { AgentMessage } from "../providers/types.js";
import { redactSecrets } from "../workspace/redact.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type CopyTarget =
  | { kind: "last" }
  | { kind: "code" }
  | { kind: "diff" }
  | { kind: "goal" }
  | { kind: "plan" }
  | { kind: "check"; runId: string }
  | { kind: "worker"; planId: string; workerId: string; part: "patch" | "log" | "review" };

export interface CopyPayload {
  label: string;
  text: string;
  bytes: number;
  truncated: boolean;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/** Hard cap on payload text before truncation. Prevents OOM on huge output. */
export const COPY_PAYLOAD_MAX_BYTES = 256 * 1024;

/* ------------------------------------------------------------------ */
/*  Parser                                                             */
/* ------------------------------------------------------------------ */

/**
 * Parse the argument string after `/copy`.
 *
 * Acceptable forms:
 *   ""             → last
 *   "last"         → last
 *   "code"         → code
 *   "diff"         → diff
 *   "goal"         → goal
 *   "plan"         → plan
 *   "check <id>"   → check
 *   "worker <plan-id> <worker-id> [patch|log|review]"  → worker
 *   "--print <target>" → any of the above with printOnly=true
 */
export function parseCopyArgs(
  arg: string,
): { ok: true; target: CopyTarget; printOnly: boolean } | { ok: false; error: string } {
  const trimmed = arg.trim();
  const tokens = trimmed.split(/\s+/).filter(Boolean);

  let printOnly = false;
  let remaining = tokens;

  // Consume optional --print prefix
  if (tokens.length > 0 && tokens[0] === "--print") {
    printOnly = true;
    remaining = tokens.slice(1);
  }

  const cmd = remaining[0];

  // No subcommand or "last"
  if (!cmd || cmd === "last") {
    return { ok: true, target: { kind: "last" }, printOnly };
  }

  if (cmd === "code") {
    return { ok: true, target: { kind: "code" }, printOnly };
  }

  if (cmd === "diff") {
    return { ok: true, target: { kind: "diff" }, printOnly };
  }

  if (cmd === "goal") {
    return { ok: true, target: { kind: "goal" }, printOnly };
  }

  if (cmd === "plan") {
    return { ok: true, target: { kind: "plan" }, printOnly };
  }

  if (cmd === "check") {
    const runId = remaining[1];
    if (!runId) {
      return { ok: false, error: "usage: /copy check <run-id>" };
    }
    return { ok: true, target: { kind: "check", runId }, printOnly };
  }

  if (cmd === "worker") {
    const planId = remaining[1];
    const workerId = remaining[2];
    const rawPart = remaining[3] || "patch";
    if (!planId || !workerId) {
      return { ok: false, error: "usage: /copy worker <plan-id> <worker-id> [patch|log|review]" };
    }
    if (rawPart !== "patch" && rawPart !== "log" && rawPart !== "review") {
      return { ok: false, error: "usage: /copy worker <plan-id> <worker-id> [patch|log|review]" };
    }
    return { ok: true, target: { kind: "worker", planId, workerId, part: rawPart as "patch" | "log" | "review" }, printOnly };
  }

  return {
    ok: false,
    error: "usage: /copy [last|code|diff|goal|plan|check <id>|worker <plan> <worker> [patch|log|review]]",
  };
}

/* ------------------------------------------------------------------ */
/*  Extraction helpers                                                 */
/* ------------------------------------------------------------------ */

/**
 * Build a CopyPayload from raw text. Applies redaction and bounding.
 * Never throws.
 */
function buildPayload(label: string, text: string): CopyPayload {
  const redacted = redactSecrets(text);
  const bytes = Buffer.byteLength(redacted, "utf8");
  if (bytes <= COPY_PAYLOAD_MAX_BYTES) {
    return { label, text: redacted, bytes, truncated: false };
  }
  const truncated = Buffer.from(redacted, "utf8").subarray(0, COPY_PAYLOAD_MAX_BYTES).toString("utf8");
  return {
    label,
    text: truncated + "\n... (truncated)",
    bytes: COPY_PAYLOAD_MAX_BYTES,
    truncated: true,
  };
}

/**
 * Find the latest assistant message with non-empty text content.
 * Returns null when no such message exists.
 */
export function extractLatestAssistant(messages: AgentMessage[]): CopyPayload | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && msg.role === "assistant" && msg.content && msg.content.trim().length > 0) {
      return buildPayload("latest assistant response", msg.content);
    }
  }
  return null;
}

/**
 * Find the last fenced code block (``` … ```) in assistant messages.
 * Returns null when no fenced block is found.
 *
 * The parser is simple and bounded:
 * - scans backwards for the last opening ``` fence that has a matching close
 * - captures the content between (optionally with a language tag on the first line)
 * - unclosed fences are bounded and handled safely
 */
export function extractLatestCodeBlock(messages: AgentMessage[]): CopyPayload | null {
  // Collect all assistant message texts in order
  const texts: string[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.content) {
      texts.push(msg.content);
    }
  }

  // Scan backwards for the last fenced block
  for (let i = texts.length - 1; i >= 0; i--) {
    const content = texts[i]!;
    const result = findLastFencedBlock(content);
    if (result) return result;
  }

  return null;
}

/**
 * Find the last fenced code block in a single text string.
 * Returns null when no fenced block is found.
 * Never throws.
 */
function findLastFencedBlock(text: string): CopyPayload | null {
  // Find all fence positions
  const fences: number[] = [];
  let pos = 0;
  while (pos < text.length) {
    const idx = text.indexOf("```", pos);
    if (idx === -1) break;
    fences.push(idx);
    pos = idx + 3;
  }

  // Need at least 2 fences for a complete block, or 1 for an unclosed block
  if (fences.length === 0) return null;

  // Work backwards: for each opening fence candidate, check if it has a matching close
  for (let i = fences.length - 1; i >= 0; i--) {
    const openIdx = fences[i]!;
    const afterOpen = openIdx + 3;

    // Check if this is an opening fence (has content after ``` on the same line)
    const restAfter = text.slice(afterOpen);
    const nlIdx = restAfter.indexOf("\n");
    const firstLine = nlIdx === -1 ? restAfter : restAfter.slice(0, nlIdx);

    if (firstLine.trim().length === 0) {
      // Closing fence or empty fence — skip
      continue;
    }

    // This is an opening fence with a language tag
    const lang = firstLine.trim();
    const codeStart = nlIdx === -1 ? undefined : afterOpen + nlIdx + 1;

    if (nlIdx === -1) {
      // ``` at end of string with just a lang tag and no newline — no code
      continue;
    }

    // Look for a matching closing fence after codeStart
    const closeIdx = text.indexOf("```", codeStart);
    if (closeIdx !== -1) {
      const codeText = text.slice(codeStart, closeIdx).trimEnd();
      if (codeText.length > 0) {
        const label = lang ? `latest code block: ${lang}` : "latest code block";
        return buildPayload(label, codeText);
      }
      // Empty block — continue scanning backwards
      continue;
    }

    // Unclosed fence — use everything after the language tag line
    const codeText = text.slice(codeStart).trimEnd();
    if (codeText.length > 0) {
      const label = lang ? `latest code block: ${lang}` : "latest code block";
      return buildPayload(label, codeText);
    }
  }

  return null;
}
