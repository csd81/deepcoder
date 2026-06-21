// Phase 7I -- pure glob matcher for diagnostic rules.
// Conservative suffix/prefix matching.

import type { DiagnosticRule } from "./types.js";

export interface MatchResult {
  rule: DiagnosticRule;
  files: string[];
}

// Match diagnostic rules against a list of workspace-relative affected paths.
// Returns one entry per matching rule, in rule-declaration order.
export function matchRules(affectedPaths: string[], rules: DiagnosticRule[]): MatchResult[] {
  const out: MatchResult[] = [];

  for (const rule of rules) {
    const matched = affectedPaths.filter((p) => matchesAny(p, rule.match));
    if (matched.length > 0) {
      out.push({ rule, files: matched });
    }
  }

  return out;
}

// Test whether a single workspace-relative path matches any of the given globs.
function matchesAny(path: string, globs: string[]): boolean {
  for (const glob of globs) {
    if (globMatch(path, glob)) return true;
  }
  return false;
}

// Conservative glob matching.
// Supports: **/*.ext -> suffix .ext, prefix/** -> prefix prefix/,
// **/name -> suffix /name or exact name, *.ext -> suffix .ext,
// Literal strings -> exact match
function globMatch(path: string, glob: string): boolean {
  // Normalise separators
  const p = path.replace(/\\/g, "/");
  const g = glob.replace(/\\/g, "/");

  // **/*.ext or *.ext -> suffix match
  const extRe = /^(?:\*\*\/)?\*(\.[a-zA-Z0-9_]+)$/;
  const extMatch = extRe.exec(g);
  if (extMatch) {
    return p.endsWith(extMatch[1]);
  }

  // prefix/** -> prefix match
  const prefixRe = /^(.+?)\/\*\*$/;
  const prefixMatch = prefixRe.exec(g);
  if (prefixMatch) {
    return p.startsWith(prefixMatch[1] + "/") || p === prefixMatch[1];
  }

  // **/name -> suffix match
  const suffixRe = /^\*\*\/(.+)$/;
  const suffixMatch = suffixRe.exec(g);
  if (suffixMatch) {
    return p.endsWith("/" + suffixMatch[1]) || p === suffixMatch[1];
  }

  // Exact match fallback
  return p === g;
}
