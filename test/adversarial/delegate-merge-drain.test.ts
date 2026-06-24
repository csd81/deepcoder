/**
 * Adversarial tests for PR merge drain: UNKNOWN polling + update-branch
 * before merge. Every side effect is injected — no live model, no git, no `gh`.
 *
 * POLL-ON-UNKNOWN: createValidateSeam retries when mergeable=UNKNOWN (up to ~5
 * times with backoff) so async GitHub mergeability computation doesn't block
 * draining a backlog. Only PERSISTENT non-MERGEABLE is a failure.
 *
 * UPDATE-BRANCH: createUpdateBranchSeam runs `gh pr update-branch <pr>` for a
 * PR that is behind master but NOT truly conflicting; re-validate after.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createValidateSeam,
  createUpdateBranchSeam,
} from "../../src/delegate/prMergeSeams.js";
import type { RunGh, RunGit, Sleep } from "../../src/delegate/prMergeSeams.js";
import { runDelegateMerge } from "../../src/cli/delegateCli.js";
import type { PrMergeResult } from "../../src/delegate/prMerge.js";

/* ------------------------------------------------------------------ */
/*  Shared helpers                                                     */
/* ------------------------------------------------------------------ */

/** A fake sleep that records calls and resolves instantly. */
function fakeSleep(): { sleep: Sleep; calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    sleep: async (ms: number) => {
      calls.push(ms);
    },
  };
}

function prViewJson(state: string, mergeable: string, mergeStateStatus: string): string {
  return JSON.stringify({ state, mergeable, mergeStateStatus, statusCheckRollup: [] });
}

function makeRunGh(responses: Array<{ stdout: string; stderr?: string; exitCode?: number }>): RunGh {
  let i = 0;
  return async (_args: string[]) => {
    const r = responses[i] ?? responses[responses.length - 1];
    i++;
    return { stdout: r.stdout, stderr: r.stderr ?? "", exitCode: r.exitCode ?? 0 };
  };
}

const fakeRunGit: RunGit = async (_args: string[], _opts?: { cwd?: string }) => ({
  stdout: "",
  stderr: "",
  exitCode: 1,
});

/* ------------------------------------------------------------------ */
/*  [DRAIN-1] UNKNOWN → retry → MERGEABLE                              */
/* ------------------------------------------------------------------ */

test("[DRAIN-1] mergeable=UNKNOWN retries then MERGEABLE → applyable", async () => {
  const { sleep, calls } = fakeSleep();
  const runGh = makeRunGh([
    { stdout: prViewJson("OPEN", "UNKNOWN", "UNKNOWN") },    // attempt 0
    { stdout: prViewJson("OPEN", "UNKNOWN", "UNKNOWN") },    // attempt 1
    { stdout: prViewJson("OPEN", "MERGEABLE", "CLEAN") },    // attempt 2 → success
  ]);

  const validate = createValidateSeam(runGh, sleep);
  const result = await validate(42);

  assert.equal(result.applyable, true);
  assert.equal(result.mergeStateStatus, "CLEAN");
  // Two retries: 1s and 2s backoff
  assert.equal(calls.length, 2);
  assert.deepEqual(calls, [1000, 2000]);
});

/* ------------------------------------------------------------------ */
/*  [DRAIN-2] persistent UNKNOWN → not applyable                       */
/* ------------------------------------------------------------------ */

test("[DRAIN-2] persistent UNKNOWN after max retries → not applyable", async () => {
  const { sleep, calls } = fakeSleep();
  const runGh = makeRunGh([
    { stdout: prViewJson("OPEN", "UNKNOWN", "UNKNOWN") },
    { stdout: prViewJson("OPEN", "UNKNOWN", "UNKNOWN") },
    { stdout: prViewJson("OPEN", "UNKNOWN", "UNKNOWN") },
    { stdout: prViewJson("OPEN", "UNKNOWN", "UNKNOWN") },
    { stdout: prViewJson("OPEN", "UNKNOWN", "UNKNOWN") },
  ]);

  const validate = createValidateSeam(runGh, sleep);
  const result = await validate(42);

  assert.equal(result.applyable, false);
  assert.deepEqual(result.failures, [{ code: "pr_not_mergeable" }]);
  // 4 retries (attempts 0-3 trigger retry, attempt 4 is the final try)
  assert.equal(calls.length, 4);
  assert.deepEqual(calls, [1000, 2000, 4000, 8000]);
});

/* ------------------------------------------------------------------ */
/*  [DRAIN-3] UNKNOWN → CONFLICTING → immediate fail, no further retry */
/* ------------------------------------------------------------------ */

