import { mkdir, writeFile, rename, readFile } from "node:fs/promises";
import path from "node:path";
import type { RepoIndex } from "./types.js";

// Index persistence (Phase 8C). Atomic tmp→rename write under .deepcoder/index.
// A corrupt or version-mismatched file loads as null so the caller rebuilds
// rather than crashing — the index is a cache, never a source of truth.

export const INDEX_DIR = path.join(".deepcoder", "index");
const INDEX_FILE = "repo-index.json";
const VERSION = 1 as const;

interface StoredIndex {
  version: typeof VERSION;
  createdAt: string;
  index: RepoIndex;
}

export interface LoadedIndex {
  createdAt: string;
  index: RepoIndex;
}

function indexPath(root: string): string {
  return path.join(root, INDEX_DIR, INDEX_FILE);
}

/** Atomically persist `index` under the workspace's `.deepcoder/index/`. */
export async function saveIndex(root: string, index: RepoIndex): Promise<void> {
  const dir = path.join(root, INDEX_DIR);
  await mkdir(dir, { recursive: true });
  const file = indexPath(root);
  const tmp = `${file}.tmp`;
  const payload: StoredIndex = { version: VERSION, createdAt: new Date().toISOString(), index };
  await writeFile(tmp, JSON.stringify(payload), "utf8");
  await rename(tmp, file);
}

/** Load a previously saved index, or null when absent/corrupt/version-mismatched. */
export async function loadIndex(root: string): Promise<LoadedIndex | null> {
  let raw: string;
  try {
    raw = await readFile(indexPath(root), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as StoredIndex;
    if (parsed?.version !== VERSION) return null;
    const idx = parsed.index;
    if (!idx || !Array.isArray(idx.files) || !idx.counts) return null;
    return { createdAt: parsed.createdAt, index: idx };
  } catch {
    return null; // corrupt JSON — caller rebuilds, never crashes
  }
}
