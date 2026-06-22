# Phase 10A.16 — Compact Output Cards

## Context

Deepcoder's TUI already represents tool/check/worker output as collapsible transcript blocks.
Large tool output is byte-collapsed in transcript storage, and focused blocks can be expanded.

The current rendering is still too log-like:

- long tool/check output can dominate the transcript
- block headers do not summarize enough useful state
- collapsed output is a storage cap, not a polished visual preview
- check failures and worker results should be scannable at a glance

Codex/Claude-style UIs keep the main conversation clean: compact cards by default, short
preview, explicit expansion for detail.

## Goal

Render tool/check/worker blocks as compact output cards in TUI mode.

Examples:

```text
▸ tool read_file · 84 lines
▸ tool rg · 12 matches · 4 files
✓ check phase · 18.2s · 412 passed
✗ check unit · 9.4s · 3 failures
▸ worker 10E web_fetch · solved attempt 2 · 3 files changed
```

When focused/expanded:

```text
▾ check unit · failed · 9.4s · 3 failures
  FAILED test/foo.test.ts:42
  Expected 1, got 0
  ...
  [full log: 320 lines · press s to save]
```

## Non-Goals

- No transcript storage changes.
- No new check runner behavior.
- No parsing every test framework perfectly.
- No replacing copy/export.
- No separate side pane.
- No virtualized huge-log viewer in this slice.

## Design

### 1. Block Preview Core

New file:

```text
src/ui/blockPreview.ts
```

Types:

```ts
export interface BlockPreview {
  title: string;
  status?: "running" | "success" | "error" | "neutral";
  summary: string;
  previewLines: string[];
  lineCount: number;
  truncated: boolean;
}

export interface BlockPreviewOptions {
  maxPreviewLines?: number;
  maxPreviewChars?: number;
}
```

Exports:

```ts
export function buildBlockPreview(
  block: TranscriptBlock,
  opts?: BlockPreviewOptions,
): BlockPreview;
```

Rules:

- pure and deterministic
- never throw on empty/malformed block data
- redact secrets before preview
- line-count based summary
- cap preview lines and chars
- preserve original block body in transcript; preview is render-only

### 2. Per-Kind Summary Heuristics

Tool blocks:

- title: `tool <name>`
- running if no `finishedAt` and body empty
- error if `isError`
- summary:
  - `<N> lines`
  - if output looks like search results, maybe `<N> matches`
  - if output starts with failure/error, show `error`

Check blocks:

- title: `check <name>`
- running if not finished
- success if finished and `!isError`
- error if finished and `isError`
- summary heuristics:
  - extract `tests <n>` / `<n> passed` / `<n> failed` if visible
  - otherwise `<N> lines`
  - if `isError`, include first failure-looking line

Worker blocks:

- title: `worker <title/ref>`
- running if not finished
- success/error from `isError`
- summary from body's last non-empty line
- detect common phrases:
  - `solved in N attempt`
  - `changed files`
  - `gate green`

Approval blocks:

- optional follow-up; keep current approval modal path in MVP

### 3. Preview Lines

Default preview:

- collapsed card: 0-3 preview lines
- expanded card: body lines, but still visually framed and capped by existing transcript cap

For collapsed cards:

- show first 3 meaningful lines
- skip blank boilerplate
- for errors, prefer failure-looking lines:
  - `FAILED`
  - `Error:`
  - `Traceback`
  - `not ok`
  - `AssertionError`

### 4. Rendering

Modify `flattenStyled` / transcript rendering:

- for `tool`, `check`, `worker`:
  - call `buildBlockPreview`
  - render compact header always
  - if focused or expanded, render preview/body lines under it

Header format:

```text
▸ tool read_file · 84 lines
▾ check phase ✓ · 18.2s · 412 passed
```

Status marks:

- running: `…`
- success: `✓`
- error: `✗`
- neutral: none

Colors:

- success: green
- error: red
- running: yellow/dim
- selected header: reverse/selected style

No-color mode should remain readable.

### 5. Expand Behavior

Current `toggleExpand` exists but the raw key handling does not clearly map Enter to expand
focused blocks. Add:

- when a collapsible block is focused and composer is empty:
  - `Enter` toggles expand instead of submitting blank input
- existing Tab focus remains
- Esc clears focus/collapses menus as today

If this conflicts with prompt submission, only trigger when:

- editor text is empty
- `selectedBlockId != null`
- not busy or safe while busy

### 6. Optional Duration Metadata

Current `TranscriptBlock` has timestamps but they are often empty sentinel strings. Do not
block MVP on real durations.

Follow-up:

- extend UI events to carry `durationMs` for tool/check/worker
- render duration in summary when available

## Files

New:

- `src/ui/blockPreview.ts`
- `test/adversarial/ui-block-preview.test.ts`

Edited:

- `src/cli/repl.ts`
- `src/ui/transcript.ts` if helper for selected block/toggle by id is needed
- `test/adversarial/ui-transcript-select.test.ts`

## Tests

Block preview tests:

- tool with 3 lines summarizes as `3 lines`
- huge tool output caps preview lines
- error tool status is error
- running tool status is running
- check passed status is success
- check failed status is error and prefers failure line
- worker summary uses final status line
- secrets are redacted
- empty body never throws
- output preview is bounded

Rendering/wiring tests if extracted:

- collapsed block renders header only or short preview
- expanded block renders body/preview
- selected block header uses selected style
- no-color mode readable
- Enter toggles focused block when composer empty
- Enter still submits prompt when composer has text

## Acceptance

- `npm run typecheck`
- `npm run test:phase`
- manual smoke:

```bash
npm run dev -- --tui
```

Smoke checklist:

- run a prompt that triggers tool output
- tool blocks appear as compact cards
- check blocks show pass/fail status
- Tab focuses blocks
- Enter expands/collapses focused block when composer is empty
- long logs do not dominate transcript by default
- error logs surface useful failure preview
- no terminal overlap or flicker

## Safety

- Render-only change.
- Raw output remains available in transcript state.
- No command/model/tool behavior changes.
- Redact before preview rendering.
- Non-TTY/plain mode unaffected unless explicitly reused later.

## Implementation Order

1. Add `blockPreview.ts` + pure tests.
2. Wire compact rendering for tool/check/worker in TUI.
3. Add Enter-to-toggle-focused-block behavior.
4. Add tests for toggle behavior if feasible.
5. Manual smoke.

## Delegation Notes

Good split:

- Slice A: `blockPreview.ts` + tests.
- Slice B: TUI rendering integration.
- Slice C: Enter-to-toggle wiring, reviewed in-house because it touches input semantics.

