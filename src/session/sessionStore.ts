import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentMessage } from "../providers/types.js";
import type { Todo } from "../tools/types.js";
import type { ApprovalMode } from "../config/config.js";

export interface PersistedSession {
  id: string;
  model: string;
  mode: ApprovalMode;
  messages: AgentMessage[];
  todos: Todo[];
  readTracker: string[];
  createdAt: string;
  updatedAt: string;
}

/** Live snapshot the REPL hands to the store on each save. */
export interface SessionSnapshot {
  model: string;
  mode: ApprovalMode;
  messages: AgentMessage[];
  todos: Todo[];
  readTracker: Set<string>;
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
      model: snapshot.model,
      mode: snapshot.mode,
      messages: snapshot.messages,
      todos: snapshot.todos,
      readTracker: [...snapshot.readTracker],
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
  const file = path.join(sessionsDir(workspaceRoot), `${id}.json`);
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
