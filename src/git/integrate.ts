/**
 * Native git integration ops — typed merge/rebase/stash/cherry-pick/revert/apply.
 *
 * Builds on src/git/core.ts (Phase 0 of plans/new/feat-native-git-core-plan.md):
 * args are assembled ONLY from typed options (never raw user strings spliced into a
 * command line), every state-changing op is flagged `{ mutating: true }` so a gating
 * layer can intercept it, and we never inject `--force`. These ops frequently fail by
 * design (merge/rebase/cherry-pick conflicts), so each returns the raw `GitExecResult`
 * — callers inspect `code`/`stdout`/`stderr` to distinguish success from conflict
 * rather than relying on a throw.
 */
import { gitExec, type GitExecResult } from "./core.js";

export type { GitExecResult } from "./core.js";

/** Merge `ref` into the current branch. `abort:true` runs `--abort` and ignores `ref`. */
export function merge(
  root: string,
  ref: string,
  opts?: { noFf?: boolean; squash?: boolean; abort?: boolean },
): Promise<GitExecResult> {
  const args = ["merge"];
  if (opts?.abort) {
    args.push("--abort");
    return gitExec(root, args, { mutating: true });
  }
  if (opts?.noFf) args.push("--no-ff");
  if (opts?.squash) args.push("--squash");
  args.push(ref);
  return gitExec(root, args, { mutating: true });
}

/** Rebase. `continue`/`abort` drive an in-progress rebase; otherwise replay onto/upstream. */
export function rebase(
  root: string,
  opts: { onto?: string; upstream?: string; continue?: boolean; abort?: boolean },
): Promise<GitExecResult> {
  const args = ["rebase"];
  if (opts.abort) {
    args.push("--abort");
    return gitExec(root, args, { mutating: true });
  }
  if (opts.continue) {
    args.push("--continue");
    return gitExec(root, args, { mutating: true });
  }
  if (opts.onto) args.push("--onto", opts.onto);
  if (opts.upstream) args.push(opts.upstream);
  return gitExec(root, args, { mutating: true });
}

/** Stash ops. `push` → `git stash push [-u]`; `pop`/`list` map to their subcommands. */
export function stash(
  root: string,
  opts: { push?: boolean; includeUntracked?: boolean; pop?: boolean; list?: boolean },
): Promise<GitExecResult> {
  const args = ["stash"];
  if (opts.list) {
    args.push("list");
    return gitExec(root, args, { mutating: true });
  }
  if (opts.pop) {
    args.push("pop");
    return gitExec(root, args, { mutating: true });
  }
  if (opts.push) {
    args.push("push");
    if (opts.includeUntracked) args.push("-u");
  }
  return gitExec(root, args, { mutating: true });
}

/** Cherry-pick `ref` onto the current branch. `abort:true` runs `--abort` and ignores `ref`. */
export function cherryPick(
  root: string,
  ref?: string,
  opts?: { abort?: boolean },
): Promise<GitExecResult> {
  const args = ["cherry-pick"];
  if (opts?.abort) {
    args.push("--abort");
    return gitExec(root, args, { mutating: true });
  }
  if (ref) args.push(ref);
  return gitExec(root, args, { mutating: true });
}

/** Revert the commit `ref` (creates an inverse commit). `noEdit` skips the editor. */
export function revert(
  root: string,
  ref: string,
  opts?: { noEdit?: boolean },
): Promise<GitExecResult> {
  const args = ["revert"];
  if (opts?.noEdit) args.push("--no-edit");
  args.push(ref);
  return gitExec(root, args, { mutating: true });
}

/** Apply a patch file. `check` validates only; `threeWay` enables 3-way merge on conflict. */
export function apply(
  root: string,
  opts: { patchFile: string; check?: boolean; threeWay?: boolean },
): Promise<GitExecResult> {
  const args = ["apply"];
  if (opts.check) args.push("--check");
  if (opts.threeWay) args.push("--3way");
  args.push(opts.patchFile);
  return gitExec(root, args, { mutating: true });
}