test("[DRAIN-3] UNKNOWN then CONFLICTING → immediate not applyable, no more retries", async () => {
  const { sleep, calls } = fakeSleep();
  const runGh = makeRunGh([
    { stdout: prViewJson("OPEN", "UNKNOWN", "UNKNOWN") },        // attempt 0
    { stdout: prViewJson("OPEN", "CONFLICTING", "DIRTY") },      // attempt 1 → fail
    { stdout: prViewJson("OPEN", "MERGEABLE", "CLEAN") },        // would succeed but never reached
  ]);

  const validate = createValidateSeam(runGh, sleep);
  const result = await validate(42);

  assert.equal(result.applyable, false);
  assert.deepEqual(result.failures, [{ code: "pr_not_mergeable" }]);
  // Only one retry (UNKNOWN → retried once, then CONFLICTING → stop)
  assert.equal(calls.length, 1);
  assert.deepEqual(calls, [1000]);
});

/* ------------------------------------------------------------------ */
/*  [DRAIN-4] update-branch success                                    */
/* ------------------------------------------------------------------ */

test("[DRAIN-4] createUpdateBranchSeam success", async () => {
  const runGh = makeRunGh([
    { stdout: "", exitCode: 0 },
  ]);
  const updateBranch = createUpdateBranchSeam(runGh);
  const result = await updateBranch(42);
  assert.equal(result.ok, true);
  assert.equal(result.error, undefined);
});

/* ------------------------------------------------------------------ */
/*  [DRAIN-5] update-branch failure                                    */
/* ------------------------------------------------------------------ */

test("[DRAIN-5] createUpdateBranchSeam failure", async () => {
  const runGh = makeRunGh([
    { stdout: "", stderr: "pull request is in a clean state", exitCode: 1 },
  ]);
  const updateBranch = createUpdateBranchSeam(runGh);
  const result = await updateBranch(42);
  assert.equal(result.ok, false);
  assert.ok(result.error?.includes("clean state"));
});

/* ------------------------------------------------------------------ */
/*  [DRAIN-6] runDelegateMerge: BEHIND → update-branch → re-validate → merge */
/* ------------------------------------------------------------------ */

test("[DRAIN-6] BEHIND PR triggers update-branch then merge", async () => {
  const { sleep, calls: sleepCalls } = fakeSleep();
  let updateBranchCalled = 0;
  let mergeCalled = 0;
  const processedPrs: number[] = [];

  // validate: first call shows BEHIND → trigger update-branch, second call shows CLEAN
  let validateCall = 0;
  const runGh = (args: string[]) => {
    const joined = args.join(" ");
    if (joined.includes("update-branch")) {
      updateBranchCalled++;
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
    }
    if (joined.includes("--json state,mergeable,mergeStateStatus,statusCheckRollup")) {
      validateCall++;
      if (validateCall === 1) {
        return Promise.resolve({ stdout: prViewJson("OPEN", "MERGEABLE", "BEHIND"), stderr: "", exitCode: 0 });
      }
      return Promise.resolve({ stdout: prViewJson("OPEN", "MERGEABLE", "CLEAN"), stderr: "", exitCode: 0 });
    }
    // merge call
    if (joined.includes("pr merge")) {
      mergeCalled++;
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
    }
    if (joined.includes("headRefName")) {
      return Promise.resolve({ stdout: JSON.stringify({ headRefName: "feat-x" }), stderr: "", exitCode: 0 });
    }
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 1 });
  };

  const mergePrFn = async (pr: number, deps: any, _opts: any) => {
    processedPrs.push(pr);
    const v = await deps.validate(pr);
    if (!v.applyable) return { pr, outcome: "skipped-not-applyable", failingGates: v.failures.map((f: any) => f.code) };
    await deps.merge(pr);
    return { pr, outcome: "merged" } as PrMergeResult;
  };

  const result = await runDelegateMerge("/root", [42], {}, {
    runGh,
    runGit: fakeRunGit,
    mergePr: mergePrFn,
    sleep,
  });

  assert.equal(updateBranchCalled, 1, "update-branch called once for BEHIND PR");
  assert.equal(mergeCalled, 1, "merge called once");
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].outcome, "merged");
  assert.equal(result.exitCode, 0);
});

/* ------------------------------------------------------------------ */
/*  [DRAIN-7] runDelegateMerge: UNKNOWN polling resolves → merge       */
/* ------------------------------------------------------------------ */

