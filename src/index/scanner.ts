import { readdir } from "node:fs/promises";
import path from "node:path";
import { loadIgnorer } from "./ignore.js";
import { classify } from "./classify.js";
import type { FileKind, IndexedFile, RepoIndex } from "./types.js";

const MAX_FILES = 20_000; // a guardrail so a huge tree can't blow up memory/time

/**
 * Walk the workspace, skipping ignored paths (.gitignore + .deepcoderignore +
 * defaults), and classify each file. Transparent and inspectable — no symbol
 * parsing yet. Bounded by MAX_FILES.
 */
export async function buildRepoIndex(root: string): Promise<RepoIndex> {
  const ignorer = loadIgnorer(root);
  const files: IndexedFile[] = [];

  async function walk(absDir: string): Promise<void> {
    if (files.length >= MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files.length >= MAX_FILES) return;
      const abs = path.join(absDir, e.name);
      const rel = path.relative(root, abs).replace(/\\/g, "/");
      if (ignorer.ignored(rel)) continue;
      if (e.isSymbolicLink()) continue; // don't follow symlinks (loops / escapes)
      if (e.isDirectory()) {
        await walk(abs);
      } else if (e.isFile()) {
        const { kind, lang } = classify(rel);
        files.push(lang ? { path: rel, kind, lang } : { path: rel, kind });
      }
    }
  }

  await walk(root);
  files.sort((a, b) => a.path.localeCompare(b.path));

  const counts: Record<FileKind, number> = { code: 0, test: 0, config: 0, docs: 0, generated: 0, other: 0 };
  for (const f of files) counts[f.kind]++;
  return { root, files, counts };
}
