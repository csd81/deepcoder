import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRepoIndex } from "../../src/index/scanner.js";
import { saveIndex, loadIndex, INDEX_DIR } from "../../src/index/store.js";

test("saveIndex/loadIndex round-trips and is atomic (no .tmp left behind)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "store-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");
    const idx = await buildRepoIndex(root, { symbols: true });
    await saveIndex(root, idx);
    const loaded = await loadIndex(root);
    assert.ok(loaded, "index loads back");
    assert.equal(loaded!.index.files.length, idx.files.length);
    assert.ok(loaded!.createdAt, "carries a build timestamp");
    // atomic write leaves no stray tmp file
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(path.join(root, INDEX_DIR));
    assert.ok(!entries.some((e) => e.endsWith(".tmp")), "no .tmp left behind");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadIndex returns null (never throws) on corrupt JSON or version mismatch", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "store-bad-"));
  try {
    const dir = path.join(root, INDEX_DIR);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "repo-index.json");
    await writeFile(file, "{ this is not json", "utf8");
    assert.equal(await loadIndex(root), null, "corrupt JSON → null");
    await writeFile(file, JSON.stringify({ version: 99, index: { files: [] } }), "utf8");
    assert.equal(await loadIndex(root), null, "version mismatch → null");
    // absent file → null
    await rm(file, { force: true });
    assert.equal(await loadIndex(root), null, "absent → null");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
