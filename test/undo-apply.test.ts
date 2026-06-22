import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import { applyUndoEntry } from "../src/session/undoApply.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

async function seedBlob(root: string, content: string): Promise<string> {
  const h = sha(content);
  const dir = path.join(root, ".deepcoder", "checkpoints", "blobs");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, h), content);
  return h;
}

test("applyUndoEntry restores a pre-image and returns a reverse that redoes it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "undo-"));
  try {
    await writeFile(path.join(root, "a.txt"), "v2");          // current (post-edit)
    const preSha = await seedBlob(root, "v1");                // recorded pre-image

    const res = await applyUndoEntry(root, { label: "edit a", files: [{ path: "a.txt", existed: true, restoreSha: preSha }] });
    assert.deepEqual(res.restored, ["a.txt"]);
    assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "v1", "restored to pre-image");

    // The reverse re-applies the change (back to v2).
    const back = await applyUndoEntry(root, res.reverse);
    assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "v2", "reverse redoes the edit");
    void back;
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("applyUndoEntry deletes an agent-created file (existed:false) and reverse recreates it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "undo-"));
  try {
    await writeFile(path.join(root, "new.txt"), "created");   // agent created it this turn
    const res = await applyUndoEntry(root, { label: "create", files: [{ path: "new.txt", existed: false, restoreSha: null }] });
    assert.deepEqual(res.deleted, ["new.txt"]);
    await assert.rejects(() => stat(path.join(root, "new.txt")), "file deleted on undo");

    await applyUndoEntry(root, res.reverse);                  // redo
    assert.equal(await readFile(path.join(root, "new.txt"), "utf8"), "created", "reverse recreates the file");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("applyUndoEntry skips an out-of-workspace path (never writes outside)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "undo-"));
  try {
    const res = await applyUndoEntry(root, { label: "x", files: [{ path: "../escape.txt", existed: true, restoreSha: sha("x") }] });
    assert.deepEqual(res.skipped, ["../escape.txt"]);
    assert.equal(res.restored.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
