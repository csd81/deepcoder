/**
 * Patch Review Browser — pure controller (no I/O).
 *
 * A reducer + renderer for the read-only delegated-worker patch viewer. The I/O
 * shell (src/cli/reviewUi.ts) owns stdin/stdout/alt-screen and async actions; it
 * feeds results back here via the pure setters. Mirrors the discipline of the
 * other src/ui modules: deterministic, unit-testable without mocks.
 */

import { keyToAction } from "./minimalRenderer.js";
import { visibleWidth } from "./minimalRenderer.js";
import { wrapLine } from "./textLayout.js";
import { highlightCode } from "./syntax.js";
import type { Theme } from "./theme.js";
import { splitPatchByFile, type DiffFileSection } from "../delegate/diffView.js";
import type { WorkerReviewDetail } from "../delegate/reviewBrowser.js";
import type { WorkerValidation } from "../delegate/types.js";

export type ReviewMode = "diff" | "message";

export interface ReviewState {
  detail: WorkerReviewDetail;
  files: DiffFileSection[];
  selected: number;
  scroll: number;
  mode: ReviewMode;
  message?: { text: string; isError: boolean };
  worktreePath?: string;
  busy: boolean;
}

export type ReviewAction =
  | "scroll-up" | "scroll-down" | "half-up" | "half-down" | "top" | "bottom"
  | "next-file" | "prev-file"
  | "verify" | "open"
  | "dismiss" | "quit" | "none";

export interface RenderSize { width: number; height: number; }
export interface ReduceCtx { bodyHeight: number; diffWidth: number; }

/* ----------------------------- layout helpers ---------------------------- */

const STATUS_ROWS = 2;
const FOOTER_ROWS = 1;
const GUTTER = 1;

export function bodyHeightFor(height: number): number {
  return Math.max(1, height - STATUS_ROWS - FOOTER_ROWS);
}
/** Width of the left file-list column; 0 on a narrow terminal (full-width diff). */
export function listWidthFor(width: number): number {
  if (width < 60) return 0;
  return Math.max(24, Math.min(40, Math.floor(width * 0.32)));
}
export function diffWidthFor(width: number): number {
  const lw = listWidthFor(width);
  return lw > 0 ? width - lw - GUTTER : width;
}

/* ----------------------------- state + setters --------------------------- */

export function initReviewState(detail: WorkerReviewDetail, worktreePath?: string): ReviewState {
  return {
    detail,
    files: splitPatchByFile(detail.patchPreview),
    selected: 0,
    scroll: 0,
    mode: "diff",
    worktreePath,
    busy: false,
  };
}

/** Number of wrapped diff rows for the current file at `diffWidth`. */
function wrappedCount(state: ReviewState, diffWidth: number): number {
  const file = state.files[state.selected];
  if (!file) return 0;
  let n = 0;
  for (const ln of file.lines) n += wrapLine(ln, Math.max(1, diffWidth)).length;
  return n;
}

export function reduceReview(state: ReviewState, action: ReviewAction, ctx: ReduceCtx): ReviewState {
  const maxScroll = Math.max(0, wrappedCount(state, ctx.diffWidth) - ctx.bodyHeight);
  const clampScroll = (n: number): number => Math.max(0, Math.min(maxScroll, n));
  const half = Math.max(1, Math.floor(ctx.bodyHeight / 2));

  switch (action) {
    case "scroll-up": return { ...state, scroll: clampScroll(state.scroll - 1) };
    case "scroll-down": return { ...state, scroll: clampScroll(state.scroll + 1) };
    case "half-up": return { ...state, scroll: clampScroll(state.scroll - half) };
    case "half-down": return { ...state, scroll: clampScroll(state.scroll + half) };
    case "top": return { ...state, scroll: 0 };
    case "bottom": return { ...state, scroll: maxScroll };
    case "next-file":
      return { ...state, selected: Math.min(state.files.length - 1, state.selected + 1), scroll: 0 };
    case "prev-file":
      return { ...state, selected: Math.max(0, state.selected - 1), scroll: 0 };
    case "dismiss":
      return state.mode === "message" ? { ...state, mode: "diff", message: undefined } : state;
    default:
      return state; // verify/open/quit/none are handled by the shell (need I/O)
  }
}

/** Fold a re-validation verdict into a message banner. */
export function applyVerify(state: ReviewState, v: WorkerValidation): ReviewState {
  const fails = v.failures.length;
  const text = `verify: ${v.status} · ${v.applyable ? "applyable" : "not applyable"}` +
    (fails ? ` · ${fails} failure${fails === 1 ? "" : "s"}: ${v.failures[0]!.message}` : "");
  return { ...state, mode: "message", message: { text, isError: !v.applyable }, busy: false };
}

export function applyMessage(state: ReviewState, text: string, isError: boolean): ReviewState {
  return { ...state, mode: "message", message: { text, isError }, busy: false };
}

/** Re-split a freshly-reloaded detail, clamping the selection. */
export function refreshDetail(state: ReviewState, detail: WorkerReviewDetail): ReviewState {
  const files = splitPatchByFile(detail.patchPreview);
  return { ...state, detail, files, selected: Math.min(state.selected, Math.max(0, files.length - 1)), scroll: 0 };
}

