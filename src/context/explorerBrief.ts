/**
 * ExplorerBrief — a compact, cited summary produced by the explorer subagent.
 *
 * Every list is bounded and deduped. File claims (relevantFiles, likelyFixLocations)
 * require at least one citation; entries without citations are dropped.
 *
 * parseExplorerBrief NEVER throws — on any parse failure it returns a safe empty brief.
 * renderExplorerBrief returns a compact text representation bounded to ~6000 bytes.
 */

import type { SubagentTrace } from "../subagents/types.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface RelevantFile {
  path: string;
  reason: string;
  citations: string[];
}

export interface LikelyFixLocation {
  path: string;
  confidence: "low" | "medium" | "high";
  reason: string;
}

export interface RelevantTest {
  pathOrCommand: string;
  reason: string;
}

export interface ExplorerBrief {
  summary: string;
  relevantFiles: RelevantFile[];
  likelyFixLocations: LikelyFixLocation[];
  relevantTests: RelevantTest[];
  risks: string[];
  openQuestions: string[];
  trace: SubagentTrace[];
}

/**
 * A persisted record of an explorer subagent run. Stored in quarantined session
 * metadata (session.briefs) — NEVER added to the model-visible message history.
 */
export interface BriefRunRecord {
  createdAt: string;
  brief: ExplorerBrief;
  trace: SubagentTrace;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const DEFAULT_MAX_PER_LIST = 10;
const DEFAULT_MAX_ENTRY_LENGTH = 200;
const DEFAULT_MAX_SUMMARY_LENGTH = 500;
const DEFAULT_MAX_BYTES = 6000;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Dedupe an array of strings by lowercased value, trim, bound length. */
function cleanStrings(items: string[], maxLen: number, maxEntry: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const trimmed = String(item).trim().slice(0, maxEntry);
    if (trimmed.length === 0) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= maxLen) break;
  }
  return out;
}

/** Dedupe RelevantFile entries by path (case-insensitive), drop those without citations. */
function cleanRelevantFiles(
  items: unknown[],
  maxLen: number,
  maxEntry: number,
): RelevantFile[] {
  const seen = new Set<string>();
  const out: RelevantFile[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const path = String(raw.path ?? "").trim().slice(0, maxEntry);
    if (path.length === 0) continue;
    const reason = String(raw.reason ?? "").trim().slice(0, maxEntry);
    const citations = asStringArray(raw.citations).filter((c) => c.trim().length > 0);
    // A file claim requires at least one citation — drop if missing or empty
    if (citations.length === 0) continue;
    const key = path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path, reason, citations: citations.map((c) => c.trim().slice(0, maxEntry)) });
    if (out.length >= maxLen) break;
  }
  return out;
}

/** Dedupe LikelyFixLocation entries by path (case-insensitive), drop those without citations. */
function cleanLikelyFixLocations(
  items: unknown[],
  maxLen: number,
  maxEntry: number,
): LikelyFixLocation[] {
  const seen = new Set<string>();
  const out: LikelyFixLocation[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const path = String(raw.path ?? "").trim().slice(0, maxEntry);
    if (path.length === 0) continue;
    const reason = String(raw.reason ?? "").trim().slice(0, maxEntry);
    const confidence = normalizeConfidence(raw.confidence);
    // A fix location claim requires at least one citation
    const citations = asStringArray(raw.citations).filter((c) => c.trim().length > 0);
    if (citations.length === 0) continue;
    const key = path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path, confidence, reason });
    if (out.length >= maxLen) break;
  }
  return out;
}

/** Dedupe RelevantTest entries by pathOrCommand (case-insensitive). */
function cleanRelevantTests(
  items: unknown[],
  maxLen: number,
  maxEntry: number,
): RelevantTest[] {
  const seen = new Set<string>();
  const out: RelevantTest[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const pathOrCommand = String(raw.pathOrCommand ?? "").trim().slice(0, maxEntry);
    if (pathOrCommand.length === 0) continue;
    const reason = String(raw.reason ?? "").trim().slice(0, maxEntry);
    const key = pathOrCommand.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ pathOrCommand, reason });
    if (out.length >= maxLen) break;
  }
  return out;
}

