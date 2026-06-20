import { test } from "node:test";
import assert from "node:assert/strict";
import { VectorRecord } from "../../src/semantic/types.js";
import {
  cosineSimilarity,
  rankBySimilarity,
  hybridRank,
} from "../../src/semantic/search.js";

function makeMockRecord(id: string, vector: number[]): VectorRecord {
  return {
    chunk: {
      id,
      path: "src/test.ts",
      startLine: 1,
      endLine: 10,
      language: "typescript",
      kind: "file",
      textHash: "hash_" + id,
      embeddingHash: "",
    },
    vector,
  };
}

test("1. cosineSimilarity: identical, orthogonal, all-zero, mismatched-length, empty", () => {
  // Identical
  const v1 = [1, 2, 3];
  const v2 = [1, 2, 3];
  const simIdentical = cosineSimilarity(v1, v2);
  assert.ok(Math.abs(simIdentical - 1) < 1e-9, `Expected ~1, got ${simIdentical}`);

  // Orthogonal
  const vOrth1 = [1, 0];
  const vOrth2 = [0, 1];
  const simOrth = cosineSimilarity(vOrth1, vOrth2);
  assert.equal(simOrth, 0);

  // All-zero
  const vZero = [0, 0, 0];
  assert.equal(cosineSimilarity(vZero, v1), 0);
  assert.equal(cosineSimilarity(v1, vZero), 0);
  assert.equal(cosineSimilarity(vZero, vZero), 0);

  // Mismatched-length
  const vShort = [1, 2];
  assert.equal(cosineSimilarity(v1, vShort), 0);

  // Empty
  assert.equal(cosineSimilarity([], []), 0);
  assert.equal(cosineSimilarity([], v1), 0);

  // Null/undefined safety (even if types say otherwise, let's be safe)
  assert.equal(cosineSimilarity(null as any, v1), 0);
  assert.equal(cosineSimilarity(v1, undefined as any), 0);
});

test("2. rankBySimilarity: orders records by cosine DESC", () => {
  const records = [
    makeMockRecord("chunk-A", [1, 0, 0]), // orthogonal to query [0, 1, 0] -> sim 0
    makeMockRecord("chunk-B", [0, 1, 0]), // identical to query [0, 1, 0] -> sim 1
    makeMockRecord("chunk-C", [0, -1, 0]), // opposite to query [0, 1, 0] -> sim -1
  ];
  const query = [0, 1, 0];
  const results = rankBySimilarity(records, query, 10);

  assert.equal(results.length, 3);
  assert.equal(results[0].chunk.id, "chunk-B");
  assert.equal(results[0].score, 1);
  assert.equal(results[0].semanticScore, 1);
  assert.equal(results[0].lexicalScore, undefined);

  assert.equal(results[1].chunk.id, "chunk-A");
  assert.equal(results[1].score, 0);

  assert.equal(results[2].chunk.id, "chunk-C");
  assert.equal(results[2].score, -1);
});

test("3. topK bounds the result count", () => {
  const records = [
    makeMockRecord("chunk-1", [1, 0]),
    makeMockRecord("chunk-2", [0, 1]),
    makeMockRecord("chunk-3", [1, 1]),
    makeMockRecord("chunk-4", [-1, 0]),
    makeMockRecord("chunk-5", [0, -1]),
  ];
  const query = [1, 0];

  const res2 = rankBySimilarity(records, query, 2);
  assert.equal(res2.length, 2);

  const res0 = rankBySimilarity(records, query, 0);
  assert.deepEqual(res0, []);

  const resNeg = rankBySimilarity(records, query, -5);
  assert.deepEqual(resNeg, []);

  const resLarge = rankBySimilarity(records, query, 100);
  assert.equal(resLarge.length, 5);
});

test("4. Determinism: identical arrays and tie-break by chunk.id ASC", () => {
  // All records have identical vectors, so they will all have the same cosine similarity.
  const records = [
    makeMockRecord("chunk-Z", [1, 0]),
    makeMockRecord("chunk-A", [1, 0]),
    makeMockRecord("chunk-M", [1, 0]),
    makeMockRecord("chunk-B", [1, 0]),
  ];
  const query = [1, 0];

  const res1 = rankBySimilarity(records, query, 4);
  const res2 = rankBySimilarity(records, query, 4);

  // Check that they are identical
  assert.deepEqual(res1, res2);

  // Check that they are sorted by chunk.id ASC
  assert.equal(res1[0].chunk.id, "chunk-A");
  assert.equal(res1[1].chunk.id, "chunk-B");
  assert.equal(res1[2].chunk.id, "chunk-M");
  assert.equal(res1[3].chunk.id, "chunk-Z");
});

