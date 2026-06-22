# Phase 10A.10 — TUI Mouse Interactions

## Context

Deepcoder's TUI already supports keyboard scrollback, collapsible tool/check/worker blocks,
approval diff scrolling, and a fixed bottom composer. It does not yet respond to mouse input.

Modern terminal agent UIs should support at least mouse-wheel scrollback and clicking block
headers to inspect/collapse logs. This is high-visibility polish with low execution risk
because it only maps terminal mouse events to existing UI state transitions.

## Goal

Add mouse interactions to TUI mode:

- mouse wheel scrolls transcript output
- mouse wheel scrolls approval diff when approval modal is active
- left-click on a collapsible block header focuses and toggles it
- terminal mouse tracking is always disabled on restore

MVP should make the TUI feel like a normal modern terminal app without changing model/tool
execution behavior.

## Non-Goals

- No mouse text selection handling.
- No clickable links in v1.
- No drag selection.
- No mouse support in plain mode.
- No click-to-place-cursor in the input composer.
- No applying/rejecting approvals by mouse yet.
- No terminal UI framework dependency.

## Design

### 1. Mouse Event Parser

New file:

```text
src/ui/mouse.ts
```

Support SGR mouse mode (`\x1b[<...M` / `\x1b[<...m`) only.

Types:

```ts
export type MouseEventKind =
  | "wheel-up"
  | "wheel-down"
  | "left-click"
  | "left-release"
  | "unknown";

export interface TuiMouseEvent {
  kind: MouseEventKind;
  row: number; // 1-based terminal row
  col: number; // 1-based terminal col
  raw: string;
}
```

Exports:

```ts
export const ENABLE_MOUSE_TRACKING: string;
export const DISABLE_MOUSE_TRACKING: string;
export function parseMouseEvent(seq: string): TuiMouseEvent | null;
```

MVP mappings:

- button code `64` -> wheel up
- button code `65` -> wheel down
- button code `0` with final `M` -> left click
- button code `0` with final `m` -> left release
- unsupported codes -> `unknown`

Use 1-based rows/cols because terminal escape sequences are 1-based.

### 2. Terminal Lifecycle

Edit `runTuiRepl`:

- enable SGR mouse tracking on TUI entry
- disable mouse tracking in `restore()`
- reset previous frame after enabling/disabling as needed

Enable:

```text
\x1b[?1000h\x1b[?1006h
```

Disable:

```text
\x1b[?1000l\x1b[?1006l
```

Do not enable aggressive tracking modes in MVP:

- no button-motion tracking
- no any-event tracking

### 3. Wheel Behavior

When no approval modal is active:

- wheel up -> transcript scroll up by 3 rows
- wheel down -> transcript scroll down by 3 rows
- update `atBottom` consistently with keyboard scroll

When approval modal is active:

- wheel up -> approval diff scroll up
- wheel down -> approval diff scroll down
- do not affect transcript viewport

The scroll step should be a small constant:

```ts
const MOUSE_WHEEL_ROWS = 3;
```

### 4. Click-to-Toggle Collapsible Blocks

The TUI currently flattens transcript blocks into rendered lines, but does not expose a row map.
Add a pure helper:

```text
src/ui/transcriptHitTest.ts
```

Types:

```ts
export interface RenderedTranscriptRow {
  text: string;
  blockId?: string;
  kind?: TranscriptBlock["kind"];
  header?: boolean;
  collapsible?: boolean;
}
```

Goal:

- preserve current rendering visually
- also produce row metadata for hit testing

MVP approach:

- refactor the `flattenStyled` logic in `runTuiRepl` into a helper that returns rows with
  block metadata
- click row maps to `viewportTop + terminalRowOffset`
- if row metadata says `collapsible && header`, focus block and toggle it

Rules:

- clicking non-collapsible rows does nothing
- clicking expanded body rows does nothing
- click outside transcript area does nothing
- click while slash menu/search mode is active may be ignored in MVP

### 5. Row Geometry

Need deterministic mapping from terminal row to UI region.

Current frame order:

```text
0 status
1..N transcript viewport
indicator?
composer rows
```

Add helper:

```ts
interface FrameRegions {
  statusRow: number;
  transcriptStartRow: number;
  transcriptEndRow: number;
  composerStartRow: number;
}
```

Rows are 1-based in mouse events, but arrays are 0-based. Tests must pin this.

### 6. Keyboard Parity

Mouse actions must reuse existing state transitions where possible:

- wheel is equivalent to repeated scroll-up/down
- click header is equivalent to focus block + toggleExpand

Do not create a separate mouse-only behavior path.

## Files

New:

- `src/ui/mouse.ts`
- `src/ui/transcriptHitTest.ts`
- `test/adversarial/ui-mouse.test.ts`
- `test/adversarial/ui-transcript-hit-test.test.ts`

Edited:

- `src/cli/repl.ts`
- maybe `src/ui/transcript.ts` if a direct `selectBlockById` helper is needed
- maybe `src/ui/minimalRenderer.ts` if frame region helper belongs there

## Tests

### Mouse Parser Tests

- parses SGR wheel up
- parses SGR wheel down
- parses SGR left click
- parses SGR left release
- ignores malformed sequences
- unsupported button codes return `unknown` or null

### Lifecycle Tests

Pure constants:

- enable string includes `?1000h` and `?1006h`
- disable string includes `?1000l` and `?1006l`

If terminal lifecycle is testable through a seam:

- restore writes disable string even after error
- restore is idempotent

### Hit-Test Tests

- collapsible tool header row maps to that block id
- expanded body row is not a toggle target
- user/assistant/notice rows are not toggle targets
- viewport offset is respected
- row outside transcript region returns null

### Integration Tests

If TUI reducer is extracted enough:

- wheel up changes viewportTop upward
- wheel down changes viewportTop downward
- click header toggles expanded flag
- click non-header leaves transcript unchanged

## Acceptance

- `npm run typecheck`
- `npm run test:phase`
- manual smoke:

```bash
npm run dev -- --tui
```

Smoke checklist:

- mouse wheel scrolls transcript up/down
- while approval modal is open, mouse wheel scrolls diff
- clicking a collapsed tool/check/worker header expands it
- clicking the same header again collapses it
- clicking normal assistant text does nothing
- keyboard scroll and Tab focus still work
- Ctrl+C restores terminal and mouse tracking is disabled
- after exit, terminal mouse selection behaves normally

## Safety

- Mouse input never executes commands.
- Clicks only map to existing UI expansion/focus state.
- No model/tool/check behavior changes.
- Terminal restore must disable mouse tracking on every exit path.
- Non-TTY/plain mode unaffected.

## Implementation Order

1. Add `mouse.ts` parser/constants + tests.
2. Add transcript row metadata / hit-test helper + tests.
3. Add optional `selectBlockById` helper if needed.
4. Wire mouse tracking lifecycle in `runTuiRepl`.
5. Wire wheel scroll behavior.
6. Wire click-to-toggle behavior.
7. Manual smoke.

## Delegation Notes

Good split:

- Slice A: `mouse.ts` + tests.
- Slice B: `transcriptHitTest.ts` + tests.
- Slice C: `runTuiRepl` terminal lifecycle/wiring, reviewed in-house because it touches raw
  terminal I/O.