/* ------------------------------- key mapping ----------------------------- */

export function reviewKeyToAction(key: string, mode: ReviewMode): ReviewAction {
  if (mode === "message") return "dismiss"; // any key clears the banner
  switch (key) {
    case "j": return "scroll-down";
    case "k": return "scroll-up";
    case "n": return "next-file";
    case "p": return "prev-file";
    case "v": return "verify";
    case "o": return "open";
    case "q": return "quit";
    case "up": return "scroll-up";
    case "down": return "scroll-down";
  }
  const base = keyToAction(key);
  switch (base) {
    case "scroll-up": case "scroll-down": case "half-up": case "half-down": case "top": case "bottom":
      return base;
    case "escape": case "interrupt": return "quit";
    default: return "none";
  }
}

/* -------------------------------- rendering ------------------------------ */

const KIND_GLYPH: Record<DiffFileSection["kind"], string> = {
  added: "A", modified: "M", deleted: "D", renamed: "R", unknown: "?",
};

/** Pad a (possibly styled) string to `width` visible columns. */
function vpad(s: string, width: number): string {
  const gap = width - visibleWidth(s);
  return gap > 0 ? s + " ".repeat(gap) : s;
}
/** Truncate to `width` visible columns, preserving SGR codes. */
function clip(s: string, width: number): string {
  if (visibleWidth(s) <= width) return s;
  let out = "", count = 0, i = 0, sawEsc = false;
  while (i < s.length && count < width) {
    const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
    if (m) { out += m[0]; i += m[0].length; sawEsc = true; continue; }
    out += s[i]; i += 1; count += 1;
  }
  return sawEsc ? out + "\x1b[0m" : out;
}

export function renderReview(state: ReviewState, size: RenderSize, theme: Theme): string[] {
  const { width, height } = size;
  const color = theme.dim(" ") !== " ";
  const listW = listWidthFor(width);
  const diffW = diffWidthFor(width);
  const bodyH = bodyHeightFor(height);
  const d = state.detail;

  /* status (2 rows) */
  const titleRow = clip(theme.title(`${d.workerId} — ${d.title}`), width);
  const tdd = d.deterministicGates.find((g) => g.name === "tdd_gate");
  const tddTxt = tdd ? (tdd.passed ? "TDD ok" : "TDD missing") : "TDD n/a";
  const checkTxt = d.checkPassed === null ? "check n/a" : d.checkPassed ? "check pass" : "check fail";
  const kb = (d.patchBytes / 1024).toFixed(1);
  // Lead with the apply verdict (+ first blocker) so it survives truncation.
  const head = d.applyEligible
    ? "apply:eligible"
    : `apply:BLOCKED${d.applyBlockers.length ? ` — ${d.applyBlockers[0]}` : ""}`;
  const status = `${head} · ${d.status} · ${checkTxt} · quality:${d.qualityGate} · ${tddTxt} · ` +
    `${d.changedFiles.length} files · ${kb}KB · file ${state.selected + 1}/${state.files.length}`;
  const statusStyle = d.applyEligible ? theme.success : theme.warning;
  const statusRow = clip(statusStyle(status), width);

  /* body (bodyH rows) */
  const file = state.files[state.selected];
  // left: file list windowed around the selection
  const listTop = Math.max(0, Math.min(state.selected - Math.floor(bodyH / 2), Math.max(0, state.files.length - bodyH)));
  // right: wrapped + highlighted diff lines, sliced by scroll
  const wrapped: string[] = [];
  if (file) for (const ln of file.lines) for (const w of wrapLine(ln, Math.max(1, diffW))) wrapped.push(w);
  const visibleDiff = wrapped.slice(state.scroll, state.scroll + bodyH);

  const body: string[] = [];
  for (let r = 0; r < bodyH; r++) {
    let leftCell = "";
    if (listW > 0) {
      const fi = listTop + r;
      const f = state.files[fi];
      if (f) {
        const stat = d.patchStat.find((s) => s.path === f.path);
        const counts = stat ? `+${stat.added}/-${stat.removed}` : "";
        let cell = vpad(clip(`${KIND_GLYPH[f.kind]} ${f.path}`, listW - counts.length - 1), listW - counts.length - 1) + " " + counts;
        cell = clip(vpad(cell, listW), listW);
        leftCell = fi === state.selected ? theme.selected(cell) : cell;
      } else {
        leftCell = " ".repeat(listW);
      }
    }
    const diffLine = visibleDiff[r] ?? "";
    const diffCell = vpad(color ? highlightCode(diffLine, "diff", { color }) : diffLine, diffW);
    body.push(clip(listW > 0 ? `${vpad(leftCell, listW)} ${diffCell}` : diffCell, width));
  }

  /* footer (1 row): message banner or keymap */
  let footer: string;
  if (state.mode === "message" && state.message) {
    const style = state.message.isError ? theme.error : theme.dim;
    footer = clip(style(`${state.message.text}  (any key)`), width);
  } else {
    footer = clip(theme.dim("j/k scroll · n/p file · v verify · o worktree · q quit"), width);
  }

  return [titleRow, statusRow, ...body, footer];
}
