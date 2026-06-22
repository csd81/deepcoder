/**
 * Phase 10E.7 — OpenRouter Search-Capable Research Routing (adversarial tests).
 *
 * Pure-module tests for searchCapableRouting.ts. No live OpenRouter calls, no
 * network, no terminal I/O.
 *
 * Deliverables (each tagged [10E7-*]):
 *   [10E7-cap-guards]    isWebAwareRoute / isToolCallingRoute / isLongContextRoute
 *                        accept optional capabilities (true → true, false/undefined → false)
 *   [10E7-resolve]       resolveCapabilities fills defaults and handles partial input
 *   [10E7-citation]      provider-side citations render with an "unverified" marker
 *   [10E7-citation-verified] verified citations render with a "verified" marker
 *   [10E7-append]        appendProviderCitation returns a new array (immutable, not web_trace)
 *   [10E7-prompt]        buildWebAwarePrompt includes the local-fetch verification instruction
 *   [10E7-should-inject] shouldInjectWebAwarePrompt only true for webAware routes
 *   [10E7-redact]        no provider citation text bypasses redactSecrets
 *   [10E7-provenance]    describeCitationProvenance returns "provider-side"
 *   [10E7-label]         buildCitationLabel yields correct labels for verified/unverified
 *   [10E7-render-list]   renderProviderCitations handles empty and non-empty lists
 *
 * RED ANCHOR: imports from src/web/searchCapableRouting.ts which does not exist yet.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  isWebAwareRoute,
  isToolCallingRoute,
  isLongContextRoute,
  resolveCapabilities,
  createProviderCitation,
  renderProviderCitation,
  renderProviderCitations,
  appendProviderCitation,
  buildCitationLabel,
  buildWebAwarePrompt,
  shouldInjectWebAwarePrompt,
  describeCitationProvenance,
  type ModelRouteCapabilities,
  type ProviderCitation,
} from "../../src/web/searchCapableRouting.js";
import type { WebTraceRecord } from "../../src/web/trace.js";

// ─────────────────────────────────────────────────────────
// [10E7-cap-guards]  Capability guards
// ─────────────────────────────────────────────────────────

test("[10E7-cap-guards] isWebAwareRoute: explicit true → true, anything else → false", () => {
  assert.equal(isWebAwareRoute({ webAware: true }), true, "explicit true");

  assert.equal(isWebAwareRoute({ webAware: false }), false, "explicit false");
  assert.equal(isWebAwareRoute({}), false, "empty capabilities");
  assert.equal(isWebAwareRoute(undefined), false, "undefined capabilities");
  assert.equal(isWebAwareRoute({ webAware: undefined }), false, "webAware undefined");
  // Truthy-but-not-true must NOT grant access (strict opt-in)
  assert.equal(isWebAwareRoute({ webAware: "yes" as unknown as boolean }), false, "string 'yes' is not true");
  assert.equal(isWebAwareRoute({ webAware: 1 as unknown as boolean }), false, "number 1 is not true");
});

test("[10E7-cap-guards] isToolCallingRoute: explicit true → true, anything else → false", () => {
  assert.equal(isToolCallingRoute({ toolCalling: true }), true, "explicit true");
  assert.equal(isToolCallingRoute({ toolCalling: false }), false, "explicit false");
  assert.equal(isToolCallingRoute({}), false, "empty capabilities");
  assert.equal(isToolCallingRoute(undefined), false, "undefined capabilities");
});

test("[10E7-cap-guards] isLongContextRoute: explicit true → true, anything else → false", () => {
  assert.equal(isLongContextRoute({ longContext: true }), true, "explicit true");
  assert.equal(isLongContextRoute({ longContext: false }), false, "explicit false");
  assert.equal(isLongContextRoute({}), false, "empty capabilities");
  assert.equal(isLongContextRoute(undefined), false, "undefined capabilities");
});

// ─────────────────────────────────────────────────────────
// [10E7-resolve]  resolveCapabilities fills defaults
// ─────────────────────────────────────────────────────────

test("[10E7-resolve] resolveCapabilities fills every field with defaults", () => {
  const allFalse = resolveCapabilities(undefined);
  assert.equal(allFalse.webAware, false);
  assert.equal(allFalse.toolCalling, false);
  assert.equal(allFalse.longContext, false);

  const partial = resolveCapabilities({ webAware: true });
  assert.equal(partial.webAware, true);
  assert.equal(partial.toolCalling, false, "missing fields default to false");
  assert.equal(partial.longContext, false, "missing fields default to false");

  const allSet = resolveCapabilities({ webAware: true, toolCalling: true, longContext: true });
  assert.equal(allSet.webAware, true);
  assert.equal(allSet.toolCalling, true);
  assert.equal(allSet.longContext, true);
});

// ─────────────────────────────────────────────────────────
// [10E7-citation]  Provider citation rendering (unverified)
// ─────────────────────────────────────────────────────────

test("[10E7-citation] renderProviderCitation includes unverified marker for unverified citations", () => {
  const citation = createProviderCitation("openrouter", "openrouter/auto", "https://example.com/research");
  const rendered = renderProviderCitation(citation);

  assert.ok(rendered.includes("unverified-provider-citation"), "must include unverified label");
  assert.ok(rendered.includes("https://example.com/research"), "must include URL");
  assert.ok(rendered.includes("openrouter"), "must include provider");
  assert.ok(rendered.includes("openrouter/auto"), "must include model");
  // NB: "unverified-provider-citation" legitimately contains the substring
  // "verified" — assert it doesn't claim the VERIFIED marker, not the substring.
  assert.ok(!rendered.includes("verified-by-local-fetch"), "must not claim verified status");
});

test("[10E7-citation] renderProviderCitation includes title and quotedAt when provided", () => {
  const citation = createProviderCitation("openrouter", "openrouter/free", "https://example.com/article", {
    title: "Research Article",
    quotedAt: "2026-07-01T12:00:00Z",
  });
  const rendered = renderProviderCitation(citation);

  assert.ok(rendered.includes("Research Article"), "must include title");
  assert.ok(rendered.includes("2026-07-01T12:00:00Z"), "must include quotedAt");
});

// ─────────────────────────────────────────────────────────
// [10E7-citation-verified]  Verified citation rendering
// ─────────────────────────────────────────────────────────

test("[10E7-citation-verified] renderProviderCitation shows verified marker for verified citations", () => {
  const citation = createProviderCitation("openrouter", "openrouter/auto", "https://example.com/verified", {
    verifiedByLocalFetch: true,
  });
  const rendered = renderProviderCitation(citation);

  assert.ok(rendered.includes("verified-by-local-fetch"), "must include verified label");
  assert.ok(!rendered.includes("unverified"), "must not include unverified label");
});

// ─────────────────────────────────────────────────────────
// [10E7-append]  appendProviderCitation is immutable, not web_trace
// ─────────────────────────────────────────────────────────

test("[10E7-append] appendProviderCitation returns a new array and does not mutate input", () => {
  const before: ProviderCitation[] = [
    createProviderCitation("openrouter", "m1", "https://example.com/a"),
  ];
  const added = createProviderCitation("openrouter", "m2", "https://example.com/b");
  const after = appendProviderCitation(before, added);

  assert.equal(before.length, 1, "input array unchanged");
  assert.equal(after.length, 2, "new array has both citations");
  assert.notEqual(before, after, "returns a new array reference");
  assert.equal(after[0].url, "https://example.com/a", "first element preserved");
  assert.equal(after[1].url, "https://example.com/b", "second element is the new citation");
});

/**
 * [10E7-append] Provider citations are NEVER appended to WebTraceRecord arrays.
 * This test verifies the type-level distinction by showing that
 * appendProviderCitation returns ProviderCitation[], not WebTraceRecord[].
 */
