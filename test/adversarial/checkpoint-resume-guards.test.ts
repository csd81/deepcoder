import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CheckpointRecorder, rollback, listCheckpoints, pruneCheckpoints } from "../../src/session/checkpoints.js";

async function ws(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "ckpt-resume-"));
}
async function agentWrite(rec: CheckpointRecorder, abs: string, content: string): Promise<void> {
  await rec.capture(abs);
  await writeFile(abs, content, "utf8");
  await rec.recordPostWrite(abs);
}
const ckptDir = (root: string, id: string) => path.join(root, ".deepcoder", "checkpoints", id);

test("resumeRollback re-checks sensitive paths: a forged recovery.json cannot overwrite .env", async () => {
  const root = await ws();
  await writeFile(path.join(root, ".env"), "REAL_SECRET", "utf8");
  await writeFile(path.join(root, "a.txt"), "ORIG", "utf8");

  // A legit checkpoint of a.txt → creates a real blob (content "ORIG") + manifest.
  const rec = new CheckpointRecorder(root);
  await agentWrite(rec, path.join(root, "a.txt"), "EDIT");
  const id = (await rec.finalize("t"))!;
  assert.ok(id);

  const dir = ckptDir(root, id);
  const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
  const aEntry = manifest.files.find((f: { path: string }) => f.path === "a.txt");
  const blobSha = aEntry.restoreSha; // blob holds "ORIG"

  // ── Forge an interrupted-rollback state: a recovery manifest + a tampered
  // manifest entry that restores `.env` from the "ORIG" blob (an attack).
  manifest.files.push({ path: ".env", existed: true, restoreSha: blobSha, expectedSha: blobSha });
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest), "utf8");
  await writeFile(
    path.join(dir, "recovery.json"),
    JSON.stringify({ checkpointId: id, files: [{ path: ".env", op: "restore" }, { path: "a.txt", op: "restore" }] }),
    "utf8",
  );

  const res = await rollback(root, id); // detects recovery.json → resumeRollback
  // .env must be untouched (sensitive-path defense-in-depth on the resume path).
  assert.equal(await readFile(path.join(root, ".env"), "utf8"), "REAL_SECRET");
  assert.ok(res.skipped.includes(".env"), "the sensitive entry must be skipped on resume");
  // The legit file still resumes.
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "ORIG");
  assert.ok(res.restored.includes("a.txt"));
});

test("pruneCheckpoints keeps the N most recent and removes older ones", async () => {
  const root = await ws();
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) {
    const rec = new CheckpointRecorder(root);
    await agentWrite(rec, path.join(root, `f${i}.txt`), `v${i}`);
    ids.push((await rec.finalize(`t${i}`))!);
  }
  assert.equal((await listCheckpoints(root)).length, 4);
  const removed = await pruneCheckpoints(root, 2);
  assert.equal(removed.length, 2, "two oldest pruned");
  assert.equal((await listCheckpoints(root)).length, 2);
});
