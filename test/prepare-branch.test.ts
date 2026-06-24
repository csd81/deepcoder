import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { prepareBranch, prepareWorkerBranch } from "../src/delegate/openPr.js";

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

async function makeRepo(): Promise<{ root: string; base: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "pb-repo-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "t@t");
  git(root, "config", "user.name", "t");
  await writeFile(path.join(root, "file.txt"), "base\n", "utf8");
  git(root, "add", "-A");
  git(root, "-c", "commit.gpgsign=false", "commit", "-qm", "base");
  const base = git(root, "rev-parse", "--abbrev-ref", "HEAD").trim();
  return { root, base };
}

test("prepareBranch applies an inline patch and commits on a new branch off base", async () => {
  const { root, base } = await makeRepo();
  try {
    // Produce a real unified diff vs HEAD, then restore the working tree.
    await writeFile(path.join(root, "file.txt"), "changed\n", "utf8");
    const patch = git(root, "diff");
    git(root, "checkout", "--", "file.txt");

    const branch = await prepareBranch(root, { branch: "feat/x", base, patch, commitMessage: "feat: x" });
    assert.equal(branch, "feat/x");

    // The branch carries the change; base is untouched.
    assert.equal(git(root, "show", "feat/x:file.txt"), "changed\n");
    assert.equal(git(root, "show", `${base}:file.txt`), "base\n");
    // The current checkout's working tree is clean.
    assert.equal(git(root, "status", "--porcelain").trim(), "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prepareBranch throws when given neither patch nor patchFile", async () => {
  const { root, base } = await makeRepo();
  try {
    await assert.rejects(
      () => prepareBranch(root, { branch: "feat/y", base, commitMessage: "m" }),
      /requires either patch or patchFile/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prepareWorkerBranch wrapper still resolves the delegation patch path", async () => {
  const { root, base } = await makeRepo();
  try {
    // Lay down a delegation patch.diff like the worker pipeline does.
    await writeFile(path.join(root, "file.txt"), "worker change\n", "utf8");
    const patch = git(root, "diff");
    git(root, "checkout", "--", "file.txt");
    const runDir = path.join(root, ".deepcoder", "delegations", "plan-1", "runs", "worker-1");
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, "patch.diff"), patch, "utf8");

    const branch = await prepareWorkerBranch(root, "plan-1", "worker-1", { branch: "feat/w", base });
    assert.equal(branch, "feat/w");
    assert.equal(git(root, "show", "feat/w:file.txt"), "worker change\n");
    // Commit message preserves the delegation provenance line.
    assert.match(git(root, "log", "-1", "--format=%B", "feat/w"), /delegated worker result/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
