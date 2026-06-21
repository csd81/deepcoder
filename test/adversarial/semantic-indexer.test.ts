/**
 * Phase 8E — semantic index builder. Walks provided files, gates them via
 * shouldChunkFile, chunks via chunkFile, embeds each chunk's reconstructed text,
 * and persists a VectorStore via saveVectorStore. This is the missing producer
 * for the semantic-search tools (which only ever LOADED a pre-built store).
 *
 * RED ANCHOR: imports buildSemanticIndex from src/semantic/indexer.ts (new).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSemanticIndex } from "../../src/semantic/indexer.js";
import { loadVectorStore } from "../../src/semantic/store.js";

// Deterministic fake embedder: vector encodes text length (no network).
const fakeEmbed = async (texts: string[]): Promise<number[][]> =>
  texts.map((t) => [t.length, 1]);

const META = { providerLabel: "fake", model: "m", dimensions: 2 };

test("[8e-index-build] chunkable files are chunked, embedded, and persisted; sensitive files skipped", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "idx-"));
  try {
    const files = [
      { path: "src/a.ts", content: "export const x = 1;\nexport const y = 2;\n" },
      { path: ".env", content: "SECRET=abc123" },
    ];
    const res = await buildSemanticIndex({ root, files, embed: fakeEmbed, ...META });

    assert.ok(res.chunkCount >= 1, "at least one chunk produced from the .ts file");
    assert.ok(
      res.skipped.some((s) => s.path === ".env"),
      "the sensitive .env file is reported as skipped: " + JSON.stringify(res.skipped),
    );

    const loaded = await loadVectorStore(root);
    assert.ok(loaded, "a store was persisted");
    assert.equal(loaded!.records.length, res.chunkCount);
    for (const r of loaded!.records) {
      assert.ok(Array.isArray(r.vector) && r.vector.length === 2, "each record has its embedding vector");
      assert.equal(r.chunk.path, "src/a.ts");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("[8e-index-empty] no chunkable files → an empty store is written (chunkCount 0)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "idx-"));
  try {
    const res = await buildSemanticIndex({
      root,
      files: [{ path: ".env", content: "SECRET=1" }],
      embed: fakeEmbed,
      ...META,
    });
    assert.equal(res.chunkCount, 0);
    const loaded = await loadVectorStore(root);
    assert.ok(loaded, "an (empty) store is still persisted");
    assert.equal(loaded!.records.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("[8e-index-no-embed-on-empty] the embedder is not called when there are no chunks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "idx-"));
  try {
    let calls = 0;
    await buildSemanticIndex({
      root,
      files: [{ path: ".env", content: "SECRET=1" }],
      embed: async (t) => { calls++; return t.map(() => [0]); },
      ...META,
    });
    assert.equal(calls, 0, "no embedding call for an empty chunk set");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
