import { promises as fs } from "node:fs";
import path from "node:path";
import { assertSafeId } from "../workspace/paths.js";
import type { PersistedSession } from "./sessionStore.js";
import type { AgentMessage } from "../providers/types.js";
import type { Todo } from "../tools/types.js";
import type { ApprovalMode } from "../config/config.js";

/**
 * Append-oriented session storage (substrate for audit / replay / fork).
 *
 * Each session gets a `<id>.jsonl` event log alongside the legacy `<id>.json`
 * snapshot. During rollout this is a *shadow* write: the snapshot remains the
 * source of truth, and every save also appends only the events needed to carry
 * the session from its last projected state to the new snapshot. A pure
 * projector (`projectSession`) rebuilds a `PersistedSession` from the log; the
 * parity invariant (projection === snapshot) is what the tests lock down.
 *
 * The log is chronological and never truncated on normal save, so the
 * pre-compaction message history survives in the log even after the live
 * `messages` array is compacted in place.
 */

const EVENT_VERSION = 1 as const;

/** Low-frequency fields carried as whole-value replacement in a `meta_set`. */
export type SessionMetaPatch = Partial<
  Pick<
    PersistedSession,
    | "provider"
    | "baseUrl"
    | "model"
    | "pendingCheckpoint"
    | "reviews"
    | "briefs"
    | "plans"
    | "activatedSkills"
    | "telemetry"
    | "webTrace"
    | "goal"
    | "plan"
    | "contextSnapshot"
    | "archived"
    | "readTracker"
    | "writeTracker"
  >
>;

/** Event body (without the per-row envelope). */
export type SessionEventBody =
  | {
      type: "session_started";
      /** The session's creation time (distinct from the append timestamp). */
      sessionCreatedAt: string;
      provider?: string;
      baseUrl?: string;
      model: string;
      mode: ApprovalMode;
      title?: string;
    }
  | { type: "message_appended"; message: AgentMessage }
  /** Non-append message change (compaction splice, epoch reset, edit): full new array. */
  | { type: "messages_replaced"; messages: AgentMessage[] }
  | { type: "todos_set"; todos: Todo[] }
  | { type: "read_tracker_added"; paths: string[] }
  | { type: "write_tracker_added"; paths: string[] }
  | { type: "mode_changed"; mode: ApprovalMode }
  | { type: "title_changed"; title?: string }
  | { type: "meta_set"; patch: SessionMetaPatch }
  | { type: "session_archived" };

export interface SessionEventEnvelope {
  v: typeof EVENT_VERSION;
  seq: number;
  sessionId: string;
  /** When this event was appended (drives `updatedAt`). */
  createdAt: string;
}

export type SessionEvent = SessionEventEnvelope & SessionEventBody;

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// Projector: events -> PersistedSession
// ---------------------------------------------------------------------------

export interface ProjectionResult {
  session: PersistedSession | null;
  /** Highest applied seq (so an appender can continue monotonically). */
  lastSeq: number;
  /** Count of events skipped as duplicate/out-of-order/unknown (for diagnostics). */
  quarantined: number;
}

/**
 * Fold an ordered event list into a `PersistedSession`. Events whose `seq` does
 * not strictly increase are quarantined (skipped) rather than trusted — a
 * corrupt or replayed log must not silently produce a worse projection.
 * Returns `null` session when there is no usable `session_started`.
 */