test("5. hybridRank: weight 1.0, 0.0, and in-between blending", () => {
  const records = [
    makeMockRecord("chunk-A", [1, 0]), // semantic similarity to [1, 0] is 1.0
    makeMockRecord("chunk-B", [0, 1]), // semantic similarity to [1, 0] is 0.0
  ];
  const query = [1, 0];
  const lexicalScores = {
    "chunk-A": 0.1,
    "chunk-B": 0.9,
  };

  // With lexicalWeight = 1.0, order should follow lexicalScores (chunk-B first)
  const resLexical = hybridRank(records, query, lexicalScores, { lexicalWeight: 1.0, topK: 2 });
  assert.equal(resLexical[0].chunk.id, "chunk-B");
  assert.equal(resLexical[0].score, 0.9);
  assert.equal(resLexical[0].lexicalScore, 0.9);
  assert.equal(resLexical[0].semanticScore, 0.0);

  assert.equal(resLexical[1].chunk.id, "chunk-A");
  assert.equal(resLexical[1].score, 0.1);
  assert.equal(resLexical[1].lexicalScore, 0.1);
  assert.equal(resLexical[1].semanticScore, 1.0);

  // With lexicalWeight = 0.0, order should follow semanticScore (chunk-A first)
  const resSemantic = hybridRank(records, query, lexicalScores, { lexicalWeight: 0.0, topK: 2 });
  assert.equal(resSemantic[0].chunk.id, "chunk-A");
  assert.equal(resSemantic[0].score, 1.0);
  assert.equal(resSemantic[0].lexicalScore, 0.1);
  assert.equal(resSemantic[0].semanticScore, 1.0);

  assert.equal(resSemantic[1].chunk.id, "chunk-B");
  assert.equal(resSemantic[1].score, 0.0);
  assert.equal(resSemantic[1].lexicalScore, 0.9);
  assert.equal(resSemantic[1].semanticScore, 0.0);

  // With lexicalWeight = 0.5, blend:
  // chunk-A score = 0.5 * 1.0 + 0.5 * 0.1 = 0.55
  // chunk-B score = 0.5 * 0.0 + 0.5 * 0.9 = 0.45
  // chunk-A should be first
  const resBlend = hybridRank(records, query, lexicalScores, { lexicalWeight: 0.5, topK: 2 });
  assert.equal(resBlend[0].chunk.id, "chunk-A");
  assert.equal(resBlend[0].score, 0.55);
  assert.equal(resBlend[1].chunk.id, "chunk-B");
  assert.equal(resBlend[1].score, 0.45);

  // With lexicalWeight = 0.9, blend:
  // chunk-A score = 0.1 * 1.0 + 0.9 * 0.1 = 0.19
  // chunk-B score = 0.1 * 0.0 + 0.9 * 0.9 = 0.81
  // chunk-B should be first
  const resBlend2 = hybridRank(records, query, lexicalScores, { lexicalWeight: 0.9, topK: 2 });
  assert.equal(resBlend2[0].chunk.id, "chunk-B");
  assert.equal(resBlend2[0].score, 0.81);
  assert.equal(resBlend2[1].chunk.id, "chunk-A");
  assert.equal(resBlend2[1].score, 0.19);

  // Clamping lexicalWeight:
  // weight 1.5 should clamp to 1.0
  const resClampHigh = hybridRank(records, query, lexicalScores, { lexicalWeight: 1.5, topK: 2 });
  assert.equal(resClampHigh[0].chunk.id, "chunk-B");
  assert.equal(resClampHigh[0].score, 0.9);

  // weight -0.5 should clamp to 0.0
  const resClampLow = hybridRank(records, query, lexicalScores, { lexicalWeight: -0.5, topK: 2 });
  assert.equal(resClampLow[0].chunk.id, "chunk-A");
  assert.equal(resClampLow[0].score, 1.0);
});

test("6. Empty records returns empty array", () => {
  const query = [1, 0];
  assert.deepEqual(rankBySimilarity([], query, 10), []);
  assert.deepEqual(hybridRank([], query, {}, { lexicalWeight: 0.5, topK: 10 }), []);
});
