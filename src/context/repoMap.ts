import { promises as fs } from "node:fs";
import path from "node:path";
import { scanFiles } from "./fileScanner.js";
import { estimateTokens } from "./tokenBudget.js";

export interface SymbolInfo {
  kind: "fn" | "class" | "interface" | "type" | "const" | "enum";
  name: string;
  exported: boolean;
}

const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);

const PATTERNS: Array<{ re: RegExp; kind: SymbolInfo["kind"] }> = [
  { re: /^\s*(export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm, kind: "fn" },
  { re: /^\s*(export\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)/gm, kind: "class" },
  { re: /^\s*(export\s+)?interface\s+([A-Za-z0-9_$]+)/gm, kind: "interface" },
  { re: /^\s*(export\s+)?type\s+([A-Za-z0-9_$]+)\s*[=<]/gm, kind: "type" },
  { re: /^\s*(export\s+)?enum\s+([A-Za-z0-9_$]+)/gm, kind: "enum" },
  { re: /^\s*(export\s+)?const\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z0-9_$]+)\s*=>/gm, kind: "const" },
];

/** Regex-based symbol extraction for TS/JS — lightweight, no compiler dep. */
export function extractSymbols(content: string): SymbolInfo[] {
  const found: SymbolInfo[] = [];
  const seen = new Set<string>();
  for (const { re, kind } of PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const exported = Boolean(m[1]);
      const name = m[2]!;
      const key = `${kind}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ kind, name, exported });
    }
  }
  return found;
}

export interface RepoMapOptions {
  /** Restrict to these workspace-relative paths/prefixes. */
  paths?: string[];
  /** Stop emitting once this many tokens are produced. */
  budgetTokens?: number;
}

/**
 * Build a compact, token-bounded map of TS/JS files and their top-level symbols.
 */
export async function buildRepoMap(root: string, opts: RepoMapOptions = {}): Promise<string> {
  const budget = opts.budgetTokens ?? 4000;
  let files = (await scanFiles(root)).filter((f) => CODE_EXT.has(path.extname(f).toLowerCase()));
  if (opts.paths?.length) {
    files = files.filter((f) => opts.paths!.some((p) => f === p || f.startsWith(p.replace(/\/?$/, "/"))));
  }

  const lines: string[] = [];
  let tokens = 0;
  let truncated = false;
  for (const file of files) {
    let content: string;
    try {
      content = await fs.readFile(path.join(root, file), "utf8");
    } catch {
      continue;
    }
    const symbols = extractSymbols(content);
    const block = [file, ...symbols.map((s) => `  ${s.exported ? "+" : " "}${s.kind} ${s.name}`)].join("\n");
    const blockTokens = estimateTokens(block);
    if (tokens + blockTokens > budget) {
      truncated = true;
      break;
    }
    lines.push(block);
    tokens += blockTokens;
  }

  if (truncated) lines.push("… (repo map truncated to fit the token budget; narrow with paths)");
  return lines.join("\n\n") || "(no TypeScript/JavaScript files found)";
}

/** Find indexed symbols by (case-insensitive substring) name across the repo. */
export async function findSymbols(root: string, query: string): Promise<string> {
  const files = (await scanFiles(root)).filter((f) => CODE_EXT.has(path.extname(f).toLowerCase()));
  const q = query.toLowerCase();
  const hits: string[] = [];
  for (const file of files) {
    let content: string;
    try {
      content = await fs.readFile(path.join(root, file), "utf8");
    } catch {
      continue;
    }
    for (const s of extractSymbols(content)) {
      if (s.name.toLowerCase().includes(q)) hits.push(`${file}: ${s.kind} ${s.name}`);
    }
  }
  return hits.length ? hits.join("\n") : `(no symbols matching "${query}")`;
}
