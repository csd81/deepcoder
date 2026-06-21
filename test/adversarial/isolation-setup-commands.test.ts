/**
 * Phase 7E — isolation setup commands. `setupCommands` (e.g. `npm ci --offline`)
 * run ONCE in the isolated worktree after dependency symlinks, before the agent.
 * Fail-closed: a failing command throws (so checks never run in a half-set-up
 * tree); an empty list is a no-op. Commands run in the worktree cwd, bounded.
 *
 * RED ANCHOR: imports runSetupCommands from src/workspaceIsolation/provision.ts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runSetupCommands } from "../../src/workspaceIsolation/provision.js";
import { WorkspaceIsolationError } from "../../src/workspaceIsolation/types.js";

test("[7e-setup-noop] an empty command list is a no-op", () => {
  const r = runSetupCommands("/nonexistent-should-not-matter", []);
  assert.deepEqual(r, []);
});

test("[7e-setup-runs-in-worktree] commands run in the worktree cwd", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "setup-"));
  try {
    const results = runSetupCommands(dir, ["echo hello > marker.txt"]);
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, true);
    const marker = await readFile(path.join(dir, "marker.txt"), "utf8");
    assert.match(marker, /hello/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("[7e-setup-failclosed] a failing command throws WorkspaceIsolationError and stops the rest", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "setup-"));
  try {
    assert.throws(
      () => runSetupCommands(dir, ["exit 7", "echo should-not-run > after.txt"]),
      (e: unknown) => e instanceof WorkspaceIsolationError && /exit 7/.test((e as Error).message),
    );
    // the second command must NOT have run
    await assert.rejects(readFile(path.join(dir, "after.txt"), "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
