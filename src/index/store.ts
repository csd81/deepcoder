import { mkdir, writeFile, rename, readFile } from "node:fs/promises";
import path from "node:path";
import type { RepoIndex } from "./types.js";
import { buildRepoIndex } from "./scanner.js";

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

export interface EnsureIndexOptions {
  /** Build with in-repo import edges (needed for reverse-import targeting). Default true. */
  imports?: boolean;
  /** Persist a freshly built index under .deepcoder/index. Default true. */
  persist?: boolean;
  /**
   * Rebuild if the persisted index is older than this many ms. Omitted/0 means
   * any existing index is reused regardless of age ("build only if absent").
   */
  maxStaleMs?: number;
}

/**
 * Phase 8C (lazy slice) — return a usable repo index, building one on demand so
 * index-dependent features (test targeting, /index impact|tests|references)
 * work WITHOUT a manual `/index rebuild`.
 *
 * Resolution order:
 *   1. a persisted index that is fresh enough (`maxStaleMs`) → reuse it (cheap),
 *   2. otherwise build one (bounded by the scanner's MAX_FILES guard), persist
 *      it (unless `persist:false`), and return it.
 *
 * Never throws: a build/persist failure yields `null` so callers degrade
 * gracefully rather than break.
 */
export async function ensureIndex(
  root: string,
  opts: EnsureIndexOptions = {},
): Promise<RepoIndex | null> {
  const loaded = await loadIndex(root);
  if (loaded) {
    const stale =
      opts.maxStaleMs !== undefined &&
      opts.maxStaleMs > 0 &&
      Date.now() - Date.parse(loaded.createdAt) > opts.maxStaleMs;
    if (!stale) return loaded.index;
  }
  let idx: RepoIndex;
  try {
    idx = await buildRepoIndex(root, { imports: opts.imports ?? true });
  } catch {
    return loaded?.index ?? null; // build failed → fall back to a stale index if we have one
  }
  if (opts.persist ?? true) {
    try {
      await saveIndex(root, idx);
    } catch {
      /* persistence is best-effort — still return the in-memory index */
    }
  }
  return idx;
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
