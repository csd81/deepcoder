/**
 * Phase 10E.7 — OpenRouter Search-Capable Research Routing (pure module).
 *
 * Routing-decision logic that lets OpenRouter serve research/planning roles while
 * keeping audited local web_search/web_fetch results distinct from provider-side
 * citations.
 *
 * Pure types + functions — no terminal I/O, no network, no live model.
 *
 * Core invariants:
 *  - Only local web_search / web_fetch create WebTraceRecord.
 *  - Provider-side citations are labelled "unverified-provider-citation" until
 *    verified via local web_fetch.
 *  - webAware routes produce a system-prompt instruction that guides the model
 *    to distinguish provider-side sources from Deepcoder-fetched sources.
 *  - All provider-side citation text passes through redactSecrets.
 */

import { redactSecrets } from "../workspace/redact.js";

// ─────────────────────────────────────────────────────────
// 1. Capability Metadata (declarative, user/config-supplied)
// ─────────────────────────────────────────────────────────

/**
 * Optional capabilities that a model route may declare.
 * This is declarative user/config metadata, NOT a trusted runtime fact.
 */
export interface ModelRouteCapabilities {
  /** The model/provider may have integrated web/search capabilities. */
  webAware?: boolean;
  /** The model/provider supports tool calling. */
  toolCalling?: boolean;
  /** The model/provider supports extended context windows. */
  longContext?: boolean;
}

// ─────────────────────────────────────────────────────────
// 2. Provider Citation (separate from local web trace)
// ─────────────────────────────────────────────────────────

/**
 * A citation returned by a provider that may have used provider-side search or
 * may only be generated text.
 *
 * These are stored separately from WebTraceRecord — they are advisory until
 * verified with local web_fetch.
 */
export interface ProviderCitation {
  /** Provider name, e.g. "deepseek". */
  provider: string;
  /** Model name, e.g. "deepseek-v4-flash". */
  model: string;
  /** The URL being cited. */
  url: string;
  /** Optional title for the cited resource. */
  title?: string;
  /** ISO timestamp when the citation was produced. */
  quotedAt?: string;
  /** Set to true once local web_fetch has verified the content. */
  verifiedByLocalFetch?: boolean;
}

// ─────────────────────────────────────────────────────────
// 3. Capability Guards
// ─────────────────────────────────────────────────────────

/**
 * Check whether a route capabilities object indicates web-aware behaviour.
 * Only explicit `true` grants the web-aware status (opt-in, default-off).
 */
export function isWebAwareRoute(
  capabilities?: ModelRouteCapabilities,
): boolean {
  return capabilities?.webAware === true;
}

/**
 * Check whether a route capabilities object indicates tool-calling support.
 * Only explicit `true` grants tool-calling status.
 */
export function isToolCallingRoute(
  capabilities?: ModelRouteCapabilities,
): boolean {
  return capabilities?.toolCalling === true;
}

/**
 * Check whether a route capabilities object indicates long-context support.
 * Only explicit `true` grants long-context status.
 */
export function isLongContextRoute(
  capabilities?: ModelRouteCapabilities,
): boolean {
  return capabilities?.longContext === true;
}

/**
 * Resolve capabilities with defaults: every missing field becomes false.
 * Returns a complete ModelRouteCapabilities with no undefined values.
 */
export function resolveCapabilities(
  capabilities?: ModelRouteCapabilities,
): Required<ModelRouteCapabilities> {
  return {
    webAware: capabilities?.webAware ?? false,
    toolCalling: capabilities?.toolCalling ?? false,
    longContext: capabilities?.longContext ?? false,
  };
}

// ─────────────────────────────────────────────────────────
// 4. Provider Citation Functions
// ─────────────────────────────────────────────────────────

/**
 * Create a new ProviderCitation with required fields.
 * The citation starts unverified (verifiedByLocalFetch = false).
 */
export function createProviderCitation(
  provider: string,
  model: string,
  url: string,
  overrides?: Partial<Pick<ProviderCitation, "title" | "quotedAt" | "verifiedByLocalFetch">>,
): ProviderCitation {
  return {
    provider,
    model,
    url,
    title: overrides?.title,
    quotedAt: overrides?.quotedAt,
    verifiedByLocalFetch: overrides?.verifiedByLocalFetch ?? false,
  };
}

