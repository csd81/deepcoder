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

  /** JSON-Schema tool definitions, as sent to the model each turn. */
  schemas(): ToolSchema[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      // Default target is JSON-Schema draft-07, which the DeepSeek/OpenAI tools
      // API expects (e.g. numeric `exclusiveMinimum`, not the OpenAPI boolean).
      parameters: zodToJsonSchema(t.schema, { $refStrategy: "none" }) as Record<string, unknown>,
    }));
  }
}

/** The MVP tool set (build order steps 4–6). */
export function defaultRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  for (const t of [
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
  ]) {
    r.register(t);
  }
  return r;
}
