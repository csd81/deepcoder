# Feature — Raw scrollback mode (`/raw`)

## Context

Deepcoder's output uses ANSI escape codes (chalk styling, syntax highlighting, box-drawing). Copying formatted terminal output often captures invisible escape sequences, producing garbled text. Both Claude Code and Codex CLI have `/raw` to toggle unformatted output for easier selection and copying.

The rendering pipeline is centralized: `plainRenderer.ts` for non-TUI mode and `minimalRenderer.ts`/`transcript.ts` for TUI mode. A single toggle strips ANSI codes from all output.

## Model

- `/raw` — toggle raw mode on/off. When on, all output is plain text: no chalk colors, no syntax highlighting, no box-drawing characters, no ANSI escape codes.
- `/raw on` and `/raw off` for explicit control.
- Persisted to session state (not config) — raw mode is per-terminal, not per-project.
- The TUI statusline shows a `[raw]` indicator when active.
- No effect on how the agent works — purely a rendering change.

## Design

### 1. Raw mode helper (`src/ui/rawMode.ts`)

```ts
import stripAnsi from "strip-ansi"; // or hand-roll a simple ANSI regex

export function renderRaw(text: string): string {
  // Strip ANSI escape codes: colors, bold, dim, underline, box-drawing
  return stripAnsi(text);
}

export function lineWidth(raw: boolean, text: string): number {
  return raw ? renderRaw(text).length : text.length;
}
```

A hand-rolled ANSI strip is ~10 lines if `strip-ansi` isn't already a dependency:

```ts
const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
export function renderRaw(text: string): string {
  return text.replace(ANSI_RE, "");
}
```

### 2. Renderer integration (`src/ui/plainRenderer.ts`)

Add a `raw` flag. When true, strip ANSI codes before writing:

```ts
export function createPlainRenderer(opts: {
  write: (s: string) => void;
  renderAssistant?: (text: string) => string[];
  raw?: boolean;                      // NEW
}): { emit(event: UiEvent): void; endTurn(): void } {
  const write = opts.raw ? (s: string) => opts.write(renderRaw(s)) : opts.write;
  // … use `write` instead of `opts.write` everywhere …
```

Also strip ANSI from the `renderAssistant` output:

```ts
if (opts.raw && render) {
  const origRender = render;
  render = (text: string) => origRender(text).map(renderRaw);
}
```

### 3. TUI integration (`src/ui/minimalRenderer.ts` or transcript layer)

In the TUI frame builder, when raw mode is on:
- Skip syntax highlighting in code blocks.
- Strip ANSI from status bar and content lines.
- Replace box-drawing characters with ASCII equivalents (or just strip them).

Add to `FrameInput`:

```ts
export interface FrameInput {
  // … existing fields …
  raw?: boolean;
}
```

In `renderFrame`, when `raw` is true, apply `renderRaw` to each output line before truncation.

### 4. Slash command + session state (`src/cli/slashCommands.ts`)

```ts
case "raw": {
  const trimmed = arg.trim().toLowerCase();
  if (trimmed === "on") session.rawMode = true;
  else if (trimmed === "off") session.rawMode = false;
  else session.rawMode = !session.rawMode; // toggle
  console.log(chalk.dim(`Raw mode ${session.rawMode ? "on" : "off"}.`));
  return { consumed: true };
}
```

Add `rawMode?: boolean` to the session object in `repl.ts` and pass it through when creating renderers.

### 5. Statusline indicator

In the TUI status bar, append `[raw]` when `session.rawMode` is true:

```ts
const rawIndicator = session.rawMode ? " [raw]" : "";
statusLine += rawIndicator;
```

### 6. Non-TUI plain mode

In `runRepl` (non-TUI path), pass `raw: session.rawMode` to `createPlainRenderer`.

### 7. Persistence

`rawMode` is session-level state (like todos or read tracker), not config. It's not persisted across sessions — it resets on each start. This avoids config complexity for a rendering convenience.

## Files

- **New:** `src/ui/rawMode.ts`, `test/raw-mode.test.ts`.
- **Edit:** `src/cli/slashCommands.ts` (add `case "raw"`), `src/cli/slashCatalog.ts` (add entry), `src/cli/repl.ts` (thread `rawMode` to renderers), `src/ui/plainRenderer.ts` (raw output path), `src/ui/minimalRenderer.ts` (raw frame building), `src/ui/statusBar.ts` or statusline ([raw] indicator).

## Tests

- `renderRaw` strips ANSI: `"\u001b[31mhello\u001b[0m"` → `"hello"`.
- `renderRaw` leaves plain text unchanged.
- `renderRaw` strips box-drawing and other escape sequences.
- Plain renderer with `raw: true` emits no ANSI codes.
- Toggle: `/raw` flips from off→on→off.

## Verification

1. `npm run typecheck` clean; `npm run test:phase` green.
2. Manual: start deepcoder, `/raw on` → output has no colors or styling. Select and copy text — no escape codes. `/raw off` → styling restored.
3. TUI statusline shows `[raw]` when active.

## Safety

- Rendering-only change. No effect on the agent loop, permissions, file I/O, or git operations.
- `rawMode` is per-session and not persisted — no config migration or compatibility concerns.
- Stripping ANSI is purely cosmetic — no data is altered or lost.
