# Phase 10A.14 — Native Slash Results in TUI

## Context

Deepcoder's TUI is improving, but slash commands still feel prototype-like:

- `runTuiRepl` suspends the alternate screen
- `handleSlashCommand` runs on the normal terminal
- most commands print directly with `console.log`
- after the command, TUI resumes

This breaks the Codex/Claude-style app feel. A modern terminal agent should keep command
results inside the same scrollable transcript.

This phase introduces structured slash-command results and renders them natively in TUI mode,
starting with low-risk read-only/status commands.

## Goal

Make selected slash commands render as transcript blocks instead of suspending the TUI.

Initial commands:

- `/usage`
- `/cost`
- `/telemetry`
- `/context`
- `/web`
- `/todos`
- `/plugins`
- `/checks`
- `/instructions` read-only display path

Example TUI result:

```text
▾ command /usage
  Session tokens
  total: 42,391
  prompt: 37,900
  completion: 4,491
  estimated cost: $0.034
```

Plain mode should continue to print readable text to stdout.

## Non-Goals

- No full rewrite of every slash command in one pass.
- No behavior change for mutating/interactive commands in MVP.
- No changing approval/check/sandbox gates.
- No native rendering for `/check`, `/solve`, `/delegate run`, `/rollback`, or commands that
  need confirmation/subprocess streaming in this slice.
- No dependency on a TUI framework.

## Design

### 1. Slash Result Types

New file:

```text
src/cli/slashResult.ts
```

Types:

```ts
export type SlashResultKind =
  | "message"
  | "table"
  | "list"
  | "markdown"
  | "error";

export interface SlashResult {
  kind: SlashResultKind;
  title: string;
  body?: string;
  rows?: string[][];
  headers?: string[];
  severity?: "info" | "warn" | "error";
}

export interface StructuredSlashOutcome extends SlashOutcome {
  result?: SlashResult;
}
```

Helpers:

```ts
export function messageResult(title: string, body: string, severity?: ...): SlashResult;
export function tableResult(title: string, headers: string[], rows: string[][]): SlashResult;
export function renderSlashResultPlain(result: SlashResult): string;
export function renderSlashResultTui(result: SlashResult, opts: { width: number; theme: Theme }): string[];
```

Rules:

- renderers are pure
- rows and body are bounded
- output is redacted
- tables degrade to aligned plain text
- no result contains functions or side effects

### 2. Split Read-Only Command Producers

Create pure-ish producers for the initial commands:

```text
src/cli/slashReadOnlyResults.ts
```

Functions:

```ts
export function usageResult(session: Session): SlashResult;
export function costResult(session: Session): SlashResult;
export function telemetryResult(session: Session): SlashResult;
export function contextResult(session: Session): SlashResult;
export function webResult(session: Session): SlashResult;
export function todosResult(session: Session): SlashResult;
export async function pluginsResult(session: Session, arg: string): Promise<SlashResult>;
export function checksResult(session: Session): SlashResult;
```

These should reuse existing helpers:

- `estimateCost`
- `renderTodos`
- `summarizeWebTrace`
- `classifyCommand`
- plugin discovery/trust helpers where needed

### 3. Handler Contract

Modify `handleSlashCommand` carefully:

- keep existing `SlashOutcome`
- add optional `result`
- for converted commands:
  - build `SlashResult`
  - if caller supports structured results, return it
  - otherwise print through `renderSlashResultPlain`

Recommended signature change:

```ts
export async function handleSlashCommand(
  input: string,
  session: Session,
  save: () => Promise<void>,
  runAgent?: () => Promise<void>,
  opts?: { structured?: boolean },
): Promise<StructuredSlashOutcome>
```

Behavior:

- plain REPL calls without `structured`, so it keeps printing
- TUI calls with `{ structured: true }`, so converted commands return `result`
- unconverted commands behave exactly as before

This avoids converting every command at once.

### 4. TUI Rendering

In `runTuiRepl`:

