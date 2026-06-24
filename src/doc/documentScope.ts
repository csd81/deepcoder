/**
 * Documentation generation over a file scope.
 *
 * Drives the pure `insertDocBlock` core across every un-documented function/class
 * in a glob scope: enumerate symbols → for each undocumented decl, generate a
 * JSDoc block → insert it ABOVE the declaration (comments only; executable code
 * is never touched). Re-runs are idempotent — a decl that already has a JSDoc
 * block above it is skipped.
 *
 * Every effectful dependency (symbol enumeration, file I/O, the doc-block
 * generator) is injected, so the orchestration is unit-testable with no live
 * model and no real index.
 */
import { insertDocBlock, hasExistingDocBlock } from "./docGen.js";
import type { IndexedSymbol } from "../index/types.js";

/** Per-symbol input handed to the generator. */
export interface DocTarget {
  symbol: IndexedSymbol;
  /** A few lines of source starting at the declaration, for the generator's context. */
  signature: string;
}

export interface DocumentDeps {
  /** Enumerate function/class/const/method symbols repo-wide (default: buildRepoIndex). */
  listSymbols: () => Promise<IndexedSymbol[]>;
  /** Read a workspace-relative file. */
  readFile: (relPath: string) => Promise<string>;
  /** Write a workspace-relative file. */
  writeFile: (relPath: string, text: string) => Promise<void>;
  /** Produce a JSDoc comment block (must start with the doc-comment opener) for a target. */
  generateDoc: (target: DocTarget) => Promise<string>;
}

export interface DocumentResult {
  filesScanned: number;
  symbolsConsidered: number;
  inserted: { file: string; symbol: string; line: number }[];
  skipped: { file: string; symbol: string; reason: string }[];
}

/** Only these kinds get JSDoc in v1 (arrow-const placement is ambiguous). */
const DOCUMENTABLE = new Set(["function", "class"]);

/** Translate a glob (supporting `**`, `*`, `?`) into an anchored RegExp. */
export function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // `**` → any chars incl. separators; consume an optional trailing slash.
        re += ".*";
        i++;
        if (pattern[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * Document every un-documented function/class whose file matches `pattern`.
 * Symbols within a file are processed in descending line order so each insertion
 * cannot shift the line numbers of symbols not yet processed.
 */
export async function documentScope(
  pattern: string,
  deps: DocumentDeps,
): Promise<DocumentResult> {
  const re = globToRegExp(pattern);
  const all = await deps.listSymbols();
  const inScope = all.filter((s) => re.test(s.file));

  const result: DocumentResult = {
    filesScanned: 0,
    symbolsConsidered: 0,
    inserted: [],
    skipped: [],
  };

  // Group symbols by file.
  const byFile = new Map<string, IndexedSymbol[]>();
  for (const s of inScope) {
    if (!byFile.has(s.file)) byFile.set(s.file, []);
    byFile.get(s.file)!.push(s);
  }

  for (const [file, symbols] of byFile) {
    result.filesScanned++;
    let text = await deps.readFile(file);
    let dirty = false;

    // Descending by line: later insertions never invalidate earlier line numbers.
    const ordered = [...symbols].sort((a, b) => b.line - a.line);
    for (const symbol of ordered) {
      result.symbolsConsidered++;
      if (!DOCUMENTABLE.has(symbol.kind)) {
        result.skipped.push({ file, symbol: symbol.name, reason: `kind ${symbol.kind} not documented in v1` });
        continue;
      }
      const lines = text.split(text.includes("\r\n") ? "\r\n" : "\n");
      if (hasExistingDocBlock(lines, symbol.line)) {
        result.skipped.push({ file, symbol: symbol.name, reason: "already documented" });
        continue;
      }
      const signature = lines.slice(symbol.line - 1, symbol.line - 1 + 4).join("\n");
      const docBlock = (await deps.generateDoc({ symbol, signature })).trim();
      if (!docBlock.startsWith("/**")) {
        result.skipped.push({ file, symbol: symbol.name, reason: "generator returned a non-doc block" });
        continue;
      }
      const next = insertDocBlock(text, symbol.line, docBlock);
      if (next.changed) {
        text = next.text;
        dirty = true;
        result.inserted.push({ file, symbol: symbol.name, line: symbol.line });
      } else {
        result.skipped.push({ file, symbol: symbol.name, reason: "insertion was a no-op" });
      }
    }

    if (dirty) await deps.writeFile(file, text);
  }

  return result;
}
