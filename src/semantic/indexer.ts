/**
 * Phase 8E — semantic index builder.
 *
 * The missing producer for the semantic-search tools. The query side
 * (`semantic_search`/`hybrid_search`/`similar_code`) only ever LOADED a
 * pre-built vector store; nothing built one. This walks a set of files, gates
 * each through `shouldChunkFile`, splits them with `chunkFile`, embeds each
 * chunk's reconstructed text, and persists the result via `saveVectorStore`.
 *
 * Pure of IO except `saveVectorStore` and the injected `embed` function — the
 * caller supplies the file list (e.g. from `git ls-files`), which keeps this
 * deterministic and testable without touching the filesystem to read sources.
 */

import { shouldChunkFile, chunkFile } from "./chunker.js";
import { saveVectorStore } from "./store.js";
import type { ChunkOptions, SemanticChunk, VectorManifest, VectorRecord } from "./types.js";

export interface IndexFile {
  /** Workspace-relative path. */
  path: string;
  content: string;
  /** Optional symbol boundaries (e.g. from the 8C repo index) for symbol-aware chunking. */
  symbols?: ChunkOptions["symbols"];
}

export interface BuildSemanticIndexInput {
  root: string;
  files: IndexFile[];
  /** Embedding function — returns one vector per input text, in order. */
  embed: (texts: string[]) => Promise<number[][]>;
  providerLabel: string;
  model: string;
  dimensions: number | null;
  chunkOptions?: ChunkOptions;
  /** Optional repo-index hash recorded in the manifest for staleness checks. */
  repoIndexHash?: string;
}

export interface BuildSemanticIndexResult {
  manifest: VectorManifest;
  chunkCount: number;
  skipped: { path: string; reason: string }[];
}

/** Reconstruct a chunk's text from the file content via its 1-based line range. */
function chunkText(lines: string[], chunk: SemanticChunk): string {
  return lines.slice(chunk.startLine - 1, chunk.endLine).join("\n");
}

/**
 * Build and persist the semantic vector store for `files`. Skipped files (and
 * the reason) are reported but never abort the build. An empty chunk set still
 * writes a valid (empty) store and never calls `embed`.
 */
export async function buildSemanticIndex(
  input: BuildSemanticIndexInput,
): Promise<BuildSemanticIndexResult> {
  const skipped: { path: string; reason: string }[] = [];
  const pending: { chunk: SemanticChunk; text: string }[] = [];

  for (const file of input.files) {
    const opts: ChunkOptions = { ...input.chunkOptions, symbols: file.symbols ?? input.chunkOptions?.symbols };
    const gate = shouldChunkFile(file.path, file.content, opts);
    if (!gate.ok) {
      skipped.push({ path: file.path, reason: gate.reason ?? "skipped" });
      continue;
    }
    const chunks = chunkFile(file.path, file.content, opts);
    const lines = file.content.split("\n");
    for (const chunk of chunks) pending.push({ chunk, text: chunkText(lines, chunk) });
  }

  const meta = {
    providerLabel: input.providerLabel,
    model: input.model,
    dimensions: input.dimensions,
    repoIndexHash: input.repoIndexHash,
  };

  if (pending.length === 0) {
    const manifest = await saveVectorStore(input.root, [], meta);
    return { manifest, chunkCount: 0, skipped };
  }

  const vectors = await input.embed(pending.map((p) => p.text));
  if (vectors.length !== pending.length) {
    throw new Error(
      `Embedding count mismatch: expected ${pending.length} vectors, got ${vectors.length}.`,
    );
  }

  const records: VectorRecord[] = pending.map((p, i) => ({ chunk: p.chunk, vector: vectors[i] }));
  const manifest = await saveVectorStore(input.root, records, meta);
  return { manifest, chunkCount: records.length, skipped };
}
