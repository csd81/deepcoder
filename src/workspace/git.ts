import { gitExec } from "../git/core.js";
import * as gitRead from "../git/read.js";
import * as gitCommit from "../git/commit.js";
import * as gitBranch from "../git/branch.js";
import * as gitIntegrate from "../git/integrate.js";

/**
 * Git helpers: read-only inspection plus structured workflow commands.
 *
 * This is the single git SURFACE for the CLI. Every operation delegates to the
 * native git core modules (`src/git/{read,commit,branch,integrate}.ts`), which in
 * turn run through `gitExec` — the one deterministic primitive deepcoder owns —
 * so there is one git surface, not two (plans/tools/feat-native-git-core-plan.md).
 * A handful of raw `this.run` calls remain only where no typed wrapper covers the
 * exact form needed (e.g. `status --short --branch`, `reset --hard`, stash with a
 * message), keeping behaviour identical to before the migration.
 */
export class Git {
  constructor(private cwd: string) {}

  /** Run an arbitrary git command, returning stdout. Throws on non-zero exit. */
  async run(args: string[]): Promise<string> {
    const res = await gitExec(this.cwd, args);
    if (res.code !== 0) {
      throw new Error(res.stderr.trim() || `git ${args.join(" ")} failed (code ${res.code})`);
    }
    return res.stdout;
  }

  /** Workspace-relative paths with unmerged (conflicting) entries, if any. */
  private async unmergedPaths(): Promise<string[]> {
    const out = await this.run(["diff", "--name-only", "--diff-filter=U"]);
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  }

  async isRepo(): Promise<boolean> {
    try {
      await this.run(["rev-parse", "--is-inside-work-tree"]);
      return true;
    } catch {
      return false;
    }
  }

  async status(): Promise<string> {
    // `--short --branch` is a display format with no typed wrapper; keep raw.
    return (await this.run(["status", "--short", "--branch"])).trim();
  }

  async diff(paths?: string[]): Promise<string> {
    return (await gitRead.diff(this.cwd, paths?.length ? { paths } : undefined)).trim();
  }

  /**
   * Workspace-relative paths of changed files (staged, unstaged, and untracked).
   * Rename entries report the new path. Returns [] on a clean tree.
   */
  async changedFiles(): Promise<string[]> {
    const { entries } = await gitRead.status(this.cwd);
    return entries.map((e) => e.path);
  }

  /** One-line summary of how dirty the tree is. */
  async dirtySummary(): Promise<string> {
    const { entries } = await gitRead.status(this.cwd);
    if (entries.length === 0) return "clean working tree";
    return `${entries.length} file${entries.length === 1 ? "" : "s"} changed`;
  }

  // ── Read-only workflow ──

  /** Last `count` commits, one line each. */
  async log(count = 10): Promise<string> {
    return gitRead.log(this.cwd, { oneline: true, n: count });
  }

