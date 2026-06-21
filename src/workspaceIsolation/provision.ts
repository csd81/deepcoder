import { symlink, stat, lstat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import type { ProvisionedLink } from "./types.js";
import { WorkspaceIsolationError } from "./types.js";

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

/** Result of one isolation setup command. */
export interface SetupCommandResult {
  command: string;
  ok: boolean;
  code: number | null;
  output: string;
}

const SETUP_TIMEOUT_MS = 300_000; // 5 minutes per command
const SETUP_MAX_OUTPUT = 256 * 1024;

/**
 * Phase 7E — run configured `setupCommands` (e.g. `npm ci --offline`) ONCE in the
 * isolated worktree, after dependency symlinks and before the agent runs.
 *
 * Fail-closed: the FIRST failing command throws `WorkspaceIsolationError` and the
 * remaining commands do not run — so checks never execute in a half-provisioned
 * tree. An empty list is a no-op (the default), so isolation behavior is
 * unchanged unless a project opts in via `.deepcoder/config.json`.
 *
 * Commands run in `isolatedRoot` (the execution plane — never the real repo),
 * each bounded by a timeout and an output cap. They run with the project's own
 * trust (like configured checks), not a fresh sandbox.
 */
export function runSetupCommands(
  isolatedRoot: string,
  commands: readonly string[],
): SetupCommandResult[] {
  const results: SetupCommandResult[] = [];
  for (const command of commands) {
    if (!command || !command.trim()) continue;
    const r = spawnSync(command, {
      cwd: isolatedRoot,
      shell: true,
      encoding: "utf8",
      timeout: SETUP_TIMEOUT_MS,
      maxBuffer: SETUP_MAX_OUTPUT,
    });
    const output = `${r.stdout ?? ""}${r.stderr ?? ""}`.slice(0, SETUP_MAX_OUTPUT);
    const ok = !r.error && r.status === 0;
    results.push({ command, ok, code: r.status, output });
    if (!ok) {
      const why = r.error
        ? r.error.message
        : `exit ${r.status ?? "?"}${r.signal ? ` (signal ${r.signal})` : ""}`;
      throw new WorkspaceIsolationError(
        `Isolation setup command failed (${why}): ${command}\n${output.trim().slice(0, 1000)}`,
      );
    }
  }
  return results;
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
