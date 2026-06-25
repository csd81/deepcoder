import { z } from "zod";
import {
  InvalidArgumentsError,
  type Tool,
  type ToolInvocation,
  type ToolResult,
  type ToolExposure,
} from "./types.js";
import type { ToolSchema } from "../providers/types.js";

const MAX_SUMMARY = 140;
export const DEFAULT_CATALOG_MAX_CHARS = 4000;

/** Collapse + bound a tool description for the compact catalog. */
export function summarize(desc: string): string {
  const oneLine = desc.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_SUMMARY ? `${oneLine.slice(0, MAX_SUMMARY - 1)}…` : oneLine;
}

/**
 * Render the bounded `[deferred-tools]` catalog block (advisory; no raw schemas).
 * Returns "" when nothing is deferred. Truncates to `maxChars` and reports the
 * number of omitted tools rather than silently dropping them.
 */
export function renderDeferredCatalog(entries: ToolExposure[], maxChars = DEFAULT_CATALOG_MAX_CHARS): string {
  if (!entries.length) return "";
  const header =
    "[deferred-tools]\n" +
    "Additional tools are available on demand. Call tool_search (by `names` or `query`) " +
    "to load their schemas before using them.\n";
  const lines: string[] = [];
  let used = header.length;
  let shown = 0;
  for (const e of entries) {
    const line = `- ${e.name} (${e.source}, ${e.kind}): ${summarize(e.summary)}`;
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
    shown += 1;
  }
  const omitted = entries.length - shown;
  const footer = omitted > 0 ? `\n…and ${omitted} more (refine your tool_search query).` : "";
  return header + lines.join("\n") + footer;
}

const argsSchema = z.object({
  query: z.string().optional(),
  names: z.array(z.string()).optional(),
  limit: z.number().int().positive().max(50).optional(),
});

/**
 * Model-callable discovery tool. Always part of the always-on core when deferred
 * schemas are enabled. Loading a schema only makes the tool callable — the full
 * permission pipeline still gates execution.
 */
export const toolSearchTool: Tool = {
  name: "tool_search",
  description:
    "Discover and load schemas for additional on-demand tools. Pass `names` for exact tools, or `query` to " +
    "search by name/description (omit both to list the catalog). Returns their full JSON schemas and makes " +
    "them callable on the next turn.",
  kind: "read-only",
  schema: argsSchema,
  build(rawArgs: unknown): ToolInvocation {
    let args: z.infer<typeof argsSchema>;
    try {
      args = argsSchema.parse(rawArgs ?? {});
    } catch (err) {
      throw new InvalidArgumentsError("tool_search", (err as Error).message);
    }
    return {
      kind: "read-only",
      source: "native",
      describe: () => `tool_search ${args.names?.join(",") ?? args.query ?? "(catalog)"}`,
      async execute(ctx): Promise<ToolResult> {
        const rt = ctx.toolSearch;
        if (!rt) return { output: "tool_search is unavailable in this session." };
        const all = rt.catalog();
        let matched: ToolExposure[];
        if (args.names?.length) {
          const want = new Set(args.names);
          matched = all.filter((e) => want.has(e.name));
        } else if (args.query) {
          const q = args.query.toLowerCase();
          matched = all.filter((e) => e.name.toLowerCase().includes(q) || e.summary.toLowerCase().includes(q));
        } else {
          matched = all;
        }
        matched = matched.slice(0, args.limit ?? 25);
        if (!matched.length) {
          return {
            output: "No matching deferred tools. Call tool_search with a broader `query`, or no arguments to list the catalog.",
          };
        }
        rt.expose(matched.map((e) => e.name));
        const schemas = matched.map((e) => rt.schemaFor(e.name)).filter((s): s is ToolSchema => Boolean(s));
        return {
          output: `Loaded ${schemas.length} tool schema(s); they are now callable:\n${JSON.stringify(schemas, null, 2)}`,
        };
      },
    };
  },
};
