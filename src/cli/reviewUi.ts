/**
 * Patch Review Browser — I/O shell (read-only v1).
 *
 * Owns stdin/stdout, the alternate screen, raw input, and the async actions
 * (re-verify, open worktree). All view logic lives in the pure controller
 * (src/ui/reviewController.ts). Structure mirrors runTuiRepl (src/cli/repl.ts):
 * guaranteed terminal restore across every exit path.
 */

import { emitKeypressEvents } from "node:readline";
import { stdin, stdout } from "node:process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";
import { createTheme, resolveColorEnabled, type Theme } from "../ui/theme.js";
import { diffFrames } from "../ui/frameWriter.js";
import { visibleWidth } from "../ui/minimalRenderer.js";
import {
  initReviewState,
  reduceReview,
  reviewKeyToAction,
  applyVerify,
  applyMessage,
  refreshDetail,
  renderReview,
  bodyHeightFor,
  diffWidthFor,
} from "../ui/reviewController.js";
import { getWorkerReviewDetail, getDelegationReviewOverview, type DelegationReviewOverview } from "../delegate/reviewBrowser.js";
import { loadAndValidateWorker } from "../delegate/validation.js";
import type { CheckConfig } from "../config/fileConfig.js";
import type { WorkerRun } from "../delegate/types.js";

type Tty = NodeJS.ReadStream & { isTTY?: boolean; setRawMode?(v: boolean): void };

function makeTheme(): Theme {
  return createTheme(
    resolveColorEnabled({
      env: process.env,
      isTTY: Boolean((stdout as { isTTY?: boolean }).isTTY) || Boolean((stdin as { isTTY?: boolean }).isTTY),
    }),
  );
}

/** Read the kept-worktree path from run.json, or undefined when not kept. */
async function readWorktreePath(root: string, planId: string, workerId: string): Promise<string | undefined> {
  try {
    const raw = await readFile(path.join(root, ".deepcoder", "delegations", planId, "runs", workerId, "run.json"), "utf8");
    const run = JSON.parse(raw) as WorkerRun;
    return run.isolation?.kept ? run.isolation.isolatedRoot ?? undefined : undefined;
  } catch {
    return undefined;
  }
}

export interface ReviewUiOptions {
  root: string;
  planId: string;
  workerId: string;
  checks: Record<string, CheckConfig>;
}

