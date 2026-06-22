import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultRegistry } from "../../src/tools/registry.js";
import type { ToolSchema } from "../../src/providers/types.js";

const schemas: ToolSchema[] = defaultRegistry().schemas();
const desc = (name: string): string => schemas.find((s) => s.name === name)!.description;

// ---------------------------------------------------------------------------
// NEW opencode-style cross-references (these MUST fail on the current tree)
// ---------------------------------------------------------------------------

test("read_file description cross-references grep for content search", () => {
  const d = desc("read_file");
  assert.ok(d.includes("grep"), "read_file should mention grep as alternative for content search");
});

test("read_file description cross-references glob for path discovery", () => {
  const d = desc("read_file");
  assert.ok(d.includes("glob"), "read_file should mention glob as alternative for path discovery");
});

test("grep description cross-references glob for file-name search", () => {
  const d = desc("grep");
  assert.ok(d.includes("glob"), "grep should mention glob as alternative for finding files by name");
});

test("edit_file description mentions FAILURE when old_string not found", () => {
  const d = desc("edit_file");
  assert.ok(
    d.toUpperCase().includes("FAIL") || d.includes("not found"),
    "edit_file should describe the failure mode when old_string is not found",
  );
});

test("run_bash description warns against file operations in bash", () => {
  const d = desc("run_bash");
  assert.ok(
    d.includes("read_file") || d.includes("write") || d.includes("edit") || d.includes("dedicated tools"),
    "run_bash should mention that file operations should use dedicated tools instead of bash",
  );
});

test("run_bash description mentions permission policy", () => {
  const d = desc("run_bash");
  assert.ok(
    d.includes("permission") || d.includes("blocked") || d.includes("require approval"),
    "run_bash should mention the permission policy",
  );
});

// ---------------------------------------------------------------------------
// EXISTING cross-references that MUST be preserved (these pass on current tree)
// ---------------------------------------------------------------------------

test("find_references description cross-references lsp_references (preserved)", () => {
  const d = desc("find_references");
  assert.ok(
    d.includes("lsp_references"),
    "find_references should preserve the lsp_references cross-reference",
  );
});

test("edit_file description cross-references apply_patch for multi-file changes (preserved)", () => {
  const d = desc("edit_file");
  assert.ok(d.includes("apply_patch"), "edit_file should preserve the apply_patch cross-reference");
});

test("grep description cross-references semantic_search for conceptual queries (preserved)", () => {
  const d = desc("grep");
  assert.ok(d.includes("semantic_search"), "grep should preserve the semantic_search cross-reference");
});

test("read_file description mentions offset/limit for slicing (preserved)", () => {
  const d = desc("read_file");
  assert.ok(d.includes("offset") || d.includes("limit"), "read_file should preserve offset/limit mention");
});

test("repo_index description cross-references repo_map for symbol overview (preserved)", () => {
  const d = desc("repo_index");
  assert.ok(d.includes("repo_map"), "repo_index should preserve the repo_map cross-reference");
});

test("repo_map description cross-references repo_index for file inventory (preserved)", () => {
  const d = desc("repo_map");
  assert.ok(d.includes("repo_index"), "repo_map should preserve the repo_index cross-reference");
});

// NOTE: generic conduct guidance (be concise / don't retry the same call) lives
// in the system prompt (DeepSeek-specific section), NOT duplicated into every
// tool description — so there are no per-description assertions for it here.