/** Dedupe SubagentTrace entries by a composite key. */
function cleanTraces(items: unknown[], maxLen: number): SubagentTrace[] {
  const seen = new Set<string>();
  const out: SubagentTrace[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const toolsCalled = asStringArray(raw.toolsCalled);
    const turns = Number(raw.turns) || 0;
    const model = String(raw.model ?? "").trim();
    const key = `${model}|${turns}|${toolsCalled.join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ toolsCalled, turns, model });
    if (out.length >= maxLen) break;
  }
  return out;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v ?? ""));
}

function normalizeConfidence(value: unknown): "low" | "medium" | "high" {
  const s = String(value ?? "").trim().toLowerCase();
  if (s === "low") return "low";
  if (s === "medium") return "medium";
  if (s === "high") return "high";
  return "low"; // default safe
}

/* ------------------------------------------------------------------ */
/*  Safe empty brief                                                   */
/* ------------------------------------------------------------------ */

function emptyBrief(): ExplorerBrief {
  return {
    summary: "",
    relevantFiles: [],
    likelyFixLocations: [],
    relevantTests: [],
    risks: [],
    openQuestions: [],
    trace: [],
  };
}

/* ------------------------------------------------------------------ */
/*  parseExplorerBrief                                                 */
/* ------------------------------------------------------------------ */

/**
 * Parse a raw JSON string into an ExplorerBrief.
 *
 * NEVER throws. On missing, empty, malformed JSON, or any parse error it
 * returns a safe empty ExplorerBrief. All lists are bounded and deduped.
 * File claims (relevantFiles, likelyFixLocations) without at least one
 * citation are dropped.
 */
export function parseExplorerBrief(raw: string): ExplorerBrief {
  if (!raw || typeof raw !== "string") return emptyBrief();
  const trimmed = raw.trim();
  if (trimmed.length === 0) return emptyBrief();

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return emptyBrief();
  }

  if (!parsed || typeof parsed !== "object") return emptyBrief();
  const obj = parsed as Record<string, unknown>;

  const summary = String(obj.summary ?? "").trim().slice(0, DEFAULT_MAX_SUMMARY_LENGTH);

  const relevantFiles = cleanRelevantFiles(
    Array.isArray(obj.relevantFiles) ? obj.relevantFiles : [],
    DEFAULT_MAX_PER_LIST,
    DEFAULT_MAX_ENTRY_LENGTH,
  );

  const likelyFixLocations = cleanLikelyFixLocations(
    Array.isArray(obj.likelyFixLocations) ? obj.likelyFixLocations : [],
    DEFAULT_MAX_PER_LIST,
    DEFAULT_MAX_ENTRY_LENGTH,
  );

  const relevantTests = cleanRelevantTests(
    Array.isArray(obj.relevantTests) ? obj.relevantTests : [],
    DEFAULT_MAX_PER_LIST,
    DEFAULT_MAX_ENTRY_LENGTH,
  );

  const risks = cleanStrings(
    Array.isArray(obj.risks) ? obj.risks.map((r) => String(r ?? "")) : [],
    DEFAULT_MAX_PER_LIST,
    DEFAULT_MAX_ENTRY_LENGTH,
  );

  const openQuestions = cleanStrings(
    Array.isArray(obj.openQuestions) ? obj.openQuestions.map((q) => String(q ?? "")) : [],
    DEFAULT_MAX_PER_LIST,
    DEFAULT_MAX_ENTRY_LENGTH,
  );

  const trace = cleanTraces(
    Array.isArray(obj.trace) ? obj.trace : [],
    5, // max 5 traces
  );

  return { summary, relevantFiles, likelyFixLocations, relevantTests, risks, openQuestions, trace };
}

/* ------------------------------------------------------------------ */
/*  renderExplorerBrief                                                */
/* ------------------------------------------------------------------ */

/**
 * Render an ExplorerBrief into a compact text representation.
 *
 * The output is bounded to ~DEFAULT_MAX_BYTES (6000) bytes. Lists are
 * truncated if the rendered output would exceed the limit.
 */
export function renderExplorerBrief(brief: ExplorerBrief, maxBytes: number = DEFAULT_MAX_BYTES): string {
  const parts: string[] = [];

  if (brief.summary) {
    parts.push(`Summary: ${brief.summary}`);
  }

  if (brief.relevantFiles.length > 0) {
    const lines = brief.relevantFiles.map(
      (f) => `  - ${f.path}: ${f.reason} [cites: ${f.citations.join(", ")}]`,
    );
    parts.push(`Relevant files (${brief.relevantFiles.length}):\n${lines.join("\n")}`);
  }

  if (brief.likelyFixLocations.length > 0) {
    const lines = brief.likelyFixLocations.map(
      (f) => `  - ${f.path} (${f.confidence}): ${f.reason}`,
    );
    parts.push(`Likely fix locations (${brief.likelyFixLocations.length}):\n${lines.join("\n")}`);
  }

  if (brief.relevantTests.length > 0) {
    const lines = brief.relevantTests.map(
      (t) => `  - ${t.pathOrCommand}: ${t.reason}`,
    );
    parts.push(`Relevant tests (${brief.relevantTests.length}):\n${lines.join("\n")}`);
  }

  if (brief.risks.length > 0) {
    const lines = brief.risks.map((r) => `  - ${r}`);
    parts.push(`Risks (${brief.risks.length}):\n${lines.join("\n")}`);
  }

  if (brief.openQuestions.length > 0) {
    const lines = brief.openQuestions.map((q) => `  - ${q}`);
    parts.push(`Open questions (${brief.openQuestions.length}):\n${lines.join("\n")}`);
  }

  if (brief.trace.length > 0) {
    const lines = brief.trace.map(
      (t) => `  - model=${t.model}, turns=${t.turns}, tools=[${t.toolsCalled.join(", ")}]`,
    );
    parts.push(`Trace (${brief.trace.length}):\n${lines.join("\n")}`);
  }

  let result = parts.join("\n\n");

  // Bound to maxBytes
  if (result.length > maxBytes) {
    result = result.slice(0, maxBytes);
    // Try to break at a newline boundary
    const lastNewline = result.lastIndexOf("\n");
    if (lastNewline > maxBytes * 0.8) {
      result = result.slice(0, lastNewline);
    }
    result += "\n… (truncated)";
  }

  return result || "(empty brief)";
}
