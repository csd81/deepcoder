import { zodToJsonSchema } from "zod-to-json-schema";
import type { Tool } from "./types.js";
import type { ToolSchema } from "../providers/types.js";
import { readFileTool } from "./readFile.js";
import { listDirTool } from "./listDir.js";
import { grepTool } from "./grep.js";
import { globTool } from "./glob.js";
import { editFileTool } from "./editFile.js";
import { writeFileTool } from "./writeFile.js";
import { runBashTool } from "./runBash.js";
import { todoWriteTool } from "./todoWrite.js";
import { repoMapTool, findSymbolsTool, listRecentContextTool } from "./contextTools.js";

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /** Remove every tool whose name starts with `prefix` (used to refresh MCP tools). */
  unregisterByPrefix(prefix: string): void {
    for (const name of this.tools.keys()) {
      if (name.startsWith(prefix)) this.tools.delete(name);
    }
  }

  /** JSON-Schema tool definitions, as sent to the model each turn. */
  schemas(): ToolSchema[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      // Raw-schema tools (MCP) supply their own JSON Schema; native tools convert
      // from zod. Default target is draft-07, which the DeepSeek/OpenAI tools API
      // expects (e.g. numeric `exclusiveMinimum`, not the OpenAPI boolean).
      parameters: t.rawSchema ?? (zodToJsonSchema(t.schema!, { $refStrategy: "none" }) as Record<string, unknown>),
    }));
  }
}

/** All built-in native tools, keyed by name (excludes MCP tools by definition). */
const NATIVE_TOOLS: Tool[] = [
  readFileTool,
  listDirTool,
  grepTool,
  globTool,
  editFileTool,
  writeFileTool,
  runBashTool,
  todoWriteTool,
  repoMapTool,
  findSymbolsTool,
  listRecentContextTool,
];

/** The full native tool set. */
export function defaultRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  for (const t of NATIVE_TOOLS) r.register(t);
  return r;
}

/**
 * A registry containing only the named native tools. Used to give a subagent a
 * minimal blast radius — MCP tools are never included, and unknown names are
 * ignored. (Defence in depth: the subagent also runs in `readonly` mode.)
 */
export function restrictedRegistry(toolNames: string[]): ToolRegistry {
  const allowed = new Set(toolNames);
  const r = new ToolRegistry();
  for (const t of NATIVE_TOOLS) if (allowed.has(t.name)) r.register(t);
  return r;
}
