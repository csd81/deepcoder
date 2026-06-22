/**
 * Phase 10E.6 — Brave Search API provider.
 *
 * Pure module: injectable fetch seam, no real network, no config wiring.
 * Maps Brave Web Search API JSON responses into the existing WebSearchResult type.
 *
 * Environment:
 *   BRAVE_SEARCH_API_KEY — the API key, passed in the request header only
 *                          (never in URL query parameters).
 */

import type { WebSearchProvider, WebSearchResult, WebSearchOptions } from "../searchProvider.js";

// ---------------------------------------------------------------------------
// Public options
// ---------------------------------------------------------------------------

export interface BraveSearchOptions {
  /** The BRAVE_SEARCH_API_KEY value. */
  apiKey: string;
  /** Injected fetch implementation for testing (defaults to global fetch). */
  fetchImpl?: typeof fetch;
  /** Base URL for the Brave Search API. Default: "https://api.search.brave.com/res/v1/web/search" */
  baseUrl?: string;
  /** Timeout in milliseconds for the HTTP request. Default: 15_000. */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Brave API response types (only the fields we map)
// ---------------------------------------------------------------------------

interface BraveApiResponse {
  web?: {
    results?: BraveWebResult[];
  };
}

interface BraveWebResult {
  title: string;
  url: string;
  description: string;
  age?: string;
  page_age?: string;
}

// ---------------------------------------------------------------------------
// Default base URL
// ---------------------------------------------------------------------------

const DEFAULT_BRAVE_URL = "https://api.search.brave.com/res/v1/web/search";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a WebSearchProvider that calls the Brave Web Search API.
 *
 * The API key is sent in the `X-Subscription-Token` header only — never in the
 * URL. An injected `fetchImpl` can be supplied for tests (defaults to global fetch).
 *
 * Non-2xx responses return an empty result set (bounded refusal). Timeouts use
 * an AbortController with a 15-second default.
 */
export function createBraveSearchProvider(opts: BraveSearchOptions): WebSearchProvider {
  const {
    apiKey,
    fetchImpl = globalThis.fetch,
    baseUrl = DEFAULT_BRAVE_URL,
    timeoutMs = 15_000,
  } = opts;

  const provider: WebSearchProvider = {
    name: "brave",

    async search(query: string, searchOpts: WebSearchOptions): Promise<WebSearchResult[]> {
      // Build query parameters
      const params = new URLSearchParams();
      params.set("q", query);

      const maxResults = searchOpts.maxResults ?? 5;
      // Brave API uses `count` for number of results (max 20, but we cap to our config)
      const count = Math.min(maxResults, 20);
      params.set("count", String(count));

      // If recencyDays is specified, request freshness
      if (searchOpts.recencyDays !== undefined && searchOpts.recencyDays > 0) {
        // Brave supports `freshness` parameter: "pd" (past day), "pw" (past week), "pm" (past month), "py" (past year)
        if (searchOpts.recencyDays <= 1) {
          params.set("freshness", "pd");
        } else if (searchOpts.recencyDays <= 7) {
          params.set("freshness", "pw");
        } else if (searchOpts.recencyDays <= 31) {
          params.set("freshness", "pm");
        } else {
          params.set("freshness", "py");
        }
      }

      const url = `${baseUrl}?${params.toString()}`;

      // Set up timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetchImpl(url, {
          method: "GET",
          headers: {
            "X-Subscription-Token": apiKey,
            Accept: "application/json",
          },
          signal: controller.signal,
        });

        if (!response.ok) {
          // Non-2xx → bounded refusal, not a throw
          return [];
        }

        const body = (await response.json()) as BraveApiResponse;

        // Map results
        const rawResults = body.web?.results ?? [];
        return rawResults.map((r) => {
          const result: WebSearchResult = {
            title: r.title,
            url: r.url,
            snippet: r.description,
            source: "brave",
          };
          // Prefer page_age, fall back to age
          const pubDate = r.page_age ?? r.age;
          if (pubDate) {
            result.publishedAt = pubDate;
          }
          return result;
        });
      } catch {
        // Timeout or network error → bounded empty response
        // The error is intentionally not propagated to avoid leaking internal details
        return [];
      } finally {
        clearTimeout(timeoutId);
      }
    },
  };

  return provider;
}
