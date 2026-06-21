/**
 * Phase 10E slice 3 — web search provider interface + web_search normalization core.
 *
 * Pure module: no network, no real search API, no tool registration, no config wiring.
 * Re-exports the seam interfaces, a `noneProvider` (always refuses), a `createManualProvider`
 * factory, and the `runWebSearch` orchestrator that runs the pipeline (query validation,
 * deduplication by canonical URL, result capping, redaction, stable id assignment).
 */
import { redactSecrets } from "../workspace/redact.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  source?: string;
  publishedAt?: string;
}

export interface WebSearchOptions {
  maxResults?: number;   // default 5
  recencyDays?: number;
  domains?: string[];
}

export interface WebSearchProvider {
  name: string;
  search(query: string, opts: WebSearchOptions): Promise<WebSearchResult[]>;
}

export interface NormalizedSearchResult extends WebSearchResult {
  id: string;
}

export interface WebSearchOutcome {
  ok: boolean;
  reason?: string;
  results: NormalizedSearchResult[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum length the query string is allowed to be. */
export const MAX_QUERY_CHARS = 400;

// ---------------------------------------------------------------------------
// noneProvider
// ---------------------------------------------------------------------------

/** A sentinel provider that never produces real hits. */
export const noneProvider: WebSearchProvider = {
  name: "none",
  async search(_query: string, _opts: WebSearchOptions): Promise<WebSearchResult[]> {
    return [];
  },
};

// ---------------------------------------------------------------------------
// createManualProvider
// ---------------------------------------------------------------------------

/**
 * Create a provider that returns the given results verbatim.
 * Useful for tests and for injecting fake data.
 */
export function createManualProvider(results: WebSearchResult[]): WebSearchProvider {
  return {
    name: "manual",
    async search(_query: string, _opts: WebSearchOptions): Promise<WebSearchResult[]> {
      return results;
    },
  };
}

// ---------------------------------------------------------------------------
// Canonical URL helper
// ---------------------------------------------------------------------------

/**
 * Canonicalize a URL string for deduplication:
 *  - parse with the global `URL` constructor
 *  - lowercase the hostname
 *  - drop the fragment (#...)
 *  - normalise trailing slash on the pathname (strip it, except for the root "/")
 *
 * Returns the canonical string or `null` if the URL is unparseable.
 */
function canonicalUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  // Lowercase the host
  url.hostname = url.hostname.toLowerCase();

  // Drop fragment
  url.hash = "";

  // Normalise trailing slash: "/docs/" → "/docs"  (but keep root "/")
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }

  return url.href;
}

// ---------------------------------------------------------------------------
// runWebSearch — the pipeline
// ---------------------------------------------------------------------------

/**
 * Execute a web search through the supplied provider.
 *
 * The pipeline:
 *  1. Validate query (empty? too long?) → refuse
 *  2. If provider is `none`, refuse
 *  3. Call provider.search(query, opts)
 *  4. Canonicalise + deduplicate results by URL (drop unparseable URLs)
 *  5. Cap to opts.maxResults (default 5)
 *  6. Assign stable ids ("r1", "r2", …)
 *  7. Redact title and snippet via redactSecrets
 */
export async function runWebSearch(
  query: string,
  opts: WebSearchOptions,
  provider: WebSearchProvider,
): Promise<WebSearchOutcome> {
  // -- Query validation ------------------------------------------------
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "empty query", results: [] };
  }
  if (trimmed.length > MAX_QUERY_CHARS) {
    return { ok: false, reason: "query too long", results: [] };
  }

  // -- "none" provider check -------------------------------------------
  if (provider.name === "none") {
    return { ok: false, reason: "no search provider configured", results: [] };
  }

  // -- Fetch results from provider -------------------------------------
  const rawResults = await provider.search(trimmed, opts);

  // -- Deduplicate by canonical URL ------------------------------------
  const seen = new Set<string>();
  const deduped: WebSearchResult[] = [];

  for (const r of rawResults) {
    const canon = canonicalUrl(r.url);
    if (canon === null) continue;       // unparseable → drop
    if (seen.has(canon)) continue;      // already seen → drop
    seen.add(canon);
    deduped.push(r);
  }

  // -- Cap to maxResults -----------------------------------------------
  const maxResults = opts.maxResults ?? 5;
  const capped = deduped.slice(0, maxResults);

  // -- Assign stable ids + redact --------------------------------------
  const results: NormalizedSearchResult[] = capped.map((r, i) => ({
    ...r,
    id: `r${i + 1}`,
    title: redactSecrets(r.title),
    snippet: redactSecrets(r.snippet),
  }));

  return { ok: true, results };
}
