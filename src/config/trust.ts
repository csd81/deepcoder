import { realpathSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Whether a workspace is trusted to run the CODE-EXECUTING parts of its own
 * `.deepcoder/config.json` — MCP servers (spawned at startup) and hooks (run on
 * session events). Untrusted by default: opening an arbitrary repo must never
 * auto-run its commands before the user approves anything.
 *
 * Trust is granted explicitly by either:
 *   - `DEEPCODER_TRUST_WORKSPACE=1` (per-invocation opt-in), or
 *   - listing the workspace's real path (one per line) in
 *     `~/.deepcoder/trusted-workspaces`.
 *
 * Never throws — any error means "not trusted" (fail-closed).
 */
export function isWorkspaceTrusted(workspaceRoot: string): boolean {
  if (["1", "true", "yes"].includes((process.env.DEEPCODER_TRUST_WORKSPACE ?? "").toLowerCase())) {
    return true;
  }
  try {
    const real = realpathSync(workspaceRoot);
    const listFile = path.join(os.homedir(), ".deepcoder", "trusted-workspaces");
    const trusted = readFileSync(listFile, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    return trusted.includes(real);
  } catch {
    return false;
  }
}
