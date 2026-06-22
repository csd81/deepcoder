/**
 * Turn-cap policy. The cap is a runaway guard; interactively the human is the
 * guard (and can Ctrl-C), so an interactive session gets a generous floor so a
 * plan implementation doesn't abort mid-flight at the headless default. An
 * explicit DEEPCODER_MAX_TURNS is always respected verbatim, both directions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveMaxTurns, INTERACTIVE_MAX_TURNS } from "../../src/config/config.js";

test("headless keeps the configured cap", () => {
  assert.equal(effectiveMaxTurns({ configMaxTurns: 40, interactive: false, envExplicit: false }), 40);
});

test("interactive with the DEFAULT cap is raised to the interactive floor", () => {
  assert.equal(effectiveMaxTurns({ configMaxTurns: 40, interactive: true, envExplicit: false }), INTERACTIVE_MAX_TURNS);
  assert.ok(INTERACTIVE_MAX_TURNS >= 150, "floor should comfortably cover a plan implementation");
});

test("an explicit env cap is respected verbatim even when interactive", () => {
  assert.equal(effectiveMaxTurns({ configMaxTurns: 25, interactive: true, envExplicit: true }), 25);
  assert.equal(effectiveMaxTurns({ configMaxTurns: 500, interactive: true, envExplicit: true }), 500);
});

test("an explicit cap higher than the floor wins when not interactive too", () => {
  assert.equal(effectiveMaxTurns({ configMaxTurns: 300, interactive: false, envExplicit: true }), 300);
});

test("interactive never lowers a config cap already above the floor", () => {
  assert.equal(effectiveMaxTurns({ configMaxTurns: 400, interactive: true, envExplicit: false }), 400);
});
