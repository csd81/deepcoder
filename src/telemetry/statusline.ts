/**
 * Phase 10C — one-line status line renderer.
 *
 * Produces a single-line (no newlines) status string bounded to a byte cap.
 * Degrades gracefully when a field is absent. REDACTED — no secrets.
 * Omits cost when pricingKnown is false (shows tokens only).
 */

import type { StatusSnapshot } from "./statusSnapshot.js";
import { redactSecrets } from "../workspace/redact.js";

export interface RenderStatuslineOptions {
  /** Maximum byte length for the output (default 200). */
  maxBytes?: number;
}

/**
 * Render a StatusSnapshot into a single-line status string.
 *
 * The output is bounded to `maxBytes` bytes (default 200). If the rendered
 * line exceeds the cap, it is truncated at a field boundary (last space before
 * the cap) and "…" is appended.
 *
 * NEVER includes secrets — all text is run through redactSecrets.
 */
export function renderStatusline(
  snapshot: StatusSnapshot,
  opts?: RenderStatuslineOptions,
): string {
  const maxBytes = opts?.maxBytes ?? 200;
  const parts: string[] = [];

  // Provider/model
  parts.push(`${snapshot.provider}/${snapshot.model}`);

  // Mode
  parts.push(snapshot.mode);

  // Sandbox
  const sb = snapshot.sandbox;
  const net = snapshot.sandboxNetwork === "unknown" ? "" : `/${snapshot.sandboxNetwork}`;
  parts.push(`${sb}${net}`);

  // Workspace isolation
  parts.push(`iso ${snapshot.workspaceIsolation}`);

  // Git
  if (snapshot.git) {
    const g = snapshot.git;
    const dirty = g.dirtyFiles !== undefined ? `+${g.dirtyFiles}` : "";
    const ahead = g.ahead !== undefined ? ` ↑${g.ahead}` : "";
    const behind = g.behind !== undefined ? ` ↓${g.behind}` : "";
    const branch = g.branch ? ` ${g.branch}` : "";
    parts.push(`git${branch}${dirty}${ahead}${behind}`);
  }

  // Tokens
  const tokTotal = snapshot.usage.totalTokens;
  const tokStr = tokTotal >= 1000 ? `${(tokTotal / 1000).toFixed(1)}k` : String(tokTotal);
  parts.push(`tok ${tokStr}`);

  // Cost — only when pricingKnown is true
  if (snapshot.cost?.pricingKnown && snapshot.cost.totalUsd > 0) {
    parts.push(`~$${snapshot.cost.totalUsd.toFixed(4)}`);
  }

  // Context percent
  if (snapshot.contextPercent !== undefined) {
    parts.push(`ctx ${snapshot.contextPercent}%`);
  }

  // Active check
  if (snapshot.activeCheck) {
    parts.push(`check ${snapshot.activeCheck}`);
  }

  // Active solve attempt
  if (snapshot.activeSolveAttempt) {
    parts.push(`solve ${snapshot.activeSolveAttempt.index}/${snapshot.activeSolveAttempt.max}`);
  }

  // MCP warnings
  if (snapshot.mcpWarnings > 0) {
    parts.push(`mcp!${snapshot.mcpWarnings}`);
  }

  // Active skills
  if (snapshot.activeSkills > 0) {
    parts.push(`skills:${snapshot.activeSkills}`);
  }

  // Warnings
  if (snapshot.warnings.length > 0) {
    parts.push(`⚠${snapshot.warnings.length}`);
  }

  let line = parts.join(" · ");

  // Redact any secrets that may have leaked through
  line = redactSecrets(line);

  // Enforce the byte cap STRICTLY (multi-byte separators/ellipsis are counted).
  if (Buffer.byteLength(line, "utf8") > maxBytes) {
    const suffix = "…";
    if (maxBytes < Buffer.byteLength(suffix, "utf8")) {
      // Degenerate cap: drop chars until the bare line fits.
      while (Buffer.byteLength(line, "utf8") > maxBytes && line.length > 0) line = line.slice(0, -1);
    } else {
      // Drop trailing chars (whole codepoints) until line + suffix fits in bytes.
      let s = line;
      while (Buffer.byteLength(s + suffix, "utf8") > maxBytes && s.length > 0) s = s.slice(0, -1);
      const cut = s.lastIndexOf(" "); // prefer a field boundary
      if (cut > 0) s = s.slice(0, cut);
      line = s.trimEnd() + suffix;
    }
  }

  return line;
}
