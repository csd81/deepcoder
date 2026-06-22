# Feature — Keybind customization

## Context

Deepcoder's TUI has hardcoded keybindings. OpenCode integrates `@opentui/keymap` for user-configurable keybinds. This would let users customize shortcuts like Tab, Enter, Escape, Ctrl+C behavior to match their terminal habits.

## Model

- Keybinds are configured in `.deepcoder/config.json` under a `keybinds` block.
- Each bind maps a key chord (e.g. `"ctrl+shift+p"`) to an action (e.g. `"toggle-plan-mode"`).
- Built-in defaults match the current hardcoded behavior — config overrides selectively.
- `/keymap` shows the current effective keybinding table.
- Only affects the TUI — plain REPL mode is unaffected.

## Design

### 1. Config (`src/config/fileConfig.ts`)

```ts
export type KeybindAction =
  | "submit"
  | "cancel"
  | "focus-composer"
  | "toggle-plan-mode"
  | "scroll-up"
  | "scroll-down"
  | "page-up"
  | "page-down"
  | "autocomplete"
  | "close-dropdown";

export interface KeybindsConfig {
  [key: string]: KeybindAction;  // e.g. "ctrl+p" → "scroll-up"
}

export interface FileConfig {
  // …
  keybinds?: KeybindsConfig;
}
```

### 2. Keybind resolution (`src/ui/keybinds.ts`)

```ts
const DEFAULTS: KeybindsConfig = {
  "enter": "submit",
  "escape": "cancel",
  "ctrl+c": "cancel",
  "tab": "toggle-plan-mode",
  "ctrl+p": "scroll-up",
  "ctrl+n": "scroll-down",
  "ctrl+u": "page-up",
  "ctrl+d": "page-down",
  "ctrl+space": "autocomplete",
  "escape": "close-dropdown",
};

export function resolveKeybinds(file: KeybindsConfig | undefined): KeybindsConfig {
  return { ...DEFAULTS, ...file };
}

export function actionForKey(keybinds: KeybindsConfig, event: { ctrl?: boolean; alt?: boolean; shift?: boolean; key: string }): KeybindAction | null {
  const chord = buildChord(event);
  return keybinds[chord] ?? null;
}
```

### 3. Wire into TUI (`src/ui/inputEditor.ts` or the key handler in `repl.ts`)

Replace hardcoded key checks with `actionForKey(resolvedKeybinds, event)`. The TUI's key event handler currently has branches like:

```ts
if (key === "enter") { /* submit */ }
if (key === "escape") { /* cancel */ }
```

Replace with:

```ts
const action = actionForKey(keybinds, event);
if (action === "submit") { /* submit */ }
else if (action === "cancel") { /* cancel */ }
// …
```

### 4. Slash command

```ts
case "keymap": {
  const k = resolveKeybinds(config.keybinds);
  for (const [chord, action] of Object.entries(k)) {
    console.log(`  ${chalk.bold(chord.padEnd(16))} ${action}`);
  }
  return { consumed: true };
}
```

## Files

- **New:** `src/ui/keybinds.ts`, `test/keybinds.test.ts`.
- **Edit:** `src/config/fileConfig.ts` (add `keybinds` schema), `src/config/config.ts` (add to `Config`), `src/ui/inputEditor.ts` or TUI key handler (use resolved keybinds), `src/cli/slashCommands.ts` (`case "keymap"`), `src/cli/slashCatalog.ts`.

## Tests

- `resolveKeybinds(undefined)` → returns defaults.
- `resolveKeybinds({ "ctrl+p": "cancel" })` → overrides that action.
- `actionForKey(defaults, { key: "enter" })` → `"submit"`.
- `actionForKey(defaults, { key: "p", ctrl: true })` → `"scroll-up"`.
- Unknown chord → `null`.

## Safety

- Config is parsed and validated — malformed keybinds fall back to defaults.
- No new I/O or permission surface — purely a UI mapping change.
