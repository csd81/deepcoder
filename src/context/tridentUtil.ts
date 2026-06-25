import type { AgentMessage } from "../providers/types.js";

/**
 * Shared, pure structural helpers for the Trident compaction stages
 * (supersede / collapse / cluster). Everything here keys on message *structure*
 * and tool *call arguments* — never on model-supplied free text — so a hostile
 * tool result cannot steer redundancy decisions.
 */

/** Per-stage result: did anything change, and ~chars shed (token accounting is
 * done by the orchestrator via estimateMessages). */
export interface StageStats {
  changed: boolean;
  saved: number;
  /** Messages removed (collapse/cluster shrink the array; supersede never does). */
  removed?: number;
}

export interface Region {
  start: number;
  end: number;
}

/** Failure signature reused from buildStructuredSummary (keep them in lockstep). */
export const FAILURE_RE = /\b(error|exit code [1-9]|failed|exception|traceback)\b/i;

export const READ_TOOLS = new Set(["read_file"]);
export const WRITE_TOOLS = new Set(["write_file", "edit_file"]);
export const SEARCH_TOOLS = new Set(["grep", "glob", "semantic_search"]);
export const EXPLORE_TOOLS = new Set(["read_file", "list_dir", "glob", "grep"]);
export const BASH_TOOLS = new Set(["run_bash"]);

export const isReadTool = (n: string): boolean => READ_TOOLS.has(n);
export const isWriteTool = (n: string): boolean => WRITE_TOOLS.has(n);
export const isSearchTool = (n: string): boolean => SEARCH_TOOLS.has(n);
export const isExploreTool = (n: string): boolean => EXPLORE_TOOLS.has(n);
export const isBashTool = (n: string): boolean => BASH_TOOLS.has(n);

export interface ToolCallInfo {
  name: string;
  args: Record<string, unknown>;
  /** Index of the assistant message holding this call. */
  callIndex: number;
}

/** Map every toolCallId to its owning assistant call's {name,args,index}. */
export function indexToolCalls(messages: AgentMessage[]): Map<string, ToolCallInfo> {
  const out = new Map<string, ToolCallInfo>();
  messages.forEach((m, i) => {
    if (m.role === "assistant" && m.toolCalls) {
      for (const c of m.toolCalls) out.set(c.id, { name: c.name, args: c.arguments ?? {}, callIndex: i });
    }
  });
  return out;
}

/** Best-effort target path from a read/write tool's args. */
export function pathArg(args: Record<string, unknown>): string | undefined {
  for (const k of ["path", "file", "filename", "filePath", "file_path"]) {
    const v = args[k];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

/** Best-effort command string from a run_bash tool's args. */
export function commandArg(args: Record<string, unknown>): string | undefined {
  for (const k of ["command", "cmd", "script"]) {
    const v = args[k];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

/** Stable normalized key for de-duplicating identical searches (sorted args). */
export function argKey(name: string, args: Record<string, unknown>): string {
  const norm: Record<string, unknown> = {};
  for (const k of Object.keys(args).sort()) norm[k] = args[k];
  return `${name}:${JSON.stringify(norm)}`;
}

/** Index of the last message whose content carries a failure signature. */
export function lastErrorIndex(messages: AgentMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const c = messages[i]?.content;
    if (typeof c === "string" && FAILURE_RE.test(c)) return i;
  }
  return -1;
}

/** A short, attributed stub — only used when strictly shorter than the original. */
export function stub(text: string): string {
  return text;
}
