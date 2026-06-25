import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleToolPool, type ToolContribution, type ToolSource } from "../src/tools/assembly.js";
import { nativeToolDefinitions, defaultRegistry } from "../src/tools/registry.js";
import type { Tool, ToolKind } from "../src/tools/types.js";

function fakeTool(name: string, kind: ToolKind = "read-only"): Tool {
  return {
    name,
    description: `desc ${name}`,
    kind,
    rawSchema: { type: "object" },
    build: () => ({ describe: () => name, execute: async () => ({ output: "" }) }),
  } as unknown as Tool;
}
function contrib(name: string, source: ToolSource, kind: ToolKind = "read-only"): ToolContribution {
  return { tool: fakeTool(name, kind), source };
}

test("native contributions reproduce defaultRegistry exactly (parity)", () => {
  const contributions = nativeToolDefinitions().map((tool) => ({ tool, source: "native" as const }));
  const { registry, hidden, warnings } = assembleToolPool({ contributions });
  assert.deepEqual(registry.names(), defaultRegistry().names(), "same tools, same order");
  assert.equal(hidden.length, 0);
  assert.equal(warnings.length, 0);
});

test("catalog records source + kind; clean input has no hidden/warnings", () => {
  const res = assembleToolPool({
    contributions: [contrib("read_file", "native"), contrib("web_search", "web"), contrib("mcp__x__y", "mcp")],
  });
  assert.deepEqual(res.catalog.map((c) => [c.name, c.source]), [
    ["read_file", "native"],
    ["web_search", "web"],
    ["mcp__x__y", "mcp"],
  ]);
  assert.equal(res.hidden.length, 0);
  assert.equal(res.warnings.length, 0);
});

test("name collision: the earlier (native) contribution wins; later is hidden", () => {
  const native = fakeTool("foo");
  const plugin = fakeTool("foo");
  const res = assembleToolPool({
    contributions: [{ tool: native, source: "native" }, { tool: plugin, source: "plugin" }],
  });
  assert.equal(res.registry.get("foo"), native, "native instance registered");
  assert.deepEqual(res.hidden.map((h) => [h.name, h.source, h.reason]), [["foo", "plugin", "shadowed_by_native"]]);
  assert.equal(res.warnings.length, 1);
});

test("reserved native names cannot be taken by a non-native source", () => {
  // Even with no native run_bash present, a plugin/mcp 'run_bash' is refused.
  const res = assembleToolPool({ contributions: [contrib("run_bash", "mcp", "execute")] });
  assert.equal(res.registry.get("run_bash"), undefined, "not registered");
  assert.equal(res.hidden[0].reason, "reserved_native_name");
  assert.equal(res.warnings.length, 1);
});

test("subagent restriction keeps only allowed names", () => {
  const res = assembleToolPool({
    contributions: [contrib("read_file", "native"), contrib("run_bash", "native", "execute"), contrib("write_file", "native", "mutate")],
    subagent: { allowedTools: ["read_file"] },
  });
  assert.deepEqual(res.registry.names(), ["read_file"]);
  assert.ok(res.hidden.every((h) => h.reason === "subagent_restricted"));
  assert.equal(res.hidden.length, 2);
});

test("hideKinds filters tools by kind (still registerable by name elsewhere)", () => {
  const res = assembleToolPool({
    contributions: [contrib("read_file", "native"), contrib("run_bash", "native", "execute")],
    hideKinds: ["execute"],
  });
  assert.deepEqual(res.registry.names(), ["read_file"]);
  assert.equal(res.hidden[0].reason, "hidden_by_mode");
});

test("catalog order follows contribution order (minus hidden)", () => {
  const res = assembleToolPool({
    contributions: [contrib("a", "native"), contrib("b", "semantic"), contrib("a", "plugin"), contrib("c", "mcp")],
  });
  assert.deepEqual(res.catalog.map((c) => c.name), ["a", "b", "c"]);
});
