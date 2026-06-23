import { test } from "node:test";
import assert from "node:assert/strict";
import { initEscalation, escalationRole, decideStartEscalation } from "../src/models/escalation.js";

test("[escalation] escalationRole maps escalated→plan, else→edit", () => {
  assert.equal(escalationRole(undefined), "edit");
  assert.equal(escalationRole(initEscalation()), "edit");
  assert.equal(escalationRole({ escalated: true, reason: "high-complexity" }), "plan");
});

test("[escalation] decideStartEscalation: hard + no manual override → escalate", () => {
  const s = decideStartEscalation("hard", false);
  assert.equal(s.escalated, true);
  assert.equal(s.reason, "high-complexity");
});

test("[escalation] decideStartEscalation: manual override always wins (no escalate)", () => {
  assert.equal(decideStartEscalation("hard", true).escalated, false);
});

test("[escalation] decideStartEscalation: simple/normal → no escalate", () => {
  assert.equal(decideStartEscalation("simple", false).escalated, false);
  assert.equal(decideStartEscalation("normal", false).escalated, false);
});
