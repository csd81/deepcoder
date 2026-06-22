/**
 * Phase 10A.15 — assistant render state (pure, no I/O, no deps beyond existing ui modules).
 *
 * Provides open-fence detection for streaming Markdown, a streaming Markdown renderer
 * that never corrupts code fences, and a top-level `renderAssistantBlock` that
 * selects the right renderer based on finish state.
 *
 * All functions are deterministic: same inputs → same outputs.
 * Never throws on malformed input.
 */

import type { Theme } from "./theme.js";
import type { RenderMarkdownOptions } from "./markdown.js";
import { renderMarkdown } from "./markdown.js";
import { wrapLine } from "./textLayout.js";
import { highlightCode } from "./syntax.js";

// ── Public Types ───────────────────────────────────────────────────────────

export interface AssistantRenderInput {
  body: string;
  finished: boolean;
  width: number;
  theme: Theme;
  modelLabel?: string;
}

export interface AssistantRenderOutput {
  header: string;
  lines: string[];
  inOpenFence: boolean;
  truncated?: boolean;
}

// ── Open-Fence Detection ──────────────────────────────────────────────────

/**
 * Scan a Markdown string and detect whether it ends inside an unclosed fenced
 * code block. Supports both backtick (```) and tilde (~~~) fences.
 *
 * Returns `{ open: true, lang: "ts" }` if the string ends inside a ```ts block,
 * or `{ open: false, lang: "" }` if all fences are closed / none exist.
 */
export function detectOpenFence(markdown: string): { open: boolean; lang: string } {
  let inCode = false;
  let lang = "";
  const lines = markdown.split("\n");
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    const fence = /^\s*(`{3,}|~{3,})\s*([A-Za-z0-9_+#.-]*)\s*$/.exec(line);
    if (fence) {
      if (!inCode) {
        inCode = true;
        lang = fence[2] ?? "";
      } else {
        inCode = false;
        lang = "";
      }
    }
  }
  return { open: inCode, lang };
}

// ── Streaming Markdown Renderer ───────────────────────────────────────────

/**
 * Render a streaming (incomplete) Markdown string into terminal lines.
 *
 * Behaves identically to `renderMarkdown` for prose, headings, lists, and
 * tables, with one critical difference for fenced code blocks:
 *
 *   - Code lines are rendered **as they arrive** — no waiting for a closing fence.
 *   - The raw ``` / ~~~ fence markers are never emitted as visible text.
 *   - If the stream ends inside a code block, a dim "[code block still streaming]"
 *     marker is appended instead of leaving the block visually dangling.
 *   - Indentation within code is preserved.
 *
 * Designed to never corrupt fences: even malformed or partial input produces
 * stable, readable output lines.
 */
export function renderStreamingMarkdown(md: string, opts: RenderMarkdownOptions): string[] {
  const { width, theme } = opts;
  // Whether the theme actually emits color (so syntax highlighting no-ops
  // under a plain / NO_COLOR theme).
  const color = theme.dim("") !== "";
  const out: string[] = [];
  let inCode = false;
  let codeLang = "";

  const lines = md.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/\s+$/, "");

    // Fenced code block toggles: on open we capture the language tag and emit a
    // dim [lang] header; on close we simply stop emitting code lines (the fence
    // line itself is never emitted as visible text).
    const fence = /^\s*(`{3,}|~{3,})\s*([A-Za-z0-9_+#.-]*)\s*$/.exec(line);
    if (fence) {
      if (!inCode) {
        inCode = true;
        codeLang = fence[2] ?? "";
        if (codeLang) out.push(theme.dim(`[${codeLang}]`));
      } else {
        inCode = false;
        codeLang = "";
      }
      continue;
    }

    if (inCode) {
      // Verbatim (indentation preserved, not wrapped) + shallow syntax coloring.
      out.push(highlightCode(raw, codeLang, { color }));
      continue;
    }

    if (line.trim() === "") {
      out.push("");
      continue;
    }

    // GFM table — same approach as renderMarkdown: detect by looking ahead for
    // a delimiter row. During streaming this is safe because the delimiter is
    // written immediately after the header, so if it's present the table is
    // structurally started. Incomplete tables (pipe line without delimiter) fall
    // through to prose rendering, which is harmless.
    if (line.includes("|") && i + 1 < lines.length && isTableDelimiter(lines[i + 1])) {
      const header = splitTableRow(line);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && lines[j].includes("|") && lines[j].trim() !== "") {
        rows.push(splitTableRow(lines[j]));
        j++;
      }
      const ncol = Math.max(header.length, ...rows.map((r) => r.length));
      const widths: number[] = [];
      for (let c = 0; c < ncol; c++) {
        widths[c] = Math.max(header[c]?.length ?? 0, ...rows.map((r) => r[c]?.length ?? 0));
      }
      const fmt = (cells: string[]): string =>
        widths.map((w, c) => (cells[c] ?? "").padEnd(w)).join(" │ ");
      out.push(theme.title(fmt(header)));
      out.push(theme.dim(widths.map((w) => "─".repeat(w)).join("─┼─")));
      for (const r of rows) out.push(fmt(r));
      i = j - 1; // consume the table; loop's i++ advances past the last row
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

  // If the stream ended inside an open code fence, append a dim marker instead
  // of leaving the block visually dangling.
  if (inCode) {
    out.push(theme.dim("[code block still streaming]"));
  }

  return out;
}

// ── Assistant Block Renderer ──────────────────────────────────────────────

const MAX_BODY_CHARS = 100_000;

/**
 * Build a fully styled assistant block for display in the transcript.
 *
 * - Finished assistant messages use the existing `renderMarkdown`.
 * - Streaming (unfinished) assistant messages use `renderStreamingMarkdown`.
 * - Header includes the model label and streaming state when appropriate.
 * - Body is bounded to MAX_BODY_CHARS to prevent rendering explosion.
 * - Never throws on malformed input.
 */
export function renderAssistantBlock(input: AssistantRenderInput): AssistantRenderOutput {
  const { finished, width, theme, modelLabel } = input;

  // Build header: "assistant · deepseek/deepseek-v4-flash · streaming..."
  let header: string;
  if (modelLabel) {
    header = finished
      ? `assistant · ${modelLabel}`
      : `assistant · ${modelLabel} · streaming...`;
  } else {
    header = "assistant";
  }

  // Cap body to prevent rendering explosion from pathological input.
  const truncated = input.body.length > MAX_BODY_CHARS;
  const body = truncated ? input.body.slice(0, MAX_BODY_CHARS) : input.body;

  const opts: RenderMarkdownOptions = { width, theme };
  const lines = finished ? renderMarkdown(body, opts) : renderStreamingMarkdown(body, opts);

  const inOpenFence = detectOpenFence(body).open;

  return { header, lines, inOpenFence, truncated: truncated || undefined };
}

// ── Private Helpers (duplicated from markdown.ts to keep this module
//    self-contained for streaming; markdown.ts helpers are not exported) ─────

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

/** True for a GFM table delimiter row, e.g. `|---|:--:|`. */
function isTableDelimiter(s: string): boolean {
  return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(s) && s.includes("-");
}

/** Split a GFM table row into trimmed, marker-stripped cells (outer pipes optional). */
function splitTableRow(s: string): string[] {
  let t = s.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  return t.split("|").map((c) => stripInline(c.trim()));
}
