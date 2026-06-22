import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { displayPath, resolveRealPathInWorkspace, assertSafeId } from "../workspace/paths.js";
import { isSensitivePath } from "../workspace/sensitive.js";

/**
 * Local, git-free undo for agent edits. A checkpoint stores, per agent-touched
 * file, the content BEFORE the agent changed it (`restoreSha`/`existed`) plus
 * the post-edit `expectedSha` used to detect later user edits. Rollback undoes
 * the run: restoring modified files and deleting agent-created ones.
 */

export interface CheckpointFile {
  /** Workspace-relative path (survives moving the repo directory). */
  path: string;
  /** Did the file exist before the agent first touched it? */
  existed: boolean;
  /** sha256 of the pre-image content (present iff existed). */
  restoreSha?: string;
  /** sha256 of the content right after the run (for conflict detection). */
  expectedSha?: string;
}

export interface CheckpointManifest {
  id: string;
  label?: string;
  createdAt: string;
  files: CheckpointFile[];
}

export interface RollbackResult {
  restored: string[];
  deleted: string[];
  conflicts: string[];
  skipped: string[];
}

function checkpointsDir(root: string): string {
  return path.join(root, ".deepcoder", "checkpoints");
}

function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

async function shaOfFile(abs: string): Promise<string | null> {
  try {
    return sha256(await fs.readFile(abs));
  } catch {
    return null;
  }
}

/** Remove `abs` if it is currently a directory, so a file can be restored in its
 *  place without an EISDIR crash. No-op if it's absent or already a file. */
async function ensureNotDirectory(abs: string): Promise<void> {
  try {
    if ((await fs.lstat(abs)).isDirectory()) {
      await fs.rm(abs, { recursive: true, force: true });
    }
  } catch {
    // absent — nothing to clear
  }
}

function newCheckpointId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Collects pre-images for the current window. `capture()` is called by the
 * mutating tools before they write; first-write-wins per path. `finalize()`
 * writes a checkpoint and resets the window.
 */
export class CheckpointRecorder {
  // Keyed by workspace-relative path. `expectedSha` is filled in immediately
  // after the agent's write (recordPostWrite) — NOT at finalize — so a later
  // user edit can't masquerade as the agent's post-write state.
  private pending = new Map<string, CheckpointFile>();

  constructor(private root: string) {}

  /** Number of finalizable entries (those the agent actually wrote). */
  get size(): number {
    let n = 0;
    for (const e of this.pending.values()) if (e.expectedSha !== undefined) n++;
    return n;
  }

  /** Capture the pre-image of `realAbs` (once), before the agent writes it. */
  async capture(realAbs: string): Promise<void> {
    const rel = displayPath(this.root, realAbs);
    if (this.pending.has(rel) || isSensitivePath(rel)) return;
    const content = await readFileOrNull(realAbs);
    if (content === null) {
      this.pending.set(rel, { path: rel, existed: false });
      return;
    }
    const sha = sha256(content);
    await this.writeBlob(sha, content);
    this.pending.set(rel, { path: rel, existed: true, restoreSha: sha });
  }

  /** Record the agent's post-write content sha, immediately after a successful write. */
  async recordPostWrite(realAbs: string): Promise<void> {
    const rel = displayPath(this.root, realAbs);
    const entry = this.pending.get(rel);
    if (!entry || isSensitivePath(rel)) return;
    entry.expectedSha = (await shaOfFile(realAbs)) ?? undefined;
  }

  /** Persist/restore the pending window across process restarts (manual mode). */
  serialize(): CheckpointFile[] {
    return [...this.pending.values()];
  }
  load(entries: CheckpointFile[]): void {
    this.pending = new Map(entries.map((e) => [e.path, { ...e }]));
  }

