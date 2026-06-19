import path from "node:path";
import type { InstructionGraph, LoadedSource } from "./instructionGraph.js";

/** Default cap on the rendered startup instruction block (bytes of text). */
export const DEFAULT_STARTUP_MAX_BYTES = 24_000;

/**
 * Render loaded startup sources into one bounded instruction block, each
 * segment prefixed with a source marker so the model (and `/instructions show`)
 * can see provenance. Sources that don't fit the budget are dropped and marked
 * `skipped` with a `budget_exceeded` warning on the graph.
 *
 * Mutates the passed sources' `skipped`/`skipReason` and pushes warnings, then
 * returns the rendered text. (The graph builder owns the source array.)
 */
export function renderStartup(
  sources: LoadedSource[],
  workspaceRoot: string,
  maxBytes: number,
  warnings: InstructionGraph["warnings"],
): string {
  const segments: string[] = [];
  let used = 0;
  for (const src of sources) {
    if (src.loadedAt !== "startup") continue;
    const body = src.text.trim();
    if (!body) {
      src.skipped = true;
      src.skipReason = "empty";
      continue;
    }
    const marker = `# ── ${rel(workspaceRoot, src.path)} (${src.kind}) ──`;
    const segment = `${marker}\n${body}`;
    const size = Buffer.byteLength(segment) + 2;
    if (used + size > maxBytes) {
      src.skipped = true;
      src.skipReason = "startup budget exceeded";
      warnings.push({
        kind: "budget_exceeded",
        sourcePath: src.path,
        message: `instruction budget (${maxBytes} bytes) exceeded; ${rel(workspaceRoot, src.path)} not loaded`,
      });
      continue;
    }
    used += size;
    segments.push(segment);
  }
  return segments.join("\n\n");
}

/** Render one JIT source as an ephemeral, attributed context block. */
export function renderJit(src: LoadedSource, workspaceRoot: string): string {
  const marker = `# ── path-local instructions: ${rel(workspaceRoot, src.path)} ──`;
  return `${marker}\n${src.text.trim()}`;
}

function rel(root: string, p: string): string {
  const r = path.relative(root, p);
  return r === "" || r.startsWith("..") ? p : r;
}
