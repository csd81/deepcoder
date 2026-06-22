# Feature — File path autocomplete in TUI composer

## Context

Deepcoder's TUI has slash command completion (`slashMenu.ts`) but no file path autocomplete. When typing `src/` or `@src/foo`, there's no popup suggesting matching files. Both opencode, codex, and pi have `@`-file mentions + fuzzy file search in the composer. The existing `@`-file mentions plan (`feat-at-file-mentions-plan.md`) covers expanding `@path` on submit, but not interactive autocomplete while typing.

## Model

- Typing `@` in the composer opens a file-completion dropdown listing matching workspace files (fuzzy-matched against the typed query).
- Typing a path without `@` (e.g., `src/`) also triggers path completion on Tab.
- Tab/Enter accepts the selected completion.
- Escape closes the dropdown without accepting.
- The file list comes from `git ls-files` (cached at startup, refreshed periodically).

## Design

### 1. File index (`src/ui/fileCompleter.ts`)

```ts
export interface FileIndex {
  paths: string[];
  /** basename → paths lookup for fuzzy matching */
  byBasename: Map<string, string[]>;
}

/**
 * Build a file index from git-ls-files output.
 * Cached for the session; refreshed on explicit request.
 */
export async function buildFileIndex(root: string): Promise<FileIndex> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const { stdout } = await exec("git", ["ls-files"], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
  const paths = stdout.trim().split("\n").filter(Boolean);
  const byBasename = new Map<string, string[]>();
  for (const p of paths) {
    const base = p.split("/").pop()!;
    const existing = byBasename.get(base);
    if (existing) existing.push(p);
    else byBasename.set(base, [p]);
  }
  return { paths, byBasename };
}

/**
 * Fuzzy-match `query` against the file index.
 * Returns up to `maxResults` matches, scored by:
 *   1. basename prefix match (highest)
 *   2. basename substring match
 *   3. path substring match
 *   4. fuzzy character match
 */
export function queryFiles(index: FileIndex, query: string, maxResults = 10): string[] {
  if (!query) return [];
  const lower = query.toLowerCase();

  // Directories: show files inside
  if (query.endsWith("/")) {
    return index.paths
      .filter((p) => p.startsWith(lower))
      .slice(0, maxResults);
  }

  // @mentions: fuzzy match basename + path
  const scores = new Map<string, number>();
  for (const p of index.paths) {
    const base = p.split("/").pop()!.toLowerCase();
    let score = 0;
    if (base.startsWith(lower)) score = 1000 - base.length;
    else if (base.includes(lower)) score = 500 - base.length;
    else if (p.toLowerCase().includes(lower)) score = 100;
    else continue; // no match
    scores.set(p, score);
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxResults)
    .map(([p]) => p);
}
```

### 2. Composer integration (`src/ui/inputEditor.ts` or `chatUiState.ts`)

Track the current "completion state" in the composer:

```ts
interface CompletionState {
  active: boolean;
  /** The current prefix being completed (e.g. "src/util" or "@src/util") */
  prefix: string;
  /** Whether this is an @-mention completion or a bare path completion */
  isMention: boolean;
  /** Matched files */
  matches: string[];
  /** Index of the selected match */
  selected: number;
  /** Cursor position at the time completion was triggered */
  cursorPos: number;
}
```

Events:
- On `@` input → enter @-mention completion mode, show matching files
- On Tab (when not in completion mode) → try bare path completion at cursor
- On Tab (in completion mode) → select next match
- On Shift+Tab → select previous match
- On Enter → accept selected match, insert path, close dropdown
- On Escape → close dropdown, cancel completion
- On any other key → re-filter matches

### 3. Dropdown rendering

Reuse the existing slash menu dropdown pattern (`src/ui/slashMenu.ts`):

```ts
export interface CompleterDropdown {
  lines: string[];      // rendered dropdown rows
  selected: number;     // which line is highlighted
}

export function renderCompleterDropdown(
  matches: string[],
  selected: number,
  maxVisible = 8,
): CompleterDropdown {
  const visible = matches.slice(0, maxVisible);
  const lines = visible.map((p, i) => {
    const marker = i === selected ? "▸ " : "  ";
    return `${marker}${p}`;
  });
  if (matches.length > maxVisible) {
    lines.push(`  … ${matches.length - maxVisible} more`);
  }
  return { lines, selected };
}
```

### 4. Wire into TUI frame

In `FrameInput`, add optional `completerLines?: string[]`. When present, render them above the composer (same position as slash menu lines).

In `runTuiRepl` / the key handler, when a completion is active, intercept Enter/Tab/Escape before they reach the normal composer handler.

### 5. @-mention integration

When the user types `@` followed by characters, the completer filters `@queryFiles` results. On Enter, insert the path as an `@path` token. The existing `feat-at-file-mentions-plan.md` handles expanding these on submit — autocomplete is just the interactive front-end.

## Files

- **New:** `src/ui/fileCompleter.ts`, `test/file-completer.test.ts`.
- **Edit:** `src/ui/inputEditor.ts` or `src/cli/repl.ts` (key handler integration), `src/ui/slashMenu.ts` (reuse dropdown rendering), `src/ui/chatUiState.ts` (completion state), `src/ui/minimalRenderer.ts` (completer lines in frame).

## Tests

- `buildFileIndex` from a git-ls-files list returns indexed paths + basename map.
- `queryFiles` with a prefix returns matching paths sorted by relevance.
- `queryFiles` with `@src/uti` returns `["src/util/helper.ts", "src/util/parser.ts"]`.
- `queryFiles` with trailing slash returns files inside that directory.
- `queryFiles` with no matches returns `[]`.
- `renderCompleterDropdown` shows `▸` on the selected item.
- `renderCompleterDropdown` truncates to `maxVisible` with a "more" indicator.

## Verification

1. `npm run typecheck` clean; `npm run test:phase` green.
2. Manual: start TUI, type `@src/` → dropdown shows files under `src/`. Type more chars to filter. Tab to select, Enter to accept.
3. Type a bare path like `src/util/` and press Tab → completes to the next path segment.

## Safety

- Read-only: file index comes from `git ls-files` (no mutation).
- Index is cached per session — no repeated git calls.
- Dropdown is rendering-only — no permission surface.
- @-mention expansion is handled by the existing plan — this is just the interactive front-end.
