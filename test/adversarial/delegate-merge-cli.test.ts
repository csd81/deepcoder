/**
 * Adversarial tests for `runDelegateMerge` + the `delegate merge` CLI subcommand.
 *
 * Every side effect is injected via seams — no live model, no git, no `gh`.
 * The merge gate is non-negotiable: a non-applyable PR is NEVER merged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";
// [DMCLI] red anchor: runDelegateMerge does not exist yet.
import { runDelegateMerge, registerDelegateCommand } from "../../src/cli/delegateCli.js";

/* ------------------------------------------------------------------ */
/*  Fake runGh / runGit — never spawn real processes                   */
/* ------------------------------------------------------------------ */

const fakeRunGh = async (_args: string[]) => ({
  stdout: "",
  stderr: "",
  exitCode: 1,
});

const fakeRunGit = async (_args: string[], _opts?: { cwd?: string }) => ({
  stdout: "",
  stderr: "",
  exitCode: 1,
});

/* ------------------------------------------------------------------ */
/*  [DMCLI-1] non-applyable PR → not merged                            */
/* ------------------------------------------------------------------ */

test("[DMCLI-1] non-applyable PR → skipped-not-applyable, merge NOT called", async () => {
  const result = await runDelegateMerge(
    "/root",
    [42],
    {},
    {
      runGh: fakeRunGh,
      runGit: fakeRunGit,
      mergePr: async (pr, _deps, _opts) => {
        return {
          pr,
          outcome: "skipped-not-applyable",
          failingGates: ["check_failed"],
        };
      },
    },
  );

  assert.equal(result.exitCode, 1, "non-zero exit for non-applyable");
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].outcome, "skipped-not-applyable");
  assert.deepEqual(result.results[0].failingGates, ["check_failed"]);
});

/* ------------------------------------------------------------------ */
/*  [DMCLI-2] applyable + no conflicts → merged exactly once           */
/* ------------------------------------------------------------------ */

test("[DMCLI-2] applyable + no conflicts → merged exactly once", async () => {
  let mergeCalls = 0;

  const result = await runDelegateMerge(
    "/root",
    [7],
    {},
    {
      runGh: fakeRunGh,
      runGit: fakeRunGit,
      mergePr: async (pr, _deps, _opts) => {
        mergeCalls++;
        return { pr, outcome: "merged" };
      },
    },
  );

  assert.equal(mergeCalls, 1, "mergePr called exactly once");
  assert.equal(result.exitCode, 0, "exit 0 when merged");
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].outcome, "merged");
});

/* ------------------------------------------------------------------ */
/*  [DMCLI-3] conflicts present → conflicts-unresolved, not merged     */
/* ------------------------------------------------------------------ */

test("[DMCLI-3] conflicts present → conflicts-unresolved, not merged", async () => {
  const result = await runDelegateMerge(
    "/root",
    [11],
    {},
    {
      runGh: fakeRunGh,
      runGit: fakeRunGit,
      mergePr: async (pr, _deps, _opts) => {
        return {
          pr,
          outcome: "conflicts-unresolved",
          unresolvedFiles: ["src/x.ts"],
        };
      },
    },
  );

  assert.equal(result.exitCode, 1, "non-zero exit for conflicts-unresolved");
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].outcome, "conflicts-unresolved");
  assert.deepEqual(result.results[0].unresolvedFiles, ["src/x.ts"]);
});

/* ------------------------------------------------------------------ */
/*  [DMCLI-4] --dry-run → neither merge nor resolve called             */
/* ------------------------------------------------------------------ */

test("[DMCLI-4] --dry-run passes dryRun:true to mergePr, no side effects", async () => {
  const dryRunFlags: boolean[] = [];

  const result = await runDelegateMerge(
    "/root",
    [7, 11],
    { dryRun: true },
    {
      runGh: fakeRunGh,
      runGit: fakeRunGit,
      mergePr: async (pr, _deps, opts) => {
        dryRunFlags.push(opts?.dryRun ?? false);
        return { pr, outcome: "merged" };
      },
    },
  );

  assert.deepEqual(dryRunFlags, [true, true], "dryRun:true passed to every mergePr call");
  assert.equal(result.results.every((r) => r.outcome === "merged"), true);
});

/* ------------------------------------------------------------------ */
/*  [DMCLI-5] multiple PRs → each processed independently              */
/* ------------------------------------------------------------------ */

test("[DMCLI-5] multiple PRs processed independently, exit reflects any failure", async () => {
  const processed: number[] = [];

  const result = await runDelegateMerge(
    "/root",
    [1, 2, 3],
    {},
    {
      runGh: fakeRunGh,
      runGit: fakeRunGit,
      mergePr: async (pr, _deps, _opts) => {
        processed.push(pr);
        if (pr === 2) {
          return { pr, outcome: "skipped-not-applyable", failingGates: ["check_x"] };
        }
        return { pr, outcome: "merged" };
      },
    },
  );

  assert.deepEqual(processed, [1, 2, 3], "all three PRs processed");
  assert.equal(result.results.length, 3);
  assert.equal(result.results[0].outcome, "merged");
  assert.equal(result.results[1].outcome, "skipped-not-applyable");
  assert.equal(result.results[2].outcome, "merged");
  assert.equal(result.exitCode, 1, "exit 1 because at least one was non-applyable");
});

/* ------------------------------------------------------------------ */
/*  [DMCLI-6] WIRED: `delegate merge` subcommand is registered         */
/* ------------------------------------------------------------------ */

test("[DMCLI-6] registerDelegateCommand registers `delegate merge`", () => {
  const program = new Command();
  registerDelegateCommand(program, { root: "/root" });
  const delegate = program.commands.find((c) => c.name() === "delegate");
  assert.ok(delegate, "delegate command registered");
  const mergeCmd = delegate!.commands.find((c) => c.name() === "merge");
  assert.ok(mergeCmd, "delegate merge subcommand registered");
});

/* ------------------------------------------------------------------ */
/*  [DMCLI-7] empty PR list → exit 2, empty results                    */
/* ------------------------------------------------------------------ */

test("[DMCLI-7] empty PR list → exit 2", async () => {
  const result = await runDelegateMerge("/root", [], {});
  assert.equal(result.exitCode, 2);
  assert.deepEqual(result.results, []);
});
