import { createGitWorktree } from "./gitWorktree.js";
import type { IsolatedWorkspace, WorkspaceIsolationConfig } from "./types.js";

export type {
  WorkspaceIsolationConfig,
  WorkspaceIsolationMode,
  WorkspaceIsolationBackend,
  IsolatedWorkspace,
} from "./types.js";
export type { ProvisionedLink } from "./types.js";
export { DEFAULT_WORKSPACE_ISOLATION, WorkspaceIsolationError } from "./types.js";
export { isGitRepo, isDirty } from "./gitWorktree.js";
export { provisionWorktree } from "./provision.js";

/**
 * Create an isolated workspace for a run. v1 is git-only: `backend: "auto"` (and
 * "git-worktree") use a detached worktree; "copy" is deferred and refused.
 */
export async function createIsolatedWorkspace(
  realRoot: string,
  config: WorkspaceIsolationConfig,
): Promise<IsolatedWorkspace> {
  if (config.backend === "copy") {
    const { WorkspaceIsolationError } = await import("./types.js");
    throw new WorkspaceIsolationError("copy backend is not implemented yet (Phase 7D v1 is git-only).");
  }
  return createGitWorktree(realRoot, { includeDirty: config.includeDirty, provision: config.provision });
}
