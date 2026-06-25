/**
 * Persistence for the session playbook — a plain, user-inspectable JSON file at
 * `.deepcoder/playbook/<sessionId>.json` (gitignored + protected from tool reads
 * by the sensitive-path guard). Atomic writes; loads are defensive (corrupt /
 * malformed JSON → empty playbook, never throws).
 */

import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { assertSafeId } from "../workspace/paths.js";
import type { PlaybookEntry } from "./playbook.js";

function playbookDir(root: string): string {
  return path.join(root, ".deepcoder", "playbook");
}

function playbookPath(root: string, sessionId: string): string {
  return path.join(playbookDir(root), `${assertSafeId(sessionId)}.json`);
}

function confined(root: string, file: string): string {
  const base = path.resolve(playbookDir(root));
  const resolved = path.resolve(file);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error("playbook path escapes the playbook directory");
  }
  return resolved;
}

function isEntry(v: unknown): v is PlaybookEntry {
  const e = v as PlaybookEntry;
  return (
    !!e &&
    typeof e.key === "string" &&
    typeof e.strategy === "string" &&
    typeof e.helpful === "number" &&
    typeof e.harmful === "number" &&
    typeof e.updatedAt === "string"
  );
}

/** Load a session's playbook; returns [] when absent or malformed. */
export async function loadPlaybook(root: string, sessionId: string): Promise<PlaybookEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(confined(root, playbookPath(root, sessionId)), "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
  } catch {
    return [];
  }
}

/** Atomically persist a session's playbook (tmp + rename). */
export async function savePlaybook(root: string, sessionId: string, entries: PlaybookEntry[]): Promise<void> {
  const file = confined(root, playbookPath(root, sessionId));
  await fs.mkdir(playbookDir(root), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(entries, null, 2), "utf8");
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}
