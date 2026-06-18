import { readFileSync } from "node:fs";
import path from "node:path";

export type McpMode = "readonly" | "execute";

export interface McpServerConfig {
  command: string;
  args?: string[];
  enabled?: boolean;
  /** Operator's trust assertion about the server. Defaults to "execute" (untrusted). */
  mode?: McpMode;
}

/** Shape of `.deepcoder/config.json` (all fields optional). */
export interface FileConfig {
  mcpServers?: Record<string, McpServerConfig>;
}

/**
 * Load `.deepcoder/config.json` from the workspace root. Missing or malformed
 * files are tolerated (return {}) so a bad config never blocks startup — a parse
 * error is reported to stderr but not fatal.
 */
export function loadFileConfig(workspaceRoot: string): FileConfig {
  const file = path.join(workspaceRoot, ".deepcoder", "config.json");
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as FileConfig;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    process.stderr.write(`Warning: ignoring malformed .deepcoder/config.json (${(err as Error).message})\n`);
    return {};
  }
}
