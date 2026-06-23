import { test } from "node:test";
import assert from "node:assert/strict";
// [RP] red anchor on baseline: the module does not exist yet.
import {
  serializePlanHandoff,
  planFromImport,
  type PlanHandoffSession,
} from "../src/session/planHandoff.js";
import { validateImport } from "../src/session/sessionExport.js";

function handoff(over: Partial<PlanHandoffSession> = {}): PlanHandoffSession {
  return {
    id: "s1",
    model: "deepseek-v4-flash",
    mode: "ask",
    messages: [{ role: "user", content: "do the thing" }],
    todos: [],
    readTracker: [],
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    plan: { text: "1. step one\n2. step two", approvedAt: "2026-06-02T00:00:00.000Z" },
    ...over,
  } as PlanHandoffSession;
}

// [RP-1] serialize a session with a plan → v1 envelope carrying the plan.
test("[RP-1] serializePlanHandoff produces a v1 export carrying the plan", () => {
  const exp = serializePlanHandoff(handoff());
  assert.equal(exp.version, 1);
  assert.equal((exp.session as PlanHandoffSession).plan?.text, "1. step one\n2. step two");
  const v = validateImport(exp);
  assert.equal(v.ok, true);
});

// [RP-2] always sanitizes — a secret in a message is redacted in the blob.
test("[RP-2] serializePlanHandoff always sanitizes message content", () => {
  const exp = serializePlanHandoff(handoff({
    messages: [{ role: "user", content: "token sk-ABCDEF123456 inline" }],
  }));
  const blob = JSON.stringify(exp);
  assert.ok(!blob.includes("sk-ABCDEF123456"), "raw secret never serialized");
  assert.ok(blob.includes("sk-***"), "redacted form present");
});

// [RP-3] throws when there is no approved plan.
test("[RP-3] serializePlanHandoff throws without an approved plan", () => {
  const noPlan = handoff();
  delete (noPlan as { plan?: unknown }).plan;
  assert.throws(() => serializePlanHandoff(noPlan), /plan/i);
});

// [RP-4] full round-trip: serialize → stringify → parse → validateImport → planFromImport.
test("[RP-4] plan round-trips through JSON + validateImport", () => {
  const exp = serializePlanHandoff(handoff());
  const roundTripped = JSON.parse(JSON.stringify(exp));
  const v = validateImport(roundTripped);
  assert.equal(v.ok, true);
  assert.equal(planFromImport(v.session as PlanHandoffSession), "1. step one\n2. step two");
});

// [RP-5] planFromImport returns undefined when there is no plan.
test("[RP-5] planFromImport returns undefined without a plan", () => {
  const noPlan = handoff();
  delete (noPlan as { plan?: unknown }).plan;
  assert.equal(planFromImport(noPlan), undefined);
});
