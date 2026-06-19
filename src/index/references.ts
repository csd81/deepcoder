import { readFile } from "node:fs/promises";
import path from "node:path";
import type { RepoIndex } from "./types.js";

// Identifier references (Phase 8C). Regex word-boundary matches across indexed
// code/test files — "good enough to guide search, not a compiler". Bounded so a
// hot identifier can't flood output. Definitions come from the symbol index;
// references include the definition line itself (it mentions the identifier).

export interface Reference {
  file: string;
  /** 1-based line. */
  line: number;
  /** Trimmed, bounded source line. */
  text: string;
}

export interface FindReferencesResult {
  symbol: string;
  definitions: { file: string; line: number; kind: string }[];
  references: Reference[];
  /** True when the result was capped at `max`. */
  truncated: boolean;
}

const MAX_REFS = 200;
const MAX_FILE_BYTES = 1_000_000;

/**
 * Find where `symbol` is defined (from the symbol index) and referenced (lexical
 * word-boundary scan of indexed code/test files). `pathHint` restricts the scan
 * to files under that workspace-relative prefix. Never throws; unreadable files
 * are skipped.
 */
export async function findReferences(
  root: string,
  index: RepoIndex,
  symbol: string,
  opts: { pathHint?: string; max?: number } = {},
): Promise<FindReferencesResult> {
  const ident = symbol.trim();
  const max = opts.max ?? MAX_REFS;
  const definitions = index.symbols
    .filter((s) => s.name === ident)
    .map((s) => ({ file: s.file, line: s.line, kind: s.kind }));

  const result: FindReferencesResult = { symbol: ident, definitions, references: [], truncated: false };
  // Only safe identifiers get a lexical scan (a regex metacharacter could blow up).
  if (!/^[A-Za-z_$][\w$]*$/.test(ident)) return result;

  const re = new RegExp(`\\b${ident}\\b`);
  const hint = opts.pathHint?.replace(/\\/g, "/");
  const targets = index.files.filter(
    (f) => (f.kind === "code" || f.kind === "test") && (!hint || f.path.startsWith(hint)),
  );

  for (const f of targets) {
    if (result.references.length >= max) {
      result.truncated = true;
      break;
    }
    let text: string;
    try {
      text = await readFile(path.join(root, f.path), "utf8");
    } catch {
      continue;
    }
    if (text.length > MAX_FILE_BYTES) continue;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      result.references.push({ file: f.path, line: i + 1, text: lines[i].trim().slice(0, 200) });
      if (result.references.length >= max) {
        result.truncated = true;
        break;
      }
    }
  }
  return result;
}
