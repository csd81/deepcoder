/**
 * Phase 8C (lazy slice) — ensureIndex: load a persisted index, or build + persist
 * one on demand so index-dependent features (targeting, /index impact|tests)
 * work without a manual `/index rebuild`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureIndex } from "../src/index/store.js";
import { loadIndex, saveIndex, INDEX_DIR } from "../src/index/store.js";
import type { RepoIndex } from "../src/index/types.js";

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ensure-idx-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "foo.ts"), "export const foo = 1;\n");
  await writeFile(path.join(root, "src", "foo.test.ts"), "import { foo } from './foo.js';\n");
  return root;
}

const ghost: RepoIndex = {
  root: "/x",
  files: [{ path: "GHOST.ts", kind: "code", lang: "ts" }],
  counts: { code: 1, test: 0, config: 0, docs: 0, generated: 0, other: 0 },
  symbols: [],
  imports: [],
};

test("ensureIndex builds and persists when no index exists", async () => {
  const root = await workspace();
  try {
    const idx = await ensureIndex(root);
    assert.ok(idx, "an index was returned");
    assert.ok(idx!.files.some((f) => f.path === "src/foo.ts"), "the built index reflects the real tree");
    // It was persisted: a fresh load finds it.
    const loaded = await loadIndex(root);
    assert.ok(loaded, "the built index was persisted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ensureIndex returns the existing persisted index without rebuilding", async () => {
  const root = await workspace();
  try {
    await saveIndex(root, ghost); // a marker index that does NOT match the real tree
    const idx = await ensureIndex(root);
    assert.deepEqual(
      idx!.files.map((f) => f.path),
      ["GHOST.ts"],
      "the persisted index was reused, not rebuilt",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ensureIndex with persist:false builds but does not write to disk", async () => {
  const root = await workspace();
  try {
    const idx = await ensureIndex(root, { persist: false });
    assert.ok(idx!.files.length > 0);
    assert.equal(await loadIndex(root), null, "nothing was persisted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ensureIndex rebuilds when the persisted index is older than maxStaleMs", async () => {
  const root = await workspace();
  try {
    // Write a stored index by hand with an ancient createdAt + the GHOST marker.
    await mkdir(path.join(root, INDEX_DIR), { recursive: true });
    await writeFile(
      path.join(root, INDEX_DIR, "repo-index.json"),
      JSON.stringify({ version: 1, createdAt: "2000-01-01T00:00:00.000Z", index: ghost }),
    );
    const idx = await ensureIndex(root, { maxStaleMs: 1000 });
    assert.ok(
      idx!.files.some((f) => f.path === "src/foo.ts"),
      "a stale index is rebuilt to reflect the real tree",
    );
    assert.ok(!idx!.files.some((f) => f.path === "GHOST.ts"), "the stale marker is gone");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ensureIndex includes import edges by default (for reverse-import targeting)", async () => {
  const root = await workspace();
  try {
    const idx = await ensureIndex(root);
    // foo.test.ts imports foo.ts → an edge should exist (imports default on).
    assert.ok(
      idx!.imports.some((e) => e.from === "src/foo.test.ts"),
      `expected an import edge from src/foo.test.ts, got ${JSON.stringify(idx!.imports)}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
