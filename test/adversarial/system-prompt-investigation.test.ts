/**
 * Open-ended investigation ("find a bug", "diagnose X") must be FOCUSED, not a
 * whole-repo sweep that ends in a hedged, unverified claim. The system prompt
 * therefore carries an investigation playbook: form a hypothesis and narrow,
 * VERIFY before claiming (trace the exact code or write a failing test), and
 * deliver a definitive conclusion citing the file:line — or report none found.
 *
 * This guards against the dogfood regression where the agent broad-swept the
 * codebase and reported a false-positive "critical bug" it never proved.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt } from "../../src/agent/systemPrompt.js";

test("system prompt carries a focused-investigation playbook", () => {
  const p = buildSystemPrompt({ workspaceRoot: "/tmp/x", mode: "ask" });
  // it names the investigation/diagnosis case explicitly
  assert.match(p, /investigat|diagnos/i);
  // form a hypothesis and narrow rather than sweep the whole repo
  assert.match(p, /hypothesis/i);
  assert.match(p, /narrow|smallest|do not sweep|don't sweep/i);
  // verify/prove before claiming — no unverified bug reports
  assert.match(p, /verif|prove/i);
});

test("investigation playbook demands a definitive, located conclusion", () => {
  const p = buildSystemPrompt({ workspaceRoot: "/tmp/x", mode: "ask" });
  // cite the location (file:line) and state the fix, or report none found
  assert.match(p, /file:line|cite|location/i);
  assert.match(p, /none|no bug|nothing/i);
});
