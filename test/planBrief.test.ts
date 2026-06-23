import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlanBrief, renderPlanBrief } from "../src/context/planBrief.js";
import type { PlanBrief } from "../src/context/planBrief.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function validPlanJson(): string {
  return JSON.stringify({
    summary: "Add an architect planner subagent",
    orderedSteps: [
      {
        id: "s1",
        description: "Define the PlanBrief schema",
        filesToTouch: ["src/context/planBrief.ts"],
        testsToAddOrRun: ["test/planBrief.test.ts"],
        rationale: "Need a typed, validated plan structure",
        dependsOn: [],
      },
      {
        id: "s2",
        description: "Write the planner runner",
        filesToTouch: ["src/subagents/architectPlanner.ts"],
        testsToAddOrRun: ["test/architectPlanner.test.ts"],
        rationale: "Runs the subagent and parses output",
        dependsOn: ["s1"],
      },
    ],
    risks: ["Model may emit cyclic dependencies"],
    assumptions: ["The explorer brief is available"],
    openQuestions: ["Should the plan be persisted as JSON too?"],
    trace: [{ toolsCalled: ["read_file"], turns: 2, model: "test-model" }],
  });
}

/* ------------------------------------------------------------------ */
/*  parsePlanBrief — valid input                                       */
/* ------------------------------------------------------------------ */

test("parsePlanBrief parses a valid plan correctly", () => {
  const plan = parsePlanBrief(validPlanJson());
  assert.equal(plan.summary, "Add an architect planner subagent");
  assert.equal(plan.orderedSteps.length, 2);
  assert.equal(plan.risks.length, 1);
  assert.equal(plan.assumptions.length, 1);
  assert.equal(plan.openQuestions.length, 1);
  assert.equal(plan.trace.length, 1);
});

test("parsePlanBrief preserves step fields", () => {
  const plan = parsePlanBrief(validPlanJson());
  const s2 = plan.orderedSteps.find((s) => s.id === "s2")!;
  assert.equal(s2.description, "Write the planner runner");
  assert.deepEqual(s2.filesToTouch, ["src/subagents/architectPlanner.ts"]);
  assert.deepEqual(s2.testsToAddOrRun, ["test/architectPlanner.test.ts"]);
  assert.equal(s2.rationale, "Runs the subagent and parses output");
  assert.deepEqual(s2.dependsOn, ["s1"]);
});

/* ------------------------------------------------------------------ */
/*  parsePlanBrief — malformed / never throws                         */
/* ------------------------------------------------------------------ */

function emptyAsserts(plan: PlanBrief): void {
  assert.equal(plan.summary, "");
  assert.deepEqual(plan.orderedSteps, []);
  assert.deepEqual(plan.risks, []);
  assert.deepEqual(plan.assumptions, []);
  assert.deepEqual(plan.openQuestions, []);
  assert.deepEqual(plan.trace, []);
}

test("parsePlanBrief returns empty plan for null", () => {
  emptyAsserts(parsePlanBrief(null as unknown as string));
});

test("parsePlanBrief returns empty plan for empty string", () => {
  emptyAsserts(parsePlanBrief(""));
});

test("parsePlanBrief returns empty plan for malformed JSON", () => {
  emptyAsserts(parsePlanBrief("not valid json"));
});

test("parsePlanBrief returns empty plan for JSON array", () => {
  emptyAsserts(parsePlanBrief("[]"));
});

test("parsePlanBrief returns empty plan for JSON null", () => {
  emptyAsserts(parsePlanBrief("null"));
});

test("parsePlanBrief never throws on any input", () => {
  const inputs = [
    null, undefined, "", "   ", "{{{bad", "not json", "null", "true", "42",
    '"string"', "[]", "{}", "{invalid", "\0",
  ];
  for (const input of inputs) {
    const plan = parsePlanBrief(input as unknown as string);
    assert.ok(typeof plan.summary === "string");
    assert.ok(Array.isArray(plan.orderedSteps));
    assert.ok(Array.isArray(plan.openQuestions));
  }
});

test("parsePlanBrief drops steps without a description", () => {
  const json = JSON.stringify({
    summary: "x",
    orderedSteps: [
      { id: "s1", description: "", dependsOn: [] },
      { id: "s2", description: "real step", dependsOn: [] },
    ],
  });
  const plan = parsePlanBrief(json);
  assert.equal(plan.orderedSteps.length, 1);
  assert.equal(plan.orderedSteps[0]!.description, "real step");
});

/* ------------------------------------------------------------------ */
/*  parsePlanBrief — DAG validation                                    */
/* ------------------------------------------------------------------ */

