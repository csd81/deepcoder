/**
 * Phase 10F — Provider Pool.
 *
 * Caches provider instances keyed by (provider, baseUrl) so that multiple roles
 * sharing the same backend reuse a single provider adapter. Never logs API keys.
 *
 * Phase 10F.2 — this is a minimal stub. Full implementation (role-specific
 * credentials, fallback on provider creation failure) will follow.
 */

import type { Config } from "../config/config.js";
import type { ModelProvider } from "../providers/types.js";
import type { ResolvedModelRoute } from "./types.js";
import { createProvider } from "../providers/factory.js";

export class ProviderPool {
  private baseConfig: Config;
  /** Cache keyed by `${provider}::${baseUrl}`. */
  private cache = new Map<string, ModelProvider>();

  constructor(baseConfig: Config) {
    this.baseConfig = baseConfig;
  }

  /**
   * Get or create a provider for the given resolved route.
   * Caches by (provider, baseUrl) so roles sharing the same backend
   * reuse the same adapter.
   */
  providerFor(route: ResolvedModelRoute): ModelProvider {
    const key = `${route.provider}::${route.baseUrl}`;
    let provider = this.cache.get(key);
    if (!provider) {
      // Build a config-like object for the factory. We reuse the base config's
      // apiKey and other fields, overriding provider/baseUrl from the route.
      const routeConfig: Config = {
        ...this.baseConfig,
        provider: route.provider,
        baseUrl: route.baseUrl,
        model: route.model,
        temperature: route.temperature ?? this.baseConfig.temperature,
        reasoningEffort: route.reasoningEffort ?? this.baseConfig.reasoningEffort,
      };
      provider = createProvider(routeConfig);
      this.cache.set(key, provider);
    }
    return provider;
  }
}
