/**
 * Phase 10F2 — Task Router Policy Layer (deterministic core).
 * Full pure-test coverage from the spec's "Tests" section.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyComplexity, decideRoute } from "../../src/models/taskRouter.js";

// ─────────────────────────────────────────────────────────
// classifyComplexity – pure tests
// ─────────────────────────────────────────────────────────

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
  const d = classifyComplexity({
    role: "edit",
    prompt: "refactor the sandbox permission model across many files",
    mutating: true,
    expectedFiles: ["a", "b", "c", "d"],
  });
  assert.equal(d.complexity, "hard");
});

test("mutating normal one-file task => normal (not simple)", () => {
  const d = classifyComplexity({ role: "edit", prompt: "fix typo in index.ts", mutating: true });
  assert.equal(d.complexity, "normal");
});

test("multi-file (≥3 expected files) without mutating => hard", () => {
  const d = classifyComplexity({
    role: "plan",
    prompt: "update several modules",
    readonly: true,
    expectedFiles: ["a.ts", "b.ts", "c.ts"],
  });
  assert.equal(d.complexity, "hard");
});

test("keyword 'security' alone => hard (even when read-only, non-mutating)", () => {
  const d = classifyComplexity({ role: "research", prompt: "review security posture", readonly: true });
  assert.equal(d.complexity, "hard");
});

test("keyword 'refactor' alone => hard", () => {
  const d = classifyComplexity({ role: "edit", prompt: "refactor the auth module", mutating: true });
  assert.equal(d.complexity, "hard");
});

test("long read-only prompt (non-short) => normal, not simple", () => {
  const longPrompt = "x".repeat(300);
  const d = classifyComplexity({ role: "summarize", prompt: longPrompt, readonly: true });
  assert.equal(d.complexity, "normal");
});

test("classifyComplexity returns risk alongside complexity", () => {
  const simple = classifyComplexity({ role: "summarize", prompt: "hi", readonly: true });
  assert.equal(simple.risk, "low");

  const hard = classifyComplexity({ role: "edit", prompt: "refactor", mutating: true });
  assert.equal(hard.risk, "high");

  const normal = classifyComplexity({ role: "edit", prompt: "small fix", mutating: true, expectedFiles: ["a.ts"] });
  assert.equal(normal.risk, "medium");
});

test("classifyComplexity returns reason array", () => {
  const d = classifyComplexity({ role: "summarize", prompt: "hi", readonly: true });
  assert.ok(Array.isArray(d.reason));
  assert.ok(d.reason.length > 0);
  assert.ok(d.reason.every((r) => typeof r === "string"));
});

// ─────────────────────────────────────────────────────────
// decideRoute – pure tests
// ─────────────────────────────────────────────────────────

test("decideRoute is pure and never leaks an API key in its reason/output", () => {
  const decision = decideRoute(
    { role: "summarize", prompt: "hi", readonly: true },
    { policy: { enabled: false } },
  );
  assert.equal(decision.requestedRole, "summarize");
  assert.ok(Array.isArray(decision.reason));
  assert.ok(!JSON.stringify(decision).toLowerCase().includes("api_key"));
  assert.ok(!JSON.stringify(decision).toLowerCase().includes("sk-"));
  assert.ok(!JSON.stringify(decision).toLowerCase().includes("secret"));
});

test("disabled policy returns original role route (byte-identical)", () => {
  for (const role of ["edit", "summarize", "plan", "review"] as const) {
    const decision = decideRoute(
      { role, prompt: "hello", readonly: role !== "edit" },
      { policy: { enabled: false } },
    );
    assert.equal(decision.selectedRole, role);
    assert.equal(decision.requestedRole, role);
  }
});

test("policy default (undefined policy) is disabled – byte-identical", () => {
  const decision = decideRoute(
    { role: "edit", prompt: "fix", mutating: true },
    {},
  );
  assert.equal(decision.selectedRole, "edit");
  assert.equal(decision.requestedRole, "edit");
});

test("enabled policy maps simple read-only to readOnlySimpleRole", () => {
  const decision = decideRoute(
    { role: "edit", prompt: "summarize this", readonly: true },
    { policy: { enabled: true, readOnlySimpleRole: "summarize" } },
  );
  assert.equal(decision.selectedRole, "summarize");
  assert.ok(decision.reason.some((r) => r.includes("summarize")));
});

test("enabled policy maps simple read-only to simpleRole when readOnlySimpleRole is unset", () => {
  const decision = decideRoute(
    { role: "edit", prompt: "short summary", readonly: true },
    { policy: { enabled: true, simpleRole: "summarize" } },
  );
  assert.equal(decision.selectedRole, "summarize");
});

test("enabled policy maps normal mutating to normalRole", () => {
  const decision = decideRoute(
    { role: "edit", prompt: "fix bug", mutating: true },
    { policy: { enabled: true, normalRole: "edit" } },
  );
  assert.equal(decision.selectedRole, "edit");
});

test("enabled policy maps a hard task to hardRole", () => {
  const decision = decideRoute(
    { role: "edit", prompt: "refactor the auth module", mutating: true },
    { policy: { enabled: true, hardRole: "plan" } },
  );
  assert.equal(decision.selectedRole, "plan");
});

test("enabled policy maps a hard safety task to safetyRole (overrides hardRole)", () => {
  const decision = decideRoute(
    { role: "edit", prompt: "review this for security issues", safetySensitive: true },
    { policy: { enabled: true, safetyRole: "review", hardRole: "plan" } },
  );
  assert.equal(decision.selectedRole, "review");
});

test("mutating task never maps to a read-only role via normalRole", () => {
  const decision = decideRoute(
    { role: "edit", prompt: "fix bug", mutating: true },
    { policy: { enabled: true, normalRole: "summarize" } }, // summarize is read-only
  );
  // Must stay on requested role rather than falling back to a read-only role
  assert.equal(decision.selectedRole, "edit");
});

test("mutating task never maps to a read-only role via hardRole", () => {
  const decision = decideRoute(
    { role: "edit", prompt: "refactor security", mutating: true },
    { policy: { enabled: true, hardRole: "research" } }, // research is read-only
  );
  assert.equal(decision.selectedRole, "edit");
});

test("mutating task never maps to read-only role via safetyRole", () => {
  const decision = decideRoute(
    { role: "edit", prompt: "fix security issue", mutating: true, safetySensitive: true },
    { policy: { enabled: true, safetyRole: "summarize" } },
  );
  assert.equal(decision.selectedRole, "edit");
});

test("unknown policy role value fails closed to requested role", () => {
  const decision = decideRoute(
    { role: "edit", prompt: "fix bug", mutating: true },
    // @ts-expect-error testing malformed policy value (not a ModelRole)
    { policy: { enabled: true, normalRole: "nonexistent" } },
  );
  assert.equal(decision.selectedRole, "edit");
});

test("decision output contains route info and can include a resolved route", () => {
  const decision = decideRoute(
    { role: "summarize", prompt: "hi", readonly: true },
    { policy: { enabled: false } },
  );
  assert.ok(decision.route);
  assert.equal(decision.route.role, decision.selectedRole);
  assert.equal(typeof decision.route.provider, "string");
  assert.equal(typeof decision.route.model, "string");
  assert.equal(typeof decision.route.baseUrl, "string");
  assert.equal(decision.route.source, "default");
});

test("enabled policy + safety-senstive => decision reason mentions safety", () => {
  const decision = decideRoute(
    { role: "research", prompt: "audit", safetySensitive: true },
    { policy: { enabled: true, safetyRole: "review" } },
  );
  assert.equal(decision.selectedRole, "review");
  assert.ok(decision.reason.some((r) => r.toLowerCase().includes("safety")));
});

test("classifyComplexity with hard keyword 'sandbox' => hard", () => {
  const d = classifyComplexity({ role: "research", prompt: "check sandbox isolation", readonly: true });
  assert.equal(d.complexity, "hard");
});

test("classifyComplexity with keyword 'permission' => hard", () => {
  const d = classifyComplexity({ role: "edit", prompt: "fix permission check", mutating: true });
  assert.equal(d.complexity, "hard");
});

test("classifyComplexity with keyword 'migration' => hard", () => {
  const d = classifyComplexity({ role: "plan", prompt: "plan database migration", readonly: true });
  assert.equal(d.complexity, "hard");
});

test("classifyComplexity with keyword 'swe-bench' => hard", () => {
  const d = classifyComplexity({ role: "edit", prompt: "solve SWE-bench issue", mutating: true });
  assert.equal(d.complexity, "hard");
});

test("classifyComplexity: 2 expected files is not multi-file (not >= 3)", () => {
  const d = classifyComplexity({
    role: "edit",
    prompt: "update two files",
    mutating: true,
    expectedFiles: ["a.ts", "b.ts"],
  });
  // 2 files is < 3, no hard keyword → normal
  assert.equal(d.complexity, "normal");
});
