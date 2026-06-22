/**
 * atomicWrite used a static `${file}.tmp`, so concurrent savePlan calls for the
 * same plan (parallel worker processes/tasks) collided on one temp file: one
 * rename consumes the tmp, a sibling's rename then ENOENTs (rejection) or the
 * tmp is half-written (corruption). A per-write unique tmp fixes it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { savePlan, loadPlan } from "../../src/delegate/store.js";
import type { DelegationPlan } from "../../src/delegate/types.js";

function plan(): DelegationPlan {
  return {
    id: "p1", task: "t", createdAt: new Date().toISOString(), status: "planned",
    workers: [{
      id: "w1", title: "t", prompt: "p", checkName: "phase", allowedPaths: ["a"],
      forbiddenPaths: [], maxAttempts: 1, dependsOn: [], expectedOutputs: [], status: "planned",
    }],
    dependencies: [], globalChecks: [], riskNotes: [],
  };
}

test("concurrent savePlan to the same plan never collides on a shared tmp", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "store-race-"));
  try {
    const saves = Array.from({ length: 20 }, (_, i) => {
      const p = plan();
      p.task = `task-${i}`;
      return savePlan(root, p);
    });
    await assert.doesNotReject(Promise.all(saves), "concurrent saves must not race on a shared tmp file");
    const loaded = await loadPlan(root, "p1");
    assert.ok(loaded, "plan.json must remain valid/parseable after the race");
    assert.equal(loaded!.id, "p1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