export function projectSessionDetailed(events: SessionEvent[]): ProjectionResult {
  let s: PersistedSession | null = null;
  let lastSeq = 0;
  let quarantined = 0;
  // Sets accumulate from *_added events; serialized to arrays at the end.
  const reads = new Set<string>();
  const writes = new Set<string>();

  for (const e of events) {
    if (typeof e.seq !== "number" || e.seq <= lastSeq) {
      quarantined++;
      continue;
    }
    lastSeq = e.seq;

    if (e.type === "session_started") {
      s = {
        id: e.sessionId,
        provider: e.provider,
        baseUrl: e.baseUrl,
        model: e.model,
        mode: e.mode,
        messages: [],
        todos: [],
        readTracker: [],
        writeTracker: [],
        pendingCheckpoint: [],
        reviews: [],
        briefs: [],
        plans: [],
        activatedSkills: [],
        title: e.title,
        createdAt: e.sessionCreatedAt,
        updatedAt: e.createdAt,
      };
      reads.clear();
      writes.clear();
      continue;
    }
    if (!s) {
      // Event before session_started — cannot place it; quarantine.
      quarantined++;
      continue;
    }
    s.updatedAt = e.createdAt;

    switch (e.type) {
      case "message_appended":
        s.messages.push(e.message);
        break;
      case "messages_replaced":
        s.messages = [...e.messages];
        break;
      case "todos_set":
        s.todos = [...e.todos];
        break;
      case "read_tracker_added":
        for (const p of e.paths) reads.add(p);
        break;
      case "write_tracker_added":
        for (const p of e.paths) writes.add(p);
        break;
      case "mode_changed":
        s.mode = e.mode;
        break;
      case "title_changed":
        s.title = e.title;
        break;
      case "session_archived":
        s.archived = true;
        break;
      case "meta_set": {
        const p = e.patch;
        // readTracker/writeTracker replacements reset the accumulating sets.
        if (p.readTracker !== undefined) {
          reads.clear();
          for (const x of p.readTracker) reads.add(x);
        }
        if (p.writeTracker !== undefined) {
          writes.clear();
          for (const x of p.writeTracker) writes.add(x);
        }
        for (const [k, v] of Object.entries(p)) {
          if (k === "readTracker" || k === "writeTracker") continue;
          // `null` is the wire sentinel for "field cleared" (JSON cannot carry
          // undefined, so a clear must be explicit) — remove the key entirely.
          const bag = s as unknown as Record<string, unknown>;
          if (v === null) delete bag[k];
          else bag[k] = v;
        }
        break;
      }
    }
  }

  if (s) {
    s.readTracker = [...reads];
    s.writeTracker = [...writes];
  }
  return { session: s, lastSeq, quarantined };
}

export function projectSession(events: SessionEvent[]): PersistedSession | null {
  return projectSessionDetailed(events).session;
}

// ---------------------------------------------------------------------------
// Diff: prior projection + new snapshot -> minimal event bodies
// ---------------------------------------------------------------------------

/**
 * Compute the append events that carry `prev` (the last projected state, or
 * null for a brand-new log) to `next`. Message growth becomes
 * `message_appended`; any non-append message change collapses to one
 * `messages_replaced`. Low-frequency fields use whole-value replacement.
 *
 * The projector applied to (prev's events ++ these) must reproduce `next`
 * exactly — that parity is the acceptance test.
 */
export function diffSnapshotToEvents(
  prev: PersistedSession | null,
  next: PersistedSession,
): SessionEventBody[] {
  const out: SessionEventBody[] = [];

  if (!prev) {
    out.push({
      type: "session_started",
      sessionCreatedAt: next.createdAt,
      provider: next.provider,
      baseUrl: next.baseUrl,
      model: next.model,
      mode: next.mode,
      title: next.title,
    });
    for (const m of next.messages) out.push({ type: "message_appended", message: m });
    if (next.todos?.length) out.push({ type: "todos_set", todos: next.todos });
    if (next.readTracker?.length) out.push({ type: "read_tracker_added", paths: next.readTracker });
    if (next.writeTracker?.length) out.push({ type: "write_tracker_added", paths: next.writeTracker });
    const patch = metaPatch(null, next);
    if (Object.keys(patch).length) out.push({ type: "meta_set", patch });
    if (next.archived) out.push({ type: "session_archived" });
    return out;
  }

  // Messages: pure append (prev is a prefix of next) vs. anything else.
  if (!sameJson(prev.messages, next.messages)) {
    const isAppend =
      next.messages.length >= prev.messages.length &&
      prev.messages.every((m, i) => sameJson(m, next.messages[i]));
    if (isAppend) {
      for (let i = prev.messages.length; i < next.messages.length; i++) {
        out.push({ type: "message_appended", message: next.messages[i] });
      }
    } else {
      out.push({ type: "messages_replaced", messages: next.messages });
    }
  }

  if (!sameJson(prev.todos ?? [], next.todos ?? [])) {
    out.push({ type: "todos_set", todos: next.todos ?? [] });
  }

  trackerDiff(out, "read_tracker_added", "readTracker", prev.readTracker ?? [], next.readTracker ?? []);
  trackerDiff(out, "write_tracker_added", "writeTracker", prev.writeTracker ?? [], next.writeTracker ?? []);

  if (prev.mode !== next.mode) out.push({ type: "mode_changed", mode: next.mode });
  if ((prev.title ?? undefined) !== (next.title ?? undefined)) {
    out.push({ type: "title_changed", title: next.title });
  }
  if (next.archived && !prev.archived) out.push({ type: "session_archived" });

  const patch = metaPatch(prev, next);
  if (Object.keys(patch).length) out.push({ type: "meta_set", patch });

  return out;
}

