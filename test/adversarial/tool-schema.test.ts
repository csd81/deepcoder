import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultRegistry } from "../../src/tools/registry.js";

const schemas = defaultRegistry().schemas();

test("every registered tool has a name, description, and object parameters", () => {
  assert.ok(schemas.length > 0);
  for (const s of schemas) {
    assert.ok(s.name, "tool has a name");
    assert.ok(s.description && s.description.length > 0, `${s.name} has a description`);
    assert.equal((s.parameters as { type?: string }).type, "object", `${s.name} parameters are an object`);
  }
});

test("schemas are JSON-serializable and round-trip", () => {
  for (const s of schemas) {
    const round = JSON.parse(JSON.stringify(s));
    assert.deepEqual(round, s, `${s.name} schema survives JSON round-trip`);
  }
});

test("no provider-rejected schema shapes (draft-07 regression guard)", () => {
  // DeepSeek/OpenAI rejected boolean exclusiveMinimum/Maximum (the openApi3 bug).
  const walk = (node: unknown, tool: string): void => {
    if (Array.isArray(node)) return node.forEach((n) => walk(n, tool));
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        if ((k === "exclusiveMinimum" || k === "exclusiveMaximum")) {
          assert.equal(typeof v, "number", `${tool}.${k} must be numeric (draft-07), not boolean`);
        }
        walk(v, tool);
      }
    }
  };
  for (const s of schemas) walk(s.parameters, s.name);
});

test("the expected MVP + context tools are all registered", () => {
  const names = new Set(schemas.map((s) => s.name));
  for (const expected of [
    "read_file", "list_dir", "grep", "glob", "edit_file", "write_file", "run_bash",
    "todo_write", "repo_map", "find_symbols", "list_recent_context",
  ]) {
    assert.ok(names.has(expected), `${expected} is registered`);
  }
});
