import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkspaceIsolationError, type IsolatedWorkspace, type ProvisionedLink } from "./types.js";
import { provisionWorktree, runSetupCommands } from "./provision.js";

interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function git(cwd: string, args: string[]): GitResult {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export function isGitRepo(root: string): boolean {
  return git(root, ["rev-parse", "--is-inside-work-tree"]).stdout.trim() === "true";
}

/** Tracked-or-untracked uncommitted changes (ignored files excluded). */
export function isDirty(root: string): boolean {
  return git(root, ["status", "--porcelain"]).stdout.trim() !== "";
}

/**
 * Create a detached git worktree at HEAD for isolated agent edits. Refuses a
 * non-git workspace, and a dirty tree unless `includeDirty` (a HEAD worktree
 * would otherwise omit the user's unsaved edits and the agent would solve stale
 * code).
 */
export async function createGitWorktree(
  realRoot: string,
  opts: { includeDirty: boolean; provision?: string[]; setupCommands?: string[] },
): Promise<IsolatedWorkspace> {
  if (!isGitRepo(realRoot)) {
    throw new WorkspaceIsolationError(
      "Workspace isolation requires a git repository (v1 is git-only). " +
        "Run inside a git repo, or use --workspace-isolation off.",
    );
  }
  if (!opts.includeDirty && isDirty(realRoot)) {
    throw new WorkspaceIsolationError(
      "The working tree has uncommitted changes. A HEAD worktree would not include them, " +
        "so the agent could edit stale code. Commit/stash first, or pass --workspace-isolation-include-dirty.",
    );
  }

  const base = await mkdtemp(path.join(tmpdir(), "deepcoder-ws-"));
  const isolatedRoot = path.join(base, "wt");
  const add = git(realRoot, ["worktree", "add", "--detach", isolatedRoot, "HEAD"]);
  if (add.status !== 0) {
    await rm(base, { recursive: true, force: true });
    throw new WorkspaceIsolationError(`git worktree add failed: ${add.stderr.trim() || add.stdout.trim()}`);
  }

  // Symlink dependency dirs (node_modules, …) so checks/builds can run in the
  // worktree. Best-effort; never fatal.
  let provisioned: ProvisionedLink[] = [];
  try {
    provisioned = await provisionWorktree(realRoot, isolatedRoot, opts.provision ?? []);
  } catch {
    /* provisioning is best-effort */
  }

  // Phase 7E: run configured setup commands in the worktree (e.g. `npm ci`).
  // Fail-closed — if setup fails, tear down the worktree and surface the error
  // rather than letting checks run in a half-provisioned tree.
  if (opts.setupCommands && opts.setupCommands.length > 0) {
    try {
      runSetupCommands(isolatedRoot, opts.setupCommands);
    } catch (err) {
      git(realRoot, ["worktree", "remove", "--force", isolatedRoot]);
      await rm(base, { recursive: true, force: true });
      throw err;
    }
  }

    // Provisioned dirs (e.g. node_modules) are symlinks into the real root. If a
    // target isn't gitignored, `git add -A` would stage the symlink and leak a
    // `120000` entry into the patch. Exclude the provisioned paths (worktree-
    // relative) from staging and diffing so they can never enter the patch.
    const excludePathspecs = provisioned
      .map((p) => path.relative(isolatedRoot, p.link))
      .filter((rel) => rel && !rel.startsWith(".."))
      .map((rel) => `:(exclude)${rel}`);
  const pathspec = [".", ...excludePathspecs];

  const stageAll = () => git(isolatedRoot, ["add", "-A", "--", ...pathspec]); // worktree has its own index; .gitignore respected

  return {
    realRoot,
    isolatedRoot,
    backend: "git-worktree",
    provisioned,

    async diff(): Promise<string> {
      stageAll();
      return git(isolatedRoot, ["diff", "--cached", "--binary", "--", ...pathspec]).stdout;
    },

    async changedFiles(): Promise<string[]> {
      stageAll();
      return git(isolatedRoot, ["diff", "--cached", "--name-only", "--", ...pathspec]).stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    },

    async applyPatchToRealRoot({ force }: { force: boolean }): Promise<void> {
      stageAll();
      const patch = git(isolatedRoot, ["diff", "--cached", "--binary", "--", ...pathspec]).stdout;
      if (!patch.trim()) return; // nothing to apply
      const patchFile = path.join(base, "isolated.patch");
      await writeFile(patchFile, patch, "utf8");

      // Never force by default: a clean check must pass first so a live-tree
      // change during the run can't be clobbered.
      if (!force) {
        const check = git(realRoot, ["apply", "--check", "--whitespace=nowarn", patchFile]);
        if (check.status !== 0) {
          throw new WorkspaceIsolationError(
            `patch does not apply cleanly to the real workspace (it changed during the run): ${check.stderr.trim()}`,
          );
        }
      }
      const applied = git(realRoot, ["apply", "--whitespace=nowarn", patchFile]);
      if (applied.status !== 0) {
        throw new WorkspaceIsolationError(`git apply failed: ${applied.stderr.trim()}`);
      }
    },

    async cleanup(): Promise<void> {
      // Detach the worktree via git (updates .git bookkeeping), then remove the
      // temp base. Both paths are inside the temp isolation root.
      git(realRoot, ["worktree", "remove", "--force", isolatedRoot]);
      git(realRoot, ["worktree", "prune"]);
      await rm(base, { recursive: true, force: true });
    },
  };
}
