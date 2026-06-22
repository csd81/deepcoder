/**
 * Slice B — adversarial tests for the dynamic "## Available tools" section of
 * buildSystemPrompt. The list must be data-driven from the registered tool
 * names, bucketed by fixed category, with empty categories omitted and unknown
 * tools surfaced under "Other:".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt } from "../../src/agent/systemPrompt.js";

const base = { workspaceRoot: "/ws", mode: "auto" as const };

test("renders Available tools section, buckets present tools, omits empty categories", () => {
  const text = buildSystemPrompt({ ...base, toolNames: ["read_file", "grep", "web_search"] });
  assert.match(text, /## Available tools/);
  // Scope assertions to the Available tools section (the static prose above it
  // legitimately mentions edit_file / "edits" / categories in passing).
  const section = text.slice(text.indexOf("## Available tools"));
  // Explore lists read_file & grep; Web lists web_search.
  assert.match(section, /\*\*Explore:\*\*[^\n]*read_file/);
  assert.match(section, /\*\*Explore:\*\*[^\n]*grep/);
  assert.match(section, /\*\*Web:\*\*[^\n]*web_search/);
  // Empty categories are omitted entirely.
  assert.doesNotMatch(section, /Edit:/);
  assert.doesNotMatch(section, /Code intelligence:/);
  assert.doesNotMatch(section, /Semantic search:/);
  // Tools that weren't registered are not listed.
  assert.doesNotMatch(section, /edit_file/);
  assert.doesNotMatch(section, /lsp_references/);
});

test("unknown tools fall under an Other category", () => {
  const text = buildSystemPrompt({ ...base, toolNames: ["read_file", "mcp__foo__bar"] });
  assert.match(text, /\*\*Other:\*\*[^\n]*mcp__foo__bar/);
});

test("no toolNames omits the Available tools section", () => {
  const text = buildSystemPrompt({ ...base });
  assert.doesNotMatch(text, /## Available tools/);
  const empty = buildSystemPrompt({ ...base, toolNames: [] });
  assert.doesNotMatch(empty, /## Available tools/);
});

test("categories render in declared order: Explore before Edit before Web", () => {
  const text = buildSystemPrompt({
    ...base,
    toolNames: ["web_search", "edit_file", "read_file"],
  });
  const section = text.slice(text.indexOf("## Available tools"));
  const iExplore = section.indexOf("Explore:");
  const iEdit = section.indexOf("Edit:");
  const iWeb = section.indexOf("Web:");
  assert.ok(iExplore !== -1 && iEdit !== -1 && iWeb !== -1, "all three categories present");
  assert.ok(iExplore < iEdit, "Explore before Edit");
  assert.ok(iEdit < iWeb, "Edit before Web");
});
