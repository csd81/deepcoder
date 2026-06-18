import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServerConfig } from "../config/fileConfig.js";

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Output cap so a hostile/chatty MCP server can't flood the model context. */
export const MCP_OUTPUT_LIMIT = 16 * 1024;

/**
 * A connected MCP server. Connection failures are surfaced to the caller, which
 * is expected to warn-and-skip rather than crash.
 */
export class McpClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;

  constructor(
    readonly name: string,
    private config: McpServerConfig,
  ) {}

  get mode(): "readonly" | "execute" {
    return this.config.mode === "readonly" ? "readonly" : "execute";
  }

  async connect(timeoutMs = 15_000): Promise<void> {
    const transport = new StdioClientTransport({
      command: this.config.command,
      args: this.config.args ?? [],
    });
    const client = new Client({ name: "deepcoder", version: "0.1.0" }, { capabilities: {} });
    // Track both BEFORE connecting so a timeout/failure can still tear down the
    // spawned child process (close() would otherwise see nulls and orphan it).
    this.transport = transport;
    this.client = client;
    try {
      await withTimeout(client.connect(transport), timeoutMs, `connect to MCP server "${this.name}"`);
    } catch (err) {
      await this.close();
      throw err;
    }
  }

  async listTools(): Promise<McpToolInfo[]> {
    if (!this.client) throw new Error(`MCP server "${this.name}" is not connected`);
    const res = await this.client.listTools();
    return res.tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: "object" },
    }));
  }

  async callTool(toolName: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<string> {
    if (!this.client) throw new Error(`MCP server "${this.name}" is not connected`);
    const res = await withTimeout(
      this.client.callTool({ name: toolName, arguments: args }),
      timeoutMs,
      `call MCP tool "${toolName}"`,
    );
    // Flatten content blocks into untrusted text, then cap the size.
    const content = Array.isArray(res.content) ? res.content : [];
    const text = content
      .map((c: { type?: string; text?: string }) => (c.type === "text" ? c.text ?? "" : `[${c.type ?? "non-text"} content]`))
      .join("\n");
    return text.length > MCP_OUTPUT_LIMIT ? text.slice(0, MCP_OUTPUT_LIMIT) + "\n…(MCP output truncated)" : text;
  }

  async close(): Promise<void> {
    try {
      await this.client?.close();
    } catch {
      /* ignore */
    }
    try {
      await this.transport?.close();
    } catch {
      /* ignore */
    }
    this.client = null;
    this.transport = null;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out trying to ${what}`)), ms);
  });
  // clearTimeout in finally so a successful call never leaves a pending timer
  // keeping the Node event loop alive (one-shot mode) or accumulating timers.
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
