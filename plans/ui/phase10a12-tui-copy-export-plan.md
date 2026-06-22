# Phase 10A.12 — TUI Copy and Transcript Export

## Context

Deepcoder's TUI can focus collapsible blocks with Tab and will soon support mouse-click focus.
Long sessions often contain useful snippets that users need outside the TUI:

- failing check logs
- tool output
- model summaries
- patch/review notes
- command results

Today, extracting those requires selecting terminal text manually or finding persisted session
JSON. This phase adds explicit copy/export affordances.

## Goal

Add low-risk UI actions:

- copy the focused transcript block to clipboard
- save the focused transcript block to `.deepcoder/exports/*.md`
- export the whole transcript as Markdown
- redact secrets before copy/save/export
- show a notice after each action

MVP key bindings in TUI:

- `y` — copy focused block
- `s` — save focused block to Markdown
- `/export transcript` — export full transcript to Markdown

If no block is focused:

- `y` and `s` show a notice: `No focused block. Press Tab to focus a tool/check/worker block.`

## Non-Goals

- No arbitrary visual text selection.
- No mouse drag selection.
- No copying while approval modal is active in v1.
- No OS-specific dependency required.
- No cloud/share integration.
- No automatic export of every session.

## Design

### 1. Transcript Markdown Formatter

New file:

```text
src/ui/transcriptExport.ts
```

Exports:

```ts
export interface TranscriptExportOptions {
  includeTimestamps?: boolean;
  includeMetadata?: boolean;
  maxBlockChars?: number;
}

export function formatTranscriptBlockMarkdown(
  block: TranscriptBlock,
  opts?: TranscriptExportOptions,
): string;

export function formatTranscriptMarkdown(
  blocks: readonly TranscriptBlock[],
  opts?: TranscriptExportOptions,
): string;
```

Format:

```md
## assistant

text...

## tool: read_file

```text
output...
```
```

Rules:

- redact with `redactSecrets`
- cap each block body, default 50_000 chars
- mark truncated blocks
- preserve code/log formatting in fenced blocks for tool/check/worker/approval
- assistant/user bodies stay normal Markdown
- never throw on malformed/empty block fields

### 2. Focused Block Lookup

Add helper:

```ts
export function selectedBlock(state: TranscriptState): TranscriptBlock | null;
```

Location:

- `src/ui/transcript.ts` or `src/ui/transcriptExport.ts`

This keeps TUI wiring small and makes tests straightforward.

### 3. Clipboard Adapter

New file:

```text
src/ui/clipboard.ts
```

Exports:

```ts
export interface ClipboardCommand {
  file: string;
  args: string[];
}

export function detectClipboardCommand(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): ClipboardCommand | null;
export async function copyToClipboard(text: string, opts?: { command?: ClipboardCommand; spawn?: SpawnFn }): Promise<CopyResult>;
```

Detection order:

- Linux Wayland: `wl-copy`
- Linux X11: `xclip -selection clipboard`
- macOS: `pbcopy`
- Windows: `clip.exe` if later supported

Implementation:

- use `spawn` with `shell:false`
- write text to stdin
- timeout, e.g. 3 seconds
- bounded stderr
- no clipboard command found => clear failure result, not throw

No clipboard command should be required for tests; inject fake spawn.

### 4. Export Writer

New file:

```text
src/ui/exportWriter.ts
```

Exports:

```ts
export function safeExportFilename(prefix: string, now: Date, id?: string): string;
export async function writeExport(root: string, filename: string, markdown: string): Promise<string>;
```

Path:

```text
<workspace>/.deepcoder/exports/<timestamp>-<kind>-<id>.md
```

Safety:

- create directory if missing
- sanitize filename to `[a-zA-Z0-9._-]`
- write inside `.deepcoder/exports`
- never follow user-provided path
- return relative path for notice display

### 5. TUI Key Bindings

In `runTuiRepl`:

- when not busy and no approval/search/slash menu is active:
  - `y` copies selected block markdown
  - `s` saves selected block markdown

Copy notice:

```text
copied tool read_file to clipboard
```

Save notice:

```text
saved .deepcoder/exports/2026-06-22T...-tool-b4.md
```

Failure notice:

```text
clipboard unavailable: install wl-copy, xclip, or pbcopy
```

Use existing transcript `notice` event to surface results.

### 6. Slash Command

Extend `handleSlashCommand`:

```text
/export transcript
```

Behavior:

- writes full transcript Markdown
- prints path
- refuses unknown subcommands:

```text
usage: /export transcript
```

Future subcommands:

- `/export block <id>`
- `/export last-check`

## Files

New:

- `src/ui/transcriptExport.ts`
- `src/ui/clipboard.ts`
- `src/ui/exportWriter.ts`
- `test/adversarial/ui-transcript-export.test.ts`
- `test/adversarial/ui-clipboard.test.ts`
- `test/adversarial/ui-export-writer.test.ts`

Edited:

- `src/ui/transcript.ts`
- `src/cli/repl.ts`
- `src/cli/slashCommands.ts`
- `test/adversarial/ui-transcript-select.test.ts`
- possible slash command test file

## Tests

### Formatter

- formats assistant/user as Markdown
- formats tool/check/worker as fenced text
- redacts key-shaped strings
- caps huge block body
- full transcript includes all blocks in order
- malformed/empty fields never throw

### Clipboard

- detects `wl-copy` when Wayland env present
- detects `xclip` when X11 env present
- detects `pbcopy` on macOS
- returns unavailable when no command
- fake spawn receives text on stdin
- timeout returns failure
- stderr is bounded/redacted

### Export Writer

- creates `.deepcoder/exports`
- sanitizes filename
- writes inside workspace only
- returns relative path
- rejects traversal-like filename

### TUI/Slash

- selectedBlock returns focused block
- no selected block produces notice path
- `/export transcript` writes a file
- unknown `/export` subcommand prints usage

## Acceptance

- `npm run typecheck`
- `npm run test:phase`
- manual smoke:

```bash
npm run dev -- --tui
```

Smoke checklist:

- run a tool/check so a collapsible block exists
- press Tab to focus it
- press `s`
- confirm Markdown file appears under `.deepcoder/exports`
- file contains redacted block output
- press `y` on a system with clipboard command installed
- confirm clipboard contains redacted Markdown
- `/export transcript` writes full transcript
- no terminal corruption after copy/save failures

## Safety

- Copy/export is read-only with respect to project source files.
- Export writes only under `.deepcoder/exports`.
- All output is redacted before copy/save.
- Clipboard command uses `shell:false`.
- Clipboard unavailable is a non-fatal notice.
- Existing approval/sandbox/delegate gates unchanged.

## Implementation Order

1. Add `transcriptExport.ts` + tests.
2. Add `exportWriter.ts` + tests.
3. Add `clipboard.ts` + tests.
4. Add selected block helper.
5. Wire `s` and `y` in TUI.
6. Add `/export transcript`.
7. Manual smoke.

## Delegation Notes

Good split:

- Slice A: formatter + tests.
- Slice B: export writer + clipboard adapter + tests.
- Slice C: TUI/slash wiring, reviewed in-house because it touches terminal I/O and filesystem
  writes.

