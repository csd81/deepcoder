import type { AgentMessage } from "../providers/types.js";
import {
  indexToolCalls,
  isReadTool,
  isWriteTool,
  isSearchTool,
  isBashTool,
  pathArg,
  commandArg,
  argKey,
  FAILURE_RE,
  lastErrorIndex,
  type Region,
  type StageStats,
} from "./tridentUtil.js";

/**
 * Trident Stage 1 — Supersede. Replace an *obsolete* tool result's content with
 * a short attributed stub **while keeping the message and its toolCallId** (so
 * tool-call↔result pairing never breaks). Three structural rules, keyed on
 * trackers and call arguments — never on model-supplied text:
 *
 *  1. Fossil file read — a `read_file` whose path a *later* turn wrote
 *     (writeTracker, or a later write_file/edit_file on the same path).
 *  2. Superseded read — an earlier read of a path that is read again later
 *     (keep only the most recent read of a never-written path).
 *  3. Redundant search — identical `grep`/`glob`/`semantic_search` args; keep
 *     the last occurrence, stub the earlier ones.
 *  4. Failed-then-fixed run — a `run_bash` failure for a command later re-run
 *     successfully; crop it. The single global *last error* is never cropped.
 *
 * In-place; only replaces content when strictly shorter (monotonic).
 */
export function supersede(messages: AgentMessage[], region: Region, writeTracker: Set<string>): StageStats {
  const idx = indexToolCalls(messages);
  const protectedError = lastErrorIndex(messages); // never crop the last error
  let saved = 0;
  let changed = false;

  // Write positions per path across the FULL history (a region read may be made
  // obsolete by a write that lands in the protected tail).
  const writeAt: { path: string; at: number }[] = [];
  messages.forEach((m, i) => {
    if (m.role === "assistant" && m.toolCalls) {
      for (const c of m.toolCalls) {
        if (isWriteTool(c.name)) {
          const p = pathArg(c.arguments ?? {});
          if (p) writeAt.push({ path: p, at: i });
        }
      }
    }
  });

  // Most-recent read (per path) and most-recent search (per arg key) within region.
  const lastReadOfPath = new Map<string, number>();
  const lastSearchOfKey = new Map<string, number>();
  // Bash runs per command (across full history): result index + ok flag.
  const bashRuns = new Map<string, { at: number; ok: boolean }[]>();

  for (let i = region.start; i < region.end; i++) {
    const m = messages[i];
    if (m?.role !== "tool" || !m.toolCallId) continue;
    const info = idx.get(m.toolCallId);
    if (!info) continue;
    if (isReadTool(info.name)) {
      const p = pathArg(info.args);
      if (p) lastReadOfPath.set(p, i);
    } else if (isSearchTool(info.name)) {
      lastSearchOfKey.set(argKey(info.name, info.args), i);
    }
  }
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m?.role !== "tool" || !m.toolCallId) continue;
    const info = idx.get(m.toolCallId);
    if (info && isBashTool(info.name)) {
      const cmd = commandArg(info.args);
      if (cmd) {
        const ok = !(typeof m.content === "string" && FAILURE_RE.test(m.content));
        let arr = bashRuns.get(cmd);
        if (!arr) {
          arr = [];
          bashRuns.set(cmd, arr);
        }
        arr.push({ at: i, ok });
      }
    }
  }

  const replace = (i: number, next: string): void => {
    const m = messages[i]!;
    if (typeof m.content !== "string" || next.length >= m.content.length) return; // monotonic
    saved += m.content.length - next.length;
    messages[i] = { ...m, content: next };
    changed = true;
  };

  for (let i = region.start; i < region.end; i++) {
    const m = messages[i];
    if (m?.role !== "tool" || !m.toolCallId) continue;
    const info = idx.get(m.toolCallId);
    if (!info) continue;

    if (isReadTool(info.name)) {
      if (i === protectedError) continue; // don't strip the last error's content
      const p = pathArg(info.args);
      if (!p) continue;
      const laterWrite = writeTracker.has(p) || writeAt.some((w) => w.path === p && w.at > info.callIndex);
      if (laterWrite) {
        replace(i, `[read ${p} — content superseded by a later write]`);
      } else if (lastReadOfPath.get(p) !== i) {
        replace(i, `[read ${p} — superseded by a later read]`);
      }
      continue;
    }

    if (isSearchTool(info.name)) {
      if (i === protectedError) continue;
      const key = argKey(info.name, info.args);
      if (lastSearchOfKey.get(key) !== i) {
        const q = String(info.args.query ?? info.args.pattern ?? info.args.q ?? "");
        replace(i, `[${info.name}${q ? ` "${q}"` : ""} — superseded by a later identical search]`);
      }
      continue;
    }

    if (isBashTool(info.name)) {
      // A failed run that LATER SUCCEEDED is resolved — safe to crop even if it is
      // the lexically-last failure (the unresolved last error has no later success
      // and so is never cropped here).
      const cmd = commandArg(info.args);
      if (cmd && typeof m.content === "string" && FAILURE_RE.test(m.content)) {
        const runs = bashRuns.get(cmd) ?? [];
        if (runs.some((r) => r.at > i && r.ok)) {
          replace(i, `[ran "${cmd}" — failed; later succeeded]`);
        }
      }
    }
  }

  return { changed, saved };
}
