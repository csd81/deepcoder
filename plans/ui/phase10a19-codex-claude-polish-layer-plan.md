# Phase 10A.19 — Codex/Claude-Style TUI Polish Layer

## Context

Deepcoder already has or has plans for the mechanical pieces of a modern terminal UI:

- scrollable transcript
- slash dropdown
- bottom status bar
- compact cards
- markdown rendering
- syntax highlighting
- mouse scroll
- copy/export
- theme switching

Those features are necessary, but they do not automatically make the app feel like Codex or Claude Code. The next high-ROI UI step is a cohesive polish layer: consistent message chrome, spacing, semantic color, empty/busy states, and status affordances that make the app look intentional instead of log-like.

This phase does **not** clone Codex/Claude. It applies the same product principles:

- quiet, readable chat surface
- compact operational cards
- strong input focus at the bottom
- explicit state near the composer
- low-noise visual hierarchy
- predictable keyboard-first controls

## Goal

Add a cohesive visual polish layer for the TUI:

- consistent role headers for user/assistant/system/tool/check/worker blocks
- visually distinct user prompts and assistant responses
- compact state chips for tool/check/worker cards
- polished empty state
- polished busy/streaming state
- consistent separators, spacing, and truncation
- one semantic style system used by transcript, cards, footer, slash menu, and help overlay

Target feel:

```text
You
  implement /doctor

Deepcoder
  I'll inspect the existing slash command wiring first.

  ▸ tool rg · 23 matches · 6 files
  ✓ check phase · 18.2s · 305 passed

────────────────────────────────────────────────────────
> _
Enter send · / commands · Ctrl+F search · ? help
deepcoder · deepseek/v4-flash · sandbox fast · master* · 42k ctx
```

## Non-Goals

- No new model behavior.
- No new tool behavior.
- No new TUI dependency such as Ink, blessed, or Yoga.
- No side-pane layout.
- No full diff browser implementation.
- No mouse drag selection.
- No persistence changes.

## Design Principles

1. **Input owns the bottom.**
   The composer and status/footer are always visually stable and close together.

2. **Conversation owns the center.**
   Model/user text should be easy to read, with tool noise collapsed into cards.

3. **Operational state is visible but not loud.**
   Checks, sandbox, costs, workers, and approvals should be visible as concise chips.

4. **Colors are semantic, not decorative.**
   Green means pass, red means fail, yellow means attention, dim means secondary.

5. **Plain terminal compatibility.**
   Every style degrades cleanly under `NO_COLOR`, narrow terminals, and dumb terminals.

## User-Facing Changes

### 1. Message Chrome

Render transcript blocks with stable role headers:

```text
You
  ...

Deepcoder
  ...

System
  ...
```

Rules:

- user and assistant are visually primary
- system/developer/internal metadata is dimmed
- no box borders around normal chat messages
- blank line between major messages
- long role labels truncate safely

### 2. Operational Cards

Tool/check/worker blocks render as compact one-line cards by default:

```text
▸ tool read_file · 84 lines
✓ check phase · 18.2s · 305 passed
✗ check unit · 9.4s · 3 failed
▸ worker 10E web_fetch · attempt 2 · 3 files
```

Expanded cards show a small preview, not an unbounded dump:

```text
▾ check unit · failed · 9.4s · 3 failed
  FAILED test/foo.test.ts:42
  Expected 1, got 0
  ...
  full log available · y copy · s save
```

This reuses or composes with the compact-output-card plan.

### 3. Empty State

When the transcript has no meaningful conversation yet:

```text
Deepcoder

  Start with a task, or type / for commands.

  Common:
    /doctor        check local setup
    /model         inspect model routing
    /permissions   inspect safety posture
    /delegate      split work into workers
```

Rules:

- no marketing copy
- no large hero layout
- no ASCII art
- useful shortcuts only
- bounded to terminal height

### 4. Busy/Streaming State

When the assistant is streaming:

```text
Deepcoder thinking · 14s · deepseek/v4-flash
```

When a tool/check/worker is active:

```text
running check phase · 00:18
```

Rules:

- no spinner required; text updates are enough
- avoid flicker by using existing diff frame writer
- active state appears near footer/status and in transcript card

### 5. Contextual Footer Hints

Footer hints should match mode:

Normal:

```text
Enter send · / commands · Ctrl+F search · ? help
```

Focused card:

```text
Enter expand · y copy · s save · Tab next · Esc clear
```

Slash menu:

```text
↑↓ select · Enter complete · Esc close
```

Approval:

```text
y approve · n deny · ↑↓ scroll diff
```

This composes with the bottom-statusbar plan.

## Architecture

### 1. Style Tokens

New file:

```text
src/ui/styleTokens.ts
```

Exports:

```ts
export interface StyleTokens {
  role: {
    user: (s: string) => string;
    assistant: (s: string) => string;
    system: (s: string) => string;
    tool: (s: string) => string;
    check: (s: string) => string;
    worker: (s: string) => string;
  };
  state: {
    success: (s: string) => string;
    error: (s: string) => string;
    warning: (s: string) => string;
    running: (s: string) => string;
    muted: (s: string) => string;
    selected: (s: string) => string;
  };
  chrome: {
    separator: string;
    bulletCollapsed: string;
    bulletExpanded: string;
    checkPass: string;
    checkFail: string;
  };
}
```

`styleTokens` wraps the existing theme rather than replacing it.

### 2. Transcript Presenter

New file:

```text
src/ui/transcriptPresenter.ts
```

Exports:

```ts
export interface PresentedBlock {
  id: string;
  lines: string[];
  focusable: boolean;
}

export interface PresentTranscriptInput {
  blocks: readonly TranscriptBlock[];
  width: number;
  selectedId?: string;
  tokens: StyleTokens;
  emptyState?: boolean;
}

export function presentTranscript(input: PresentTranscriptInput): PresentedBlock[];
```

Responsibilities:

- role headers
- spacing between messages
- compact card rendering
- expansion preview handoff
- selected card styling
- bounded empty state

This keeps `minimalRenderer.ts` from accumulating all presentation logic.

### 3. Empty State Renderer

New file:

```text
src/ui/emptyState.ts
```

Exports:

```ts
export function renderEmptyState(opts: { width: number; height: number; tokens: StyleTokens }): string[];
```

Recommended commands:

- `/doctor`
- `/permissions`
- `/model`
- `/delegate`
- `/help`

No provider-specific or project-specific text.

### 4. Busy State Model

Extend existing UI status inputs rather than creating a new event system.

Fields:

```ts
activeAssistant?: { model?: string; elapsedMs?: number };
activeOperation?: { kind: "tool" | "check" | "worker" | "subagent"; label: string; elapsedMs?: number };
```

Render through footer/status and card headers.

### 5. Minimal Renderer Integration

Edit:

- `src/ui/minimalRenderer.ts`
- `src/cli/repl.ts`

Keep core constraints:

- pure frame render remains testable
- no TTY required for tests
- diff frame writer remains responsible for low-flicker output
- no side effects in presenter

## Tests

New file:

```text
test/adversarial/ui-polish-layer.test.ts
```

Coverage:

1. Empty transcript renders useful bounded empty state.
2. User and assistant blocks render with distinct role headers.
3. System/internal blocks are dim/secondary.
4. Tool blocks render as compact cards when collapsed.
5. Expanded tool/check cards show bounded previews.
6. Check pass/fail cards use distinct semantic markers.
7. Selected card is visibly marked but width-bounded.
8. Footer hints change by mode.
9. Busy state appears without shifting composer position.
10. Very narrow terminal still produces non-overlapping lines.
11. `NO_COLOR` output has no ANSI codes but remains readable.
12. Long model/check/worker labels truncate safely.
13. No secret-looking strings appear unredacted in previews.
14. Snapshot-style output remains deterministic.

## Acceptance

Required:

```text
npm run typecheck
npm run test:phase
node --import tsx --test test/adversarial/ui-polish-layer.test.ts
```

Manual smoke:

```text
DEEPCODER_UI=tui deepcoder
/help
/doctor
/check phase
```

Check:

- first screen has a clear bottom composer
- transcript looks like chat, not raw logs
- tool/check output is compact by default
- expanded output remains bounded
- slash menu/footer/status do not overlap
- colors are useful but not required
- resizing does not create garbled layout

## Relationship To Existing Plans

This phase composes with, but does not replace:

- `phase10a12-tui-copy-export-plan.md`
- `phase10a13-tui-help-overlay-plan.md`
- `phase10a15-streaming-assistant-polish-plan.md`
- `phase10a16-compact-output-cards-plan.md`
- `phase10a17-bottom-statusbar-footer-hints-plan.md`
- `phase10a18-color-theme-switcher-plan.md`

If those are not implemented first, this phase should start with the shared primitives:

1. style tokens
2. transcript presenter
3. empty state

Then wire cards/footer/streaming as the dependency plans land.

## Delegation Suitability

Good disjoint slices:

1. `styleTokens.ts` + tests
2. `emptyState.ts` + tests
3. `transcriptPresenter.ts` + tests

Manual integration recommended for:

- `minimalRenderer.ts`
- `repl.ts`

Reason: the pure presentation pieces are easy to delegate and verify. Renderer integration touches the live TUI path and should be reviewed carefully.

## Implementation Order

1. Add style tokens wrapping existing theme.
2. Add empty state renderer.
3. Add transcript presenter for user/assistant/system role chrome.
4. Add compact operational-card presentation hooks.
5. Wire presenter into minimal renderer.
6. Add busy-state fields and footer/status rendering.
7. Run test snapshots across wide/narrow/no-color.
8. Manual TUI smoke in a real terminal.
