import { promises as fs } from "node:fs";
import path from "node:path";
import { assertSafeId } from "../workspace/paths.js";
import type { AgentMessage } from "../providers/types.js";
import type { Todo } from "../tools/types.js";
import type { ApprovalMode } from "../config/config.js";
import type { CheckpointFile } from "./checkpoints.js";
import type { SubagentRunRecord } from "../subagents/types.js";
import type { BriefRunRecord } from "../context/explorerBrief.js";
import type { PlanRunRecord } from "../context/planBrief.js";
import type { SessionGoal } from "./goal.js";

export interface PersistedSession {
  id: string;
  /** Provider + baseUrl are persisted so resume can detect a backend change. */
  provider?: string;
  baseUrl?: string;
  model: string;
  mode: ApprovalMode;
  messages: AgentMessage[];
  todos: Todo[];
  readTracker: string[];
  /** Human-readable session label, set via /title or --title. Optional; absent in pre-title sessions. */
  title?: string;
  /** Absolute real paths the agent has mutated (for checkpoint scoping). */
  writeTracker?: string[];
  /** Not-yet-finalized checkpoint pre-images (manual mode survives a restart). */
  pendingCheckpoint?: CheckpointFile[];
  /** Subagent run records — audit metadata, NOT part of model context. */
  reviews?: SubagentRunRecord[];
  /** Explorer brief records — quarantined metadata, NOT part of model context. */
  briefs?: BriefRunRecord[];
  /** Architect plan records — quarantined metadata, NOT part of model context. */
  plans?: PlanRunRecord[];
  activatedSkills?: import("../skills/types.js").ActivatedSkillRecord[];
  /** Phase 10C — session usage/cost telemetry. Absent in pre-10C sessions (loads as undefined). */
  telemetry?: import("../telemetry/sessionTelemetry.js").SessionTelemetry;
  /** Phase 10E — auditable web trace. Absent in pre-10E sessions (loads as undefined). */
  webTrace?: import("../web/trace.js").WebTraceRecord[];
  /** Phase 10M — persistent session goal. Absent in pre-10M sessions (loads as undefined). */
  goal?: SessionGoal;
  createdAt: string;
  updatedAt: string;
  /** Phase 10 — soft-delete: archived sessions are hidden by default. */
  archived?: boolean;
}

/** Live snapshot the REPL hands to the store on each save. */
export interface SessionSnapshot {
  provider: string;
  baseUrl: string;
  model: string;
  mode: ApprovalMode;
  messages: AgentMessage[];
  todos: Todo[];
  readTracker: Set<string>;
  title?: string;
  writeTracker: Set<string>;
  pendingCheckpoint: CheckpointFile[];
  reviews: SubagentRunRecord[];
  briefs: BriefRunRecord[];
  plans: PlanRunRecord[];
  activatedSkills: import("../skills/types.js").ActivatedSkillRecord[];
  telemetry?: import("../telemetry/sessionTelemetry.js").SessionTelemetry;
  webTrace?: import("../web/trace.js").WebTraceRecord[];
  /** Phase 10M — persistent session goal. */
  goal?: import("./goal.js").SessionGoal;
}

function sessionsDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".deepcoder", "sessions");
}

export function newSessionId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `${ts}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Bound to one session id; debounced-free, simple atomic-ish JSON writes. */
export class SessionStore {
  readonly createdAt: string;
  constructor(
    private workspaceRoot: string,
    readonly id: string,
    createdAt?: string,
  ) {
    this.createdAt = createdAt ?? new Date().toISOString();
  }

  private file(): string {
    return path.join(sessionsDir(this.workspaceRoot), `${this.id}.json`);
  }

  async save(snapshot: SessionSnapshot): Promise<void> {
    const data: PersistedSession = {
      id: this.id,
      provider: snapshot.provider,
      baseUrl: snapshot.baseUrl,
      model: snapshot.model,
      mode: snapshot.mode,
      messages: snapshot.messages,
      todos: snapshot.todos,
      readTracker: [...snapshot.readTracker],
      writeTracker: [...(snapshot.writeTracker ?? [])],
      pendingCheckpoint: snapshot.pendingCheckpoint ?? [],
      reviews: snapshot.reviews ?? [],
      briefs: snapshot.briefs ?? [],
      plans: snapshot.plans ?? [],
      activatedSkills: snapshot.activatedSkills ?? [],
      telemetry: snapshot.telemetry,
      webTrace: snapshot.webTrace,
      goal: snapshot.goal,
      title: snapshot.title,
      createdAt: this.createdAt,
      updatedAt: new Date().toISOString(),
    };
    await fs.mkdir(sessionsDir(this.workspaceRoot), { recursive: true });
    // Atomic write: a crash mid-write leaves the temp file, never a half-written
    // session. rename() is atomic on the same filesystem.
    const tmp = `${this.file()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await fs.rename(tmp, this.file());
  }
}

export async function loadSession(workspaceRoot: string, id: string): Promise<PersistedSession> {
  const file = path.join(sessionsDir(workspaceRoot), `${assertSafeId(id)}.json`);
  return JSON.parse(await fs.readFile(file, "utf8")) as PersistedSession;
}

export interface SessionMeta {
  id: string;
  updatedAt: string;
  messageCount: number;
  title?: string;
  archived?: boolean;
}

export async function listSessions(
  workspaceRoot: string,
  opts?: { includeArchived?: boolean },
): Promise<SessionMeta[]> {
  let files: string[];
  try {
    files = (await fs.readdir(sessionsDir(workspaceRoot))).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const metas: SessionMeta[] = [];
  for (const f of files) {
    try {
      const s = JSON.parse(await fs.readFile(path.join(sessionsDir(workspaceRoot), f), "utf8")) as PersistedSession;
      metas.push({ id: s.id, updatedAt: s.updatedAt, messageCount: s.messages.length, title: s.title, archived: s.archived });
    } catch {
      // skip corrupt files
    }
  }
  let filtered = metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (!opts?.includeArchived) {
    filtered = filtered.filter((m) => !m.archived);
  }
  return filtered;
}

export async function deleteSession(root: string, id: string): Promise<void> {
  const file = path.join(sessionsDir(root), `${assertSafeId(id)}.json`);
  await fs.rm(file, { force: true });
}

export async function archiveSession(root: string, id: string): Promise<void> {
  const session = await loadSession(root, id);
  session.archived = true;
  const file = path.join(sessionsDir(root), `${assertSafeId(id)}.json`);
  // Atomic write (same pattern as SessionStore.save)
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(session, null, 2), "utf8");
  await fs.rename(tmp, file);
}

export async function latestSessionId(workspaceRoot: string): Promise<string | null> {
  const all = await listSessions(workspaceRoot);
  return all[0]?.id ?? null;
}

/**
 * Fork an existing session to a new id. The original session is never mutated.
 * Checkpoints, reviews, briefs, telemetry, and web trace are cleared in the copy.
 */
export async function forkSession(root: string, id: string): Promise<string> {
  const original = await loadSession(root, id);
  const newId = newSessionId();
  const store = new SessionStore(root, newId);
  await store.save({
    provider: original.provider ?? "",
    baseUrl: original.baseUrl ?? "",
    model: original.model,
    mode: original.mode,
    messages: original.messages,
    todos: original.todos ?? [],
    readTracker: new Set(original.readTracker ?? []),
    writeTracker: new Set(original.writeTracker ?? []),
    pendingCheckpoint: [],
    reviews: [],
    briefs: [],
    plans: [],
    activatedSkills: [],
    telemetry: undefined,
    webTrace: undefined,
    goal: original.goal,
  });
  return newId;
}
