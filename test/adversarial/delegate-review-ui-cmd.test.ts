/**
 * /delegate review-ui — command smoke (static fallback path; never raw mode).
 * The interactive raw-mode loop is manual-smoke (like runTuiRepl); here we only
 * assert the non-TTY / --no-tui path prints the existing review output safely.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { handleSlashCommand } from "../../src/cli/slashCommands.js";
import { savePlan } from "../../src/delegate/store.js";
import type { Session } from "../../src/cli/repl.js";
import type { DelegationPlan, WorkerRun } from "../../src/delegate/types.js";

async function setup(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dc-review-ui-cmd-"));
  const plan: DelegationPlan = {
    id: "p1", task: "t", createdAt: new Date().toISOString(), status: "needs_review",
    workers: [{ id: "w1", title: "Worker One", prompt: "do it", allowedPaths: ["src/"], forbiddenPaths: [], checkName: "test", maxAttempts: 1, dependsOn: [], expectedOutputs: [], status: "passed" }],
    dependencies: [], globalChecks: [], riskNotes: [],
  };
  await savePlan(root, plan);
  const run: WorkerRun = {
    planId: "p1", workerId: "w1", sessionId: "s", worktreePath: "/tmp/wt",
    startedAt: new Date().toISOString(), exitCode: 0, checkPassed: true,
    changedFiles: ["src/foo.ts"], patchPath: "patch.diff", patchSha256: "abc", summary: "", warnings: [],
  };
  const dir = path.join(root, ".deepcoder", "delegations", "p1", "runs", "w1");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "run.json"), JSON.stringify(run));
  await fs.writeFile(path.join(dir, "patch.diff"), "diff --git a/src/foo.ts b/src/foo.ts\n--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1,2 @@\n-old\n+new\n+new2");
  return root;
}

function session(root: string): Session {
  return { config: { workspaceRoot: root, checks: {} } } as unknown as Session;
}

async function capture(fn: () => Promise<void>): Promise<string> {
  const orig = console.log;
  let out = "";
  console.log = (...a: unknown[]) => { out += a.join(" ") + "\n"; };
  try { await fn(); } finally { console.log = orig; }
  return out;
}

test("review-ui --no-tui prints the worker review statically and never enters raw mode", async () => {
  const root = await setup();
  let rawModeCalled = false;
  const origRaw = process.stdin.setRawMode?.bind(process.stdin);
  (process.stdin as unknown as { setRawMode?: (v: boolean) => void }).setRawMode = () => { rawModeCalled = true; };
  try {
    const out = await capture(() => handleSlashCommand("/delegate review-ui p1 w1 --no-tui", session(root), async () => {}).then(() => {}));
    assert.match(out, /w1|Worker One/);
    assert.match(out, /src\/foo\.ts/, "patch stat / file path present");
    assert.equal(rawModeCalled, false, "static fallback must not enter raw mode");
  } finally {
    (process.stdin as unknown as { setRawMode?: typeof origRaw }).setRawMode = origRaw;
  }
});

test("review-ui --no-tui with an unknown worker reports a clean error", async () => {
  const root = await setup();
  const out = await capture(() => handleSlashCommand("/delegate review-ui p1 nope --no-tui", session(root), async () => {}).then(() => {}));
  assert.match(out, /not found/i);
});

test("review-ui --no-tui with no worker lists the plan overview", async () => {
  const root = await setup();
  const out = await capture(() => handleSlashCommand("/delegate review-ui p1 --no-tui", session(root), async () => {}).then(() => {}));
  assert.match(out, /w1|Worker One/);
});
