# Phase 10A.6 — Yoga-Inspired TUI Layout MVP

## Context

Yoga is the C/C++ layout engine that implements Flexbox for React Native and many UI runtimes. Ink uses Yoga-style layout ideas so terminal components can declare boxes, rows, columns, flex growth, and alignment, then let the engine compute exact rectangles.

Deepcoder does not need the full Yoga engine for the first useful TUI. The current UI direction is pure, deterministic, dependency-light TypeScript: frame builders, transcript reducers, rich-text rendering, input editor, and diff-based redraw. Pulling in Yoga now would add a native dependency and a general-purpose layout model before the UI needs it.

What Deepcoder does need is the small part of Flexbox that makes a terminal UI easy to evolve:

- reserve fixed regions such as status bar and input composer;
- let the transcript viewport take remaining height;
- support vertical stacks and simple horizontal splits later;
- compute stable rectangles for overlays, patch review, worker review, and check output;
- keep layout pure and snapshot-testable.

## Decision

Do not add Yoga as a dependency in the MVP.

Implement a tiny Yoga-inspired layout solver in TypeScript:

- one-dimensional rows and columns;
- fixed size;
- flex grow;
- min/max constraints;
- gap;
- padding;
- optional alignment for content inside a rectangle.

This gives Deepcoder the useful Flexbox behavior without cloning Ink or taking on native layout complexity.

## Goals

- Make full TUI layout predictable and testable.
- Replace ad hoc `height - status - composer` math with named regions.
- Enable future panes without rewriting the renderer.
- Keep all layout computation pure and dependency-free.
- Avoid native modules and terminal-specific I/O inside the layout engine.

## Non-Goals

- No full CSS/Flexbox implementation.
- No Yoga dependency in this slice.
- No React component runtime.
- No arbitrary wrapping layout or percent-based responsive web layout.
- No mouse/drag resizing.
- No plugin widget system.

## MVP API

New file: `src/ui/layoutBox.ts`

```ts
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type LayoutDirection = "row" | "column";

export interface LayoutNode {
  id: string;
  direction?: LayoutDirection;
  fixedWidth?: number;
  fixedHeight?: number;
  flex?: number;
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
  gap?: number;
  padding?: number | { top?: number; right?: number; bottom?: number; left?: number };
  children?: LayoutNode[];
}

export interface LayoutResult {
  id: string;
  rect: Rect;
  children: LayoutResult[];
}

export function computeLayout(root: LayoutNode, rect: Rect): LayoutResult;
export function flattenLayout(result: LayoutResult): Map<string, Rect>;
```

Rules:

- `direction: "column"` stacks children top to bottom.
- `direction: "row"` stacks children left to right.
- Fixed sizes are allocated first.
- Remaining space is distributed by positive `flex` weights.
- Min/max constraints clamp each child.
- If the terminal is too small, later regions shrink to zero before producing negative sizes.
- Every returned rect uses integer terminal cells.
- The function never throws for normal malformed sizing; it clamps to safe output.
- Duplicate IDs are rejected by a validator used in tests and render setup.

## TUI Layout Tree

New file: `src/ui/tuiLayout.ts`

```ts
export interface TuiLayoutInput {
  width: number;
  height: number;
  composerHeight: number;
  overlayHeight?: number;
  showStatus: boolean;
}

export interface TuiRegions {
  status?: Rect;
  transcript: Rect;
  composer: Rect;
  overlay?: Rect;
}

export function computeTuiRegions(input: TuiLayoutInput): TuiRegions;
```

MVP region tree:

```text
root column
  status    fixed 1, optional
  transcript flex 1, min 0
  overlay   fixed N, optional
  composer  fixed composerHeight, min 1
```

Future side-pane tree:

```text
root column
  status fixed 1
  body row flex 1
    transcript flex 3
    sidePane flex 1 min 24
  composer fixed N
```

The future row split should be possible without changing block renderers.

## Rendering Integration

Update the full TUI renderer when it exists, or the minimal renderer if that remains the active entry point:

- compute regions once per frame;
- render transcript only into `regions.transcript`;
- render input composer only into `regions.composer`;
- render status only into `regions.status`;
- render approval/help/patch overlays into `regions.overlay`;
- compose region frames into one terminal-sized frame with clipping.

New helper: `src/ui/frameCanvas.ts`

```ts
export interface FrameCanvas {
  width: number;
  height: number;
  lines: string[];
}

export function createCanvas(width: number, height: number): FrameCanvas;
export function drawLines(canvas: FrameCanvas, rect: Rect, lines: readonly string[]): void;
```

`drawLines` clips safely. This prevents blocks from overwriting the composer or status bar.

## Why This Is Better Than Yoga Now

- Pure TypeScript: no native install or platform compatibility issues.
- Tiny API: tuned for terminal rows/columns, not web layout.
- Easy tests: no terminal, no DOM, no subprocess.
- Enough for Deepcoder's next UI: scrollback, status, composer, overlays, worker/check blocks.
- Future-compatible: if Deepcoder later needs full Flexbox, `LayoutNode` can be adapted to Yoga or replaced behind `computeLayout`.

## When To Reconsider Real Yoga

Consider adopting Yoga later only if Deepcoder needs at least two of:

- nested plugin-provided widgets with unknown layouts;
- complex side panes and adaptive dashboards;
- reusable component library with arbitrary nesting;
- alignment/wrapping behavior that starts duplicating CSS Flexbox;
- compatibility with an Ink-like component runtime.

Until then, the in-repo solver is lower risk.

## Files

New:

- `src/ui/layoutBox.ts`
- `src/ui/tuiLayout.ts`
- `src/ui/frameCanvas.ts`
- `test/adversarial/ui-layout-box.test.ts`
- `test/adversarial/ui-tui-layout.test.ts`
- `test/adversarial/ui-frame-canvas.test.ts`

Edit:

- `src/ui/minimalRenderer.ts` or the new full TUI renderer to use computed regions.
- `plans/ui/phase10a5-non-ink-tui-mvp-plan.md` only if a cross-reference is useful.

## Tests

No model, no terminal required.

Required cases:

1. Fixed status + fixed composer + flex transcript fills remaining height.
2. Very small terminal never produces negative rects.
3. Fixed children are allocated before flex children.
4. Flex weights split remaining space deterministically.
5. Min/max constraints clamp without exceeding parent bounds.
6. Gap and padding reduce available child space correctly.
7. Duplicate IDs are rejected by validation.
8. `drawLines` clips long and tall content to its rect.
9. Overlay region cannot overwrite composer.
10. Resize recomputes a different but valid region map.

## Acceptance

- `npm run typecheck` clean.
- `npm run test:phase` green.
- Layout tests prove all output rects are bounded by the terminal.
- A snapshot test shows the same transcript rendered at two terminal sizes without overlap.
- No new runtime dependency is added.

## Implementation Order

1. Add `layoutBox.ts` with pure row/column fixed/flex layout.
2. Add `frameCanvas.ts` clipping composer.
3. Add `tuiLayout.ts` named Deepcoder regions.
4. Add adversarial tests for sizing, clipping, and resize.
5. Wire the active renderer to `computeTuiRegions`.
6. Run typecheck and phase tests.

