// Fast tool-level sandboxing (Phase 7A). Only risky tool executions (run_bash,
// configured checks) are isolated; the deepcoder process, file tools, config,
// and session state stay local. File tools keep using path confinement.

/** Requested sandbox mode. "fast" resolves to the best available backend. */
export type SandboxMode =
  | "off"
  | "fast"
  | "local"
  | "bubblewrap"
  | "sandbox-exec"
  | "docker"
  | "podman"
  | "runsc";

/** What to do when the requested backend is unavailable at run time. */
export type SandboxFallback = "ask" | "local" | "fail";

export interface SandboxMount {
  path: string;
  /** Read-only by default — only the workspace is writable. */
  mode: "ro" | "rw";
}

export interface SandboxConfig {
  mode: SandboxMode;
  network: "on" | "off";
  /** Whether the workspace is mounted writable (default true). */
  workspaceWrite: boolean;
  /** Extra mounts; default read-only (security rule). */
  extraMounts: SandboxMount[];
  timeoutMs: number;
  fallback: SandboxFallback;
}

/** A command string ready to hand to the existing exec/spawn call sites. */
export interface WrappedCommand {
  /** Shell command to execute. Identical to the input when not sandboxed. */
  command: string;
  /** Backend actually used: "off" | "local" | "bubblewrap". */
  backend: string;
  /** True iff `command` is wrapped in an isolation layer. */
  sandboxed: boolean;
}

export interface WrapRequest {
  command: string;
  workspaceRoot: string;
  /** Per-call override of the configured network policy. */
  network?: "on" | "off";
}

export const DEFAULT_SANDBOX: SandboxConfig = {
  mode: "fast",
  network: "on",
  workspaceWrite: true,
  extraMounts: [],
  timeoutMs: 120_000,
  fallback: "ask",
};
