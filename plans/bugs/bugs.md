# Known bugs (TUI dogfooding)

Living log of bugs found while dogfooding `npm run dev -- --tui`. Newest first.
Status: `OPEN` / `FIXED <commit>` / `WONTFIX`.

---

## OPEN — `/understand` in the TUI does nothing, and mouse starts printing garbage again
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
