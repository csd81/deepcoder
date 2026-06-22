# Phase 10O — `/copy` Slash Command

## Context

Deepcoder sessions contain many values users need outside the app:

- the latest assistant answer
- the latest code block
- a command/check failure excerpt
- the current git diff
- a delegated worker patch/review summary
- the current session goal or plan text

Today the user has to select terminal text manually, inspect session JSON, or rerun commands. That is slow and error-prone, especially inside the TUI where alternate-screen rendering and wrapped lines make selection awkward.

The next highest-ROI missing slash command is `/copy`: a small command surface that copies the useful thing directly to the system clipboard, with safe fallback to printing/saving when a clipboard backend is unavailable.

This plan is the slash-command layer. It complements the broader TUI copy/export plan (`phase10a12-tui-copy-export-plan.md`) but can ship independently.

## Goal

Add:

```text
/copy
/copy last
/copy code
/copy diff
/copy goal
/copy plan
/copy check <run-id>
/copy worker <plan-id> <worker-id> [patch|log|review]
/copy --print <target>
```

Default behavior:

- `/copy` aliases `/copy last`
- copies to clipboard when a supported clipboard command is available
- otherwise prints a bounded fallback with a clear warning
- always redacts secrets before copying or printing

## Non-Goals

- No arbitrary mouse/visual selection.
- No OCR or terminal screen scraping.
- No cloud clipboard.
- No automatic copy of every response.
- No TUI keybindings in this slice.
- No editing exported files; `/export` is separate.
- No copying raw secrets, even if the user asks.

## UX

Latest assistant answer:

```text
/copy
copied latest assistant response (1,284 chars)
```

Latest code block:

```text
/copy code
copied latest code block: typescript (542 chars)
```

Diff:

```text
/copy diff
copied git diff (3 files, 9,812 chars)
```

Clipboard unavailable:

```text
clipboard unavailable: install wl-copy, xclip, or pbcopy

--- copied text fallback ---
...
```

Print instead of clipboard:

```text
/copy --print code
```

Invalid target:

```text
usage: /copy [last|code|diff|goal|plan|check <id>|worker <plan> <worker> [patch|log|review]]
```

## Design

### 1. Copy Target Extraction

New file: `src/clipboard/copyTargets.ts`

Exports:

```ts
export type CopyTarget =
  | { kind: "last" }
  | { kind: "code" }
  | { kind: "diff" }
  | { kind: "goal" }
  | { kind: "plan" }
  | { kind: "check"; runId: string }
  | { kind: "worker"; planId: string; workerId: string; part: "patch" | "log" | "review" };

export interface CopyPayload {
  label: string;
  text: string;
  bytes: number;
  truncated: boolean;
}

export function parseCopyArgs(arg: string): { ok: true; target: CopyTarget; printOnly: boolean } | { ok: false; error: string };
export function extractLatestAssistant(messages: AgentMessage[]): CopyPayload | null;
export function extractLatestCodeBlock(messages: AgentMessage[]): CopyPayload | null;
```

Rules:

- `last` finds latest assistant message with non-empty text.
- `code` finds the last fenced code block in assistant messages.
- code block parser is simple and bounded; no full Markdown parser required.
- target extraction never throws.
- all text is bounded before copy.
- all text is redacted with `redactSecrets`.

### 2. Clipboard Adapter

New file: `src/clipboard/clipboard.ts`

Exports:

```ts
export interface ClipboardCommand {
  file: string;
  args: string[];
}

export interface CopyResult {
  ok: boolean;
  backend?: string;
  error?: string;
}

export function detectClipboardCommand(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): ClipboardCommand | null;
export async function copyToClipboard(text: string, opts?: {
  command?: ClipboardCommand | null;
  spawn?: SpawnFn;
  timeoutMs?: number;
}): Promise<CopyResult>;
```

Detection:

- macOS: `pbcopy`
- Linux Wayland: `wl-copy`
- Linux X11: `xclip -selection clipboard`
- Windows: defer unless already easy in Node environment

Implementation:

- `spawn(command.file, command.args, { shell:false })`
- write redacted text to stdin
- timeout after 3 seconds
- bounded stderr capture
- no clipboard command => `{ ok:false, error:"clipboard unavailable" }`

Tests inject fake `spawn`; they should not depend on a real clipboard.

