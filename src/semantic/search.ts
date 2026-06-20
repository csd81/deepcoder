import { SemanticChunk, VectorRecord } from "./types.js";

export interface ScoredChunk {
  chunk: SemanticChunk;
  score: number;            // final ranking score in [0,1]-ish
  semanticScore: number;    // cosine similarity
  lexicalScore?: number;    // present for hybrid
}

/**
 * Computes the standard cosine similarity between two vectors.
 * If either vector is all-zero or lengths differ, returns 0 (never NaN, never throw).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length || a.length === 0) {
    return 0;
  }
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const valA = a[i];
    const valB = b[i];
    dotProduct += valA * valB;
    normA += valA * valA;
    normB += valB * valB;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  const similarity = dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  if (Number.isNaN(similarity)) {
    return 0;
  }
  return similarity;
}

/**
 * Scores each record by cosineSimilarity(record.vector, queryVector);
 * sorts DESC by score, tie-breaks by chunk.id ASC (deterministic);
 * returns at most topK (topK <= 0 -> []).
 * semanticScore === score here; lexicalScore omitted.
 */
export function rankBySimilarity(
  records: VectorRecord[],
  queryVector: number[],
  topK: number
): ScoredChunk[] {
  if (topK <= 0) {
    return [];
  }
  const scored: ScoredChunk[] = records.map((record) => {
    const sim = cosineSimilarity(record.vector, queryVector);
    return {
      chunk: record.chunk,
      score: sim,
      semanticScore: sim,
    };
  });

  scored.sort((a, b) => {
    if (a.score !== b.score) {
      return b.score - a.score;
    }
    if (a.chunk.id < b.chunk.id) return -1;
    if (a.chunk.id > b.chunk.id) return 1;
    return 0;
  });

  return scored.slice(0, topK);
}

/**
 * Hybrid ranking combining semantic and lexical scores.
 * lexicalScores maps chunk.id -> a lexical score in [0,1] (0 when absent).
 * final score = (1 - lexicalWeight) * semanticScore + lexicalWeight * lexicalScore.
 * Clamps lexicalWeight to [0,1].
 * Sorts DESC, tie-breaks by chunk.id ASC, bounds to topK.
 * Each result includes semanticScore and lexicalScore.
 */
export function hybridRank(
  records: VectorRecord[],
  queryVector: number[],
  lexicalScores: Record<string, number>,
  opts: { lexicalWeight: number; topK: number }
): ScoredChunk[] {
  if (opts.topK <= 0) {
    return [];
  }
  const weight = Math.max(0, Math.min(1, opts.lexicalWeight));
  const scored: ScoredChunk[] = records.map((record) => {
    const semanticScore = cosineSimilarity(record.vector, queryVector);
    const lexicalScore = lexicalScores[record.chunk.id] ?? 0;
    const score = (1 - weight) * semanticScore + weight * lexicalScore;
    return {
      chunk: record.chunk,
      score,
      semanticScore,
      lexicalScore,
    };
  });

  scored.sort((a, b) => {
    if (a.score !== b.score) {
      return b.score - a.score;
    }
    if (a.chunk.id < b.chunk.id) return -1;
    if (a.chunk.id > b.chunk.id) return 1;
    return 0;
  });

  return scored.slice(0, opts.topK);
}
