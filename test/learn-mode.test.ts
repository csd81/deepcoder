import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initLearnState,
  generateToolExplanation,
  type LearnState,
} from "../src/cli/learnMode.js";

test("initLearnState returns inactive with all focus", () => {
  const s = initLearnState();
  assert.equal(s.active, false);
  assert.equal(s.focus, "all");
});

test("generateToolExplanation returns a non-null string for known tools on success", () => {
  const r = { output: "file contents", isError: false };
  const expl = generateToolExplanation("read_file", r);
  assert.ok(expl !== null);
  assert.ok(expl!.includes("read_file"));
  assert.ok(expl!.includes("line-numbered"));
});

test("generateToolExplanation returns null for error results", () => {
  const r = { output: "not found", isError: true };
  assert.equal(generateToolExplanation("read_file", r), null);
});

test("generateToolExplanation returns null for unknown tools", () => {
  const r = { output: "ok", isError: false };
  assert.equal(generateToolExplanation("unknown_tool", r), null);
});

test("generateToolExplanation covers all registered native tools", () => {
  const toolNames = [
    "read_file", "write_file", "edit_file", "run_bash", "glob", "grep",
    "list_dir", "delete_file", "rename_file", "todo_write", "repo_map",
    "find_symbols", "list_recent_context", "apply_patch", "delegate",
  ];
  const r = { output: "ok", isError: false };
  for (const name of toolNames) {
    const expl = generateToolExplanation(name, r);
    assert.ok(expl !== null, `no explanation for ${name}`);
    assert.ok(expl!.length > 10, `explanation for ${name} is too short`);
  }
});

test("generateToolExplanation for edit_file mentions exact-string replacement", () => {
  const r = { output: "replaced", isError: false };
  const expl = generateToolExplanation("edit_file", r);
  assert.ok(expl!.includes("exact-string"));
});

test("generateToolExplanation for run_bash mentions command classifier", () => {
  const r = { output: "done", isError: false };
  const expl = generateToolExplanation("run_bash", r);
  assert.ok(expl!.includes("classif"));
});
