# Deepcoder Phase 10A - Scrollable Terminal UI

## Context

Deepcoder currently uses a line-oriented terminal interface:

- `runRepl` is built on `node:readline/promises`,
- assistant streaming writes directly to `stdout`,
- tool output is printed inline,
- approval prompts are blocking readline questions,
- long output scrolls away in the terminal's native scrollback.

That is simple and robust, but it is not the UX users expect from Codex or
Claude Code:

- no fixed input bar,
- no persistent message pane,
- no keyboard scrollback,
- hard to inspect old tool output,
- long diffs/check logs flood the prompt,
- no stable place for status, tokens, branch, sandbox, or active worker state.

Phase 10A adds an optional scrollable terminal UI while keeping the current
plain CLI as the fallback and non-TTY mode.

## Goal

Provide an interactive TUI with:

- scrollable transcript,
- fixed input composer,
- stable status bar,
- streamed assistant output,
- collapsible tool/check blocks,
- approval prompt overlay,
- keyboard navigation,
- no behavior change for headless/non-TTY runs.

```text
┌────────────────────────────────────────────┐
│ status: auto · sandbox fast · branch master │
├────────────────────────────────────────────┤
│ scrollable transcript                       │
│ assistant/tool/check/output blocks          │
│ ...                                         │
├────────────────────────────────────────────┤
│ > input composer                            │
└────────────────────────────────────────────┘
```

## ROI

Medium-high.

Why it helps:

- improves daily usability immediately,
- makes long tool/check output inspectable,
- reduces accidental context loss in terminal scrollback,
- gives a foundation for worker/status dashboards,
- makes approval and patch review less chaotic.

Why it is not first priority:

- terminal UI bugs can be distracting,
- raw-mode input and rendering are fiddly,
- must preserve existing CLI reliability.

## Non-Goals

- Do not replace the headless one-shot mode.
- Do not change agent loop semantics.
- Do not add a web UI.
- Do not implement mouse support in v1.
- Do not render full-screen diff viewers in v1.
- Do not require TUI dependencies for non-interactive use.

## UX Modes

Add:

```bash
deepcoder --tui
deepcoder --no-tui
```

Environment:

```bash
DEEPCODER_TUI=1
DEEPCODER_TUI=0
```

Default:

- if `stdin.isTTY && stdout.isTTY`: eventually `tui`,
- v1 default remains current line mode unless `--tui` is set,
- non-TTY always line/headless mode.

## Library Choice

Preferred: `ink` + React.

Reasons:

- modern terminal UI model,
- composable components,
- good input handling,
- easier testing with component rendering,
- used by several modern CLIs.

Alternative: `blessed`.

Reasons to avoid initially:

- older imperative model,
- more rendering quirks,
- harder to integrate with existing typed state.

If dependency risk is a concern, implement a minimal internal renderer first:

- raw mode,
- alternate screen,
- manual ANSI clear/draw,
- simple scrollback.

Recommendation: use `ink` if install/build is clean; otherwise minimal renderer
for 10A and defer React-like composition.

## Architecture

Introduce a UI event boundary between the agent loop and terminal rendering.

New modules:

```text
src/ui/events.ts
src/ui/transcript.ts
src/ui/plainRenderer.ts
src/ui/tui/App.tsx
src/ui/tui/components/*
src/ui/tui/input.ts
```

The agent loop should not write directly to stdout. Instead, CLI wiring emits
events:

```ts
type UiEvent =
  | { type: "assistant_delta"; text: string }
  | { type: "assistant_done"; text?: string }
  | { type: "tool_start"; name: string; description: string }
  | { type: "tool_result"; name: string; output: string; isError: boolean }
  | { type: "notice"; message: string; severity?: "info" | "warn" | "error" }
  | { type: "approval_request"; id: string; description: string; diff?: string }
  | { type: "approval_result"; id: string; approved: boolean }
  | { type: "status"; patch: Partial<UiStatus> };
```

Line mode consumes events and prints like today.

TUI mode consumes events and updates a structured transcript.

## Transcript Model

```ts
interface TranscriptBlock {
  id: string;
  kind:
    | "user"
    | "assistant"
    | "tool"
    | "check"
    | "notice"
    | "approval"
    | "system";
  title?: string;
  body: string;
  collapsed?: boolean;
  isError?: boolean;
  startedAt: string;
  finishedAt?: string;
}
```

Rules:

- assistant streaming appends to the current assistant block,
- tool output gets its own block,
- long tool/check blocks default collapsed after a threshold,
- secrets are already redacted upstream; renderer should not unredact or persist.

## Input Composer

Features v1:

- single-line input,
- Enter submits,
- Shift+Enter or Alt+Enter inserts newline if feasible,
- Up/Down history navigation,
- Ctrl+C behavior:
  - during idle: exit prompt,
  - during run: abort current run,
  - second Ctrl+C: force exit,
- slash commands supported exactly as today.

Deferred:

- full multiline editor,
- command palette,
- autocomplete,
- mouse selection.

## Scrolling

Keyboard:

```text
PageUp / PageDown    scroll viewport
Ctrl+u / Ctrl+d      half-page scroll
Home / End           top / bottom
Esc                  return to bottom / close overlay
```