test("parsePlanBrief topologically sorts steps", () => {
  const json = JSON.stringify({
    summary: "x",
    orderedSteps: [
      { id: "s1", description: "depends on s2", dependsOn: ["s2"] },
      { id: "s2", description: "no deps", dependsOn: [] },
    ],
  });
  const plan = parsePlanBrief(json);
  const ids = plan.orderedSteps.map((s) => s.id);
  // s2 must come before s1 since s1 depends on s2
  assert.ok(ids.indexOf("s2") < ids.indexOf("s1"), `expected s2 before s1, got ${ids.join(",")}`);
});

test("parsePlanBrief drops dangling dependsOn references and notes them", () => {
  const json = JSON.stringify({
    summary: "x",
    orderedSteps: [
      { id: "s1", description: "depends on missing step", dependsOn: ["s99"] },
    ],
  });
  const plan = parsePlanBrief(json);
  assert.equal(plan.orderedSteps.length, 1);
  assert.deepEqual(plan.orderedSteps[0]!.dependsOn, []);
  assert.ok(
    plan.openQuestions.some((q) => /depend/i.test(q)),
    `expected an open question about the dropped dependency, got ${JSON.stringify(plan.openQuestions)}`,
  );
});

test("parsePlanBrief drops self-dependencies", () => {
  const json = JSON.stringify({
    summary: "x",
    orderedSteps: [{ id: "s1", description: "self dep", dependsOn: ["s1"] }],
  });
  const plan = parsePlanBrief(json);
  assert.deepEqual(plan.orderedSteps[0]!.dependsOn, []);
});

test("parsePlanBrief breaks dependency cycles and notes them", () => {
  const json = JSON.stringify({
    summary: "x",
    orderedSteps: [
      { id: "s1", description: "a", dependsOn: ["s2"] },
      { id: "s2", description: "b", dependsOn: ["s1"] },
    ],
  });
  const plan = parsePlanBrief(json);
  // Both steps survive; the cycle is broken (no node depends on a later node circularly)
  assert.equal(plan.orderedSteps.length, 2);
  assert.ok(
    plan.openQuestions.some((q) => /cycle/i.test(q)),
    `expected an open question about the broken cycle, got ${JSON.stringify(plan.openQuestions)}`,
  );
});

test("parsePlanBrief assigns ids to steps missing one", () => {
  const json = JSON.stringify({
    summary: "x",
    orderedSteps: [
      { description: "no id here", dependsOn: [] },
      { description: "also no id", dependsOn: [] },
    ],
  });
  const plan = parsePlanBrief(json);
  assert.equal(plan.orderedSteps.length, 2);
  const ids = plan.orderedSteps.map((s) => s.id);
  assert.ok(ids[0]!.length > 0 && ids[1]!.length > 0);
  assert.notEqual(ids[0], ids[1]);
});

test("parsePlanBrief bounds the number of steps", () => {
  const many = Array.from({ length: 100 }, (_, i) => ({
    id: `s${i}`,
    description: `step ${i}`,
    dependsOn: [],
  }));
  const plan = parsePlanBrief(JSON.stringify({ summary: "x", orderedSteps: many }));
  assert.ok(plan.orderedSteps.length <= 30, `expected bounded steps, got ${plan.orderedSteps.length}`);
});

test("parsePlanBrief dedupes risks and assumptions", () => {
  const json = JSON.stringify({
    summary: "x",
    risks: ["r", "r", "r2"],
    assumptions: ["a", "a"],
  });
  const plan = parsePlanBrief(json);
  assert.equal(plan.risks.length, 2);
  assert.equal(plan.assumptions.length, 1);
});

/* ------------------------------------------------------------------ */
/*  renderPlanBrief                                                    */
/* ------------------------------------------------------------------ */

test("renderPlanBrief contains key sections", () => {
  const plan = parsePlanBrief(validPlanJson());
  const rendered = renderPlanBrief(plan);
  assert.ok(rendered.includes("Summary:"));
  assert.ok(rendered.includes("Steps"));
  assert.ok(rendered.includes("Risks"));
  assert.ok(rendered.includes("Assumptions"));
  assert.ok(rendered.includes("Open questions"));
});

test("renderPlanBrief shows step dependencies", () => {
  const plan = parsePlanBrief(validPlanJson());
  const rendered = renderPlanBrief(plan);
  assert.ok(rendered.includes("Write the planner runner"));
  assert.ok(rendered.includes("s1")); // s2 depends on s1
});

test("renderPlanBrief returns '(empty plan)' for empty plan", () => {
  const rendered = renderPlanBrief(parsePlanBrief(""));
  assert.equal(rendered, "(empty plan)");
});

test("renderPlanBrief bounds output to maxBytes", () => {
  const plan = parsePlanBrief(validPlanJson());
  const rendered = renderPlanBrief(plan, 80);
  assert.ok(rendered.length <= 200, `expected bounded, got ${rendered.length}`);
  assert.ok(rendered.includes("truncated"));
});
