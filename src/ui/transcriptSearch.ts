/**
 * Phase 10A.9 — Pure scrollback search module.
 *
 * Case-insensitive search over transcript lines.  No I/O, no terminals, no
 * ANSI awareness — matches use visible string indexes only.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SearchMatch {
  line: number;
  start: number;
  end: number;
}

export interface TranscriptSearchState {
  active: boolean;
  query: string;
  matches: SearchMatch[];
  selected: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Hard cap to avoid pathological scans on very large transcripts. */
const MAX_MATCHES = 500;

// ── Factory ───────────────────────────────────────────────────────────────────

export function createSearchState(): TranscriptSearchState {
  return {
    active: false,
    query: "",
    matches: [],
    selected: 0,
  };
}

// ── Core search ───────────────────────────────────────────────────────────────

/**
 * Find all non-overlapping case-insensitive occurrences of `query` in `lines`.
 *
 * - Empty or whitespace-only query returns an empty array.
 * - Matches use visible string indexes (not ANSI positions).
 * - At most `MAX_MATCHES` results are returned.
 * - Never throws.
 */
export function findMatches(
  lines: readonly string[],
  query: string,
): SearchMatch[] {
  if (!Array.isArray(lines)) return [];
  if (typeof query !== "string" || query.trim().length === 0) return [];

  const lowerQuery = query.toLowerCase();
  const queryLen = query.length;
  const results: SearchMatch[] = [];

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    if (typeof line !== "string") continue;

    const lowerLine = line.toLowerCase();
    let pos = 0;

    while (results.length < MAX_MATCHES) {
      const idx = lowerLine.indexOf(lowerQuery, pos);
      if (idx === -1) break;

      results.push({
        line: lineIdx,
        start: idx,
        end: idx + queryLen,
      });

      pos = idx + queryLen; // non-overlapping
    }

    if (results.length >= MAX_MATCHES) break;
  }

  return results;
}

// ── State updates ─────────────────────────────────────────────────────────────

/**
 * Update search state with a new query, recomputing all matches.
 *
 * - Resets `selected` to 0 (or keeps 0 when no matches).
 * - When query is empty/whitespace, matches are cleared.
 */
export function updateSearch(
  state: TranscriptSearchState,
  lines: readonly string[],
  query: string,
): TranscriptSearchState {
  const matches = query.trim().length > 0 ? findMatches(lines, query) : [];
  return {
    ...state,
    query,
    matches,
    selected: matches.length > 0 ? state.selected : 0,
  };
}

/**
 * Move the selection cursor by `delta` (1 = next, -1 = previous).
 *
 * - Wraps around at both ends (0-indexed).
 * - If there are no matches, selected stays 0.
 */
export function moveSearchSelection(
  state: TranscriptSearchState,
  delta: 1 | -1,
): TranscriptSearchState {
  const count = state.matches.length;
  if (count === 0) return state;

  const next = (state.selected + delta + count) % count;
  return { ...state, selected: next };
}

/**
 * Return the currently selected match, or `null` when there are no matches.
 */
export function selectedMatch(
  state: TranscriptSearchState,
): SearchMatch | null {
  if (state.matches.length === 0) return null;
  if (state.selected < 0 || state.selected >= state.matches.length) return null;
  return state.matches[state.selected];
}
