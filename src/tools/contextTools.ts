import { z } from "zod";
import type { Tool, ToolInvocation } from "./types.js";
import { parseArgs } from "./types.js";
import { displayPath } from "../workspace/paths.js";
import { buildRepoMap, findSymbols } from "../context/repoMap.js";
import { renderTodos } from "./todoWrite.js";

const SUMMARY_TAG = "[compacted-summary]";

const repoMapSchema = z.object({
  paths: z.array(z.string()).optional().describe("Restrict the map to these workspace-relative paths/prefixes."),
});

export const repoMapTool: Tool = {
  name: "repo_map",
  kind: "read-only",
  description:
    "Return a compact, token-bounded map of the repo's TypeScript/JavaScript files and their top-level symbols " +
    "(functions, classes, interfaces, types). Use it to orient on an unfamiliar codebase before reading files. " +
    "A symbol overview — for a file inventory by kind use repo_index.",
  schema: repoMapSchema,
  build(raw): ToolInvocation {
    const args = parseArgs("repo_map", repoMapSchema, raw);
    return {
      kind: "read-only",
      describe: () => `Build repo map${args.paths?.length ? ` for ${args.paths.join(", ")}` : ""}`,
      async execute(ctx) {
        return { output: await buildRepoMap(ctx.workspaceRoot, { paths: args.paths }) };
      },
    };
  },
};

const findSymbolsSchema = z.object({
  query: z.string().describe("Substring to match against symbol names (case-insensitive)."),
});

export const findSymbolsTool: Tool = {
  name: "find_symbols",
  kind: "read-only",
  description: "Search the repo's indexed top-level symbols by name and return matching file:symbol locations.",
  schema: findSymbolsSchema,
  build(raw): ToolInvocation {
    const args = parseArgs("find_symbols", findSymbolsSchema, raw);
    return {
      kind: "read-only",
      describe: () => `Find symbols matching "${args.query}"`,
      async execute(ctx) {
        return { output: await findSymbols(ctx.workspaceRoot, args.query) };
      },
    };
  },
};

const emptySchema = z.object({});

export const listRecentContextTool: Tool = {
  name: "list_recent_context",
  kind: "read-only",
  description:
    "Show what the session already knows: compaction summaries of earlier turns, recently read/edited files, and current todos.",
  schema: emptySchema,
  build(raw): ToolInvocation {
    parseArgs("list_recent_context", emptySchema, raw);
    return {
      kind: "read-only",
      describe: () => "List recent session context",
      async execute(ctx) {
        const parts: string[] = [];

        const summaries = (ctx.history ?? []).filter((m) => m.role === "user" && m.content.startsWith(SUMMARY_TAG));
        if (summaries.length) parts.push("## Summaries of earlier work\n" + summaries.map((s) => s.content).join("\n\n"));

        const files = [...ctx.readTracker].map((p) => displayPath(ctx.workspaceRoot, p)).sort();
        parts.push("## Files touched this session\n" + (files.length ? files.join("\n") : "(none)"));

        parts.push("## Todos\n" + renderTodos(ctx.todos));
        return { output: parts.join("\n\n") };
      },
    };
  },
};
