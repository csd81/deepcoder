/**
 * Apply an {@link UndoEntry} by restoring each file to its recorded pre-image
 * (or deleting it if it didn't exist before), reusing the checkpoint blob store
 * (content-addressed by sha, written by CheckpointRecorder). Captures the CURRENT
 * content first and returns a REVERSE entry, so `/undo` and `/redo` can navigate
 * the same stack bidirectionally without a separate post-image store.
 */
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { resolveRealPathInWorkspace } from "../workspace/paths.js";
import { isSensitivePath } from "../workspace/sensitive.js";
import type { UndoEntry } from "../cli/undoRedo.js";

function blobPath(root: string, sha: string): string {
  return path.join(root, ".deepcoder", "checkpoints", "blobs", sha);
}

/** Write content to the content-addressed blob store; returns its sha. */
async function writeBlob(root: string, content: Buffer): Promise<string> {
  const sha = createHash("sha256").update(content).digest("hex");
  const file = blobPath(root, sha);
  await fs.mkdir(path.dirname(file), { recursive: true });
  try { await fs.access(file); } catch { await fs.writeFile(file, content); }
  return sha;
}

export interface UndoApplyResult {
  reverse: UndoEntry;
  restored: string[];
  deleted: string[];
  skipped: string[];
}

export async function applyUndoEntry(root: string, entry: UndoEntry): Promise<UndoApplyResult> {
  const restored: string[] = [];
  const deleted: string[] = [];
  const skipped: string[] = [];
  const reverseFiles: UndoEntry["files"] = [];

  for (const f of entry.files) {
    if (isSensitivePath(f.path)) { skipped.push(f.path); continue; }
    let abs: string;
    try { abs = resolveRealPathInWorkspace(root, f.path); } catch { skipped.push(f.path); continue; }

    // Snapshot the current content so the reverse entry can redo this change.
    let current: Buffer | null = null;
    try { current = await fs.readFile(abs); } catch { current = null; }
    reverseFiles.push({
      path: f.path,
      existed: current !== null,
      restoreSha: current !== null ? await writeBlob(root, current) : null,
    });

    // Restore the recorded pre-image (or delete a file that didn't exist before).
    if (f.existed && f.restoreSha) {
      const content = await fs.readFile(blobPath(root, f.restoreSha));
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content);
      restored.push(f.path);
    } else {
      try { await fs.rm(abs); deleted.push(f.path); } catch { /* already gone */ }
    }
  }

  return { reverse: { label: entry.label, files: reverseFiles }, restored, deleted, skipped };
}
