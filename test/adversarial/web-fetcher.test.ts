/**
 * Phase 10E slice 2 — safe web fetcher core (pure, INJECTED fetch seam, no real network).
 *
 * fetchUrl is the read-only fetch primitive behind web_fetch. It re-runs the
 * domain policy (slice 1) on the initial URL AND every redirect hop, enforces a
 * timeout, a byte cap, a redirect limit, a MIME allowlist, strips HTML to bounded
 * text, and redacts secrets. It NEVER throws — failures come back as a bounded
 * FetchResult. The network is an injected `fetchImpl` seam, so tests use fakes.
 *
 * Deliverables (each tagged [10E2-*]):
 *   [10E2-policy]   a policy-denied URL returns blocked WITHOUT calling fetchImpl
 *   [10E2-redirect] a redirect to a blocked domain is denied; the redirect limit is enforced
 *   [10E2-timeout]  a hanging fetch is aborted -> bounded error result, not a throw
 *   [10E2-cap]      an oversized body is truncated at maxBytes
 *   [10E2-mime]     an unsupported content-type is refused
 *   [10E2-extract]  HTML is stripped of script/style and tags, bounded to maxChars
 *   [10E2-redact]   key-shaped strings in the body are redacted from the output
 *
 * RED ANCHOR: imports from src/web/fetcher.ts which does not exist yet.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fetchUrl } from "../../src/web/fetcher.js";

const openPolicy = { allowedDomains: [], blockedDomains: [] };

test("[10E2-policy] a policy-denied URL is blocked and never calls fetchImpl", async () => {
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return new Response("nope");
  }) as unknown as typeof fetch;
  const r = await fetchUrl("http://169.254.169.254/latest/meta-data/", {}, { policy: openPolicy, fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.blocked, true, "metadata IP must be blocked by policy");
  assert.equal(called, false, "fetchImpl must NOT be called for a denied URL");
});

test("[10E2-mime] an unsupported content-type is refused", async () => {
  const fetchImpl = (async () =>
    new Response("\x89PNG...", { status: 200, headers: { "content-type": "image/png" } })) as unknown as typeof fetch;
  const r = await fetchUrl("https://example.com/logo.png", {}, { policy: openPolicy, fetchImpl });
  assert.equal(r.ok, false, "image/* is not in the MIME allowlist");
});
