import type { Tool, ToolInvocation } from "../tools/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import { McpClient } from "./client.js";
import { adaptMcpInputSchema } from "./schemaAdapter.js";
import type { McpServerConfig } from "../config/fileConfig.js";

export const MCP_TOOL_PREFIX = "mcp__";

/**
 * Sanitise a server/tool name fragment into the provider tool-name alphabet
 * (`[A-Za-z0-9_-]`). Invalid runs collapse to `_`.
 */
export function sanitizeNamePart(s: string): string {
  const cleaned = s.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "x";
}

/** Build a namespaced, length-capped, provider-valid tool name. */
export function mcpToolName(server: string, tool: string): string {
  const name = `${MCP_TOOL_PREFIX}${sanitizeNamePart(server)}__${sanitizeNamePart(tool)}`;
  return name.length > 64 ? name.slice(0, 64) : name;
}

export interface McpServerStatus {
  name: string;
  mode: "readonly" | "execute";
  connected: boolean;
  error?: string;
  tools: string[]; // namespaced tool names
}

/**
 * Connects configured MCP servers, discovers their tools, and exposes them as
 * Deepcoder `Tool`s. A server that fails to start is recorded as an error and
 * skipped — it never crashes the CLI.
 *
 * Trust model: an MCP tool is `read-only` only if its server is configured
 * `mode: "readonly"` (an operator assertion about the server). Otherwise it is
 * `execute`, and in Phase 4A execute-mode tools are denied by the permission
 * policy. MCP output is untrusted text — already size-capped in McpClient — and
 * flows through the normal tool-result path, so it can never alter policy.
 */
export class McpManager {
  private clients: McpClient[] = [];
  private statuses: McpServerStatus[] = [];

  constructor(private servers: Record<string, McpServerConfig>) {}

  async connectAll(): Promise<void> {
    await this.closeAll();
    this.clients = [];
    this.statuses = [];
    for (const [name, cfg] of Object.entries(this.servers)) {
      if (cfg.enabled === false) {
        this.statuses.push({ name, mode: cfg.mode === "readonly" ? "readonly" : "execute", connected: false, tools: [], error: "disabled" });
        continue;
      }
      const client = new McpClient(name, cfg);
      try {
        await client.connect();
        this.clients.push(client);
        this.statuses.push({ name, mode: client.mode, connected: true, tools: [] });
      } catch (err) {
        this.statuses.push({ name, mode: client.mode, connected: false, tools: [], error: (err as Error).message });
        await client.close();
      }
    }
  }

  /** Build wrapped Deepcoder tools for every discovered MCP tool. */
  async tools(): Promise<Tool[]> {
    const out: Tool[] = [];
    const used = new Set<string>();
    for (const client of this.clients) {
      const status = this.statuses.find((s) => s.name === client.name)!;
      status.tools = [];
      let discovered;
      try {
        discovered = await client.listTools();
      } catch (err) {
        status.error = `listTools failed: ${(err as Error).message}`;
        continue;
      }
      for (const info of discovered) {
        // Sanitise + de-collide so server/tool names can't produce a
        // provider-invalid or duplicate model tool name.
        let toolName = mcpToolName(client.name, info.name);
        if (used.has(toolName)) {
          let i = 2;
          const base = toolName.slice(0, 60);
          while (used.has(`${base}_${i}`)) i++;
          toolName = `${base}_${i}`;
        }
        used.add(toolName);
        status.tools.push(toolName);
        out.push(wrapMcpTool(client, info.name, toolName, info.description, info.inputSchema));
      }
    }
    return out;
  }

  /**
   * Atomically refresh the MCP tools in a registry: drop all previously
   * registered MCP tools, then register the currently discovered set. Prevents
   * `/mcp reload` from leaving stale wrappers pointing at a closed client.
   */
  async registerInto(registry: ToolRegistry): Promise<void> {
    registry.unregisterByPrefix(MCP_TOOL_PREFIX);
    for (const tool of await this.tools()) registry.register(tool);
  }

  status(): McpServerStatus[] {
    return this.statuses;
  }

  async closeAll(): Promise<void> {
    await Promise.all(this.clients.map((c) => c.close()));
    this.clients = [];
  }
}

function wrapMcpTool(
  client: McpClient,
  remoteName: string,
  toolName: string,
  description: string,
  inputSchema: Record<string, unknown>,
): Tool {
  const kind = client.mode === "readonly" ? "read-only" : "execute";
  return {
    name: toolName,
    description: `[MCP:${client.name}] ${description}`,
    kind,
    rawSchema: adaptMcpInputSchema(inputSchema),
    build(rawArgs): ToolInvocation {
      const args = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;
      return {
        kind,
        source: "mcp",
        describe: () => `${toolName}(${JSON.stringify(args).slice(0, 120)})`,
        async execute() {
          try {
            const output = await client.callTool(remoteName, args);
            return { output: output || "(no output)" };
          } catch (err) {
            return { output: `MCP tool ${toolName} failed: ${(err as Error).message}`, isError: true };
          }
        },
      };
    },
  };
}
