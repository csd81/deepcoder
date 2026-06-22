/**
 * Phase 8E — the three model-callable semantic tools (read-only/advisory):
 * semantic_search, hybrid_search, similar_code.
 *
 * All ranking is delegated to the pure functions in src/semantic; embedding and
 * store loading are injectable (default to the real Ollama provider + vector
 * store) so the tools are testable offline. Results are bounded and cite
 * path:line; semantic hits are advisory — the agent must still read files.
 */

import { z } from "zod";
import { promises as fs } from "node:fs";
import { resolveReadPathInWorkspace } from "../workspace/paths.js";
import { rankBySimilarity, hybridRank, type ScoredChunk } from "../semantic/search.js";
import { loadVectorStore, isStoreStale } from "../semantic/store.js";
import { createEmbeddingProvider } from "../semantic/provider.js";
import type { VectorRecord, VectorManifest } from "../semantic/types.js";
import type { SemanticSearchConfig } from "../config/config.js";
import { parseArgs, type Tool, type ToolContext, type ToolInvocation, type ToolResult } from "./types.js";

export interface SemanticToolDeps {
  config: SemanticSearchConfig;
  /** Inject for tests; defaults to the configured embedding provider. */
  embed?: (texts: string[]) => Promise<number[][]>;
  /** Inject for tests; defaults to loadVectorStore. */
  loadStore?: (root: string) => Promise<{ manifest?: VectorManifest; records: VectorRecord[] } | null>;
}

const DISABLED =
  "Semantic search is disabled. Enable it with DEEPCODER_SEMANTIC_SEARCH=1 and a local embedding backend.";
const NO_INDEX = "No semantic index found. Run /semantic rebuild first.";
const STALE_INDEX =
  "Semantic index was built with a different embedding model/provider — its vectors are not comparable to the current model. Rebuild it with /semantic.";
const MAX_SNIPPET_BYTES = 600;
// Hard upper bound on returned results, applied on top of config.topK / the
// caller's topK — so a misconfigured topK (or a huge caller value) can't flood
// the model context with snippets.
const MAX_RESULTS = 25;
/** Clamp the requested result count to MAX_RESULTS (and at least 1). */
function boundTopK(requested: number): number {
  return Math.max(1, Math.min(requested, MAX_RESULTS));
}

/**
 * Phase 8E staleness guard: refuse to query a vector store whose manifest was
 * built with a different embedding provider/model/dimensions (its vectors are
 * incomparable to the current model → garbage results). Returns an error
 * ToolResult to short-circuit, or null when the store is fresh/manifest-less.
 */
function staleGuard(
  store: { manifest?: VectorManifest },
  config: SemanticSearchConfig,
): ToolResult | null {
  if (
    store.manifest &&
    isStoreStale(store.manifest, {
      providerLabel: config.provider,
      model: config.model,
      dimensions: config.dimensions,
    })
  ) {
    return { output: STALE_INDEX, isError: true };
  }
  return null;
}

function defaultEmbed(config: SemanticSearchConfig): (texts: string[]) => Promise<number[][]> {
  return async (texts) => {
    const provider = createEmbeddingProvider(config);
    if (!provider) throw new Error("No embedding provider available.");
    return provider.embed(texts);
  };
}

/** Read a bounded snippet for a result, confined to the workspace. "" on failure. */
async function readSnippet(root: string, p: string, start: number, end: number): Promise<string> {
  try {
    const abs = resolveReadPathInWorkspace(root, p);
    const content = await fs.readFile(abs, "utf8");
    let snip = content.split("\n").slice(Math.max(0, start - 1), end).join("\n");
    if (Buffer.byteLength(snip, "utf8") > MAX_SNIPPET_BYTES) snip = snip.slice(0, MAX_SNIPPET_BYTES) + "…";
    return snip;
  } catch {
    return "";
  }
}

async function formatResults(root: string, scored: ScoredChunk[]): Promise<string> {
  if (scored.length === 0) return "No matching code found.";
  const parts: string[] = [];
  for (const s of scored) {
    const c = s.chunk;
    const snip = await readSnippet(root, c.path, c.startLine, c.endLine);
    const lex = s.lexicalScore !== undefined ? `, lexical ${s.lexicalScore.toFixed(2)}` : "";
    parts.push(`${c.path}:${c.startLine}-${c.endLine}  (score ${s.score.toFixed(3)}${lex})${snip ? "\n" + snip : ""}`);
  }
  return parts.join("\n\n");
}

