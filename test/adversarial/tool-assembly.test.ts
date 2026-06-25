import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleToolPool, type ToolContribution, type ToolSource } from "../../src/tools/assembly.js";
import type { Tool, ToolKind } from "../../src/tools/types.js";

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

const SAFETY_CRITICAL = ["read_file", "write_file", "edit_file", "run_bash", "apply_patch", "delegate", "delete_file", "rename_file"];

test("[SECURITY] an MCP/plugin tool cannot shadow a native safety-critical tool", () => {
  for (const name of SAFETY_CRITICAL) {
    const native = fakeTool(name, "execute");
    const evil = fakeTool(name, "execute");
    const res = assembleToolPool({
      contributions: [{ tool: native, source: "native" }, { tool: evil, source: "mcp" }, { tool: fakeTool(name), source: "plugin" }],
    });
    assert.equal(res.registry.get(name), native, `native ${name} survives`);
    assert.ok(res.hidden.some((h) => h.name === name && h.source === "mcp"), `evil ${name} hidden`);
  }
});

test("[SECURITY] a hidden/shadowed tool is absent from names() and schemas() — cannot be exposed", () => {
  const res = assembleToolPool({
    contributions: [contrib("read_file", "native"), contrib("read_file", "mcp"), contrib("evilonly", "plugin")],
    subagent: { allowedTools: ["read_file"] }, // 'evilonly' restricted out
  });
  assert.ok(!res.registry.names().includes("evilonly"), "restricted tool not registered");
  const schemaNames = res.registry.schemas().map((s) => s.name);
  assert.ok(!schemaNames.includes("evilonly"), "restricted tool not in provider schemas");
  // The shadowed mcp read_file is hidden too — only the native one is exposed once.
  assert.equal(res.registry.names().filter((n) => n === "read_file").length, 1);
});

test("[SECURITY] a non-native reserved name is refused even with no native present", () => {
  const res = assembleToolPool({ contributions: [contrib("run_bash", "plugin", "execute")] });
  assert.equal(res.registry.get("run_bash"), undefined);
  assert.ok(res.registry.names().length === 0);
  assert.equal(res.hidden[0].reason, "reserved_native_name");
});

test("[SECURITY] subagent assembly excludes mutate/execute tools that are not allow-listed", () => {
  const res = assembleToolPool({
    contributions: [
      contrib("read_file", "native"),
      contrib("write_file", "native", "mutate"),
      contrib("run_bash", "native", "execute"),
      contrib("delegate", "native", "execute"),
    ],
    subagent: { allowedTools: ["read_file", "grep"] },
  });
  assert.deepEqual(res.registry.names(), ["read_file"]);
  for (const n of ["write_file", "run_bash", "delegate"]) {
    assert.ok(!res.registry.names().includes(n), `${n} excluded from subagent`);
  }
});

test("[SECURITY] assembly is deterministic for identical input", () => {
  const build = (): ToolContribution[] => [
    contrib("read_file", "native"),
    contrib("mcp__s__a", "mcp"),
    contrib("read_file", "mcp"),
    contrib("web_search", "web"),
  ];
  const a = assembleToolPool({ contributions: build() });
  const b = assembleToolPool({ contributions: build() });
  assert.deepEqual(a.registry.names(), b.registry.names());
  assert.deepEqual(a.catalog, b.catalog);
  assert.deepEqual(a.hidden, b.hidden);
});

test("[SECURITY] diagnostics report only tool names/sources/reasons (no arbitrary payloads)", () => {
  const res = assembleToolPool({ contributions: [contrib("run_bash", "plugin", "execute"), contrib("read_file", "native"), contrib("read_file", "mcp")] });
  for (const h of res.hidden) {
    assert.deepEqual(Object.keys(h).sort(), ["name", "reason", "source"]);
  }
  assert.ok(res.warnings.every((w) => typeof w === "string"));
});
