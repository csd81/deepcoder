import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export interface UnderstandEntry {
  key: string;
  createdAt: string;
  data: unknown;
}

export function computeRepoKey(files: { path: string; mtimeMs: number }[]): string {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const lines = sorted.map((f) => `${f.path}:${f.mtimeMs}`);
  const content = lines.join("\n");
  return createHash("sha256").update(content).digest("hex");
}

export async function writeUnderstandCache(dir: string, entry: UnderstandEntry): Promise<void> {
  const deepcoderDir = path.join(dir, ".deepcoder");
  await mkdir(deepcoderDir, { recursive: true });
  
  const targetPath = path.join(deepcoderDir, "understand-cache.json");
  const tempPath = path.join(deepcoderDir, `understand-cache.json.tmp.${randomUUID()}`);
  
  const content = JSON.stringify(entry);
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, targetPath);
}

export async function readUnderstandCache(dir: string, key: string): Promise<UnderstandEntry | null> {
  const targetPath = path.join(dir, ".deepcoder", "understand-cache.json");
  try {
    const content = await readFile(targetPath, "utf8");
    const entry = JSON.parse(content) as UnderstandEntry;
    if (entry.key !== key) {
      return null;
    }
    return entry;
  } catch (error) {
    return null;
  }
}
