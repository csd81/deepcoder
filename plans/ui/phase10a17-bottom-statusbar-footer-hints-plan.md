# Phase 10A.17 — Bottom Status Bar and Footer Hints

## Context

Deepcoder's TUI currently renders the status bar at the top of the alternate screen. The bottom
area is only the composer. Modern Codex/Claude-style terminal UIs put the most actionable
state near the input area:

- current mode
- model/provider
- sandbox/isolation
- branch/dirty state
- token/cost/context usage
- active check/worker status
- contextual key hints

Moving status to the bottom makes the screen feel more like a focused chat/work surface:

```text
transcript / output
...
> input composer
Enter send · / commands · Ctrl+F search · ? help
deepcoder · deepseek/v4-flash · sandbox fast · master* · 42k ctx · $0.03
```

This phase moves status from top to bottom and adds contextual footer hints.

## Goal

Replace the top status bar with a bottom status region:

```text
┌ transcript/output area ───────────────────────────────────────────────┐
│ ...                                                                   │
├ composer ─────────────────────────────────────────────────────────────┤
│ > user input                                                          │
│ Enter send · / commands · Ctrl+F search · ? help                      │
│ deepcoder · model · sandbox · branch · ctx · cost · web · running     │
└───────────────────────────────────────────────────────────────────────┘
```

Requirements:

- status moves from top to bottom
- footer hints change by current context
- status and hints are width-bounded
- transcript height accounts for bottom rows
- non-TTY/plain mode unaffected

## Non-Goals

- No new telemetry collection.
- No model/tool/check behavior changes.
- No full TUI redesign.
- No click targets in the status bar in this phase.
- No dependency on Ink/blessed.

## Design

### 1. Status Bar Renderer

New file:

```text
src/ui/statusBar.ts
```

Types:

```ts
export interface TuiStatusInput {
  appName: string;
  mode?: string;
  provider?: string;
  model?: string;
  sandbox?: string;
  isolation?: string;
  branch?: string;
  dirty?: boolean;
  tokens?: string;
  cost?: string;
  context?: string;
  webEnabled?: boolean;
  activeCheck?: string;
  activeWorkers?: number;
  busy?: boolean;
}
```

Exports:

```ts
export function renderBottomStatus(input: TuiStatusInput, opts: { width: number; theme: Theme }): string;
```

Segment rules:

- omit unknown values
- keep `deepcoder` leftmost
- model segment: `<provider>/<model>` truncated if long
- dirty branch: `master*`
- sandbox: `sandbox fast`
- isolation: `iso patch` or omitted if off
- web: `web on` / `web off`
- busy: `running`
- active check: `check phase`
- active workers: `workers 2`

Example:

```text
deepcoder · auto · deepseek/deepseek-v4-flash · sandbox fast · master* · 42k ctx · ~$0.03 · running
```

### 2. Footer Hints Renderer

New file:

```text
src/ui/footerHints.ts
```

Types:

```ts
export type FooterHintMode =
  | "normal"
  | "busy"
  | "slash-menu"
  | "search"
  | "focused-block"
  | "approval";

export interface FooterHintInput {
  mode: FooterHintMode;
  width: number;
  theme: Theme;
}
```

Exports:

```ts
export function renderFooterHints(input: FooterHintInput): string;
```

Hints:

Normal:

```text
Enter send · / commands · Ctrl+F search · Tab blocks · ? help
```

Busy:

```text
PgUp/PgDn scroll · Tab inspect · Ctrl+C interrupt · ? help
```

Slash menu:

```text
↑↓ select · Tab complete · Enter run · Esc close
```

Search:

```text
Enter/n next · p previous · PgUp/PgDn scroll · Esc close
```

Focused block:

```text
Enter expand · y copy · s save · Tab next · Esc clear
```

Approval:

```text
y approve · n deny · ↑↓ scroll · Esc deny
```

### 3. Frame Layout Change

Current `renderFrame` order:

```text
status
transcript viewport
new-output indicator
composer
```

New order:

```text
transcript viewport
new-output indicator
composer
footer hints
bottom status
```

