# Phase 10R — `!` shell-escape for the REPL/TUI

## Context

deepcoder's interactive REPL/TUI sends every non-slash line to the model. There's
no way to run a quick shell command (`ls`, `git status`, `cat foo`) without leaving
the session or asking the model to do it. Codex/Claude-style CLIs support a `!`
prefix that runs the line as a real shell command and shows its output inline. This
adds that: typing `!git status` runs it as a sandboxed shell command instead of a
model prompt, in both the plain REPL and the TUI.

**Save this plan to `plans/new/phase10r-bang-shell-escape-plan.md` as the first
implementation step** (plan mode can't write into the repo).

## Decisions (user-confirmed)

- **Permission: sandboxed + deny-gated.** Always run inside the configured sandbox.
  Refuse in `--mode readonly`. If `classifyCommand` returns `deny` (e.g. `rm -rf`,
  `sudo`, subshells), require an explicit `confirm()`. `allow`/`ask` run directly —
  the human explicitly typed it.
- **Fresh shell each `!`.** Each command is a new one-shot via `runBashTool` (no
  `cd`/env persistence). This reuses the sandbox wrap + secret redaction + timeout
  for free; the persistent PTY path is NOT sandboxed yet, so we don't use it.

## Reuse (do not reinvent)

- **Execution:** `runBashTool` (`src/tools/runBash.ts`) — `runBashTool.build({ command, timeout_ms })`
  then `.execute(ctx)` → `{ output: string, isError?: true }`. It already spawns
  through the sandbox via `wrapCommand(req, ctx.sandbox)` (`src/sandbox/index.ts`),
  caps output at 8 MB, applies the timeout, and redacts secrets. **It RETURNS the
  output** (does not print), so we render the return value directly — no stdout
  monkeypatch needed (unlike the `TUI_INLINE_SLASH` slash path).
  `ctx = { workspaceRoot: session.executionRoot ?? session.config.workspaceRoot, signal, sandbox: session.config.sandbox, readTracker: session.readTracker, todos: session.todos }`.
- **Permission:** `classifyCommand(cmd)` (`src/permissions/commandClassifier.ts`) →
  `"allow"|"ask"|"deny"` (fail-closed). `confirm(question)` (`src/permissions/prompt.ts`)
  — already imported in `repl.ts:24`.
- **TUI transcript write:** `transcript = applyEvent(transcript, { type: "notice", message })`
  then `stickBottom(); redraw()`. Errors → notice with the error text.

## Design

### 1. New pure module `src/cli/bangCommand.ts` (testable seams)

```ts
/** Strip the leading `!` (and one optional space). Returns the command, "" for a
 *  bare `!` (caller shows a hint), or null when the input isn't a bang line. */
export function parseBangCommand(input: string): string | null;

export type BangDecision =
  | { action: "run" }
  | { action: "confirm"; reason: string }
  | { action: "refuse"; reason: string };

/** Pure policy: readonly → refuse; classify==="deny" → confirm; else run. */
export function decideBang(
  command: string,
  mode: ApprovalMode,
  classify: (c: string) => "allow" | "ask" | "deny",
): BangDecision;
```

Parsing rules: `!ls`→`ls`, `! ls`→`ls`, `!`→`""`, `!!`→`"!"`. Detection happens
BEFORE slash/model dispatch so `!` never reaches the model.

### 2. Plain REPL (`runRepl`, repl.ts ~553–566)

At the TOP of the loop body (before `handleSlashCommand`): if `parseBangCommand(input)`
is non-null → handle it and `continue` (never push to the model):
- empty → print a hint (`! <command>` usage).
- `decideBang(cmd, session.mode, classifyCommand)`:
  - `refuse` → `chalk.yellow` message (e.g. "refused: readonly mode").
  - `confirm` → `await confirm("Run flagged-dangerous command? ...")`; if no, print "cancelled".
  - then build+execute `runBashTool`, write `result.output` to stdout (red if `isError`).
- Thread an `AbortController` + the existing SIGINT handling so Ctrl-C kills the child.

### 3. TUI (`runTuiRepl` → `handleSubmit`, repl.ts ~1043–1102)

Intercept between the `/exit` check (1047) and the `/` check (1048). `pushUser(line)`
already echoed the `!cmd` as a user block; we add the output as a notice block:
- empty → notice hint.
- `decideBang(...)`:
  - `refuse` → notice ("refused: …"). `redraw`.
  - `run` (allow/ask, the common case) → `busy=true; redraw()`; `await runBashTool…execute(ctx)`;
    push `result.output` as a notice (or an error notice); `busy=false; stickBottom; redraw`.
    **No alt-screen suspend** — output stays in the scrollable transcript.
  - `confirm` (deny case) — do NOT call `confirm()` in the TUI (its readline fights raw
    mode). Instead reuse the EXISTING `approve` closure (`repl.ts:1032`, the
    `createTuiApproval`→`approvalResolve`→`onKey` y/n/Esc flow that already renders the
    10A.20 approval review panel + "approval" footer): `const ok = await approve(runBashTool.build({ command: cmd }))`.
    `runBashTool.build(...).describe()` returns `` `$ <cmd>` ``, so the panel shows the
    command. `!ok` → "Cancelled." notice. No suspend, no flicker — this is the project's
    standard "confirm while in raw mode" path.

### 4. Discoverability

- Startup notice (repl.ts:1271): add "· `!cmd` shell".
- `src/ui/footerHints.ts` (`normal` mode hint): add `!cmd shell`.
- `src/ui/helpOverlay.ts` (`normal`/`busy` entries): add a `!<cmd>` row.
  (These are pure modules with existing tests — extend the snapshots accordingly.)

## Files to change

- **New:** `src/cli/bangCommand.ts`, `test/adversarial/bang-command.test.ts`.
- **Edit:** `src/cli/repl.ts` (both `runRepl` and `handleSubmit` dispatch; startup notice).
- **Edit:** `src/ui/footerHints.ts`, `src/ui/helpOverlay.ts` (+ their tests for the new hint rows).

## Tests (`test/adversarial/bang-command.test.ts`, pure)

- `parseBangCommand`: `!ls`→`ls`, `! ls`→`ls`, `!`→`""`, `!!`→`"!"`, `ls`→`null`, `/help`→`null`, leading space `" !ls"`→`null` (only a leading `!` counts).
- `decideBang`: readonly → `refuse` for any command; `deny`-classified (injected classify) → `confirm`; `allow`/`ask` → `run`; verify the injected classify fn is what's consulted (no real classification needed).
- Optional: a thin `runBang(command, deps)` orchestrator with an injected `execute` + `confirm` so the refuse/confirm/run branches are unit-tested without a real shell. (The repl wiring itself is raw-mode I/O — manual smoke, like the rest of the TUI shell.)

## Verification

1. `npm run typecheck` clean; `npm run test:phase` fully green (new pure tests included).
2. Plain REPL: `npm run dev` → `!git status` prints output; `!` shows the hint;
   `!rm -rf /tmp/nope` prompts to confirm; in `--mode readonly` it's refused.
3. TUI: `npm run dev -- --tui` → `!ls -la` shows output as a transcript block (no
   screen flicker/suspend); `!sudo true` triggers the approval review panel (y approve
   / n deny / Esc) in-place — no raw-mode break; Ctrl-C during a long `!sleep 30`
   interrupts it; mouse/scroll still work afterward.

## Safety

- Always sandboxed (inherits `session.config.sandbox`); secret-redacted; timeout-bounded — all via `runBashTool`.
- `readonly` mode refuses; `deny`-classified commands require explicit confirm.
- `!` is intercepted before slash/model dispatch, so it never reaches the model and can't be injected by it (it's a user-input-only affordance).
- No new permission bypass: the model still cannot run `!` — only the human at the prompt.
