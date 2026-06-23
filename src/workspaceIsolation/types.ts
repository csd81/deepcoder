// Workspace isolation (Phase 7D). Agent file mutations happen in a disposable
// git worktree of HEAD; the real repo changes only when the user applies the
// resulting patch. Complements Phase 7A sandboxing (which isolates *commands*).
//
// Control plane stays on the real root (config, sessions, MCP, provider env,
// slash state); only the *execution* root (file tools, run_bash, checks) moves
// to the isolated worktree.

export type WorkspaceIsolationMode = "off" | "patch" | "keep";
export const VALID_ISOLATION_MODES: readonly WorkspaceIsolationMode[] = ["off", "patch", "keep"];
export type WorkspaceIsolationBackend = "auto" | "git-worktree" | "copy";

export interface WorkspaceIsolationConfig {
  mode: WorkspaceIsolationMode;
  backend: WorkspaceIsolationBackend;
  keepOnSuccess: boolean;
  keepOnFailure: boolean;
  includeDirty: boolean;
  /** Paths excluded from copy fallback (deferred); git backend uses .gitignore. */
  exclude: string[];
  /**
   * Dependency dirs to symlink into the worktree so checks/builds can run (a
   * worktree of HEAD has no gitignored deps). Default `["node_modules"]`.
   */
  provision: string[];
  /** Optional commands run once in the worktree before the agent (e.g. `npm ci`). */
  setupCommands: string[];
}

/** A dependency dir symlinked into the worktree, and its real target. */
export interface ProvisionedLink {
  /** Absolute path of the symlink inside the worktree. */
  link: string;
  /** Absolute real path the symlink points at. */
  target: string;
}

export interface IsolatedWorkspace {
  realRoot: string;
  isolatedRoot: string;
  backend: "git-worktree";
  /**
   * Dep symlinks provisioned into the worktree (Phase 7E). When the sandbox is
   * active, these targets must be bound read-only so the symlinks resolve inside
   * bwrap. Empty when nothing was provisioned.
   */
  provisioned: ProvisionedLink[];
  /** Unified diff of the agent's changes vs HEAD (respects .gitignore). */
  diff(): Promise<string>;
  /** Workspace-relative paths changed in the isolated workspace. */
  changedFiles(): Promise<string[]>;
  /** `git apply --check` then apply the patch to the real root. Throws on conflict. */
  applyPatchToRealRoot(opts: { force: boolean }): Promise<void>;
  /** Remove the worktree; confined to the temp isolation root. */
  cleanup(): Promise<void>;
}

export const DEFAULT_WORKSPACE_ISOLATION: WorkspaceIsolationConfig = {
  mode: "off",
  backend: "auto",
  keepOnSuccess: false,
  keepOnFailure: true,
  includeDirty: false,
  exclude: ["node_modules", "dist", ".deepcoder/sessions", "evals/local-bench/runs"],
  provision: ["node_modules"],
  setupCommands: [],
};

/** Thrown when isolation can't be set up (non-git, dirty tree, git error). */
export class WorkspaceIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceIsolationError";
  }
}
