/**
 * Native git branch / worktree / tag wrappers — typed, deterministic.
 *
 * Part of the native git core (plans/new/feat-native-git-core-plan.md): every op
 * builds its argv from typed options and runs through `gitExec`. State-changing ops
 * pass `{ mutating: true }`; listing ops are read-only. A force/delete-force flag is
 * NEVER added unless the caller explicitly opts in via `opts.force` — the safe form
 * (`-d`, plain `worktree remove`, etc.) is the default.
 */
import { gitExec } from "./core.js";

/** Run a state-changing git command; throw on nonzero exit with git's stderr. */
async function runMutating(root: string, args: string[], fallbackMsg: string): Promise<void> {
  const res = await gitExec(root, args, { mutating: true });
  if (res.code !== 0) {
    throw new Error(res.stderr.trim() || fallbackMsg);
  }
}

/** Create a branch. `switch:true` → `git switch -c <name>`; else `git branch <name>`. */
export async function createBranch(
  root: string,
  name: string,
  opts?: { switch?: boolean },
): Promise<void> {
  const args = opts?.switch ? ["switch", "-c", name] : ["branch", name];
  await runMutating(root, args, `failed to create branch ${name}`);
}

/** Switch HEAD to an existing branch (`git switch <name>`). */
export async function switchBranch(root: string, name: string): Promise<void> {
  await runMutating(root, ["switch", name], `failed to switch to branch ${name}`);
}

/** Delete a branch. `-d` by default; `-D` only when `force:true`. */
export async function deleteBranch(
  root: string,
  name: string,
  opts?: { force?: boolean },
): Promise<void> {
  const flag = opts?.force ? "-D" : "-d";
  await runMutating(root, ["branch", flag, name], `failed to delete branch ${name}`);
}

/** Rename a branch (`git branch -m <from> <to>`). */
export async function renameBranch(root: string, from: string, to: string): Promise<void> {
  await runMutating(root, ["branch", "-m", from, to], `failed to rename branch ${from} -> ${to}`);
}

/** Add a linked worktree (`git worktree add [-b <branch>] <dir>`). */
export async function worktreeAdd(
  root: string,
  dir: string,
  opts?: { branch?: string },
): Promise<void> {
  const args = ["worktree", "add"];
  if (opts?.branch) args.push("-b", opts.branch);
  args.push(dir);
  await runMutating(root, args, `failed to add worktree ${dir}`);
}

/** Remove a linked worktree. Adds `--force` only when `force:true`. */
export async function worktreeRemove(
  root: string,
  dir: string,
  opts?: { force?: boolean },
): Promise<void> {
  const args = ["worktree", "remove"];
  if (opts?.force) args.push("--force");
  args.push(dir);
  await runMutating(root, args, `failed to remove worktree ${dir}`);
}

/** List linked worktrees (`git worktree list`) — read-only. */
export async function worktreeList(root: string): Promise<string> {
  const res = await gitExec(root, ["worktree", "list"]);
  if (res.code !== 0) {
    throw new Error(res.stderr.trim() || "failed to list worktrees");
  }
  return res.stdout;
}

/** Prune stale worktree administrative files (`git worktree prune`). */
export async function worktreePrune(root: string): Promise<void> {
  await runMutating(root, ["worktree", "prune"], "failed to prune worktrees");
}

/** Create a tag. `annotate:true` → `git tag -a -m <message> <name>`; else lightweight. */
export async function createTag(
  root: string,
  name: string,
  opts?: { annotate?: boolean; message?: string },
): Promise<void> {
  const args = ["tag"];
  if (opts?.annotate) args.push("-a", "-m", opts.message ?? name);
  args.push(name);
  await runMutating(root, args, `failed to create tag ${name}`);
}

/** Delete a tag (`git tag -d <name>`). */
export async function deleteTag(root: string, name: string): Promise<void> {
  await runMutating(root, ["tag", "-d", name], `failed to delete tag ${name}`);
}
