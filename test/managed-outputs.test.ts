import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveManagedOutput, readManagedOutput } from "../src/session/managedOutputs.js";
import { readManagedOutputTool } from "../src/tools/readManagedOutput.js";
import { defaultRegistry } from "../src/tools/registry.js";
import { makeCtx } from "./helpers/providers.js";

test("saveManagedOutput writes content and returns a UUID", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mo-"));
  const content = "hello\nworld\n";
  const id = await saveManagedOutput(root, content);
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  const filePath = path.join(root, ".deepcoder", "outputs", `output-${id}.log`);
  const saved = await readFile(filePath, "utf8");
  assert.equal(saved, content);
});

test("readManagedOutput round-trips full content", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mo-"));
  const content = "line1\nline2\nline3\nline4\nline5\n";
  const id = await saveManagedOutput(root, content);
  const result = await readManagedOutput(root, id);
  assert.equal(result, content);
});

test("readManagedOutput returns a line-range slice (1-indexed, inclusive end)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mo-"));
  const content = "line1\nline2\nline3\nline4\nline5\n";
  const id = await saveManagedOutput(root, content);
  const result = await readManagedOutput(root, id, { startLine: 2, endLine: 4 });
  assert.equal(result, "line2\nline3\nline4");
});

test("readManagedOutput with only startLine returns from start to end", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mo-"));
  const content = "line1\nline2\nline3\nline4\nline5\n";
  const id = await saveManagedOutput(root, content);
  const result = await readManagedOutput(root, id, { startLine: 3 });
  assert.equal(result, "line3\nline4\nline5");
});

test("readManagedOutput with only endLine returns from line 1 to endLine", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mo-"));
  const content = "line1\nline2\nline3\nline4\nline5\n";
  const id = await saveManagedOutput(root, content);
  const result = await readManagedOutput(root, id, { endLine: 2 });
  assert.equal(result, "line1\nline2");
});

test("readManagedOutput rejects a missing outputId", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mo-"));
  await assert.rejects(readManagedOutput(root, "00000000-0000-0000-0000-000000000000"), /not found/);
});

test("readManagedOutput rejects a non-UUID outputId", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mo-"));
  await assert.rejects(readManagedOutput(root, "../../etc/passwd"), /Invalid output ID/);
  await assert.rejects(readManagedOutput(root, "../some/file"), /Invalid output ID/);
  await assert.rejects(readManagedOutput(root, "/etc/passwd"), /Invalid output ID/);
  await assert.rejects(readManagedOutput(root, "..%2f"), /Invalid output ID/);
  await assert.rejects(readManagedOutput(root, ""), /Invalid output ID/);
});

test("readManagedOutput via tool returns text", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mo-"));
  const content = "test output\nline2\n";
  const id = await saveManagedOutput(root, content);
  const inv = readManagedOutputTool.build({ outputId: id });
  const result = await inv.execute(makeCtx(root));
  assert.equal(result.isError, undefined);
  assert.equal(result.output, content);
});

test("readManagedOutput via tool with line range", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mo-"));
  const content = "a\nb\nc\nd\n";
  const id = await saveManagedOutput(root, content);
  const inv = readManagedOutputTool.build({ outputId: id, startLine: 2, endLine: 3 });
  const result = await inv.execute(makeCtx(root));
  assert.equal(result.isError, undefined);
  assert.equal(result.output, "b\nc");
});

test("readManagedOutput via tool returns error for bad id", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mo-"));
  const inv = readManagedOutputTool.build({ outputId: "00000000-0000-0000-0000-000000000000" });
  const result = await inv.execute(makeCtx(root));
  assert.equal(result.isError, true);
  assert.match(result.output, /not found/);
});

test("defaultRegistry includes read_managed_output", () => {
  const registry = defaultRegistry();
  assert.ok("read_managed_output" in registry.tools, "read_managed_output must be registered");
  const tool = registry.get("read_managed_output");
  assert.ok(tool);
  assert.equal(tool.kind, "read-only");
});