Behavior:

- auto-follow while at bottom,
- if user scrolls up, new output does not yank viewport,
- show "new output below" indicator,
- End returns to live tail.

## Approval Overlay

Approval prompts should become an overlay/modal in TUI mode:

```text
Permission required: Edit src/foo.ts

diff preview...

[y] approve   [n] deny
```

Implementation:

- replace direct `promptForApproval` dependency with an injected approval
  interface,
- plain renderer uses existing readline prompt,
- TUI renderer resolves a promise from keypress.

Non-TTY remains auto-deny.

## Status Bar

Show compact state:

- mode: ask/auto/readonly,
- model/provider,
- sandbox mode,
- workspace isolation mode,
- branch + dirty indicator,
- active check/worker,
- token usage if available.

Status updates should be best-effort and never block agent execution.

## Output Bounding

TUI makes output easier to inspect, but still must not become an unbounded memory
sink.

Transcript limits:

- max blocks, e.g. 500,
- max bytes per block, e.g. 256 KiB,
- max total transcript bytes, e.g. 8 MiB,
- collapsed large blocks retain first/last chunks.

Persisted session history remains unchanged; UI transcript is a view concern.

## Config

Add:

```json
{
  "ui": {
    "mode": "plain",
    "transcriptMaxBytes": 8388608,
    "collapseToolOutputAfterBytes": 12000,
    "showStatusBar": true,
    "useAlternateScreen": true
  }
}
```

Environment:

```bash
DEEPCODER_UI=tui
DEEPCODER_UI=plain
```

## Integration Points

### `src/cli/repl.ts`

Currently owns:

- readline prompt,
- stdout streaming,
- approval callback,
- notice rendering,
- tool rendering.

Refactor into:

```ts
runRepl(session, renderer)
```

or:

```ts
createUi(session) -> { promptUser, emit, approve, close }
```

### `src/permissions/prompt.ts`

Keep as plain-mode approval implementation.

Add interface:

```ts
interface ApprovalProvider {
  approve(invocation: ToolInvocation, preview?: ToolPreview): Promise<boolean>;
}
```

### `src/cli/solveRunner.ts`

Can stay plain in v1. TUI solve-mode support comes after interactive REPL TUI.

## Testing

No live model required.

### Pure tests

1. transcript appends assistant deltas into one block.
2. tool results create separate blocks.
3. large blocks collapse.
4. transcript total byte cap evicts old blocks.
5. scroll state follows bottom by default.
6. scrolling up disables auto-follow.
7. new-output indicator appears when not at bottom.
8. status patches merge.

### Renderer tests

If using Ink:

- render transcript with long tool block,
- render approval overlay,
- keypress `y` resolves approval true,
- keypress `n` resolves false,
- PageUp/PageDown adjust viewport.

### Integration tests

1. line mode output unchanged for simple one-shot.
2. non-TTY never starts TUI.
3. Ctrl+C aborts active run.
4. approval in TUI blocks until keypress.
5. secrets in rendered transcript remain redacted.

## Acceptance

Required:

```bash
npm run typecheck
npm run test:phase
```

Manual smoke:

```bash
deepcoder --tui
```

Then:

1. ask a simple readonly question,
2. run a tool that produces long output,
3. scroll up/down,
4. trigger an edit approval,
5. approve/deny from overlay,
6. run a slash command,
7. Ctrl+C aborts cleanly,
8. exit returns terminal to normal state.

## Rollout

Phase 10A:

- optional `--tui`,
- interactive REPL only,
- basic scrollback/input/status/approval.

Phase 10B:

- solve/delegate dashboards,
- worker progress panels,
- diff viewer,
- command palette/autocomplete.

Phase 10C:

- persistent terminal panes / PTY integration.

## Risks

### Terminal Corruption

Raw mode/alternate screen can leave the terminal broken after crashes.

Mitigation:

- `try/finally` restore,
- signal handlers restore,
- plain mode fallback,
- tests for close/cleanup paths.

### Regression in Headless Mode

TUI must never start when stdin/stdout are not TTY.

Mitigation:

- explicit TTY checks,
- non-TTY tests.

### Excess Memory

Long tool output can balloon UI state.

Mitigation:

- block and transcript caps,
- collapsed large blocks,
- no raw unbounded logs in UI.

### Approval Bugs

Approval flow is security-sensitive.

Mitigation:

- shared approval interface,
- non-TTY auto-deny unchanged,
- TUI approval tests,
- denied-by-policy tools never reach approval UI.

## Implementation Order

1. Add UI config types.
2. Add `UiEvent` and transcript reducer with tests.
3. Add plain renderer adapter to preserve current behavior.
4. Refactor `runRepl` to emit UI events instead of direct stdout writes.
5. Add TUI renderer/app behind `--tui`.
6. Add input composer and scroll viewport.
7. Add approval overlay.
8. Add status bar.
9. Add tests and manual smoke.
10. Document usage in README.

## Definition of Done

- `deepcoder --tui` opens a scrollable terminal UI.
- Existing plain CLI still works.
- Non-TTY/headless behavior is unchanged.
- Approval prompts work safely in both modes.
- Long outputs are scrollable and bounded.
- Terminal state is restored on exit/abort.
