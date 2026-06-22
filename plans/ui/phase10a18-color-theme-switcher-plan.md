# Phase 10A.18 — Color Theme Switcher

## Context

Deepcoder's TUI has a small semantic theme layer:

- `dim`
- `success`
- `error`
- `warning`
- `title`
- `selected`

Color support already respects:

- `FORCE_COLOR`
- `NO_COLOR`
- TTY detection

But there is only one built-in color palette. As the TUI becomes more polished, users should
be able to choose a theme that fits their terminal, accessibility needs, and personal
preference.

## Goal

Add named color themes with a runtime switcher:

```text
/theme
/theme list
/theme set default
/theme set high-contrast
/theme set muted
/theme set monochrome
```

Environment/config:

```text
DEEPCODER_THEME=default|high-contrast|muted|monochrome
DEEPCODER_UI_COLOR=auto|on|off
```

Requirements:

- no-color mode still emits zero ANSI
- themes are semantic, not hard-coded in individual renderers
- switching theme in TUI repaints without restarting
- unknown theme names fail clearly and keep current theme

## Non-Goals

- No full user-defined theme file format in v1.
- No truecolor/RGB requirement.
- No dependency on chalk/ink/blessed.
- No per-language syntax theme selection in v1.
- No theme marketplace/plugin system in this slice.

## Design

### 1. Theme Palette Types

Edit:

```text
src/ui/theme.ts
```

Add:

```ts
export type ColorMode = "auto" | "on" | "off";
export type ThemeName = "default" | "high-contrast" | "muted" | "monochrome";

export interface ThemePalette {
  name: ThemeName;
  dim: [on: number, off: number];
  success: [on: number, off: number];
  error: [on: number, off: number];
  warning: [on: number, off: number];
  title: [on: number, off: number];
  selected: [on: number, off: number];
  // optional future fields:
  searchMatch?: [on: number, off: number];
  status?: [on: number, off: number];
}
```

Keep the public `Theme` interface semantic:

```ts
export interface Theme {
  name: ThemeName;
  color: boolean;
  dim: (s: string) => string;
  success: (s: string) => string;
  error: (s: string) => string;
  warning: (s: string) => string;
  title: (s: string) => string;
  selected: (s: string) => string;
}
```

### 2. Built-In Themes

Initial built-ins:

#### `default`

Current behavior:

- success green
- error red
- warning yellow
- title bold
- selected reverse
- dim faint

#### `high-contrast`

For readability:

- title bold + bright white
- selected reverse + bold
- error bright red + bold
- warning bright yellow
- success bright green
- dim normal grey if supported, not faint-only

#### `muted`

Quieter daily-use palette:

- fewer bright colors
- title bold only
- success green
- warning yellow/dim
- error red
- selected reverse

#### `monochrome`

Still uses ANSI style, but no hue:

- title bold
- selected reverse
- dim faint
- success plain/bold
- error bold/underline if available
- warning bold

This is different from `NO_COLOR`: monochrome may use style SGR, `NO_COLOR` emits none.

### 3. Color Mode Resolution

Replace `resolveColorEnabled` with a richer resolver while preserving compatibility:

```ts
export interface ThemeResolveInput {
  env: Record<string, string | undefined>;
  isTTY: boolean;
  themeName?: string;
  colorMode?: string;
}

export interface ResolvedThemeChoice {
  color: boolean;
  themeName: ThemeName;
  colorMode: ColorMode;
  warnings: string[];
}
```

Precedence:

1. `DEEPCODER_UI_COLOR=off|on|auto`
2. `FORCE_COLOR`
3. `NO_COLOR`
4. TTY auto

Theme precedence:

1. explicit runtime `/theme set`
2. `.deepcoder/config.json` if added later
3. `DEEPCODER_THEME`
4. `default`

Compatibility:

- keep `resolveColorEnabled` exported as a wrapper for existing tests/callers
- keep `createTheme(color)` working by defaulting to `default`

New helper:

```ts
export function createTheme(opts: boolean | { color: boolean; name?: ThemeName }): Theme;
```

If overloading is too messy, add `createNamedTheme(name, color)` and keep `createTheme(color)`.

Recommended: add `createNamedTheme`, keep `createTheme` stable.

