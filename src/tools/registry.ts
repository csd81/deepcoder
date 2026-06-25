import { zodToJsonSchema } from "zod-to-json-schema";
import type { Tool, ToolExposure } from "./types.js";
import type { ToolSchema } from "../providers/types.js";
import { readFileTool } from "./readFile.js";
import { listDirTool } from "./listDir.js";
import { grepTool } from "./grep.js";
import { globTool } from "./glob.js";
import { editFileTool } from "./editFile.js";
import { writeFileTool } from "./writeFile.js";
import { runBashTool } from "./runBash.js";
import { deleteFileTool } from "./deleteFile.js";
import { renameFileTool } from "./renameFile.js";
import { todoWriteTool } from "./todoWrite.js";
import { repoMapTool, findSymbolsTool, listRecentContextTool } from "./contextTools.js";
import { repoIndexTool, findReferencesTool, impactGraphTool, targetTestsTool } from "./repoIndexTools.js";
import { activateSkillTool } from "./activateSkill.js";
import { applyPatchTool } from "./applyPatch.js";
import { delegateTool } from "./delegateTool.js";
import { enterWorktreeTool } from "./enterWorktree.js";
import { exitWorktreeTool } from "./exitWorktree.js";
import { readManagedOutputTool } from "./readManagedOutput.js";

export class ToolRegistry {
  tools: Record<string, Tool> = {};
  /**
   * Deferred tool schemas (set by assembleToolPool when enabled). Deferred tools
   * are registered (executable) but their schema is withheld from `schemas()`
   * until exposed via `tool_search`. Empty → no deferral (legacy behavior).
   */
  deferred = new Set<string>();
  /** Deferred tools whose schema has been loaded this session (tool_search). */
  exposed = new Set<string>();
  /** Compact catalog metadata for the deferred tools. */
  catalogEntries: ToolExposure[] = [];

  register(tool: Tool): void {
    this.tools[tool.name] = tool;
  }

  get(name: string): Tool | undefined {
    return this.tools[name];
  }

  names(): string[] {
    return Object.keys(this.tools);
  }

  /** Remove every tool whose name starts with `prefix` (used to refresh MCP tools). */
  unregisterByPrefix(prefix: string): void {
    for (const name of Object.keys(this.tools)) {
      if (name.startsWith(prefix)) delete this.tools[name];
    }
  }

  private schemaOf(t: Tool): ToolSchema {
    return {
      name: t.name,
      description: t.description,
      // Raw-schema tools (MCP) supply their own JSON Schema; native tools convert
      // from zod. Default target is draft-07, which the DeepSeek/OpenAI tools API
      // expects (e.g. numeric `exclusiveMinimum`, not the OpenAPI boolean).
      parameters: t.rawSchema ?? (zodToJsonSchema(t.schema!, { $refStrategy: "none" }) as Record<string, unknown>),
    };
  }

  /**
   * JSON-Schema tool definitions sent to the model each turn. When deferred
   * schemas are active, a deferred tool is omitted until it has been exposed.
   * With no deferred tools this returns every schema (legacy behavior).
   */
  schemas(): ToolSchema[] {
    return Object.values(this.tools)
      .filter((t) => this.deferred.size === 0 || !this.deferred.has(t.name) || this.exposed.has(t.name))
      .map((t) => this.schemaOf(t));
  }

  /** True if `name` is a deferred tool whose schema has not been loaded yet. */
  isDeferredUnexposed(name: string): boolean {
    return this.deferred.has(name) && !this.exposed.has(name);
  }

  /** Mark deferred tools exposed (no-op for non-deferred / unknown names). */
  expose(names: string[]): void {
    for (const n of names) if (this.deferred.has(n)) this.exposed.add(n);
  }

  /** Deferred tools not yet exposed — the live `tool_search` catalog. */
  catalog(): ToolExposure[] {
    return this.catalogEntries.filter((e) => !this.exposed.has(e.name));
  }

  /** Full provider schema for one tool name (used by `tool_search`). */
  schemaForName(name: string): ToolSchema | undefined {
    const t = this.tools[name];
    return t ? this.schemaOf(t) : undefined;
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
  deleteFileTool,
  renameFileTool,
  todoWriteTool,
  repoMapTool,
  findSymbolsTool,
  listRecentContextTool,
  repoIndexTool,
  findReferencesTool,
  impactGraphTool,
  targetTestsTool,
  // Phase 7C2: always registered; activation enforces enabled/trust/disabled.
  activateSkillTool,
  applyPatchTool,
  delegateTool,
  enterWorktreeTool,
  exitWorktreeTool,
  readManagedOutputTool,
];

/** The built-in native tool definitions, in canonical order (excludes MCP). */
export function nativeToolDefinitions(): Tool[] {
  return [...NATIVE_TOOLS];
}

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
