import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  saveVectorStore,
  loadVectorStore,
  isStoreStale,
  purgeVectorStore
} from "../../src/semantic/store.js";
import { VectorRecord } from "../../src/semantic/types.js";

const fakeRecords: VectorRecord[] = [
  {
    chunk: {
      id: "chunk-1",
      path: "src/foo.ts",
      startLine: 1,
      endLine: 10,
      language: "typescript",
      kind: "file",
      textHash: "hash1",
      embeddingHash: ""
    },
    vector: [0.1, 0.2, 0.3]
  },
  {
    chunk: {
      id: "chunk-2",
      path: "src/bar.ts",
      startLine: 5,
      endLine: 15,
      language: "typescript",
      kind: "symbol",
      textHash: "hash2",
      embeddingHash: ""
    },
    vector: [0.4, 0.5, 0.6]
  }
];

const fakeMeta = {
  providerLabel: "ollama/nomic-embed-text",
  model: "nomic-embed-text",
  dimensions: 3,
  repoIndexHash: "repo-hash-123"
};

test("1. save -> load round-trips the manifest and all records", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "semantic-store-"));
  try {
    const manifest = await saveVectorStore(root, fakeRecords, fakeMeta);

    assert.equal(manifest.providerLabel, fakeMeta.providerLabel);
    assert.equal(manifest.model, fakeMeta.model);
    assert.equal(manifest.dimensions, fakeMeta.dimensions);
    assert.equal(manifest.repoIndexHash, fakeMeta.repoIndexHash);
    assert.equal(manifest.chunkCount, fakeRecords.length);
    assert.ok(manifest.createdAt);

    const loaded = await loadVectorStore(root);
    assert.ok(loaded);
    assert.deepEqual(loaded.manifest, manifest);
    assert.deepEqual(loaded.records, fakeRecords);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("2. isStoreStale checks providerLabel, model, and dimensions", () => {
  const manifest = {
    providerLabel: "ollama/nomic-embed-text",
    model: "nomic-embed-text",
    dimensions: 3,
    createdAt: new Date().toISOString(),
    chunkCount: 2
  };

  // Same provider/model/dimensions -> false
  assert.equal(
    isStoreStale(manifest, {
      providerLabel: "ollama/nomic-embed-text",
      model: "nomic-embed-text",
      dimensions: 3
    }),
    false
  );

  // Different model -> true
  assert.equal(
    isStoreStale(manifest, {
      providerLabel: "ollama/nomic-embed-text",
      model: "different-model",
      dimensions: 3
    }),
    true
  );

  // Different dimensions -> true
  assert.equal(
    isStoreStale(manifest, {
      providerLabel: "ollama/nomic-embed-text",
      model: "nomic-embed-text",
      dimensions: 5
    }),
    true
  );

  // Different providerLabel -> true
  assert.equal(
    isStoreStale(manifest, {
      providerLabel: "openai/text-embedding-3-small",
      model: "nomic-embed-text",
      dimensions: 3
    }),
    true
  );
});

test("3. Corrupt store handling", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "semantic-store-corrupt-"));
  try {
    // Missing dir -> null
    const loadedMissing = await loadVectorStore(root);
    assert.equal(loadedMissing, null);

    // Save valid store first
    await saveVectorStore(root, fakeRecords, fakeMeta);

    const vectorsDir = path.join(root, ".deepcoder", "index", "vectors");
    const manifestPath = path.join(vectorsDir, "manifest.json");
    const vectorsPath = path.join(vectorsDir, "vectors.jsonl");

    // A garbage line appended to vectors.jsonl -> loadVectorStore SKIPS it and returns valid records
    await writeFile(vectorsPath, (await readFile(vectorsPath, "utf8")) + "\n{invalid json line\n", "utf8");
    const loadedWithGarbageLine = await loadVectorStore(root);
    assert.ok(loadedWithGarbageLine);
    assert.deepEqual(loadedWithGarbageLine.records, fakeRecords);

    // A garbage/empty manifest.json -> loadVectorStore returns null
    await writeFile(manifestPath, "{invalid json", "utf8");
    const loadedWithGarbageManifest = await loadVectorStore(root);
    assert.equal(loadedWithGarbageManifest, null);

    // Empty manifest.json -> loadVectorStore returns null
    await writeFile(manifestPath, "", "utf8");
    const loadedWithEmptyManifest = await loadVectorStore(root);
    assert.equal(loadedWithEmptyManifest, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("4. No secret leakage", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "semantic-store-leak-"));
  try {
    const secretKey = "sk-proj-1234567890abcdef1234567890abcdef";
    // We pass providerLabel and model, but NOT the secret key.
    // We want to verify that the secret key is never written to the files.
    await saveVectorStore(root, fakeRecords, {
      providerLabel: "openai/text-embedding-3-small",
      model: "text-embedding-3-small",
      dimensions: 1536
    });

    const vectorsDir = path.join(root, ".deepcoder", "index", "vectors");
    const manifestContent = await readFile(path.join(vectorsDir, "manifest.json"), "utf8");
    const vectorsContent = await readFile(path.join(vectorsDir, "vectors.jsonl"), "utf8");

    assert.ok(!manifestContent.includes(secretKey), "manifest must not contain secret key");
    assert.ok(!vectorsContent.includes(secretKey), "vectors must not contain secret key");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("5. purgeVectorStore deletes vectors/ but leaves sibling files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "semantic-store-purge-"));
  try {
    const indexDir = path.join(root, ".deepcoder", "index");
    await mkdir(indexDir, { recursive: true });

    // Write a sibling file
    const siblingPath = path.join(indexDir, "lexical.json");
    await writeFile(siblingPath, '{"lexical": true}', "utf8");

    // Save vector store
    await saveVectorStore(root, fakeRecords, fakeMeta);

    const vectorsDir = path.join(indexDir, "vectors");
    // Verify vectors directory exists
    const entriesBefore = await readdir(indexDir);
    assert.ok(entriesBefore.includes("vectors"));
    assert.ok(entriesBefore.includes("lexical.json"));

    // Purge vector store
    await purgeVectorStore(root);

    // Verify vectors directory is gone, but sibling file remains
    const entriesAfter = await readdir(indexDir);
    assert.ok(!entriesAfter.includes("vectors"));
    assert.ok(entriesAfter.includes("lexical.json"));

    // Purge on an absent store does not throw
    await purgeVectorStore(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("6. Atomic: no leftover *.tmp files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "semantic-store-atomic-"));
  try {
    await saveVectorStore(root, fakeRecords, fakeMeta);

    const vectorsDir = path.join(root, ".deepcoder", "index", "vectors");
    const entries = await readdir(vectorsDir);
    assert.ok(!entries.some((e) => e.endsWith(".tmp")), "no .tmp files left behind");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
