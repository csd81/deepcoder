import type { AgentMessage, ToolCall } from "../providers/types.js";

export interface SupersedeResult {
  changed: boolean;
  saved: number; // estimated tokens saved
}

/**
 * Normalize the arguments of a search tool call (grep/glob/semantic_search) into a
 * stable key for deduplication.
 */
function searchKey(name: string, args: Record<string, unknown>): string {
  if (name === "grep") {
    return `grep:${String(args.pattern ?? "")}:${String(args.path ?? ".")}:${String(args.glob ?? "")}`;
  }
  if (name === "glob") {
    return `glob:${String(args.pattern ?? "")}:${String(args.path ?? ".")}`;
  }
  if (name === "semantic_search") {
    return `semantic_search:${String(args.query ?? "")}`;
  }
  return "";
}

/** Rough token estimate for a message (matching estimateMessage in tokenBudget). */
function msgTokens(m: AgentMessage): number {
  let chars = m.content.length;
  if (m.toolCalls) chars += JSON.stringify(m.toolCalls).length;
  return Math.ceil(chars / 4) + 4;
}

const SEARCH_TOOLS = new Set(["grep", "glob", "semantic_search"]);
const WRITE_TOOLS = new Set(["write_file", "edit_file", "delete_file", "rename_file", "apply_patch"]);

/**
 * Stage 1 — Supersede: replace obsolete tool results with short stubs while
 * keeping the message and its toolCallId (pairing-safe). Mutates `messages` in
 * place. Only touches messages within [regionStart, regionEnd).
 */
