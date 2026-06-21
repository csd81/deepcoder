/**
 * Phase 10E slice 1 — web domain/SSRF policy (pure, no network).
 *
 * Single gate `checkUrlAllowed` every URL must pass before any fetch.
 * Must be re-runnable on every redirect hop.
 *
 * Order of checks (non-negotiable):
 *   1. scheme     — only http/https
 *   2. IP literal — deny any bare IPv4 or IPv6 literal (SSRF guard)
 *   3. localhost  — localhost, *.localhost, *.local
 *   4. blocklist  — always wins
 *   5. allowlist  — only when non-empty
 */

import type { WebDomainPolicy, UrlCheck } from "./types.js";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** True when `domain` equals `host` or is a suffix after a `.` separator. */
function isSubdomainOf(host: string, domain: string): boolean {
  if (host === domain) return true;
  return host.endsWith("." + domain);
}

/** Strip trailing dot from a hostname (fully-qualified form). */
function stripTrailingDot(host: string): string {
  return host.endsWith(".") ? host.slice(0, -1) : host;
}

/** Check whether `host` looks like an IPv4 literal (four dot-separated octets). */
function isIPv4Literal(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    if (p.length === 0) return false;
    // Reject leading zeros (e.g. "01" is not a canonical octet)
    if (p.length > 1 && p[0] === "0") return false;
    const n = Number(p);
    return !Number.isNaN(n) && n >= 0 && n <= 255;
  });
}

/** Check whether the host is an IPv6 literal (URL hostname contains colons). */
function isIPv6Literal(host: string): boolean {
  return host.includes(":");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check whether a raw URL string is allowed by the web domain policy.
 *
 * @param rawUrl  The URL to check (e.g. `"https://example.com/path"`)
 * @param policy  Domain allow/block lists
 * @returns       A `UrlCheck` with the decision and optional reason/host
 */
export function checkUrlAllowed(rawUrl: string, policy: WebDomainPolicy): UrlCheck {
  // 0. Parse — reject malformed URLs
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: "invalid url" };
  }

  // Normalise: URL.hostname is already lowercased by the URL parser.
  const rawHost = url.hostname;
  const host = stripTrailingDot(rawHost);

  // -----------------------------------------------------------------------
  // [10E1-scheme] Only http: and https: protocols are allowed
  // -----------------------------------------------------------------------
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { allowed: false, reason: "scheme not allowed" };
  }

  // -----------------------------------------------------------------------
  // [10E1-ip] Deny IP literals (SSRF guard) — applies regardless of lists
  // -----------------------------------------------------------------------
  if (isIPv4Literal(host)) {
    return { allowed: false, reason: "ip literal not allowed", host };
  }
  if (isIPv6Literal(host)) {
    return { allowed: false, reason: "ip literal not allowed", host };
  }

  // -----------------------------------------------------------------------
  // [10E1-localhost] Deny localhost, *.localhost, *.local
  // -----------------------------------------------------------------------
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local")
  ) {
    return { allowed: false, reason: "localhost/.local not allowed", host };
  }

  // Normalise domain entries for comparison (lowercase, strip trailing dot).
  // Input entries should already be lowercase in practice, but be defensive.
  const normalise = (d: string): string => stripTrailingDot(d.toLowerCase());

  // -----------------------------------------------------------------------
  // [10E1-block] blockedDomains ALWAYS wins (exact + subdomain)
  // -----------------------------------------------------------------------
  const blocked = policy.blockedDomains.map(normalise);
  for (const b of blocked) {
    if (isSubdomainOf(host, b)) {
      return { allowed: false, reason: "blocked domain", host };
    }
  }

  // -----------------------------------------------------------------------
  // [10E1-allow] If allowedDomains is non-empty, host must match
  // -----------------------------------------------------------------------
  if (policy.allowedDomains.length > 0) {
    const allowed = policy.allowedDomains.map(normalise);
    const matched = allowed.some((a) => isSubdomainOf(host, a));
    if (!matched) {
      return { allowed: false, reason: "not in allowlist", host };
    }
  }

  // All checks passed.
  return { allowed: true, host };
}
