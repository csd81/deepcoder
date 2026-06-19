import type { IndexedSymbol, SymbolKind } from "./types.js";

// Regex-based symbol-definition extraction (Phase 8C). "Good enough to guide
// search, not a compiler": TS/JS top-level + exported declarations, Python
// def/class (top-level functions vs indented methods). References, imports, and
// the impact graph are deferred.

interface Rule {
  re: RegExp;
  kind: SymbolKind;
  group: number;
}

const TS_RULES: Rule[] = [
  { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: "function", group: 1 },
  { re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class", group: 1 },
  { re: /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, kind: "const", group: 1 },
];

/** Extract symbol definitions from one file. `lang` is the coarse tag from classify(). */
export function extractSymbols(file: string, text: string, lang: string | undefined): IndexedSymbol[] {
  if (lang === "ts" || lang === "js") return extractWith(TS_RULES, file, text);
  if (lang === "py") return extractPython(file, text);
  return [];
}

function extractWith(rules: Rule[], file: string, text: string): IndexedSymbol[] {
  const out: IndexedSymbol[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const r of rules) {
      const m = r.re.exec(line);
      if (m && m[r.group]) {
        out.push({ name: m[r.group]!, kind: r.kind, file, line: i + 1 });
        break; // one symbol per line
      }
    }
  }
  return out;
}

function extractPython(file: string, text: string): IndexedSymbol[] {
  const out: IndexedSymbol[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const def = /^(\s*)def\s+([A-Za-z_]\w*)/.exec(line);
    if (def) {
      out.push({ name: def[2]!, kind: def[1]! ? "method" : "function", file, line: i + 1 });
      continue;
    }
    const cls = /^(\s*)class\s+([A-Za-z_]\w*)/.exec(line);
    if (cls) out.push({ name: cls[2]!, kind: "class", file, line: i + 1 });
  }
  return out;
}
