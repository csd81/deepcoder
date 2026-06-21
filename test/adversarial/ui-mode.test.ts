/**
 * Phase 10A (slice 3) — minimal-renderer TUI, testable core (NO deps). SEED
 * (red-first): the safety invariant — a non-TTY session NEVER starts the TUI,
 * even with --tui — so a delegated worker must implement the pure mode resolver
 * (no green-check no-op), then EXTENDS this file with the rest of the pure core
 * (approval interface, frame builder, keymap) from
 * plans/phase10a-scrollable-terminal-ui-plan.md.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveUiMode } from "../../src/ui/uiMode.js";

test("[uimode-nontty-never-tui] a non-TTY session is always plain, even with --tui", () => {
  assert.equal(resolveUiMode({ flag: "tui", env: {}, isTTY: false }), "plain");
  assert.equal(resolveUiMode({ flag: undefined, env: { DEEPCODER_TUI: "1" }, isTTY: false }), "plain");
});
