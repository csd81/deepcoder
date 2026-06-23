import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { displayPath, resolveRealPathInWorkspace, assertSafeId } from "../workspace/paths.js";
import { isSensitivePath } from "../workspace/sensitive.js";
import { redactSecrets } from "../workspace/redact.js";

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
  // Paths whose pre-image looked like it held secrets and so were NOT captured
  // (see capture()). These edits are intentionally un-undoable; the list lets a
  // caller surface a warning that rollback won't restore them.
  private secretSkips = new Set<string>();

  constructor(private root: string) {}

  /** Paths skipped by secret detection in capture() — their edits are NOT undoable. */
  get skippedSecrets(): string[] {
    return [...this.secretSkips];
  }

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
    // Secret detection: if the pre-image looks like it contains secrets
    // (e.g., API keys), do NOT capture it — we never copy secret bytes into the
    // blob store. Because no `pending` entry is created, this file never enters
    // a manifest, so its edit is silently un-undoable (it will NOT appear as a
    // "skipped" rollback entry — rollback only sees manifest files). The path is
    // recorded in `secretSkips` so a caller can warn the user it can't be undone.
    if (redactSecrets(content.toString("utf8")) !== content.toString("utf8")) {
      this.secretSkips.add(rel);
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

// ── Recovery manifest ──────────────────────────────────────────────────────
// Written before Phase 2 of a rollback so a crash mid-rollback can be detected
// and completed on the next call.

const RECOVERY_FILE = "recovery.json";

async function writeRecoveryManifest(root: string, id: string, plan: Array<{ path: string; op: "restore" | "delete" }>): Promise<void> {
  const dir = path.join(checkpointsDir(root), id);
  // atomicWrite (temp + rename) so a crash mid-write can't leave a half-written
  // recovery.json that the next rollback would fail to JSON.parse.
  await atomicWrite(
    path.join(dir, RECOVERY_FILE),
    JSON.stringify({ checkpointId: id, files: plan }, null, 2),
  );
}

async function clearRecoveryManifest(root: string, id: string): Promise<void> {
  try {
    await fs.rm(path.join(checkpointsDir(root), id, RECOVERY_FILE), { force: true });
  } catch {
    // best-effort
  }
}

/** True iff a recovery.json exists AND parses to a well-formed plan. A corrupt
 *  manifest (crash mid-write) returns false so the caller can discard it rather
 *  than crashing on JSON.parse. */
async function recoveryManifestIsReadable(root: string, id: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(path.join(checkpointsDir(root), id, RECOVERY_FILE), "utf8");
    const parsed = JSON.parse(raw) as { files?: unknown };
    return Array.isArray(parsed.files);
  } catch {
    return false;
  }
}

export async function detectIncompleteRollback(root: string, id: string): Promise<boolean> {
  try {
    await fs.access(path.join(checkpointsDir(root), id, RECOVERY_FILE));
    return true;
  } catch {
    return false;
  }
}

/**
 * Undo a checkpoint. For each file: if the current content still matches the
 * post-run `expectedSha` (or the file is gone), apply the undo — restore the
 * pre-image, or delete a file the agent created. If it differs, the user
 * changed it after the run: refuse unless `force`.
 *
 * Crash recovery: before Phase 2 writes a recovery manifest. On a subsequent
 * call with the same id, the manifest is detected and Phase 2 is resumed.
 * After Phase 2 completes, the manifest is deleted.
 */
