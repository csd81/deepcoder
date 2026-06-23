# UI Assessment — TODO / Backlog

Findings from a UI assessment of the Deepcoder terminal UI (custom hand-rolled
TUI: diff-based rendering, pure modules, ~94% module test coverage). Ordered by
priority. Items 1–4 are concrete cleanups; 5–6 are polish/coverage.

## 1. No CJK / grapheme width awareness — ✅ FIXED

~~`visibleWidth()` counts code points, not display columns; CJK/emoji misalign
layout and truncation can split a grapheme.~~

**Done.** Added a pure, zero-dep wcwidth-style width module
`src/ui/charWidth.ts` (`charWidth` / `displayWidth`): East-Asian-wide +
fullwidth + emoji = 2 columns, combining / zero-width / control = 0, SGR codes
ignored, surrogate pairs counted once. Routed all width-sensitive code through
it:
- `minimalRenderer.visibleWidth` → `displayWidth`; `truncate` now measures
  display columns, never splits a surrogate pair, and drops a wide char that
  would straddle the limit.
- `textLayout.wrapLine` wraps by display columns (hard-split is width-aware).
- `table.ts` header sizing, cell padding, and `truncateToWidth` all width-aware,
  so box borders line up around CJK content.

Tests: `test/adversarial/ui-char-width.test.ts` (17) + 2 new CJK cases in
`test/table.test.ts`. Full suite green (1867 pass). The status bar already routes
through `truncate`, so it inherits the fix.

## 2. `repl.ts` is a monolithic orchestrator

`src/cli/repl.ts` (~2,028 lines, 88 imports) drives every UI subsystem and the
event loop. The pure modules mitigate it (logic stays testable), but adding any
new pane/element means editing frame-layout arithmetic in this one file.

The "no red flags" vs "god object" verdicts are both right at different
altitudes: *logic* is well-factored into pure modules; *orchestration* is
centralized. Worth extracting the frame-layout assembly and per-subsystem wiring
into smaller units so new UI elements don't require touching the core loop.

## 3. `slashCommands.ts` is 3,939 lines in one file

`src/cli/slashCommands.ts` — justifiable for fast iteration, but a navigation
tax. Obvious cleanup: split by domain (e.g. `slashSessions.ts`, `slashGit.ts`,
`slashWeb.ts`) behind the existing dispatch.

## 4. Unbounded input queue

`createInputQueue()` (`src/cli/inputQueue.ts`) has no max depth; a stalled event
loop could accumulate keystrokes unbounded. Low likelihood, but worth a cap
(drop-oldest or bounded backpressure).

## 5. Discoverability gaps

- Slash menu caps at 8 visible of ~60 commands with no category view.
- `@`-mention has no live dropdown (parser-only); completion isn't surfaced
  while typing.
- Policy-denied `!`bang commands don't show *why* (which classifier rule fired).
- Plan-mode phase isn't always reflected in the footer.

## 6. Test coverage holes

- `src/ui/diffSummary.ts` and `src/ui/table.ts` are only tested indirectly (via
  approvalReview tests). Add dedicated unit tests.
- Note: zero TODO/FIXME markers across the UI — a good sign of finish.