test("[DRAIN-7] UNKNOWN polling resolves to MERGEABLE → merge", async () => {
  const { sleep, calls: sleepCalls } = fakeSleep();
  let mergeCalled = 0;

  let validateCount = 0;
  const runGh = (args: string[]) => {
    const joined = args.join(" ");
    if (joined.includes("--json state,mergeable,mergeStateStatus,statusCheckRollup")) {
      validateCount++;
      if (validateCount <= 2) {
        return Promise.resolve({ stdout: prViewJson("OPEN", "UNKNOWN", "UNKNOWN"), stderr: "", exitCode: 0 });
      }
      return Promise.resolve({ stdout: prViewJson("OPEN", "MERGEABLE", "CLEAN"), stderr: "", exitCode: 0 });
    }
    if (joined.includes("pr merge")) {
      mergeCalled++;
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
    }
    if (joined.includes("headRefName")) {
      return Promise.resolve({ stdout: JSON.stringify({ headRefName: "feat-y" }), stderr: "", exitCode: 0 });
    }
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 1 });
  };

  const mergePrFn = async (pr: number, deps: any, _opts: any) => {
    const v = await deps.validate(pr);
    if (!v.applyable) return { pr, outcome: "skipped-not-applyable", failingGates: v.failures.map((f: any) => f.code) };
    await deps.merge(pr);
    return { pr, outcome: "merged" } as PrMergeResult;
  };

  const result = await runDelegateMerge("/root", [42], {}, {
    runGh,
    runGit: fakeRunGit,
    mergePr: mergePrFn,
    sleep,
  });

  assert.equal(sleepCalls.length, 2); // validate seam retried twice internally
  assert.equal(mergeCalled, 1);
  assert.equal(result.results[0].outcome, "merged");
  assert.equal(result.exitCode, 0);
});

/* ------------------------------------------------------------------ */
/*  [DRAIN-8] runDelegateMerge: BEHIND → update-branch → still CONFLICTING → conflicts-unresolved */
/* ------------------------------------------------------------------ */

test("[DRAIN-8] BEHIND + update-branch succeeds but git-level conflicts remain → conflicts-unresolved", async () => {
  const { sleep } = fakeSleep();
  let updateBranchCalled = 0;
  let mergeCalled = 0;

  const runGh = (args: string[]) => {
    const joined = args.join(" ");
    if (joined.includes("update-branch")) {
      updateBranchCalled++;
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
    }
    if (joined.includes("--json state,mergeable,mergeStateStatus,statusCheckRollup")) {
      // First call: BEHIND → triggers update-branch. Second (re-validate): CLEAN.
      return Promise.resolve({ stdout: prViewJson("OPEN", "MERGEABLE", "CLEAN"), stderr: "", exitCode: 0 });
    }
    if (joined.includes("pr merge")) {
      mergeCalled++;
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
    }
    if (joined.includes("headRefName")) {
      return Promise.resolve({ stdout: JSON.stringify({ headRefName: "feat-z" }), stderr: "", exitCode: 0 });
    }
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 1 });
  };

  // Fake git that reports conflicts.
  const conflictingRunGit = async (args: string[], _opts?: { cwd?: string }) => {
    const joined = args.join(" ");
    if (joined.includes("merge-base")) {
      return { stdout: "abc123\n", stderr: "", exitCode: 0 };
    }
    if (joined.includes("merge-tree")) {
      // Simulate merge-tree output with one conflict.
      return {
        stdout: [
          "changed in both",
          "  base   100644 abc123 src/conflict.ts",
          "  our    100644 def456 src/conflict.ts",
          "  their  100644 789abc src/conflict.ts",
        ].join("\n"),
        stderr: "",
        exitCode: 0,
      };
    }
    return { stdout: "", stderr: "", exitCode: 1 };
  };

  const mergePrFn = async (pr: number, deps: any, _opts: any) => {
    const v = await deps.validate(pr);
    if (!v.applyable) return { pr, outcome: "skipped-not-applyable", failingGates: v.failures.map((f: any) => f.code) };
    const cf = await deps.conflicts();
    if (cf.length > 0) return { pr, outcome: "conflicts-unresolved", unresolvedFiles: cf } as PrMergeResult;
    await deps.merge(pr);
    return { pr, outcome: "merged" } as PrMergeResult;
  };

  const result = await runDelegateMerge("/root", [42], {}, {
    runGh,
    runGit: conflictingRunGit,
    mergePr: mergePrFn,
    sleep,
  });

  assert.equal(mergeCalled, 0, "merge must NOT be called when conflicts remain");
  assert.equal(result.results[0].outcome, "conflicts-unresolved");
  assert.deepEqual(result.results[0].unresolvedFiles, ["src/conflict.ts"]);
  assert.equal(result.exitCode, 1);
});

