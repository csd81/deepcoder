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

export interface CheckConfig {
  command: string;
  timeoutMs?: number;
}

/** Shape of `.deepcoder/config.json` (all fields optional). */
export interface FileConfig {
  mcpServers?: Record<string, McpServerConfig>;
  checks?: Record<string, CheckConfig>;
}

const mcpServerSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  mode: z.enum(["readonly", "execute"]).optional(),
});

const CHECK_NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;
const checkSchema = z.object({
  command: z.string().min(1),
  timeoutMs: z.number().int().positive().optional(),
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

  const rawChecks = (parsed as { checks?: unknown }).checks;
  const checks: Record<string, CheckConfig> = {};
  if (rawChecks && typeof rawChecks === "object") {
    for (const [name, value] of Object.entries(rawChecks as Record<string, unknown>)) {
      if (!CHECK_NAME_RE.test(name)) {
        warn(`ignoring check "${name}": name must match ${CHECK_NAME_RE}`);
        continue;
      }
      const result = checkSchema.safeParse(value);
      if (result.success) checks[name] = result.data;
      else warn(`ignoring checks["${name}"]: ${result.error.issues.map((i) => i.message).join("; ")}`);
    }
  }

  return { mcpServers, checks };
}

function warn(msg: string): void {
  process.stderr.write(`Warning: .deepcoder/config.json — ${msg}\n`);
}
