/**
 * Adversarial test — the merge seam's post-merge cleanup must prune the REMOTE
 * (the now-deleted branch's remote-tracking ref), not just local artifacts.
 *
 * `gh pr merge --delete-branch` deletes the remote branch, but a plain
 * `git fetch origin` leaves the stale `origin/<branch>` ref dangling locally.
 * The cleanup must fetch with `--prune` so the local view matches the remote.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createMergeSeam, type RunResult } from "../../src/delegate/prMergeSeams.js";

function ok(stdout = ""): RunResult {
  return { stdout, stderr: "", exitCode: 0 };
}

test("merge seam deletes the remote branch AND prunes the stale remote-tracking ref", async () => {
  const ghCalls: string[][] = [];
  const gitCalls: string[][] = [];

  const runGh = async (args: string[]): Promise<RunResult> => {
    ghCalls.push(args);
    if (args[0] === "pr" && args[1] === "view") {
      return ok(JSON.stringify({ headRefName: "feat-thing" }));
    }
    return ok();
  };
  const runGit = async (args: string[]): Promise<RunResult> => {
    gitCalls.push(args);
    return ok();
  };

  const merge = createMergeSeam(runGh, runGit, { root: "/repo" });
  await merge(36);

  // Remote branch deletion is requested via gh.
  assert.ok(
    ghCalls.some((a) => a.join(" ") === "pr merge 36 --merge --delete-branch"),
    `expected gh pr merge --delete-branch; got ${JSON.stringify(ghCalls)}`,
  );

  // The post-merge fetch MUST prune so the deleted remote branch's tracking ref
  // is dropped locally — a plain `fetch origin` would leave it dangling.
  const fetches = gitCalls.filter((a) => a[0] === "fetch");
  assert.ok(fetches.length > 0, "expected a post-merge fetch");
  for (const f of fetches) {
    assert.ok(
      f.includes("--prune"),
      `post-merge fetch must use --prune to drop the deleted remote ref; got ${JSON.stringify(f)}`,
    );
  }
});