test("[10E7-append] appendProviderCitation returns ProviderCitation[] — not WebTraceRecord[]", () => {
  const citations: ProviderCitation[] = [];
  const result = appendProviderCitation(
    citations,
    createProviderCitation("openrouter", "m", "https://example.com/"),
  );

  // Type-level proof: result is ProviderCitation[], not WebTraceRecord[]
  // We assert by checking fields that only exist on ProviderCitation
  assert.equal(result.length, 1);
  assert.equal(typeof result[0].provider, "string", "ProviderCitation has .provider");
  assert.equal(typeof result[0].model, "string", "ProviderCitation has .model");
  assert.equal(result[0].verifiedByLocalFetch, false, "starts unverified");

  // Verify that a WebTraceRecord has different fields (kind, fetchedAt)
  // We can't structurally assign a ProviderCitation to WebTraceRecord
  // because WebTraceRecord requires `kind` and `fetchedAt`.
  const webRecord: WebTraceRecord = {
    id: "fetch-1",
    kind: "fetch",
    url: "https://example.com/",
    fetchedAt: "2026-07-01T00:00:00Z",
  };
  assert.equal(webRecord.kind, "fetch", "WebTraceRecord has .kind");
  assert.equal(webRecord.fetchedAt, "2026-07-01T00:00:00Z", "WebTraceRecord has .fetchedAt");
  // ProviderCitation does NOT have .kind or .fetchedAt — they are separate types
});