Update `FrameInput`:

```ts
export interface FrameInput {
  lines: string[];
  viewportTop: number;
  height: number;
  width: number;
  inputLine: string;
  inputLines?: string[];
  hasNewOutputBelow: boolean;
  footerHintLine?: string;
  statusLine?: string;
}
```

Backward compatibility:

- tests should be updated; the status line is no longer first
- if `footerHintLine` or `statusLine` is omitted, render fewer bottom rows

### 4. TUI Layout Update

Current layout tree in `runTuiRepl`:

```text
status fixed 1
transcript grow
indicator fixed 1
composer fixed N
```

New layout:

```text
transcript grow
indicator fixed 1
composer fixed N
footer fixed 1
status fixed 1
```

`viewportH` must subtract composer rows + footer/status rows.

When future overlays are open:

- slash menu/activity/search/help rows must also subtract from transcript height
- this plan should define the status/footer rows as always bottom-fixed

### 5. TUI State Inputs

In `runTuiRepl`, build status from:

- `session.mode`
- `session.config.provider`
- `session.config.model`
- `session.config.sandbox.mode`
- `session.config.workspaceIsolation?.mode` if available
- `session.config.web.enabled`
- `busy`
- `transcript.status.activeCheck`
- session telemetry/token usage if cheap and already available

Git branch/dirty:

- do not shell out on every redraw
- use existing status snapshot if already available
- otherwise omit in MVP

Cost/context:

- use existing telemetry if already present
- omit if unknown

### 6. Context Mode Detection

Footer hints need current UI mode:

Priority:

1. approval
2. search
3. slash-menu
4. focused-block
5. busy
6. normal

If not all features are implemented yet, the helper can still support future modes and current
code can pass only `normal`, `busy`, `focused-block`, and `approval`.

## Files

New:

- `src/ui/statusBar.ts`
- `src/ui/footerHints.ts`
- `test/adversarial/ui-status-bar.test.ts`
- `test/adversarial/ui-footer-hints.test.ts`

Edited:

- `src/ui/minimalRenderer.ts`
- `src/cli/repl.ts`
- `test/adversarial/ui-minimal-renderer.test.ts`

## Tests

Status bar:

- renders known segments in stable order
- omits unknown segments
- marks dirty branch with `*`
- includes busy/running state
- width-bounds long model names
- no-color output has no ANSI

Footer hints:

- normal hints include send/slash/search/help
- busy hints include interrupt
- focused-block hints include expand/copy/save
- approval hints include approve/deny
- slash/search modes render expected hints
- width-bounded

Frame renderer:

- no status at top anymore
- composer appears before footer/status
- footer is second-to-last when status present
- status is last when present
- transcript viewport height is respected
- output lines do not exceed width

TUI layout:

- transcript height subtracts footer/status rows
- resize recomputes bottom layout

## Acceptance

- `npm run typecheck`
- `npm run test:phase`
- manual smoke:

```bash
npm run dev -- --tui
```

Smoke checklist:

- top of screen starts with transcript/content, not status
- input remains near bottom
- footer hints appear below composer
- bottom status appears below hints
- status updates when running/busy
- focused block changes footer hints
- approval modal changes footer hints
- narrow terminal truncates cleanly
- no overlap between transcript, composer, footer, and status

## Safety

- UI-only rendering/layout change.
- No command/model/tool/check behavior changes.
- No shelling out during redraw.
- Non-TTY/plain mode unaffected.
- Terminal restore behavior unchanged.

## Implementation Order

1. Add `statusBar.ts` + tests.
2. Add `footerHints.ts` + tests.
3. Change `renderFrame` order to bottom status/footer.
4. Update `ui-minimal-renderer` tests.
5. Wire status/footer generation in `runTuiRepl`.
6. Manual smoke.

## Delegation Notes

Good split:

- Slice A: `statusBar.ts` + tests.
- Slice B: `footerHints.ts` + tests.
- Slice C: frame layout + `runTuiRepl` integration, reviewed in-house because it changes
  screen geometry.