### 4. Config / Env

Optional config shape:

```json
{
  "ui": {
    "theme": "default",
    "color": "auto"
  }
}
```

If config UI block does not exist yet, v1 can be env + runtime only:

```text
DEEPCODER_THEME=high-contrast
DEEPCODER_UI_COLOR=auto
```

Recommended MVP:

- env support first
- runtime `/theme set` affects current session only
- config persistence follow-up

### 5. Slash Command

Extend slash commands:

```text
/theme
/theme list
/theme set <name>
/theme color auto|on|off
```

Behavior:

- `/theme` shows current theme and color mode
- `/theme list` shows built-ins
- `/theme set high-contrast` changes current TUI theme immediately
- `/theme color off` disables ANSI immediately

Plain mode:

- prints result normally
- no live repaint concept

TUI mode:

- updates local `theme`
- clears previous frame baseline
- redraws
- appends a notice block

### 6. TUI Runtime State

Current `runTuiRepl` creates:

```ts
const theme: Theme = createTheme(resolveColorEnabled(...));
```

Change to:

```ts
let theme = resolveThemeFromEnv(...);
```

Because runtime theme can change, it must be `let`.

When theme changes:

- set `prevFrame = []`
- call `redraw()`

### 7. Renderer Discipline

All UI code should use semantic theme functions. Do not introduce direct SGR codes outside:

- `theme.ts`
- syntax highlighter if already isolated
- diff renderer if already isolated

Search/mouse/help/status future styles should be added as semantic fields, not hard-coded.

## Files

New:

- `test/adversarial/ui-theme-switcher.test.ts`

Edited:

- `src/ui/theme.ts`
- `src/cli/repl.ts`
- `src/cli/slashCommands.ts`
- possibly `src/config/config.ts` if adding config UI block now
- `test/adversarial/ui-theme.test.ts`

## Tests

Theme core:

- `createTheme(false)` remains identity/no ANSI
- `createNamedTheme("default", true)` preserves current styles
- all built-in themes expose every semantic style
- unknown theme name falls back with warning or refuses
- `NO_COLOR` disables ANSI even with theme set
- `FORCE_COLOR=1` enables ANSI in non-TTY
- `DEEPCODER_UI_COLOR=off` wins over `FORCE_COLOR`
- `DEEPCODER_UI_COLOR=on` enables ANSI unless `NO_COLOR` policy is intentionally stronger
- `monochrome` uses no hue codes if feasible

Slash command:

- `/theme list` includes all built-ins
- `/theme set high-contrast` updates session/TUI theme state
- `/theme set nope` refuses and keeps previous theme
- `/theme color off` disables ANSI for future frames

TUI:

- changing theme invalidates frame diff baseline
- redraw output changes under high-contrast
- no-color output has no SGR

## Acceptance

- `npm run typecheck`
- `npm run test:phase`
- manual smoke:

```bash
npm run dev -- --tui
```

Smoke checklist:

- `DEEPCODER_THEME=high-contrast npm run dev -- --tui` starts in high contrast
- `/theme list` shows built-ins
- `/theme set muted` repaints immediately
- `/theme color off` removes ANSI styling
- `NO_COLOR=1` still forces no ANSI
- terminal remains clean after switching repeatedly

## Safety

- UI-only feature.
- No model/tool/check behavior changes.
- No provider calls.
- No filesystem writes in MVP.
- No ANSI emitted under no-color mode.
- Unknown theme never crashes the TUI.

## Implementation Order

1. Extend `theme.ts` with named palettes while preserving existing API.
2. Add theme resolution tests.
3. Wire env theme selection into TUI creation.
4. Add `/theme` slash command.
5. Add runtime theme switching in TUI.
6. Manual smoke.

## Follow-Ups

- Persist preferred theme in `.deepcoder/config.json`.
- User-defined custom theme file.
- 24-bit truecolor palettes.
- Per-syntax theme integration.
- Theme preview screen.

## Delegation Notes

Good split:

- Slice A: named palettes + tests.
- Slice B: env/theme resolution + tests.
- Slice C: `/theme` command + TUI repaint wiring, reviewed in-house because it touches UI
  runtime state.

