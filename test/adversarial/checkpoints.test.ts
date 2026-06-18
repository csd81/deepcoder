import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir, rename, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CheckpointRecorder, listCheckpoints, rollback } from "../../src/session/checkpoints.js";

async function ws(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "adv-ckpt-"));
}
async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

test("undo a modification restores the exact original bytes", async () => {
  const root = await ws();
  const file = path.join(root, "a.txt");
  await writeFile(file, "ORIGINAL", "utf8");

  const rec = new CheckpointRecorder(root);
  await rec.capture(file);                 // pre-image captured before edit
  await writeFile(file, "AGENT EDIT", "utf8"); // simulate the agent's write
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
  await rec.capture(file);                 // file does not exist yet → existed:false
  await writeFile(file, "created by agent", "utf8");
  const id = await rec.finalize();

  const res = await rollback(root, id!);
  assert.deepEqual(res.deleted, ["new.txt"]);
  assert.equal(await exists(file), false);
});

test("a file changed after the checkpoint is refused without --force, applied with it", async () => {
  const root = await ws();
  const file = path.join(root, "a.txt");
  await writeFile(file, "ORIGINAL", "utf8");
  const rec = new CheckpointRecorder(root);
  await rec.capture(file);
  await writeFile(file, "AGENT EDIT", "utf8");
  const id = await rec.finalize();

  // user edits the file after the run
  await writeFile(file, "USER EDIT", "utf8");

  const refused = await rollback(root, id!);
  assert.deepEqual(refused.conflicts, ["a.txt"]);
  assert.equal(await readFile(file, "utf8"), "USER EDIT", "must not be touched");

  const forced = await rollback(root, id!, { force: true });
  assert.deepEqual(forced.restored, ["a.txt"]);
  assert.equal(await readFile(file, "utf8"), "ORIGINAL");
});

test("manifests use workspace-relative paths and survive moving the repo dir", async () => {
  const root = await ws();
  const file = path.join(root, "src", "a.txt");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "v1", "utf8");
  const rec = new CheckpointRecorder(root);
  await rec.capture(file);
  await writeFile(file, "v2", "utf8");
  const id = await rec.finalize();

  // The manifest path is relative.
  const manifests = await listCheckpoints(root);
  assert.equal(manifests[0]!.files[0]!.path, "src/a.txt");

  // Move the whole workspace, then roll back at the new location.
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
  await rec.capture(env); // must be skipped
  assert.equal(rec.size, 0);
  const id = await rec.finalize();
  assert.equal(id, null, "nothing to finalize");
});

test("rollback only touches manifest files, never untracked siblings", async () => {
  const root = await ws();
  const a = path.join(root, "a.txt");
  const sibling = path.join(root, "sibling.txt");
  await writeFile(a, "orig", "utf8");
  await writeFile(sibling, "do not touch", "utf8");
  const rec = new CheckpointRecorder(root);
  await rec.capture(a);
  await writeFile(a, "edited", "utf8");
  const id = await rec.finalize();

  await rollback(root, id!);
  assert.equal(await readFile(sibling, "utf8"), "do not touch");
});

test("an empty window finalizes to null (off/manual no-op safety)", async () => {
  const root = await ws();
  const rec = new CheckpointRecorder(root);
  assert.equal(rec.size, 0);
  assert.equal(await rec.finalize(), null);
});