function trackerDiff(
  out: SessionEventBody[],
  type: "read_tracker_added" | "write_tracker_added",
  field: "readTracker" | "writeTracker",
  prev: string[],
  next: string[],
): void {
  if (sameJson(prev, next)) return;
  const prevSet = new Set(prev);
  const removed = prev.some((p) => !next.includes(p));
  if (removed) {
    // Non-monotonic (a path disappeared) — fall back to whole-value replacement.
    out.push({ type: "meta_set", patch: { [field]: next } as SessionMetaPatch });
    return;
  }
  const added = next.filter((p) => !prevSet.has(p));
  if (added.length) out.push({ type, paths: added });
}

/** Whole-value diff of the low-frequency fields carried in `meta_set`. */
function metaPatch(prev: PersistedSession | null, next: PersistedSession): SessionMetaPatch {
  const patch: SessionMetaPatch = {};
  const fields: (keyof SessionMetaPatch)[] = [
    "provider",
    "baseUrl",
    "model",
    "pendingCheckpoint",
    "reviews",
    "briefs",
    "plans",
    "activatedSkills",
    "telemetry",
    "webTrace",
    "goal",
    "plan",
    "contextSnapshot",
  ];
  for (const f of fields) {
    const pv = prev ? prev[f] : undefined;
    if (sameJson(pv, next[f])) continue;
    if (next[f] === undefined) {
      if (pv === undefined) continue; // undefined→undefined: nothing to record
      // value→undefined: emit an explicit clear (null sentinel — JSON drops undefined).
      (patch as Record<string, unknown>)[f] = null;
    } else {
      (patch as Record<string, unknown>)[f] = next[f];
    }
  }
  return patch;
}

// ---------------------------------------------------------------------------
// Log I/O (append-only, path-confined, corruption-tolerant)
// ---------------------------------------------------------------------------

function sessionsDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".deepcoder", "sessions");
}

/**
 * Append-only JSONL log for one session. `assertSafeId` keeps the id from
 * escaping `.deepcoder/sessions`. Reads tolerate a torn final line (a crash
 * mid-append) by dropping any trailing line that does not parse.
 */
export class SessionEventLog {
  private nextSeq = 1;
  private inited = false;

  constructor(
    private workspaceRoot: string,
    readonly id: string,
  ) {
    assertSafeId(id);
  }

  private file(): string {
    return path.join(sessionsDir(this.workspaceRoot), `${this.id}.jsonl`);
  }

  /** Read + project the whole log. Missing log → null session, seq 0. */
  async read(): Promise<ProjectionResult> {
    const events = await this.readEvents();
    const res = projectSessionDetailed(events);
    this.nextSeq = res.lastSeq + 1;
    this.inited = true;
    return res;
  }

  /** Parse every complete line; drop a torn trailing line; skip bad rows. */
  async readEvents(): Promise<SessionEvent[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file(), "utf8");
    } catch {
      return [];
    }
    const lines = raw.split("\n");
    const events: SessionEvent[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue; // blank / trailing newline
      try {
        const e = JSON.parse(line) as SessionEvent;
        if (e && e.v === EVENT_VERSION && typeof e.seq === "number" && e.sessionId === this.id) {
          events.push(e);
        }
        // else: foreign/old-version row — skip (quarantine)
      } catch {
        // A parse failure on the LAST line is an expected torn write; on an
        // interior line it's corruption. Either way: skip, keep the rest.
      }
    }
    return events;
  }

  /**
   * Stamp bodies with a monotonic seq + envelope and append them as one
   * contiguous block. `O_APPEND` keeps concurrent appenders from interleaving
   * partial writes within a process.
   */
  async append(bodies: SessionEventBody[], now: string): Promise<void> {
    if (!bodies.length) return;
    if (!this.inited) await this.read();
    const rows: string[] = [];
    for (const body of bodies) {
      const e: SessionEvent = { v: EVENT_VERSION, seq: this.nextSeq++, sessionId: this.id, createdAt: now, ...body };
      rows.push(JSON.stringify(e));
    }
    await fs.mkdir(sessionsDir(this.workspaceRoot), { recursive: true });
    await fs.appendFile(this.file(), rows.join("\n") + "\n", { encoding: "utf8", flag: "a" });
  }
}

/**
 * Load a session by replaying its event log. Returns null when no log exists
 * (caller falls back to the legacy `.json` snapshot). `assertSafeId` is enforced
 * by `SessionEventLog`.
 */
export async function loadSessionFromEvents(
  workspaceRoot: string,
  id: string,
): Promise<PersistedSession | null> {
  const log = new SessionEventLog(workspaceRoot, id);
  const { session } = await log.read();
  return session;
}
