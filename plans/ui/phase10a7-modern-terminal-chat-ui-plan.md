# Phase 10A.7 — Modern Terminal Chat UI

## Context

Deepcoder already has a hand-rolled experimental TUI:

- alternate screen + raw input in `runTuiRepl`
- top status row
- scrollable transcript area
- bottom composer
- input history and multiline editing
- diff-based frame writer
- markdown rendering and syntax highlighting
- approval modal with diff scrolling
- collapsible tool/check/worker blocks
- resize handling

The current experience is still not at a Codex/Claude-style daily-driver level:

- slash commands suspend the TUI and run on the normal screen
- no slash-command autocomplete dropdown
- mouse wheel support is missing
- output is not consistently presented as a polished chat timeline
- command/check/tool logs need better visual treatment
- the composer needs to feel like a fixed bottom input bar, not just the last rendered row

This phase upgrades the experimental TUI into a modern terminal chat interface while keeping
the existing dependency-light architecture.

## Goal

Make `deepcoder --tui` feel like a modern coding-agent terminal UI:

```text
┌ deepcoder · model · sandbox · cost/tokens · branch/check status ─────────────┐
│ user / assistant / tool / check / worker transcript                         │
│ collapsible tool output                                                     │
│ markdown-rendered assistant output                                          │
│ check run blocks with pass/fail badges                                      │
│ worker/delegate review summaries                                           │
│ ... mouse-wheel scrollback ...                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│ /slash dropdown when input starts with "/"                                  │
│ > fixed bottom input composer                                               │
└──────────────────────────────────────────────────────────────────────────────┘
```

Core user-facing features:

- output transcript on top
- fixed input line/composer at the bottom
- mouse wheel scrollback
- slash commands appear in a dropdown when the user presses `/`
- keyboard navigation for slash suggestions
- modern visual hierarchy: status bar, badges, dim tool logs, highlighted errors
- no flicker during streaming
- clean fallback to plain mode for non-TTY

## Non-Goals

- No full Ink/React rewrite.
- No Yoga dependency in this phase.
- No web browser UI.
- No global redesign of slash command semantics.
- No mouse click editing in v1; mouse wheel first.
- No applying delegate patches from this TUI unless existing apply gates are reused.

## Design Principles

- Keep pure state/render modules testable without a real TTY.
- Keep terminal I/O thin and small inside `runTuiRepl`.
- Prefer hand-rolled primitives over a framework until the UI needs true nested widgets.
- Every interactive action must have a keyboard path.
- Never let UI rendering bypass existing approval, sandbox, delegate, or apply gates.
- Treat slash dropdown as discovery/navigation only; execution still goes through
  `handleSlashCommand`.

## Existing Pieces to Reuse

- `src/ui/minimalRenderer.ts` — frame builder
- `src/ui/frameWriter.ts` — diff writer
- `src/ui/inputEditor.ts` — composer state/history/multiline
- `src/ui/layout.ts` — pure row/column layout solver
- `src/ui/transcript.ts` — transcript state/events/collapsible blocks
- `src/ui/theme.ts` — color handling
- `src/ui/markdown.ts` and `src/ui/syntax.ts` — assistant output formatting
- `src/ui/approvalModal.ts` — approval overlay
- `src/cli/slashCommands.ts` — command implementation/source of truth

## Architecture

### 1. UI State

Add a higher-level TUI state module:

```text
src/ui/chatUiState.ts
```

Shape:

```ts
interface ChatUiState {
  transcript: TranscriptState;
  editor: EditorState;
  viewportTop: number;
  atBottom: boolean;
  busy: boolean;
  slashMenu: SlashMenuState;
  focusedRegion: "transcript" | "composer" | "slash-menu" | "approval";
  size: { width: number; height: number };
}
```

All transitions should be pure where possible:

```ts
reduceChatUi(state, action) -> state
```

### 2. Fixed Bottom Composer

Keep the layout column split:

```text
status: fixed 1
transcript: grow
new-output indicator / slash dropdown: fixed dynamic
composer: fixed dynamic height
```

Composer requirements:

- fixed at bottom
- supports multiline input
- caps displayed composer height, e.g. max 6 rows
- scrolls internally if input exceeds cap
- shows placeholder when empty, e.g. `Ask deepcoder or type /`
- Enter submits
- Alt+Enter inserts newline
- Up/Down history only when slash menu is closed

### 3. Mouse Wheel Scrollback

Enable mouse tracking in TUI mode:

```text
\x1b[?1000h basic mouse
\x1b[?1002h button-event tracking if needed later
\x1b[?1006h SGR mouse mode
```

On exit, always disable:

```text
\x1b[?1000l\x1b[?1002l\x1b[?1006l
```

Implement parser:

```text
src/ui/mouse.ts
```

Support only SGR wheel events for MVP:

- wheel up -> transcript scroll up
- wheel down -> transcript scroll down
- Shift+wheel or page-sized wheel can be follow-up

Tests:

- parses wheel-up/wheel-down escape sequences
- ignores unsupported mouse events
- TUI restore emits mouse-disable sequence

### 4. Slash Command Dropdown

Add a pure slash command catalog:

```text
src/cli/slashCatalog.ts
```

Each command:

```ts
interface SlashCommandInfo {
  name: string;
  args?: string;
  description: string;
  category: "session" | "context" | "checks" | "delegate" | "web" | "config" | "debug";
  aliases?: string[];
}
```

Important: this is metadata only. `handleSlashCommand` remains the executor.

Add:

