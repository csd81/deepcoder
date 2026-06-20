import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { VectorManifest, VectorRecord } from './types.js';

/**
 * Writes the vector store manifest and records atomically.
 * Creates the directory if it does not exist.
 */
export async function saveVectorStore(
  root: string,
  records: VectorRecord[],
  meta: {
    providerLabel: string;
    model: string;
    dimensions: number | null;
    repoIndexHash?: string;
  }
): Promise<VectorManifest> {
  const vectorsDir = path.join(root, '.deepcoder', 'index', 'vectors');
  await fs.mkdir(vectorsDir, { recursive: true });

  const manifest: VectorManifest = {
    providerLabel: meta.providerLabel,
    model: meta.model,
    dimensions: meta.dimensions,
    createdAt: new Date().toISOString(),
    chunkCount: records.length,
    repoIndexHash: meta.repoIndexHash,
  };

  const manifestPath = path.join(vectorsDir, 'manifest.json');
  const manifestTmpPath = path.join(vectorsDir, 'manifest.json.tmp');
  const vectorsPath = path.join(vectorsDir, 'vectors.jsonl');
  const vectorsTmpPath = path.join(vectorsDir, 'vectors.jsonl.tmp');

  // Write manifest atomically
  await fs.writeFile(manifestTmpPath, JSON.stringify(manifest, null, 2), 'utf8');
  await fs.rename(manifestTmpPath, manifestPath);

  // Write vectors atomically
  const lines = records.map(r => JSON.stringify(r)).join('\n') + (records.length > 0 ? '\n' : '');
  await fs.writeFile(vectorsTmpPath, lines, 'utf8');
  await fs.rename(vectorsTmpPath, vectorsPath);

  return manifest;
}

/**
 * Validates the parsed manifest shape defensively.
 */
function isValidManifest(manifest: any): manifest is VectorManifest {
  if (!manifest || typeof manifest !== 'object') {
    return false;
  }
  if (typeof manifest.providerLabel !== 'string') {
    return false;
  }
  if (typeof manifest.model !== 'string') {
    return false;
  }
  if (manifest.dimensions !== null && typeof manifest.dimensions !== 'number') {
    return false;
  }
  if (typeof manifest.createdAt !== 'string') {
    return false;
  }
  if (typeof manifest.chunkCount !== 'number') {
    return false;
  }
  if (manifest.repoIndexHash !== undefined && typeof manifest.repoIndexHash !== 'string') {
    return false;
  }
  return true;
}

/**
 * Validates a parsed vector record shape defensively.
 */
function isValidRecord(record: any): record is VectorRecord {
  if (!record || typeof record !== 'object') {
    return false;
  }
  if (!record.chunk || typeof record.chunk !== 'object') {
    return false;
  }
  if (!Array.isArray(record.vector)) {
    return false;
  }
  return true;
}

/**
 * Loads the vector store manifest and records.
 * Returns null if missing, unparseable, or invalid.
 * Skips corrupt/unparseable lines in vectors.jsonl without throwing.
 */
export async function loadVectorStore(
  root: string
): Promise<{ manifest: VectorManifest; records: VectorRecord[] } | null> {
  const vectorsDir = path.join(root, '.deepcoder', 'index', 'vectors');
  const manifestPath = path.join(vectorsDir, 'manifest.json');
  const vectorsPath = path.join(vectorsDir, 'vectors.jsonl');

  try {
    // Check if files exist
    await fs.access(manifestPath);
    await fs.access(vectorsPath);
  } catch {
    return null;
  }

  let manifest: VectorManifest;
  try {
    const manifestContent = await fs.readFile(manifestPath, 'utf8');
    const parsed = JSON.parse(manifestContent);
    if (!isValidManifest(parsed)) {
      return null;
    }
    manifest = parsed;
  } catch {
    return null;
  }

  const records: VectorRecord[] = [];
  try {
    const vectorsContent = await fs.readFile(vectorsPath, 'utf8');
    const lines = vectorsContent.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const parsed = JSON.parse(trimmed);
        if (isValidRecord(parsed)) {
          records.push(parsed);
        }
      } catch {
        // Skip corrupt/unparseable line
      }
    }
  } catch {
    return null;
  }

  return { manifest, records };
}

/**
 * Returns true if providerLabel OR model OR dimensions differ from the manifest.
 */
export function isStoreStale(
  manifest: VectorManifest,
  current: { providerLabel: string; model: string; dimensions: number | null }
): boolean {
  return (
    manifest.providerLabel !== current.providerLabel ||
    manifest.model !== current.model ||
    manifest.dimensions !== current.dimensions
  );
}

/**
 * Deletes ONLY .deepcoder/index/vectors/ recursively.
 * Never throws if absent.
 */
export async function purgeVectorStore(root: string): Promise<void> {
  const vectorsDir = path.join(root, '.deepcoder', 'index', 'vectors');
  try {
    await fs.rm(vectorsDir, { recursive: true, force: true });
  } catch {
    // Never throws
  }
}
