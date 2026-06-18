import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

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

const mcpServerSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  mode: z.enum(["readonly", "execute"]).optional(),
});

/**
 * Load `.deepcoder/config.json` from the workspace root. Missing files are
 * silently tolerated; a malformed file or invalid entries warn to stderr and
 * are skipped (a bad config never blocks startup). Each MCP server is validated
 * independently so one bad entry doesn't discard the others.
 */
export function loadFileConfig(workspaceRoot: string): FileConfig {
  const file = path.join(workspaceRoot, ".deepcoder", "config.json");
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    warn(`malformed JSON (${(err as Error).message})`);
    return {};
  }
  if (!parsed || typeof parsed !== "object") {
    warn("top-level value is not an object");
    return {};
  }

  const servers = (parsed as { mcpServers?: unknown }).mcpServers;
  const mcpServers: Record<string, McpServerConfig> = {};
  if (servers && typeof servers === "object") {
    for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
      const result = mcpServerSchema.safeParse(value);
      if (result.success) mcpServers[name] = result.data;
      else warn(`ignoring mcpServers["${name}"]: ${result.error.issues.map((i) => i.message).join("; ")}`);
    }
  }
  return { mcpServers };
}

function warn(msg: string): void {
  process.stderr.write(`Warning: .deepcoder/config.json — ${msg}\n`);
}
