import { bwrapAvailable, buildBwrapCommand } from "./bubblewrap.js";
import type { SandboxConfig, SandboxFallback, SandboxMode, WrappedCommand, WrapRequest } from "./types.js";

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
 *
 * When `fallback` is "fail" and the requested backend cannot be satisfied,
 * throws instead of degrading.
 */
export function resolveBackend(mode: SandboxMode, fallback?: SandboxFallback): ResolvedBackend {
  switch (mode) {
    case "off":
      return "off";
    case "local":
      return "local";
    case "fast":
      if (bwrapAvailable()) return "bubblewrap";
      return "local";
    case "bubblewrap":
      if (bwrapAvailable()) return "bubblewrap";
      if (fallback === "fail") {
        throw new Error(
          "bwrap (bubblewrap) is not available on this system — cannot sandbox. " +
            "Set sandbox.mode to \"fast\", \"local\", or \"off\" to proceed without isolation.",
        );
      }
      return "local";
    default:
      // docker/podman/runsc/sandbox-exec deferred to a later phase
      if (fallback === "fail") {
        throw new Error(
          `Sandbox mode "${mode}" is not yet implemented — cannot sandbox. ` +
            'Set sandbox.mode to "fast", "local", or "off" to proceed without isolation.',
        );
      }
      return "local";
  }
}

/**
 * Produce a command string ready for the existing exec/spawn call sites. For
 * `off`/`local` the command is returned unchanged (current behavior — full env,
 * output redacted upstream). For bubblewrap it is wrapped with isolation.
 */
export function wrapCommand(req: WrapRequest, config: SandboxConfig): WrappedCommand {
  const backend = resolveBackend(config.mode, config.fallback);
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