- do not suspend TUI for converted structured commands
- push user command block as today
- call `handleSlashCommand(..., { structured: true })`
- if `result` exists:
  - append a transcript block of kind `notice` or new kind `command`
  - title: command string
  - body: rendered text or Markdown
- if no `result`, fall back to current suspend-and-run behavior

Potential transcript extension:

```ts
kind: "command"
```

If adding a new block kind is too broad for MVP, use `notice` with title/body.

Recommended:

- add `command` block kind so UI can style command results distinctly.

### 5. Plain Rendering

Plain mode should use `renderSlashResultPlain`.

Example:

```text
Usage
  total        42391
  prompt       37900
  completion   4491
  cost         ~$0.034
```

### 6. Native vs Suspended Commands

Converted native commands:

- `/usage`
- `/cost`
- `/telemetry`
- `/context`
- `/web`
- `/todos`
- `/plugins` list-only path
- `/checks`

Still suspended/legacy in MVP:

- `/check`
- `/solve`
- `/delegate run`
- `/delegate apply`
- `/rollback`
- `/plan`
- `/research`
- `/review`
- `/triage`
- `/explore`
- `/semantic`
- `/understand`
- `/plugins trust|untrust`
- `/skills activate`
- `/$`

Reason: these perform subprocesses, model calls, mutations, confirmations, or longer streamed
work. They can be converted later with structured streaming events.

## Files

New:

- `src/cli/slashResult.ts`
- `src/cli/slashReadOnlyResults.ts`
- `test/adversarial/slash-result.test.ts`
- `test/adversarial/slash-readonly-results.test.ts`

Edited:

- `src/cli/slashCommands.ts`
- `src/cli/repl.ts`
- `src/ui/transcript.ts`
- `test/adversarial/ui-transcript.test.ts`
- targeted slash command tests if present

## Tests

### Slash Result Renderer

- message result renders plain and TUI forms
- table result aligns columns
- rows are bounded
- body is redacted
- narrow width does not throw
- error severity is visible

### Read-Only Producers

- usage result includes token counts
- cost unknown displays unknown instead of fake cost
- telemetry result includes model/tool/check counts
- context result includes budget percent
- web result includes enabled/provider/trace
- todos result handles empty and non-empty lists
- checks result marks denied commands
- plugins list result handles no plugins

### Handler Contract

- plain call prints converted command result
- structured call returns result and does not print
- unconverted command still uses legacy path
- unknown command behavior unchanged

### TUI Integration

If extracted enough:

- structured slash result appends a command block
- fallback legacy command still suspends
- slash command failure renders error block

## Acceptance

- `npm run typecheck`
- `npm run test:phase`
- manual smoke:

```bash
npm run dev -- --tui
```

Smoke checklist:

- `/usage` renders inline in transcript
- `/web` renders inline in transcript
- `/todos` renders inline in transcript
- `/checks` renders inline in transcript
- `/check phase` still uses safe legacy confirmation path
- terminal no longer flickers/suspends for converted commands
- plain REPL output remains readable

## Safety

- Converted commands are read-only/status-only.
- No permission/sandbox behavior changes.
- Mutating commands remain on legacy paths.
- Plain mode remains supported.
- Outputs are bounded/redacted before rendering.

## Implementation Order

1. Add `slashResult.ts` and renderer tests.
2. Add read-only result producers for `/usage`, `/cost`, `/telemetry`, `/context`, `/web`,
   `/todos`, `/checks`.
3. Add structured option to `handleSlashCommand`.
4. Convert the initial read-only commands.
5. Add TUI structured-result rendering.
6. Convert `/plugins` list path if low risk.
7. Manual smoke.

## Follow-Ups

- Structured streaming slash commands for `/check`.
- Native `/delegate status/review` blocks.
- Native `/research` and `/explore` subagent blocks.
- Structured slash results for `/instructions`.
- Export command results via Phase 10A.12 copy/export.

## Delegation Notes

Good split:

- Slice A: `slashResult.ts` + pure render tests.
- Slice B: read-only producers + tests.
- Slice C: `handleSlashCommand` structured option + TUI integration, reviewed in-house because
  it changes CLI control flow.

