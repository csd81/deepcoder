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
  type ValidateWorkerInput,
} from "../../src/delegate/validation.js";
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
