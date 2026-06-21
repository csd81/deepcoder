/**
 * Phase 10E slice 1 — web domain/SSRF policy (pure, no network).
 *
 * The safety boundary for the read-only web tools. checkUrlAllowed is the single
 * gate every URL must pass before any fetch: scheme, IP-literal/private/link-local/
 * loopback/metadata blocking, blocklist (always wins), and allowlist (exact +
 * subdomain). Must be re-runnable on every redirect hop.
 *
 * Deliverables (each tagged [10E1-*]):
 *   [10E1-scheme]    only http/https allowed; other schemes denied
 *   [10E1-block]     blockedDomains always wins, even over an allowlisted host
 *   [10E1-allow]     allowlist matches exact + subdomain; lookalikes denied
 *   [10E1-ip]        IP literals + private/link-local/loopback/metadata denied
 *   [10E1-localhost] localhost and *.local denied
 *
 * RED ANCHOR: imports from src/web/policy.ts which does not exist yet.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { checkUrlAllowed } from "../../src/web/policy.js";

test("[10E1-ip] cloud metadata IP is denied even with empty policy lists", () => {
  const r = checkUrlAllowed("http://169.254.169.254/latest/meta-data/", {
    allowedDomains: [],
    blockedDomains: [],
  });
  assert.equal(r.allowed, false, "link-local/metadata IP must be blocked");
});

test("[10E1-allow] allowlisted apex permits a subdomain but not a lookalike", () => {
  const policy = { allowedDomains: ["example.com"], blockedDomains: [] };
  assert.equal(checkUrlAllowed("https://docs.example.com/x", policy).allowed, true);
  assert.equal(checkUrlAllowed("https://badexample.com/x", policy).allowed, false);
});

test("[10E1-block] blocklist overrides the allowlist", () => {
  const r = checkUrlAllowed("https://example.com/", {
    allowedDomains: ["example.com"],
    blockedDomains: ["example.com"],
  });
  assert.equal(r.allowed, false, "blocked domain wins over allow");
});

// ---------------------------------------------------------------------------
// [10E1-scheme]  Only http: and https: allowed
// ---------------------------------------------------------------------------
test("[10E1-scheme] file: scheme is denied", () => {
  const r = checkUrlAllowed("file:///etc/passwd", { allowedDomains: [], blockedDomains: [] });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "scheme not allowed");
});

test("[10E1-scheme] ftp: scheme is denied", () => {
  const r = checkUrlAllowed("ftp://files.example.com/readme.txt", { allowedDomains: [], blockedDomains: [] });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "scheme not allowed");
});

test("[10E1-scheme] data: URI is denied", () => {
  const r = checkUrlAllowed("data:text/plain;base64,SGVsbG8=", { allowedDomains: [], blockedDomains: [] });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "scheme not allowed");
});

test("[10E1-scheme] javascript: URI is denied", () => {
  const r = checkUrlAllowed("javascript:alert(1)", { allowedDomains: [], blockedDomains: [] });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "scheme not allowed");
});

// ---------------------------------------------------------------------------
// [10E1-ip]  IP literal / SSRF guard
// ---------------------------------------------------------------------------
test("[10E1-ip] loopback 127.0.0.1 is denied", () => {
  const r = checkUrlAllowed("http://127.0.0.1/", { allowedDomains: [], blockedDomains: [] });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "ip literal not allowed");
});

test("[10E1-ip] loopback 127.255.0.1 is denied", () => {
  const r = checkUrlAllowed("http://127.255.0.1/", { allowedDomains: [], blockedDomains: [] });
  assert.equal(r.allowed, false);
});

test("[10E1-ip] private 10.0.0.1 is denied", () => {
  const r = checkUrlAllowed("http://10.0.0.1/admin", { allowedDomains: [], blockedDomains: [] });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "ip literal not allowed");
});

test("[10E1-ip] private 172.16.0.1 is denied", () => {
  const r = checkUrlAllowed("http://172.16.0.1/", { allowedDomains: [], blockedDomains: [] });
  assert.equal(r.allowed, false);
});

test("[10E1-ip] private 192.168.1.1 is denied", () => {
  const r = checkUrlAllowed("http://192.168.1.1/", { allowedDomains: [], blockedDomains: [] });
  assert.equal(r.allowed, false);
});

test("[10E1-ip] link-local 169.254.169.254 (cloud metadata) is denied", () => {
  const r = checkUrlAllowed("http://169.254.169.254/latest/meta-data/", {
    allowedDomains: ["169.254.169.254"],
    blockedDomains: [],
  });
  assert.equal(r.allowed, false, "metadata IP must be blocked even if allowlisted");
});

test("[10E1-ip] 0.0.0.0 is denied", () => {
  const r = checkUrlAllowed("http://0.0.0.0/", { allowedDomains: [], blockedDomains: [] });
  assert.equal(r.allowed, false);
});

test("[10E1-ip] public IPv4 literal 8.8.8.8 is denied (all IPv4 literals denied)", () => {
  const r = checkUrlAllowed("http://8.8.8.8/", { allowedDomains: [], blockedDomains: [] });
  assert.equal(r.allowed, false);
});

test("[10E1-ip] IPv6 loopback ::1 is denied", () => {
  const r = checkUrlAllowed("http://[::1]/", { allowedDomains: [], blockedDomains: [] });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "ip literal not allowed");
});

test("[10E1-ip] IPv6 unique-local fc00:: is denied", () => {
  const r = checkUrlAllowed("http://[fc00::]/", { allowedDomains: [], blockedDomains: [] });
  assert.equal(r.allowed, false);
});

test("[10E1-ip] IPv6 link-local fe80::1 is denied", () => {
  const r = checkUrlAllowed("http://[fe80::1]/", { allowedDomains: [], blockedDomains: [] });
  assert.equal(r.allowed, false);
});

test("[10E1-ip] IPv6 unspecified :: is denied", () => {
  const r = checkUrlAllowed("http://[::]/", { allowedDomains: [], blockedDomains: [] });
  assert.equal(r.allowed, false);
});

// ---------------------------------------------------------------------------
// [10E1-localhost]  localhost / .localhost / .local
// ---------------------------------------------------------------------------
test("[10E1-localhost] localhost hostname is denied", () => {
  const r = checkUrlAllowed("http://localhost/", { allowedDomains: [], blockedDomains: [] });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "localhost/.local not allowed");
});

test("[10E1-localhost] subdomain.localhost is denied", () => {
  const r = checkUrlAllowed("http://api.localhost/", { allowedDomains: [], blockedDomains: [] });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "localhost/.local not allowed");
});

test("[10E1-localhost] .local mDNS hostname is denied", () => {
  const r = checkUrlAllowed("http://printer.local/", { allowedDomains: [], blockedDomains: [] });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "localhost/.local not allowed");
});

test("[10E1-localhost] deep .local subdomain is denied", () => {
  const r = checkUrlAllowed("http://my.printer.local/", { allowedDomains: [], blockedDomains: [] });
  assert.equal(r.allowed, false);
});

// ---------------------------------------------------------------------------
// [10E1-block]  blockedDomains always wins
// ---------------------------------------------------------------------------
test("[10E1-block] subdomain of blocked domain is also blocked", () => {
  const r = checkUrlAllowed("https://sub.verybad.com/", {
    allowedDomains: ["verybad.com"],
    blockedDomains: ["verybad.com"],
  });
  assert.equal(r.allowed, false, "subdomain of blocked domain must be blocked");
});

test("[10E1-block] blocked host gets reason 'blocked domain' and host field", () => {
  const r = checkUrlAllowed("https://evil.com/", {
    allowedDomains: ["good.com"],
    blockedDomains: ["evil.com"],
  });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "blocked domain");
  assert.equal(r.host, "evil.com");
});

// ---------------------------------------------------------------------------
// [10E1-allow]  allowlist behaviour
// ---------------------------------------------------------------------------
test("[10E1-allow] empty allowlist allows a clean domain", () => {
  const r = checkUrlAllowed("https://trusted.example.com/", {
    allowedDomains: [],
    blockedDomains: [],
  });
  assert.equal(r.allowed, true);
  assert.equal(r.host, "trusted.example.com");
});

test("[10E1-allow] exact match on allowlist entry is allowed", () => {
  const r = checkUrlAllowed("https://example.com/", {
    allowedDomains: ["example.com"],
    blockedDomains: [],
  });
  assert.equal(r.allowed, true);
});

test("[10E1-allow] subdomain of allowlist entry is allowed", () => {
  const r = checkUrlAllowed("https://docs.example.com/", {
    allowedDomains: ["example.com"],
    blockedDomains: [],
  });
  assert.equal(r.allowed, true);
});

test("[10E1-allow] deep subdomain of allowlist entry is allowed", () => {
  const r = checkUrlAllowed("https://a.b.c.example.com/", {
    allowedDomains: ["example.com"],
    blockedDomains: [],
  });
  assert.equal(r.allowed, true);
});

test("[10E1-allow] lookalike badexample.com is denied", () => {
  const r = checkUrlAllowed("https://badexample.com/", {
    allowedDomains: ["example.com"],
    blockedDomains: [],
  });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "not in allowlist");
});

test("[10E1-allow] lookalike notexample.com is denied", () => {
  const r = checkUrlAllowed("https://notexample.com/", {
    allowedDomains: ["example.com"],
    blockedDomains: [],
  });
  assert.equal(r.allowed, false);
});

test("[10E1-allow] case-insensitive matching on allowlist", () => {
  const r = checkUrlAllowed("https://EXAMPLE.COM/", {
    allowedDomains: ["Example.COM"],
    blockedDomains: [],
  });
  assert.equal(r.allowed, true, "case should not matter");
});

test("[10E1-allow] trailing dot on host is stripped", () => {
  const r = checkUrlAllowed("https://example.com./", {
    allowedDomains: ["example.com"],
    blockedDomains: [],
  });
  assert.equal(r.allowed, true, "trailing dot should be stripped");
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------
test("[10E1-scheme] invalid URL returns invalid reason", () => {
  const r = checkUrlAllowed("not a url", { allowedDomains: [], blockedDomains: [] });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "invalid url");
});

test("empty string URL is invalid", () => {
  const r = checkUrlAllowed("", { allowedDomains: [], blockedDomains: [] });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "invalid url");
});

test("host field is set when allowed", () => {
  const r = checkUrlAllowed("https://api.example.com/path?q=1", {
    allowedDomains: ["example.com"],
    blockedDomains: [],
  });
  assert.equal(r.allowed, true);
  assert.equal(r.host, "api.example.com");
});
