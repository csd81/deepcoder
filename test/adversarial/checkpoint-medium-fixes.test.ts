import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CheckpointRecorder, rollback } from "../../src/session/checkpoints.js";

async function ws(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "ckpt-med-"));
}
async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}
async function agentWrite(rec: CheckpointRecorder, abs: string, content: string): Promise<void> {
  await rec.capture(abs);
  await writeFile(abs, content, "utf8");
  await rec.recordPostWrite(abs);
}
const ckptDir = (root: string, id: string) => path.join(root, ".deepcoder", "checkpoints", id);

// ── Fix 1: writeRecoveryManifest is atomic, and a corrupt recovery.json is
// ignored rather than bricking that checkpoint's rollback. ──────────────────

test("a corrupt recovery.json does not brick rollback (graceful parse, falls back to normal rollback)", async () => {
  const root = await ws();
  const file = path.join(root, "a.txt");
  await writeFile(file, "ORIGINAL", "utf8");

  const rec = new CheckpointRecorder(root);
  await agentWrite(rec, file, "AGENT EDIT");
  const id = (await rec.finalize("t"))!;
  assert.ok(id);

  // Simulate a crash mid-write of recovery.json: half-written / corrupt JSON.
  await writeFile(path.join(ckptDir(root, id), "recovery.json"), '{"checkpointId":"', "utf8");

  // Rollback must NOT throw a JSON.parse SyntaxError. The corrupt recovery.json
  // is ignored and the forward rollback proceeds, restoring the original bytes.
  const res = await rollback(root, id);
  assert.deepEqual(res.restored, ["a.txt"]);
  assert.equal(await readFile(file, "utf8"), "ORIGINAL");
});

test("after a clean rollback no recovery.json .tmp file is left behind (atomic write)", async () => {
  const root = await ws();
  const file = path.join(root, "a.txt");
  await writeFile(file, "ORIGINAL", "utf8");

  const rec = new CheckpointRecorder(root);
  await agentWrite(rec, file, "AGENT EDIT");
  const id = (await rec.finalize("t"))!;

  await rollback(root, id);

  const dir = ckptDir(root, id);
  assert.equal(await exists(path.join(dir, "recovery.json")), false, "recovery cleared");
  assert.equal(await exists(path.join(dir, "recovery.json.tmp")), false, "no temp left behind");
});

// ── Fix 2: secret-skip is honest. A file whose pre-image looks like a secret
// is NOT captured (no pending entry, not undoable), and the caller can surface
// it via skippedSecrets. ────────────────────────────────────────────────────

test("a file with secret-looking content is not captured and is reported via skippedSecrets", async () => {
  const root = await ws();
  const file = path.join(root, "creds.txt");
  // Pre-image content that redactSecrets will alter (contains an API-key-shaped token).
  await writeFile(file, "DEEPSEEK_API_KEY=REDACTED_PLACEHOLDER_NOT_A_REAL_KEY", "utf8");

  const rec = new CheckpointRecorder(root);
  await agentWrite(rec, file, "agent rewrote it");

  // It is intentionally NOT in the manifest (un-undoable) — behavior unchanged.
  assert.equal(rec.size, 0);
  assert.equal(await rec.finalize(), null);

  // But the path is surfaced so the caller can warn the user it won't be undoable.
  assert.deepEqual(rec.skippedSecrets, ["creds.txt"]);
});

test("a normal file is captured and never appears in skippedSecrets", async () => {
  const root = await ws();
  const file = path.join(root, "a.txt");
  await writeFile(file, "ordinary content", "utf8");

  const rec = new CheckpointRecorder(root);
  await agentWrite(rec, file, "edited");

  assert.equal(rec.size, 1);
  assert.deepEqual(rec.skippedSecrets, []);
});
