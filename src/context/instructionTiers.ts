/**
 * Tiered instruction model (pure, unwired core).
 *
 * Instructions can come from several authorities. This module expresses that as
 * an explicit, ordered set of *tiers* with per-source attribution, plus a safe
 * `@include` expander whose file access is injected (so it is fully testable
 * without touching disk).
 *
 * Everything here is pure: no `Date.now`, no `Math.random`, no filesystem — the
 * only I/O is the caller-supplied `readFile` reader passed to
 * {@link resolveIncludes}. Output is deterministic for a given input.
 *
 * This is the inert core. Discovery, disk reads, and wiring into the system
 * prompt live elsewhere; this file never imports a real filesystem.
 */

/**
 * The instruction authority tiers, listed from highest authority (most
 * binding, hardest to override) to most local/specific.
 *
 * - `managed`   — administrator/org policy (e.g. `/etc/deepcoder/...`).
 * - `user`      — the user's personal instructions (`~/.deepcoder/...`).
 * - `workspace` — project files committed to the repo (`AGENTS.md`, ...).
 * - `local`     — private, gitignored workspace overrides (`*.local.md`).
 * - `path`      — directory/path-local instructions deep in the tree.
 */
export type InstructionTier = "managed" | "user" | "workspace" | "local" | "path";

/**
 * Explicit precedence ranking, highest authority first. `managed` is index 0
 * (outranks everything); `path` is last (most specific/local). This ordering is
 * the single source of truth — render and sort both derive from it, so the
 * precedence cannot be inverted by the order sources happen to arrive in.
 */
export const TIER_PRECEDENCE: readonly InstructionTier[] = [
  "managed",
  "user",
  "workspace",
  "local",
  "path",
] as const;

/** Lower rank == higher authority. Unknown tiers sort after all known tiers. */
export function tierRank(tier: InstructionTier): number {
  const i = TIER_PRECEDENCE.indexOf(tier);
  return i === -1 ? TIER_PRECEDENCE.length : i;
}

/** One attributed instruction source. */
export interface InstructionSource {
  /** Authority tier this source belongs to. */
  tier: InstructionTier;
  /** A file path or label, used for attribution in rendered output. */
  origin: string;
  /** The (already include-expanded, if desired) instruction text. */
  text: string;
}

/**
 * Deterministic, stable ordering by tier precedence then origin.
 *
 * Sources are ordered highest authority first (`managed` before `user` before
 * ... before `path`); within a tier, by `origin` lexicographically; ties keep
 * their original relative order (a true stable sort). Pure — returns a new
 * array and does not mutate the input.
 */
export function orderSources(sources: readonly InstructionSource[]): InstructionSource[] {
  return sources
    .map((source, index) => ({ source, index }))
    .sort((a, b) => {
      const byTier = tierRank(a.source.tier) - tierRank(b.source.tier);
      if (byTier !== 0) return byTier;
      const byOrigin = a.source.origin < b.source.origin ? -1 : a.source.origin > b.source.origin ? 1 : 0;
      if (byOrigin !== 0) return byOrigin;
      return a.index - b.index; // stable: preserve input order on full ties
    })
    .map((entry) => entry.source);
}

/** Default cap on the rendered tier block, in bytes of UTF-8 text. */
export const DEFAULT_RENDER_MAX_BYTES = 24_000;

/**
 * Render sources into one attributed block, grouped by tier in precedence
 * order. Each chunk is labeled with its tier and origin so the model (and any
 * audit) can see exactly where a rule came from and how binding it is.
 *
 * Bounded and deterministic: chunks are emitted in {@link orderSources} order
 * until `maxBytes` would be exceeded, after which remaining chunks are dropped
 * (never reordered, never partially emitted).
 */
