/**
 * Phase 10F2 — Task Router Policy Layer (deterministic core).
 * Red seed: forces an implementation of src/models/taskRouter.ts.
 * The worker MUST keep these green AND add the full coverage from
 * plans/routing/phase10f2-task-router-policy-layer-plan.md (Tests section).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyComplexity, decideRoute } from "../../src/models/taskRouter.js";

test("short read-only summary => simple", () => {
  const d = classifyComplexity({ role: "summarize", prompt: "summarize this file", readonly: true });
  assert.equal(d.complexity, "simple");
});

test("a mutating task is never simple", () => {
  const d = classifyComplexity({ role: "edit", prompt: "x", mutating: true });
  assert.notEqual(d.complexity, "simple");
});

test("a safety-sensitive task is always hard", () => {
  const d = classifyComplexity({ role: "review", prompt: "ok", safetySensitive: true });
  assert.equal(d.complexity, "hard");
});

test("a security / multi-file prompt => hard", () => {
  const d = classifyComplexity({ role: "edit", prompt: "refactor the sandbox permission model across many files", mutating: true, expectedFiles: ["a","b","c","d"] });
  assert.equal(d.complexity, "hard");
});

test("decideRoute is pure and never leaks an API key in its reason/output", () => {
  const decision = decideRoute(
    { role: "summarize", prompt: "hi", readonly: true },
    { policy: { enabled: false } },
  );
  assert.equal(decision.requestedRole, "summarize");
  assert.ok(Array.isArray(decision.reason));
  assert.ok(!JSON.stringify(decision).toLowerCase().includes("api_key"));
  assert.ok(!JSON.stringify(decision).toLowerCase().includes("sk-"));
});