### 3. Rich Targets

Targets with existing data sources:

- `diff`: use existing `Git.diff()` or shell-free git helper if present
- `goal`: use Phase 10M goal data when implemented; until then returns "goal not available"
- `plan`: latest `/plan` assistant response, or current delegation plan summary if args later expand
- `check <run-id>`: `loadCheckRun`
- `worker <plan-id> <worker-id> patch|log|review`: `loadWorkerArtifacts`

If a dependency feature is not implemented yet, the command should fail gracefully:

```text
goal copying requires Phase 10M /goal
```

### 4. Slash Command

Edit: `src/cli/slashCommands.ts`

Add:

```ts
case "copy":
  await runCopySlash(session, arg);
  return { consumed: true };
```

`runCopySlash`:

1. parse args
2. build payload
3. redact + bound
4. if `--print`, print payload
5. else call `copyToClipboard`
6. on clipboard failure, print a short fallback preview or full bounded text depending on size

Output must include:

- target label
- copied char count
- truncation marker if truncated
- backend name when useful

### 5. Slash Catalog and Help

Edit if present:

- `src/cli/slashCatalog.ts`
- `/help` list in `src/cli/slashCommands.ts`

Add:

```text
/copy [last|code|diff|check|worker]  copy useful session output to clipboard
```

## Safety

- Always redact with `redactSecrets` before copy, save, print, or tests inspect output.
- Do not allow arbitrary file paths.
- `check` IDs and plan/worker IDs go through existing `assertSafeId` through their loaders.
- Clipboard command uses `shell:false`.
- Timeout clipboard writes.
- No network.
- No model call.
- No execution of checks/workers.

## Tests

New file: `test/adversarial/copy-slash.test.ts`

Pure parsing/extraction:

1. `/copy` parses as `last`.
2. `/copy --print code` parses print-only code target.
3. invalid target returns usage error.
4. latest assistant extraction skips user/tool messages.
5. latest code block extraction returns the last fenced block.
6. unclosed code fence is bounded and handled safely.
7. output is redacted before copy.

Clipboard:

8. detects `pbcopy` on darwin.
9. detects `wl-copy` when `WAYLAND_DISPLAY` exists.
10. detects `xclip` when `DISPLAY` exists and no Wayland.
11. uses `shell:false`.
12. timeout returns a clean failure.
13. fake stderr is bounded.

Slash behavior:

14. `/copy last` copies latest assistant response through fake clipboard.
15. `/copy code` copies latest code block through fake clipboard.
16. `/copy --print code` prints and does not spawn clipboard.
17. clipboard unavailable prints a clear fallback.
18. copied text never contains fixture API key strings.

Optional integration:

19. `/copy check <run-id>` loads a saved check run.
20. `/copy worker <plan> <worker> patch` loads worker patch artifact.

## Acceptance

Required:

```text
npm run typecheck
npm run test:phase
node --import tsx --test test/adversarial/copy-slash.test.ts
```

Manual smoke:

```text
/copy
/copy code
/copy --print code
/copy diff
/copy check <recent-check-run-id>
```

Expected:

- no secrets copied or printed
- no clipboard command required for tests
- command fails gracefully when clipboard unavailable
- no session/config/git mutation except normal command history if applicable

## Delegation Suitability

Good delegated split:

1. Worker A: `src/clipboard/copyTargets.ts` + pure tests.
2. Worker B: `src/clipboard/clipboard.ts` + fake-spawn tests.
3. Parent/manual: `slashCommands.ts` wiring + integration tests.

Reason: parsing and clipboard adapter are disjoint and pure enough for parallel workers; slash wiring touches shared command code and should be reviewed manually.

Suggested worker prompt:

```text
Implement Phase 10O copy target parsing/extraction only.
Touch only src/clipboard/copyTargets.ts and test/adversarial/copy-slash.test.ts.
Do not wire slash commands yet. Do not use a real clipboard.
Run npm run test:phase.
```

## Implementation Order

1. Add `copyTargets.ts`.
2. Add parser/extractor tests.
3. Add `clipboard.ts`.
4. Add fake-spawn clipboard tests.
5. Wire `/copy last|code|diff`.
6. Add `check` and `worker` artifact targets.
7. Add catalog/help entry.
8. Run full gate.
9. Later: integrate TUI `y` key with the same adapter.
