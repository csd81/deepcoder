/**
 * Phase 10S — workspace containment.
 *
 * Containment is a guarantee that no file access escapes the workspace root. It
 * is ON BY DEFAULT (secure by default); disable with `--no-contain` /
 * `DEEPCODER_CONTAIN=0` / config. File tools are already contained by
 * src/workspace/paths.ts; this closes the SHELL gap by forcing a fail-closed,
 * workspace-only sandbox for every command that flows through `wrapCommand`
 * (run_bash, configured checks, `!cmd`, hooks).
 *
 * OUT OF SCOPE (v1): MCP execute tools and the `run_in_shell` PTY tool are NOT
 * routed through `wrapCommand`, so containment does not sandbox them.
 */
import type { SandboxConfig } from "../sandbox/types.js";

export interface ContainmentConfig {
  /** Master switch — default ON. When on, the effective sandbox is workspace-locked. */
  enabled: boolean;
}

export const DEFAULT_CONTAINMENT: ContainmentConfig = { enabled: true };

/**
 * Rewrite a sandbox config into a fail-closed, workspace-only profile:
 * - `mode: "bubblewrap"` — the real isolation backend (not `fast`, which silently
 *   degrades to the uncontained `local` backend when bwrap is missing).
 * - `fallback: "fail"` — `resolveBackend` THROWS when bubblewrap is unavailable,
 *   so a contained run refuses rather than degrading to no containment.
 * - `extraMounts: []` — drop any file/env-configured external mounts that would
 *   punch a hole outside the workspace. (Workspace-isolation re-adds its own
 *   provisioned read-only mounts later, in setupIsolation, after loadConfig.)
 * `network`, `workspaceWrite`, and `timeoutMs` are left as configured —
 * containment is a filesystem property, not a network one.
 */
export function applyContainment(sandbox: SandboxConfig): SandboxConfig {
  return { ...sandbox, mode: "bubblewrap", fallback: "fail", extraMounts: [] };
}
