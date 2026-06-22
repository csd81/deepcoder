/**
 * /resolve — merge-conflict detection + context building.
 * Covers the deterministic, offline core (the model-resolution step is manual,
 * per the plan): detectConflicts on a real conflicted temp repo, readConflict
 * reading the three git stages, and buildResolvePrompt assembling the context.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { Git } from "../src/workspace/git.js";
import { detectConflicts, readConflict, buildResolvePrompt, hasConflictMarkers, filesStillConflicted, type ConflictFile } from "../src/cli/mergeConflict.js";

const exec = promisify(execFile);

/** Create a temp git repo with one conflicted file (ours vs theirs over a base). */
async function makeConflictRepo(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), "merge-conflict-"));
  const cleanup = () => rm(root, { recursive: true, force: true });
  const g = (args: string[]) => exec("git", args, { cwd: root });
  try {
    await g(["init", "-q", "-b", "main"]);
    await g(["config", "user.email", "t@t"]);
    await g(["config", "user.name", "t"]);
    await g(["config", "commit.gpgsign", "false"]);
    await writeFile(path.join(root, "f.txt"), "line1\nBASE\nline3\n");
    await g(["add", "-A"]);
    await g(["commit", "-qm", "base"]);
    await g(["checkout", "-q", "-b", "feature"]);
    await writeFile(path.join(root, "f.txt"), "line1\nTHEIRS\nline3\n");
    await g(["commit", "-qam", "theirs"]);
    await g(["checkout", "-q", "main"]);
    await writeFile(path.join(root, "f.txt"), "line1\nOURS\nline3\n");
    await g(["commit", "-qam", "ours"]);
    // Merge → conflict (non-zero exit; ignore).
    await g(["merge", "feature"]).catch(() => {});
    return { root, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

test("detectConflicts returns [] on a clean repo", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "no-conflict-"));
  try {
    const g = (args: string[]) => exec("git", args, { cwd: root });
    await g(["init", "-q", "-b", "main"]);
    await g(["config", "user.email", "t@t"]);
    await g(["config", "user.name", "t"]);
    await writeFile(path.join(root, "a.txt"), "x\n");
    await g(["add", "-A"]);
    await g(["commit", "-qm", "init"]);
    assert.deepEqual(await detectConflicts(new Git(root)), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detectConflicts lists the conflicted file after a failed merge", async () => {
  const { root, cleanup } = await makeConflictRepo();
  try {
    assert.deepEqual(await detectConflicts(new Git(root)), ["f.txt"]);
  } finally {
    await cleanup();
  }
});

test("readConflict reads ours/theirs/base stages + the marker'd working tree", async () => {
  const { root, cleanup } = await makeConflictRepo();
  try {
    const cf = await readConflict(new Git(root), root, "f.txt");
    assert.ok(cf, "expected a ConflictFile");
    assert.match(cf!.baseContent, /BASE/);
    assert.match(cf!.oursContent, /OURS/);
    assert.match(cf!.theirsContent, /THEIRS/);
    assert.match(cf!.current, /<<<<<<</); // working tree carries conflict markers
  } finally {
    await cleanup();
  }
});

test("hasConflictMarkers detects leftover markers, ignores resolved content", () => {
  assert.equal(hasConflictMarkers("line1\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> x\nline3"), true);
  assert.equal(hasConflictMarkers("line1\nmerged\nline3\n"), false);
  // Leftover separator-only or diff3 base markers must also count as unresolved —
  // otherwise a file with a stray ======= / ||||||| gets staged as "resolved".
  assert.equal(hasConflictMarkers("a\n=======\nb\n"), true);
  assert.equal(hasConflictMarkers("a\n||||||| base\nb\n"), true);
  // Resolved-but-unstaged is the case that broke the first cut: markers gone → false,
  // even though `git diff --diff-filter=U` would still list the file until staged.
  assert.equal(hasConflictMarkers("line1\nHELLO FROM OURS\nline3\n"), false);
});

test("filesStillConflicted returns only files whose working tree still has markers", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "still-conflicted-"));
  try {
    await writeFile(path.join(root, "resolved.txt"), "all good\n");
    await writeFile(path.join(root, "bad.txt"), "x\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> y\n");
    const out = await filesStillConflicted(root, ["resolved.txt", "bad.txt"]);
    assert.deepEqual(out, ["bad.txt"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("buildResolvePrompt includes the current file + all three versions", () => {
  const files: ConflictFile[] = [
    { path: "src/a.ts", baseContent: "B", oursContent: "O", theirsContent: "T", current: "<<<<<<<\nO\n=======\nT\n>>>>>>>" },
  ];
  const p = buildResolvePrompt(files);
  assert.match(p, /src\/a\.ts/);
  assert.match(p, /Ours/i);
  assert.match(p, /Theirs/i);
  assert.match(p, /base/i);
  assert.match(p, /conflict markers/i); // instructs the model to remove them
});
