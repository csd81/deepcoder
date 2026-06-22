import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir, rename, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CheckpointRecorder, listCheckpoints, rollback } from "../../src/session/checkpoints.js";

async function ws(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "adv-ckpt-"));
}
async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

/** Simulate the real tool flow: pre-image, write, post-write sha. */
async function agentWrite(rec: CheckpointRecorder, abs: string, content: string): Promise<void> {
  await rec.capture(abs);
  await writeFile(abs, content, "utf8");
  await rec.recordPostWrite(abs);
}

test("rollback restores a file replaced by a directory (no EISDIR crash)", async () => {
  const root = await ws();
  const file = path.join(root, "a.txt");
  await writeFile(file, "ORIGINAL", "utf8");

  const rec = new CheckpointRecorder(root);
  await agentWrite(rec, file, "AGENT EDIT");
  const id = await rec.finalize("t");
  assert.ok(id);

  // The user replaces the file with a (non-empty) directory after the run.
  await rm(file, { force: true });
  await mkdir(file);
  await writeFile(path.join(file, "inner.txt"), "x", "utf8");

  // Phase 2 must not crash with EISDIR; it removes the dir and restores bytes.
  const res = await rollback(root, id!, { force: true });
  assert.ok(res.restored.includes("a.txt"), "the original file should be restored");
  assert.equal(await readFile(file, "utf8"), "ORIGINAL");
});

test("undo a modification restores the exact original bytes", async () => {
  const root = await ws();
  const file = path.join(root, "a.txt");
  await writeFile(file, "ORIGINAL", "utf8");

  const rec = new CheckpointRecorder(root);
  await agentWrite(rec, file, "AGENT EDIT");
  const id = await rec.finalize("t");
  assert.ok(id);

  const res = await rollback(root, id!);
  assert.deepEqual(res.restored, ["a.txt"]);
  assert.equal(await readFile(file, "utf8"), "ORIGINAL");
});

test("undo a creation deletes the agent-created file", async () => {
  const root = await ws();
  const file = path.join(root, "new.txt");

  const rec = new CheckpointRecorder(root);
  await agentWrite(rec, file, "created by agent"); // file didn't exist → existed:false
  const id = await rec.finalize();

  const res = await rollback(root, id!);
  assert.deepEqual(res.deleted, ["new.txt"]);
  assert.equal(await exists(file), false);
});

test("conflict guard: a file changed after the run is refused without --force", async () => {
  const root = await ws();
  const file = path.join(root, "a.txt");
  await writeFile(file, "ORIGINAL", "utf8");
  const rec = new CheckpointRecorder(root);
  await agentWrite(rec, file, "AGENT EDIT");
  const id = await rec.finalize();

  await writeFile(file, "USER EDIT", "utf8"); // user edits after the run

  const refused = await rollback(root, id!);
  assert.deepEqual(refused.conflicts, ["a.txt"]);
  assert.equal(await readFile(file, "utf8"), "USER EDIT", "must not be touched");

  const forced = await rollback(root, id!, { force: true });
  assert.deepEqual(forced.restored, ["a.txt"]);
  assert.equal(await readFile(file, "utf8"), "ORIGINAL");
});

// --- Finding 2: the previously-broken case ---
test("a user edit BEFORE /checkpoint is detected as a conflict, not silently wiped", async () => {
  const root = await ws();
  const file = path.join(root, "a.txt");
  await writeFile(file, "ORIGINAL", "utf8");
  const rec = new CheckpointRecorder(root);
  await agentWrite(rec, file, "AGENT EDIT"); // expectedSha captured here (agent's write)

  // User edits the file, THEN the checkpoint is finalized (manual /checkpoint).
  await writeFile(file, "USER EDIT BEFORE CHECKPOINT", "utf8");
  const id = await rec.finalize();

  // Rollback must NOT silently restore the pre-image over the user's edit.
  const res = await rollback(root, id!);
  assert.deepEqual(res.conflicts, ["a.txt"]);
  assert.equal(await readFile(file, "utf8"), "USER EDIT BEFORE CHECKPOINT");
});

