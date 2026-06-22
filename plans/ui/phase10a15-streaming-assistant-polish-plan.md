# Phase 10A.15 — Streaming Assistant Polish

## Context

Deepcoder's UI already has:

- `assistant_delta` / `assistant_done` UI events
- transcript blocks for assistant output
- final Markdown rendering for completed assistant messages
- syntax-highlighted fenced code blocks
- diff-based frame repainting

Current TUI behavior:

- completed assistant messages render as Markdown
- unfinished/streaming assistant messages render as raw text with `assistant>` prefix

That makes the most-watched part of the app feel less polished than Codex/Claude-style UIs.
The assistant should appear as a stable streaming block with a clean header, safe partial
Markdown rendering, and a final re-render when complete.

## Goal

Polish assistant streaming in TUI mode:

- show a stable assistant block header while streaming
- render partial Markdown progressively without corrupting code fences
- show `streaming...` / `writing...` state in the assistant header or status line
- on completion, re-render as final Markdown with syntax highlighting
- keep bottom composer stable while text streams above

Example:

```text
assistant · deepseek/deepseek-v4-flash · streaming...

I found the issue in `src/parser.ts`.

[ts]
export function parse...
```

Final:

```text
assistant · deepseek/deepseek-v4-flash

I found the issue in src/parser.ts.

[ts]
export function parse(input: string) { ... }
```

## Non-Goals

- No model/tool behavior changes.
- No hidden chain-of-thought display.
- No provider-specific reasoning UI in this slice.
- No full Markdown parser dependency.
- No changing persisted assistant message content.
- No animation beyond stable status text/spinner if cheap.

## Design

### 1. Assistant Render State

New file:

```text
src/ui/assistantRenderState.ts
```

Exports:

```ts
export interface AssistantRenderInput {
  body: string;
  finished: boolean;
  width: number;
  theme: Theme;
  modelLabel?: string;
}

export interface AssistantRenderOutput {
  header: string;
  lines: string[];
  inOpenFence: boolean;
  truncated?: boolean;
}

export function detectOpenFence(markdown: string): { open: boolean; lang: string };
export function renderAssistantBlock(input: AssistantRenderInput): AssistantRenderOutput;
```

Rules:

- finished messages use existing `renderMarkdown`
- streaming messages use `renderStreamingMarkdown`
- header includes model label if available
- body is bounded to a sane cap, e.g. 100_000 chars for rendering
- never throw on malformed Markdown

### 2. Streaming Markdown Renderer

Add:

```ts
export function renderStreamingMarkdown(md: string, opts: RenderMarkdownOptions): string[];
```

Location:

- `src/ui/markdown.ts` if it can share helpers
- or `src/ui/assistantRenderState.ts` if keeping it isolated is cleaner

Behavior:

- render headings/lists/prose similarly to final renderer
- if a fenced code block is open at the end, render code lines verbatim and add a dim marker:

```text
[code block still streaming]
```

- do not require a closing fence before showing code
- do not emit raw ``` fence markers
- preserve indentation in code
- avoid table rendering until the table is complete enough; incomplete tables can render as
  plain wrapped prose or simple lines

### 3. TUI Transcript Rendering

Modify assistant branch in `flattenStyled` inside `runTuiRepl`:

Current:

- finished assistant -> `renderMarkdown`
- unfinished assistant -> raw prefixed lines

New:

- all assistant blocks go through `renderAssistantBlock`
- unfinished header:

```text
assistant · <model> · streaming...
```

- finished header:

```text
assistant · <model>
```

If model label is unavailable, use:

```text
assistant
```

The header should be dim/title styled but not too loud.

### 4. Plain Renderer Optional Polish

Plain mode currently buffers assistant text and renders on `assistant_done` if
`renderAssistant` is provided. Keep that behavior for MVP because streaming Markdown in a plain
scrolling terminal can be noisy.

Optional:

- show one initial `assistant>` line immediately
- buffer final Markdown as today

Do not block this phase on plain-mode streaming.

### 5. Activity Timeline / Status Integration

If Phase 10A.11 exists:

- `assistant_delta` should mark assistant activity as running
- `assistant_done` marks done

If not, add only a status suffix in TUI:

```text
 · streaming
```

Existing `busy` status already shows `running...`; this phase may leave it unchanged.

### 6. Width and Stability

Requirements:

- wrapped lines never exceed terminal width, ignoring ANSI
- open code blocks do not cause layout explosions
- rendering is deterministic for the same input/width/theme
- frame diffing remains effective: streaming changes only assistant rows, not the composer

## Files

New:

- `src/ui/assistantRenderState.ts`
- `test/adversarial/ui-assistant-render-state.test.ts`

Edited:

- `src/ui/markdown.ts`
- `src/cli/repl.ts`
- `test/adversarial/markdown.test.ts`
- possibly `src/ui/theme.ts` if assistant header style needs a new helper

## Tests

### Assistant Render State

- unfinished assistant header includes `streaming`
- finished assistant header omits `streaming`
- model label appears when provided
- empty body renders a stable header and no crash
- huge body is bounded

### Open Fence Detection

- no fence -> closed
- one opening ```ts -> open with `ts`
- opening and closing fence -> closed
- multiple fences -> detects final state
- tilde fences supported if final renderer supports them

### Streaming Markdown

- partial prose wraps
- partial list renders cleanly
- partial code fence does not show raw ```
- partial code fence preserves code indentation
- final closed code fence matches existing final-render behavior
- incomplete table does not crash or produce raw delimiter spam

### TUI Rendering

If feasible through pure helpers:

- unfinished assistant block goes through streaming renderer
- finished assistant block goes through final renderer
- output lines are width-bounded

## Acceptance

- `npm run typecheck`
- `npm run test:phase`
- manual smoke:

```bash
npm run dev -- --tui
```

Smoke checklist:

- assistant response appears under a stable assistant header
- header shows streaming state while model is responding
- code fence starts rendering before the closing fence arrives
- completed response re-renders as final Markdown
- composer stays fixed at bottom during streaming
- no flicker beyond changed rows
- Ctrl+C/exit restores terminal

## Safety

- UI-only rendering change.
- No model prompt/history mutation.
- No tool execution changes.
- No extra provider calls.
- No hidden reasoning display.
- Non-TTY/plain mode behavior remains stable.

## Implementation Order

1. Add `assistantRenderState.ts` with open-fence detection and tests.
2. Add `renderStreamingMarkdown` and tests.
3. Wire assistant blocks in TUI rendering through `renderAssistantBlock`.
4. Add width-bound tests.
5. Manual TUI smoke with a response containing Markdown and code fences.

## Delegation Notes

Good split:

- Slice A: open-fence detection + assistant render state tests.
- Slice B: streaming Markdown renderer + tests.
- Slice C: `runTuiRepl` integration, reviewed in-house because it touches terminal rendering.

