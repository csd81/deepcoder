/**
 * Phase 10A.4 — terminal markdown renderer (pure, no I/O, no deps).
 *
 * Converts a markdown string into styled terminal lines. Supports headings,
 * fenced code blocks (verbatim + dim), unordered/ordered lists, links, and inline
 * emphasis/code — whose MARKERS are physically removed from the text (so with a
 * disabled theme nothing but the words remains). Prose is wrapped to `width`;
 * code lines are preserved verbatim (not wrapped).
 *
 * Inline emphasis is marker-stripped but not separately recolored mid-line (a
 * deliberate v1 limit — partial-line color would break width-accurate wrapping).
 */

import type { Theme } from "./theme.js";
import { wrapLine } from "./textLayout.js";

export interface RenderMarkdownOptions {
  width: number;
  theme: Theme;
}

/** Remove inline markdown markers, keeping the visible text. */
function stripInline(s: string): string {
  return s
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)") // [text](url) -> text (url)
    .replace(/\*\*([^*]+)\*\*/g, "$1") // **bold**
    .replace(/__([^_]+)__/g, "$1") // __bold__
    .replace(/`([^`]+)`/g, "$1") // `code`
    .replace(/\*([^*]+)\*/g, "$1") // *italic*
    .replace(/_([^_]+)_/g, "$1"); // _italic_
}

export function renderMarkdown(md: string, opts: RenderMarkdownOptions): string[] {
  const { width, theme } = opts;
  const out: string[] = [];
  let inCode = false;

  for (const raw of md.split("\n")) {
    const line = raw.replace(/\s+$/, "");

    // Fenced code block toggles — the fence lines themselves are not emitted.
    if (line.trimStart().startsWith("```")) {
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(theme.dim(raw)); // verbatim, distinct style, not wrapped
      continue;
    }
    if (line.trim() === "") {
      out.push("");
      continue;
    }

    // Heading -> whole-line title style, markers stripped.
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      for (const c of wrapLine(stripInline(h[2]), width)) out.push(theme.title(c));
      continue;
    }

    // Unordered list item -> "• " prefix.
    const ul = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (ul) {
      for (const c of wrapLine("• " + stripInline(ul[2]), width)) out.push(c);
      continue;
    }

    // Ordered list item -> keep the number.
    const ol = /^(\s*)(\d+)\.\s+(.*)$/.exec(line);
    if (ol) {
      for (const c of wrapLine(`${ol[2]}. ` + stripInline(ol[3]), width)) out.push(c);
      continue;
    }

    // Prose -> inline markers stripped, wrapped to width.
    for (const c of wrapLine(stripInline(line), width)) out.push(c);
  }

  return out;
}
