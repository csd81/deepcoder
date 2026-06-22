# Phase 10A.8 — Slash Command Dropdown MVP

## Context

Deepcoder's TUI already has:

- fixed bottom composer
- scrollable transcript
- input history and multiline editing
- diff-based frame writer
- markdown rendering
- collapsible tool/check/worker blocks
- approval modal

But slash commands are still hard to discover. In TUI mode, the user has to remember commands
and type them manually. Worse, executing slash commands currently suspends the TUI to the normal
screen, so the experience does not feel like a modern Codex/Claude-style terminal interface.

This phase implements the smallest high-ROI slice: slash-command discovery and completion in
the bottom composer. It does not change command execution semantics.

## Goal

When the user types `/` in TUI mode, show a dropdown above the input line:

```text
╭ commands ─────────────────────────────────────────╮
│ /solve <check> <task>       Run closed-loop solve │
│ /check <name>               Run configured check  │
│ /delegate review <plan>     Review worker output  │
│ /web                        Show web status/trace │
╰───────────────────────────────────────────────────╯
> /de
```

MVP behavior:

- typing `/` opens the dropdown
- typing filters commands by prefix and aliases
- Up/Down changes selected command while menu is open
- Tab completes the selected command into the composer
- Enter submits normally
- Esc closes dropdown without clearing input
- dropdown is bounded and width-truncated
- no command execution changes

## Non-Goals

- No full native slash-command output rendering.
- No command argument forms or rich parameter picker.
- No mouse selection in v1.
- No changing `handleSlashCommand`.
- No executing a command from the dropdown without the existing submit path.
- No dependency on Ink, blessed, or readline UI libraries.

## Design

### 1. Slash Catalog

New file:

```text
src/cli/slashCatalog.ts
```

Exports:

```ts
export interface SlashCommandInfo {
  name: string;
  args?: string;
  description: string;
  category:
    | "session"
    | "context"
    | "checks"
    | "delegate"
    | "web"
    | "plugins"
    | "skills"
    | "config"
    | "debug";
  aliases?: string[];
}

export const SLASH_COMMANDS: readonly SlashCommandInfo[];
export function commandUsage(cmd: SlashCommandInfo): string;
export function filterSlashCommands(input: string, limit?: number): SlashCommandInfo[];
```

Initial catalog should cover the important commands already implemented in
`src/cli/slashCommands.ts`:

- `/exit`, `/quit`
- `/clear`
- `/usage`
- `/mode`
- `/todos`
- `/save`
- `/instructions`
- `/understand`
- `/semantic`
- `/plugins`
- `/web`
- `/solve`
- `/check`
- `/triage`
- `/delegate`
- `/skills`
- `/$<skill>`
- `/context-plan`
- `/explore`

Rules:

- catalog is metadata only
- `handleSlashCommand` remains source of execution truth
- unknown commands are not added for appearance
- descriptions are short enough to fit one line
- aliases are used only for filtering, not execution rewrites

### 2. Slash Menu State

New file:

```text
src/ui/slashMenu.ts
```

Types:

```ts
export interface SlashMenuState {
  open: boolean;
  query: string;
  selected: number;
  items: SlashCommandInfo[];
}

export type SlashMenuAction =
  | { type: "input"; text: string }
  | { type: "up" }
  | { type: "down" }
  | { type: "close" };
```

Functions:

```ts
export function updateSlashMenu(text: string, previous?: SlashMenuState): SlashMenuState;
export function moveSlashSelection(state: SlashMenuState, delta: number): SlashMenuState;
export function selectedSlashCompletion(state: SlashMenuState): string | null;
export function renderSlashMenu(state: SlashMenuState, width: number, maxRows?: number): string[];
```

Behavior:

- closed unless composer text starts with `/`
- query is current token after `/`
- selected index clamps to available items
- item list is capped, default 8
- render returns `[]` when closed or no items
- render never exceeds `width`
- output is stable/deterministic for tests

### 3. TUI Integration

Edit:

```text
src/cli/repl.ts
```

Minimal integration:

- keep a local `slashMenu` state in `runTuiRepl`
- after any editor text change, recompute `slashMenu`
- layout reserves dropdown rows above the composer when menu is open
- Up/Down:
  - if slash menu open: move selection
  - otherwise existing history behavior
- Tab:
  - if slash menu open: complete selected command
  - otherwise existing collapsible block focus behavior
- Esc:
  - if slash menu open: close it
  - otherwise existing clear-selection behavior
- Enter:
  - submit exactly the current composer text

Completion behavior:

If selected item is `/delegate` with args `<subcommand> ...`, completion should insert:

```text
/delegate 
```

not the whole placeholder. For `/$<skill>` it should insert:

```text
/$
```

Use a trailing space for normal commands so users can keep typing arguments.

### 4. Renderer Integration

Edit:

```text
src/ui/minimalRenderer.ts
```

Add optional field:

```ts
slashMenuLines?: string[];
```

Frame order:

```text
status
transcript viewport
new-output indicator
slash menu lines
composer lines
```

The transcript height must shrink by `slashMenuLines.length` so the dropdown never overlaps
the composer or spills below the terminal.

If the terminal is too short:

- prefer showing status + composer
- cap menu to remaining rows
- show fewer transcript rows

### 5. Styling

Use existing theme:

- menu border/title dim
- selected row highlighted with `theme.selected`
- command usage bold/title
- description dim

Plain/no-color mode should remain readable.

## Tests

New:

```text
test/adversarial/slash-catalog.test.ts
test/adversarial/ui-slash-menu.test.ts
```

Extend:

```text
test/adversarial/ui-minimal-renderer.test.ts
```

Cases:

- catalog includes expected high-value commands
- `filterSlashCommands("/")` returns bounded top commands
- `/de` returns delegate commands before unrelated commands
- aliases match where defined
- no duplicates in catalog
- `updateSlashMenu("not slash")` closes
- `updateSlashMenu("/")` opens
- selection clamps on up/down
- Tab completion returns command name with trailing space
- `/$` completion is preserved
- render is bounded by width
- render caps rows
- renderer reserves space for dropdown above composer
- narrow terminal output does not exceed width

No live model required.

## Acceptance

- `npm run typecheck`
- `npm run test:phase`
- manual smoke:

```bash
npm run dev -- --tui
```

Smoke checklist:

- type `/` -> dropdown appears above bottom input
- type `/de` -> delegate command appears
- Up/Down changes highlighted command
- Tab completes command
- Esc hides dropdown
- Enter submits completed command through existing slash handler
- normal Up/Down history still works when dropdown is closed
- Tab still focuses collapsible blocks when dropdown is closed
- terminal restores cleanly on Ctrl+C

## Safety

- Dropdown never executes anything by itself.
- Existing slash handler remains authoritative.
- Existing approval/sandbox/delegate gates remain unchanged.
- Non-TTY/plain mode unaffected.
- No new dependencies.

## Implementation Order

1. Add `src/cli/slashCatalog.ts` + tests.
2. Add `src/ui/slashMenu.ts` + tests.
3. Extend `renderFrame` to accept/dropdown menu lines + renderer tests.
4. Wire menu state/actions into `runTuiRepl`.
5. Manual smoke in TUI.

## Delegation Notes

This is a good delegated-worker task if split:

- Slice A: `slashCatalog.ts` + tests.
- Slice B: `slashMenu.ts` + tests.
- Slice C: renderer + `runTuiRepl` wiring, reviewed in-house because it touches terminal I/O.