// ─────────────────────────────────────────────────────────
// [10E7-prompt]  buildWebAwarePrompt content
// ─────────────────────────────────────────────────────────

test("[10E7-prompt] buildWebAwarePrompt includes the local-fetch verification instruction", () => {
  const prompt = buildWebAwarePrompt();

  assert.ok(prompt.includes("Deepcoder-fetched source"), "must mention Deepcoder-fetched source");
  assert.ok(prompt.includes("web_fetch"), "must mention web_fetch");
  assert.ok(prompt.includes("unverified-provider-citation"), "must mention unverified label");
  assert.ok(prompt.includes("WebTraceRecord"), "must mention WebTraceRecord");
  assert.ok(prompt.includes("URL"), "must instruct to include URLs");
  assert.ok(prompt.length > 200, "prompt is substantial");
});

test("[10E7-prompt] buildWebAwarePrompt includes source distinction rules", () => {
  const prompt = buildWebAwarePrompt();

  assert.ok(prompt.includes("provider-side source"), "must mention provider-side source");
  assert.ok(prompt.includes("DISTINGUISH SOURCES"), "must have DISTINGUISH SOURCES heading");
  assert.ok(prompt.includes("INCLUDE URLS"), "must have INCLUDE URLS heading");
  assert.ok(prompt.includes("NO LONG COPYRIGHTED TEXT"), "must have copyright notice");
  assert.ok(prompt.includes("USE LOCAL FETCH"), "must have USE LOCAL FETCH heading");
});

// ─────────────────────────────────────────────────────────
// [10E7-should-inject]  shouldInjectWebAwarePrompt gate
// ─────────────────────────────────────────────────────────

test("[10E7-should-inject] shouldInjectWebAwarePrompt is true only for webAware routes", () => {
  assert.equal(shouldInjectWebAwarePrompt({ webAware: true }), true, "webAware route");
  assert.equal(shouldInjectWebAwarePrompt({ webAware: false }), false, "not webAware");
  assert.equal(shouldInjectWebAwarePrompt({}), false, "empty capabilities");
  assert.equal(shouldInjectWebAwarePrompt(undefined), false, "undefined capabilities");
  assert.equal(shouldInjectWebAwarePrompt({ toolCalling: true, longContext: true }), false, "other caps alone");
});

// ─────────────────────────────────────────────────────────
// [10E7-redact]  Provider citation text is redacted
// ─────────────────────────────────────────────────────────

test("[10E7-redact] secret key patterns in provider citation URL are redacted", () => {
  const citation = createProviderCitation("openrouter", "m", "https://example.com/?token=sk-ABCDEF0123456789");
  const rendered = renderProviderCitation(citation);

  assert.ok(!rendered.includes("sk-ABCDEF0123456789"), "raw key must not appear");
  // redactSecrets is defense-in-depth: the first regex replaces the key with
  // sk-***, but subsequent regexes (e.g. token=...) may redact further, so we
  // check for *** rather than sk-*** specifically.
  assert.ok(rendered.includes("***"), "some redaction marker appears");
});

test("[10E7-redact] secret key patterns in provider citation title are redacted", () => {
  const citation = createProviderCitation("openrouter", "m", "https://example.com/doc", {
    title: "API key is sk-ABCDEF0123456789",
  });
  const rendered = renderProviderCitation(citation);

  assert.ok(!rendered.includes("sk-ABCDEF0123456789"), "raw key must not appear in title");
});

test("[10E7-redact] secret key patterns in provider name/model are redacted", () => {
  const citation = createProviderCitation("openrouter-sk-ABCDEF0123456789", "model-with-sk-ABCDEF0123456789", "https://example.com/");
  const rendered = renderProviderCitation(citation);

  assert.ok(!rendered.includes("sk-ABCDEF0123456789"), "raw key must not appear in provider/model");
});

// ─────────────────────────────────────────────────────────
// [10E7-provenance]  describeCitationProvenance boundary
// ─────────────────────────────────────────────────────────

