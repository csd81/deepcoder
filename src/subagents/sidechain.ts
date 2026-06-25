import { promises as fs } from "node:fs";
import path from "node:path";
import { assertSafeId } from "../workspace/paths.js";
import { redactSecrets } from "../workspace/redact.js";

/**
 * Append-only **sidechain transcript store** for subagent runs.
 *
 * The parent session keeps only a bounded summary of a subagent run (so
 * untrusted subagent output can never poison the parent's model-visible
 * context). The *full* transcript is the durable audit trail, written here to
 * `.deepcoder/subagents/<runId>.jsonl` — a local control-plane artifact.
 *
 * `.deepcoder/**` is already model-unreadable (see `isSensitivePath`), so this
 * adds no model-visible surface: it is purely an out-of-band record for UI,
 * `/subagents`, audit, and future replay tooling.
 *
 * The log mirrors the session-event substrate: monotonic `seq`, `O_APPEND`
 * writes that never truncate, content redacted before it hits disk, and reads
 * that tolerate a torn final line and quarantine foreign/corrupt rows.
 */

const ENTRY_VERSION = 1 as const;

/** Who produced this transcript row, from the subagent's point of view. */
export type SidechainRole = "system" | "user" | "assistant" | "tool";

/** A single persisted transcript row (with its on-disk envelope). */
export interface SidechainEntry {
  v: typeof ENTRY_VERSION;
  /** Monotonic per-run sequence number, stamped by the store. */
  seq: number;
  runId: string;
  /** ISO timestamp the row was appended. */
  createdAt: string;
  role: SidechainRole;
  /** Redacted transcript text (secrets stripped before write). */
  content: string;
  /** Present for `role: "tool"` rows: the tool that produced the content. */
  toolName?: string;
}

/** Caller-supplied fields for one append; the store stamps the rest. */
export interface SidechainEntryInput {
  role: SidechainRole;
  content: string;
  toolName?: string;
  /** Optional explicit timestamp; defaults to now. */
  createdAt?: string;
}

/** Aggregate, model-safe metadata for the parent's quarantined record. */
export interface SidechainStats {
  entries: number;
  byRole: Record<string, number>;
}

function subagentsDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".deepcoder", "subagents");
}

function sidechainFile(workspaceRoot: string, runId: string): string {
  return path.join(subagentsDir(workspaceRoot), `${runId}.jsonl`);
}

/**
 * Append-only writer for one subagent run's sidechain. `assertSafeId(runId)`
 * confines the file to `.deepcoder/subagents`, so a crafted runId (`../escape`,
 * absolute, `a/b`) cannot escape the directory.
 */
export class SubagentSidechain {
  private nextSeq = 1;
  private inited = false;

  constructor(
    private workspaceRoot: string,
    readonly runId: string,
  ) {
    assertSafeId(runId);
  }

  private file(): string {
    return sidechainFile(this.workspaceRoot, this.runId);
  }

  /**
   * Initialise `nextSeq` from any rows already on disk so a fresh store
   * instance (a "process restart") continues the sequence monotonically rather
   * than restarting at 1.
   */
  private async init(): Promise<void> {
    if (this.inited) return;
    const existing = await readSidechain(this.workspaceRoot, this.runId);
    let max = 0;
    for (const e of existing) if (e.seq > max) max = e.seq;
    this.nextSeq = max + 1;
    this.inited = true;
  }

  /**
   * Append one transcript row. `content` is redacted via `redactSecrets`
   * before it is written. `seq` is stamped monotonically. The write is an
   * atomic-ish `O_APPEND` and never truncates the log.
   */
  async appendEntry(input: SidechainEntryInput): Promise<SidechainEntry> {
    await this.init();
    const entry: SidechainEntry = {
      v: ENTRY_VERSION,
      seq: this.nextSeq++,
      runId: this.runId,
      createdAt: input.createdAt ?? new Date().toISOString(),
      role: input.role,
      content: redactSecrets(input.content),
    };
    if (input.toolName !== undefined) entry.toolName = input.toolName;

    await fs.mkdir(subagentsDir(this.workspaceRoot), { recursive: true });
    await fs.appendFile(this.file(), JSON.stringify(entry) + "\n", {
      encoding: "utf8",
      flag: "a",
    });
    return entry;
  }
}

/**
 * Read + parse the whole sidechain for `runId`. Tolerates a torn final line
 * (a crash mid-append), skips corrupt interior rows, and quarantines rows whose
 * `runId` does not match (foreign rows), rather than throwing. Missing log →
 * `[]`. `assertSafeId` is enforced before any path is built.
 */
export async function readSidechain(
  workspaceRoot: string,
  runId: string,
): Promise<SidechainEntry[]> {
  assertSafeId(runId);
  let raw: string;
  try {
    raw = await fs.readFile(sidechainFile(workspaceRoot, runId), "utf8");
  } catch {
    return [];
  }
  const out: SidechainEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue; // blank / trailing newline
    let e: unknown;
    try {
      e = JSON.parse(line);
    } catch {
      // Torn trailing line or corrupt interior line — skip, keep the rest.
      continue;
    }
    if (!isValidEntry(e) || e.runId !== runId) continue; // quarantine foreign/bad rows
    out.push(e);
  }
  return out;
}

function isValidEntry(e: unknown): e is SidechainEntry {
  if (!e || typeof e !== "object") return false;
  const r = e as Record<string, unknown>;
  return (
    r.v === ENTRY_VERSION &&
    typeof r.seq === "number" &&
    typeof r.runId === "string" &&
    typeof r.createdAt === "string" &&
    (r.role === "system" || r.role === "user" || r.role === "assistant" || r.role === "tool") &&
    typeof r.content === "string" &&
    (r.toolName === undefined || typeof r.toolName === "string")
  );
}

/**
 * Compact, model-safe stats over a set of entries — the kind of quarantined
 * metadata the parent may keep about a subagent run without ever ingesting the
 * transcript itself.
 */
export function sidechainStats(entries: SidechainEntry[]): SidechainStats {
  const byRole: Record<string, number> = {};
  for (const e of entries) byRole[e.role] = (byRole[e.role] ?? 0) + 1;
  return { entries: entries.length, byRole };
}
