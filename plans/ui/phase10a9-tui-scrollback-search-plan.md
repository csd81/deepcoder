# Phase 10A.9 — TUI Scrollback Search

## Context

Deepcoder's TUI can already scroll transcript output with keyboard controls. As sessions get
long, users need a fast way to find earlier errors, file paths, command output, model claims,
check failures, and tool results.

Modern coding-agent TUIs should support "find in transcript" the same way terminals/editors
support find in buffer. This phase adds search within the rendered scrollback without changing
agent/tool behavior.

## Goal

Add interactive scrollback search to TUI mode:

- `Ctrl+F` enters search mode
- bottom composer becomes `search: <query>`
- matches are highlighted in transcript output
- `Enter` jumps to next match
- `Shift+Enter` or `N` / `P` jumps next/previous
- `Esc` exits search mode and restores normal composer
- status bar shows match count, e.g. `search 2/9`

MVP should work for all rendered transcript content:

- user messages
- assistant markdown output
- tool/check/worker block headers
- expanded tool/check/worker bodies
- notices/errors

## Non-Goals

- No regex search in v1.
- No fuzzy search.
- No persistent search history.
- No mouse selection.
- No searching hidden/collapsed block bodies unless they are currently rendered.
- No separate full-screen search panel.

## Design

### 1. Pure Search Module

New file:

```text
src/ui/transcriptSearch.ts
```

Types:

```ts
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
```

Functions:

```ts
export function createSearchState(): TranscriptSearchState;
export function findMatches(lines: readonly string[], query: string): SearchMatch[];
export function updateSearch(
  state: TranscriptSearchState,
  lines: readonly string[],
  query: string,
): TranscriptSearchState;
export function moveSearchSelection(
  state: TranscriptSearchState,
  delta: 1 | -1,
): TranscriptSearchState;
export function selectedMatch(state: TranscriptSearchState): SearchMatch | null;
```

Rules:

- case-insensitive by default
- empty/whitespace query => no matches
- matches use visible string indexes, not ANSI-coded positions
- return all non-overlapping matches per line
- cap total matches, e.g. 500, to avoid pathological scans
- never throw on unusual input

### 2. Highlight Rendering

Add helper:

```ts
export function highlightSearchMatches(
  line: string,
  lineIndex: number,
  matches: readonly SearchMatch[],
  selected?: SearchMatch | null,
  theme?: Theme,
): string;
```

MVP can start by highlighting only unstyled/plain rendered rows. Since current `buildLines`
already returns styled ANSI strings, highlight should either:

1. be applied before color styling where possible, or
2. use ANSI-aware insertion helper that preserves visible indexes.

Recommended v1:

- compute search over the final visible `buildLines(width)` output after stripping ANSI
- for highlight, insert background/selected SGR into the final line with an ANSI-aware helper
- if helper encounters complex escape boundaries, fail open and return original line

Theme additions:

```ts
searchMatch: (s: string) => string;
searchSelected: (s: string) => string;
```

No-color mode should mark selected match minimally, e.g. brackets around the selected match,
only if this can be done without changing layout too much. Otherwise no-color may simply omit
visual highlighting but still jump/count matches.

### 3. TUI State Integration

In `runTuiRepl`:

- add `searchState`
- add `searchDraft` separate from normal editor
- `Ctrl+F`:
  - enters search mode
  - initializes query from prior query or empty
  - does not modify normal editor text
- typing while search active updates search query
- Backspace edits search query
- Enter moves to next match and scrolls viewport to it
- `N` moves next, `P` moves previous when search active
- Esc exits search mode

When search active:

- Up/Down can keep normal scroll behavior, or move previous/next match. Recommended MVP:
  - Enter / `n` next
  - `p` previous
  - PgUp/PgDn still scroll
- slash menu is disabled while search active
- normal prompt submission is disabled

### 4. Viewport Jumping

When a match is selected:

- set `atBottom = false`
- set `viewportTop` so selected line is visible
- prefer placing selected line around the middle of viewport:

```ts
viewportTop = clamp(match.line - Math.floor(height / 2), 0, maxTop)
```

If output changes while search is active:

- recompute matches against new rendered lines
- preserve selected match by nearest line when possible
- if no matches remain, selected = 0 and status says `0/0`

### 5. Composer Rendering

When search is active, composer rows should display:

```text
search: query
```

Not:

```text
> query
```

Status bar suffix:

```text
 · search 2/9
```

If query has no matches:

```text
 · search 0/0
```

### 6. Key Mapping

Add action for Ctrl+F:

```ts
KeyAction = ... | "search"
```

Map:

- `\x06` -> `search`

Search-mode local keys:

- Esc -> exit search
- Enter -> next match
- `n` -> next match
- `p` -> previous match
- Backspace -> remove char
- printable chars -> append char

## Files

New:

- `src/ui/transcriptSearch.ts`
- `test/adversarial/ui-transcript-search.test.ts`

Edited:

- `src/ui/theme.ts`
- `src/ui/minimalRenderer.ts` if highlight support belongs there
- `src/cli/repl.ts`
- `test/adversarial/ui-minimal-renderer.test.ts`

## Tests

Pure module tests:

- empty query returns no matches
- case-insensitive search
- multiple matches on one line
- multiple lines
- match cap works
- next/previous wraps
- selectedMatch returns null when no matches
- unusual input never throws

Renderer/helper tests:

- selected match gets selected style
- non-selected matches get match style
- no-color output remains readable
- ANSI-colored input does not leak broken escape sequences

TUI reducer/wiring tests, if extracted:

- Ctrl+F enters search mode
- typing search query does not mutate composer editor
- Esc exits search mode
- Enter moves selected match
- selected match computes expected viewportTop

## Acceptance

- `npm run typecheck`
- `npm run test:phase`
- manual smoke:

```bash
npm run dev -- --tui
```

Smoke checklist:

- run a prompt that produces several lines
- press `Ctrl+F`
- type a word from prior output
- matches highlight
- status shows match count
- Enter jumps to next match
- `p` jumps previous
- PgUp/PgDn still scroll while search active
- Esc exits search and restores normal composer
- normal prompt input is unchanged after exiting search
- resize while search active does not corrupt screen

## Safety

- Search is read-only UI state.
- It does not call model/tools/checks.
- It does not mutate session history.
- It must not break terminal restore.
- Non-TTY/plain mode unaffected.

## Implementation Order

1. Add `transcriptSearch.ts` and pure tests.
2. Add theme styles for search highlight.
3. Add highlight helper with tests.
4. Wire `Ctrl+F` and search-mode editor into `runTuiRepl`.
5. Add viewport jump logic.
6. Manual smoke.

## Delegation Notes

Good parallel split:

- Slice A: `transcriptSearch.ts` + pure tests.
- Slice B: highlight helper + theme tests.
- Slice C: `runTuiRepl` integration, reviewed in-house because it touches raw terminal I/O.