test("[10E7-provenance] describeCitationProvenance returns 'provider-side'", () => {
  const citation = createProviderCitation("openrouter", "m", "https://example.com/");
  assert.equal(describeCitationProvenance(citation), "provider-side");
});

// ─────────────────────────────────────────────────────────
// [10E7-label]  buildCitationLabel
// ─────────────────────────────────────────────────────────

test("[10E7-label] buildCitationLabel returns correct labels", () => {
  const unverified = createProviderCitation("openrouter", "m", "https://example.com/");
  assert.equal(buildCitationLabel(unverified), "unverified-provider-citation");

  const verified = createProviderCitation("openrouter", "m", "https://example.com/", {
    verifiedByLocalFetch: true,
  });
  assert.equal(buildCitationLabel(verified), "verified-provider-citation");
});

// ─────────────────────────────────────────────────────────
// [10E7-render-list]  renderProviderCitations
// ─────────────────────────────────────────────────────────

test("[10E7-render-list] renderProviderCitations with empty list", () => {
  const result = renderProviderCitations([]);
  assert.equal(result, "(no provider citations)");
});

test("[10E7-render-list] renderProviderCitations with multiple citations produces one line each", () => {
  const citations = [
    createProviderCitation("openrouter", "m1", "https://example.com/a", { title: "A" }),
    createProviderCitation("openrouter", "m2", "https://example.com/b", { title: "B" }),
  ];
  const result = renderProviderCitations(citations);
  const lines = result.split("\n");

  assert.equal(lines.length, 2, "one line per citation");
  assert.ok(lines[0].includes("https://example.com/a"), "first citation URL");
  assert.ok(lines[1].includes("https://example.com/b"), "second citation URL");
  assert.ok(lines[0].includes("unverified-provider-citation"), "first citation unverified");
  assert.ok(lines[1].includes("unverified-provider-citation"), "second citation unverified");
});

// ─────────────────────────────────────────────────────────
// [10E7-create]  createProviderCitation edge cases
// ─────────────────────────────────────────────────────────

test("[10E7-create] createProviderCitation defaults verifiedByLocalFetch to false", () => {
  const citation = createProviderCitation("openrouter", "m", "https://example.com/");
  assert.equal(citation.verifiedByLocalFetch, false);
  assert.equal(citation.provider, "openrouter");
  assert.equal(citation.model, "m");
  assert.equal(citation.url, "https://example.com/");
  assert.equal(citation.title, undefined);
  assert.equal(citation.quotedAt, undefined);
});

test("[10E7-create] createProviderCitation accepts explicit verifiedByLocalFetch true", () => {
  const citation = createProviderCitation("openrouter", "m", "https://example.com/", {
    verifiedByLocalFetch: true,
  });
  assert.equal(citation.verifiedByLocalFetch, true);
});

// ─────────────────────────────────────────────────────────
// [10E7-cap-guards]  Combined capability checks
// ─────────────────────────────────────────────────────────

test("[10E7-cap-guards] all guards work independently on the same capabilities object", () => {
  const caps: ModelRouteCapabilities = { webAware: true, toolCalling: false, longContext: true };

  assert.equal(isWebAwareRoute(caps), true);
  assert.equal(isToolCallingRoute(caps), false);
  assert.equal(isLongContextRoute(caps), true);
});

// ─────────────────────────────────────────────────────────
// Safety: no provider citation is structurally a WebTraceRecord
// ─────────────────────────────────────────────────────────

test("[10E7-safety] ProviderCitation type is structurally distinct from WebTraceRecord", () => {
  // ProviderCitation does NOT have 'kind' or 'fetchedAt' which WebTraceRecord requires.
  // This is a compile-time assertion encoded as a runtime check:
  const pc: ProviderCitation = createProviderCitation("o", "m", "https://ex.com/");
  // @ts-expect-error — WebTraceRecord fields should NOT exist on ProviderCitation
  const hasKind = (pc as Record<string, unknown>).kind;
  assert.equal(hasKind, undefined, "ProviderCitation must not have 'kind' field from WebTraceRecord");

  // @ts-expect-error — WebTraceRecord fields should NOT exist on ProviderCitation
  const hasFetchedAt = (pc as Record<string, unknown>).fetchedAt;
  assert.equal(hasFetchedAt, undefined, "ProviderCitation must not have 'fetchedAt' field from WebTraceRecord");
});
