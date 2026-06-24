import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The adapted prompt corpus: ~197 markdown files under `system-prompts/`
 * at the package root, adapted from Claude Code's published system prompts. They are
 * REFERENCE source material, not config: the authoritative live system prompt is built
 * in `src/agent/systemPrompt.ts`. This module is the only sanctioned bridge that pulls
 * selected corpus files into runtime text — see `manifest.ts` for which files are
 * surfaced. Resolves the same in dev (tsx, `src/prompts/`) and build (`dist/prompts/`)
 * because both sit two levels under the package root.
 */
export const CORPUS_DIR = fileURLToPath(new URL("../../system-prompts/", import.meta.url));

/** A corpus filename: lowercase, dash/underscore-separated, `.md`. Anything else is
 *  rejected (this is what confines reads to the corpus dir — the rule admits no `/`,
 *  no `.` other than the extension, no `..`, and no absolute path). */
const CORPUS_FILE = /^[a-z0-9][a-z0-9_-]*\.md$/;

const cache = new Map<string, string>();
let fileList: string[] | undefined;

/**
 * Load one corpus file's body, with its `<!-- adapted-from: … -->` header and any
 * surrounding blank lines stripped. Returns "" for an invalid name or a missing/
 * unreadable file — this is on the prompt-building path, which must never throw.
 * Results are cached (including the empty fallback) so repeated builds are stable.
 */
export function loadCorpusPrompt(filename: string): string {
  const cached = cache.get(filename);
  if (cached !== undefined) return cached;
  const body = CORPUS_FILE.test(filename) ? readBody(filename) : "";
  cache.set(filename, body);
  return body;
}

function readBody(filename: string): string {
  let raw: string;
  try {
    raw = readFileSync(CORPUS_DIR + filename, "utf8");
  } catch {
    return "";
  }
  const lines = raw.split("\n");
  // Drop a leading HTML-comment header block (the adapted-from provenance marker).
  while (lines.length > 0) {
    const t = lines[0].trim();
    if (t === "" || (t.startsWith("<!--") && t.endsWith("-->"))) lines.shift();
    else break;
  }
  return lines.join("\n").trim();
}

/** Every adapted corpus file, sorted. Excludes the README and any other non-corpus
 *  markdown via the same name rule the loader enforces. Cached; deterministic. */
export function listCorpusFiles(): string[] {
  if (fileList) return fileList;
  let names: string[];
  try {
    names = readdirSync(CORPUS_DIR);
  } catch {
    names = [];
  }
  fileList = names.filter((n) => CORPUS_FILE.test(n)).sort();
  return fileList;
}
