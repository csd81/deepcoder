import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleToolPool } from "../src/tools/assembly.js";
import { nativeToolDefinitions } from "../src/tools/registry.js";
import { toolSearchTool, renderDeferredCatalog, summarize } from "../src/tools/toolSearch.js";
import type { Tool, ToolKind, ToolContext, ToolSearchRuntime, ToolExposure } from "../src/tools/types.js";

function fakeTool(name: string, kind: ToolKind = "read-only", description = `description of ${name}`): Tool {
  return {
    name,
    description,
    kind,
    rawSchema: { type: "object", properties: { q: { type: "string" } } },
    build: () => ({ kind, describe: () => name, execute: async () => ({ output: `ran ${name}` }) }),
  } as unknown as Tool;
}
function nativeContribs() {
  return nativeToolDefinitions().map((tool) => ({ tool, source: "native" as const }));
}
function runtime(registry: { catalog(): ToolExposure[]; expose(n: string[]): void; schemaForName(n: string): unknown }): ToolSearchRuntime {
  return {
    catalog: () => registry.catalog(),
    expose: (names) => registry.expose(names),
    schemaFor: (name) => registry.schemaForName(name) as never,
  };
}
function ctxWith(rt: ToolSearchRuntime): ToolContext {
  return { workspaceRoot: "/tmp", signal: new AbortController().signal, readTracker: new Set(), todos: [], toolSearch: rt };
}

test("deferred OFF: schemas() includes every tool and there is no tool_search", () => {
  const { registry } = assembleToolPool({
    contributions: [...nativeContribs(), { tool: fakeTool("mcp__s__a"), source: "mcp" }],
  });
  const names = registry.schemas().map((s) => s.name);
  assert.ok(names.includes("mcp__s__a"), "mcp schema present when deferral off");
  assert.ok(!names.includes("tool_search"), "no tool_search when deferral off");
  assert.equal(registry.deferred.size, 0);
});

test("deferred ON: deferred-source tools are withheld from schemas but tool_search + native stay", () => {
  const { registry } = assembleToolPool({
    contributions: [...nativeContribs(), { tool: fakeTool("mcp__s__a"), source: "mcp" }, { tool: fakeTool("lsp_def"), source: "lsp" }],
    deferred: { enabled: true, deferSources: ["mcp", "lsp"] },
  });
  const schemaNames = registry.schemas().map((s) => s.name);
  assert.ok(schemaNames.includes("tool_search"), "tool_search always exposed");
  assert.ok(schemaNames.includes("read_file"), "native always exposed");
  assert.ok(!schemaNames.includes("mcp__s__a"), "mcp deferred (hidden)");
  assert.ok(!schemaNames.includes("lsp_def"), "lsp deferred (hidden)");
  // But they are still registered (executable) and catalogued.
  assert.ok(registry.get("mcp__s__a"), "deferred tool still registered");
  assert.deepEqual(registry.catalog().map((e) => e.name).sort(), ["lsp_def", "mcp__s__a"]);
});

test("expose() reveals a deferred tool's schema and removes it from the catalog", () => {
  const { registry } = assembleToolPool({
    contributions: [...nativeContribs(), { tool: fakeTool("mcp__s__a"), source: "mcp" }],
    deferred: { enabled: true, deferSources: ["mcp"] },
  });
  assert.ok(!registry.schemas().map((s) => s.name).includes("mcp__s__a"));
  registry.expose(["mcp__s__a"]);
  assert.ok(registry.schemas().map((s) => s.name).includes("mcp__s__a"), "exposed → schema sent");
  assert.equal(registry.catalog().length, 0, "exposed tool drops out of the catalog");
  assert.equal(registry.isDeferredUnexposed("mcp__s__a"), false);
});

test("tool_search by exact names exposes the tools and returns their schemas", async () => {
  const { registry } = assembleToolPool({
    contributions: [...nativeContribs(), { tool: fakeTool("mcp__s__a"), source: "mcp" }, { tool: fakeTool("mcp__s__b"), source: "mcp" }],
    deferred: { enabled: true, deferSources: ["mcp"] },
  });
  const res = await toolSearchTool.build({ names: ["mcp__s__a"] }).execute(ctxWith(runtime(registry)));
  assert.match(res.output, /mcp__s__a/);
  assert.ok(registry.schemas().map((s) => s.name).includes("mcp__s__a"), "now callable");
  assert.ok(!registry.schemas().map((s) => s.name).includes("mcp__s__b"), "unrequested stays deferred");
});

test("tool_search by query matches name/description; no args lists the catalog", async () => {
  const { registry } = assembleToolPool({
    contributions: [...nativeContribs(), { tool: fakeTool("lsp_definition", "read-only", "Find symbol definition"), source: "lsp" }, { tool: fakeTool("web_search", "read-only", "Search the web"), source: "web" }],
    deferred: { enabled: true, deferSources: ["lsp", "web"] },
  });
  const rt = runtime(registry);
  const byQuery = await toolSearchTool.build({ query: "symbol" }).execute(ctxWith(rt));
  assert.match(byQuery.output, /lsp_definition/);
  assert.ok(!byQuery.output.includes("web_search"));
});

test("renderDeferredCatalog is bounded and reports omitted count", () => {
  const entries: ToolExposure[] = Array.from({ length: 50 }, (_, i) => ({
    name: `mcp__s__t${i}`,
    source: "mcp",
    kind: "read-only" as const,
    summary: "x".repeat(60),
  }));
  const out = renderDeferredCatalog(entries, 600);
  assert.ok(Buffer.byteLength(out) <= 600 + 40, `bounded (${Buffer.byteLength(out)} bytes)`);
  assert.match(out, /\[deferred-tools\]/);
  assert.match(out, /and \d+ more/);
});

test("summarize collapses whitespace and truncates long descriptions", () => {
  assert.equal(summarize("a\n\n  b   c"), "a b c");
  assert.equal(summarize("x".repeat(200)).length, 140);
});

test("empty catalog renders to an empty string (no block when nothing deferred)", () => {
  assert.equal(renderDeferredCatalog([]), "");
});
