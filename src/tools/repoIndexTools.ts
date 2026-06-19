import { z } from "zod";
import type { Tool, ToolInvocation } from "./types.js";
import { parseArgs } from "./types.js";
import { buildRepoIndex } from "../index/scanner.js";
import { impactedBy, reverseGraph } from "../index/impact.js";
import { relevantTests } from "../index/testTargeting.js";
import { findReferences } from "../index/references.js";
import type { FileKind } from "../index/types.js";

// Model-callable, read-only repo-index tools (Phase 8C). Each builds the index
// fresh for the call (bounded by the scanner) so results reflect edits made this
// session. None executes anything — target_tests only *suggests* commands.

const FILE_KINDS = ["code", "test", "config", "docs", "generated", "other"] as const;
const norm = (p: string) => p.replace(/\\/g, "/");

const repoIndexSchema = z.object({
  pathPrefix: z.string().optional().describe("Restrict to files under this workspace-relative path prefix."),
  kind: z.enum(FILE_KINDS).optional().describe("Restrict to one file kind."),
  limit: z.number().int().positive().max(500).optional().describe("Max files to list (default 100)."),
});

export const repoIndexTool: Tool = {
  name: "repo_index",
  kind: "read-only",
  description:
    "List indexed workspace files with their kind (code/test/config/docs/generated/other) and language. " +
    "Optionally filter by path prefix and/or kind. Read-only; respects .gitignore/.deepcoderignore.",
  schema: repoIndexSchema,
  build(raw): ToolInvocation {
    const args = parseArgs("repo_index", repoIndexSchema, raw);
    const limit = args.limit ?? 100;
    const prefix = args.pathPrefix ? norm(args.pathPrefix) : undefined;
    return {
      kind: "read-only",
      describe: () => `Query repo index${prefix ? ` under ${prefix}` : ""}${args.kind ? ` (${args.kind})` : ""}`,
      async execute(ctx) {
        const idx = await buildRepoIndex(ctx.workspaceRoot);
        let files = idx.files;
        if (prefix) files = files.filter((f) => f.path === prefix || f.path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`) || f.path.startsWith(prefix));
        if (args.kind) files = files.filter((f) => f.kind === (args.kind as FileKind));
        const c = idx.counts;
        const header =
          `repo index: ${idx.files.length} files — code ${c.code} · test ${c.test} · config ${c.config} · docs ${c.docs} · generated ${c.generated} · other ${c.other}`;
        const shown = files.slice(0, limit);
        const body = shown.length
          ? shown.map((f) => `  ${f.path} [${f.kind}${f.lang ? `, ${f.lang}` : ""}]`).join("\n")
          : "  (no matching files)";
        const more = files.length > shown.length ? `\n  … ${files.length - shown.length} more` : "";
        return { output: `${header}\n${body}${more}` };
      },
    };
  },
};

const findReferencesSchema = z.object({
  symbol: z.string().describe("Identifier to locate (definitions + references)."),
  pathHint: z.string().optional().describe("Restrict the reference scan to files under this path prefix."),
});

export const findReferencesTool: Tool = {
  name: "find_references",
  kind: "read-only",
  description:
    "Find where an identifier is defined and referenced across indexed code/test files (lexical, bounded). " +
    "Good for orienting before an edit; not a type-aware resolver.",
  schema: findReferencesSchema,
  build(raw): ToolInvocation {
    const args = parseArgs("find_references", findReferencesSchema, raw);
    return {
      kind: "read-only",
      describe: () => `Find references to "${args.symbol}"`,
      async execute(ctx) {
        const idx = await buildRepoIndex(ctx.workspaceRoot, { symbols: true });
        const res = await findReferences(ctx.workspaceRoot, idx, args.symbol, { pathHint: args.pathHint });
        const defs = res.definitions.length
          ? res.definitions.map((d) => `  ${d.kind} ${d.file}:${d.line}`).join("\n")
          : "  (no definition found in the index)";
        const refs = res.references.length
          ? res.references.map((r) => `  ${r.file}:${r.line}: ${r.text}`).join("\n")
          : "  (no references found)";
        return {
          output:
            `"${res.symbol}" — ${res.definitions.length} definition(s), ${res.references.length} reference(s)` +
            `${res.truncated ? " (truncated)" : ""}\n` +
            `definitions:\n${defs}\nreferences:\n${refs}`,
        };
      },
    };
  },
};

const impactGraphSchema = z.object({
  path: z.string().describe("Workspace-relative file to analyze the blast radius of."),
});

export const impactGraphTool: Tool = {
  name: "impact_graph",
  kind: "read-only",
  description:
    "For a changed file, show the files that import it directly, all files transitively impacted (reverse-import " +
    "graph), and the tests likely relevant. Read-only; never runs anything.",
  schema: impactGraphSchema,
  build(raw): ToolInvocation {
    const args = parseArgs("impact_graph", impactGraphSchema, raw);
    const target = norm(args.path);
    return {
      kind: "read-only",
      describe: () => `Impact graph for ${target}`,
      async execute(ctx) {
        const idx = await buildRepoIndex(ctx.workspaceRoot, { imports: true });
        const direct = [...(reverseGraph(idx.imports).get(target) ?? [])].sort();
        const transitive = impactedBy(idx, target);
        const tests = relevantTests(idx, target);
        const fmt = (label: string, items: string[]) =>
          `${label} (${items.length}):` + (items.length ? "\n" + items.slice(0, 200).map((f) => `  ${f}`).join("\n") : " none");
        return {
          output:
            `impact of ${target}:\n` +
            `${fmt("direct importers", direct)}\n` +
            `${fmt("transitively impacted", transitive)}\n` +
            `${fmt("likely-relevant tests", tests)}`,
        };
      },
    };
  },
};

const targetTestsSchema = z.object({
  changedPaths: z.array(z.string()).min(1).describe("Workspace-relative files that changed."),
});

export const targetTestsTool: Tool = {
  name: "target_tests",
  kind: "read-only",
  description:
    "Suggest the tests likely relevant to a set of changed files (union of reverse-import impact + naming " +
    "convention). Suggestion only — it never runs tests.",
  schema: targetTestsSchema,
  build(raw): ToolInvocation {
    const args = parseArgs("target_tests", targetTestsSchema, raw);
    const changed = args.changedPaths.map(norm);
    return {
      kind: "read-only",
      describe: () => `Suggest tests for ${changed.join(", ")}`,
      async execute(ctx) {
        const idx = await buildRepoIndex(ctx.workspaceRoot, { imports: true });
        const out = new Set<string>();
        for (const p of changed) for (const t of relevantTests(idx, p)) out.add(t);
        const tests = [...out].sort();
        return {
          output: tests.length
            ? `suggested tests (${tests.length}; not run):\n${tests.map((t) => `  ${t}`).join("\n")}`
            : "no tests obviously relevant to the changed files.",
        };
      },
    };
  },
};