// --- Finding 3: pending window survives serialize/reload ---
test("pending pre-images survive serialize + reload (manual mode crash safety)", async () => {
  const root = await ws();
  const file = path.join(root, "a.txt");
  await writeFile(file, "ORIGINAL", "utf8");
  const rec = new CheckpointRecorder(root);
  await agentWrite(rec, file, "AGENT EDIT");

  // Persist the window, then reconstruct a fresh recorder from it (resume).
  const serialized = rec.serialize();
  assert.equal(serialized.length, 1);
  const rec2 = new CheckpointRecorder(root);
  rec2.load(serialized);
  assert.equal(rec2.size, 1);

  const id = await rec2.finalize("after-reload");
  assert.ok(id);
  const res = await rollback(root, id!);
  assert.deepEqual(res.restored, ["a.txt"]);
  assert.equal(await readFile(file, "utf8"), "ORIGINAL");
});

// --- Finding 1: a write captured before a failure is still finalizable ---
test("an entry captured before an error still finalizes (no lost rollback point)", async () => {
  const root = await ws();
  const file = path.join(root, "a.txt");
  await writeFile(file, "ORIGINAL", "utf8");
  const rec = new CheckpointRecorder(root);
  await agentWrite(rec, file, "AGENT EDIT"); // write succeeds...
  // ...then imagine the next provider call throws; finalize still runs (in finally).
  assert.equal(rec.size, 1);
  const id = await rec.finalize("auto:interrupted");
  assert.ok(id);
  assert.equal((await listCheckpoints(root))[0]!.label, "auto:interrupted");
});

test("manifests use workspace-relative paths and survive moving the repo dir", async () => {
  const root = await ws();
  const file = path.join(root, "src", "a.txt");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "v1", "utf8");
  const rec = new CheckpointRecorder(root);
  await agentWrite(rec, file, "v2");
  const id = await rec.finalize();

  const manifests = await listCheckpoints(root);
  assert.equal(manifests[0]!.files[0]!.path, "src/a.txt");

  const moved = root + "-moved";
  await rename(root, moved);
  const res = await rollback(moved, id!);
  assert.deepEqual(res.restored, ["src/a.txt"]);
  assert.equal(await readFile(path.join(moved, "src/a.txt"), "utf8"), "v1");
});

test("sensitive files are never captured into a checkpoint", async () => {
  const root = await ws();
  const env = path.join(root, ".env");
  await writeFile(env, "DEEPSEEK_API_KEY=sk-SECRETVALUE999", "utf8");
  const rec = new CheckpointRecorder(root);
  await agentWrite(rec, env, "still secret"); // capture + post-write both skip it
  assert.equal(rec.size, 0);
  assert.equal(await rec.finalize(), null);
});

test("rollback only touches manifest files, never untracked siblings", async () => {
  const root = await ws();
  const a = path.join(root, "a.txt");
  const sibling = path.join(root, "sibling.txt");
  await writeFile(a, "orig", "utf8");
  await writeFile(sibling, "do not touch", "utf8");
  const rec = new CheckpointRecorder(root);
  await agentWrite(rec, a, "edited");
  const id = await rec.finalize();

  await rollback(root, id!);
  assert.equal(await readFile(sibling, "utf8"), "do not touch");
});

