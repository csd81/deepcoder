import type { InstructionWarning } from "./instructionGraph.js";

/** A loaded source reduced to what conflict detection needs. */
export interface ConflictInput {
  path: string;
  text: string;
}

/**
 * Detect OBVIOUS, mutually-exclusive guidance across instruction sources. This
 * is a heuristic warning system, not a proof engine: it surfaces likely
 * contradictions so the user can fix unclear instructions. It never picks a
 * winner beyond normal merge order, and never crashes on odd input.
 */
export function detectConflicts(sources: ConflictInput[]): InstructionWarning[] {
  const warnings: InstructionWarning[] = [];
  for (const dim of DIMENSIONS) {
    // For each source, which (single) bucket in this dimension does it assert?
    const hits = new Map<string, string[]>(); // bucket -> sourcePaths
    for (const src of sources) {
      const bucket = classify(src.text, dim);
      if (!bucket) continue;
      const list = hits.get(bucket) ?? [];
      list.push(src.path);
      hits.set(bucket, list);
    }
    if (hits.size > 1) {
      const parts = [...hits.entries()].map(([bucket, paths]) => `${paths.join(", ")}: ${bucket}`);
      warnings.push({
        kind: "conflict",
        sourcePaths: [...new Set(sources.map((s) => s.path))],
        message: `${dim.label} guidance differs — ${parts.join(" | ")}`,
      });
    }
  }
  return warnings;
}

interface Dimension {
  label: string;
  buckets: { name: string; re: RegExp }[];
}

// Each dimension lists mutually-exclusive buckets; a source matches at most the
// FIRST bucket whose pattern fires (so we never double-count one file).
const DIMENSIONS: Dimension[] = [
  {
    label: "package manager",
    buckets: [
      { name: "pnpm", re: /\bpnpm\b/i },
      { name: "yarn", re: /\byarn\b/i },
      { name: "npm", re: /\bnpm\b/i },
    ],
  },
  {
    label: "test runner",
    buckets: [
      { name: "pytest", re: /\bpytest\b/i },
      { name: "unittest", re: /\bunittest\b/i },
      { name: "vitest", re: /\bvitest\b/i },
      { name: "jest", re: /\bjest\b/i },
    ],
  },
  {
    label: "indentation",
    buckets: [
      { name: "tabs", re: /\b(use\s+)?tabs\b/i },
      { name: "spaces", re: /\b(use\s+)?spaces\b|\b[24]\s+spaces\b/i },
    ],
  },
  {
    label: "generated files policy",
    buckets: [
      { name: "never edit generated files", re: /\b(never|don'?t|do not)\s+edit\s+generated\b/i },
      { name: "edit generated files", re: /\b(do\s+)?edit\s+generated\b/i },
    ],
  },
];

function classify(text: string, dim: Dimension): string | null {
  for (const b of dim.buckets) {
    if (b.re.test(text)) return b.name;
  }
  return null;
}