export async function rollback(root: string, id: string, opts: { force?: boolean } = {}): Promise<RollbackResult> {
  assertSafeId(id);

  // Crash recovery: if a previous rollback was interrupted, resume it. A
  // corrupt recovery.json (e.g. a crash mid-write) must not brick the rollback:
  // if it can't be parsed, discard it and fall through to a fresh forward
  // rollback instead of letting resumeRollback's JSON.parse throw.
  if (await detectIncompleteRollback(root, id)) {
    if (await recoveryManifestIsReadable(root, id)) {
      return resumeRollback(root, id, opts);
    }
    await clearRecoveryManifest(root, id);
  }

  const raw = await fs.readFile(path.join(checkpointsDir(root), id, "manifest.json"), "utf8");
  const manifest = JSON.parse(raw) as CheckpointManifest;
  const result: RollbackResult = { restored: [], deleted: [], conflicts: [], skipped: [] };

  // Phase 1: resolve targets and detect conflicts WITHOUT mutating anything, so
  // rollback is all-or-nothing — a conflict on a later file never leaves earlier
  // files half-rolled-back.
  const plan: Array<{ f: CheckpointFile; abs: string; current: string | null }> = [];
  for (const f of manifest.files) {
    if (isSensitivePath(f.path)) {
      result.skipped.push(f.path);
      continue;
    }
    let abs: string;
    try {
      abs = resolveRealPathInWorkspace(root, f.path);
    } catch {
      result.skipped.push(f.path);
      continue;
    }
    if (isSensitivePath(displayPath(root, abs))) {
      result.skipped.push(f.path);
      continue;
    }
    if (f.restoreSha && !/^[a-f0-9]{64}$/.test(f.restoreSha)) {
      result.skipped.push(f.path);
      continue;
    }
    const current = await shaOfFile(abs);
    if (current !== null && current !== f.expectedSha) result.conflicts.push(f.path);
    plan.push({ f, abs, current });
  }
  if (result.conflicts.length && !opts.force) {
    return result;
  }

  // Write recovery manifest before Phase 2 — crash recovery point.
  const recoveryOps = plan
    .filter((p) => !result.conflicts.includes(p.f.path) || opts.force)
    .map((p) => ({ path: p.f.path, op: p.f.existed ? "restore" as const : "delete" as const }));
  await writeRecoveryManifest(root, id, recoveryOps);

  // Phase 2: apply with per-file error handling.
  for (const { f, abs, current } of plan) {
    if (result.conflicts.includes(f.path) && !opts.force) continue;
    try {
      if (f.existed) {
        if (!f.restoreSha) {
          result.skipped.push(f.path);
          continue;
        }
        const content = await fs.readFile(path.join(checkpointsDir(root), "blobs", f.restoreSha));
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await ensureNotDirectory(abs);
        // Atomic write: temp file + rename prevents partial writes on crash.
        await atomicWrite(abs, content);
        result.restored.push(f.path);
      } else {
        if (current === null) {
          result.skipped.push(f.path);
          continue;
        }
        await fs.rm(abs, { force: true, recursive: true });
        result.deleted.push(f.path);
      }
    } catch (err) {
      result.skipped.push(f.path);
    }
  }

  // Recovery manifest cleared — Phase 2 is complete.
  await clearRecoveryManifest(root, id);
  return result;
}

/** Resume an interrupted rollback from its recovery manifest. */
async function resumeRollback(root: string, id: string, _opts: { force?: boolean }): Promise<RollbackResult> {
  const raw = await fs.readFile(path.join(checkpointsDir(root), id, RECOVERY_FILE), "utf8");
  const recovery = JSON.parse(raw) as { files: Array<{ path: string; op: "restore" | "delete" }> };
  const manifest = JSON.parse(
    await fs.readFile(path.join(checkpointsDir(root), id, "manifest.json"), "utf8"),
  ) as CheckpointManifest;
  const result: RollbackResult = { restored: [], deleted: [], conflicts: [], skipped: [] };

  for (const entry of recovery.files) {
    try {
      const f = manifest.files.find((mf) => mf.path === entry.path);
      if (!f) { result.skipped.push(entry.path); continue; }
      // Defense-in-depth, identical to the forward rollback path: a tampered
      // recovery.json/manifest must never restore/delete a sensitive path or a
      // malformed blob ref. (Previously the resume path trusted the manifest
      // blindly, reopening the forged-manifest threat the forward path defends.)
      if (isSensitivePath(f.path)) { result.skipped.push(entry.path); continue; }
      let abs: string;
      try {
        abs = resolveRealPathInWorkspace(root, f.path);
      } catch {
        result.skipped.push(entry.path); // resolves (via symlink) outside the workspace
        continue;
      }
      if (isSensitivePath(displayPath(root, abs))) { result.skipped.push(entry.path); continue; }
      if (f.restoreSha && !/^[a-f0-9]{64}$/.test(f.restoreSha)) { result.skipped.push(entry.path); continue; }
      if (entry.op === "restore") {
        if (!f.restoreSha) { result.skipped.push(entry.path); continue; }
        // Conflict re-check: only restore when the live file still matches the
        // agent's post-run state (expectedSha) or is already at the pre-image —
        // otherwise the user edited it after the crash; don't clobber it.
        const current = await shaOfFile(abs);
        if (current !== null && current !== f.expectedSha && current !== f.restoreSha) {
          result.conflicts.push(entry.path);
          continue;
        }
        const content = await fs.readFile(path.join(checkpointsDir(root), "blobs", f.restoreSha));
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await ensureNotDirectory(abs);
        await atomicWrite(abs, content);
        result.restored.push(entry.path);
      } else {
        await fs.rm(abs, { force: true, recursive: true });
        result.deleted.push(entry.path);
      }
    } catch {
      result.skipped.push(entry.path);
    }
  }

  await clearRecoveryManifest(root, id);
  return result;
}

// ── Pruning ─────────────────────────────────────────────────────────────────

/**
 * Keep the N most recent checkpoints and remove older ones.
 * Returns the list of pruned checkpoint IDs.
 */
export async function pruneCheckpoints(root: string, keep: number = 10): Promise<string[]> {
  const all = await listCheckpoints(root);
  const toRemove = all.slice(keep); // oldest after keep
  const removed: string[] = [];
  for (const cp of toRemove) {
    try {
      const dir = path.join(checkpointsDir(root), cp.id);
      await fs.rm(dir, { recursive: true, force: true });
      removed.push(cp.id);
    } catch {
      // skip corrupt entries
    }
  }
  return removed;
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