  /** Current branch plus all local and remote branch names. */
  async branches(): Promise<{ current: string; local: string[]; remote: string[] }> {
    const current = (await this.run(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    const local = await gitRead.listBranches(this.cwd);
    // Skip the symbolic "origin/HEAD -> origin/main" pointer line.
    const remote = (await this.run(["branch", "-r", "--format=%(refname:short)"]))
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((r) => !r.includes("->"));
    return { current, local, remote };
  }

  /** Blame annotation for a file. */
  async blame(file: string): Promise<string> {
    return gitRead.blame(this.cwd, file);
  }

  /** `git show [<ref>]` — full diff/metadata for a commit or object. */
  async show(ref?: string): Promise<string> {
    return gitRead.show(this.cwd, ref);
  }

  /** Tracked files (optionally limited to `paths`). */
  async lsFiles(paths?: string[]): Promise<string[]> {
    return gitRead.lsFiles(this.cwd, paths);
  }

  /** Number of commits in `range` (e.g. `origin/main..HEAD`). */
  async revListCount(range: string): Promise<number> {
    return gitRead.revListCount(this.cwd, range);
  }

  /** Raw `git stash list` output. */
  async stashList(): Promise<string> {
    return (await gitIntegrate.stash(this.cwd, { list: true })).stdout.trim();
  }

  /** Diff of staged (cached) changes only. */
  async diffStaged(): Promise<string> {
    return (await gitRead.diff(this.cwd, { cached: true })).trim();
  }

  // ── Mutating workflow ──

  /**
   * Commit changes. With `paths`, stages and commits only those paths; otherwise
   * stages all tracked modifications (`add -u`, matching `commit -a` semantics)
   * and commits. Returns the new commit hash and a summary line.
   */
  async commit(message: string, paths?: string[]): Promise<{ hash: string; stdout: string }> {
    if (paths?.length) {
      // Pathspec commit: record ONLY these paths, regardless of what else is
      // staged. (add+commit would also sweep up other already-staged changes.)
      const stdout = await this.run(["commit", "-m", message, "--", ...paths]);
      return { hash: stdout.match(/\[[^\]]*?\s([0-9a-f]+)\]/)?.[1] ?? "unknown", stdout };
    }
    await this.run(["add", "-u"]); // stage tracked modifications (== commit -a, no untracked)
    const { hash } = await gitCommit.commit(this.cwd, { message });
    const h = hash ?? "unknown";
    return { hash: h, stdout: `[${h}] ${message}` };
  }

  /** Stage paths (or everything with `all`). */
  async stage(opts: { all?: boolean; paths?: string[] }): Promise<void> {
    await gitCommit.add(this.cwd, opts);
  }

  /** Restore working-tree (or, with `staged`, index) entries for `paths`. */
  async restore(paths: string[], staged?: boolean): Promise<void> {
    await gitCommit.restore(this.cwd, { staged, paths });
  }

  /** Create a revert commit for `commit` (uses --no-edit for a default message). */
  async revert(commit: string): Promise<string> {
    const res = await gitIntegrate.revert(this.cwd, commit, { noEdit: true });
    if (res.code !== 0) throw new Error(res.stderr.trim() || res.stdout.trim() || `git revert ${commit} failed`);
    return res.stdout;
  }

  /** Reset HEAD to `commit` with the given mode. */
  async reset(commit: string, mode: "soft" | "mixed" | "hard"): Promise<string> {
    // `--hard` has no typed wrapper by design (commit.reset never discards work);
    // run it raw so the existing hard-reset behaviour is preserved.
    if (mode === "hard") return this.run(["reset", "--hard", commit]);
    await gitCommit.reset(this.cwd, { [mode]: true, ref: commit });
    return "";
  }

  /** Amend the last commit with a new message. Returns the rewritten hash. */
  async amend(message: string): Promise<{ hash: string; stdout: string }> {
    const { hash } = await gitCommit.commit(this.cwd, { amend: true, message });
    const h = hash ?? "unknown";
    return { hash: h, stdout: `[${h}] ${message}` };
  }

  /** Cherry-pick a commit onto the current branch. */
  async cherryPick(commit: string): Promise<string> {
    const res = await gitIntegrate.cherryPick(this.cwd, commit);
    if (res.code !== 0) throw new Error(res.stderr.trim() || res.stdout.trim() || `git cherry-pick ${commit} failed`);
    return res.stdout;
  }

  /** Apply a patch file. `check` validates only; `threeWay` enables 3-way merge. */
  async applyPatch(patchFile: string, opts?: { check?: boolean; threeWay?: boolean }): Promise<string> {
    const res = await gitIntegrate.apply(this.cwd, { patchFile, check: opts?.check, threeWay: opts?.threeWay });
    if (res.code !== 0) throw new Error(res.stderr.trim() || res.stdout.trim() || `git apply ${patchFile} failed`);
    return res.stdout || res.stderr;
  }

  /** Push `branch` to `remote`. `force` uses --force-with-lease for safety. */
  async push(remote: string, branch: string, force?: boolean): Promise<string> {
    const args = ["push"];
    if (force) args.push("--force-with-lease");
    args.push(remote, branch);
    return this.run(args);
  }

  /** Pull `branch` from `remote`, optionally with --rebase. */
  async pull(remote: string, branch: string, rebase?: boolean): Promise<string> {
    const args = ["pull"];
    if (rebase) args.push("--rebase");
    args.push(remote, branch);
    return this.run(args);
  }

  /**
   * Merge `branch` into the current branch. On conflict, returns
   * `{ ok: false, conflicts }` rather than throwing.
   */
  async merge(branch: string): Promise<{ ok: boolean; conflicts?: string[] }> {
    const res = await gitIntegrate.merge(this.cwd, branch, { noEdit: true });
    if (res.code === 0) return { ok: true };
    const conflicts = await this.unmergedPaths();
    if (conflicts.length) return { ok: false, conflicts };
    // Non-conflict failure (e.g. dirty tree): surface as an error.
    throw new Error(res.stderr.trim() || res.stdout.trim() || `git merge ${branch} failed`);
  }

  /**
   * Rebase the current branch onto `target`. On conflict, returns
   * `{ ok: false, conflicts }` rather than throwing.
   */
  async rebase(target: string): Promise<{ ok: boolean; conflicts?: string[] }> {
    const res = await gitIntegrate.rebase(this.cwd, { upstream: target });
    if (res.code === 0) return { ok: true };
    const conflicts = await this.unmergedPaths();
    if (conflicts.length) return { ok: false, conflicts };
    throw new Error(res.stderr.trim() || res.stdout.trim() || `git rebase ${target} failed`);
  }

  /** Check out an existing branch. */
  async checkout(branch: string): Promise<string> {
    await gitBranch.switchBranch(this.cwd, branch);
    return "";
  }

  /** Create and switch to a new branch (`git switch -c`). */
  async createBranch(name: string): Promise<string> {
    await gitBranch.createBranch(this.cwd, name, { switch: true });
    return "";
  }

  /** Delete a branch (`-d`, or `-D` to force-delete an unmerged branch). */
  async deleteBranch(name: string, force = false): Promise<string> {
    await gitBranch.deleteBranch(this.cwd, name, { force });
    return "";
  }

  /** Rename a branch (`git branch -m <from> <to>`). */
  async renameBranch(from: string, to: string): Promise<void> {
    await gitBranch.renameBranch(this.cwd, from, to);
  }

  // ── Worktrees ──

  /** Add a linked worktree, optionally creating a new branch for it. */
  async worktreeAdd(dir: string, branch?: string): Promise<void> {
    await gitBranch.worktreeAdd(this.cwd, dir, branch ? { branch } : undefined);
  }

  /** Remove a linked worktree (force only when explicitly requested). */
  async worktreeRemove(dir: string, force = false): Promise<void> {
    await gitBranch.worktreeRemove(this.cwd, dir, { force });
  }

  /** List linked worktrees. */
  async worktreeList(): Promise<string> {
    return (await gitBranch.worktreeList(this.cwd)).trim();
  }

  /** Prune stale worktree administrative files. */
  async worktreePrune(): Promise<void> {
    await gitBranch.worktreePrune(this.cwd);
  }

  // ── Tags ──

  /** Create a tag (lightweight, or annotated when `message` is given). */
  async createTag(name: string, message?: string): Promise<void> {
    await gitBranch.createTag(this.cwd, name, message ? { annotate: true, message } : undefined);
  }

  /** Delete a tag. */
  async deleteTag(name: string): Promise<void> {
    await gitBranch.deleteTag(this.cwd, name);
  }

  // ── Stash ──

  /** Stash working-tree changes, optionally with a message. */
  async stashSave(message?: string): Promise<string> {
    // The typed wrapper has no message form, so a labelled stash stays raw.
    if (message) return this.run(["stash", "push", "-m", message]);
    const res = await gitIntegrate.stash(this.cwd, { push: true });
    if (res.code !== 0) throw new Error(res.stderr.trim() || "git stash push failed");
    return res.stdout;
  }

  /** Pop a stash entry (default: most recent) back onto the working tree. */
  async stashPop(index?: number): Promise<string> {
    if (index != null) return this.run(["stash", "pop", `stash@{${index}}`]);
    const res = await gitIntegrate.stash(this.cwd, { pop: true });
    if (res.code !== 0) throw new Error(res.stderr.trim() || "git stash pop failed");
    return res.stdout;
  }

  /** Drop a stash entry (default: most recent) without applying it. */
  async stashDrop(index?: number): Promise<string> {
    const args = ["stash", "drop"];
    if (index != null) args.push(`stash@{${index}}`);
    return this.run(args);
  }

  // ── PR-fetch helpers ──

  /**
   * Fetch a refspec from a remote (read-only). Used by prFetch to pull
   * `pull/<n>/head:pr/<n>` without touching any other remote refs.
   */
  async fetchRef(remote: string, refspec: string): Promise<string> {
    return this.run(["fetch", remote, refspec]);
  }

  /** Resolve a git ref to its full SHA. */
  async revParse(ref: string): Promise<string> {
    return gitRead.revParse(this.cwd, ref);
  }
}
