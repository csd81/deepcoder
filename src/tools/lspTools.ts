import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { Tool, ToolInvocation, ToolContext } from "./types.js";
import { parseArgs } from "./types.js";
import { resolveReadPathInWorkspace } from "../workspace/paths.js";
import type { LspRuntime, LspDiagnostic, LspLocation } from "../lsp/types.js";

/**
 * Subtask 4 — three read-only, model-callable LSP tools over an injected
 * {@link LspRuntime}. Each resolves the file inside the workspace, asks the
 * runtime for a client, and degrades gracefully (isError, never throws into the
 * agent loop) when no server is available.
 */

const fileSchema = z.object({
  file: z.string().describe("File to query, relative to the workspace root."),
});

const posSchema = z.object({
  file: z.string().describe("File to query, relative to the workspace root."),
  line: z.number().int().describe("0-based line number."),
  character: z.number().int().describe("0-based character offset within the line."),
});

const SEVERITY: Record<number, string> = { 1: "error", 2: "warning", 3: "info", 4: "hint" };

function unavailable(): { output: string; isError: true } {
  return {
    output: "LSP unavailable for this file (no server configured/running).",
    isError: true,
  };
}

function formatLocation(loc: LspLocation): string {
  const { line, character } = loc.range.start;
  return `${loc.uri}:${line}:${character}`;
}

function formatDiagnostic(d: LspDiagnostic): string {
  const sev = SEVERITY[d.severity] ?? `severity${d.severity}`;
  const { line, character } = d.range.start;
  return `${sev}: ${d.message} [${line}:${character}]`;
}

export function createLspTools(runtime: LspRuntime): Tool[] {
  const diagnostics: Tool = {
    name: "lsp_diagnostics",
    kind: "read-only",
    description:
      "Report language-server diagnostics (errors/warnings) for a file. Read-only. " +
      "Returns nothing if no LSP server is configured for the file's language.",
    schema: fileSchema,
    build(raw): ToolInvocation {
      const args = parseArgs("lsp_diagnostics", fileSchema, raw);
      return {
        kind: "read-only",
        describe: () => `LSP diagnostics for ${args.file}`,
        async execute(ctx: ToolContext) {
          try {
            const abs = resolveReadPathInWorkspace(ctx.workspaceRoot, args.file);
            const client = await runtime.forFile(abs);
            if (!client) return unavailable();
            const uri = pathToFileURL(abs).href;
            const diags = client.diagnostics(uri);
            if (diags.length === 0) {
              return { output: `No diagnostics for ${args.file}.` };
            }
            return { output: diags.map(formatDiagnostic).join("\n") };
          } catch (err) {
            return { output: (err as Error).message, isError: true };
          }
        },
      };
    },
  };

  const definition: Tool = {
    name: "lsp_definition",
    kind: "read-only",
    description:
      "Go to the definition of the symbol at a position (0-based line/character). Read-only. " +
      "Returns 'no definition' when the server has no result.",
    schema: posSchema,
    build(raw): ToolInvocation {
      const args = parseArgs("lsp_definition", posSchema, raw);
      return {
        kind: "read-only",
        describe: () => `LSP definition at ${args.file}:${args.line}:${args.character}`,
        async execute(ctx: ToolContext) {
          try {
            const abs = resolveReadPathInWorkspace(ctx.workspaceRoot, args.file);
            const client = await runtime.forFile(abs);
            if (!client) return unavailable();
            const uri = pathToFileURL(abs).href;
            const loc = await client.definition(uri, { line: args.line, character: args.character });
            if (!loc) return { output: "no definition found" };
            return { output: formatLocation(loc) };
          } catch (err) {
            return { output: (err as Error).message, isError: true };
          }
        },
      };
    },
  };

  const references: Tool = {
    name: "lsp_references",
    kind: "read-only",
    description:
      "Find all references to the symbol at a position (0-based line/character). Read-only.",
    schema: posSchema,
    build(raw): ToolInvocation {
      const args = parseArgs("lsp_references", posSchema, raw);
      return {
        kind: "read-only",
        describe: () => `LSP references at ${args.file}:${args.line}:${args.character}`,
        async execute(ctx: ToolContext) {
          try {
            const abs = resolveReadPathInWorkspace(ctx.workspaceRoot, args.file);
            const client = await runtime.forFile(abs);
            if (!client) return unavailable();
            const uri = pathToFileURL(abs).href;
            const locs = await client.references(uri, { line: args.line, character: args.character });
            if (locs.length === 0) return { output: "no references found" };
            return { output: locs.map(formatLocation).join("\n") };
          } catch (err) {
            return { output: (err as Error).message, isError: true };
          }
        },
      };
    },
  };

  return [diagnostics, definition, references];
}
