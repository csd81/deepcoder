import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { displayPath, resolveRealPathInWorkspace } from "../workspace/paths.js";
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

function newCheckpointId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Collects pre-images for the current window. `capture()` is called by the
 * mutating tools before they write; first-write-wins per path. `finalize()`
 * writes a checkpoint and resets the window.
 */
export class CheckpointRecorder {
  private pending = new Map<string, { existed: boolean; restoreSha?: string }>();

  constructor(private root: string) {}

  get size(): number {
    return this.pending.size;
  }

  /** Capture the pre-image of `realAbs` (once). Skips sensitive paths. */
  async capture(realAbs: string): Promise<void> {
    const rel = displayPath(this.root, realAbs);
    if (this.pending.has(rel) || isSensitivePath(rel)) return;
    const content = await readFileOrNull(realAbs);
    if (content === null) {
      this.pending.set(rel, { existed: false });
      return;
    }
    const sha = sha256(content);
    await this.writeBlob(sha, content);
    this.pending.set(rel, { existed: true, restoreSha: sha });
  }

  /** Write the captured window as a checkpoint; returns its id, or null if empty. */
  async finalize(label?: string): Promise<string | null> {
    if (this.pending.size === 0) return null;
    const id = newCheckpointId();
    const files: CheckpointFile[] = [];
    for (const [rel, pre] of this.pending) {
      const abs = path.join(this.root, rel);
      const expectedSha = (await shaOfFile(abs)) ?? undefined;
      files.push({ path: rel, existed: pre.existed, restoreSha: pre.restoreSha, expectedSha });
    }
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
  const raw = await fs.readFile(path.join(checkpointsDir(root), id, "manifest.json"), "utf8");
  const manifest = JSON.parse(raw) as CheckpointManifest;
  const result: RollbackResult = { restored: [], deleted: [], conflicts: [], skipped: [] };

  for (const f of manifest.files) {
    let abs: string;
    try {
      abs = resolveRealPathInWorkspace(root, f.path);
    } catch {
      result.skipped.push(f.path); // would resolve outside the workspace now
      continue;
    }
    const current = await shaOfFile(abs);
    const changedSinceRun = current !== null && current !== f.expectedSha;
    if (changedSinceRun && !opts.force) {
      result.conflicts.push(f.path);
      continue;
    }

    if (f.existed) {
      // Restore the pre-image content. (Missing-now is restorable, not a conflict.)
      if (!f.restoreSha) {
        result.skipped.push(f.path);
        continue;
      }
      const content = await fs.readFile(path.join(checkpointsDir(root), "blobs", f.restoreSha));
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content);
      result.restored.push(f.path);
    } else {
      // The agent created this file → undo means delete it.
      if (current === null) {
        result.skipped.push(f.path); // already gone
        continue;
      }
      await fs.rm(abs, { force: true });
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
