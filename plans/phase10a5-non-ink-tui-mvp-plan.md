# Phase 10A.5 — Non-Ink TUI MVP

## Context

Ink is powerful because it gives CLIs a React-style component tree, stateful rendering, input hooks,
flexbox layout, and automatic redraw. Deepcoder does not need to clone that framework. The existing
Phase 10A work already has the right foundation: pure UI events, transcript reducer, plain renderer,
and minimal frame rendering.

This phase builds the practical subset Deepcoder needs: one deterministic terminal app renderer, not
a general-purpose TUI framework.

## Goal

Ship a usable Codex/Claude-style terminal UI without adopting Ink or implementing a React/flexbox
runtime.

The MVP should provide:

- scrollback;
- fixed input composer;
- status bar;
- assistant Markdown rendering;
- code/diff highlighting;
- collapsible tool/check/worker blocks;
- approval overlay with diff preview;
- diff-based non-flicker redraw;
- resize handling;
- input history and multiline prompts.

## Non-goals

- No React-like component model.
- No hooks runtime.
- No flexbox/Yoga layout.
- No arbitrary nested panes in v1.
- No plugin widget API.
- No mouse-first workflow.
- No full Markdown/CommonMark engine.

## Architecture

Single app state:

```ts
export interface TuiState {
  transcript: TranscriptBlock[];
  input: InputState;
  status: StatusState;
  overlay?: ApprovalOverlay | PatchOverlay | HelpOverlay;
  scroll: ScrollState;
  selectedBlockId?: string;
  size: TerminalSize;
  theme: UiTheme;
}
```

Pure renderer:

```ts
export function renderTui(state: TuiState): Frame;
```

Pure key reducer:

```ts
export function reduceKey(state: TuiState, key: KeyEvent): { state: TuiState; command?: TuiCommand };
```

Impure terminal controller:

```ts
export class TuiController {
  start(): Promise<void>;
  stop(): Promise<void>;
  dispatch(event: UiEvent): void;
}
```

The controller owns raw mode, keypress listeners, resize listeners, stdout writes, and abort/submit
callbacks. Everything else stays pure and snapshot-testable.

## Layout

Single-column inline layout:

```text
┌ status line ────────────────────────────────────────────────────────┐
│ transcript viewport                                                  │
│   user / assistant / tool / check / worker / approval blocks         │
│                                                                      │
├──────────────────────────────────────────────────────────────────────┤
│ > input composer                                                     │
└──────────────────────────────────────────────────────────────────────┘
```

Regions:

- status: 1 line;
- transcript: terminal height minus status/composer/overlay rows;
- composer: 1-N lines depending on multiline input;
- overlay: rendered over the transcript bottom or as an inline focused block.

No side panes in MVP. Future multi-pane can reuse the same block renderers.

## Files

New:

- `src/ui/tuiState.ts`
- `src/ui/layout.ts`
- `src/ui/blockRenderers.ts`
- `src/ui/renderTui.ts`
- `src/ui/keyReducer.ts`
- `src/ui/frameDiff.ts`
- `src/ui/terminalController.ts`
- `src/ui/inputState.ts`
- `test/adversarial/ui-tui-state.test.ts`
- `test/adversarial/ui-key-reducer.test.ts`
- `test/adversarial/ui-frame-diff.test.ts`
- `test/adversarial/ui-render-tui.test.ts`

Reuse:

- `src/ui/events.ts`
- `src/ui/transcript.ts`
- `src/ui/approval.ts`
- `src/ui/minimalRenderer.ts` while migrating
- `src/ui/plainRenderer.ts`
- planned `src/ui/markdown.ts`, `syntax.ts`, `theme.ts`, `wrapRich.ts` from Phase 10A.4

Edit:

- `src/cli/repl.ts` to dispatch UI events and use the TUI controller when enabled.
- `src/cli/main.ts` to add/finish `--tui` and env/config wiring if missing.
- `src/config/config.ts` / `fileConfig.ts` if TUI config belongs in config.

## App State Details

### InputState

```ts
export interface InputState {
  text: string;
  cursor: number;
  history: string[];
  historyIndex?: number;
  multiline: boolean;
}
```

Features:

- printable character insertion;
- backspace/delete;
- left/right/home/end;
- up/down history when not multiline;
- Alt+Enter or Shift+Enter inserts newline when terminal reports it;
- Enter submits when not in multiline insert mode.

### ScrollState

```ts
export interface ScrollState {
  top: number;
  followTail: boolean;
  selectedBlockId?: string;
}
```

Rules:

- new output follows tail only when `followTail` is true;
- user scroll disables follow-tail;
- End re-enables follow-tail;
- PageUp/PageDown scroll by viewport height;
- j/k or arrows scroll by one line.

### StatusState

Composed from existing status telemetry when available:

- provider/model;
- approval mode;
- sandbox;
- workspace isolation;
- token/cost summary;
- active check/solve/delegate status;
- git dirty/ahead summary when cheap;
- warning marker.

## Block Rendering

Block types:

- `user`
- `assistant`
- `tool`
- `check`
- `notice`
- `approval`
- `worker`
- `patchReview`
- `error`

Each block renderer returns rich/plain lines plus metadata:

```ts
export interface RenderedBlock {
  id: string;
  lines: RichLine[];
  selectable: boolean;
  collapsed: boolean;
}
```

Collapsed behavior:

- tool output: title + one summary line;
- check output: pass/fail/time + collapsed log hint;
- worker review: changed files + gates + status;
- approval: always expanded while active.

## Markdown and Syntax

Phase 10A.4 should provide:

- assistant Markdown rendering;
- code fences;
- diff highlighting;
- lightweight syntax highlighting;
- no-color snapshot mode.

This MVP uses those modules but should not block on full syntax completeness. If 10A.4 is not yet
implemented, render assistant blocks as wrapped plain text and integrate Markdown later.

## Frame Diff Writer

New pure diff:

```ts
export type TerminalOp =
  | { type: "move"; row: number; col: number }
  | { type: "write"; text: string }
  | { type: "clearLine" }
  | { type: "hideCursor" }
  | { type: "showCursor" };

export function diffFrames(prev: Frame | null, next: Frame): TerminalOp[];
```

Rules:

- first frame clears screen and writes all lines;
- later frames only rewrite changed lines;
- always clear line before writing a shorter replacement;
- cursor ends at composer cursor position;
- no flicker from full clear/redraw during streaming.

## Resize Handling

Controller listens to `SIGWINCH`:

1. update `state.size`;
2. re-run layout/wrap/render;
3. force full repaint on next frame;
4. preserve scroll intent where possible.

## Approval Overlay

Active approval should be impossible to miss:

```text
╭─ approval required ───────────────────────────────╮
│ run_bash: npm test                                │
│ y approve · n deny · v expand diff · esc deny     │
╰───────────────────────────────────────────────────╯
```

Rules:

- `y` approves;
- `n` denies;
- non-TTY never enters TUI approval path;
- preview/diff is bounded;
- denial/approval emits a transcript event.

## Keymap

Minimum:

```text
PgUp/PgDn       scroll page
Up/Down         history or scroll depending focus
j/k             scroll line when composer empty
Home/End        top/bottom
Enter           submit
Alt+Enter       newline
Tab             next selectable block
Shift+Tab       previous selectable block
Space/Enter     expand/collapse selected block
y/n             approval response when overlay active
Ctrl+C          interrupt current run or exit idle
Ctrl+L          redraw
?               help overlay
Esc             close overlay / deny approval / return to composer
```

## Config and Activation

CLI:

```bash
deepcoder --tui
```

Env:

```bash
DEEPCODER_UI=tui
DEEPCODER_UI=plain
```

Config:

```json
{
  "ui": {
    "mode": "auto",
    "markdown": true,
    "syntaxHighlighting": true,
    "color": "auto"
  }
}
```

Default should remain current plain behavior until TUI is stable. Auto mode can later enable TUI for
interactive TTYs.

## Tests

No real TTY required for most tests.

1. Render layout respects status/transcript/composer heights.
2. Scroll reducer disables follow-tail on manual scroll.
3. End re-enables follow-tail.
4. Input reducer inserts, deletes, moves cursor.
5. History up/down works without corrupting current draft.
6. Multiline input preserves newlines and cursor.
7. Approval overlay captures `y`/`n` and emits commands.
8. Collapsed tool/check blocks render bounded summaries.
9. Expanded block is bounded by viewport/caps.
10. `diffFrames` rewrites only changed lines after first frame.
11. Shorter changed lines clear stale tail content.
12. Resize forces full repaint and preserves transcript content.
13. Non-TTY does not start TUI.
14. Existing plain renderer tests remain green.

## Rollout

### 10A.5.1 — State and Key Reducer

- Add `TuiState`, `InputState`, `ScrollState`, key reducer, tests.

### 10A.5.2 — Layout and Block Renderers

- Render single-column status/transcript/composer frames.
- Add collapsed/expanded block support.

### 10A.5.3 — Frame Diff Writer

- Add anti-flicker terminal ops and tests.

### 10A.5.4 — Terminal Controller

- Raw mode, keypress, resize, render loop.
- No business logic in controller.

### 10A.5.5 — CLI Integration

- `--tui` / `DEEPCODER_UI=tui`.
- Wire REPL events into controller.

### 10A.5.6 — Polish

- Help overlay.
- Status details.
- Input history persistence optional later.

## Acceptance Criteria

- TUI can run an interactive one-shot/REPL session with scrollback and composer.
- Streaming assistant output updates without full-screen flicker.
- Approvals work in TUI and remain fail-closed outside TTY.
- Tool/check/worker blocks are readable and collapsible.
- Resize does not corrupt the screen.
- Plain mode behavior remains unchanged.
- `npm run typecheck` and `npm run test:phase` pass.

## Open Questions

- Should auto mode eventually make TUI default for TTYs?
- Should mouse wheel support ship in MVP or later?
- Should input history persist across sessions?
- Should worker patch review open as inline block first or overlay first?
