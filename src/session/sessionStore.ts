import { promises as fs } from "node:fs";
import path from "node:path";
import { assertSafeId } from "../workspace/paths.js";
import type { AgentMessage } from "../providers/types.js";
import type { Todo } from "../tools/types.js";
import type { ApprovalMode } from "../config/config.js";
import type { CheckpointFile } from "./checkpoints.js";
import type { SubagentRunRecord } from "../subagents/types.js";
import type { BriefRunRecord } from "../context/explorerBrief.js";

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
  /** Absolute real paths the agent has mutated (for checkpoint scoping). */
  writeTracker?: string[];
  /** Not-yet-finalized checkpoint pre-images (manual mode survives a restart). */
  pendingCheckpoint?: CheckpointFile[];
  /** Subagent run records — audit metadata, NOT part of model context. */
  reviews?: SubagentRunRecord[];
  /** Explorer brief records — quarantined metadata, NOT part of model context. */
  briefs?: BriefRunRecord[];
  activatedSkills?: import("../skills/types.js").ActivatedSkillRecord[];
  /** Phase 10C — session usage/cost telemetry. Absent in pre-10C sessions (loads as undefined). */
  telemetry?: import("../telemetry/sessionTelemetry.js").SessionTelemetry;
  createdAt: string;
  updatedAt: string;
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
  writeTracker: Set<string>;
  pendingCheckpoint: CheckpointFile[];
  reviews: SubagentRunRecord[];
  briefs: BriefRunRecord[];
  activatedSkills: import("../skills/types.js").ActivatedSkillRecord[];
  telemetry?: import("../telemetry/sessionTelemetry.js").SessionTelemetry;
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
      activatedSkills: snapshot.activatedSkills ?? [],
      telemetry: snapshot.telemetry,
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
}

export async function listSessions(workspaceRoot: string): Promise<SessionMeta[]> {
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
      metas.push({ id: s.id, updatedAt: s.updatedAt, messageCount: s.messages.length });
    } catch {
      // skip corrupt files
    }
  }
  return metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function latestSessionId(workspaceRoot: string): Promise<string | null> {
  const all = await listSessions(workspaceRoot);
  return all[0]?.id ?? null;
}
