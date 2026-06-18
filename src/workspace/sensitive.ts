import path from "node:path";

/**
 * Paths that may hold secrets and should not be read into the model context or
 * auto-`cat`'d. This is a default-secure guard, not a hard security boundary —
 * the bytes still exist on disk; we just refuse to surface them automatically.
 */
const SENSITIVE_PATTERNS: RegExp[] = [
  /(^|\/)\.env($|\.|\/)/, // .env, .env.local, .env.production, ...
  /(^|\/)\.deepcoder(\/|$)/, // session store, instructions cache
  /(^|\/)\.git(\/|$)/, // raw git internals
  /(^|\/)(id_rsa|id_ed25519|id_dsa)(\.pub)?$/,
  /\.pem$/,
  /(^|\/)credentials(\.json|\.yaml|\.yml)?$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.aws(\/|$)/,
];

/** True if a workspace-relative (or bare) path looks like it may hold secrets. */
export function isSensitivePath(p: string): boolean {
  const normalized = p.replace(/\\/g, "/");
  const base = path.basename(normalized);
  return SENSITIVE_PATTERNS.some((re) => re.test(normalized) || re.test(base));
}
