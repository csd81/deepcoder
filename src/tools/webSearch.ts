/**
 * Phase 10E — web_search tool wrapper.
 *
 * Wraps runWebSearch from src/web/searchProvider.ts as a Tool consumable by the agent loop.
 * Does NOT register itself in registry.ts (registration is deferred).
 */

import { z } from "zod";
import type { Tool, ToolInvocation, ToolResult, ToolContext } from "./types.js";
import { parseArgs } from "./types.js";
import { runWebSearch } from "../web/searchProvider.js";
import type { WebSearchProvider } from "../web/searchProvider.js";
import { boundText } from "./outputBound.js";

// Hard cap on the rendered result block so a provider returning many long
// snippets can't flood the model context. Each result is title/url/snippet
// joined by blank lines; this bounds the joined text by line count.
const MAX_RESULT_LINES = 200;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const schema = z.object({
  query: z.string().min(1).describe("The search query."),
  maxResults: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum number of results to return."),
  domains: z
    .array(z.string())
    .optional()
    .describe("Optional list of domains to restrict the search to."),
});

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface CreateWebSearchOptions {
  provider: WebSearchProvider;
}

export function createWebSearchTool(options: CreateWebSearchOptions): Tool {
  const { provider } = options;

  const tool: Tool = {
    name: "web_search",
    kind: "read-only",
    description: "Search the web for information.",
    schema,

    build(rawArgs: unknown): ToolInvocation {
      const args = parseArgs("web_search", schema, rawArgs);

      return {
        kind: "read-only",
        describe: () => `Search: ${args.query}`,

        async execute(ctx: ToolContext): Promise<ToolResult> {
          // Respect the session's abort signal
          if (ctx.signal.aborted) {
            return { output: "Operation aborted.", isError: true };
          }

          const out = await runWebSearch(
            args.query,
            { maxResults: args.maxResults, domains: args.domains },
            provider,
          );

          if (!out.ok) {
            const reason = out.reason ?? "unknown";
            return {
              output: `Search failed: ${reason}`,
              isError: true,
            };
          }

          if (out.results.length === 0) {
            return { output: "No results." };
          }

          const parts = out.results.map(
            (r) => `[${r.id}] ${r.title}\n${r.url}\n${r.snippet}`
          );

          return { output: boundText(parts.join("\n\n"), MAX_RESULT_LINES) };
        },
      };
    },
  };

  return tool;
}
