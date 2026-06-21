# Phase 10A.4 — Terminal-Friendly Markdown Renderer and Code Syntax Highlighting

## Context

Phase 10A has a pure TUI core and minimal renderer: transcript events reduce into blocks, and
`renderFrame` produces deterministic frame lines with no terminal I/O, ANSI, or dependencies. This
is the right foundation for a robust Codex/Claude-style terminal UI, but assistant output is still
treated mostly as plain text.

LLM output is usually Markdown: headings, bullets, numbered lists, inline code, fenced code blocks,
diffs, links, and occasional tables. The TUI should render this cleanly in a terminal without trying
to become a full browser or CommonMark engine.

This phase adds a terminal-friendly Markdown renderer and lightweight syntax highlighting for code
blocks. It stays pure/testable and dependency-free by default.

## Goals

- Render common Markdown from assistant output into readable terminal lines.
- Preserve code blocks exactly enough that code remains copyable and trustworthy.
- Add lightweight syntax highlighting for common languages and diffs.
- Respect terminal width, color capability, `NO_COLOR`, and snapshot-test determinism.
- Keep all rendering pure: Markdown/text in, styled line model out.
- Avoid introducing a heavy Markdown parser dependency in the first pass.

## Non-goals

- No full CommonMark compliance.
- No HTML rendering.
- No image rendering.
- No link preview fetching.
- No interactive table/grid widget.
- No semantic code parser or tree-sitter in this phase.
- No mutation of transcript source text.

## Rendering Model

Add a richer intermediate line model instead of embedding ANSI early:

`src/ui/richText.ts`

```ts
export type UiStyle =
  | "normal"
  | "dim"
  | "bold"
  | "italic"
  | "code"
  | "heading"
  | "link"
  | "success"
  | "warning"
  | "error"
  | "diffAdd"
  | "diffRemove"
  | "diffMeta"
  | "keyword"
  | "string"
  | "number"
  | "comment";

export interface RichSpan {
  text: string;
  style?: UiStyle;
}

export interface RichLine {
  spans: RichSpan[];
  hardBreak?: boolean;
}
```

Pipeline:

```text
Markdown string
  -> MarkdownBlock[]
  -> RichLine[]
  -> wrapRichLines(width)
  -> applyTheme(theme, colorMode)
  -> frame lines
```

For non-color snapshot tests, `applyTheme` can be disabled so expected frames are stable.

## Markdown Support

New module:

`src/ui/markdown.ts`

Supported v1 constructs:

- paragraphs
- ATX headings: `#`, `##`, `###`
- unordered lists: `-`, `*`, `+`
- ordered lists: `1.`, `2.`
- nested list indentation preserved up to a cap
- blockquotes: `>`
- fenced code blocks: triple backticks or tildes, language tag captured
- indented code blocks only if unambiguous
- inline code: backticks
- Markdown links: `[text](url)` rendered as `text (url)` or styled text + dim URL
- horizontal rules as a dim separator
- simple tables preserved as monospace text, not reflowed

Unsupported constructs are rendered as plain text.

## Code Block Rendering

Code block rules:

- Preserve line order and indentation.
- Do not paragraph-wrap code by default.
- Clip long code lines to viewport width with a visible continuation marker.
- Optional horizontal scroll can be a later phase.
- Show a compact header when language is present:

```text
```ts
```

renders as:

```text
╭─ ts
│ const x = 1;
╰─
```

In no-border mode or narrow terminals, degrade to:

```text
[ts]
  const x = 1;
