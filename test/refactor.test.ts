/**
 * `/refactor` command — pure helpers.
 *
 * /refactor is a thin wrapper over the existing /solve wiring (runSolveCommand):
 * it parses `<check-name> <description>` like /solve and seeds a steering prompt
 * that points the model at the impact tools and an atomic apply_patch. The arg
 * parsing and prompt are pure and unit-tested here; the case handler is thin.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRefactorArgs, buildRefactorPrompt } from "../src/cli/refactor.js";

test("[refactor-args-ok] parses a check name and the rest as the description", () => {
  const r = parseRefactorArgs("phase rename displayPath to formatPath");
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.checkName, "phase");
    assert.equal(r.description, "rename displayPath to formatPath");
  }
});

test("[refactor-args-missing-desc] a check name with no description is a usage error", () => {
  const r = parseRefactorArgs("phase");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.usage, /usage: \/refactor/i);
});

test("[refactor-args-empty] empty input is a usage error", () => {
  assert.equal(parseRefactorArgs("").ok, false);
  assert.equal(parseRefactorArgs("   ").ok, false);
});

test("[refactor-args-trim] extra whitespace between check and description collapses", () => {
  const r = parseRefactorArgs("  phase   extract the http client  ");
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.checkName, "phase");
    assert.equal(r.description, "extract the http client");
  }
});

test("[refactor-prompt-steers] the prompt names the impact tools and the atomic-patch expectation", () => {
  const p = buildRefactorPrompt("rename displayPath to formatPath");
  assert.match(p, /impact_graph/);
  assert.match(p, /find_references/);
  assert.match(p, /apply_patch/);
  // It carries the user's description so the model knows the target.
  assert.match(p, /rename displayPath to formatPath/);
});

test("[refactor-prompt-bounded] the steering prompt stays small (rides the per-run prefix)", () => {
  const p = buildRefactorPrompt("x".repeat(50));
  assert.ok(p.length < 1200, `prompt should be compact, got ${p.length}`);
});