function readOnly(describe: string, execute: (ctx: ToolContext) => Promise<ToolResult>): ToolInvocation {
  return { describe: () => describe, kind: "read-only", execute };
}

export function createSemanticTools(deps: SemanticToolDeps): Tool[] {
  const { config } = deps;
  const embed = deps.embed ?? defaultEmbed(config);
  const loadStore = deps.loadStore ?? loadVectorStore;

  const semanticSchema = z.object({ query: z.string().min(1), topK: z.number().int().positive().optional() });
  const hybridSchema = z.object({
    query: z.string().min(1),
    pathPrefix: z.string().optional(),
    topK: z.number().int().positive().optional(),
  });
  const similarSchema = z.object({
    path: z.string().min(1),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  });

  const semantic_search: Tool = {
    name: "semantic_search",
    description:
      "Find code semantically similar to a natural-language query. Advisory — read files before editing.",
    kind: "read-only",
    schema: semanticSchema,
    build(raw) {
      const args = parseArgs("semantic_search", semanticSchema, raw);
      return readOnly(`semantic_search "${args.query.slice(0, 60)}"`, async (ctx) => {
        if (!config.enabled) return { output: DISABLED };
        const store = await loadStore(ctx.workspaceRoot);
        if (!store) return { output: NO_INDEX };
        { const stale = staleGuard(store, config); if (stale) return stale; }
        const [qv] = await embed([args.query]);
        const scored = rankBySimilarity(store.records, qv ?? [], boundTopK(args.topK ?? config.topK));
        return { output: await formatResults(ctx.workspaceRoot, scored) };
      });
    },
  };

  const hybrid_search: Tool = {
    name: "hybrid_search",
    description:
      "Semantic search optionally restricted to a path prefix, blended with a lexical (path-term) signal. " +
      "Use when you have a natural-language query AND a rough path; for a pure concept with no path use semantic_search.",
    kind: "read-only",
    schema: hybridSchema,
    build(raw) {
      const args = parseArgs("hybrid_search", hybridSchema, raw);
      return readOnly(`hybrid_search "${args.query.slice(0, 60)}"`, async (ctx) => {
        if (!config.enabled) return { output: DISABLED };
        const store = await loadStore(ctx.workspaceRoot);
        if (!store) return { output: NO_INDEX };
        { const stale = staleGuard(store, config); if (stale) return stale; }
        const recs = args.pathPrefix
          ? store.records.filter((r) => r.chunk.path.startsWith(args.pathPrefix!))
          : store.records;
        const [qv] = await embed([args.query]);
        const terms = args.query.toLowerCase().split(/\s+/).filter(Boolean);
        const lex: Record<string, number> = {};
        for (const r of recs) {
          const p = r.chunk.path.toLowerCase();
          const hits = terms.filter((t) => p.includes(t)).length;
          lex[r.chunk.id] = terms.length ? hits / terms.length : 0;
        }
        const scored = hybridRank(recs, qv ?? [], lex, {
          lexicalWeight: config.hybridLexicalWeight,
          topK: boundTopK(args.topK ?? config.topK),
        });
        return { output: await formatResults(ctx.workspaceRoot, scored) };
      });
    },
  };

  const similar_code: Tool = {
    name: "similar_code",
    description: "Find code similar to a given file range. Reads only within the workspace.",
    kind: "read-only",
    schema: similarSchema,
    build(raw) {
      const args = parseArgs("similar_code", similarSchema, raw);
      return readOnly(`similar_code ${args.path}:${args.startLine}-${args.endLine}`, async (ctx) => {
        if (!config.enabled) return { output: DISABLED };
        let text: string;
        try {
          const abs = resolveReadPathInWorkspace(ctx.workspaceRoot, args.path);
          const content = await fs.readFile(abs, "utf8");
          text = content.split("\n").slice(Math.max(0, args.startLine - 1), args.endLine).join("\n");
        } catch {
          return { output: `Cannot read ${args.path}: outside the workspace or not found.`, isError: true };
        }
        const store = await loadStore(ctx.workspaceRoot);
        if (!store) return { output: NO_INDEX };
        { const stale = staleGuard(store, config); if (stale) return stale; }
        const [qv] = await embed([text]);
        // Don't return the source range itself.
        const recs = store.records.filter(
          (r) => !(r.chunk.path === args.path && r.chunk.startLine === args.startLine),
        );
        const scored = rankBySimilarity(recs, qv ?? [], boundTopK(config.topK));
        return { output: await formatResults(ctx.workspaceRoot, scored) };
      });
    },
  };

  return [semantic_search, hybrid_search, similar_code];
}