```

## Syntax Highlighting

New module:

`src/ui/syntax.ts`

Dependency-free token highlighter with regex rules. This is intentionally shallow and safe.

Supported languages:

- `ts`, `tsx`, `js`, `jsx`, `mjs`, `cjs`
- `json`
- `python`, `py`
- `bash`, `sh`
- `diff`, `patch`
- `markdown`, `md`
- fallback plaintext

Highlight categories:

- keywords
- strings
- numbers
- comments
- diff add/remove/meta lines

Rules:

- Never changes text content.
- Never drops characters.
- Never throws on malformed input.
- Line length and number of highlighted lines are capped.
- Regexes must be linear enough to avoid catastrophic backtracking.

## Theme and ANSI

New module:

`src/ui/theme.ts`

```ts
export interface UiTheme {
  color: boolean;
  styles: Record<UiStyle, { open: string; close: string }>;
}
```

Color detection:

- no color when `NO_COLOR` is set;
- force color when `FORCE_COLOR` is set;
- otherwise color only for TTY-ish output;
- tests can pass `color:false`.

Use simple ANSI sequences, no dependency.

Example mapping:

- heading: bold
- dim: gray
- code: cyan
- success/diffAdd: green
- error/diffRemove: red
- warning: yellow
- keyword: magenta/blue
- string: green
- comment: dim

## Integration with Transcript Renderer

Assistant blocks should render through Markdown by default:

- `kind: assistant` -> Markdown renderer
- `kind: tool` -> plain/preformatted renderer unless output declares markdown later
- `kind: check` -> preformatted/log renderer
- `kind: notice` -> plain wrapped text
- `kind: approval` -> diff/code renderer

Add a display hint field only if needed:

```ts
display?: "markdown" | "plain" | "log" | "diff";
```

Avoid storing rendered lines in transcript state; render from source body so width/theme changes can re-render correctly.

## Wrapping and Width

New module:

`src/ui/wrapRich.ts`

Rules:

- Prose wraps on spaces.
- Inline styles preserve spans across wraps.
- Code blocks clip or hard-wrap based on config; default clip.
- ANSI sequences are not counted as columns because wrapping happens before ANSI application.
- Unicode width can remain approximate in v1; document this limitation.

## Configuration

Add UI config fields:

```ts
export interface UiConfig {
  markdown?: boolean;
  syntaxHighlighting?: boolean;
  color?: "auto" | "on" | "off";
  codeBlockBorders?: boolean;
  maxMarkdownLines?: number;
  maxCodeBlockLines?: number;
}
```

Defaults:

- markdown: true
- syntaxHighlighting: true
- color: auto
- codeBlockBorders: true
- maxMarkdownLines: bounded by existing transcript caps
- maxCodeBlockLines: 400 per block by default

Environment overrides:

- `DEEPCODER_UI_MARKDOWN=0|1`
- `DEEPCODER_UI_COLOR=auto|on|off`

## Safety and Correctness

- Renderer must never execute anything.
- URLs remain text only; no fetching.
- HTML is escaped/rendered as text.
- Malformed Markdown renders as plain text.
- Output stays bounded by transcript/frame caps.
- Code blocks preserve exact content except for display clipping; source body remains unchanged.
- Redaction remains upstream; renderer should not undo or obscure redaction markers.

## Files

New:

- `src/ui/richText.ts`
- `src/ui/markdown.ts`
- `src/ui/syntax.ts`
- `src/ui/theme.ts`
- `src/ui/wrapRich.ts`
- `test/adversarial/ui-markdown.test.ts`
- `test/adversarial/ui-syntax.test.ts`

Edit:

- `src/ui/minimalRenderer.ts`
- `src/ui/transcript.ts` only if display hints are needed
- `src/ui/events.ts` if config types live there
- `test/adversarial/ui-minimal-renderer.test.ts`
- `test/adversarial/ui-transcript.test.ts` only if state shape changes

## Tests

No TTY required.

1. Paragraphs wrap at width without losing text.
2. Headings produce heading-styled lines.
3. Bullets and numbered lists preserve indentation.
4. Inline code becomes `code` style while preserving text.
5. Fenced code captures language and preserves indentation.
6. Code block long lines are clipped with marker, not wrapped into misleading text.
7. Diff fences highlight `+`, `-`, and metadata lines.
8. TypeScript/Python/Bash/JSON highlighting never changes text content.
9. Links render as readable terminal text without fetching.
10. HTML renders as inert text.
11. `NO_COLOR` / color off produces no ANSI sequences.
12. Color on produces ANSI but wrapping ignores ANSI length.
13. Malformed Markdown never throws.
14. Huge Markdown is bounded by line/byte caps.
15. Existing minimal renderer snapshots remain stable when Markdown disabled.

## Rollout

### 10A.4.1 — Rich Text and Wrapping

- Add `RichLine`/`RichSpan` and rich wrapping.
- Keep existing renderer behavior unchanged until wired.

### 10A.4.2 — Markdown Parser/Renderer

- Implement dependency-free Markdown subset.
- Add snapshot-style tests with color disabled.

### 10A.4.3 — Syntax Highlighting

- Add regex-based highlighter for supported languages.
- Add text-preservation tests.

### 10A.4.4 — Theme/ANSI

- Add theme and color mode handling.
- Respect `NO_COLOR`/`FORCE_COLOR`.

### 10A.4.5 — Transcript Integration

- Render assistant blocks as Markdown in TUI mode.
- Keep plain renderer behavior unchanged.

## Acceptance Criteria

- Assistant Markdown is readable in the TUI without corrupting code blocks.
- Syntax highlighting works for TS/JS/Python/Bash/JSON/diff in color terminals.
- No-color mode is deterministic and snapshot-testable.
- Renderer is pure and dependency-free.
- Existing CLI/plain output behavior remains compatible.
- `npm run typecheck` and `npm run test:phase` pass.

## Open Questions

- Should code blocks clip or hard-wrap by default on very narrow terminals?
- Should tables be preserved verbatim or lightly aligned later?
- Should a future phase adopt a real Markdown parser if dependency policy changes?
- Should the patch review browser use the same code/diff renderer immediately?
