import { test } from "node:test";
import assert from "node:assert/strict";
import { slashNeedsSuspend } from "../src/cli/tuiSlashRouting.js";

// In the TUI, display/read-only slash commands must render INTO the transcript
// (captured), not suspend the alt-screen and print on the normal screen where
// the user can't see them. Only long-running/streaming/interactive commands
// (which await for seconds, stream via onData, or read stdin) suspend — capturing
// those would buffer their output and let the redraw loop's escapes leak in.

test("display commands render inline (do NOT suspend) — this is the default", () => {
  for (const cmd of [
    "understand", "help", "status", "models", "model", "effort", "mode",
    "usage", "cost", "context", "doctor", "memory", "skills", "plugins",
    "mcp", "isolation", "sandbox", "diff", "permissions", "compact", "save",
    "hooks", "copy", "checkpoints", "rollback", "stop", "todos", "checks",
  ]) {
    assert.equal(slashNeedsSuspend(cmd), false, `/${cmd} should render inline in the TUI`);
  }
});

test("long-running / streaming / interactive commands suspend the alt-screen", () => {
  for (const cmd of [
    "plan", "solve", "delegate", "research", "review", "explore",
    "triage", "context-plan", "tests", "check", "index", "semantic",
  ]) {
    assert.equal(slashNeedsSuspend(cmd), true, `/${cmd} should suspend the TUI (it streams / reads input)`);
  }
});

test("matching is case-insensitive and unknown commands render inline", () => {
  assert.equal(slashNeedsSuspend("SOLVE"), true);
  assert.equal(slashNeedsSuspend("Understand"), false);
  assert.equal(slashNeedsSuspend("totally-unknown-command"), false);
});