/**
 * Render a single provider citation as a human-readable line.
 *
 * Unverified citations carry the label "[unverified-provider-citation]".
 * Verified citations carry the label "[provider-citation:verified-by-local-fetch]".
 * All user-supplied fields are passed through redactSecrets.
 */
export function renderProviderCitation(citation: ProviderCitation): string {
  const label = citation.verifiedByLocalFetch
    ? "provider-citation:verified-by-local-fetch"
    : "unverified-provider-citation";

  let line = `[${label}] ${redactSecrets(citation.url)}`;

  if (citation.title) {
    line += ` — ${redactSecrets(citation.title)}`;
  }
  if (citation.quotedAt) {
    line += ` (cited ${redactSecrets(citation.quotedAt)})`;
  }

  line += ` (provider: ${redactSecrets(citation.provider)}, model: ${redactSecrets(citation.model)})`;

  return line;
}

/**
 * Render a list of provider citations into a multi-line string.
 * Each line is rendered via renderProviderCitation. Empty list returns a short
 * empty-state string.
 */
export function renderProviderCitations(citations: ProviderCitation[]): string {
  if (citations.length === 0) {
    return "(no provider citations)";
  }
  return citations.map(renderProviderCitation).join("\n");
}

/**
 * Append a provider citation to a list, returning a NEW array (immutable).
 * Provider citations are NEVER appended to WebTraceRecord arrays.
 */
export function appendProviderCitation(
  citations: ProviderCitation[],
  citation: ProviderCitation,
): ProviderCitation[] {
  return [...citations, citation];
}

/**
 * Build the attribution label for a provider citation.
 * Returns a short, machine-readable label indicating the verification status.
 */
export function buildCitationLabel(citation: ProviderCitation): string {
  if (citation.verifiedByLocalFetch) {
    return "verified-provider-citation";
  }
  return "unverified-provider-citation";
}

// ─────────────────────────────────────────────────────────
// 5. Research Role Prompt Contract
// ─────────────────────────────────────────────────────────

/**
 * Build the system-prompt instruction text for a webAware research route.
 *
 * This prompts the model to:
 *  - distinguish "provider-side source" from "Deepcoder-fetched source"
 *  - include URLs when claiming external facts
 *  - avoid quoting long copyrighted text
 *  - use local web_fetch when exact source text is required
 */
export function buildWebAwarePrompt(): string {
  return [
    "## Web-Aware Research Instructions",
    "",
    "You may have integrated web/search capabilities through your provider.",
    "When you cite external sources, follow these rules:",
    "",
    "1. DISTINGUISH SOURCES: Clearly label whether a fact comes from",
    "   a \"provider-side source\" (your built-in search/knowledge) or a",
    "   \"Deepcoder-fetched source\" (fetched via local web_fetch/web_search tools).",
    "",
    "2. INCLUDE URLS: Always include the URL when claiming an external fact.",
    "   Provider-side citations carry the [unverified-provider-citation] label",
    "   until verified by local web_fetch.",
    "",
    "3. NO LONG COPYRIGHTED TEXT: Do not quote large blocks of copyrighted",
    "   material. Summarise in your own words and cite the source URL.",
    "",
    "4. USE LOCAL FETCH FOR VERIFICATION: If you need the exact text of a",
    "   source, ask the user to run /web fetch <URL> so the result becomes a",
    "   verified local web_fetch record.",
    "",
    "Remember: only local web_search and web_fetch create auditable",
    "WebTraceRecords. Provider-side citations are advisory until verified.",
  ].join("\n");
}

/**
 * Check whether a route with the given capabilities should receive the
 * webAware system-prompt instruction. Returns true only when capabilities
 * are provided AND webAware is explicitly true.
 */
export function shouldInjectWebAwarePrompt(
  capabilities?: ModelRouteCapabilities,
): boolean {
  return isWebAwareRoute(capabilities);
}

// ─────────────────────────────────────────────────────────
// 6. Strict boundary: provider citations vs. web trace
// ─────────────────────────────────────────────────────────

/**
 * Assert that a provider citation is NOT appended to a WebTraceRecord array.
 * This is a safety / documentation boundary — it returns the citation's
 * provenance descriptor to make the distinction obvious at call sites.
 *
 * This function does NOT mutate any array; it purely describes the boundary.
 */
export function describeCitationProvenance(
  _citation: ProviderCitation,
): "provider-side" {
  return "provider-side";
}
