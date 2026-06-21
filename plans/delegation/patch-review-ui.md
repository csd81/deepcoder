# Patch Review Browser TUI (read-only v1)

## Context

We now delegate a lot, and acceptance-first delegation tightened the gates — but the
bottleneck is **review and merge confidence**. Inspecting a delegated worker's output today
means jumping between `run.json`, the kept worktree, and raw `git diff`. The review **data
layer already exists** (`reviewBrowser.ts` computes every signal) but is non-interactive and
isn't even wired into `/delegate review`. This adds a keyboard-navigable TUI that makes an
isolated worker's patch + status inspectable in one place: `/delegate review-ui <plan> [<worker>]`.

**v1 is READ-ONLY** (user decision): navigate + verify + show apply-eligibility + open the
worktree path. Accept/reject (apply/discard) are deferred — they still work via the existing
`/delegate apply`. This de-risks the MVP: no destructive actions, no in-TUI confirm flow.

## What already exists (REUSE — do not rebuild)

- **Data layer (`src/delegate/reviewBrowser.ts`):** `getWorkerReviewDetail(root, planId, workerId, {checks})`
  → `WorkerReviewDetail` with `status`, `checkPassed`, `changedFiles[]`, `patchBytes`,
  `patchSha256`, `qualityGate`, `deterministicGates[]` (named gates incl. `tdd_gate`,
  `quality_gate`, `git_apply_check`, `patch_scope`), `applyEligible`, `applyBlockers[]`,
  `patchStat[]`, `patchPreview` (the unified diff), `artifactPaths`. `getDelegationReviewOverview(root, planId)`
  → worker list for the picker. **The "acceptance-first/TDD proof present/missing" and quality
  flags are already in `deterministicGates` (tdd_gate / quality_gate)** — the status bar just reads them by name.
- **Diff stats:** `computePatchStat(patchText)` in `src/delegate/diffView.ts` (already parses
  `diff --git`/`+++`/`---`/`/dev/null` boundaries; the new splitter mirrors its exact prefix logic).
- **TUI infra (`src/ui/`, `src/cli/repl.ts`):** `wrapLine` (textLayout), `highlightCode(line,"diff",{color})`
  (syntax — diff lines already +green/-red/@@cyan), `createTheme`/`resolveColorEnabled` (theme),
  `diffFrames` anti-flicker (frameWriter), `solveLayout`/`flattenLayout` split-panes (layout),
  `visibleWidth` (minimalRenderer), `resolveUiMode` (uiMode — non-TTY ALWAYS "plain"). Shell
  template = `runTuiRepl` (repl.ts ~574-865): alt-screen enter `"\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H"`
  / exit `"\x1b[?25h\x1b[?1049l"` with an idempotent `restore()`, `emitKeypressEvents(stdin)` +
  `tty.setRawMode?.(true)`, `onResize` clears + invalidates `prevFrame`, `redraw()`→`diffFrames`.
- **Verify action:** `loadAndValidateWorker(root, planId, workerId)` (validation.ts) → pure
  re-validation `{status, applyable, failures, warnings}` (no apply, no spawn).
- **Worktree path:** `run.isolation.isolatedRoot` when `run.isolation.kept` (read `run.json`).

## Decisions (user-confirmed)

- **Worker picker:** `/delegate review-ui <plan>` with no worker shows an interactive list of
  the plan's workers (id, status, check, apply-eligible); j/k + Enter opens one. A worker id
  given → straight to the diff view.
- **Layout:** left file-list column / right diff body, status bar on top — via `solveLayout`.
  Narrow-terminal fallback (< ~60 cols): a one-line file header + full-width diff (file nav via n/p).
- **Read-only v1:** keys are `j/k` scroll diff · `n/p` next/prev file · `v` verify
  (`loadAndValidateWorker`) · `o` show kept worktree path · `q`/Esc quit. No accept/reject.

## Implementation (TDD; pure core + I/O shell, mirroring src/ui discipline)

