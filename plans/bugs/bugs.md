# Known bugs (TUI dogfooding)

Living log of bugs found while dogfooding `npm run dev -- --tui`. Newest first.
Status: `OPEN` / `FIXED <commit>` / `WONTFIX`.

---

## FIXED `ad0a206` (mouse) + `82c388e` (no-output) — `/understand` in the TUI does nothing, and mouse starts printing garbage again
- **No-output fix (`82c388e`):** the TUI used an ALLOWLIST (`TUI_INLINE_SLASH`)
  to decide which slash commands render into the transcript; everything else
  suspended the alt-screen and printed on the hidden normal screen. `/understand`
  (and every other unlisted display command) was invisible. Inverted to a small
  SUSPEND denylist (`src/cli/tuiSlashRouting.ts` → `slashNeedsSuspend`): capture
  into the transcript is now the DEFAULT; only long-running/streaming/interactive
  commands (plan, solve, delegate, research, review, explore, triage, context-plan,
  tests, check, index, semantic) suspend. New display commands render in the TUI
  automatically. Verified safe: redraws are event-driven only (no timer), so no
  escape sequences leak into the capture buffer during a command's `await`.
- **Mouse fix (`ad0a206`):** `restore()` removed `onStdinData` but readline's internal `"data"`
  handler (attached by `emitKeypressEvents`) self-removes only lazily, so on
  slash-suspend re-entry a plain `stdin.on("data", onStdinData)` landed AFTER the
  stale readline handler — inverting the required order and leaking SGR mouse
  digits. Refactored attach/detach into shared `attachInput()`/`detachInput()`
  helpers; `attachInput` uses `prependListener` so `onStdinData` always runs
  before readline's handler on every (re-)entry. Mouse priority fixed; the
  `/understand` "no output" is the inherent suspend-screen behavior (out of scope).

- **Found:** 2026-06-22 (dogfood)
- **Symptom:** Running `/understand` in the TUI produces no visible output, and
  afterwards the mouse wheel/click starts leaking raw ANSI (`64;36;29M…`) into the
  composer again — i.e. the earlier mouse-garbage fix (`c2e617e`) regresses.
- **Likely cause:** `/understand` is NOT in `TUI_INLINE_SLASH`, so it takes the
  suspend path in `handleSubmit` (`restore()` → `handleSlashCommand` → `enterAlt()`).
  On re-entry the raw-stdin mouse handler (`onStdinData`) and/or the listener
  ordering vs. `emitKeypressEvents` is not restored correctly, so SGR mouse
  sequences are no longer intercepted before readline fragments them. The "does
  nothing" part suggests `/understand`'s output is also being lost (suspended
  screen) rather than surfaced in the transcript.
- **Fix ideas:**
  - In the slash-suspend re-entry, ensure `onStdinData` is re-attached BEFORE the
    keypress listener (so it runs first), mirroring initial setup order; verify
    `restore()`/re-enter symmetry for the `data` listener.
  - Consider adding read-only informational commands like `understand` to
    `TUI_INLINE_SLASH` (capture output into the transcript, no suspend) — though
    `/understand` may be long-running, so the suspend path itself must be correct.
  - Add a regression test around the suspend/re-enter listener wiring if feasible.

---
