/**
 * Phase 10A (slice 3) — minimal-renderer TUI, testable core (NO deps). SEED
 * (red-first): the safety invariant — a non-TTY session NEVER starts the TUI,
 * even with --tui — so a delegated worker must implement the pure mode resolver
 * (no green-check no-op), then EXTENDS this file with the rest of the pure core
 * (approval interface, frame builder, keymap) from
 * plans/ui/phase10a-scrollable-terminal-ui-plan.md.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveUiMode } from "../../src/ui/uiMode.js";

test("[uimode-nontty-never-tui] a non-TTY session is always plain, even with --tui", () => {
  assert.equal(resolveUiMode({ flag: "tui", env: {}, isTTY: false }), "plain");
  assert.equal(resolveUiMode({ flag: undefined, env: { DEEPCODER_TUI: "1" }, isTTY: false }), "plain");
});

test("[uimode-tty-flag-tui] TTY + --tui flag resolves to tui", () => {
  assert.equal(resolveUiMode({ flag: "tui", env: {}, isTTY: true }), "tui");
});

test("[uimode-tty-flag-plain] TTY + --no-tui (flag plain) resolves to plain", () => {
  assert.equal(resolveUiMode({ flag: "plain", env: {}, isTTY: true }), "plain");
});

test("[uimode-tty-default] TTY + no flag, no env resolves to plain (v1 default)", () => {
  assert.equal(resolveUiMode({ flag: undefined, env: {}, isTTY: true }), "plain");
});

test("[uimode-tty-env-tui] TTY + DEEPCODER_TUI=1 resolves to tui", () => {
  assert.equal(resolveUiMode({ flag: undefined, env: { DEEPCODER_TUI: "1" }, isTTY: true }), "tui");
});

test("[uimode-tty-env-tui-0] TTY + DEEPCODER_TUI=0 resolves to plain", () => {
  assert.equal(resolveUiMode({ flag: undefined, env: { DEEPCODER_TUI: "0" }, isTTY: true }), "plain");
});

test("[uimode-env-ui-overrides-tui] DEEPCODER_UI=plain overrides DEEPCODER_TUI=1", () => {
  assert.equal(
    resolveUiMode({ flag: undefined, env: { DEEPCODER_UI: "plain", DEEPCODER_TUI: "1" }, isTTY: true }),
    "plain",
  );
});

test("[uimode-env-ui-tui] DEEPCODER_UI=tui resolves to tui", () => {
  assert.equal(resolveUiMode({ flag: undefined, env: { DEEPCODER_UI: "tui" }, isTTY: true }), "tui");
});

test("[uimode-flag-overrides-env] flag overrides DEEPCODER_UI env var", () => {
  assert.equal(
    resolveUiMode({ flag: "plain", env: { DEEPCODER_UI: "tui" }, isTTY: true }),
    "plain",
  );
  assert.equal(
    resolveUiMode({ flag: "tui", env: { DEEPCODER_UI: "plain" }, isTTY: true }),
    "tui",
  );
});
