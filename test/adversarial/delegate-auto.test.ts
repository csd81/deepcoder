/**
 * Slice AUTO — `runDelegateAuto` chains plan → run → validate → pr into one
 * autonomous command. Every test injects seams; no live model, no worktree.
 *
 * [AUTO-1] all workers applyable → pr called once per worker, prUrls populated, exit 0
 * [AUTO-2] a worker NOT applyable → NO pr for it, exit non-zero (the gate)
 * [AUTO-3] --no-pr → no pr calls regardless of applyable; exit reflects validation
 * [AUTO-4] WIRED: `delegate auto` subcommand registered
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Command } from "commander";
// [AUTO] red anchor: runDelegateAuto does not exist yet.
import { runDelegateAuto, registerDelegateCommand } from "../../src/cli/delegateCli.js";
import { savePlan } from "../../src/delegate/store.js";
import type { DelegationPlan, WorkerValidation } from "../../src/delegate/types.js";

/* ---------------- helpers ---------------- */

function val(applyable: boolean): WorkerValidation {
  return {
    status: applyable ? "valid" : "invalid",
    applyable,
    evaluatedAt: "2026-07-01T00:00:00.000Z",
    failures: applyable ? [] : [{ code: "check_failed", message: "tests not green", source: "run" }],
    warnings: [],
    evidence: [],
  };
}

async function makePlan(root: string, workerIds: string[]): Promise<DelegationPlan> {
  const plan: DelegationPlan = {
    id: `auto-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    task: "auto task",
    createdAt: new Date().toISOString(),
    status: "planned",
    workers: workerIds.map((id) => ({
      id,
      title: `Worker ${id}`,
      prompt: `Task for ${id}`,
      allowedPaths: [`src/${id}.ts`],
      forbiddenPaths: [],
      checkName: "phase",
      maxAttempts: 3,
      dependsOn: [],
      expectedOutputs: [],
      status: "planned" as const,
    })),
    dependencies: [],
    globalChecks: [],
    riskNotes: [],
  };
  await savePlan(root, plan);
  return plan;
}

async function tmpdirAsync(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "delegate-auto-test-"));
}

/* ---------------- AUTO-1: all applyable → pr per worker, exit 0 ---------------- */

test("[AUTO-1] all workers applyable → pr called once per worker, prUrls populated, exit 0", async () => {
  const root = await tmpdirAsync();
  try {
    const plan = await makePlan(root, ["w1", "w2"]);

    const prCalls: { planId: string; workerId: string }[] = [];
    const res = await runDelegateAuto(root, "some task", {}, {
      plan: async (_r, _t, _o) => ({ exitCode: 0, planId: plan.id }),
      run: async () => ({ exitCode: 0, result: null }),
      validate: async (_r, _p, workerId) => {
        // w1 applyable, w2 applyable
        return val(true);
      },
      pr: async (_r, planId, workerId) => {
        prCalls.push({ planId, workerId });
        return { exitCode: 0, prUrl: `https://pr/${workerId}` };
      },
    });

    assert.equal(res.exitCode, 0, "exit 0 when all applyable");
    assert.equal(res.planId, plan.id);
    assert.equal(prCalls.length, 2, "pr called once per worker");
    assert.equal(prCalls[0].workerId, "w1");
    assert.equal(prCalls[1].workerId, "w2");
    assert.deepStrictEqual(res.prUrls, ["https://pr/w1", "https://pr/w2"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/* ---------------- AUTO-2: a worker NOT applyable → NO pr for it, exit non-zero ---------------- */

test("[AUTO-2] a worker NOT applyable → NO pr for it, exit non-zero (the gate)", async () => {
  const root = await tmpdirAsync();
  try {
    const plan = await makePlan(root, ["w1", "w2"]);

    const prCalls: string[] = [];
    const res = await runDelegateAuto(root, "some task", {}, {
      plan: async (_r, _t, _o) => ({ exitCode: 0, planId: plan.id }),
      run: async () => ({ exitCode: 0, result: null }),
      validate: async (_r, _p, workerId) => {
        if (workerId === "w1") return val(true);
        return val(false); // w2 not applyable
      },
      pr: async (_r, _p, workerId) => {
        prCalls.push(workerId);
        return { exitCode: 0, prUrl: `https://pr/${workerId}` };
      },
    });

    assert.notEqual(res.exitCode, 0, "non-zero exit when any worker not applyable");
    assert.equal(prCalls.length, 1, "only applyable worker gets a PR");
    assert.equal(prCalls[0], "w1", "w1 applyable → pr'd");
    assert.deepStrictEqual(res.prUrls, ["https://pr/w1"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/* ---------------- AUTO-3: --no-pr → no pr calls, exit reflects validation ---------------- */

test("[AUTO-3] --no-pr → no pr calls regardless of applyable; exit reflects validation", async () => {
  const root = await tmpdirAsync();
  try {
    const plan = await makePlan(root, ["w1", "w2"]);

    let prCalled = false;
    // all applyable but --no-pr
    const resAll = await runDelegateAuto(root, "some task", { noPr: true }, {
      plan: async (_r, _t, _o) => ({ exitCode: 0, planId: plan.id }),
      run: async () => ({ exitCode: 0, result: null }),
      validate: async () => val(true),
      pr: async () => { prCalled = true; return { exitCode: 0, prUrl: "no" }; },
    });

    assert.equal(prCalled, false, "pr seam never called with --no-pr");
    assert.equal(resAll.exitCode, 0, "exit 0 when all applyable even with --no-pr");
    assert.deepStrictEqual(resAll.prUrls, []);

    // one applyable, one not — --no-pr → exit non-zero still
    const plan2 = await makePlan(root, ["w3", "w4"]);
    prCalled = false;
    const resMixed = await runDelegateAuto(root, "task2", { noPr: true }, {
      plan: async (_r, _t, _o) => ({ exitCode: 0, planId: plan2.id }),
      run: async () => ({ exitCode: 0, result: null }),
      validate: async (_r, _p, workerId) => {
        return workerId === "w3" ? val(true) : val(false);
      },
      pr: async () => { prCalled = true; return { exitCode: 0, prUrl: "no" }; },
    });

    assert.equal(prCalled, false, "pr seam never called with --no-pr (mixed validation)");
    assert.notEqual(resMixed.exitCode, 0, "non-zero exit when any not applyable (--no-pr)");
    assert.deepStrictEqual(resMixed.prUrls, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/* ---------------- AUTO-4: WIRED — `delegate auto` subcommand registered ---------------- */

test("[AUTO-4] registerDelegateCommand registers `delegate auto` subcommand", () => {
  const program = new Command();
  registerDelegateCommand(program, { root: "/root" });
  const delegate = program.commands.find((c) => c.name() === "delegate");
  assert.ok(delegate, "delegate command registered");
  const autoCmd = delegate!.commands.find((c) => c.name() === "auto");
  assert.ok(autoCmd, "delegate auto subcommand registered");
  assert.ok(autoCmd!.options.find((o: { long?: string }) => o.long?.includes("concurrent")), "--concurrent flag registered");
  assert.ok(autoCmd!.options.find((o: { long?: string }) => o.long?.includes("no-pr")), "--no-pr flag registered");
  assert.ok(autoCmd!.options.find((o: { long?: string }) => o.long?.includes("base")), "--base flag registered");
  assert.ok(autoCmd!.options.find((o: { long?: string }) => o.long?.includes("json")), "--json flag registered");
});
