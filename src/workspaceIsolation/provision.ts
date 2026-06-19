import { symlink, stat, lstat } from "node:fs/promises";
import path from "node:path";
import type { ProvisionedLink } from "./types.js";

/**
 * Symlink dependency dirs (Phase 7E) from the real root into a fresh worktree so
 * checks/builds can run — a `git worktree` of HEAD checks out tracked files only,
 * so gitignored deps (`node_modules`, …) are absent. Symlinks (not copies) keep
 * it fast; removing the worktree later removes the symlinks without touching the
 * targets.
 *
 * Only allowlisted names are linked, each must (a) exist in the real root and
 * (b) be absent in the worktree (so tracked dirs are never shadowed). Path
 * separators in a name are rejected — this is a dep-dir allowlist, not arbitrary
 * mounts. Returns the {link,target} pairs (for sandbox read-only mounts).
 */
export async function provisionWorktree(
  realRoot: string,
  isolatedRoot: string,
  names: string[],
): Promise<ProvisionedLink[]> {
  const out: ProvisionedLink[] = [];
  for (const name of names) {
    if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) continue;
    const target = path.join(realRoot, name);
    const link = path.join(isolatedRoot, name);
    if (!(await exists(target))) continue; // nothing to provision
    if (await exists(link)) continue; // already present (e.g. tracked) — never shadow
    try {
      await symlink(target, link, "dir");
      out.push({ link, target });
    } catch {
      /* a provisioning failure is non-fatal; the check will report if it can't run */
    }
  }
  return out;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p); // follows symlinks — a real target must exist
    return true;
  } catch {
    // a dangling/own symlink still counts as "present" so we don't shadow it
    try {
      await lstat(p);
      return true;
    } catch {
      return false;
    }
  }
}
