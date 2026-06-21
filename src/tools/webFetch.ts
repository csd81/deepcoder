/**
 * Phase 10E — web_fetch tool wrapper.
 *
 * Wraps fetchUrl from src/web/fetcher.ts as a Tool consumable by the agent loop.
 * Does NOT register itself in registry.ts (registration is deferred).
 */

import { z } from "zod";
import type { Tool, ToolInvocation, ToolResult, ToolContext } from "./types.js";
import { parseArgs } from "./types.js";
import { fetchUrl } from "../web/fetcher.js";
import type { WebDomainPolicy } from "../web/types.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const schema = z.object({
  url: z.string().url().describe("The URL to fetch (http/https only)."),
  maxChars: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum characters to return (default 12_000)."),
});

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface CreateWebFetchOptions {
  web: WebDomainPolicy;
  fetchImpl?: typeof fetch;
}

export function createWebFetchTool(options: CreateWebFetchOptions): Tool {
  const { web, fetchImpl } = options;

  const tool: Tool = {
    name: "web_fetch",
    kind: "read-only",
    description: "Fetch a URL and return its text content (redacted).",
    schema,

    build(rawArgs: unknown): ToolInvocation {
      const args = parseArgs("web_fetch", schema, rawArgs);

      return {
        kind: "read-only",
        describe: () => `Fetch ${args.url}`,

        async execute(ctx: ToolContext): Promise<ToolResult> {
          // Respect the session's abort signal
          if (ctx.signal.aborted) {
            return { output: "Operation aborted.", isError: true };
          }

          const result = await fetchUrl(
            args.url,
            { maxChars: args.maxChars },
            { policy: web, fetchImpl },
          );

          if (!result.ok) {
            const reason = result.reason ?? "unknown error";
            return {
              output: `Failed to fetch ${args.url}: ${reason}`,
              isError: true,
            };
          }

          const parts: string[] = [];

          if (result.title) {
            parts.push(`Title: ${result.title}`);
          }

          parts.push(result.text ?? "");

          if (result.truncated) {
            parts.push(
              `\n[Truncated: showing ${result.charsReturned} characters]`,
            );
          }

          return { output: parts.join("\n\n") };
        },
      };
    },
  };

  return tool;
}
