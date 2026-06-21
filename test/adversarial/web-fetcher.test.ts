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
  assert.equal(r.reason, "unsupported content type");
});

// ---------------------------------------------------------------------------
// [10E2-redirect] — manual redirect handling + policy re-check + limit
// ---------------------------------------------------------------------------

test("[10E2-redirect] a redirect to a blocked domain is denied (blocked:true)", async () => {
  /**
   * First call to https://evil.example.com returns 302 -> allowed.example.com.
   * Second call to allowed.example.com returns 302 -> blocked.example.com.
   * The redirect to blocked.example.com should be denied by policy.
   *
   * fetchImpl state machine (use a closure):
   *   call 0: 302 Location: https://allowed.example.com/ok
   *   call 1: 302 Location: https://blocked.example.com/bad
   *   call 2: should never be reached
   */
  const blockPolicy = { allowedDomains: [], blockedDomains: ["blocked.example.com"] };
  let callCount = 0;
  const fetchImpl = (async (url: string) => {
    callCount++;
    if (url.includes("blocked.example.com")) {
      // If we somehow get called for blocked, return success (but test should fail before)
      return new Response("should not be reached", { status: 200, headers: { "content-type": "text/plain" } });
    }
    if (callCount === 1) {
      return new Response("", { status: 302, headers: { location: "https://allowed.example.com/ok" } });
    }
    // callCount === 2: redirect to a blocked domain
    return new Response("", { status: 302, headers: { location: "https://blocked.example.com/bad" } });
  }) as unknown as typeof fetch;

  const r = await fetchUrl("https://evil.example.com/start", {}, { policy: blockPolicy, fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.blocked, true, "redirect target must be blocked by policy");
  assert.equal(callCount, 2, "fetcher must attempt the first redirect before denying the second");
});

test("[10E2-redirect] a redirect chain longer than the limit returns an error", async () => {
  /**
   * Default max redirects = 3. Chain: A->B->C->D->E (4 hops → exceeds limit).
   * Each hop returns a 302 to the next URL.
   */
  const urls = [
    "https://hop0.example.com",
    "https://hop1.example.com",
    "https://hop2.example.com",
    "https://hop3.example.com",
    "https://hop4.example.com",
  ];
  let callIdx = 0;
  const fetchImpl = (async (url: string) => {
    callIdx++;
    if (callIdx <= 4) {
      return new Response("", { status: 302, headers: { location: urls[callIdx] } });
    }
    return new Response("final", { status: 200, headers: { "content-type": "text/plain" } });
  }) as unknown as typeof fetch;

  const r = await fetchUrl(urls[0], {}, { policy: openPolicy, fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "too many redirects");
});

// ---------------------------------------------------------------------------
// [10E2-timeout] — AbortController timeout
// ---------------------------------------------------------------------------

test("[10E2-timeout] a hanging fetch is aborted and returns a timeout error (no throw)", async () => {
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    // Hang until the signal aborts, then reject with AbortError
    return new Promise<Response>((_, reject) => {
      const signal = init?.signal;
      if (signal) {
        const onAbort = () => {
          signal.removeEventListener("abort", onAbort);
          reject(new DOMException("The operation was aborted", "AbortError"));
        };
        signal.addEventListener("abort", onAbort);
      }
      // If there's no signal, just hang forever (test timeout will catch it)
    });
  }) as unknown as typeof fetch;

  // Use a very short timeout so the test doesn't wait long
  const r = await fetchUrl("https://example.com/slow", { timeoutMs: 10 }, { policy: openPolicy, fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "timeout", "must return a timeout reason, not throw");
});

// ---------------------------------------------------------------------------
// [10E2-cap] — byte cap on response body
// ---------------------------------------------------------------------------

test("[10E2-cap] an oversized body is truncated at maxBytes and truncated===true", async () => {
  const body = "Hello, world! ".repeat(200); // ~2800 bytes
  const fetchImpl = (async () =>
    new Response(body, { headers: { "content-type": "text/plain" } })) as unknown as typeof fetch;

  const r = await fetchUrl("https://example.com/big", { maxBytes: 100 }, { policy: openPolicy, fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.truncated, true, "body larger than maxBytes must be truncated");
  assert.ok(r.bytesRead !== undefined && r.bytesRead <= 100, "bytesRead must not exceed maxBytes");
  assert.ok(r.text !== undefined && r.text.length > 0, "truncated text must not be empty");
  // The text should be a prefix of the original
  const originalPrefix = body.slice(0, 100); // approx, UTF-8 means <= 100 chars
  assert.ok(r.text!.startsWith("Hello,"), "truncated text must be a prefix of original");
});

// ---------------------------------------------------------------------------
// [10E2-extract] — HTML extraction (strip script/style/noscript, tags, entities)
// ---------------------------------------------------------------------------

test("[10E2-extract] HTML script/style contents are removed; visible text and <title> are returned", async () => {
  const html = `<!DOCTYPE html>
<html>
<head><title>My Test Page</title></head>
<body>
  <script>alert('xss');</script>
  <style>body { color: red; }</style>
  <noscript>Your browser is not cool</noscript>
  <p>Hello <b>World</b> &amp; welcome!</p>
</body>
</html>`;
  const fetchImpl = (async () =>
    new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })) as unknown as typeof fetch;

  const r = await fetchUrl("https://example.com/page", {}, { policy: openPolicy, fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.title, "My Test Page", "<title> must be extracted");
  assert.ok(r.text, "text must be present");
  assert.ok(r.text!.includes("Hello"), "visible text must survive extraction");
  assert.ok(r.text!.includes("&"), "HTML entities must be decoded (&amp; → &)");
  assert.ok(!r.text!.includes("alert"), "script contents must be stripped");
  assert.ok(!r.text!.includes("xss"), "script contents must be stripped");
  assert.ok(!r.text!.includes("body { color"), "style contents must be stripped");
  assert.ok(!r.text!.includes("Your browser"), "noscript contents must be stripped");
});

// ---------------------------------------------------------------------------
// [10E2-redact] — secret redaction in returned text
// ---------------------------------------------------------------------------

test("[10E2-redact] key-shaped strings in the body are redacted from the output", async () => {
  const body = "My API key is sk-ABCDEF0123456789 and it's secret.";
  const fetchImpl = (async () =>
    new Response(body, { headers: { "content-type": "text/plain" } })) as unknown as typeof fetch;

  const r = await fetchUrl("https://example.com/leaky", {}, { policy: openPolicy, fetchImpl });
  assert.equal(r.ok, true);
  assert.ok(r.text, "text must be present");
  assert.ok(!r.text!.includes("sk-ABCDEF0123456789"), "raw secret key must NOT appear in output");
  assert.ok(r.text!.includes("sk-***"), "secret must be replaced with sk-***");
});
