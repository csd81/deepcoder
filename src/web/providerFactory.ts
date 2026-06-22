/**
 * Phase 10E.6 — Web search provider factory.
 *
 * Pure module (no side effects, no terminal I/O, no real network).
 * Reads config and env through explicit parameters so it is fully testable.
 *
 * Responsibilities:
 *   - Map `config.web.searchProvider` to a concrete `WebSearchProvider`
 *   - Default "none" (the noneProvider)
 *   - "brave" requires `BRAVE_SEARCH_API_KEY`
 *   - Provider construction is fail-closed:
 *       - if web disabled → noneProvider
 *       - if provider unknown → noneProvider
 *       - if provider key missing → noneProvider
 */

import { noneProvider } from "./searchProvider.js";
import type { WebSearchProvider } from "./searchProvider.js";
import type { WebConfig } from "../config/webConfig.js";
import { createBraveSearchProvider } from "./providers/brave.js";

export interface ProviderFactoryOptions {
  /** The resolved web configuration. */
  config: WebConfig;
  /** Environment variables (process.env or a test stub). */
  env: Record<string, string | undefined>;
  /** Optional injected fetch implementation (for testing providers). */
  fetchImpl?: typeof fetch;
}

/**
 * Build a WebSearchProvider from the resolved web config and env vars.
 *
 * Rules:
 *  1. If web is disabled (`config.enabled === false`) → noneProvider
 *  2. If `searchProvider === "none"` → noneProvider
 *  3. If `searchProvider === "brave"`:
 *       - requires `BRAVE_SEARCH_API_KEY` in env → missing key → noneProvider
 *       - otherwise returns a configured BraveSearchProvider
 *  4. Any other provider string → noneProvider (unknown provider)
 */
export function createWebSearchProviderFromConfig(
  opts: ProviderFactoryOptions,
): WebSearchProvider {
  const { config, env, fetchImpl } = opts;

  // Rule 1: Web disabled → noneProvider
  if (!config.enabled) {
    return noneProvider;
  }

  const providerName = config.searchProvider ?? "none";

  // Rule 2: Explicit "none" → noneProvider
  if (providerName === "none") {
    return noneProvider;
  }

  // Rule 3: Brave provider
  if (providerName === "brave") {
    const apiKey = env.BRAVE_SEARCH_API_KEY;
    if (!apiKey || apiKey.trim().length === 0) {
      // Missing key → noneProvider (fail-closed)
      return noneProvider;
    }
    // Use the configured maxResults as default
    return createBraveSearchProvider({
      apiKey: apiKey.trim(),
      fetchImpl,
    });
  }

  // Rule 4: Unknown provider → noneProvider
  return noneProvider;
}
