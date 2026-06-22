# Phase 10A.13 — Contextual TUI Help Overlay

## Context

Deepcoder's TUI is gaining more interactive features:

- scrollback
- collapsible tool/check/worker blocks
- approval modal
- multiline composer
- slash-command dropdown
- scrollback search
- mouse interactions
- copy/export shortcuts
- live activity timeline

As the keybindings grow, discoverability becomes a real usability issue. A modern terminal UI
needs an in-app help overlay that shows the relevant controls for the current mode.

## Goal

Press `?` in TUI mode to show a contextual help overlay.

The overlay should display mode-specific controls:

- normal transcript mode
- focused block mode
- slash dropdown mode
- search mode
- approval modal mode
- busy/running mode

`Esc` closes the overlay. Pressing `?` again toggles it.

## Non-Goals

- No command execution changes.
- No interactive tutorial.
- No searchable help in v1.
- No external docs browser.
- No help overlay in plain/non-TTY mode.
- No dependency on Ink/blessed.

## Design

### 1. Help Context

New file:

```text
src/ui/helpOverlay.ts
```

Types:

```ts
export type HelpMode =
  | "normal"
  | "busy"
  | "focused-block"
  | "slash-menu"
  | "search"
  | "approval";

export interface HelpEntry {
  keys: string;
  label: string;
  detail?: string;
}

export interface HelpOverlayInput {
  mode: HelpMode;
  width: number;
  height: number;
  color?: boolean;
  title?: string;
}
```

Exports:

```ts
export function helpEntriesForMode(mode: HelpMode): HelpEntry[];
export function renderHelpOverlay(input: HelpOverlayInput, theme: Theme): string[];
```

### 2. Mode Detection

In `runTuiRepl`, derive help mode:

```ts
function currentHelpMode(): HelpMode {
  if (pendingApproval) return "approval";
  if (searchActive) return "search";
  if (slashMenu.open) return "slash-menu";
  if (transcript.selectedBlockId) return "focused-block";
  if (busy) return "busy";
  return "normal";
}
```

If features are not yet implemented, include only active modes and leave future entries in
the plan. The overlay should evolve with the UI.

### 3. Entries

Normal mode:

```text
Enter        submit prompt
Alt+Enter    insert newline
↑/↓          prompt history
PgUp/PgDn    scroll transcript
Home/End     top/bottom
/            slash commands
Ctrl+F       search transcript
Tab          focus next tool/check/worker block
?            help
Ctrl+C       exit / interrupt
```

Focused block mode:

```text
Tab          next block
Shift+Tab    previous block
Enter        expand/collapse
Esc          clear focus
y            copy block
s            save block
```

Slash menu mode:

```text
↑/↓          select command
Tab          complete command
Enter        submit command
Esc          close menu
```

Search mode:

```text
type         update search
Enter / n    next match
p            previous match
PgUp/PgDn    scroll
Esc          close search
```

Approval mode:

```text
y            approve
n            deny
↑/↓          scroll diff
PgUp/PgDn    scroll diff faster
Esc          deny / close
```

Busy mode:

```text
PgUp/PgDn    scroll while work runs
Tab          inspect latest block
Ctrl+C       interrupt
?            help
```

### 4. Rendering

Use a centered bounded overlay in the transcript area, similar to approval modal style.

Example:

```text
╭ Help — normal ─────────────────────────────╮
│ Enter       submit prompt                  │
│ Alt+Enter   insert newline                 │
│ /           slash commands                 │
│ Ctrl+F      search transcript              │
│ Tab         focus tool/check/worker block  │
│ Esc         close overlays / clear focus   │
╰────────────────────────────────────────────╯
```

Fallback:

- if terminal is too narrow, use ASCII border or no border
- truncate rows to width
- cap rows to height
- include footer: `Esc close`

### 5. TUI Integration

Add local state:

```ts
let helpOpen = false;
```

Key behavior:

- `?` toggles `helpOpen` when not typing normal prompt text
- if help is open:
  - `Esc` closes
  - `?` closes
  - other keys ignored, except Ctrl+C

Important ambiguity:

- `?` should still be insertable in normal prompt text. Recommended rule:
  - if composer is empty, `?` toggles help
  - if composer has text, `?` inserts the character
  - if slash/search/approval mode is active, `?` toggles help regardless only when not editing
    a query; search mode can use `F1` later if this becomes awkward

Alternative:

- map help to `F1` and `?`.

MVP recommendation:

- `?` toggles help only when composer text is empty.

### 6. Renderer Integration

When `helpOpen`, the main content window should render the help overlay instead of transcript
lines, same pattern as approval modal.

Priority:

1. approval modal
2. help overlay
3. normal transcript

If approval is active and help is requested, show approval-mode help in the modal area without
losing the approval request state.

## Files

New:

- `src/ui/helpOverlay.ts`
- `test/adversarial/ui-help-overlay.test.ts`

Edited:

- `src/cli/repl.ts`
- `src/ui/minimalRenderer.ts` if overlay plumbing belongs there
- `src/ui/theme.ts` if extra border/title styles are useful
- `test/adversarial/ui-minimal-renderer.test.ts`

## Tests

Pure tests:

- normal mode entries include submit, slash commands, scroll, help
- focused-block entries include copy/save/expand
- slash-menu entries include select/complete/close
- search entries include next/previous/close
- approval entries include approve/deny/scroll
- busy entries include interrupt
- render output is bounded by width and height
- narrow width does not throw
- no-color output has no ANSI

Integration tests if reducer is extracted:

- `?` opens help when composer empty
- `?` inserts literal question mark when composer has text
- Esc closes help
- help mode derives approval/search/slash/focused/busy priority correctly

## Acceptance

- `npm run typecheck`
- `npm run test:phase`
- manual smoke:

```bash
npm run dev -- --tui
```

Smoke checklist:

- press `?` on empty composer -> help appears
- press `Esc` -> help closes
- type `hello?` -> question mark is inserted, not help
- focus a block with Tab, press `?` -> focused-block help
- open slash menu with `/`, press `?` if supported -> slash help
- during approval modal, help shows approval keys or does not break approval
- terminal restore remains clean

## Safety

- Help overlay is UI-only.
- It does not execute commands.
- It does not mutate session history.
- It must not interfere with approval decisions.
- Non-TTY/plain mode unaffected.

## Implementation Order

1. Add `helpOverlay.ts` + pure tests.
2. Add help mode derivation helper.
3. Wire `helpOpen` state and `?` / `Esc` keys in `runTuiRepl`.
4. Render help overlay in the content window.
5. Manual smoke.

## Delegation Notes

Good split:

- Slice A: `helpOverlay.ts` + tests.
- Slice B: mode derivation helper + tests.
- Slice C: `runTuiRepl` wiring, reviewed in-house because it touches raw terminal I/O.

