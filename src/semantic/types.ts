export interface SemanticChunk {
  id: string;            // stable: derived from path + startLine + textHash
  path: string;          // workspace-relative
  startLine: number;     // 1-based, inclusive
  endLine: number;       // 1-based, inclusive (>= startLine)
  language: string;      // inferred from extension, e.g. "typescript","python","markdown","text"
  kind: "symbol" | "section" | "file";
  textHash: string;      // sha256 hex of the chunk text
  embeddingHash: string; // "" in slice 1 (not embedded yet)
  summary?: string;
}
export interface EmbeddingProvider {        // interface only; no implementation in slice 1
  embed(input: string[]): Promise<number[][]>;
  dimensions(): number | null;
  label(): string;
}
export interface ChunkOptions {
  maxChunkBytes?: number;  // default 4000
  maxFileBytes?: number;   // default 262144
  // Optional symbol boundaries (e.g. from the 8C repo index). 1-based lines.
  symbols?: { name: string; startLine: number; endLine: number }[];
}

export interface VectorManifest {
  providerLabel: string;      // e.g. "ollama/nomic-embed-text" — NEVER a key
  model: string;
  dimensions: number | null;
  createdAt: string;          // ISO
  chunkCount: number;
  repoIndexHash?: string;
}
export interface VectorRecord { chunk: SemanticChunk; vector: number[]; }

