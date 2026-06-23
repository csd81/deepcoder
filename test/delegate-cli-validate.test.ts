import { test } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";
// [DCV] red anchor on baseline: the module does not exist yet.
import { runDelegateValidate, registerDelegateCommand } from "../src/cli/delegateCli.js";
import type { WorkerValidation } from "../src/delegate/types.js";

function fakeValidation(applyable: boolean): WorkerValidation {
  return {
    status: applyable ? "valid" : "invalid",
    applyable,
    evaluatedAt: "2026-06-23T00:00:00.000Z",
    failures: applyable ? [] : [{ code: "out_of_scope", message: "touched a forbidden path", source: "patch" }],
    warnings: [],
    evidence: [],
  };
}

// [DCV-1] all-workers mode: exit 0 only when EVERY worker is applyable.
test("[DCV-1] runDelegateValidate exits non-zero if any worker is not applyable", async () => {
  const plan = { id: "p1", workers: [{ id: "w1" }, { id: "w2" }] };
  const validations: Record<string, boolean> = { w1: true, w2: false };
  const res = await runDelegateValidate("/root", "p1", undefined, {}, {
    loadPlan: async () => plan as any,
    validate: async (_r, _p, wid) => fakeValidation(validations[wid]),
  });
  assert.equal(res.results.length, 2);
  assert.equal(res.exitCode, 1, "w2 is not applyable → non-zero");
});

// [DCV-2] single applyable worker → exit 0.
test("[DCV-2] runDelegateValidate exits 0 for a single applyable worker", async () => {
  const plan = { id: "p1", workers: [{ id: "w1" }, { id: "w2" }] };
  const res = await runDelegateValidate("/root", "p1", "w1", {}, {
    loadPlan: async () => plan as any,
    validate: async () => fakeValidation(true),
  });
  assert.equal(res.results.length, 1);
  assert.equal(res.results[0].workerId, "w1");
  assert.equal(res.exitCode, 0);
});

// [DCV-3] missing plan → distinct non-zero exit, no validations.
test("[DCV-3] runDelegateValidate exits 2 when the plan is not found", async () => {
  const res = await runDelegateValidate("/root", "nope", undefined, {}, {
    loadPlan: async () => null,
    validate: async () => fakeValidation(true),
  });
  assert.equal(res.exitCode, 2);
  assert.equal(res.results.length, 0);
});

// [DCV-4] WIRED: registerDelegateCommand adds a `delegate validate` subcommand to a
// commander program (anchors the CLI wiring; main.ts calls this).
test("[DCV-4] registerDelegateCommand registers `delegate validate`", () => {
  const program = new Command();
  registerDelegateCommand(program, { root: "/root" });
  const delegate = program.commands.find((c) => c.name() === "delegate");
  assert.ok(delegate, "delegate command registered");
  const validate = delegate!.commands.find((c) => c.name() === "validate");
  assert.ok(validate, "delegate validate subcommand registered");
});