export function supersede(
  messages: AgentMessage[],
  regionStart: number,
  regionEnd: number,
  writeTracker: Set<string>,
): SupersedeResult {
  let changed = false;
  let saved = 0;

  // ---- pass 1: collect write positions + last-read per path + search occurrences ----
  const writtenPaths: Map<string, number> = new Map(); // path → index of first write in region
  const readOccurrences: Map<string, number[]> = new Map(); // path → [indices of read_file results]
  const searchOccurrences: Map<string, number[]> = new Map(); // searchKey → [indices]
  const runBashOccurrences: { command: string; index: number; isError: boolean }[] = [];

  const FAILURE_RE = /\b(error|exit code [1-9]|failed|exception|traceback)\b/i;

  for (let i = regionStart; i < regionEnd; i++) {
    const m = messages[i]!;
    if (m.role !== "tool") continue;

    // Track writes
    if (m.name && WRITE_TOOLS.has(m.name)) {
      const call = findToolCall(messages, i, m.toolCallId);
      if (call) {
        const p = pathFromArgs(m.name, call.arguments);
        if (p && !writtenPaths.has(p)) writtenPaths.set(p, i);
      }
    }

    // Track reads
    if (m.name === "read_file") {
      const call = findToolCall(messages, i, m.toolCallId);
      if (call) {
        const p = pathFromArgs("read_file", call.arguments);
        if (p) {
          const arr = readOccurrences.get(p);
          if (arr) arr.push(i);
          else readOccurrences.set(p, [i]);
        }
      }
    }

    // Track searches
    if (m.name && SEARCH_TOOLS.has(m.name)) {
      const call = findToolCall(messages, i, m.toolCallId);
      if (call) {
        const key = searchKey(m.name, call.arguments);
        if (key) {
          const arr = searchOccurrences.get(key);
          if (arr) arr.push(i);
          else searchOccurrences.set(key, [i]);
        }
      }
    }

    // Track run_bash
    if (m.name === "run_bash") {
      const call = findToolCall(messages, i, m.toolCallId);
      if (call) {
        const cmd = typeof call.arguments.command === "string" ? call.arguments.command : "";
        const isError = FAILURE_RE.test(m.content);
        runBashOccurrences.push({ command: cmd, index: i, isError });
      }
    }
  }

  // ---- pass 2: apply stubs ----

  // Fossil file reads
  // A path is "written later" if it appears in writeTracker OR is written in this region.
  // For paths written later: ALL reads before the write are fossil.
  // For paths NOT written later: only the MOST RECENT read survives.
  for (const [path, indices] of readOccurrences) {
    const firstWriteInRegion = writtenPaths.get(path);
    const writtenLater = firstWriteInRegion !== undefined || writeTracker.has(path);

    if (writtenLater) {
      // Stub reads that happen before the write
      for (let idx = 0; idx < indices.length; idx++) {
        const mi = indices[idx]!;
        if (firstWriteInRegion !== undefined && mi > firstWriteInRegion) continue;
        const m = messages[mi]!;
        const before = msgTokens(m);
        m.content = `[read ${path} — content superseded by a later write]`;
        const after = msgTokens(m);
        saved += Math.max(0, before - after);
        changed = true;
        indices[idx] = -1 as unknown as number;
      }
    } else {
      // Path not written later: keep only the most recent read
      if (indices.length > 1) {
        const lastIdx = indices[indices.length - 1]!;
        for (const mi of indices) {
          if (mi === lastIdx) continue;
          const m = messages[mi]!;
          const before = msgTokens(m);
          m.content = `[read ${path} — superseded by a later read]`;
          const after = msgTokens(m);
          saved += Math.max(0, before - after);
          changed = true;
        }
      }
    }
  }

  // Redundant searches: keep last occurrence, stub earlier
  for (const [, indices] of searchOccurrences) {
    if (indices.length <= 1) continue;
    const lastIdx = indices[indices.length - 1]!;
    for (const mi of indices) {
      if (mi === lastIdx) continue;
      const m = messages[mi]!;
      const call = findToolCall(messages, mi, m.toolCallId);
      const toolName = call?.name ?? m.name ?? "search";
      const before = msgTokens(m);
      if (toolName === "grep") {
        const pattern = call?.arguments.pattern ?? "";
        m.content = `[grep "${String(pattern)}" — superseded by a later identical search]`;
      } else if (toolName === "glob") {
        const pattern = call?.arguments.pattern ?? "";
        m.content = `[glob "${String(pattern)}" — superseded by a later identical search]`;
      } else {
        const query = call?.arguments.query ?? "";
        m.content = `[semantic_search "${String(query)}" — superseded by a later identical search]`;
      }
      const after = msgTokens(m);
      saved += Math.max(0, before - after);
      changed = true;
    }
  }

  // Failed-then-fixed run_bash
  const runsByCmd = new Map<string, { index: number; isError: boolean }[]>();
  for (const r of runBashOccurrences) {
    const arr = runsByCmd.get(r.command);
    if (arr) arr.push(r);
    else runsByCmd.set(r.command, [r]);
  }
  for (const [, runs] of runsByCmd) {
    if (runs.length < 2) continue;
    for (let i = 0; i < runs.length - 1; i++) {
      const ri = runs[i]!;
      if (!ri.isError) continue;
      const hasLaterSuccess = runs.slice(i + 1).some((r) => !r.isError);
      if (!hasLaterSuccess) continue;
      const m = messages[ri.index]!;
      const before = msgTokens(m);
      m.content = `[ran "${ri.command}" — failed; later succeeded]`;
      const after = msgTokens(m);
      saved += Math.max(0, before - after);
      changed = true;
    }
  }

  return { changed, saved };
}

/** Find the assistant toolCall that owns a tool result. */
function findToolCall(
  messages: AgentMessage[],
  toolIndex: number,
  toolCallId: string | undefined,
): ToolCall | undefined {
  if (!toolCallId) return undefined;
  for (let i = toolIndex - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "assistant" && m.toolCalls) {
      for (const c of m.toolCalls) {
        if (c.id === toolCallId) return c;
      }
    }
  }
  return undefined;
}

/** Extract a path from tool arguments. */
function pathFromArgs(name: string, args: Record<string, unknown>): string | undefined {
  if (name === "read_file" || name === "write_file" || name === "edit_file" || name === "delete_file") {
    return typeof args.path === "string" ? args.path : undefined;
  }
  if (name === "rename_file") {
    return typeof args.to === "string" ? args.to : undefined;
  }
  if (name === "apply_patch") {
    const ops = args.ops;
    if (Array.isArray(ops) && ops.length > 0 && typeof ops[0]?.path === "string") {
      return ops[0].path as string;
    }
    return undefined;
  }
  return undefined;
}
