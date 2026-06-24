import { gitExec, type GitExecResult } from "../git/core.js";

/**
 * Git helpers: read-only inspection plus structured workflow commands.
 *
 * All execution flows through the native git core (`gitExec`) — the single
 * deterministic primitive deepcoder owns — rather than spawning git directly,
 * so there is one git surface, not two (plans/new/feat-native-git-core-plan.md).
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

  /**
   * Like {@link run} but returns the combined stdout+stderr and exit code
   * instead of throwing on a non-zero exit. Used by merge/rebase which exit
   * non-zero on conflicts — a non-error condition we want to inspect, not throw.
   */
  private async runStatus(args: string[]): Promise<GitExecResult> {
    return gitExec(this.cwd, args);
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
    return (await this.run(["status", "--short", "--branch"])).trim();
  }

  async diff(paths?: string[]): Promise<string> {
    // `--` ensures any paths are treated as pathspecs, not git options.
    const args = paths?.length ? ["diff", "--", ...paths] : ["diff"];
    return (await this.run(args)).trim();
  }

  /**
   * Workspace-relative paths of changed files (staged, unstaged, and untracked)
   * from `git status --porcelain`. Rename entries (`old -> new`) report the new
   * path. Returns [] on a clean tree.
   */
  async changedFiles(): Promise<string[]> {
    // Do NOT trim the whole output: porcelain lines for an unstaged change start
    // with a space (" M path"), and a leading trim would eat the first line's
    // status column and corrupt its path. Split first, parse each line from the
    // fixed 3-char (XY + space) prefix.
    const out = await this.run(["status", "--porcelain"]);
    const files: string[] = [];
    for (const line of out.split("\n")) {
      if (line.length < 4) continue; // blank line or too short to carry a path
      let p = line.slice(3).trim(); // drop the 2-char status code + separator
      const arrow = p.indexOf(" -> ");
      if (arrow >= 0) p = p.slice(arrow + 4).trim(); // rename: take the destination
      // Strip surrounding quotes git adds for paths with special chars.
      if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
      if (p) files.push(p);
    }
    return files;
  }

  /** One-line summary of how dirty the tree is. */
  async dirtySummary(): Promise<string> {
    const out = (await this.run(["status", "--porcelain"])).trim();
    if (!out) return "clean working tree";
    const files = out.split("\n").length;
    return `${files} file${files === 1 ? "" : "s"} changed`;
  }

  // ── Read-only workflow ──

  /** Last `count` commits, one line each (decorated, colored). */
  async log(count = 10): Promise<string> {
    return this.run(["log", `--max-count=${count}`, "--oneline", "--decorate"]);
  }

  /** Current branch plus all local and remote branch names. */
  async branches(): Promise<{ current: string; local: string[]; remote: string[] }> {
    const current = (await this.run(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    const parse = (out: string): string[] =>
      out
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
    const local = parse(await this.run(["branch", "--format=%(refname:short)"]));
    // Skip the symbolic "origin/HEAD -> origin/main" pointer line.
    const remote = parse(await this.run(["branch", "-r", "--format=%(refname:short)"])).filter(
      (r) => !r.includes("->"),
    );
    return { current, local, remote };
  }

  /** Blame annotation for a file. */
  async blame(file: string): Promise<string> {
    return this.run(["blame", "--", file]);
  }

  /** Raw `git stash list` output. */
  async stashList(): Promise<string> {
    return (await this.run(["stash", "list"])).trim();
  }

  /** Diff of staged (cached) changes only. */
  async diffStaged(): Promise<string> {
    return (await this.run(["diff", "--cached"])).trim();
  }

  // ── Mutating workflow ──

  /**
   * Commit changes. With `paths`, commits only those paths; otherwise stages
   * all tracked modifications (`-a`) and commits. Returns the new commit hash
   * and raw stdout.
   */
  async commit(message: string, paths?: string[]): Promise<{ hash: string; stdout: string }> {
    const args = paths?.length
      ? ["commit", "-m", message, "--", ...paths]
      : ["commit", "-a", "-m", message]; // stage all tracked modifications
    const stdout = await this.run(args);
    return { hash: this.commitHash(stdout), stdout };
  }

  /** Create a revert commit for `commit` (uses --no-edit for a default message). */
  async revert(commit: string): Promise<string> {
    return this.run(["revert", "--no-edit", commit]);
  }

  /** Reset HEAD to `commit` with the given mode. */
  async reset(commit: string, mode: "soft" | "mixed" | "hard"): Promise<string> {
    return this.run(["reset", `--${mode}`, commit]);
  }

  /** Amend the last commit with a new message. Returns the rewritten hash. */
  async amend(message: string): Promise<{ hash: string; stdout: string }> {
    const stdout = await this.run(["commit", "--amend", "-m", message]);
    return { hash: this.commitHash(stdout), stdout };
  }

  /** Cherry-pick a commit onto the current branch. */
  async cherryPick(commit: string): Promise<string> {
    return this.run(["cherry-pick", commit]);
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
    const res = await this.runStatus(["merge", "--no-edit", branch]);
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
    const res = await this.runStatus(["rebase", target]);
    if (res.code === 0) return { ok: true };
    const conflicts = await this.unmergedPaths();
    if (conflicts.length) return { ok: false, conflicts };
    throw new Error(res.stderr.trim() || res.stdout.trim() || `git rebase ${target} failed`);
  }

  /** Check out an existing branch. */
  async checkout(branch: string): Promise<string> {
    return this.run(["checkout", branch]);
  }

  /** Create and switch to a new branch (`git checkout -b`). */
  async createBranch(name: string): Promise<string> {
    return this.run(["checkout", "-b", name]);
  }

  /** Delete a branch (`-d`, or `-D` to force-delete an unmerged branch). */
  async deleteBranch(name: string, force = false): Promise<string> {
    return this.run(["branch", force ? "-D" : "-d", name]);
  }

  // ── Stash ──

  /** Stash working-tree changes, optionally with a message. */
  async stashSave(message?: string): Promise<string> {
    const args = ["stash", "push"];
    if (message) args.push("-m", message);
    return this.run(args);
  }

  /** Pop a stash entry (default: most recent) back onto the working tree. */
  async stashPop(index?: number): Promise<string> {
    const args = ["stash", "pop"];
    if (index != null) args.push(`stash@{${index}}`);
    return this.run(args);
  }

  /** Drop a stash entry (default: most recent) without applying it. */
  async stashDrop(index?: number): Promise<string> {
    const args = ["stash", "drop"];
    if (index != null) args.push(`stash@{${index}}`);
    return this.run(args);
  }

  /** Extract the short hash from a `git commit` summary line "[branch <hash>] ...". */
  private commitHash(stdout: string): string {
    return stdout.match(/\[[^\]]*?\s([0-9a-f]+)\]/)?.[1] ?? "unknown";
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
    return (await this.run(["rev-parse", ref])).trim();
  }
}
