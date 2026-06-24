/**
 * Adversarial wiring test — proves the reachability completeness gate is wired
 * END-TO-END through the delegation validation pipeline, not just inside
 * completeness.ts. Two surfaces:
 *
 *   Test A — the PURE validator (validateWorkerResult) FORWARDS `findImporters`
 *            / `requireDeliverableTested` into evaluateCompleteness, so an
 *            orphaned `expectedReachable` module surfaces as a completeness
 *            failure (and disappears once an importer exists).
 *
 *   Test B — the loader's real `findImporters` (buildFindImporters) resolves
 *            ESM `.js` specifiers to `.ts` sources over a temp worktree.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  validateWorkerResult,
  buildFindImporters,
  deriveReachabilityFromPatch,
  loadAndValidateWorker,
  type ValidateWorkerInput,
} from "../../src/delegate/validation.js";
import { savePlan } from "../../src/delegate/store.js";
import type { DelegationPlan, WorkerTask, WorkerRun } from "../../src/delegate/types.js";

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

function makeWorker(overrides: Partial<WorkerTask> = {}): WorkerTask {
  return {
    id: "w1",
    title: "wire orphan",
    prompt: "do the thing",
    allowedPaths: ["src/"],
    forbiddenPaths: [],
    checkName: "typecheck",
    maxAttempts: 1,
    dependsOn: [],
    expectedOutputs: [],
    status: "passed",
    ...overrides,
  };
}

function makeRun(overrides: Partial<WorkerRun> = {}): WorkerRun {
  return {
    planId: "p1",
    workerId: "w1",
    sessionId: "s1",
    worktreePath: "/tmp/wt",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    exitCode: 0,
    checkPassed: true,
    changedFiles: ["src/foo/orphan.ts"],
    patchPath: "patch.diff",
    patchSha256: "abc",
    summary: "ok",
    warnings: [],
    isolation: { isolatedRoot: "/tmp/wt" } as WorkerRun["isolation"],
    telemetryPath: "log.txt",
    ...overrides,
  };
}

function makePlan(worker: WorkerTask): DelegationPlan {
  return {
    id: "p1",
    workers: [worker],
  } as unknown as DelegationPlan;
}

const PATCH =
  "diff --git a/src/foo/orphan.ts b/src/foo/orphan.ts\n" +
  "--- a/src/foo/orphan.ts\n" +
  "+++ b/src/foo/orphan.ts\n" +
  "@@ -0,0 +1 @@\n" +
  "+export const x = 1;\n";

function baseInput(over: Partial<ValidateWorkerInput> = {}): ValidateWorkerInput {
  const worker = makeWorker({
    expectedReachable: [{ module: "src/foo/orphan.ts" }],
  });
  return {
    root: "/tmp/wt",
    plan: makePlan(worker),
    worker,
    run: makeRun(),
    patchText: PATCH,
    alreadyChangedPaths: [],
    qualityGateRequired: false,
    ...over,
  };
}

/* ------------------------------------------------------------------ */
/*  Test A — pure wiring (forwarding into evaluateCompleteness)        */
/* ------------------------------------------------------------------ */

test("A: orphaned expectedReachable module surfaces as a completeness failure (findImporters forwarded)", () => {
  const result = validateWorkerResult(baseInput({ findImporters: () => [] }));

  const orphan = result.failures.find(
    (f) => f.source === "completeness" && /orphaned|not imported/i.test(f.message),
  );
  assert.ok(
    orphan,
    `expected an orphaned-deliverable completeness failure; got: ${JSON.stringify(result.failures)}`,
  );
  assert.notEqual(result.status, "valid");
});

test("A: providing a non-test importer clears the orphaned-deliverable failure", () => {
  const result = validateWorkerResult(
    baseInput({ findImporters: () => ["src/cli/main.ts"] }),
  );

  const orphan = result.failures.find(
    (f) => f.source === "completeness" && /orphaned|not imported/i.test(f.message),
  );
  assert.equal(
    orphan,
    undefined,
    `did not expect an orphaned-deliverable failure; got: ${JSON.stringify(result.failures)}`,
  );
});

/* ------------------------------------------------------------------ */
/*  Test B — loader resolver (buildFindImporters over a real worktree) */
/* ------------------------------------------------------------------ */

