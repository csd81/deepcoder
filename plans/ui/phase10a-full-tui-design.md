# Phase 10A — Full Scrollable TUI (design)

Status: approved 2026-06-21. Builds on the existing 10A core (pure event model,
transcript reducer, `renderFrame`, `keyToAction`, approval provider, working
`runTuiRepl`). Foundation decision: **stay hand-rolled / dependency-free** (pure
state→frame functions + a thin imperative shell). Layout: **single-column inline
blocks** (Claude-Code style) — tools, checks, approvals, worker reviews are all
inline expandable blocks; a transient full-width modal overlays only for approvals.

## Scope

Core (all in): scrollback, enriched status bar, approvals + diff, logs (expand
collapsed blocks), worker review, check output.

Polish (all in) — **implement in THIS order** (user-locked):
1. **Diff-based frame writer** — biggest maturity win; streaming without flicker.
   `diffFrames(prev, next) -> terminal ops`, pure/testable.
2. **Resize handling** — `SIGWINCH -> recompute layout -> repaint`. A wrong layout
   after resize makes the TUI feel broken; closely tied to the frame writer.
3. **Color & theming** — semantic styles (success/error/warning/dim/title); respect
   `NO_COLOR`, `FORCE_COLOR`, non-TTY. Isolated, low risk.
4. **Input history + multiline** — Up/Down recall; a key inserts a newline. Done
   after rendering/layout is stable.

## Architecture — pure core + thin shell

Pure modules (no I/O, unit-tested without a TTY) + one imperative shell that wires
stdin/stdout to them.

### Pure units (each its own file, adversarially tested; delegatable)

- **events.ts** (extend `UiEvent`): `check_start{name,command}`,
  `check_output{name,chunk}`, `check_done{name,exitCode,passed}`,
  `worker_start{id,label}`, `worker_update{id,status}`,
  `worker_done{id,summary,reviewPath?}`.
- **transcript.ts** (extend): map new events to blocks (`kind: "check" | "worker"`);
  add interaction state `selectedBlockId` (focus cursor) + per-block `expanded`;
  pure reducers `moveSelection(±1)`, `toggleExpand()`.
- **frameWriter.ts** (NEW): `diffFrames(prev: string[], next: string[]) -> string`
  — emits cursor-move + clear-line + write ONLY for changed lines. Kills the
  full-screen clear/redraw flicker. (Polish #1.)
- **textLayout.ts** (NEW): `wrapLine(s, width)` / body wrapping, ANSI-width-aware
  (so color codes don't count toward width). Replaces truncate-only behavior.
  (Supports Polish #2 re-wrap.)
- **theme.ts** (NEW): named semantic styles gated by a `color` flag;
  `NO_COLOR`/`FORCE_COLOR`/non-TTY resolution -> identity when disabled. (Polish #3.)
- **blockRenderer.ts** (NEW): `renderBlock(block,{width,color,focused,expanded})
  -> string[]` (header `▸/▾` marker + kind + title + summary; wrapped body when
  expanded).
- **approvalModal.ts** (NEW): `renderApprovalModal(req,{width,height,scroll,color})
  -> string[]` — full-width overlay box, description + scrollable diff.
- **minimalRenderer.ts** (extend): compose status bar + visible blocks + input +
  optional modal into the frame `string[]`, with color + wrapping.
- **inputEditor.ts** (NEW): pure editor state `{lines,cursor,history,historyIndex}`
  with transitions char/backspace/newline/history-up/down/submit. (Polish #4.)
- **keyToAction** (extend): focus-up/down, toggle-expand, history-up/down, newline.

### Status bar
Reuse the existing 10C `buildStatusSnapshot` + `renderStatusline` (tokens, cost,
git, mode, sandbox) instead of the current hardcoded string.

### Shell (imperative; in-house)
**runTuiRepl** rewrite: keypress → editor/scroll/selection/approval state;
`SIGWINCH` → recompute width/height, re-wrap, redraw via `diffFrames`; slash-command
suspend/resume unchanged; guaranteed terminal restore preserved. The injectable
`runTask(session, ui?)` seam stays as-is.

## Data flow
`UiEvent → applyEvent → TranscriptState → renderBlocks + compose → frame string[] →
diffFrames(prev,next) → stdout`. Keys: `keyToAction` (extended) → state transition →
recompose → diff-write.

## Testing
Each pure unit gets adversarial unit tests: wrap edge cases (ANSI width, CJK best
effort), color on/off (NO_COLOR/FORCE_COLOR), diff writer repaints ONLY changed
lines, editor history/multiline transitions, modal diff scroll, reducer
expand/focus, new events → blocks. No live model, no TTY in tests — gate is
`npm run test:phase`. The shell stays thin; manual TTY smoke is a separate human
step (TUI can't be CI-tested).

## Build approach
Pure units are bounded slices: red-seed a tagged failing test per deliverable,
build (in-house or delegate to ds-flash verify-then-force), apply→prove
red-on-baseline + green-on-full→commit. The shell (runTuiRepl) is done in-house.
Implementation order follows the locked polish order, with the supporting pure
units (events/transcript/blockRenderer) landed as each feature needs them.

## Acceptance
- `npm run typecheck` + `npm run test:phase` green.
- Streaming repaints without full-screen flicker (diff writer).
- Resize re-lays-out cleanly (no garbled screen).
- Color respects NO_COLOR/FORCE_COLOR/non-TTY; plain mode unchanged.
- Approvals show a scrollable diff modal; checks/workers render as inline blocks;
  collapsed blocks expand for full logs.
- Non-TTY still forced to plain mode; terminal always restored on exit/error/signal.

## Out of scope
Mouse support, copy/paste selection, multi-pane layout, syntax highlighting beyond
diff +/- coloring, terminfo capability probing (assume ANSI; degrade color only).