/** Open the interactive read-only patch viewer for one worker. */
export async function runReviewUi(opts: ReviewUiOptions): Promise<void> {
  const { root, planId, workerId, checks } = opts;
  const detail = await getWorkerReviewDetail(root, planId, workerId, { checks });
  if (!detail) {
    stdout.write(chalk.red(`No review data for worker "${workerId}" in plan "${planId}".\n`));
    return;
  }
  let state = initReviewState(detail, await readWorktreePath(root, planId, workerId));

  const tty = stdin as Tty;
  const theme = makeTheme();
  let restored = false;
  let prevFrame: string[] = [];
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((r) => { resolveDone = r; });

  const enterAlt = () => { stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H"); prevFrame = []; };
  const leaveAlt = () => stdout.write("\x1b[?25h\x1b[?1049l");
  function restore(): void {
    if (restored) return;
    restored = true;
    try { if (tty.isTTY) tty.setRawMode?.(false); } catch { /* */ }
    try { stdin.removeListener("keypress", onKey); } catch { /* */ }
    try { leaveAlt(); } catch { /* */ }
    try { stdin.pause(); } catch { /* */ }
  }

  function redraw(): void {
    if (restored) return;
    const size = { width: stdout.columns ?? 80, height: stdout.rows ?? 24 };
    const frame = renderReview(state, size, theme);
    const ops = diffFrames(prevFrame, frame);
    if (ops) stdout.write(ops);
    prevFrame = frame;
  }
  function onResize(): void {
    if (restored) return;
    stdout.write("\x1b[2J\x1b[H");
    prevFrame = [];
    redraw();
  }

  async function onKey(str: string | undefined, key: { name?: string; sequence?: string; ctrl?: boolean } | undefined): Promise<void> {
    if (restored) return;
    if (key?.ctrl && key.name === "c") { restore(); resolveDone(); return; }
    const action = reviewKeyToAction(key?.name ?? str ?? "", state.mode);
    const ctx = { bodyHeight: bodyHeightFor(stdout.rows ?? 24), diffWidth: diffWidthFor(stdout.columns ?? 80) };
    switch (action) {
      case "quit":
        restore(); resolveDone(); return;
      case "verify": {
        state = { ...state, busy: true }; redraw();
        try {
          const v = await loadAndValidateWorker(root, planId, workerId);
          const fresh = await getWorkerReviewDetail(root, planId, workerId, { checks });
          state = applyVerify(fresh ? refreshDetail(state, fresh) : state, v);
        } catch (err) {
          state = applyMessage(state, `verify failed: ${(err as Error).message}`, true);
        }
        redraw(); return;
      }
      case "open":
        state = state.worktreePath
          ? applyMessage(state, `worktree: ${state.worktreePath}`, false)
          : applyMessage(state, "no kept worktree (run with workspace-isolation keep)", true);
        redraw(); return;
      default:
        state = reduceReview(state, action, ctx); redraw(); return;
    }
  }

  enterAlt();
  emitKeypressEvents(stdin);
  if (tty.isTTY) tty.setRawMode?.(true);
  stdin.resume();
  stdin.on("keypress", onKey);
  const onProcExit = () => restore();
  process.on("exit", onProcExit);
  process.on("SIGTERM", onProcExit);
  stdout.on("resize", onResize);
  redraw();
  try {
    await done;
  } finally {
    restore();
    stdout.removeListener("resize", onResize);
    process.removeListener("exit", onProcExit);
    process.removeListener("SIGTERM", onProcExit);
  }
}

/**
 * Interactive worker picker for a plan: list workers, j/k to move, Enter to open
 * the viewer, q to quit. Returns after the chosen viewer session ends.
 */
export async function runReviewPicker(opts: { root: string; planId: string; checks: Record<string, CheckConfig> }): Promise<void> {
  const { root, planId, checks } = opts;
  const overview = await getDelegationReviewOverview(root, planId, { checks });
  if (!overview || overview.workers.length === 0) {
    stdout.write(chalk.dim(`No workers with run artifacts in plan "${planId}".\n`));
    return;
  }
  const ov: DelegationReviewOverview = overview; // non-null for the closures below
  if (ov.workers.length === 1) {
    await runReviewUi({ root, planId, workerId: ov.workers[0]!.workerId, checks });
    return;
  }

  const tty = stdin as Tty;
  const theme = makeTheme();
  let selected = 0;
  let chosen: string | null = null;
  let restored = false;
  let prevFrame: string[] = [];
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((r) => { resolveDone = r; });

  const leaveAlt = () => stdout.write("\x1b[?25h\x1b[?1049l");
  function restore(): void {
    if (restored) return;
    restored = true;
    try { if (tty.isTTY) tty.setRawMode?.(false); } catch { /* */ }
    try { stdin.removeListener("keypress", onKey); } catch { /* */ }
    try { leaveAlt(); } catch { /* */ }
    try { stdin.pause(); } catch { /* */ }
  }
  function clip(s: string, w: number): string { return visibleWidth(s) <= w ? s : s.slice(0, w); }
  function redraw(): void {
    if (restored) return;
    const width = stdout.columns ?? 80;
    const height = stdout.rows ?? 24;
    const rows: string[] = [clip(theme.title(`Plan ${ov.planId} — ${ov.workers.length} workers · ${ov.task}`), width)];
    ov.workers.forEach((w, i) => {
      const chk = w.checkPassed === null ? "check n/a" : w.checkPassed ? "check pass" : "check fail";
      const line = `${w.workerId}  ${w.status} · ${chk} · ${w.applyEligible ? "apply:eligible" : "apply:BLOCKED"} · ${w.title}`;
      rows.push(clip(i === selected ? theme.selected(` ${line} `) : `  ${line}`, width));
    });
    rows.push(clip(theme.dim("j/k move · Enter open · q quit"), width));
    while (rows.length < height) rows.push("");
    const frame = rows.slice(0, height);
    const ops = diffFrames(prevFrame, frame);
    if (ops) stdout.write(ops);
    prevFrame = frame;
  }

  function onKey(str: string | undefined, key: { name?: string; sequence?: string; ctrl?: boolean } | undefined): void {
    if (restored) return;
    const name = key?.name ?? str ?? "";
    if ((key?.ctrl && key.name === "c") || name === "q" || name === "escape") { restore(); resolveDone(); return; }
    if (name === "j" || name === "down") { selected = Math.min(ov.workers.length - 1, selected + 1); redraw(); return; }
    if (name === "k" || name === "up") { selected = Math.max(0, selected - 1); redraw(); return; }
    if (name === "return" || name === "enter" || str === "\r") { chosen = ov.workers[selected]!.workerId; restore(); resolveDone(); return; }
  }

  stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H");
  emitKeypressEvents(stdin);
  if (tty.isTTY) tty.setRawMode?.(true);
  stdin.resume();
  stdin.on("keypress", onKey);
  const onProcExit = () => restore();
  process.on("exit", onProcExit);
  process.on("SIGTERM", onProcExit);
  redraw();
  try {
    await done;
  } finally {
    restore();
    process.removeListener("exit", onProcExit);
    process.removeListener("SIGTERM", onProcExit);
  }
  if (chosen) await runReviewUi({ root, planId, workerId: chosen, checks });
}