export function renderTiers(
  sources: readonly InstructionSource[],
  maxBytes: number = DEFAULT_RENDER_MAX_BYTES,
): string {
  const ordered = orderSources(sources);
  const segments: string[] = [];
  let used = 0;
  let lastTier: InstructionTier | null = null;
  for (const src of ordered) {
    const body = src.text.trim();
    if (!body) continue; // empty source contributes nothing
    const parts: string[] = [];
    if (src.tier !== lastTier) {
      parts.push(`# ═══ tier: ${src.tier} ═══`);
    }
    parts.push(`# ── [${src.tier}] ${src.origin} ──`);
    parts.push(body);
    const segment = parts.join("\n");
    const size = Buffer.byteLength(segment) + 2; // +2 for the joining blank line
    if (used + size > maxBytes) break; // bounded: stop, deterministically
    used += size;
    segments.push(segment);
    lastTier = src.tier;
  }
  return segments.join("\n\n");
}

/** Why an `@include` directive was not expanded. */
export type IncludeSkipReason = "not-allowed" | "depth" | "cycle" | "missing";

/** A noted, skipped `@include` — surfaced instead of silently dropped. */
export interface IncludeSkip {
  /** The path as written in the directive. */
  path: string;
  reason: IncludeSkipReason;
}

export interface ResolveIncludeOptions {
  /**
   * Allowlist predicate: returns true only for paths permitted to be included
   * (e.g. text files under an allowed root). Paths failing this are refused and
   * never read. This is the path-confinement gate — `/etc/passwd`, `../../x`,
   * etc. must be rejected here.
   */
  isAllowed: (path: string) => boolean;
  /**
   * Maximum nesting depth of includes. `0` expands nothing; `1` expands
   * top-level includes but not includes within them; and so on.
   */
  maxDepth: number;
}

export interface ResolveIncludeResult {
  /** The text with each safe `@include` replaced by its (recursive) expansion. */
  text: string;
  /** Every include that was refused/skipped, in encounter order. */
  skipped: IncludeSkip[];
}

// An include directive: a line whose sole content is `@include <path>`.
const INCLUDE_LINE = /^@include\s+(\S+)\s*$/;

/**
 * Expand `@include <path>` directives in `text`, reading included files via the
 * injected `readFile` (which returns `undefined` for a missing/unreadable
 * path). Safe and bounded:
 *  - every target must pass `opts.isAllowed`, else it is refused (not read);
 *  - nesting is capped at `opts.maxDepth`;
 *  - cycles (a file including itself, or A→B→A) are detected and skipped — the
 *    partial expansion is returned with the cycle noted; never loops or throws.
 *
 * Pure aside from the injected reader; deterministic for a given reader.
 */
export function resolveIncludes(
  text: string,
  readFile: (path: string) => string | undefined,
  opts: ResolveIncludeOptions,
): ResolveIncludeResult {
  const skipped: IncludeSkip[] = [];
  const maxDepth = Math.max(0, Math.floor(opts.maxDepth));
  const out = expand(text, 0, maxDepth, new Set<string>(), readFile, opts, skipped);
  return { text: out, skipped };
}

function expand(
  text: string,
  depth: number,
  maxDepth: number,
  chain: Set<string>,
  readFile: (path: string) => string | undefined,
  opts: ResolveIncludeOptions,
  skipped: IncludeSkip[],
): string {
  const result: string[] = [];
  for (const line of text.split("\n")) {
    const m = INCLUDE_LINE.exec(line.trim());
    if (!m) {
      result.push(line);
      continue;
    }
    const inc = m[1];
    if (!opts.isAllowed(inc)) {
      skipped.push({ path: inc, reason: "not-allowed" });
      result.push(`<!-- skipped (not allowed): @include ${inc} -->`);
      continue;
    }
    if (depth + 1 > maxDepth) {
      skipped.push({ path: inc, reason: "depth" });
      result.push(`<!-- skipped (depth limit): @include ${inc} -->`);
      continue;
    }
    if (chain.has(inc)) {
      skipped.push({ path: inc, reason: "cycle" });
      result.push(`<!-- skipped (cycle): @include ${inc} -->`);
      continue;
    }
    const body = readFile(inc);
    if (body === undefined) {
      skipped.push({ path: inc, reason: "missing" });
      result.push(`<!-- skipped (missing): @include ${inc} -->`);
      continue;
    }
    chain.add(inc);
    result.push(expand(body, depth + 1, maxDepth, chain, readFile, opts, skipped));
    chain.delete(inc); // pop: siblings may include the same file legitimately
  }
  return result.join("\n");
}
