import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initPlanMode,
  enterPlanMode,
  recordPlan,
  approvePlan,
  rejectPlan,
  exitPlanMode,
  effectivePlanModeApproval,
} from "../src/cli/planMode.js";
import { checkPermission } from "../src/permissions/policy.js";
import type { ToolInvocation } from "../src/tools/types.js";

// Red-seed anchor (do NOT weaken these assertions). The worker implements
// src/cli/planMode.ts (a PURE state machine, no I/O) to make these pass.

test("happy path: init -> enter(auto) -> record -> approve -> executing, priorMode round-trips", () => {
  let s = initPlanMode();
  assert.equal(s.phase, "off");
  s = enterPlanMode(s, "auto");
  assert.equal(s.phase, "investigating");
  assert.equal(s.priorMode, "auto");
  s = recordPlan(s, "1. do the thing");
  assert.equal(s.phase, "awaiting-approval");
  assert.equal(s.plan, "1. do the thing");
  s = approvePlan(s);
  assert.equal(s.phase, "executing");
});

test("effectivePlanModeApproval is read-only until executing, then the base mode", () => {
  let s = enterPlanMode(initPlanMode(), "auto");
  assert.equal(effectivePlanModeApproval(s, "auto"), "readonly");
  s = recordPlan(s, "p");
  assert.equal(effectivePlanModeApproval(s, "auto"), "readonly");
  s = approvePlan(s);
  assert.equal(effectivePlanModeApproval(s, "auto"), "auto");
  assert.equal(effectivePlanModeApproval(initPlanMode(), "ask"), "ask"); // off -> base
});

test("illegal transitions are no-ops", () => {
  const investigating = enterPlanMode(initPlanMode(), "auto");
  assert.deepEqual(approvePlan(investigating), investigating, "approve only from awaiting-approval");
  const off = initPlanMode();
  assert.deepEqual(recordPlan(off, "p"), off, "record only while investigating");
});

test("reject returns to investigating and clears the plan", () => {
  let s = recordPlan(enterPlanMode(initPlanMode(), "auto"), "p");
  s = rejectPlan(s);
  assert.equal(s.phase, "investigating");
  assert.equal(s.plan, null);
});

test("exitPlanMode returns to off", () => {
  const s = exitPlanMode(recordPlan(enterPlanMode(initPlanMode(), "auto"), "p"));
  assert.equal(s.phase, "off");
});

test("permission gate: a mutate is denied while investigating, allowed once executing", () => {
  const mutate = { kind: "mutate", source: "builtin", command: "edit_file" } as unknown as ToolInvocation;
  let s = enterPlanMode(initPlanMode(), "auto");
  assert.equal(checkPermission(mutate, effectivePlanModeApproval(s, "auto"), { mcpExecuteEnabled: false }), "deny");
  s = approvePlan(recordPlan(s, "p"));
  assert.notEqual(checkPermission(mutate, effectivePlanModeApproval(s, "auto"), { mcpExecuteEnabled: false }), "deny");
});
