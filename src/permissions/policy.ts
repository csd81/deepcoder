import type { ToolInvocation } from "../tools/types.js";
import type { ApprovalMode } from "../config/config.js";
import { classifyCommand } from "./commandClassifier.js";

export type ApprovalDecision = "allow" | "ask" | "deny";

export interface PermissionOptions {
  /** Whether execute-kind MCP tools may run. Off in Phase 4A. */
  mcpExecuteEnabled?: boolean;
}

/**
 * Decide whether an invocation may run, combining the tool's `kind` with the
 * session approval mode. `execute` tools additionally defer to the command
 * classifier. This is the single gate every mutating/executing tool passes
 * through before the agent loop runs it.
 */
export function checkPermission(
  invocation: ToolInvocation,
  mode: ApprovalMode,
  opts: PermissionOptions = {},
): ApprovalDecision {
  // An execute-kind MCP tool is denied unless explicitly enabled (Phase 4A:
  // off). MCP read-only tools fall through to the normal read-only allowance.
  if (invocation.source === "mcp" && invocation.kind === "execute" && !opts.mcpExecuteEnabled) {
    return "deny";
  }

  // Read-only and session-state tools never touch the filesystem/shell, so
  // they are always allowed regardless of mode.
  if (invocation.kind === "read-only" || invocation.kind === "session") return "allow";

  if (mode === "readonly") return "deny";

  if (invocation.kind === "mutate") {
    return mode === "auto" ? "allow" : "ask";
  }

  // kind === "execute": classify the command, then fold in the mode.
  const classified = invocation.command ? classifyCommand(invocation.command) : "ask";
  if (classified === "deny") return "deny";
  if (mode === "auto") return classified; // allow | ask
  return classified === "allow" ? "allow" : "ask";
}
