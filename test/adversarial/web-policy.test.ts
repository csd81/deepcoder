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