  /** Write the captured window as a checkpoint; returns its id, or null if empty. */
  async finalize(label?: string): Promise<string | null> {
    // Only entries that were actually written (have expectedSha) are undoable.
    const files = [...this.pending.values()].filter((e) => e.expectedSha !== undefined);
    if (files.length === 0) return null;
    const id = newCheckpointId();
    const manifest: CheckpointManifest = { id, label, createdAt: new Date().toISOString(), files };
    const dir = path.join(checkpointsDir(this.root), id);
    await fs.mkdir(dir, { recursive: true });
    await atomicWrite(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
    this.pending.clear();
    return id;
  }

  private async writeBlob(sha: string, content: Buffer): Promise<void> {
    const blobs = path.join(checkpointsDir(this.root), "blobs");
    await fs.mkdir(blobs, { recursive: true });
    const file = path.join(blobs, sha);
    try {
      await fs.access(file); // content-addressed: skip if it already exists
    } catch {
      await atomicWrite(file, content);
    }
  }
}

export async function listCheckpoints(root: string): Promise<CheckpointManifest[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(checkpointsDir(root));
  } catch {
    return [];
  }
  const out: CheckpointManifest[] = [];
  for (const id of entries) {
    if (id === "blobs") continue;
    try {
      const raw = await fs.readFile(path.join(checkpointsDir(root), id, "manifest.json"), "utf8");
      out.push(JSON.parse(raw) as CheckpointManifest);
    } catch {
      // skip corrupt checkpoint dirs
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Undo a checkpoint. For each file: if the current content still matches the
 * post-run `expectedSha` (or the file is gone), apply the undo — restore the
 * pre-image, or delete a file the agent created. If it differs, the user
 * changed it after the run: refuse unless `force`.
 */
export async function rollback(root: string, id: string, opts: { force?: boolean } = {}): Promise<RollbackResult> {
  assertSafeId(id);
  const raw = await fs.readFile(path.join(checkpointsDir(root), id, "manifest.json"), "utf8");
  const manifest = JSON.parse(raw) as CheckpointManifest;
  const result: RollbackResult = { restored: [], deleted: [], conflicts: [], skipped: [] };

  // Phase 1: resolve targets and detect conflicts WITHOUT mutating anything, so
  // rollback is all-or-nothing — a conflict on a later file never leaves earlier
  // files half-rolled-back.
  const plan: Array<{ f: CheckpointFile; abs: string; current: string | null }> = [];
  for (const f of manifest.files) {
    // Defense-in-depth against a TAMPERED manifest: never restore/delete a
    // sensitive path. The capture side already excludes these, so a legitimate
    // checkpoint never contains one — a sensitive entry here is an attack.
    if (isSensitivePath(f.path)) {
      result.skipped.push(f.path);
      continue;
    }
    let abs: string;
    try {
      abs = resolveRealPathInWorkspace(root, f.path);
    } catch {
      result.skipped.push(f.path); // would resolve outside the workspace now
      continue;
    }
    // Re-check the normalized, resolved path so `sub/../.env` or a symlinked
    // alias can't slip a sensitive target past the raw-string check above.
    if (isSensitivePath(displayPath(root, abs))) {
      result.skipped.push(f.path);
      continue;
    }
    if (f.restoreSha && !/^[a-f0-9]{64}$/.test(f.restoreSha)) {
      result.skipped.push(f.path); // malformed blob ref — never join it into a path
      continue;
    }
    const current = await shaOfFile(abs);
    if (current !== null && current !== f.expectedSha) result.conflicts.push(f.path);
    plan.push({ f, abs, current });
  }
  if (result.conflicts.length && !opts.force) {
    return result; // refuse the whole rollback; nothing mutated
  }

  // Phase 2: apply.
  for (const { f, abs, current } of plan) {
    if (result.conflicts.includes(f.path) && !opts.force) continue;
    if (f.existed) {
      if (!f.restoreSha) {
        result.skipped.push(f.path);
        continue;
      }
      const content = await fs.readFile(path.join(checkpointsDir(root), "blobs", f.restoreSha));
      await fs.mkdir(path.dirname(abs), { recursive: true });
      // If the path was replaced by a directory, writeFile would EISDIR-crash
      // mid-rollback. Remove the directory first so the file can be restored.
      await ensureNotDirectory(abs);
      await fs.writeFile(abs, content);
      result.restored.push(f.path);
    } else {
      if (current === null) {
        result.skipped.push(f.path); // already gone
        continue;
      }
      // recursive: a file replaced by a directory must still be removable
      // (plain rm throws EISDIR/ERR_FS_EISDIR on a directory).
      await fs.rm(abs, { force: true, recursive: true });
      result.deleted.push(f.path);
    }
  }
  return result;
}

async function readFileOrNull(abs: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(abs);
  } catch {
    return null;
  }
}

async function atomicWrite(file: string, data: Buffer | string): Promise<void> {
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}