// --- atomic rollback: a conflict on ONE file leaves ALL files untouched ---
test("rollback is all-or-nothing: one conflict blocks restore of the clean file too", async () => {
  const root = await ws();
  const a = path.join(root, "a.txt");
  const b = path.join(root, "b.txt");
  await writeFile(a, "A-ORIG", "utf8");
  await writeFile(b, "B-ORIG", "utf8");
  const rec = new CheckpointRecorder(root);
  await agentWrite(rec, a, "A-EDIT");
  await agentWrite(rec, b, "B-EDIT");
  const id = await rec.finalize();

  // User edits only b after the run → b conflicts, a is clean.
  await writeFile(b, "B-USER", "utf8");

  const res = await rollback(root, id!);
  assert.deepEqual(res.conflicts, ["b.txt"]);
  assert.deepEqual(res.restored, [], "no file restored when any conflicts");
  assert.equal(await readFile(a, "utf8"), "A-EDIT", "clean file must NOT be half-rolled-back");
  assert.equal(await readFile(b, "utf8"), "B-USER");
});

// --- a malformed restoreSha is never joined into a blob path ---
test("rollback skips a file whose manifest restoreSha is not a clean sha256", async () => {
  const root = await ws();
  const file = path.join(root, "a.txt");
  await writeFile(file, "v1", "utf8");
  const rec = new CheckpointRecorder(root);
  await agentWrite(rec, file, "v2");
  const id = await rec.finalize();

  // Tamper the manifest with a traversal-shaped restoreSha.
  const mpath = path.join(root, ".deepcoder", "checkpoints", id!, "manifest.json");
  const m = JSON.parse(await readFile(mpath, "utf8"));
  m.files[0].restoreSha = "../../../../etc/passwd";
  await writeFile(mpath, JSON.stringify(m), "utf8");

  const res = await rollback(root, id!);
  assert.deepEqual(res.skipped, ["a.txt"]);
  assert.deepEqual(res.restored, []);
  assert.equal(await readFile(file, "utf8"), "v2", "tampered ref must not restore anything");
});

test("an empty window finalizes to null", async () => {
  const root = await ws();
  const rec = new CheckpointRecorder(root);
  assert.equal(rec.size, 0);
  assert.equal(await rec.finalize(), null);
});

test("R1#10: a tampered manifest cannot restore or delete a sensitive path", async () => {
  const root = await ws();
  // Real secrets the agent must never be able to clobber via a forged checkpoint.
  await writeFile(path.join(root, ".env"), "REAL_SECRET=keep", "utf8");
  await mkdir(path.join(root, ".deepcoder"), { recursive: true });
  await writeFile(path.join(root, ".deepcoder", "config.json"), '{"keep":true}', "utf8");

  const id = "tampered-2026-01-01T00-00-00-000Z";
  const ckptDir = path.join(root, ".deepcoder", "checkpoints", id);
  await mkdir(path.join(root, ".deepcoder", "checkpoints", "blobs"), { recursive: true });
  await mkdir(ckptDir, { recursive: true });
  const fakeSha = "a".repeat(64);
  await writeFile(path.join(root, ".deepcoder", "checkpoints", "blobs", fakeSha), "PWNED-OVERWRITE", "utf8");
  // Forged manifest: restore .env from an attacker blob; delete .deepcoder/config.json.
  await writeFile(
    path.join(ckptDir, "manifest.json"),
    JSON.stringify({
      id,
      createdAt: "2026-01-01T00:00:00.000Z",
      files: [
        { path: ".env", existed: true, restoreSha: fakeSha, expectedSha: "b".repeat(64) },
        { path: ".deepcoder/config.json", existed: false, expectedSha: "c".repeat(64) },
      ],
    }),
    "utf8",
  );

  const res = await rollback(root, id, { force: true }); // even with --force
  assert.ok(res.skipped.includes(".env"), ".env must be skipped");
  assert.ok(res.skipped.includes(".deepcoder/config.json"), "sensitive config must be skipped");
  assert.deepEqual(res.restored, [], "no sensitive path restored");
  assert.deepEqual(res.deleted, [], "no sensitive path deleted");
  assert.equal(await readFile(path.join(root, ".env"), "utf8"), "REAL_SECRET=keep", ".env untouched");
  assert.equal(await exists(path.join(root, ".deepcoder", "config.json")), true, "config not deleted");
});
