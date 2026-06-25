import type { Tool, ToolKind } from "./types.js";
import { ToolRegistry } from "./registry.js";
import { toolSearchTool, summarize } from "./toolSearch.js";

/**
 * Unified tool-pool assembly: the single chokepoint that turns contributions
 * from every source (native, optional built-ins, MCP, future plugins) into the
 * model-visible / runtime-executable registry, applying one deterministic
 * dedup + precedence policy, optional mode/subagent filtering, and producing
 * diagnostics (catalog / hidden / warnings) so tools never silently disappear.
 *
 * With a contribution list that has no name collisions (the case for every real
 * config today — native names are unique, MCP tools are `mcp__`-prefixed, the
 * optional built-ins have fixed distinct names) this is byte-identical to the
 * previous ad-hoc `register()` sequence. The earlier-wins precedence + reserved
 * native names close the door on a future plugin/MCP tool shadowing a
 * safety-critical native tool — defence in depth; `checkPermission()` remains
 * the runtime authority and a hidden tool is never exposed in `schemas()`.
 */
export type ToolSource = "native" | "semantic" | "web" | "pty" | "lsp" | "mcp" | "plugin";

export interface ToolContribution {
  tool: Tool;
  source: ToolSource;
}

export interface ToolCatalogEntry {
  name: string;
  source: ToolSource;
  kind: ToolKind;
}

export interface ToolHiddenRecord {
  name: string;
  source: ToolSource;
  reason: string;
}

export interface ToolAssemblyInput {
  /** Contributions in precedence order (native first → earlier wins). */
  contributions: ToolContribution[];
  /** Subagent restriction: only these tool names survive (any source). */
  subagent?: { allowedTools: string[] };
  /** Mode filtering: hide tools of these kinds (still policy-gated at runtime). */
  hideKinds?: ToolKind[];
  /**
   * Deferred tool schemas. When enabled, tools from `deferSources` are registered
   * (executable) but their schema is withheld until `tool_search` exposes them;
   * the always-on `tool_search` tool is added to the registry.
   */
  deferred?: { enabled: boolean; deferSources: ToolSource[] };
}

export interface ToolAssemblyResult {
  registry: ToolRegistry;
  catalog: ToolCatalogEntry[];
  hidden: ToolHiddenRecord[];
  warnings: string[];
}

/**
 * Native tools whose names a non-native contribution may NEVER take — shadowing
 * one would let an untrusted source redirect a safety-critical operation.
 */
const RESERVED_NATIVE_NAMES = new Set([
  "read_file",
  "write_file",
  "edit_file",
  "run_bash",
  "apply_patch",
  "delegate",
  "delete_file",
  "rename_file",
]);

export function assembleToolPool(input: ToolAssemblyInput): ToolAssemblyResult {
  const registry = new ToolRegistry();
  const catalog: ToolCatalogEntry[] = [];
  const hidden: ToolHiddenRecord[] = [];
  const warnings: string[] = [];
  /** name -> the source that won it (the first contribution registered). */
  const taken = new Map<string, ToolSource>();

  const allow = input.subagent ? new Set(input.subagent.allowedTools) : undefined;
  const hideKinds = input.hideKinds ? new Set(input.hideKinds) : undefined;

  for (const { tool, source } of input.contributions) {
    const name = tool.name;

    // Subagent restriction: only explicitly-allowed names survive (any source).
    if (allow && !allow.has(name)) {
      hidden.push({ name, source, reason: "subagent_restricted" });
      continue;
    }

    // Reserve native safety-critical names: a non-native tool can never take one,
    // regardless of contribution order.
    if (source !== "native" && RESERVED_NATIVE_NAMES.has(name)) {
      hidden.push({ name, source, reason: "reserved_native_name" });
      warnings.push(`tool "${name}" (${source}) refused — it would shadow a native safety-critical tool`);
      continue;
    }

    // Optional mode filtering by kind (default: nothing hidden).
    if (hideKinds && hideKinds.has(tool.kind)) {
      hidden.push({ name, source, reason: "hidden_by_mode" });
      continue;
    }

    // Deterministic dedup: the earlier contribution wins (native is first).
    const winner = taken.get(name);
    if (winner !== undefined) {
      hidden.push({ name, source, reason: `shadowed_by_${winner}` });
      warnings.push(`tool "${name}" (${source}) hidden — name already provided by ${winner}`);
      continue;
    }

    registry.register(tool);
    taken.set(name, source);
    catalog.push({ name, source, kind: tool.kind });
  }

  // Deferred schemas: add the always-on tool_search tool and mark the configured
  // sources deferred (registered + executable, but schema withheld until exposed).
  // tool_search itself and every native tool stay always-on.
  if (input.deferred?.enabled) {
    if (!registry.get(toolSearchTool.name)) {
      registry.register(toolSearchTool);
      taken.set(toolSearchTool.name, "native");
      catalog.push({ name: toolSearchTool.name, source: "native", kind: toolSearchTool.kind });
    }
    const deferSet = new Set(input.deferred.deferSources);
    for (const entry of catalog) {
      if (entry.source === "native" || !deferSet.has(entry.source)) continue;
      registry.deferred.add(entry.name);
      const tool = registry.get(entry.name);
      registry.catalogEntries.push({
        name: entry.name,
        source: entry.source,
        kind: entry.kind,
        summary: summarize(tool?.description ?? entry.name),
      });
    }
  }

  return { registry, catalog, hidden, warnings };
}