```text
src/ui/slashMenu.ts
```

Behavior:

- menu opens when composer text starts with `/`
- filter by current token after `/`
- shows top N matches, default 8
- selected row with Up/Down or Ctrl+N/Ctrl+P
- Tab or Enter completes command when menu is open and command has not been submitted
- Enter submits if command is already complete or user presses Enter twice
- Esc closes menu
- menu closes when input no longer starts with `/`

Render:

```text
╭ commands ───────────────────────────╮
│ /solve <check> <task>   Run solver  │
│ /check <name>           Run check   │
│ /delegate review        Review plan │
╰─────────────────────────────────────╯
```

Use normal ASCII fallback if box drawing is disabled or terminal is narrow.

Tests:

- `/` opens menu
- `/de` filters delegate commands
- Down/Up changes selection
- Tab completes selected command
- Esc closes menu
- menu output is bounded and width-truncated

### 5. Transcript Polish

Improve block rendering:

- user messages: strong prompt marker
- assistant messages: markdown-rendered, no raw markdown clutter
- tool blocks: dim, collapsible, show duration/exit if available
- check blocks: green/red badge, duration, truncated log preview
- worker/delegate blocks: status badge and changed files summary
- notices/errors: warning/error colors

Recommended display:

```text
you
  fix the parser bug

assistant
  I’ll inspect the parser and tests first.

▸ tool read_file src/parser.ts       84 lines
▾ check phase ✓ 18.2s
  tests 412 passed
```

### 6. Status Bar

Status bar should include compact operational state:

- provider/model
- sandbox mode
- git branch + dirty indicator if cheap/available
- tokens/cost if available
- running/idle
- web on/off
- delegate workers running count if available

Example:

```text
deepcoder · deepseek/deepseek-v4-flash · sandbox fast · web off · master* · 42k ctx · $0.03 · running
```

All pieces should degrade gracefully if unavailable.

### 7. Native Slash Execution

Current TUI suspends to normal screen for slash commands. Improve in two stages.

Stage A, this phase:

- slash dropdown is native
- when command is submitted, TUI adds a transcript block:
  - `command /check phase`
  - result summary
- commands that already print to stdout may still temporarily suspend, but the user sees a
  transcript notice before/after

Stage B, follow-up:

- refactor slash commands to return structured `SlashCommandResult`
- render results natively without leaving alternate screen

This avoids boiling the ocean while still making slash discovery modern.

## Files

New:

- `src/ui/chatUiState.ts`
- `src/ui/mouse.ts`
- `src/ui/slashMenu.ts`
- `src/cli/slashCatalog.ts`
- `test/adversarial/ui-mouse.test.ts`
- `test/adversarial/ui-slash-menu.test.ts`
- `test/adversarial/ui-chat-state.test.ts`

Edited:

- `src/cli/repl.ts`
- `src/ui/minimalRenderer.ts`
- `src/ui/transcript.ts`
- `src/ui/theme.ts`
- `test/adversarial/ui-minimal-renderer.test.ts`
- `plans/ui/phase10a-scrollable-terminal-ui-plan.md` or README docs

## Implementation Order

### Slice 1 — Slash Catalog and Menu

- Extract slash metadata into `slashCatalog.ts`.
- Add pure `filterSlashCommands`.
- Add pure slash menu reducer/render helper.
- Tests for filtering, selection, completion, bounds.

This slice is file-disjoint enough to delegate.

### Slice 2 — Mouse Wheel Parser

- Add `mouse.ts`.
- Parse SGR wheel events.
- Add terminal enable/disable constants.
- Tests for parsing and ignored events.

This slice is small and delegate-friendly.

### Slice 3 — Chat UI State Reducer

- Introduce `ChatUiState`.
- Move viewport/menu/editor state transitions out of `runTuiRepl`.
- Keep I/O unchanged initially.
- Tests for scroll, submit, slash open/close, resize.

### Slice 4 — Renderer Polish

- Improve frame layout for fixed composer and dropdown area.
- Add status bar renderer.
- Add better transcript block styling.
- Ensure no overlap on narrow terminals.

### Slice 5 — Repl Integration

- Enable mouse tracking on TUI enter and disable on restore.
- Wire mouse wheel actions.
- Wire slash dropdown actions.
- Keep slash command execution through existing handler.
- Add manual smoke checklist.

## Acceptance

No live model required.

- `npm run typecheck`
- `npm run test:phase`
- TUI pure renderer tests pass
- slash menu tests pass
- mouse parser tests pass
- manual smoke:

```bash
npm run dev -- --tui
```

Smoke checklist:

- output stays above input
- input remains fixed at bottom while assistant streams
- mouse wheel scrolls transcript
- PgUp/PgDn still scroll
- typing `/` opens dropdown
- typing `/de` filters to delegate commands
- Tab completes selected command
- Esc closes dropdown
- slash command execution does not corrupt terminal
- Ctrl+C restores terminal cleanly
- resizing terminal reflows without overlap

## Safety

- No command execution changes.
- Slash dropdown never executes by itself; it only completes text.
- Existing approval flow remains authoritative.
- TUI must always restore raw mode, cursor, alternate screen, and mouse tracking on exit.
- Non-TTY never enters TUI.

## Follow-Ups

- Native structured slash command rendering without alternate-screen suspension.
- Search within scrollback.
- Clickable/selectable transcript blocks.
- Copy/export transcript block.
- Dedicated delegate review panel.
- Horizontal scroll mode for wide tables/code.
- Persist TUI preferences in config.