### 1. Per-file diff splitter — `src/delegate/diffView.ts` (add next to `computePatchStat`)
`splitPatchByFile(patchText) → DiffFileSection[]` where `DiffFileSection { path; kind: PatchStat["kind"]; lines: string[] }`.
Single pass reusing the **identical** prefix tests as `computePatchStat` (open a section on
`diff --git a/<a> b/<b>`, `path` = b-side, rename when `a!==b`; `new file`/`/dev/null` → kind;
no-`diff --git` fallback opens on first `--- a/`/`+++ b/`). Preserve every line verbatim inside
its section (lossless body). Empty/whitespace → `[]`.

### 2. Pure review controller — `src/ui/reviewController.ts` (new)
- `ReviewState { detail: WorkerReviewDetail; files: DiffFileSection[]; selected: number; scroll: number; mode: "diff"|"message"; message?: {text;isError}; worktreePath?: string; busy: boolean }`
  + `initReviewState(detail, worktreePath?)` (splits `detail.patchPreview`).
- `type ReviewAction = "scroll-up"|"scroll-down"|"half-up"|"half-down"|"top"|"bottom"|"next-file"|"prev-file"|"verify"|"open"|"dismiss"|"quit"|"none"`
  + `reviewKeyToAction(key, mode)` — reuse `keyToAction` (minimalRenderer) for the scroll family;
  layer letters: `j`→scroll-down, `k`→scroll-up, `n`→next-file, `p`→prev-file, `v`→verify, `o`→open,
  `q`/Esc→quit; in `message` mode any key → dismiss. (Local action type — do NOT widen the REPL's `KeyAction`.)
- `reduceReview(state, action, {height})` — pure/total: scroll clamps to `[0, maxScroll]` (from the
  current file's wrapped-line count vs body height); `next/prev-file` clamps `selected` and resets `scroll=0`.
- Pure setters the shell folds async results through: `applyVerify(state, validation)` → `mode:"message"`
  summarizing status/applyable/failures; `applyMessage(state, text, isError)` (for `o`/errors);
  `refreshDetail(state, detail)` → re-split + clamp.
- `renderReview(state, size, theme) → string[]` (full frame; shell `diffFrames` it). Uses `solveLayout`
  (status fixed / body grow / footer fixed; body row = filelist fixed-width + diff grow), composes
  region rows into a `string[]`. **Status bar** from `detail`: `worker — title · status · check pass/fail ·
  quality:<gate> · TDD <present|missing|n-a> · <N> files · <KB>KB · apply:<eligible|BLOCKED>` (+ first
  blocker), reading `deterministicGates.find(name==="tdd_gate"/"quality_gate")`, colorized via theme.
  **File list**: per file `kind`-glyph + path + `+a/-r` (from `patchStat`); selected row uses `theme.selected`.
  **Diff body**: `files[selected].lines` → `wrapLine` to region width → slice `[scroll, scroll+bodyH]` →
  `highlightCode(line,"diff",{color})` per visible row (color AFTER wrap). **message mode**: banner.

### 3. I/O shell — `src/cli/reviewUi.ts` (new, mirrors `runTuiRepl`)
`runReviewUi({ root, planId, workerId })`. Before alt-screen: `getWorkerReviewDetail(...)`; if null →
print error, return (never raw mode). Read `run.json` for the kept-worktree path. Then alt-screen +
`restore()` (idempotent, also on `process exit`/`SIGTERM`) + `emitKeypressEvents` + `setRawMode(true)` +
`stdout.on("resize")`. `redraw()` = `renderReview(state,size,theme)` → `diffFrames(prev,frame)`.
`onKey` → `reviewKeyToAction` → pure transitions `redraw()`; `verify` → `busy`, `await loadAndValidateWorker`,
re-load detail, `refreshDetail(applyVerify(...))`; `open` → `applyMessage(worktreePath ?? "worktree not kept")`;
`quit` → `restore()` + resolve. `finally { restore(); remove listeners }`. **Never call `confirm()`** (readline
conflicts with raw mode — not needed in read-only v1 anyway).

### 4. Command + picker — `src/cli/slashCommands.ts` (`if (sub === "review-ui")` in `case "delegate"`)
- Imports: `runReviewUi` (new), `runReviewPicker` (new, in reviewUi.ts) , `resolveUiMode`.
- TTY gate via `resolveUiMode({flag: --no-tui?"plain":undefined, env, isTTY})`. Non-TTY or `--no-tui` →
  **static fallback**: print existing `renderWorkerReview(detail)` + `renderPatchStat` (reviewRender.ts), no raw mode.
- **No worker** → `getDelegationReviewOverview(root, planId)`; TTY → `runReviewPicker` (small single-column
  list-select reusing the same alt-screen/raw-input shell; j/k + Enter → call `runReviewUi` for the chosen worker;
  q quits). Non-TTY → print the overview list.
- **Worker given** + TTY → `runReviewUi({root, planId, workerId})`.
- Add `review-ui` to the `/delegate` usage + help strings.

### 5. Tests (failing first; pure modules tested directly, no mocks)
- `test/adversarial/delegate-diff-split.test.ts` — splitter: 2-file modify, new/deleted/renamed, `/dev/null`
  both sides, lossless round-trip, path-set consistency with `computePatchStat`/`parseChangedPaths`, empty→[].
- `test/adversarial/ui-review-controller.test.ts` — `reviewKeyToAction` (j/k/n/p/v/o/q + scroll family);
  scroll clamps `[0,maxScroll]`; file nav clamps + resets scroll; `applyVerify` summary; `refreshDetail` re-split.
- `test/adversarial/ui-review-renderer.test.ts` — frame line count == height, each ≤ width (`visibleWidth`);
  status bar contains status/check/quality/TDD/file-count/KB/apply fields; selected row has `\x1b[7m`; a `+`
  line is green / `-` red / `@@` cyan in the body; `createTheme(false)` → no SGR.
- `test/adversarial/delegate-review-ui-cmd.test.ts` — non-TTY (or `--no-tui`) `/delegate review-ui <plan> <worker>`
  prints the static fallback and never enters raw mode; unknown plan/worker → clean error. Reuse the on-disk
  plan/run/patch fixture builder from `test/adversarial/delegate-review-browser.test.ts`.
  (Raw-mode keypress loop = manual smoke, like `runTuiRepl`.)

## Critical files
- `src/delegate/diffView.ts` — add `splitPatchByFile` (reuse `computePatchStat` parsing).
- `src/ui/reviewController.ts` — new pure reducer + renderer + `reviewKeyToAction`.
- `src/cli/reviewUi.ts` — new I/O shell (`runReviewUi` + `runReviewPicker`), modeled on `runTuiRepl`.
- `src/cli/slashCommands.ts` — `review-ui` subcommand + static fallback (reuse `renderWorkerReview`/`renderPatchStat`).
- `src/delegate/reviewBrowser.ts` — read-only data source (`getWorkerReviewDetail`/`getDelegationReviewOverview`).

## Verification
1. `npm run test:phase` green (new pure tests + cmd smoke; existing suite unbroken); `npx tsc --noEmit` clean.
2. Static fallback: `/delegate review-ui <plan> <worker> --no-tui` (or non-TTY) prints worker review + patch stat,
   never enters alt-screen.
3. Interactive (real TTY): `/delegate review-ui <plan>` → picker lists workers, Enter opens one; `j/k` scroll diff;
   `n/p` switch files (scroll resets); status bar shows check/quality/TDD/apply-eligibility + blockers; `v` shows the
   `loadAndValidateWorker` verdict; `o` shows the kept worktree path (or "not kept"); `q`/Esc restores the terminal
   cleanly (cursor shown, main screen, raw off). Resize mid-session repaints; SIGTERM leaves the terminal usable.

## Deferred (explicit follow-ups, not in v1)
- **Accept/reject** (apply/discard from the TUI) — needs an in-TUI confirm keystroke + `applyWorker({isTTY:true,
  confirmResult:true, requireValidatedTest})` / `discardWorker`. Use existing `/delegate apply` meanwhile.
- **`o` spawns `$EDITOR`** (suspend/resume the TUI) — v1 just prints the path.
- **Deep verify** (`v` re-runs the actual check command on the kept worktree via `runCheck`) — v1 re-validates only.
- **Per-file scroll memory** — v1 resets to top on file switch.
