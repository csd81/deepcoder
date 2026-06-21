/**
 * Phase 10E — web tools factory.
 *
 * Builds the registerable web tools from a resolved web config. Returns NO tools
 * when web is disabled (default-off: no model-callable web tools exist), so the
 * registry can simply spread the result. The central registry.ts edit that calls
 * this is a separate in-house step.
 */

import type { Tool } from "./types.js";
import { createWebFetchTool } from "./webFetch.js";
import { createWebSearchTool } from "./webSearch.js";
import { noneProvider, type WebSearchProvider } from "../web/searchProvider.js";

export interface WebToolsOptions {
  enabled: boolean;
  allowedDomains: string[];
  blockedDomains: string[];
  /** Provider name (kept for config symmetry; the concrete instance is `provider`). */
  searchProvider: string;
  /** Concrete search provider; defaults to the refusing `noneProvider`. */
  provider?: WebSearchProvider;
  fetchImpl?: typeof fetch;
}

/** The web tools available for the given config; [] when web is disabled. */
export function createWebTools(opts: WebToolsOptions): Tool[] {
  if (!opts.enabled) return [];
  return [
    createWebFetchTool({
      web: { allowedDomains: opts.allowedDomains, blockedDomains: opts.blockedDomains },
      fetchImpl: opts.fetchImpl,
    }),
    createWebSearchTool({ provider: opts.provider ?? noneProvider }),
  ];
}