test("B: buildFindImporters returns [] with no importer and the importer once it exists", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "deepcoder-importers-"));
  try {
    await fs.mkdir(path.join(root, "src", "foo"), { recursive: true });
    await fs.writeFile(
      path.join(root, "src", "foo", "orphan.ts"),
      "export const x = 1;\n",
      "utf8",
    );

    const findImporters = buildFindImporters(root);

    // (i) no importer
    assert.deepEqual(findImporters("src/foo/orphan.ts"), []);

    // (ii) add an importer using the ESM `.js`-specifier convention
    await fs.mkdir(path.join(root, "src", "cli"), { recursive: true });
    await fs.writeFile(
      path.join(root, "src", "cli", "wire.ts"),
      'import { x } from "../foo/orphan.js";\nconsole.log(x);\n',
      "utf8",
    );

    const importers = findImporters("src/foo/orphan.ts");
    assert.deepEqual(importers, ["src/cli/wire.ts"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/*  Test C — deriveReachabilityFromPatch (auto-arm the wiring gate)    */
/* ------------------------------------------------------------------ */

test("C: derives a rule for every NEW non-test src module, ignoring the rest", () => {
  const patch =
    // new src module → MUST be wired
    "diff --git a/src/session/managedOutputs.ts b/src/session/managedOutputs.ts\n" +
    "new file mode 100644\n--- /dev/null\n+++ b/src/session/managedOutputs.ts\n+export const a = 1;\n" +
    // MODIFIED existing src file → already has call sites, not a deliverable
    "diff --git a/src/agent/agentLoop.ts b/src/agent/agentLoop.ts\n" +
    "--- a/src/agent/agentLoop.ts\n+++ b/src/agent/agentLoop.ts\n@@ -1 +1 @@\n-old\n+new\n" +
    // new TEST file → never a deliverable
    "diff --git a/test/managed-outputs.test.ts b/test/managed-outputs.test.ts\n" +
    "new file mode 100644\n--- /dev/null\n+++ b/test/managed-outputs.test.ts\n+test;\n" +
    // new src .test.ts (colocated test) → excluded
    "diff --git a/src/session/managedOutputs.test.ts b/src/session/managedOutputs.test.ts\n" +
    "new file mode 100644\n--- /dev/null\n+++ b/src/session/managedOutputs.test.ts\n+test;\n" +
    // new type-only declaration → no runtime call site, excluded
    "diff --git a/src/types/foo.d.ts b/src/types/foo.d.ts\n" +
    "new file mode 100644\n--- /dev/null\n+++ b/src/types/foo.d.ts\n+export type T = 1;\n" +
    // new file OUTSIDE src → not our wiring concern
    "diff --git a/scripts/tool.ts b/scripts/tool.ts\n" +
    "new file mode 100644\n--- /dev/null\n+++ b/scripts/tool.ts\n+x;\n";

  const rules = deriveReachabilityFromPatch(patch);
  assert.deepEqual(
    rules.map((r) => r.module),
    ["src/session/managedOutputs.ts"],
    "only the new non-test runtime src module should be required-reachable",
  );
});

test("C: empty/null patch yields no rules (no false gate)", () => {
  assert.deepEqual(deriveReachabilityFromPatch(null), []);
  assert.deepEqual(deriveReachabilityFromPatch(""), []);
});

/* ------------------------------------------------------------------ */
/*  Test D — loadAndValidateWorker ARMS the gate with NO declared      */
/*           expectedReachable (the whole point: wiring is enforced)   */
/* ------------------------------------------------------------------ */

async function setupWorktree(wired: boolean): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "deepcoder-autowire-"));
  // The new deliverable module exists in the worktree…
  await fs.mkdir(path.join(root, "src", "foo"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "foo", "orphan.ts"), "export const x = 1;\n", "utf8");
  // …wired only when the test asks for it (non-test importer in src/).
  if (wired) {
    await fs.mkdir(path.join(root, "src", "cli"), { recursive: true });
    await fs.writeFile(
      path.join(root, "src", "cli", "wire.ts"),
      'import { x } from "../foo/orphan.js";\nconsole.log(x);\n',
      "utf8",
    );
  }

  // Worker has NO expectedReachable — the gate must be armed by auto-derive alone.
  const worker = makeWorker({ id: "w1", allowedPaths: ["src/"], checkName: "typecheck" });
  const plan = { ...makePlan(worker), workers: [worker], status: "planned", task: "t", createdAt: "", dependencies: [], globalChecks: [], riskNotes: [] } as DelegationPlan;
  await savePlan(root, plan);

  const runDir = path.join(root, ".deepcoder", "delegations", "p1", "runs", "w1");
  await fs.mkdir(runDir, { recursive: true });
  const patch =
    "diff --git a/src/foo/orphan.ts b/src/foo/orphan.ts\n" +
    "new file mode 100644\n--- /dev/null\n+++ b/src/foo/orphan.ts\n@@ -0,0 +1 @@\n+export const x = 1;\n";
  await fs.writeFile(path.join(runDir, "patch.diff"), patch, "utf8");
  await fs.writeFile(
    path.join(runDir, "run.json"),
    JSON.stringify(makeRun({ changedFiles: ["src/foo/orphan.ts"] })),
    "utf8",
  );
  return root;
}

test("D: a NEW src module with no non-test importer is rejected (orphaned) — no expectedReachable declared", async () => {
  const root = await setupWorktree(false);
  try {
    const v = await loadAndValidateWorker(root, "p1", "w1");
    const orphan = v.failures.find((f) => /orphaned|not imported/i.test(f.message));
    assert.ok(orphan, `expected an auto-armed orphaned-deliverable failure; got ${JSON.stringify(v.failures)}`);
    assert.notEqual(v.status, "valid");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("D: the same patch passes once a non-test importer exists (gate clears)", async () => {
  const root = await setupWorktree(true);
  try {
    const v = await loadAndValidateWorker(root, "p1", "w1");
    const orphan = v.failures.find((f) => /orphaned|not imported/i.test(f.message));
    assert.equal(orphan, undefined, `did not expect an orphan failure; got ${JSON.stringify(v.failures)}`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
