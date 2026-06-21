/**
 * Phase 10E slice 1 — web domain/SSRF policy types.
 *
 * Pure data types; no imports, no side effects.
 */

export interface WebDomainPolicy {
  allowedDomains: string[];
  blockedDomains: string[];
}

export interface UrlCheck {
  allowed: boolean;
  reason?: string;
  host?: string;
}
