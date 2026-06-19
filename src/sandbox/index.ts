import { bwrapAvailable, buildBwrapCommand } from "./bubblewrap.js";
import type { SandboxConfig, SandboxMode, WrappedCommand, WrapRequest } from "./types.js";

export type {
  SandboxConfig,
  SandboxMode,
  SandboxFallback,
  SandboxMount,
  WrappedCommand,
  WrapRequest,
} from "./types.js";
export { DEFAULT_SANDBOX } from "./types.js";
export { bwrapAvailable, buildBwrapCommand } from "./bubblewrap.js";

export type ResolvedBackend = "off" | "local" | "bubblewrap";

let warnedFallback = false;

/**
 * Resolve the effective backend for a configured mode (no execution). "fast"
 * picks bubblewrap when available, else local. Backends not yet implemented
 * (docker/podman/runsc/sandbox-exec) degrade to local in this MVP.
 */
export function resolveBackend(mode: SandboxMode): ResolvedBackend {
  switch (mode) {
    case "off":
      return "off";
    case "local":
      return "local";
    case "fast":
    case "bubblewrap":
      return bwrapAvailable() ? "bubblewrap" : "local";
    default:
      return "local"; // docker/podman/runsc/sandbox-exec deferred to a later phase
  }
}

/**
 * Produce a command string ready for the existing exec/spawn call sites. For
 * `off`/`local` the command is returned unchanged (current behavior — full env,
 * output redacted upstream). For bubblewrap it is wrapped with isolation.
 */
export function wrapCommand(req: WrapRequest, config: SandboxConfig): WrappedCommand {
  const backend = resolveBackend(config.mode);
  if (backend === "bubblewrap") {
    return { command: buildBwrapCommand(req, config), backend, sandboxed: true };
  }
  if ((config.mode === "fast" || config.mode === "bubblewrap") && !warnedFallback) {
    warnedFallback = true;
    process.stderr.write(
      "Warning: sandbox mode is fast/bubblewrap but bwrap is unavailable — running commands locally (no isolation).\n",
    );
  }
  return { command: req.command, backend, sandboxed: false };
}
