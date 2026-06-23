import { test } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";
// [DPR] red anchor: runDelegatePr does not exist yet.
import { runDelegatePr, registerDelegateCommand } from "../../src/cli/delegateCli.js";
import type { WorkerValidation } from "../../src/delegate/types.js";

function val(applyable: boolean): WorkerValidation {
  return {
    status: applyable ? "valid" : "invalid",
    applyable,
    evaluatedAt: "2026-06-24T00:00:00.000Z",
    failures: applyable ? [] : [{ code: "out_of_scope", message: "touched a forbidden path", source: "patch" }],
    warnings: [],
    evidence: [],
  };
}

// [DPR-1] the gate: a NOT-applyable worker must NOT open a PR (the whole safety point).
test("[DPR-1] runDelegatePr refuses to open a PR when validation is not applyable", async () => {
  let opened = 0;
  const res = await runDelegatePr("/root", "p1", "w1", {}, {
    validate: async () => val(false),
    openPr: async () => { opened++; return "https://pr/should-not-happen"; },
  });
  assert.equal(opened, 0, "no PR opened when not applyable");
  assert.notEqual(res.exitCode, 0, "non-zero exit on refusal");
  assert.equal(res.prUrl, undefined);
});

// [DPR-2] applyable → exactly one PR, url returned, verdict carried in the body.
test("[DPR-2] runDelegatePr opens exactly one PR when applyable", async () => {
  let opened = 0;
  let body = "";
  const res = await runDelegatePr("/root", "p1", "w1", {}, {
    validate: async () => val(true),
    openPr: async (b: string) => { opened++; body = b; return "https://pr/1"; },
  });
  assert.equal(opened, 1, "exactly one PR");
  assert.equal(res.exitCode, 0);
  assert.equal(res.prUrl, "https://pr/1");
  assert.match(body, /applyable|valid/i, "PR body carries the gate verdict");
});

// [DPR-3] WIRED: the `delegate pr` subcommand is registered.
test("[DPR-3] registerDelegateCommand registers `delegate pr`", () => {
  const program = new Command();
  registerDelegateCommand(program, { root: "/root" });
  const delegate = program.commands.find((c) => c.name() === "delegate");
  assert.ok(delegate, "delegate command registered");
  assert.ok(delegate!.commands.find((c) => c.name() === "pr"), "delegate pr subcommand registered");
});