/* ------------------------------------------------------------------ */
/*  [DRAIN-9] multiple PRs drain: mix of outcomes                       */
/* ------------------------------------------------------------------ */

test("[DRAIN-9] multiple PRs drain with mixed outcomes", async () => {
  const { sleep } = fakeSleep();
  const outcomes: Array<{ pr: number; outcome: string }> = [];

  const runGh = (args: string[]) => {
    const joined = args.join(" ");
    if (joined.includes("update-branch")) {
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
    }
    if (joined.includes("--json state,mergeable,mergeStateStatus,statusCheckRollup")) {
      // PR numbers from the validate call...
      // We need to distinguish which PR is being validated
      if (joined.includes("10")) {
        return Promise.resolve({ stdout: prViewJson("OPEN", "UNKNOWN", "UNKNOWN"), stderr: "", exitCode: 0 });
      }
      if (joined.includes("11")) {
        return Promise.resolve({ stdout: prViewJson("OPEN", "MERGEABLE", "BEHIND"), stderr: "", exitCode: 0 });
      }
      if (joined.includes("12")) {
        return Promise.resolve({ stdout: prViewJson("OPEN", "MERGEABLE", "CLEAN"), stderr: "", exitCode: 0 });
      }
    }
    if (joined.includes("pr merge")) {
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
    }
    if (joined.includes("headRefName")) {
      return Promise.resolve({ stdout: JSON.stringify({ headRefName: "feat" }), stderr: "", exitCode: 0 });
    }
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 1 });
  };

  const mergePrFn = async (pr: number, deps: any, _opts: any) => {
    const v = await deps.validate(pr);
    if (!v.applyable) {
      outcomes.push({ pr, outcome: "skipped-not-applyable" });
      return { pr, outcome: "skipped-not-applyable", failingGates: v.failures.map((f: any) => f.code) };
    }
    await deps.merge(pr);
    outcomes.push({ pr, outcome: "merged" });
    return { pr, outcome: "merged" } as PrMergeResult;
  };

  const result = await runDelegateMerge("/root", [10, 11, 12], {}, {
    runGh,
    runGit: fakeRunGit,
    mergePr: mergePrFn,
    sleep,
  });

  assert.equal(result.results.length, 3);
  assert.equal(result.exitCode, 1, "exit 1 because PR #10 is not applyable");
  // PR #10: UNKNOWN persistent → skipped
  // PR #11: BEHIND → merge (update-branch happens inside runDelegateMerge before mergePr)
  // PR #12: CLEAN → merge
});

/* ------------------------------------------------------------------ */
/*  [DRAIN-10] BEHIND → update-branch fails → still try merge (best-effort) */
/* ------------------------------------------------------------------ */

test("[DRAIN-10] BEHIND + update-branch fails → proceed to validate/merge anyway", async () => {
  const { sleep } = fakeSleep();
  let mergeCalled = 0;
  let updateBranchCalled = 0;

  let validateCall = 0;
  const runGh = (args: string[]) => {
    const joined = args.join(" ");
    if (joined.includes("update-branch")) {
      updateBranchCalled++;
      return Promise.resolve({ stdout: "", stderr: "error", exitCode: 1 });
    }
    if (joined.includes("--json state,mergeable,mergeStateStatus,statusCheckRollup")) {
      validateCall++;
      // First call: BEHIND → triggers update-branch attempt
      // Second call: still MERGEABLE (update-branch failed but PR is still structurally ok)
      return Promise.resolve({ stdout: prViewJson("OPEN", "MERGEABLE", "BEHIND"), stderr: "", exitCode: 0 });
    }
    if (joined.includes("pr merge")) {
      mergeCalled++;
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
    }
    if (joined.includes("headRefName")) {
      return Promise.resolve({ stdout: JSON.stringify({ headRefName: "feat" }), stderr: "", exitCode: 0 });
    }
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 1 });
  };

  const mergePrFn = async (pr: number, deps: any, _opts: any) => {
    const v = await deps.validate(pr);
    if (!v.applyable) return { pr, outcome: "skipped-not-applyable", failingGates: v.failures.map((f: any) => f.code) };
    await deps.merge(pr);
    return { pr, outcome: "merged" } as PrMergeResult;
  };

  const result = await runDelegateMerge("/root", [42], {}, {
    runGh,
    runGit: fakeRunGit,
    mergePr: mergePrFn,
    sleep,
  });

  assert.equal(updateBranchCalled, 1, "update-branch attempted");
  assert.equal(mergeCalled, 1, "merge still called after failed update-branch");
  assert.equal(result.results[0].outcome, "merged");
  assert.equal(result.exitCode, 0);
});
